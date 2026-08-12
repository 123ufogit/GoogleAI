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
     * @param {Array} ring - [[lng, lat], ...] または [{lat, lng}, ...]
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
        // 穴 (hole) の判定
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
     * GeoJSON ジオメトリの最小矩形バウンディングボックス (BBox) を計算する
     */
    _getBboxOfGeometry(geometry) {
      let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
      const processCoord = (pt) => {
        const lng = Array.isArray(pt) ? pt[0] : pt.lng;
        const lat = Array.isArray(pt) ? pt[1] : pt.lat;
        if (lng < minLng) minLng = lng;
        if (lng > maxLng) maxLng = lng;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
      };
      const processRing = ring => ring.forEach(processCoord);

      if (geometry.type === 'Polygon') {
        geometry.coordinates.forEach(processRing);
      } else if (geometry.type === 'MultiPolygon') {
        geometry.coordinates.forEach(poly => poly.forEach(processRing));
      }
      return { minLng, maxLng, minLat, maxLat };
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
     * 1レイヤー解析 (「低」: 0~4 / 「高」: 5~9)
     */
    _analyzeSingleLayer(geometry, polygonAreaM2, geotiffEntry) {
      const info = geotiffEntry.geotiffInfo;
      const { rasterData, outW, outH, bounds, samplesPerPixel = 1 } = info;
      if (!rasterData || !bounds) return '';

      const minLat = typeof bounds.getSouth === 'function' ? bounds.getSouth() : bounds.minLat;
      const maxLat = typeof bounds.getNorth === 'function' ? bounds.getNorth() : bounds.maxLat;
      const minLng = typeof bounds.getWest === 'function' ? bounds.getWest() : bounds.minLng;
      const maxLng = typeof bounds.getEast === 'function' ? bounds.getEast() : bounds.maxLng;

      // ポリゴンと GeoTIFF の交差 BBox を計算して高速走査
      const polyBbox = this._getBboxOfGeometry(geometry);
      const startLng = Math.max(minLng, polyBbox.minLng);
      const endLng = Math.min(maxLng, polyBbox.maxLng);
      const startLat = Math.max(minLat, polyBbox.minLat);
      const endLat = Math.min(maxLat, polyBbox.maxLat);

      if (startLng >= endLng || startLat >= endLat) return ''; // 交差なし

      const minPx = Math.max(0, Math.floor(((startLng - minLng) / (maxLng - minLng)) * outW));
      const maxPx = Math.min(outW, Math.ceil(((endLng - minLng) / (maxLng - minLng)) * outW));
      const minPy = Math.max(0, Math.floor(((maxLat - endLat) / (maxLat - minLat)) * outH));
      const maxPy = Math.min(outH, Math.ceil(((maxLat - startLat) / (maxLat - minLat)) * outH));

      let countHigh = 0; // 5~9
      let countLow = 0;  // 0~4
      let countTotalValid = 0;

      const stride = samplesPerPixel || 1;

      for (let py = minPy; py < maxPy; py++) {
        const lat = maxLat - ((py + 0.5) / outH) * (maxLat - minLat);
        for (let px = minPx; px < maxPx; px++) {
          const lng = minLng + ((px + 0.5) / outW) * (maxLng - minLng);

          if (!this.isPointInGeometry(lng, lat, geometry)) continue;

          const val = rasterData[(py * outW + px) * stride];
          // 有効ピクセル 0 <= val <= 9
          if (val === undefined || isNaN(val) || val < 0 || val > 9) continue;

          countTotalValid++;
          // 0~4 は「低」、5~9 (4超) は「高」
          if (val > 4.0) {
            countHigh++;
          } else {
            countLow++;
          }
        }
      }

      if (countTotalValid === 0) return '';

      const pctHigh = ((countHigh / countTotalValid) * 100).toFixed(1);
      const pctLow = ((countLow / countTotalValid) * 100).toFixed(1);

      const areaHigh = (polygonAreaM2 * (countHigh / countTotalValid));
      const areaLow = (polygonAreaM2 * (countLow / countTotalValid));

      const formatArea = (m2) => m2 >= 10000 ? `${(m2 / 10000).toFixed(2)} ha` : `${m2.toFixed(0)} m²`;
      const modeName = GIS.UI ? GIS.UI.escHtml(geotiffEntry.name || 'GeoTIFF') : (geotiffEntry.name || 'GeoTIFF');

      const colorHigh = info.colorHigh || '#ffff00';
      const colorLow = info.colorLow || '#00d7ff';

      return `
        <div class="zoning-analysis-card">
          <div class="zoning-analysis-title">📊 ゾーニング解析 (${modeName})</div>
          <div class="zoning-item zoning-high">
            <span class="zoning-badge" style="background:${colorHigh}; color:${this._getTextColor(colorHigh)};">高 (5〜9)</span>
            <span class="zoning-val">${countHigh} px (${formatArea(areaHigh)})</span>
            <span class="zoning-pct">${pctHigh}%</span>
          </div>
          <div class="zoning-bar-bg"><div class="zoning-bar-fill" style="width:${pctHigh}%; background:${colorHigh};"></div></div>

          <div class="zoning-item zoning-low" style="margin-top:6px;">
            <span class="zoning-badge" style="background:${colorLow}; color:${this._getTextColor(colorLow)};">低 (0〜4)</span>
            <span class="zoning-val">${countLow} px (${formatArea(areaLow)})</span>
            <span class="zoning-pct">${pctLow}%</span>
          </div>
          <div class="zoning-bar-bg"><div class="zoning-bar-fill" style="width:${pctLow}%; background:${colorLow};"></div></div>
        </div>
      `;
    },

    /**
     * Hex カラーコードを {r, g, b} オブジェクトに変換
     */
    _hexToRgb(hex) {
      let c = (hex || '#000000').replace('#', '');
      if (c.length === 3) c = c.split('').map(x => x + x).join('');
      const num = parseInt(c, 16);
      return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
    },

    /**
     * 2つの Hex カラーを透過率 50% ずつで重ね合わせた合成色 rgb(...) を計算する
     */
    _blendColors50(hex1, hex2) {
      const c1 = this._hexToRgb(hex1);
      const c2 = this._hexToRgb(hex2);
      const r = Math.round(c1.r * 0.5 + c2.r * 0.5);
      const g = Math.round(c1.g * 0.5 + c2.g * 0.5);
      const b = Math.round(c1.b * 0.5 + c2.b * 0.5);
      return `rgb(${r}, ${g}, ${b})`;
    },

    /**
     * 背景色に応じた最適な視認性の高い文字色 (#000000 または #ffffff) を判定
     */
    _getTextColor(colorStr) {
      let r = 128, g = 128, b = 128;
      if (colorStr.startsWith('rgb')) {
        const matches = colorStr.match(/\d+/g);
        if (matches && matches.length >= 3) {
          r = parseInt(matches[0], 10);
          g = parseInt(matches[1], 10);
          b = parseInt(matches[2], 10);
        }
      } else {
        const rgb = this._hexToRgb(colorStr);
        r = rgb.r; g = rgb.g; b = rgb.b;
      }
      const brightness = (r * 299 + g * 587 + b * 114) / 1000;
      return brightness > 140 ? '#000000' : '#ffffff';
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

      const { rasterData: rDataP, outW: outWP, outH: outHP, bounds: boundsP, samplesPerPixel: strideP = 1 } = infoP;
      const { rasterData: rDataR, outW: outWR, outH: outHR, bounds: boundsR, samplesPerPixel: strideR = 1 } = infoR;

      // 各レイヤー設定に基づく高・低カラーコード
      const profHigh = infoP.colorHigh || '#ffff00';
      const profLow  = infoP.colorLow  || '#00d7ff';
      const riskHigh = infoR.colorHigh || '#ff55ff';
      const riskLow  = infoR.colorLow  || '#00d7ff';

      // 50% 透過重畳色の動的計算
      const colorZ1 = this._blendColors50(profHigh, riskLow);  // 収益高 / リスク低
      const colorZ2 = this._blendColors50(profHigh, riskHigh); // 収益高 / リスク高
      const colorZ3 = this._blendColors50(profLow,  riskLow);  // 収益低 / リスク低
      const colorZ4 = this._blendColors50(profLow,  riskHigh); // 収益低 / リスク高

      const minLatP = typeof boundsP.getSouth === 'function' ? boundsP.getSouth() : boundsP.minLat;
      const maxLatP = typeof boundsP.getNorth === 'function' ? boundsP.getNorth() : boundsP.maxLat;
      const minLngP = typeof boundsP.getWest === 'function' ? boundsP.getWest() : boundsP.minLng;
      const maxLngP = typeof boundsP.getEast === 'function' ? boundsP.getEast() : boundsP.maxLng;

      const minLatR = typeof boundsR.getSouth === 'function' ? boundsR.getSouth() : boundsR.minLat;
      const maxLatR = typeof boundsR.getNorth === 'function' ? boundsR.getNorth() : boundsR.maxLat;
      const minLngR = typeof boundsR.getWest === 'function' ? boundsR.getWest() : boundsR.minLng;
      const maxLngR = typeof boundsR.getEast === 'function' ? boundsR.getEast() : boundsR.maxLng;

      // ポリゴンと GeoTIFF P の交差 BBox 計算
      const polyBbox = this._getBboxOfGeometry(geometry);
      const startLng = Math.max(minLngP, polyBbox.minLng);
      const endLng = Math.min(maxLngP, polyBbox.maxLng);
      const startLat = Math.max(minLatP, polyBbox.minLat);
      const endLat = Math.min(maxLatP, polyBbox.maxLat);

      if (startLng >= endLng || startLat >= endLat) return ''; // 交差なし

      const minPx = Math.max(0, Math.floor(((startLng - minLngP) / (maxLngP - minLngP)) * outWP));
      const maxPx = Math.min(outWP, Math.ceil(((endLng - minLngP) / (maxLngP - minLngP)) * outWP));
      const minPy = Math.max(0, Math.floor(((maxLatP - endLat) / (maxLatP - minLatP)) * outHP));
      const maxPy = Math.min(outHP, Math.ceil(((maxLatP - startLat) / (maxLatP - minLatP)) * outHP));

      let z1Count = 0; // 収益性:高(5~9), リスク:低(0~4)
      let z2Count = 0; // 収益性:高(5~9), リスク:高(5~9)
      let z3Count = 0; // 収益性:低(0~4), リスク:低(0~4)
      let z4Count = 0; // 収益性:低(0~4), リスク:高(5~9)
      let totalValid = 0;

      for (let py = minPy; py < maxPy; py++) {
        const lat = maxLatP - ((py + 0.5) / outHP) * (maxLatP - minLatP);
        for (let px = minPx; px < maxPx; px++) {
          const lng = minLngP + ((px + 0.5) / outWP) * (maxLngP - minLngP);

          if (!this.isPointInGeometry(lng, lat, geometry)) continue;

          const valP = rDataP[(py * outWP + px) * strideP];
          if (valP === undefined || isNaN(valP) || valP < 0 || valP > 9) continue;

          // リスクレイヤーのピクセル位置
          const pxR = Math.floor(((lng - minLngR) / (maxLngR - minLngR)) * outWR);
          const pyR = Math.floor(((maxLatR - lat) / (maxLatR - minLatR)) * outHR);

          if (pxR < 0 || pxR >= outWR || pyR < 0 || pyR >= outHR) continue;
          const valR = rDataR[(pyR * outWR + pxR) * strideR];
          if (valR === undefined || isNaN(valR) || valR < 0 || valR > 9) continue;

          totalValid++;
          const isProfHigh = valP > 4.0; // 0~4:低, 5~9:高
          const isRiskHigh = valR > 4.0; // 0~4:低, 5~9:高

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
            <span class="zoning-badge" style="background:${colorZ1}; color:${this._getTextColor(colorZ1)};">ゾーニング１ (収益高/リスク低)</span>
            <span class="zoning-val">${z1.count} px (${z1.areaStr})</span>
            <span class="zoning-pct">${z1.pct}%</span>
          </div>
          <div class="zoning-bar-bg"><div class="zoning-bar-fill" style="width:${z1.pct}%; background:${colorZ1};"></div></div>

          <div class="zoning-item" style="margin-top:4px;">
            <span class="zoning-badge" style="background:${colorZ2}; color:${this._getTextColor(colorZ2)};">ゾーニング２ (収益高/リスク高)</span>
            <span class="zoning-val">${z2.count} px (${z2.areaStr})</span>
            <span class="zoning-pct">${z2.pct}%</span>
          </div>
          <div class="zoning-bar-bg"><div class="zoning-bar-fill" style="width:${z2.pct}%; background:${colorZ2};"></div></div>

          <div class="zoning-item" style="margin-top:4px;">
            <span class="zoning-badge" style="background:${colorZ3}; color:${this._getTextColor(colorZ3)};">ゾーニング３ (収益低/リスク低)</span>
            <span class="zoning-val">${z3.count} px (${z3.areaStr})</span>
            <span class="zoning-pct">${z3.pct}%</span>
          </div>
          <div class="zoning-bar-bg"><div class="zoning-bar-fill" style="width:${z3.pct}%; background:${colorZ3};"></div></div>

          <div class="zoning-item" style="margin-top:4px;">
            <span class="zoning-badge" style="background:${colorZ4}; color:${this._getTextColor(colorZ4)};">ゾーニング４ (収益低/リスク高)</span>
            <span class="zoning-val">${z4.count} px (${z4.areaStr})</span>
            <span class="zoning-pct">${z4.pct}%</span>
          </div>
          <div class="zoning-bar-bg"><div class="zoning-bar-fill" style="width:${z4.pct}%; background:${colorZ4};"></div></div>
        </div>
      `;
    }

  };

})(window.GIS = window.GIS || {});
