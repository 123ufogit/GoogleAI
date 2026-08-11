/**
 * ui.js - UIユーティリティ（他のすべてのモジュールより先に読み込む）
 * GIS Browser - Leaflet WebGIS
 */
(function (GIS) {
  'use strict';

  GIS.UI = {
    _toastTimer: null,

    /**
     * トースト通知を表示する
     * @param {string} message
     * @param {'info'|'success'|'warn'|'error'} type
     * @param {number} duration
     */
    showToast(message, type = 'info', duration = 4500) {
      const toast = document.getElementById('toast');
      if (!toast) return;
      toast.textContent = message;
      toast.className = `toast toast-${type}`;
      toast.classList.remove('hidden');

      if (this._toastTimer) clearTimeout(this._toastTimer);
      this._toastTimer = setTimeout(() => toast.classList.add('hidden'), duration);
    },

    /** Pannellum CDN */
    _PANNELLUM_CSS: 'https://cdn.jsdelivr.net/npm/pannellum@2.5.6/build/pannellum.css',
    _PANNELLUM_JS:  'https://cdn.jsdelivr.net/npm/pannellum@2.5.6/build/pannellum.js',
    _pannellumLoading: false,
    _pannellumReady: false,
    _pannellumCallbacks: [],
    /** モーダル内のPannellumインスタンス */
    _modalViewer: null,

    /**
     * Pannellumライブラリを動的にロードする
     * @returns {Promise<void>}
     */
    _ensurePannellum() {
      if (this._pannellumReady) return Promise.resolve();
      return new Promise((resolve, reject) => {
        this._pannellumCallbacks.push({ resolve, reject });
        if (this._pannellumLoading) return;
        this._pannellumLoading = true;

        // CSS
        if (!document.querySelector('link[href*="pannellum"]')) {
          const link = document.createElement('link');
          link.rel  = 'stylesheet';
          link.href = this._PANNELLUM_CSS;
          document.head.appendChild(link);
        }
        // JS
        const script = document.createElement('script');
        script.src = this._PANNELLUM_JS;
        script.onload = () => {
          this._pannellumReady = true;
          this._pannellumCallbacks.forEach(cb => cb.resolve());
          this._pannellumCallbacks = [];
        };
        script.onerror = (err) => {
          this._pannellumLoading = false;
          this._pannellumCallbacks.forEach(cb => cb.reject(err));
          this._pannellumCallbacks = [];
        };
        document.head.appendChild(script);
      });
    },

    /**
     * 画像モーダルを開く（通常画像 / 360°両対応）
     * 360°の場合はPannellumを動的ロードして自動回転で表示
     * @param {string} src      - 画像URL（360°の場合はフル解像度dataUrl）
     * @param {string} altText
     * @param {boolean} is360
     */
    openImageModal(src, altText, is360) {
      const modal   = document.getElementById('image-modal');
      const content = document.getElementById('image-modal-content');
      if (!modal || !content) return;

      // 既存のPannellumビューアを破棄
      if (this._modalViewer) {
        try { this._modalViewer.destroy(); } catch (_) {}
        this._modalViewer = null;
      }

      modal.classList.remove('hidden');

      if (is360) {
        // ローディング表示
        content.innerHTML = `
          <div style="width:100%;height:100%;display:flex;align-items:center;
                      justify-content:center;flex-direction:column;gap:12px;color:#888;">
            <div style="font-size:32px;animation:spin-slow 2s linear infinite">🌐</div>
            <div style="font-size:13px">360°ビューアを読み込み中...</div>
          </div>`;

        // モーダル回転ボタンを非表示（ロード完了まで）
        const rotBtn = document.getElementById('modal-rotate-btn');
        if (rotBtn) rotBtn.classList.add('hidden');

        this._ensurePannellum().then(() => {
          content.innerHTML = '<div id="modal-pano" style="width:100%;height:100%"></div>';

          this._modalViewer = window.pannellum.viewer('modal-pano', {
            type: 'equirectangular',
            panorama: src,
            autoLoad: true,
            showControls: true,
            compass: false,
            mouseZoom: true,
            hfov: 100,
            autoRotate: -2,                  // 左回りで自動回転
            autoRotateInactivityDelay: 3000, // 操作後3秒で再開
          });

          // 回転トグルボタンを表示
          if (rotBtn) {
            rotBtn.classList.remove('hidden');
            rotBtn.dataset.rotating = '1';
            rotBtn.textContent = '⏸ 回転一時停止';
          }

        }).catch(() => {
          // フォールバック：通常表示
          content.innerHTML = `<img src="${src}" alt="${this.escHtml(altText)}" class="modal-image">`;
        });

      } else {
        content.innerHTML = `<img src="${src}" alt="${this.escHtml(altText)}" class="modal-image">`;
        // 回転ボタンを隠す
        const rotBtn = document.getElementById('modal-rotate-btn');
        if (rotBtn) rotBtn.classList.add('hidden');
      }
    },

    /**
     * モーダル内360°ビューアの回転をトグルする
     */
    toggleModalRotation() {
      if (!this._modalViewer) return;
      const btn = document.getElementById('modal-rotate-btn');
      const isRotating = btn && btn.dataset.rotating === '1';
      if (isRotating) {
        this._modalViewer.stopAutoRotate();
        if (btn) { btn.textContent = '▶ 自動回転開始'; btn.dataset.rotating = '0'; }
      } else {
        this._modalViewer.startAutoRotate(-2);
        if (btn) { btn.textContent = '⏸ 回転一時停止'; btn.dataset.rotating = '1'; }
      }
    },

    /**
     * HTMLエスケープ
     * @param {string} str
     * @returns {string}
     */
    escHtml(str) {
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    },

    // ----------------------------------------------------------
    // プログレスバー制御
    // ----------------------------------------------------------

    /**
     * プログレスオーバーレイを表示する
     * @param {string} title - 処理タイトル
     * @param {string} message - サブメッセージ
     */
    showProgress(title = '処理中...', message = '') {
      const overlay = document.getElementById('progress-overlay');
      if (!overlay) return;
      document.getElementById('progress-title').textContent   = title;
      document.getElementById('progress-message').textContent = message;
      document.getElementById('progress-bar-fill').style.width = '0%';
      document.getElementById('progress-percent').textContent  = '0%';
      overlay.classList.remove('hidden');
    },

    /**
     * プログレスを更新する
     * @param {number} percent - 0〜100
     * @param {string} message - サブメッセージ
     */
    updateProgress(percent, message = '') {
      const fill = document.getElementById('progress-bar-fill');
      const pct  = document.getElementById('progress-percent');
      const msg  = document.getElementById('progress-message');
      if (!fill) return;
      const clamped = Math.min(100, Math.max(0, Math.round(percent)));
      fill.style.width            = clamped + '%';
      pct.textContent             = clamped + '%';
      if (message) msg.textContent = message;
    },

    /**
     * プログレスオーバーレイを非表示にする
     */
    hideProgress() {
      const overlay = document.getElementById('progress-overlay');
      if (!overlay) return;
      // 100%を一瞬見せてから非表示
      this.updateProgress(100);
      setTimeout(() => overlay.classList.add('hidden'), 400);
    }
  };

})(window.GIS = window.GIS || {});
