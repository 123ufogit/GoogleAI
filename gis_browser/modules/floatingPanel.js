/**
 * floatingPanel.js - 折りたたみ可能フローティングパネルのUI管理
 * GIS Browser - Leaflet WebGIS
 */
(function (GIS) {
  'use strict';

  GIS.FloatingPanel = {
    _panel: null,
    _header: null,
    _body: null,
    _collapsed: false,
    _dragging: false,
    _dragOffset: { x: 0, y: 0 },

    /**
     * パネルを初期化する
     */
    init() {
      this._panel = document.getElementById('floating-panel');
      this._header = document.getElementById('panel-header');
      this._body = document.getElementById('panel-body');
      const toggleBtn = document.getElementById('panel-toggle');
      const clearAllBtn = document.getElementById('clear-all-btn');
      const dropZone = document.getElementById('drop-zone');
      const fileInput = document.getElementById('file-input');

      // 折りたたみトグル
      toggleBtn.addEventListener('click', () => this.toggleCollapse());

      // 全削除ボタン
      clearAllBtn.addEventListener('click', () => {
        if (confirm('すべてのレイヤーを削除しますか？')) {
          GIS.AppState.clearAllLayers();
        }
      });

      // ドラッグ移動（ヘッダー）
      this._initDragMove();

      // ドロップゾーン
      this._initDropZone(dropZone);

      // ファイル選択（クリックでファイルダイアログ）
      dropZone.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', (e) => {
        const files = Array.from(e.target.files);
        if (files.length) GIS.FileHandler.handleFiles(files);
        fileInput.value = ''; // リセット
      });

      // 状態変化を反映
      GIS.AppState.on('layerAdded', (entry) => this._addLayerItem(entry));
      GIS.AppState.on('layerRemoved', ({ id }) => this._removeLayerItem(id));
      GIS.AppState.on('layerToggled', ({ id, visible }) => this._updateLayerItemVisibility(id, visible));
      GIS.AppState.on('allLayersCleared', () => this._clearLayerList());
    },

    /**
     * パネルの折りたたみ/展開をトグルする
     */
    toggleCollapse() {
      this._collapsed = !this._collapsed;
      this._body.style.display = this._collapsed ? 'none' : '';
      const btn = document.getElementById('panel-toggle');
      btn.textContent = this._collapsed ? '⌄' : '⌃';
      btn.title = this._collapsed ? '展開する' : '折りたたむ';
      this._panel.classList.toggle('collapsed', this._collapsed);
    },

    /**
     * パネルの表示/非表示を切り替える（PDF出力時などに使用）
     * @param {boolean} visible
     */
    setVisible(visible) {
      this._panel.style.display = visible ? '' : 'none';
    },

    /**
     * ドラッグ移動を初期化する
     */
    _initDragMove() {
      const handle = document.getElementById('panel-drag-handle');

      const onMouseDown = (e) => {
        if (e.target.closest('button')) return;
        this._dragging = true;
        const rect = this._panel.getBoundingClientRect();
        this._dragOffset.x = e.clientX - rect.left;
        this._dragOffset.y = e.clientY - rect.top;
        this._panel.style.transition = 'none';
        e.preventDefault();
      };

      const onMouseMove = (e) => {
        if (!this._dragging) return;
        const x = Math.max(0, Math.min(window.innerWidth - this._panel.offsetWidth, e.clientX - this._dragOffset.x));
        const y = Math.max(0, Math.min(window.innerHeight - this._panel.offsetHeight, e.clientY - this._dragOffset.y));
        this._panel.style.left = x + 'px';
        this._panel.style.top = y + 'px';
        this._panel.style.right = 'auto';
        this._panel.style.bottom = 'auto';
      };

      const onMouseUp = () => {
        this._dragging = false;
        this._panel.style.transition = '';
      };

      handle.addEventListener('mousedown', onMouseDown);
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);

      // タッチ対応
      handle.addEventListener('touchstart', (e) => {
        const t = e.touches[0];
        onMouseDown({ clientX: t.clientX, clientY: t.clientY, target: e.target, preventDefault: () => e.preventDefault() });
      }, { passive: false });
      document.addEventListener('touchmove', (e) => {
        if (!this._dragging) return;
        const t = e.touches[0];
        onMouseMove({ clientX: t.clientX, clientY: t.clientY });
      }, { passive: false });
      document.addEventListener('touchend', onMouseUp);
    },

    /**
     * ドロップゾーンを初期化する
     * @param {HTMLElement} zone
     */
    _initDropZone(zone) {
      // dragenter / dragover : ハイライト表示
      ['dragenter', 'dragover'].forEach(ev => {
        zone.addEventListener(ev, (e) => {
          e.preventDefault();
          e.stopPropagation();
          zone.classList.add('drag-over');
        });
      });

      // dragleave / dragend : ハイライト解除のみ
      ['dragleave', 'dragend'].forEach(ev => {
        zone.addEventListener(ev, (e) => {
          e.preventDefault();
          e.stopPropagation();
          zone.classList.remove('drag-over');
        });
      });

      // drop : ファイルを処理する（ここが重要）
      zone.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        zone.classList.remove('drag-over');
        const files = Array.from(e.dataTransfer.files);
        if (files.length) GIS.FileHandler.handleFiles(files);
      });

      // ドロップゾーン外（地図上など）へのドロップも受け付ける
      document.addEventListener('dragover', (e) => e.preventDefault());
      document.addEventListener('drop', (e) => {
        // ドロップゾーン自体へのdropはstopPropagationで止めてあるので
        // ここに来るのはゾーン外へのドロップのみ
        e.preventDefault();
        const files = Array.from(e.dataTransfer.files);
        if (files.length) GIS.FileHandler.handleFiles(files);
      });
    },

    /**
     * レイヤーリストにアイテムを追加する
     * @param {object} entry
     */
    _addLayerItem(entry) {
      const list = document.getElementById('layer-list');
      // 「レイヤーがありません」メッセージを削除
      const empty = list.querySelector('.layer-list-empty');
      if (empty) empty.remove();

      const li = document.createElement('li');
      li.className = 'layer-item';
      li.dataset.layerId = entry.id;

      const typeIcon = this._getTypeIcon(entry.type);
      li.innerHTML = `
        <button class="layer-vis-btn" title="表示/非表示" data-id="${entry.id}">👁</button>
        <span class="layer-type-icon">${typeIcon}</span>
        <span class="layer-name" title="${entry.name}">${entry.name}</span>
        <button class="layer-del-btn" title="削除" data-id="${entry.id}">✕</button>
      `;

      li.querySelector('.layer-vis-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        GIS.AppState.toggleLayer(entry.id);
      });
      li.querySelector('.layer-del-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        GIS.AppState.removeLayer(entry.id);
      });

      list.appendChild(li);
    },

    /**
     * レイヤーリストからアイテムを削除する
     * @param {string} id
     */
    _removeLayerItem(id) {
      const list = document.getElementById('layer-list');
      const item = list.querySelector(`[data-layer-id="${id}"]`);
      if (item) item.remove();
      if (!list.children.length) {
        list.innerHTML = '<li class="layer-list-empty">レイヤーがありません</li>';
      }
    },

    /**
     * レイヤーアイテムの表示状態を更新する
     * @param {string} id
     * @param {boolean} visible
     */
    _updateLayerItemVisibility(id, visible) {
      const list = document.getElementById('layer-list');
      const item = list.querySelector(`[data-layer-id="${id}"]`);
      if (!item) return;
      item.classList.toggle('layer-hidden', !visible);
      const btn = item.querySelector('.layer-vis-btn');
      if (btn) btn.textContent = visible ? '👁' : '🙈';
    },

    /**
     * レイヤーリストをクリアする
     */
    _clearLayerList() {
      const list = document.getElementById('layer-list');
      list.innerHTML = '<li class="layer-list-empty">レイヤーがありません</li>';
    },

    /**
     * レイヤータイプに応じたアイコンを返す
     * @param {string} type
     * @returns {string}
     */
    _getTypeIcon(type) {
      const icons = { kml: '🗺️', geojson: '📐', image: '📷', geotiff: '🛰️', pin: '📍' };
      return icons[type] || '📄';
    }
  };

})(window.GIS = window.GIS || {});
