/**
 * polygonDrawer.js - 地図上でのマスク用ポリゴン手描き作成モジュール
 * GIS Browser - Leaflet WebGIS
 */
(function (GIS) {
  'use strict';

  GIS.PolygonDrawer = {
    _isDrawing: false,
    _points: [],          // L.LatLng の配列
    _tempMarkers: [],     // 頂点マーカーの配列
    _tempPolyline: null,  // 描画中ガイドライン
    _polygonCount: 0,

    /**
     * ポリゴン描画を開始する
     */
    startDrawing() {
      if (this._isDrawing) return;
      const map = GIS.AppState.map;
      if (!map) return;

      this._isDrawing = true;
      this._points = [];
      this._tempMarkers = [];

      this._showBanner(true);
      map.getContainer().style.cursor = 'crosshair';

      this._onMapClick = this._handleMapClick.bind(this);
      this._onMouseMove = this._handleMouseMove.bind(this);
      this._onKeyDown = this._handleKeyDown.bind(this);

      map.on('click', this._onMapClick);
      map.on('mousemove', this._onMouseMove);
      document.addEventListener('keydown', this._onKeyDown);
    },

    /**
     * 描画をキャンセルまたは終了する
     */
    stopDrawing() {
      if (!this._isDrawing) return;
      const map = GIS.AppState.map;

      this._isDrawing = false;
      this._showBanner(false);

      if (map) {
        map.getContainer().style.cursor = '';
        map.off('click', this._onMapClick);
        map.off('mousemove', this._onMouseMove);
      }
      document.removeEventListener('keydown', this._onKeyDown);

      this._clearTempLayers();
      this._points = [];
    },

    /**
     * クリック時の処理
     */
    _handleMapClick(e) {
      const map = GIS.AppState.map;
      const latlng = e.latlng;

      // 始点近くをクリックした場合は確定処理
      if (this._points.length >= 3) {
        const firstPt = this._points[0];
        const distPx = map.latLngToContainerPoint(latlng).distanceTo(map.latLngToContainerPoint(firstPt));
        if (distPx < 15) { // 15px以内なら閉じる
          this._finishPolygon();
          return;
        }
      }

      this._points.push(latlng);

      // 頂点マーカーを追加
      const marker = L.circleMarker(latlng, {
        radius: 5,
        color: '#00d7ff',
        fillColor: '#ffffff',
        fillOpacity: 1,
        weight: 2
      }).addTo(map);

      // 始点クリックで確定できるようにイベント登録
      if (this._points.length === 1) {
        marker.on('click', (ev) => {
          L.DomEvent.stopPropagation(ev);
          if (this._points.length >= 3) {
            this._finishPolygon();
          }
        });
      }

      this._tempMarkers.push(marker);
      this._updatePolyline();
    },

    /**
     * マウス移動時のガイドライン更新
     */
    _handleMouseMove(e) {
      if (this._points.length === 0) return;
      const map = GIS.AppState.map;
      const guidePoints = [...this._points, e.latlng];

      if (!this._tempPolyline) {
        this._tempPolyline = L.polyline(guidePoints, {
          color: '#00d7ff',
          weight: 2.5,
          dashArray: '5, 5'
        }).addTo(map);
      } else {
        this._tempPolyline.setLatLngs(guidePoints);
      }
    },

    /**
     * キー入力（Escキーでキャンセル、Enterで確定）
     */
    _handleKeyDown(e) {
      if (e.key === 'Escape') {
        this.stopDrawing();
        GIS.UI.showToast('ℹ️ ポリゴン描画をキャンセルしました', 'info');
      } else if (e.key === 'Enter') {
        if (this._points.length >= 3) {
          this._finishPolygon();
        } else {
          GIS.UI.showToast('⚠️ ポリゴン作成には3つ以上の点が必要です', 'warn');
        }
      }
    },

    /**
     * 一時描画要素を更新
     */
    _updatePolyline() {
      const map = GIS.AppState.map;
      if (this._points.length < 2) return;

      if (!this._tempPolyline) {
        this._tempPolyline = L.polyline(this._points, {
          color: '#00d7ff',
          weight: 2.5
        }).addTo(map);
      } else {
        this._tempPolyline.setLatLngs(this._points);
      }
    },

    /**
     * ポリゴン描画を確定し、AppState に登録する
     */
    _finishPolygon() {
      if (this._points.length < 3) {
        GIS.UI.showToast('⚠️ ポリゴン作成には3点以上必要です', 'warn');
        return;
      }

      this._polygonCount++;
      const polygonName = `手描きマスク ${this._polygonCount}`;

      // Leaflet Polygon レイヤーの作成
      const polygonLayer = L.polygon(this._points, {
        color: '#00d7ff',
        weight: 2,
        fillColor: '#00d7ff',
        fillOpacity: 0.3
      });

      // GeoJSON データ構造の構築 ([lng, lat] 順)
      const coordinates = this._points.map(pt => [pt.lng, pt.lat]);
      // 閉路を保証
      if (coordinates[0][0] !== coordinates[coordinates.length - 1][0] ||
          coordinates[0][1] !== coordinates[coordinates.length - 1][1]) {
        coordinates.push([...coordinates[0]]);
      }

      const rawGeoJSON = {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            geometry: {
              type: 'Polygon',
              coordinates: [coordinates]
            },
            properties: {
              name: polygonName,
              isDrawn: true
            }
          }
        ]
      };

      // AppState にレイヤーとして追加
      const newLayerId = GIS.AppState.addLayer({
        name: polygonName,
        type: 'geojson',
        layer: polygonLayer,
        file: null,
        rawGeoJSON: rawGeoJSON
      });

      // 一括マスク設定が選択されている場合は、この新しいポリゴンを優先適用
      const batchSelect = document.getElementById('batch-mask-select');
      if (batchSelect && GIS.ZoningHandler) {
        batchSelect.value = newLayerId;
        GIS.ZoningHandler.applyBatchMask(newLayerId);
      }

      this.stopDrawing();
      GIS.UI.showToast(`✅ 『${polygonName}』を作成し、マスクに適用しました`, 'success');
    },

    /**
     * 一時描画エレメントの消去
     */
    _clearTempLayers() {
      const map = GIS.AppState.map;
      if (!map) return;

      this._tempMarkers.forEach(m => map.removeLayer(m));
      this._tempMarkers = [];

      if (this._tempPolyline) {
        map.removeLayer(this._tempPolyline);
        this._tempPolyline = null;
      }
    },

    /**
     * 案内バナーの表示/非表示
     */
    _showBanner(show) {
      let banner = document.getElementById('polygon-draw-banner');
      if (show) {
        if (!banner) {
          banner = document.createElement('div');
          banner.id = 'polygon-draw-banner';
          banner.className = 'polygon-draw-banner';
          banner.innerHTML = `
            <span>✏️ <strong>ポリゴン描画中</strong>: 地図上をクリックして頂点を追加 (ダブルクリック/始点クリック/Enterで確定, Escでキャンセル)</span>
            <button id="btn-cancel-draw" class="location-mode-cancel">キャンセル</button>
          `;
          document.body.appendChild(banner);
          document.getElementById('btn-cancel-draw').addEventListener('click', () => this.stopDrawing());
        }
        banner.classList.remove('hidden');
      } else if (banner) {
        banner.classList.add('hidden');
      }
    }
  };

})(window.GIS = window.GIS || {});
