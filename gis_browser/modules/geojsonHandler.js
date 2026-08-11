/**
 * geojsonHandler.js - GeoJSONファイルの読み込みとLeaflet表示
 * GIS Browser - Leaflet WebGIS
 */
(function (GIS) {
  'use strict';

  /** 大きなファイルの警告閾値（バイト） */
  const LARGE_FILE_THRESHOLD = 5 * 1024 * 1024; // 5MB

  /** ポップアップに表示するプロパティの最大数 */
  const MAX_PROPS_IN_POPUP = 15;

  GIS.GeoJsonHandler = {

    /**
     * GeoJSONファイルを読み込み、地図に表示する
     * @param {File} file
     */
    async load(file) {
      if (file.size > LARGE_FILE_THRESHOLD) {
        GIS.UI.showToast(
          `⚠️ 大きなファイルです (${(file.size / 1024 / 1024).toFixed(1)}MB)。読み込みに時間がかかる場合があります。`,
          'warn'
        );
      }

      const text = await file.text();
      let geojson;
      try {
        geojson = JSON.parse(text);
      } catch (e) {
        throw new Error('JSONの解析に失敗しました。ファイルが正しいGeoJSON形式か確認してください。');
      }

      if (!geojson.type) throw new Error('GeoJSONのtypeが見つかりません。');

      // FeatureCollectionでなければラップする
      if (geojson.type === 'Feature') {
        geojson = { type: 'FeatureCollection', features: [geojson] };
      } else if (geojson.type !== 'FeatureCollection') {
        geojson = {
          type: 'FeatureCollection',
          features: [{ type: 'Feature', geometry: geojson, properties: {} }]
        };
      }

      const featureCount = (geojson.features || []).length;
      if (featureCount === 0) throw new Error('GeoJSONにフィーチャが含まれていません。');

      const leafletLayer = L.geoJSON(geojson, {
        style: (feature) => this._getStyle(feature),
        pointToLayer: (feature, latlng) => this._pointToLayer(feature, latlng),
        onEachFeature: (feature, layer) => this._onEachFeature(feature, layer)
      });

      GIS.AppState.addLayer({
        name: file.name,
        type: 'geojson',
        layer: leafletLayer,
        file: file
      });

      // 読み込んだレイヤーの範囲にフィット
      // setTimeout(0) でレイヤーの描画完了後に実行する
      setTimeout(() => {
        try {
          const bounds = leafletLayer.getBounds();
          if (bounds && bounds.isValid()) {
            GIS.AppState.map.fitBounds(bounds, { padding: [40, 40] });
            return;
          }
        } catch (e) {
          console.warn('[GeoJSON] getBounds() failed, trying manual collection:', e);
        }

        // フォールバック: 全レイヤーから手動で LatLngBounds を収集
        try {
          const fallbackBounds = L.latLngBounds();
          leafletLayer.eachLayer(layer => {
            if (typeof layer.getBounds === 'function') {
              fallbackBounds.extend(layer.getBounds());
            } else if (typeof layer.getLatLng === 'function') {
              fallbackBounds.extend(layer.getLatLng());
            }
          });
          if (fallbackBounds.isValid()) {
            GIS.AppState.map.fitBounds(fallbackBounds, { padding: [40, 40] });
          }
        } catch (e2) {
          console.error('[GeoJSON] fitBounds fallback also failed:', e2);
        }
      }, 0);

      GIS.UI.showToast(`✅ GeoJSON読み込み完了: ${featureCount}フィーチャ (${file.name})`, 'success');
    },

    /**
     * ポリゴン・ラインのスタイルを返す
     */
    _getStyle(feature) {
      const p = feature.properties || {};
      return {
        color:       p.stroke       || p['marker-color'] || '#7c3aed',
        fillColor:   p.fill        || p.stroke           || '#7c3aed',
        weight:      p['stroke-width'] || 2,
        opacity:     p['stroke-opacity'] || 0.9,
        fillOpacity: p['fill-opacity']   || 0.3
      };
    },

    /**
     * ポイントをカスタムマーカーに変換する
     */
    _pointToLayer(feature, latlng) {
      const p = feature.properties || {};
      const color = p['marker-color'] || p.stroke || '#00d4ff';
      return L.circleMarker(latlng, {
        radius: 8,
        fillColor: color,
        color: '#fff',
        weight: 2,
        fillOpacity: 0.9
      });
    },

    /**
     * 各フィーチャにポップアップを設定する（面積・距離バッジ含む）
     * @param {object} feature
     * @param {L.Layer} layer
     */
    _onEachFeature(feature, layer) {
      const props = feature.properties || {};
      const geom  = feature.geometry;

      const name = props.name || props.NAME || props.title || props.TITLE || '';
      const entries = Object.entries(props)
        .filter(([k]) => !['name','NAME','title','TITLE','description','Description',
                           'stroke','fill','fill-opacity','stroke-width','stroke-opacity',
                           'marker-color','marker-size','marker-symbol'].includes(k))
        .slice(0, MAX_PROPS_IN_POPUP);

      const tableRows = entries.map(([k, v]) =>
        `<tr><td class="popup-key">${this._escHtml(String(k))}</td>` +
        `<td class="popup-val">${this._escHtml(String(v ?? ''))}</td></tr>`
      ).join('');

      // 面積・距離バッジを生成
      let measureBadge = '';
      if (geom) {
        const type = geom.type;
        if (type === 'Polygon' || type === 'MultiPolygon') {
          const rings = type === 'Polygon'
            ? [geom.coordinates[0]]
            : geom.coordinates.map(p => p[0]);
          let totalArea = 0;
          rings.forEach(ring => { totalArea += this._calcPolygonArea(ring); });
          measureBadge = `<div class="popup-measure-badge popup-area">
            📐 面積: <strong>${this._formatArea(totalArea)}</strong>
          </div>`;
        } else if (type === 'LineString' || type === 'MultiLineString') {
          const lines = type === 'LineString'
            ? [geom.coordinates]
            : geom.coordinates;
          let totalDist = 0;
          lines.forEach(line => { totalDist += this._calcLineLength(line); });
          measureBadge = `<div class="popup-measure-badge popup-distance">
            📏 距離: <strong>${this._formatDistance(totalDist)}</strong>
          </div>`;
        }
      }

      const html = `<div class="geojson-popup">
        ${name ? `<strong class="popup-name">${this._escHtml(name)}</strong>` : ''}
        ${props.description ? `<p class="popup-desc">${this._escHtml(String(props.description))}</p>` : ''}
        ${measureBadge}
        ${tableRows ? `<table class="popup-table">${tableRows}</table>` : ''}
      </div>`;

      layer.bindPopup(html, { maxWidth: 340 });
    },

    // ------------------------------------------------------------------
    // 測量計算（球面三角法）
    // ------------------------------------------------------------------

    /**
     * ポリゴンリング（[lon,lat] 配列）の球面積を返す（m²）
     * Gauss's spherical excess formula
     * @param {Array} ring - [[lon,lat], ...]
     * @returns {number} 面積（m²）
     */
    _calcPolygonArea(ring) {
      if (!ring || ring.length < 3) return 0;
      const R = 6371008.8; // 地球平均半径（m）
      const n = ring.length;
      let area = 0;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const lon1 = ring[i][0] * Math.PI / 180;
        const lon2 = ring[j][0] * Math.PI / 180;
        const lat1 = ring[i][1] * Math.PI / 180;
        const lat2 = ring[j][1] * Math.PI / 180;
        area += (lon2 - lon1) * (2 + Math.sin(lat1) + Math.sin(lat2));
      }
      return Math.abs(area * R * R / 2);
    },

    /**
     * ラインの測地線距離を返す（m）
     * Haversine公式
     * @param {Array} coords - [[lon,lat], ...]
     * @returns {number} 距離（m）
     */
    _calcLineLength(coords) {
      if (!coords || coords.length < 2) return 0;
      const R = 6371008.8;
      let total = 0;
      for (let i = 0; i < coords.length - 1; i++) {
        const [lon1, lat1] = coords[i];
        const [lon2, lat2] = coords[i + 1];
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(dLat / 2) ** 2
          + Math.cos(lat1 * Math.PI / 180)
          * Math.cos(lat2 * Math.PI / 180)
          * Math.sin(dLon / 2) ** 2;
        total += 2 * R * Math.asin(Math.sqrt(a));
      }
      return total;
    },

    /**
     * 面積を人間が読みやすい文字列に変換する
     */
    _formatArea(m2) {
      if (m2 >= 1e6)  return (m2 / 1e6).toFixed(3) + ' km²';
      if (m2 >= 1e4)  return (m2 / 1e4).toFixed(2) + ' ha';
      return m2.toFixed(1) + ' m²';
    },

    /**
     * 距離を人間が読みやすい文字列に変換する
     */
    _formatDistance(m) {
      if (m >= 1000) return (m / 1000).toFixed(3) + ' km';
      return m.toFixed(1) + ' m';
    },

    /**
     * HTMLエスケープ
     */
    _escHtml(str) {
      return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }
  };

})(window.GIS = window.GIS || {});
