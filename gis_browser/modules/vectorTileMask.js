/**
 * vectorTileMask.js - GeoTIFF ベクトルポリゴンマスク処理
 *
 * ローカルで読み込まれた GeoJSON / KML などのポリゴンデータを使用し、
 * GeoTIFF の Offscreen Canvas に対して destination-in クリッピング（透明化）を行う。
 */
(function (GIS) {
  'use strict';

  GIS.VectorTileMask = {

    /**
     * GeoTIFFの Canvas に対して GeoJSON / ベクトルポリゴンによるマスク (destination-in) を適用する
     * ポリゴン範囲外のピクセルは透明化される。ポリゴンが存在しない場合は安全にスキップ（全表示）。
     *
     * @param {HTMLCanvasElement} geoCanvas GeoTIFFが描画されたCanvas
     * @param {L.LatLngBounds} bounds 
     * @param {string} maskLayerId 'none' | 'all' | 特定のレイヤーID
     * @returns {Promise<HTMLCanvasElement>}
     */
    async applyMaskToCanvas(geoCanvas, bounds, maskLayerId = 'all') {
      if (maskLayerId === 'none' || !bounds) {
        return geoCanvas;
      }

      // GeoJSONポリゴンを抽出
      const polygons = this._getPolygonsToMask(maskLayerId);
      if (!polygons || polygons.length === 0) {
        // ポリゴンが見つからない場合は安全に元のCanvasを返却（真っ消去を防止）
        return geoCanvas;
      }

      const outW = geoCanvas.width;
      const outH = geoCanvas.height;

      // オフスクリーンマスクCanvasを生成
      const maskCanvas = document.createElement('canvas');
      maskCanvas.width = outW;
      maskCanvas.height = outH;
      const maskCtx = maskCanvas.getContext('2d');

      maskCtx.fillStyle = '#ffffff';

      let hasPolygonsDrawn = false;

      for (const polyRings of polygons) {
        if (!polyRings || polyRings.length === 0) continue;
        maskCtx.beginPath();
        for (const ring of polyRings) {
          if (!ring || ring.length === 0) continue;
          for (let k = 0; k < ring.length; k++) {
            const pt = ring[k];
            const lng = Array.isArray(pt) ? pt[0] : pt.lng;
            const lat = Array.isArray(pt) ? pt[1] : pt.lat;
            if (lng === undefined || lat === undefined) continue;

            const px = this._latLngToCanvasPx(lat, lng, bounds, outW, outH);
            if (k === 0) maskCtx.moveTo(px.cx, px.cy);
            else maskCtx.lineTo(px.cx, px.cy);
          }
        }
        maskCtx.closePath();
        maskCtx.fill('evenodd');
        hasPolygonsDrawn = true;
      }

      // マスク画像を描画できた場合のみ destination-in 合成を実行
      if (hasPolygonsDrawn) {
        const geoCtx = geoCanvas.getContext('2d');
        geoCtx.globalCompositeOperation = 'destination-in';
        geoCtx.drawImage(maskCanvas, 0, 0);
        geoCtx.globalCompositeOperation = 'source-over';
      }

      return geoCanvas;
    },

    /**
     * AppState 内の指定されたレイヤー、またはすべてのベクトルレイヤーからポリゴン座標配列を抽出する
     * @param {string} maskLayerId 
     * @returns {Array}
     */
    _getPolygonsToMask(maskLayerId) {
      const allPolygons = [];

      if (!GIS.AppState || !GIS.AppState.layers) return allPolygons;

      GIS.AppState.layers.forEach((entry, id) => {
        if (!entry.visible) return; // 非表示レイヤーはスキップ
        if (maskLayerId !== 'all' && id !== maskLayerId) return;

        let geojson = entry.rawGeoJSON;

        // Leaflet Layer から toGeoJSON でフォールバック取得
        if (!geojson && entry.layer && typeof entry.layer.toGeoJSON === 'function') {
          try { geojson = entry.layer.toGeoJSON(); } catch (_) {}
        }

        if (geojson) {
          const extracted = this._extractPolygonsFromGeoJSON(geojson);
          allPolygons.push(...extracted);
        }
      });

      return allPolygons;
    },

    /**
     * GeoJSON オブジェクトからすべての Polygon / MultiPolygon 座標リングを抽出
     * @param {object} geojson 
     * @returns {Array}
     */
    _extractPolygonsFromGeoJSON(geojson) {
      const polygons = [];
      if (!geojson) return polygons;

      const processFeature = (feature) => {
        if (!feature || !feature.geometry) return;
        const geom = feature.geometry;
        if (geom.type === 'Polygon') {
          polygons.push(geom.coordinates);
        } else if (geom.type === 'MultiPolygon') {
          geom.coordinates.forEach(polyCoords => polygons.push(polyCoords));
        }
      };

      if (geojson.type === 'FeatureCollection' && Array.isArray(geojson.features)) {
        geojson.features.forEach(processFeature);
      } else if (geojson.type === 'Feature') {
        processFeature(geojson);
      } else if (geojson.type === 'Polygon') {
        polygons.push(geojson.coordinates);
      } else if (geojson.type === 'MultiPolygon') {
        geojson.coordinates.forEach(polyCoords => polygons.push(polyCoords));
      }

      return polygons;
    },

    /**
     * LatLng を GeoTIFF Canvas ピクセル座標に変換
     */
    _latLngToCanvasPx(lat, lng, bounds, outW, outH) {
      const minLat = typeof bounds.getSouth === 'function' ? bounds.getSouth() : (bounds.minLat ?? bounds._southWest?.lat);
      const maxLat = typeof bounds.getNorth === 'function' ? bounds.getNorth() : (bounds.maxLat ?? bounds._northEast?.lat);
      const minLng = typeof bounds.getWest === 'function' ? bounds.getWest() : (bounds.minLng ?? bounds._southWest?.lng);
      const maxLng = typeof bounds.getEast === 'function' ? bounds.getEast() : (bounds.maxLng ?? bounds._northEast?.lng);

      const cx = ((lng - minLng) / (maxLng - minLng)) * outW;
      const cy = ((maxLat - lat) / (maxLat - minLat)) * outH;
      return { cx, cy };
    },

    /** 後方互換性用ダミーメソッド */
    bringToFront() {},
    initLeafletLayer() {},
    toggleLayer() { return false; }
  };

})(window.GIS = window.GIS || {});
