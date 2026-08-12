/**
 * zoningAnalysis.js - GeoTIFF ピクセルとポリゴンの空間重畳解析モジュール
 * GIS Browser - Leaflet WebGIS
 */
(function (GIS) {
  'use strict';

  GIS.ZoningAnalysis = {

    /**
     * 点 (lng, lat) が GeoJSON ポリゴン（リング配列）の内部にあるか判定する Ray Casting (光線判定) アルゴリズム
     * @param {number} lng 
     * @param {number} lat 
     * @param {Array} ring - [[lng, lat], ...]
     * @returns {boolean}
     */
    pointInPolygon(lng, lat, ring) {
      if (!ring || ring.length < 3) return false;
      let inside = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = Array.isArray(ring[i]) ? ring[i][0] : ring[i].lng;
        const yi = Array.isArray(ring[i]) ? ring[i][1] : ring[i].lat;
        const xj = Array.isArray(ring[j]) ? ring[j][0] : ring[j].lng;
        const yj = Array.isArray(ring[j]) ? ring[j][1] : ring[j].lat;

        const intersect = ((yi > lat) !== (yj > lat)) &&
          (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi);
        if (intersect) inside = !inside;
      }
      return inside;
    },

    /**
     * ポリゴン要素 (Feature / Polygon / MultiPolygon) 内に点 (lng, lat) が含まれるか
     */
    isPointInGeometry(lng, lat, geometry) {
      if (!geometry) return false;
      if (geometry.type === 'Polygon') {
        const outerRing = geometry.coordinates[0];
        if (!this.pointInPolygon(lng, lat, outerRing)) return false;
        // 穴 (hole) の判定 (穴の内部にある場合は除外)
        for (let h = 1; h < geometry.coordinates.length; h++) {
          if (this.pointInPolygon(lng, lat, geometry.coordinates[h])) return false;
        }
        return true;
      } else if (geometry.type === 'MultiPolygon') {
        return geometry.coordinates.some(polyCoords => {
          if (this.pointInPolygon(lng, lat, polyCoords[0])) {
            for (let h = 1; h < polyCoords.length; h++) {
              if (this.pointInPolygon(lng, lat, polyCoords[h])) return false;
            }
            return true;
          }
          return false;
        });
      }
      return false;
    },

    /**
     * 現在マップ上に表示されているアクティブな GeoTIFF レイヤーを取得
     */
    getActiveGeoTIFFLayers() {
      const geotiffLayers = [];
      if (!GIS.AppState || !GIS.AppState.layers) return geotiffLayers;

      GIS.AppState.layers.forEach((entry) => {
        if (entry.type === 'geotiff' && entry.visible && entry.geotiffInfo) {
          geotiffLayers.push(entry);
        }
      });
      return geotiffLayers;
    },

    /**
     * ポリゴンに対して GeoTIFF ピクセル解析を行い、ポップアップ用HTMLを生成する
     * @param {object} geometry - GeoJSON Geometry
     * @param {number} polygonAreaM2 - ポリゴン面積 (m²)
     * @returns {string} ポップアップ内に挿入する HTML（解析不可時は空文字）
     */
    analyzePolygonZoning(geometry, polygonAreaM2) {
      const geotiffLayers = this.getActiveGeoTIFFLayers();
      if (!geotiffLayers || geotiffLayers.length === 0) return '';

      if (geotiffLayers.length === 1) {
        return this._analyzeSingleLayer(geometry, polygonAreaM2, geotiffLayers[0]);
      } else {
        // 2つ以上のレイヤーがある場合は、最初の2つ（収益性と災害リスク）を対象に重畳解析
        return this._analyzeDualLayers(geometry, polygonAreaM2, geotiffLayers[0], geotiffLayers[1]);
      }
    },

    /**
     * 1レイヤー解析 (「高」: 5~9 / 「低」: 0~4)
     */
    _analyzeSingleLayer(geometry, polygonAreaM2, geotiffEntry) {
      const info = geotiffEntry.geotiffInfo;
      const { rasterData, outW, outH, bounds, threshold = 4.0 } = info;
      if (!rasterData || !bounds) return '';

      const minLat = typeof bounds.getSouth === 'function' ? bounds.getSouth() : bounds.minLat;
      const maxLat = typeof bounds.getNorth === 'function' ? bounds.getNorth() : bounds.maxLat;
      const minLng = typeof bounds.getWest === 'function' ? bounds.getWest() : bounds.minLng;
      const maxLng = typeof bounds.getEast === 'function' ? bounds.getEast() : bounds.maxLng;

      let countHigh = 0;
      let countLow = 0;
      let countTotalValid = 0;

      for (let py = 0; py < outH; py++) {
        const lat = maxLat - ((py + 0.5) / outH) * (maxLat - minLat);
        for (let px = 0; px < outW; px++) {
          const lng = minLng + ((px + 0.5) / outW) * (maxLng - minLng);

          if (!this.isPointInGeometry(lng, lat, geometry)) continue;

          const val = rasterData[py * outW + px];
          // 有効ピクセル 0 <= val <= 9
          if (val === undefined || isNaN(val) || val < 0 || val > 9) continue;

          countTotalValid++;
          // 0~4 は「低」、5~9 (または threshold 超) は「高」
          const t = (threshold !== undefined) ? threshold : 4.0;
          if (val > t) {
            countHigh++;
          } else {
            countLow++;
          }
        }
      }

      if (countTotalValid === 0) return '';

      const pctHigh = ((countHigh / countTotalValid) * 100).toFixed(1);
      const pctLow = ((countLow / countTotalValid) * 100).toFixed(1);

      // 各区分の推定面積
      const areaHigh = (polygonAreaM2 * (countHigh / countTotalValid));
      const areaLow = (polygonAreaM2 * (countLow / countTotalValid));

      const formatArea = (m2) => m2 >= 10000 ? `${(m2 / 10000).toFixed(2)} ha` : `${m2.toFixed(0)} m²`;

      const modeName = GIS.UI ? GIS.UI.escHtml(geotiffEntry.name || 'GeoTIFF') : (geotiffEntry.name || 'GeoTIFF');

      return `
        <div class="zoning-analysis-card">
          <div class="zoning-analysis-title">📊 ゾーニング解析 (${modeName})</div>
          <div class="zoning-item zoning-high">
            <span class="zoning-badge badge-high">高 (5〜9)</span>
            <span class="zoning-val">${countHigh} px (${formatArea(areaHigh)})</span>
            <span class="zoning-pct">${pctHigh}%</span>
          </div>
          <div class="zoning-bar-bg"><div class="zoning-bar-fill fill-high" style="width:${pctHigh}%"></div></div>

          <div class="zoning-item zoning-low" style="margin-top:6px;">
            <span class="zoning-badge badge-low">低 (0〜4)</span>
            <span class="zoning-val">${countLow} px (${formatArea(areaLow)})</span>
            <span class="zoning-pct">${pctLow}%</span>
          </div>
          <div class="zoning-bar-bg"><div class="zoning-bar-fill fill-low" style="width:${pctLow}%"></div></div>
        </div>
      `;
    },

    /**
     * 2レイヤー重畳解析 (ゾーニング１〜４)
     */
    _analyzeDualLayers(geometry, polygonAreaM2, entry1, entry2) {
      let profEntry = entry1;
      let riskEntry = entry2;

      if (entry2.geotiffInfo?.mode === 'profitability' || entry1.geotiffInfo?.mode === 'disaster_risk') {
        profEntry = entry1.geotiffInfo?.mode === 'profitability' ? entry1 : entry2;
        riskEntry = profEntry === entry1 ? entry2 : entry1;
      }

      const infoP = profEntry.geotiffInfo;
      const infoR = riskEntry.geotiffInfo;
      if (!infoP.rasterData || !infoR.rasterData) return '';

      const { rasterData: rDataP, outW: outWP, outH: outHP, bounds: boundsP, threshold: tP = 4.0 } = infoP;
      const { rasterData: rDataR, outW: outWR, outH: outHR, bounds: boundsR, threshold: tR = 4.0 } = infoR;

      const minLatP = typeof boundsP.getSouth === 'function' ? boundsP.getSouth() : boundsP.minLat;
      const maxLatP = typeof boundsP.getNorth === 'function' ? boundsP.getNorth() : boundsP.maxLat;
      const minLngP = typeof boundsP.getWest === 'function' ? boundsP.getWest() : boundsP.minLng;
      const maxLngP = typeof boundsP.getEast === 'function' ? boundsP.getEast() : boundsP.maxLng;

      const minLatR = typeof boundsR.getSouth === 'function' ? boundsR.getSouth() : boundsR.minLat;
      const maxLatR = typeof boundsR.getNorth === 'function' ? boundsR.getNorth() : boundsR.maxLat;
      const minLngR = typeof boundsR.getWest === 'function' ? boundsR.getWest() : boundsR.minLng;
      const maxLngR = typeof boundsR.getEast === 'function' ? boundsR.getEast() : boundsR.maxLng;

      let z1Count = 0; // 収益性:高, リスク:低
      let z2Count = 0; // 収益性:高, リスク:高
      let z3Count = 0; // 収益性:低, リスク:低
      let z4Count = 0; // 収益性:低, リスク:高
      let totalValid = 0;

      for (let py = 0; py < outHP; py++) {
        const lat = maxLatP - ((py + 0.5) / outHP) * (maxLatP - minLatP);
        for (let px = 0; px < outWP; px++) {
          const lng = minLngP + ((px + 0.5) / outWP) * (maxLngP - minLngP);

          if (!this.isPointInGeometry(lng, lat, geometry)) continue;

          const valP = rDataP[py * outWP + px];
          if (valP === undefined || isNaN(valP) || valP < 0 || valP > 9) continue;

          // リスクレイヤーのピクセル位置
          const pxR = Math.floor(((lng - minLngR) / (maxLngR - minLngR)) * outWR);
          const pyR = Math.floor(((maxLatR - lat) / (maxLatR - minLatR)) * outHR);

          if (pxR < 0 || pxR >= outWR || pyR < 0 || pyR >= outHR) continue;
          const valR = rDataR[pyR * outWR + pxR];
          if (valR === undefined || isNaN(valR) || valR < 0 || valR > 9) continue;

          totalValid++;
          const isProfHigh = valP > tP; // 0~4:低, 5~9:高
          const isRiskHigh = valR > tR; // 0~4:低, 5~9:高

          if (isProfHigh && !isRiskHigh) z1Count++;      // ゾーニング１: 収益高/リスク低
          else if (isProfHigh && isRiskHigh) z2Count++;  // ゾーニング２: 収益高/リスク高
          else if (!isProfHigh && !isRiskHigh) z3Count++; // ゾーニング３: 収益低/リスク低
          else if (!isProfHigh && isRiskHigh) z4Count++;  // ゾーニング４: 収益低/リスク高
        }
      }

      if (totalValid === 0) return '';

      const formatItem = (count) => {
        const pct = ((count / totalValid) * 100).toFixed(1);
        const area = polygonAreaM2 * (count / totalValid);
        const areaStr = area >= 10000 ? `${(area / 10000).toFixed(2)} ha` : `${area.toFixed(0)} m²`;
        return { count, pct, areaStr };
      };

      const z1 = formatItem(z1Count);
      const z2 = formatItem(z2Count);
      const z3 = formatItem(z3Count);
      const z4 = formatItem(z4Count);

      return `
        <div class="zoning-analysis-card">
          <div class="zoning-analysis-title">🌲 ゾーニング重畳解析 (2層)</div>
          
          <div class="zoning-item">
            <span class="zoning-badge z1-badge">ゾーニング１ (収益高/リスク低)</span>
            <span class="zoning-val">${z1.count} px (${z1.areaStr})</span>
            <span class="zoning-pct">${z1.pct}%</span>
          </div>
          <div class="zoning-bar-bg"><div class="zoning-bar-fill fill-z1" style="width:${z1.pct}%"></div></div>

          <div class="zoning-item" style="margin-top:4px;">
            <span class="zoning-badge z2-badge">ゾーニング２ (収益高/リスク高)</span>
            <span class="zoning-val">${z2.count} px (${z2.areaStr})</span>
            <span class="zoning-pct">${z2.pct}%</span>
          </div>
          <div class="zoning-bar-bg"><div class="zoning-bar-fill fill-z2" style="width:${z2.pct}%"></div></div>

          <div class="zoning-item" style="margin-top:4px;">
            <span class="zoning-badge z3-badge">ゾーニング３ (収益低/リスク低)</span>
            <span class="zoning-val">${z3.count} px (${z3.areaStr})</span>
            <span class="zoning-pct">${z3.pct}%</span>
          </div>
          <div class="zoning-bar-bg"><div class="zoning-bar-fill fill-z3" style="width:${z3.pct}%"></div></div>

          <div class="zoning-item" style="margin-top:4px;">
            <span class="zoning-badge z4-badge">ゾーニング４ (収益低/リスク高)</span>
            <span class="zoning-val">${z4.count} px (${z4.areaStr})</span>
            <span class="zoning-pct">${z4.pct}%</span>
          </div>
          <div class="zoning-bar-bg"><div class="zoning-bar-fill fill-z4" style="width:${z4.pct}%"></div></div>
        </div>
      `;
    }

  };

})(window.GIS = window.GIS || {});
