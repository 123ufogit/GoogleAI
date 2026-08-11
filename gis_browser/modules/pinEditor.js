/**
 * pinEditor.js - 撮影位置特定UI（位置情報なし画像の位置付与フロー）
 * 360°全天球画像はPannellumビューアで表示
 * GIS Browser - Leaflet WebGIS
 */
(function (GIS) {
  'use strict';

  /** Pannellum ライブラリのCDN */
  const PANNELLUM_CSS = 'https://cdn.jsdelivr.net/npm/pannellum@2.5.6/build/pannellum.css';
  const PANNELLUM_JS  = 'https://cdn.jsdelivr.net/npm/pannellum@2.5.6/build/pannellum.js';

  let pannellumReady = false;
  let pannellumLoading = false;
  let pannellumCallbacks = [];
  let pannellumViewer = null;

  GIS.PinEditor = {

    _currentIndex: 0,

    /**
     * 位置特定フローを開始する
     */
    start() {
      this._currentIndex = 0;
      this._showCurrent();
    },

    /**
     * 現在の画像を表示する
     */
    async _showCurrent() {
      const queue = GIS.AppState.pendingImages;
      if (this._currentIndex >= queue.length) {
        this._finish();
        return;
      }

      const item = queue[this._currentIndex];
      const total = queue.length;

      // プレビューパネルを表示
      const panel = document.getElementById('photo-preview-panel');
      panel.classList.remove('hidden');

      document.getElementById('preview-filename').textContent = item.filename;
      document.getElementById('preview-counter').textContent =
        `${this._currentIndex + 1} / ${total}`;

      // 360°バッジ表示
      const badge = document.getElementById('badge-360');
      if (item.is360) badge.classList.remove('hidden');
      else badge.classList.add('hidden');

      // ビューア切り替え
      if (item.is360) {
        await this._show360Viewer(item.dataUrl);
      } else {
        this._showFlatViewer(item.dataUrl);
      }

      // ボタン状態を初期化
      this._resetButtons();
    },

    /**
     * 通常画像プレビューを表示する
     * @param {string} dataUrl
     */
    _showFlatViewer(dataUrl) {
      const img = document.getElementById('preview-img');
      const pano = document.getElementById('pannellum-container');
      img.src = dataUrl;
      img.classList.remove('hidden');
      pano.classList.add('hidden');

      // Pannellumビューアが存在すれば破棄
      if (pannellumViewer) {
        pannellumViewer.destroy();
        pannellumViewer = null;
      }
    },

    /**
     * Pannellum 360°ビューアを表示する
     * @param {string} dataUrl
     */
    async _show360Viewer(dataUrl) {
      await this._ensurePannellum();

      const img = document.getElementById('preview-img');
      const panoContainer = document.getElementById('pannellum-container');
      img.classList.add('hidden');
      panoContainer.classList.remove('hidden');

      // 既存ビューアを破棄
      if (pannellumViewer) {
        pannellumViewer.destroy();
        pannellumViewer = null;
      }

      // Pannellumビューアを初期化（自動回転機能付き）
      pannellumViewer = window.pannellum.viewer('pannellum-container', {
        type: 'equirectangular',
        panorama: dataUrl,
        autoLoad: true,
        showControls: true,
        compass: false,
        mouseZoom: true,
        keyboardZoom: false,
        hfov: 100,
        autoRotate: -2,                  // 自動回転（度/秒、マイナス=左回り）
        autoRotateInactivityDelay: 3000, // マウス操作後3秒で自動回転再開
      });

      // 回転一時停止/再開ボタンを更新
      this._updateRotateBtn(true);
    },

    /**
     * ボタン状態を初期化する（撮影位置特定前の状態）
     */
    _resetButtons() {
      document.getElementById('btn-locate').classList.remove('hidden');
      document.getElementById('btn-confirm-location').classList.add('hidden');
      document.getElementById('btn-next').classList.add('hidden');
      document.getElementById('location-preview-map-hint').classList.add('hidden');

      // 回転ボタンを初期化（360°画像のときのみ表示）
      const item = GIS.AppState.pendingImages[this._currentIndex];
      const rotateRow = document.getElementById('rotate-btn-row');
      if (item && item.is360) {
        rotateRow.classList.remove('hidden');
        this._updateRotateBtn(true);
      } else {
        rotateRow.classList.add('hidden');
      }

      // 仮マーカーを削除
      if (GIS.AppState.tempMarker) {
        GIS.AppState.map.removeLayer(GIS.AppState.tempMarker);
        GIS.AppState.tempMarker = null;
      }
      GIS.AppState.locationMode = false;

      this._bindButtons();
    },

    /**
     * ボタンのイベントを設定する
     */
    _bindButtons() {
      const btnLocate  = document.getElementById('btn-locate');
      const btnConfirm = document.getElementById('btn-confirm-location');
      const btnNext    = document.getElementById('btn-next');
      const btnSkip    = document.getElementById('btn-skip');
      const btnCancel  = document.getElementById('location-mode-cancel');
      const btnRotate  = document.getElementById('btn-rotate-toggle');

      // 既存リスナを除去（再バインドのため）
      btnLocate.replaceWith(btnLocate.cloneNode(true));
      btnConfirm.replaceWith(btnConfirm.cloneNode(true));
      btnNext.replaceWith(btnNext.cloneNode(true));
      btnSkip.replaceWith(btnSkip.cloneNode(true));
      btnCancel.replaceWith(btnCancel.cloneNode(true));
      if (btnRotate) btnRotate.replaceWith(btnRotate.cloneNode(true));

      // 再取得
      const bLocate  = document.getElementById('btn-locate');
      const bConfirm = document.getElementById('btn-confirm-location');
      const bNext    = document.getElementById('btn-next');
      const bSkip    = document.getElementById('btn-skip');
      const bCancel  = document.getElementById('location-mode-cancel');
      const bRotate  = document.getElementById('btn-rotate-toggle');

      // 「撮影位置を特定する」ボタン
      bLocate.addEventListener('click', () => this._enterLocationMode());

      // 「確定」ボタン
      bConfirm.addEventListener('click', () => this._confirmLocation());

      // 「次へ」ボタン
      bNext.addEventListener('click', () => this._goNext());

      // 「スキップ」ボタン
      bSkip.addEventListener('click', () => this._skip());

      // 「キャンセル」ボタン
      bCancel.addEventListener('click', () => this._cancelLocationMode());

      // 「自動回転 一時停止/再開」ボタン
      if (bRotate) {
        bRotate.addEventListener('click', () => this._toggleRotation());
      }
    },

    /**
     * 自動回転ボタンの表示を更新する
     * @param {boolean} rotating - 回転中かどうか
     */
    _updateRotateBtn(rotating) {
      const btn = document.getElementById('btn-rotate-toggle');
      if (!btn) return;
      btn.textContent = rotating ? '⏸ 回転一時停止' : '▶ 自動回転開始';
      btn.dataset.rotating = rotating ? '1' : '0';
    },

    /**
     * 自動回転のトグル
     */
    _toggleRotation() {
      if (!pannellumViewer) return;
      const btn = document.getElementById('btn-rotate-toggle');
      const isRotating = btn.dataset.rotating === '1';
      if (isRotating) {
        pannellumViewer.stopAutoRotate();
      } else {
        pannellumViewer.startAutoRotate(-2);
      }
      this._updateRotateBtn(!isRotating);
    },

    /**
     * 地図クリックモードに入る
     */
    _enterLocationMode() {
      GIS.AppState.locationMode = true;
      const map = GIS.AppState.map;
      const item = GIS.AppState.pendingImages[this._currentIndex];

      // 既存クリックイベント解除
      map.off('click');

      // GPXからの自動提案チェック（GPXレイヤーがあり、画像にtimestampがある場合）
      const proposal = this._findClosestGpxPoint(item.timestamp);

      if (proposal) {
        const { point, diffMs } = proposal;
        const diffSec = Math.round(diffMs / 1000);
        const diffMin = Math.floor(diffSec / 60);
        const secRem = diffSec % 60;
        const diffStr = diffMin > 0 ? `${diffMin}分${secRem}秒` : `${diffSec}秒`;

        // 仮マーカーを提案位置に置く
        const latlng = L.latLng(point.lat, point.lon);
        if (GIS.AppState.tempMarker) map.removeLayer(GIS.AppState.tempMarker);
        GIS.AppState.tempMarker = L.marker(latlng, {
          draggable: true,
          icon: L.divIcon({
            className: 'temp-marker',
            html: '<div class="temp-marker-inner">📍</div>',
            iconSize: [36, 36],
            iconAnchor: [18, 36]
          })
        }).addTo(map);

        map.setView(latlng, Math.max(map.getZoom(), 15));

        document.getElementById('location-mode-message').textContent =
          `「${item.filename}」の撮影位置をGPXから提案中（時刻差: ${diffStr}）。再クリックで変更可`;

        document.getElementById('btn-locate').classList.add('hidden');
        document.getElementById('btn-confirm-location').classList.remove('hidden');
        document.getElementById('location-preview-map-hint').classList.remove('hidden');
      } else {
        document.getElementById('location-mode-message').textContent =
          `「${item.filename}」の撮影位置を地図上でクリックして指定`;
      }

      document.getElementById('location-mode-overlay').classList.remove('hidden');
      map.getContainer().classList.add('location-mode');

      // クリックリスナー（手動指定または提案の変更）
      const onMapClick = (e) => {
        if (!GIS.AppState.locationMode) return;

        // 既存ピンへのスナップ判定
        const snappedLatLng = this._findSnappedLatLng(e.latlng);

        // 仮マーカーを設置
        if (GIS.AppState.tempMarker) map.removeLayer(GIS.AppState.tempMarker);
        GIS.AppState.tempMarker = L.marker(snappedLatLng, {
          draggable: true,
          icon: L.divIcon({
            className: 'temp-marker',
            html: '<div class="temp-marker-inner">📍</div>',
            iconSize: [36, 36],
            iconAnchor: [18, 36]
          })
        }).addTo(map);

        // UI更新
        document.getElementById('btn-locate').classList.add('hidden');
        document.getElementById('btn-confirm-location').classList.remove('hidden');
        document.getElementById('location-preview-map-hint').classList.remove('hidden');
      };

      map.on('click', onMapClick);
    },

    /**
     * 画像の撮影日時に最も近いGPXポイントを探索する（24時間以内）
     * @param {number|null} timestamp
     * @returns {{ point: object, diffMs: number }|null}
     */
    _findClosestGpxPoint(timestamp) {
      if (!timestamp) return null;
      let bestPt = null;
      let minDiff = Infinity;
      const MAX_DIFF_MS = 24 * 60 * 60 * 1000; // 24時間

      GIS.AppState.layers.forEach(entry => {
        if (entry.type === 'gpx' && entry.visible && entry.layer && entry.layer._gpxPoints) {
          entry.layer._gpxPoints.forEach(pt => {
            const diff = Math.abs(pt.timeMs - timestamp);
            if (diff < minDiff) {
              minDiff = diff;
              bestPt = pt;
            }
          });
        }
      });

      if (bestPt && minDiff <= MAX_DIFF_MS) {
        return { point: bestPt, diffMs: minDiff };
      }
      return null;
    },

    /**
     * クリック位置の近く（18px以内）に既存のポイントがあればその座標にスナップする
     * @param {L.LatLng} eLatLng
     * @returns {L.LatLng}
     */
    _findSnappedLatLng(eLatLng) {
      const map = GIS.AppState.map;
      const clickPt = map.latLngToContainerPoint(eLatLng);
      let closestLatLng = eLatLng;
      let minPixelDist = 18;

      map.eachLayer(layer => {
        if (layer === GIS.AppState.tempMarker) return;
        if (typeof layer.getLatLng === 'function') {
          const latLng = layer.getLatLng();
          const pt = map.latLngToContainerPoint(latLng);
          const dist = clickPt.distanceTo(pt);
          if (dist < minPixelDist) {
            minPixelDist = dist;
            closestLatLng = latLng;
          }
        }
      });

      return closestLatLng;
    },

    /**
     * 位置をキャンセルする
     */
    _cancelLocationMode() {
      GIS.AppState.locationMode = false;
      GIS.AppState.map.off('click');
      document.getElementById('location-mode-overlay').classList.add('hidden');
      GIS.AppState.map.getContainer().classList.remove('location-mode');

      // 仮マーカーを削除
      if (GIS.AppState.tempMarker) {
        GIS.AppState.map.removeLayer(GIS.AppState.tempMarker);
        GIS.AppState.tempMarker = null;
      }

      this._resetButtons();
    },

    /**
     * 位置を確定する
     */
    _confirmLocation() {
      if (!GIS.AppState.tempMarker) return;
      const latlng = GIS.AppState.tempMarker.getLatLng();
      const item = GIS.AppState.pendingImages[this._currentIndex];

      // 仮マーカーを削除
      GIS.AppState.map.removeLayer(GIS.AppState.tempMarker);
      GIS.AppState.tempMarker = null;

      // ピンを追加
      GIS.ImageHandler.addPin(item.filename, item.dataUrl, latlng, item.is360);
      GIS.UI.showToast(`📍 撮影位置を確定しました: ${item.filename}`, 'success');

      // 「次へ」ボタンを表示
      document.getElementById('btn-confirm-location').classList.add('hidden');
      document.getElementById('btn-next').classList.remove('hidden');
      document.getElementById('location-preview-map-hint').classList.add('hidden');
    },

    /**
     * 次の画像へ進む
     */
    _goNext() {
      this._currentIndex++;
      this._showCurrent();
    },

    /**
     * スキップして次へ
     */
    _skip() {
      GIS.UI.showToast(`⏭ スキップ: ${GIS.AppState.pendingImages[this._currentIndex].filename}`, 'info');
      this._currentIndex++;
      this._showCurrent();
    },

    /**
     * 全画像の処理完了
     */
    _finish() {
      document.getElementById('photo-preview-panel').classList.add('hidden');
      document.getElementById('location-mode-overlay').classList.add('hidden');
      GIS.AppState.map.getContainer().classList.remove('location-mode');

      // Pannellumビューアを破棄
      if (pannellumViewer) {
        pannellumViewer.destroy();
        pannellumViewer = null;
      }

      // キューをリセット
      const count = GIS.AppState.pendingImages.length;
      GIS.AppState.resetPendingQueue();
      GIS.UI.showToast(`✅ ${count}枚の画像処理が完了しました`, 'success');
    },

    /**
     * Pannellumライブラリを動的に読み込む（初回のみ）
     * @returns {Promise<void>}
     */
    _ensurePannellum() {
      if (pannellumReady) return Promise.resolve();
      if (pannellumLoading) {
        return new Promise((resolve, reject) => pannellumCallbacks.push({ resolve, reject }));
      }

      pannellumLoading = true;
      return new Promise((resolve, reject) => {
        pannellumCallbacks.push({ resolve, reject });

        // CSS
        if (!document.querySelector(`link[href="${PANNELLUM_CSS}"]`)) {
          const link = document.createElement('link');
          link.rel = 'stylesheet';
          link.href = PANNELLUM_CSS;
          document.head.appendChild(link);
        }

        // JS
        const script = document.createElement('script');
        script.src = PANNELLUM_JS;
        script.onload = () => {
          pannellumReady = true;
          pannellumLoading = false;
          pannellumCallbacks.forEach(cb => cb.resolve());
          pannellumCallbacks = [];
        };
        script.onerror = () => {
          pannellumLoading = false;
          const err = new Error('Pannellumライブラリの読み込みに失敗しました。');
          pannellumCallbacks.forEach(cb => cb.reject(err));
          pannellumCallbacks = [];
          reject(err);
        };
        document.head.appendChild(script);
      });
    }
  };

})(window.GIS = window.GIS || {});
