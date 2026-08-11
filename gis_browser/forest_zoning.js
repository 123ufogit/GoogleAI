/**
 * forest_zoning.js - 森林ゾーニングツール メイン初期化スクリプト
 *
 * 森林GIS・傾斜・標高解析に特化したスタンドアロンWebGIS
 * GIS Browser 派生アプリケーション
 */
(function () {
  'use strict';

  document.addEventListener('DOMContentLoaded', () => {
    initMap();
    initStatusBar();
    initControls();
    GIS.FloatingPanel.init();
  });

  /**
   * Leaflet マップを初期化する（森林・地形向けベースマップ構成）
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
      hillshade: L.tileLayer(
        'https://cyberjapandata.gsi.go.jp/xyz/hillshademap/{z}/{x}/{y}.png',
        {
          attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">国土地理院 陰影起伏図</a>',
          maxZoom: 16,
          crossOrigin: true
        }
      ),
      osm: L.tileLayer(
        'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
        {
          attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>',
          maxZoom: 19
        }
      )
    };

    basemaps.standard.addTo(map);
    GIS.AppState.map = map;
    GIS.AppState._basemaps = basemaps;
    GIS.AppState._currentBasemap = 'standard';

    // 森林計画対象森林 ベクトルタイルレイヤー初期化
    if (GIS.VectorTileMask) {
      GIS.VectorTileMask.initLeafletLayer(map);
    }
  }

  /**
   * マウス座標・ズーム表示ステータスバー
   */
  function initStatusBar() {
    const map   = GIS.AppState.map;
    const elCoords = document.getElementById('status-coords');
    const elZoom   = document.getElementById('status-zoom');
    if (!elCoords || !elZoom) return;

    const updateZoom = () => {
      elZoom.textContent = `Zoom ${map.getZoom()}`;
    };
    updateZoom();

    map.on('mousemove', (e) => {
      const { lat, lng } = e.latlng;
      elCoords.textContent = `${lat.toFixed(6)}°, ${lng.toFixed(6)}°`;
    });

    map.on('mouseout', () => {
      elCoords.textContent = '— , —';
    });

    map.on('zoomend', updateZoom);
  }

  /**
   * UIコントロール初期化
   */
  function initControls() {
    // 森林計画対象森林 ベクトルタイルレイヤー トグルボタン
    const vtBtn = document.getElementById('btn-toggle-fr-tiles');
    if (vtBtn) {
      vtBtn.addEventListener('click', () => {
        const isVisible = GIS.VectorTileMask.toggleLayer(GIS.AppState.map);
        vtBtn.classList.toggle('active', isVisible);
      });
    }

    // ベースマップ切り替え
    document.querySelectorAll('[data-basemap]').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.basemap;
        const map = GIS.AppState.map;
        const basemaps = GIS.AppState._basemaps;
        const current = GIS.AppState._currentBasemap;

        if (key === current || !basemaps[key]) return;
        map.removeLayer(basemaps[current]);
        basemaps[key].addTo(map);
        GIS.AppState._currentBasemap = key;

        document.querySelectorAll('[data-basemap]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });

    // エクスポートボタン
    document.getElementById('export-geojson')?.addEventListener('click', () => GIS.ExportHandler.exportGeoJSON());
    document.getElementById('export-kml')?.addEventListener('click',     () => GIS.ExportHandler.exportKML());
    document.getElementById('export-pdf')?.addEventListener('click',     () => GIS.ExportHandler.exportPDF());

    // 画像モーダルを閉じる
    document.getElementById('image-modal')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget || e.target.id === 'modal-close') {
        document.getElementById('image-modal').classList.add('hidden');
        document.getElementById('image-modal-content').innerHTML = '';
        if (GIS.UI._modalViewer) {
          try { GIS.UI._modalViewer.destroy(); } catch (_) {}
          GIS.UI._modalViewer = null;
        }
      }
    });

    // モーダル内360°回転トグル
    document.getElementById('modal-rotate-btn')?.addEventListener('click', () => {
      GIS.UI.toggleModalRotation();
    });

    // ポップアップ画像の拡大表示
    document.addEventListener('click', (e) => {
      const thumb = e.target.closest('.image-popup-thumb[data-src]');
      if (!thumb) return;
      const alt   = thumb.dataset.alt  || '';
      const is360 = thumb.dataset.is360 === 'true';

      let src = thumb.dataset.src;
      if (is360 && thumb.dataset.pinId) {
        const pin = GIS.AppState.getPinById(thumb.dataset.pinId);
        if (pin && pin.dataUrl) src = pin.dataUrl;
      }

      GIS.UI.openImageModal(src, alt, is360);
    });

    // PDFエクスポート形式モーダルキャンセル
    document.getElementById('export-format-cancel')?.addEventListener('click', () => {
      document.getElementById('export-format-modal').classList.add('hidden');
    });

    // ❓ ヘルプモーダル
    document.getElementById('btn-help')?.addEventListener('click', () => {
      document.getElementById('help-modal').classList.remove('hidden');
    });
    document.getElementById('help-modal-close')?.addEventListener('click', () => {
      document.getElementById('help-modal').classList.add('hidden');
    });
    document.getElementById('help-modal')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) {
        document.getElementById('help-modal').classList.add('hidden');
      }
    });

    // ESCキーバインド
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        document.getElementById('image-modal')?.classList.add('hidden');
        document.getElementById('export-format-modal')?.classList.add('hidden');
        document.getElementById('help-modal')?.classList.add('hidden');
        if (GIS.AppState.locationMode) {
          document.getElementById('location-mode-cancel')?.click();
        }
      }
    });

    // 縮尺コントロール
    L.control.scale({ imperial: false, position: 'bottomright' }).addTo(GIS.AppState.map);
  }

})();
