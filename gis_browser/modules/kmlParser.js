/**
 * kmlParser.js - KMLファイルの解析とLeaflet表示
 * 外部ライブラリ不要（DOMParser + Leafletのみ使用）
 * GIS Browser - Leaflet WebGIS
 */
(function (GIS) {
  'use strict';

  GIS.KmlParser = {

    /**
     * KMLファイルを読み込み、地図に表示する
     * @param {File} file
     */
    async load(file) {
      let xmlText;

      if (file.name.toLowerCase().endsWith('.kmz')) {
        // KMZ（ZIP圧縮KML）の処理
        // ブラウザのDecompressionStream (Chrome 80+, Firefox 113+)を使用
        try {
          xmlText = await this._readKmz(file);
        } catch (e) {
          throw new Error('KMZファイルの解凍に失敗しました。KMLファイルに変換してから再試行してください。');
        }
      } else {
        xmlText = await file.text();
      }

      const parser = new DOMParser();
      const xmlDoc = parser.parseFromString(xmlText, 'application/xml');

      const parseError = xmlDoc.querySelector('parsererror');
      if (parseError) throw new Error('KMLの解析に失敗しました。ファイルが壊れている可能性があります。');

      const layerGroup = L.featureGroup();
      const styles = this._parseStyles(xmlDoc);
      let featureCount = 0;

      xmlDoc.querySelectorAll('Placemark').forEach(placemark => {
        const layers = this._placemarkToLeaflet(placemark, styles);
        layers.forEach(l => { layerGroup.addLayer(l); featureCount++; });
      });

      if (featureCount === 0) throw new Error('KMLファイルにフィーチャが見つかりませんでした。');

      const id = GIS.AppState.addLayer({
        name: file.name,
        type: 'kml',
        layer: layerGroup,
        file: file
      });

      // 読み込んだレイヤーの範囲にフィット
      try {
        const bounds = layerGroup.getBounds();
        if (bounds.isValid()) GIS.AppState.map.fitBounds(bounds, { padding: [40, 40] });
      } catch (e) { /* ポイントのみの場合はfitBoundsが失敗することがある */ }

      GIS.UI.showToast(`✅ KML読み込み完了: ${featureCount}フィーチャ (${file.name})`, 'success');
    },

    /**
     * KMZファイルを解凍してKMLテキストを取得する
     * @param {File} file
     * @returns {Promise<string>}
     */
    async _readKmz(file) {
      // DecompressionStream APIで ZIP を解凍する
      // KMZはZIPでありJSZipなしで直接扱えないため、簡易フォールバックを実装
      // ここでは最初のファイル（通常 doc.kml）を取り出す
      const arrayBuffer = await file.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);

      // ZIP Local File Headerを探してKMLを抽出
      return this._extractKmlFromZip(bytes);
    },

    /**
     * ZIP バイト列から最初の .kml ファイルを抽出する
     * @param {Uint8Array} bytes
     * @returns {string}
     */
    _extractKmlFromZip(bytes) {
      const decoder = new TextDecoder('utf-8');
      let offset = 0;

      while (offset < bytes.length - 30) {
        // Local file header signature: PK (0x50 0x4B 0x03 0x04)
        if (bytes[offset] !== 0x50 || bytes[offset + 1] !== 0x4B ||
          bytes[offset + 2] !== 0x03 || bytes[offset + 3] !== 0x04) {
          offset++;
          continue;
        }

        const compressionMethod = bytes[offset + 8] | (bytes[offset + 9] << 8);
        const compressedSize = bytes[offset + 18] | (bytes[offset + 19] << 8) |
          (bytes[offset + 20] << 16) | (bytes[offset + 21] << 24);
        const filenameLength = bytes[offset + 26] | (bytes[offset + 27] << 8);
        const extraLength = bytes[offset + 28] | (bytes[offset + 29] << 8);

        const filename = decoder.decode(bytes.slice(offset + 30, offset + 30 + filenameLength));
        const dataOffset = offset + 30 + filenameLength + extraLength;

        if (filename.toLowerCase().endsWith('.kml') && compressionMethod === 0) {
          // 無圧縮ストアのKMLを直接デコード
          return decoder.decode(bytes.slice(dataOffset, dataOffset + compressedSize));
        }

        offset = dataOffset + compressedSize;
      }

      throw new Error('KMZファイル内にKMLが見つかりません（無圧縮のみ対応）。');
    },

    /**
     * KML内のStyleタグを解析してスタイルマップを返す
     * @param {Document} xmlDoc
     * @returns {Map<string, object>}
     */
    _parseStyles(xmlDoc) {
      const styles = new Map();

      xmlDoc.querySelectorAll('Style').forEach(styleEl => {
        const id = styleEl.getAttribute('id');
        if (!id) return;
        const style = {};

        const lineStyle = styleEl.querySelector('LineStyle');
        if (lineStyle) {
          style.lineColor = this._kmlColorToHex(lineStyle.querySelector('color')?.textContent);
          style.lineWidth = parseFloat(lineStyle.querySelector('width')?.textContent) || 2;
        }

        const polyStyle = styleEl.querySelector('PolyStyle');
        if (polyStyle) {
          style.fillColor = this._kmlColorToHex(polyStyle.querySelector('color')?.textContent);
          style.fill = polyStyle.querySelector('fill')?.textContent !== '0';
        }

        const iconStyle = styleEl.querySelector('IconStyle');
        if (iconStyle) {
          style.iconColor = this._kmlColorToHex(iconStyle.querySelector('color')?.textContent);
        }

        styles.set('#' + id, style);
      });

      // StyleMap の解決
      xmlDoc.querySelectorAll('StyleMap').forEach(smEl => {
        const id = smEl.getAttribute('id');
        const normalPair = smEl.querySelector('Pair key');
        // normalペアのstyleUrlを参照
        const normalUrl = smEl.querySelector('Pair styleUrl')?.textContent;
        if (id && normalUrl && styles.has(normalUrl)) {
          styles.set('#' + id, styles.get(normalUrl));
        }
      });

      return styles;
    },

    /**
     * KML色コード（aabbggrr）をCSS hex色に変換する
     * @param {string|undefined} kmlColor
     * @returns {string}
     */
    _kmlColorToHex(kmlColor) {
      if (!kmlColor || kmlColor.length < 8) return '#3388ff';
      const a = kmlColor.slice(0, 2);
      const b = kmlColor.slice(2, 4);
      const g = kmlColor.slice(4, 6);
      const r = kmlColor.slice(6, 8);
      return `#${r}${g}${b}`;
    },

    /**
     * PlacemarkをLeafletのLayerに変換する
     * @param {Element} placemark
     * @param {Map} styles
     * @returns {L.Layer[]}
     */
    _placemarkToLeaflet(placemark, styles) {
      const name = placemark.querySelector('name')?.textContent || '(名称なし)';
      const desc = placemark.querySelector('description')?.textContent || '';
      const styleUrl = placemark.querySelector('styleUrl')?.textContent;
      const style = styles.get(styleUrl) || {};
      const layers = [];

      // Point
      placemark.querySelectorAll('Point coordinates').forEach(coords => {
        const [lon, lat] = coords.textContent.trim().split(',').map(Number);
        if (isNaN(lat) || isNaN(lon)) return;
        const popupHtml = `<div class="kml-popup">
          <strong>${this._escHtml(name)}</strong>
          ${desc ? `<div class="kml-desc">${this._escHtml(desc)}</div>` : ''}
        </div>`;
        const marker = L.circleMarker([lat, lon], {
          radius: 8,
          fillColor: style.iconColor || '#00d4ff',
          color: '#fff',
          weight: 2,
          fillOpacity: 0.9
        }).bindPopup(popupHtml);
        layers.push(marker);
      });

      // LineString（距離バッジ付き）
      placemark.querySelectorAll('LineString coordinates').forEach(coords => {
        const latlngs = this._parseCoords(coords.textContent);
        if (!latlngs.length) return;
        const dist = this._calcLineLength(latlngs);
        const popupHtml = `<div class="kml-popup">
          <strong>${this._escHtml(name)}</strong>
          ${desc ? `<div class="kml-desc">${this._escHtml(desc)}</div>` : ''}
          <div class="popup-measure-badge popup-distance">
            📏 距離: <strong>${this._formatDistance(dist)}</strong>
          </div>
        </div>`;
        const polyline = L.polyline(latlngs, {
          color: style.lineColor || '#ff6b35',
          weight: style.lineWidth || 3,
          opacity: 0.85
        }).bindPopup(popupHtml);
        layers.push(polyline);
      });

      // Polygon（面積バッジ付き）
      placemark.querySelectorAll('Polygon').forEach(polygon => {
        const outerCoords = polygon.querySelector('outerBoundaryIs coordinates');
        if (!outerCoords) return;
        const outerRing = this._parseCoords(outerCoords.textContent);

        const holes = [];
        polygon.querySelectorAll('innerBoundaryIs coordinates').forEach(inner => {
          holes.push(this._parseCoords(inner.textContent));
        });

        const latlngs = holes.length ? [outerRing, ...holes] : outerRing;

        // [lat,lon] -> [lon,lat] に変換して面積計算
        const lonlatRing = outerRing.map(([lat, lon]) => [lon, lat]);
        const area = this._calcPolygonArea(lonlatRing);
        const popupHtml = `<div class="kml-popup">
          <strong>${this._escHtml(name)}</strong>
          ${desc ? `<div class="kml-desc">${this._escHtml(desc)}</div>` : ''}
          <div class="popup-measure-badge popup-area">
            📐 面積: <strong>${this._formatArea(area)}</strong>
          </div>
        </div>`;

        const poly = L.polygon(latlngs, {
          color: style.lineColor || '#7c3aed',
          fillColor: style.fillColor || '#7c3aed',
          weight: style.lineWidth || 2,
          fillOpacity: style.fill === false ? 0 : 0.3,
          opacity: 0.9
        }).bindPopup(popupHtml);
        layers.push(poly);
      });

      return layers;
    },

    /**
     * KML座標テキストを [lat, lon] の配列に変換する
     * @param {string} text - "lon,lat,alt lon,lat,alt ..."
     * @returns {Array<[number,number]>}
     */
    _parseCoords(text) {
      return text.trim().split(/\s+/).map(pair => {
        const [lon, lat] = pair.split(',').map(Number);
        return isNaN(lat) || isNaN(lon) ? null : [lat, lon];
      }).filter(Boolean);
    },

    // ------------------------------------------------------------------
    // 測量計算（球面三角法）
    // ------------------------------------------------------------------

    /**
     * ポリゴンリング（[lon,lat] 配列）の球面積を返す（m²）
     * @param {Array} ring - [[lon,lat], ...]
     * @returns {number} 面積（m²）
     */
    _calcPolygonArea(ring) {
      if (!ring || ring.length < 3) return 0;
      const R = 6371008.8;
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
     * ラインの測地線距離を返す（m）。KMLは [lat,lon] 順なので変換して使用
     * @param {Array} latlngs - [[lat,lon], ...]
     * @returns {number} 距離（m）
     */
    _calcLineLength(latlngs) {
      if (!latlngs || latlngs.length < 2) return 0;
      const R = 6371008.8;
      let total = 0;
      for (let i = 0; i < latlngs.length - 1; i++) {
        const [lat1, lon1] = latlngs[i];
        const [lat2, lon2] = latlngs[i + 1];
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
      if (m2 >= 1e6) return (m2 / 1e6).toFixed(3) + ' km²';
      if (m2 >= 1e4) return (m2 / 1e4).toFixed(2) + ' ha';
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
     * @param {string} str
     * @returns {string}
     */
    _escHtml(str) {
      return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
  };

})(window.GIS = window.GIS || {});
