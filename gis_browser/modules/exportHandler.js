/**
 * exportHandler.js - GeoJSON / KML / PDF（html2canvas+jsPDF）エクスポート
 * GIS Browser - Leaflet WebGIS
 */
(function (GIS) {
  'use strict';

  /** html2canvas CDN */
  const HTML2CANVAS_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
  /** jsPDF CDN */
  const JSPDF_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';

  let exportLibsReady = false;
  let exportLibsLoading = false;
  let exportCallbacks = [];

  GIS.ExportHandler = {

    /**
     * AppState 内の全ベクトルレイヤー (手描きポリゴン、KML、GeoJSON) の Feature 一覧を取得
     */
    _getVectorFeatures() {
      const features = [];
      if (!GIS.AppState || !GIS.AppState.layers) return features;

      GIS.AppState.layers.forEach((entry) => {
        if (entry.type === 'geotiff' || entry.type === 'pin') return;

        let geojson = entry.rawGeoJSON;
        if (!geojson && entry.layer && typeof entry.layer.toGeoJSON === 'function') {
          try { geojson = entry.layer.toGeoJSON(); } catch (_) {}
        }

        if (!geojson) return;

        if (geojson.type === 'FeatureCollection' && Array.isArray(geojson.features)) {
          geojson.features.forEach(f => {
            const copy = JSON.parse(JSON.stringify(f));
            if (!copy.properties) copy.properties = {};
            if (!copy.properties.name) copy.properties.name = entry.name;
            features.push(copy);
          });
        } else if (geojson.type === 'Feature') {
          const copy = JSON.parse(JSON.stringify(geojson));
          if (!copy.properties) copy.properties = {};
          if (!copy.properties.name) copy.properties.name = entry.name;
          features.push(copy);
        } else if (geojson.type && geojson.coordinates) {
          features.push({
            type: 'Feature',
            geometry: geojson,
            properties: { name: entry.name }
          });
        }
      });
      return features;
    },

    /**
     * 全ピンおよびベクトルデータ (ポリゴン等) をGeoJSON形式でダウンロードする
     */
    exportGeoJSON() {
      const pins = GIS.AppState.pins || [];
      const vectorFeatures = this._getVectorFeatures();

      if (!pins.length && !vectorFeatures.length) {
        GIS.UI.showToast('⚠️ エクスポートするデータ（ピンまたはポリゴン等）がありません', 'warn');
        return;
      }

      const pinFeatures = pins.map(pin => ({
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: [pin.latlng.lng, pin.latlng.lat]
        },
        properties: {
          name:      pin.filename,
          filename:  pin.filename,
          is360:     pin.is360,
          timestamp: new Date().toISOString()
        }
      }));

      const features = [...pinFeatures, ...vectorFeatures];

      const geojson = {
        type: 'FeatureCollection',
        features,
        metadata: {
          created:   new Date().toISOString(),
          generator: 'GIS Browser - Leaflet WebGIS',
          count:     features.length
        }
      };

      const json = JSON.stringify(geojson, null, 2);
      this._download(
        new Blob([json], { type: 'application/geo+json' }),
        `gis_export_${this._timestamp()}.geojson`
      );

      GIS.UI.showToast(`✅ GeoJSONを保存しました (ピン: ${pinFeatures.length}, 図形: ${vectorFeatures.length})`, 'success');
    },

    /**
     * 全ピンおよびベクトルデータ (ポリゴン等) をKML形式でダウンロードする
     */
    exportKML() {
      const pins = GIS.AppState.pins || [];
      const vectorFeatures = this._getVectorFeatures();

      if (!pins.length && !vectorFeatures.length) {
        GIS.UI.showToast('⚠️ エクスポートするデータ（ピンまたはポリゴン等）がありません', 'warn');
        return;
      }

      const pinPlacemarks = pins.map(pin => `
    <Placemark>
      <name>${this._escXml(pin.filename)}</name>
      <description><![CDATA[
        ファイル名: ${this._escXml(pin.filename)}<br>
        ${pin.is360 ? '360°全天球画像<br>' : ''}
        緯度: ${pin.latlng.lat.toFixed(8)}<br>
        経度: ${pin.latlng.lng.toFixed(8)}
      ]]></description>
      <Style>
        <IconStyle>
          <color>ff${pin.is360 ? '356bff' : 'ffd400'}</color>
          <scale>1.0</scale>
          <Icon>
            <href>https://maps.google.com/mapfiles/kml/pushpin/ylw-pushpin.png</href>
          </Icon>
        </IconStyle>
      </Style>
      <Point>
        <coordinates>${pin.latlng.lng.toFixed(8)},${pin.latlng.lat.toFixed(8)},0</coordinates>
      </Point>
    </Placemark>`).join('\n');

      const vectorPlacemarks = vectorFeatures.map((f, i) => {
        const name = this._escXml(f.properties?.name || `Polygon ${i + 1}`);
        const geom = f.geometry;
        if (!geom) return '';

        let kmlGeom = '';
        if (geom.type === 'Polygon') {
          const outerRing = geom.coordinates[0] || [];
          const coordsStr = outerRing.map(pt => `${pt[0]},${pt[1]},0`).join(' ');
          kmlGeom = `
      <Polygon>
        <outerBoundaryIs>
          <LinearRing>
            <coordinates>${coordsStr}</coordinates>
          </LinearRing>
        </outerBoundaryIs>
      </Polygon>`;
        } else if (geom.type === 'MultiPolygon') {
          const polys = geom.coordinates.map(poly => {
            const outerRing = poly[0] || [];
            const coordsStr = outerRing.map(pt => `${pt[0]},${pt[1]},0`).join(' ');
            return `
      <Polygon>
        <outerBoundaryIs>
          <LinearRing>
            <coordinates>${coordsStr}</coordinates>
          </LinearRing>
        </outerBoundaryIs>
      </Polygon>`;
          }).join('\n');
          kmlGeom = `<MultiGeometry>${polys}</MultiGeometry>`;
        } else if (geom.type === 'LineString') {
          const coordsStr = geom.coordinates.map(pt => `${pt[0]},${pt[1]},0`).join(' ');
          kmlGeom = `<LineString><coordinates>${coordsStr}</coordinates></LineString>`;
        } else if (geom.type === 'Point') {
          kmlGeom = `<Point><coordinates>${geom.coordinates[0]},${geom.coordinates[1]},0</coordinates></Point>`;
        }

        return `
    <Placemark>
      <name>${name}</name>
      <Style>
        <LineStyle><color>ff00d7ff</color><width>2</width></LineStyle>
        <PolyStyle><color>7f00d7ff</color></PolyStyle>
      </Style>
      ${kmlGeom}
    </Placemark>`;
      }).filter(Boolean).join('\n');

      const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>GIS Browser エクスポート</name>
    <description>生成日時: ${new Date().toLocaleString('ja-JP')}</description>
    ${pinPlacemarks}
    ${vectorPlacemarks}
  </Document>
</kml>`;

      this._download(
        new Blob([kml], { type: 'application/vnd.google-earth.kml+xml' }),
        `gis_export_${this._timestamp()}.kml`
      );

      GIS.UI.showToast(`✅ KMLを保存しました (ピン: ${pins.length}, 図形: ${vectorFeatures.length})`, 'success');
    },

    /**
     * 地図をPDF（A4横）またはPNG画像で出力する
     * html2canvas + jsPDF を動的ロードして使用
     */
    async exportPDF() {
      GIS.UI.showToast('🖨️ PDF出力の準備中...', 'info');

      try {
        await this._ensureExportLibs();
      } catch (e) {
        GIS.UI.showToast('❌ PDF出力ライブラリの読み込みに失敗しました', 'error');
        return;
      }

      // フローティングパネルとUIを一時非表示
      GIS.FloatingPanel.setVisible(false);
      const overlay = document.getElementById('location-mode-overlay');
      const preview = document.getElementById('photo-preview-panel');
      const toast   = document.getElementById('toast');
      overlay.classList.add('hidden');
      preview.classList.add('hidden');
      toast.classList.add('hidden');

      // 地図コンテナを取得
      const mapEl = document.getElementById('map');

      try {
        // Leafletタイルを確実に表示するため少し待つ
        await new Promise(r => setTimeout(r, 500));

        const canvas = await window.html2canvas(mapEl, {
          useCORS:         true,
          allowTaint:      true,
          scale:           window.devicePixelRatio || 1,
          logging:         false,
          foreignObjectRendering: false
        });

        // PDF出力ダイアログ
        const format = await this._askExportFormat();

        if (format === 'png') {
          // PNG として保存
          canvas.toBlob(blob => {
            this._download(blob, `gis_map_${this._timestamp()}.png`);
            GIS.UI.showToast('✅ PNG画像を保存しました', 'success');
          }, 'image/png');

        } else {
          // PDF（A4横）として保存
          const { jsPDF } = window.jspdf;
          const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });

          const pdfW = pdf.internal.pageSize.getWidth();
          const pdfH = pdf.internal.pageSize.getHeight();
          const imgW = canvas.width;
          const imgH = canvas.height;
          const ratio = Math.min(pdfW / imgW, pdfH / imgH);
          const w = imgW * ratio;
          const h = imgH * ratio;
          const x = (pdfW - w) / 2;
          const y = (pdfH - h) / 2;

          const imgData = canvas.toDataURL('image/jpeg', 0.92);
          pdf.addImage(imgData, 'JPEG', x, y, w, h);
          pdf.save(`gis_map_${this._timestamp()}.pdf`);
          GIS.UI.showToast('✅ PDFを保存しました', 'success');
        }

      } catch (err) {
        console.error('[ExportHandler] PDF export error:', err);
        GIS.UI.showToast(`❌ 出力エラー: ${err.message}`, 'error');
      } finally {
        // UIを元に戻す
        GIS.FloatingPanel.setVisible(true);
      }
    },

    /**
     * 出力形式（PDF / PNG）を選択するダイアログを表示する
     * @returns {Promise<'pdf'|'png'>}
     */
    _askExportFormat() {
      return new Promise(resolve => {
        const modal = document.getElementById('export-format-modal');
        modal.classList.remove('hidden');

        const onPdf = () => { cleanup(); resolve('pdf'); };
        const onPng = () => { cleanup(); resolve('png'); };
        const cleanup = () => {
          modal.classList.add('hidden');
          document.getElementById('export-format-pdf').removeEventListener('click', onPdf);
          document.getElementById('export-format-png').removeEventListener('click', onPng);
        };

        document.getElementById('export-format-pdf').addEventListener('click', onPdf);
        document.getElementById('export-format-png').addEventListener('click', onPng);
      });
    },

    /**
     * Blobをダウンロードする
     * @param {Blob} blob
     * @param {string} filename
     */
    _download(blob, filename) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    },

    /**
     * タイムスタンプ文字列を生成する (YYYYMMDD_HHmmss)
     * @returns {string}
     */
    _timestamp() {
      return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
    },

    /**
     * XML特殊文字をエスケープする
     * @param {string} str
     * @returns {string}
     */
    _escXml(str) {
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
    },

    /**
     * html2canvas と jsPDF を動的に読み込む（初回のみ）
     * @returns {Promise<void>}
     */
    _ensureExportLibs() {
      if (exportLibsReady) return Promise.resolve();
      if (exportLibsLoading) {
        return new Promise((resolve, reject) => exportCallbacks.push({ resolve, reject }));
      }

      exportLibsLoading = true;
      return new Promise((resolve, reject) => {
        exportCallbacks.push({ resolve, reject });

        const loadScript = (src) => new Promise((res, rej) => {
          const s = document.createElement('script');
          s.src = src;
          s.onload = res;
          s.onerror = () => rej(new Error(`Failed to load: ${src}`));
          document.head.appendChild(s);
        });

        loadScript(HTML2CANVAS_CDN)
          .then(() => loadScript(JSPDF_CDN))
          .then(() => {
            exportLibsReady = true;
            exportLibsLoading = false;
            exportCallbacks.forEach(cb => cb.resolve());
            exportCallbacks = [];
          })
          .catch(err => {
            exportLibsLoading = false;
            exportCallbacks.forEach(cb => cb.reject(err));
            exportCallbacks = [];
            reject(err);
          });
      });
    }
  };

})(window.GIS = window.GIS || {});
