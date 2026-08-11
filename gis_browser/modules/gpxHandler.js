/**
 * gpxHandler.js - GPXファイルの解析とLeaflet表示
 * 外部ライブラリ不要（DOMParser + Leafletのみ使用）
 *
 * 対応要素:
 *   <wpt>  - ウェイポイント → CircleMarker
 *   <trkpt>/<trkseg>/<trk> - トラック → Polyline
 *   <rtept>/<rte>          - ルート   → Polyline
 *
 * GIS Browser - Leaflet WebGIS
 */
(function (GIS) {
  'use strict';

  /** トラック線の色パレット（複数トラックを色分け） */
  const TRACK_COLORS = [
    '#ff6b35', '#7c3aed', '#00d4ff', '#22c55e',
    '#f59e0b', '#ec4899', '#06b6d4', '#84cc16'
  ];

  GIS.GpxHandler = {

    /**
     * GPXファイルを読み込み、地図に表示する
     * @param {File} file
     */
    async load(file) {
      const text = await file.text();

      const parser = new DOMParser();
      const xmlDoc = parser.parseFromString(text, 'application/xml');

      // XML解析エラー確認
      const parseError = xmlDoc.querySelector('parsererror');
      if (parseError) {
        throw new Error('GPXの解析に失敗しました。ファイルが正しいGPX形式か確認してください。');
      }

      // <gpx> ルート要素の確認
      const gpxRoot = xmlDoc.querySelector('gpx');
      if (!gpxRoot) {
        throw new Error('GPXファイルの形式が不正です（<gpx>要素が見つかりません）。');
      }

      const layerGroup = L.featureGroup();
      let featureCount = 0;
      let colorIndex = 0;
      const gpxPoints = [];

      // --------------------------------------------------
      // 1. ウェイポイント <wpt>
      // --------------------------------------------------
      const wpts = xmlDoc.querySelectorAll('gpx > wpt');
      wpts.forEach(wpt => {
        const lat = parseFloat(wpt.getAttribute('lat'));
        const lon = parseFloat(wpt.getAttribute('lon'));
        if (isNaN(lat) || isNaN(lon)) return;

        const name = wpt.querySelector('name')?.textContent?.trim() || '(名称なし)';
        const desc = wpt.querySelector('desc')?.textContent?.trim() || '';
        const ele  = wpt.querySelector('ele')?.textContent?.trim();
        const time = wpt.querySelector('time')?.textContent?.trim();

        const timeMs = time ? new Date(time).getTime() : null;
        if (timeMs && !isNaN(timeMs)) {
          gpxPoints.push({ lat, lon, timeMs, name });
        }

        const popupHtml = this._buildWptPopup(name, desc, ele, time, lat, lon);

        const marker = L.circleMarker([lat, lon], {
          radius:      9,
          fillColor:   '#facc15',
          color:       '#fff',
          weight:      2,
          fillOpacity: 0.95
        }).bindPopup(popupHtml);

        layerGroup.addLayer(marker);
        featureCount++;
      });

      // --------------------------------------------------
      // 2. トラック <trk> / <trkseg> / <trkpt>
      // --------------------------------------------------
      const tracks = xmlDoc.querySelectorAll('gpx > trk');
      tracks.forEach(trk => {
        const trkName = trk.querySelector('name')?.textContent?.trim() || '(名称なし)';
        const color = TRACK_COLORS[colorIndex % TRACK_COLORS.length];
        colorIndex++;

        let totalDist = 0;
        const allSegPoints = []; // 全セグメントの点を蓄積（全体距離計算用）

        trk.querySelectorAll('trkseg').forEach(seg => {
          const pts = seg.querySelectorAll('trkpt');
          const latlngs = [];

          pts.forEach(pt => {
            const lat = parseFloat(pt.getAttribute('lat'));
            const lon = parseFloat(pt.getAttribute('lon'));
            if (!isNaN(lat) && !isNaN(lon)) {
              latlngs.push([lat, lon]);
              allSegPoints.push([lat, lon]);
              const timeStr = pt.querySelector('time')?.textContent?.trim();
              const timeMs = timeStr ? new Date(timeStr).getTime() : null;
              if (timeMs && !isNaN(timeMs)) {
                gpxPoints.push({ lat, lon, timeMs, name: trkName });
              }
            }
          });

          if (latlngs.length < 2) return;

          // セグメント線を描画（クリック時は後でポップアップを上書き）
          const polyline = L.polyline(latlngs, {
            color:   color,
            weight:  4,
            opacity: 0.85
          });
          layerGroup.addLayer(polyline);
        });

        // トラック全体の距離を計算してポップアップを設定
        if (allSegPoints.length >= 2) {
          totalDist = this._calcLineLength(allSegPoints);
          const startPt = allSegPoints[0];
          const endPt   = allSegPoints[allSegPoints.length - 1];

          // 開始点・終了点にマーカーを置く
          const startIcon = L.divIcon({
            className: '',
            html: `<div class="gpx-endpoint gpx-start" title="開始点: ${this._escHtml(trkName)}">▶</div>`,
            iconSize:   [20, 20],
            iconAnchor: [10, 10]
          });
          const endIcon = L.divIcon({
            className: '',
            html: `<div class="gpx-endpoint gpx-end" title="終了点: ${this._escHtml(trkName)}">■</div>`,
            iconSize:   [20, 20],
            iconAnchor: [10, 10]
          });

          const popupHtml = this._buildTrkPopup(trkName, totalDist, allSegPoints.length, color);

          // ライン全体にポップアップを付けるため、FeatureGroupで包む
          const trkGroup = L.featureGroup();

          // セグメントを再追加（ポップアップ付き）
          trk.querySelectorAll('trkseg').forEach(seg => {
            const pts = seg.querySelectorAll('trkpt');
            const latlngs = [];
            pts.forEach(pt => {
              const lat = parseFloat(pt.getAttribute('lat'));
              const lon = parseFloat(pt.getAttribute('lon'));
              if (!isNaN(lat) && !isNaN(lon)) latlngs.push([lat, lon]);
            });
            if (latlngs.length < 2) return;
            L.polyline(latlngs, {
              color:   color,
              weight:  4,
              opacity: 0.85
            }).bindPopup(popupHtml).addTo(trkGroup);
          });

          L.marker(startPt, { icon: startIcon }).bindPopup(
            `<div class="gpx-popup"><strong>🟢 開始点</strong><br>${this._escHtml(trkName)}</div>`
          ).addTo(trkGroup);

          L.marker(endPt, { icon: endIcon }).bindPopup(
            `<div class="gpx-popup"><strong>🔴 終了点</strong><br>${this._escHtml(trkName)}</div>`
          ).addTo(trkGroup);

          // layerGroup から先に追加した生ラインを除去して trkGroup を追加
          // （上で layerGroup に追加した分は trkGroup で上書き）
          layerGroup.clearLayers();
          // wpt を再追加（clearLayers で消えるため）
          wpts.forEach(wpt => {
            const lat = parseFloat(wpt.getAttribute('lat'));
            const lon = parseFloat(wpt.getAttribute('lon'));
            if (isNaN(lat) || isNaN(lon)) return;
            const name = wpt.querySelector('name')?.textContent?.trim() || '(名称なし)';
            const desc = wpt.querySelector('desc')?.textContent?.trim() || '';
            const ele  = wpt.querySelector('ele')?.textContent?.trim();
            const time = wpt.querySelector('time')?.textContent?.trim();
            L.circleMarker([lat, lon], {
              radius: 9, fillColor: '#facc15',
              color: '#fff', weight: 2, fillOpacity: 0.95
            }).bindPopup(this._buildWptPopup(name, desc, ele, time, lat, lon))
              .addTo(layerGroup);
          });

          trkGroup.addTo(layerGroup);
          featureCount++;
        }
      });

      // --------------------------------------------------
      // 3. ルート <rte> / <rtept>
      // --------------------------------------------------
      const routes = xmlDoc.querySelectorAll('gpx > rte');
      routes.forEach(rte => {
        const rteName = rte.querySelector('name')?.textContent?.trim() || '(名称なし)';
        const color = TRACK_COLORS[colorIndex % TRACK_COLORS.length];
        colorIndex++;

        const pts = rte.querySelectorAll('rtept');
        const latlngs = [];

        pts.forEach(pt => {
          const lat = parseFloat(pt.getAttribute('lat'));
          const lon = parseFloat(pt.getAttribute('lon'));
          if (!isNaN(lat) && !isNaN(lon)) latlngs.push([lat, lon]);
        });

        if (latlngs.length < 2) return;

        const dist = this._calcLineLength(latlngs);
        const popupHtml = this._buildRtePopup(rteName, dist, latlngs.length, color);

        L.polyline(latlngs, {
          color:     color,
          weight:    4,
          opacity:   0.85,
          dashArray: '8, 5'   // ルートは破線で区別
        }).bindPopup(popupHtml).addTo(layerGroup);

        featureCount++;
      });

      if (featureCount === 0 && wpts.length === 0) {
        throw new Error('GPXファイルにウェイポイント・トラック・ルートが見つかりませんでした。');
      }

      // ウェイポイントだけの場合もカウントに含める
      if (featureCount === 0) featureCount = wpts.length;

      layerGroup._gpxPoints = gpxPoints;

      GIS.AppState.addLayer({
        name:  file.name,
        type:  'gpx',
        layer: layerGroup,
        file:  file
      });

      // 読み込んだレイヤーの範囲にフィット
      try {
        const bounds = layerGroup.getBounds();
        if (bounds.isValid()) {
          GIS.AppState.map.fitBounds(bounds, { padding: [40, 40] });
        }
      } catch (e) {
        console.warn('[GpxHandler] fitBounds failed:', e);
      }

      GIS.UI.showToast(`✅ GPX読み込み完了: ${featureCount}フィーチャ (${file.name})`, 'success');
    },

    // ------------------------------------------------------------------
    // ポップアップ HTML 生成
    // ------------------------------------------------------------------

    /**
     * ウェイポイントのポップアップHTMLを生成する
     */
    _buildWptPopup(name, desc, ele, time, lat, lon) {
      const eleRow  = ele  ? `<tr><td class="popup-key">標高</td><td class="popup-val">${parseFloat(ele).toFixed(1)} m</td></tr>` : '';
      const timeRow = time ? `<tr><td class="popup-key">時刻</td><td class="popup-val">${this._escHtml(time)}</td></tr>` : '';
      const coordRow = `<tr><td class="popup-key">座標</td><td class="popup-val">${lat.toFixed(6)}, ${lon.toFixed(6)}</td></tr>`;
      return `
        <div class="gpx-popup">
          <strong class="popup-name">📍 ${this._escHtml(name)}</strong>
          ${desc ? `<p class="popup-desc">${this._escHtml(desc)}</p>` : ''}
          <table class="popup-table">
            ${eleRow}${timeRow}${coordRow}
          </table>
        </div>`;
    },

    /**
     * トラックのポップアップHTMLを生成する
     */
    _buildTrkPopup(name, distM, ptCount, color) {
      return `
        <div class="gpx-popup">
          <strong class="popup-name">🛤️ ${this._escHtml(name)}</strong>
          <div class="popup-measure-badge popup-distance">
            📏 距離: <strong>${this._formatDistance(distM)}</strong>
          </div>
          <table class="popup-table">
            <tr><td class="popup-key">ポイント数</td><td class="popup-val">${ptCount.toLocaleString()} pt</td></tr>
            <tr><td class="popup-key">種別</td>
              <td class="popup-val">
                <span style="display:inline-block;width:12px;height:12px;
                  background:${color};border-radius:2px;margin-right:4px;"></span>トラック
              </td>
            </tr>
          </table>
        </div>`;
    },

    /**
     * ルートのポップアップHTMLを生成する
     */
    _buildRtePopup(name, distM, ptCount, color) {
      return `
        <div class="gpx-popup">
          <strong class="popup-name">🗺️ ${this._escHtml(name)}</strong>
          <div class="popup-measure-badge popup-distance">
            📏 距離: <strong>${this._formatDistance(distM)}</strong>
          </div>
          <table class="popup-table">
            <tr><td class="popup-key">ポイント数</td><td class="popup-val">${ptCount.toLocaleString()} pt</td></tr>
            <tr><td class="popup-key">種別</td>
              <td class="popup-val">
                <span style="display:inline-block;width:12px;height:12px;
                  background:${color};border-radius:2px;margin-right:4px;"></span>ルート（破線）
              </td>
            </tr>
          </table>
        </div>`;
    },

    // ------------------------------------------------------------------
    // 測量計算（Haversine公式）
    // ------------------------------------------------------------------

    /**
     * ラインの測地線距離を返す（m）
     * @param {Array} latlngs - [[lat, lon], ...]
     * @returns {number}
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
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    }
  };

})(window.GIS = window.GIS || {});
