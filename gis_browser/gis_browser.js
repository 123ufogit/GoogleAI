/**
 * gis_browser.js - メインアプリケーション初期化・モジュール統合
 * GIS Browser - Leaflet WebGIS
 * GitHub: https://github.com/your-repo/gis-browser
 */
(function () {
  'use strict';

  // ======================================================
  // アプリケーション初期化
  // ======================================================
  document.addEventListener('DOMContentLoaded', () => {
    initMap();
    initStatusBar();
    initControls();
    GIS.FloatingPanel.init();
  });

  /**
   * Leafletマップを初期化する
   */
  function initMap() {
    const map = L.map('map', {
      center: [36.432416, 136.639853], // 石川県農林総合研究センター林業試験場
      zoom: 15,
      zoomControl: true,
      attributionControl: true
    });

    // ベースマップレイヤー定義
    const basemaps = {
      standard: L.tileLayer(
        'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png',
        {
          attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">国土地理院</a>',
          maxZoom: 18,
          crossOrigin: true
        }
      ),
      ortho: L.tileLayer(
        'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg',
        {
          attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">国土地理院</a>',
          maxZoom: 18,
          crossOrigin: true
        }
      ),
      osm: L.tileLayer(
        'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
        {
          attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> contributors',
          maxZoom: 19
        }
      )
    };

    basemaps.standard.addTo(map);
    GIS.AppState.map = map;
    GIS.AppState._basemaps = basemaps;
    GIS.AppState._currentBasemap = 'standard';
  }

  /**
   * マウス座標ステータスバーを初期化する
   */
  function initStatusBar() {
    const map   = GIS.AppState.map;
    const elCoords = document.getElementById('status-coords');
    const elZoom   = document.getElementById('status-zoom');
    if (!elCoords || !elZoom) return;

    // 初期表示
    const updateZoom = () => {
      elZoom.textContent = `Zoom ${map.getZoom()}`;
    };
    updateZoom();

    // マウスムーブで座標更新
    map.on('mousemove', (e) => {
      const { lat, lng } = e.latlng;
      elCoords.textContent =
        `${lat >= 0 ? '' : ''}${lat.toFixed(6)}°, ` +
        `${lng >= 0 ? '' : ''}${lng.toFixed(6)}°`;
    });

    // 地図外に出たらリセット
    map.on('mouseout', () => {
      elCoords.textContent = '— , —';
    });

    // ズーム変更時
    map.on('zoomend', updateZoom);
  }

  /**
   * ツールバー・ボタン等のUI制御を初期化する
   */
  function initControls() {
    // ベースマップ切り替えボタン
    document.querySelectorAll('[data-basemap]').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.basemap;
        const map = GIS.AppState.map;
        const basemaps = GIS.AppState._basemaps;
        const current = GIS.AppState._currentBasemap;

        if (key === current) return;
        map.removeLayer(basemaps[current]);
        basemaps[key].addTo(map);
        GIS.AppState._currentBasemap = key;

        document.querySelectorAll('[data-basemap]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });

    // エクスポートボタン
    document.getElementById('export-geojson').addEventListener('click', () => GIS.ExportHandler.exportGeoJSON());
    document.getElementById('export-kml').addEventListener('click',     () => GIS.ExportHandler.exportKML());
    document.getElementById('export-pdf').addEventListener('click',     () => GIS.ExportHandler.exportPDF());

    // 画像モーダルを閉じる（Pannellumビューアも破棄）
    document.getElementById('image-modal').addEventListener('click', (e) => {
      if (e.target === e.currentTarget || e.target.id === 'modal-close') {
        document.getElementById('image-modal').classList.add('hidden');
        document.getElementById('image-modal-content').innerHTML = '';
        // Pannellumビューアをクリーンアップ
        if (GIS.UI._modalViewer) {
          try { GIS.UI._modalViewer.destroy(); } catch (_) {}
          GIS.UI._modalViewer = null;
        }
      }
    });

    // モーダル内360°回転トグルボタン
    document.getElementById('modal-rotate-btn').addEventListener('click', () => {
      GIS.UI.toggleModalRotation();
    });

    // ポップアップ内の画像クリックをイベント委譲で処理する
    document.addEventListener('click', (e) => {
      const thumb = e.target.closest('.image-popup-thumb[data-src]');
      if (!thumb) return;
      const alt   = thumb.dataset.alt  || '';
      const is360 = thumb.dataset.is360 === 'true';

      // 360°画像はAppStateからフル解像度URLを取得する
      // （サムネイルではPannellumの全天球表示が正しく動かないため）
      let src = thumb.dataset.src;
      if (is360 && thumb.dataset.pinId) {
        const pin = GIS.AppState.getPinById(thumb.dataset.pinId);
        if (pin && pin.dataUrl) src = pin.dataUrl;
      }

      GIS.UI.openImageModal(src, alt, is360);
    });

    // エクスポート形式モーダルを閉じる（キャンセル）
    document.getElementById('export-format-cancel').addEventListener('click', () => {
      document.getElementById('export-format-modal').classList.add('hidden');
    });

    // ❓ ヘルプモーダルを開く
    document.getElementById('btn-help').addEventListener('click', () => {
      document.getElementById('help-modal').classList.remove('hidden');
    });
    // ヘルプモーダルを閉じる
    document.getElementById('help-modal-close').addEventListener('click', () => {
      document.getElementById('help-modal').classList.add('hidden');
    });
    document.getElementById('help-modal').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) {
        document.getElementById('help-modal').classList.add('hidden');
      }
    });

    // キーボードショートカット
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        document.getElementById('image-modal').classList.add('hidden');
        document.getElementById('export-format-modal').classList.add('hidden');
        document.getElementById('help-modal').classList.add('hidden');
        if (GIS.AppState.locationMode) {
          document.getElementById('location-mode-cancel').click();
        }
      }
    });

    // 縮尺コントロール
    L.control.scale({ imperial: false, position: 'bottomright' }).addTo(GIS.AppState.map);
  }

})();
