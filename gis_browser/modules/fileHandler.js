/**
 * fileHandler.js - ファイルタイプ判定と適切なハンドラへの振り分け
 * GIS Browser - Leaflet WebGIS
 */
(function (GIS) {
  'use strict';

  /** サポートする拡張子とハンドラのマッピング */
  const EXT_MAP = {
    kml:     'kml',
    kmz:     'kml',
    geojson: 'geojson',
    json:    'geojson',
    gpx:     'gpx',
    tif:     'geotiff',
    tiff:    'geotiff',
    jpg:     'image',
    jpeg:    'image',
    png:     'image',
    heic:    'image',
    heif:    'image',
    webp:    'image',
  };

  GIS.FileHandler = {

    /**
     * ファイル配列を受け取り、各ファイルを適切なハンドラへ振り分ける
     * @param {File[]} files
     */
    async handleFiles(files) {
      for (const file of files) {
        const type = this._detectType(file);
        if (!type) {
          GIS.UI.showToast(`⚠️ 非対応のファイル形式です: ${file.name}`, 'warn');
          continue;
        }
        GIS.UI.showToast(`📂 読み込み中: ${file.name}`, 'info');
        try {
          switch (type) {
            case 'kml':     await GIS.KmlParser.load(file); break;
            case 'geojson': await GIS.GeoJsonHandler.load(file); break;
            case 'gpx':     await GIS.GpxHandler.load(file); break;
            case 'image':   await GIS.ImageHandler.load(file); break;
            case 'geotiff': await GIS.GeoTiffHandler.load(file); break;
          }
        } catch (err) {
          console.error('[FileHandler] Error:', file.name, err);
          GIS.UI.showToast(`❌ 読み込みエラー: ${file.name}\n${err.message}`, 'error');
        }
      }
    },

    /**
     * ファイルのタイプを判定する
     * MIMEタイプと拡張子の両方で判定（堅牢性確保）
     * @param {File} file
     * @returns {string|null} 'kml' | 'geojson' | 'gpx' | 'image' | 'geotiff' | null
     */
    _detectType(file) {
      // 拡張子で判定
      const ext = file.name.split('.').pop().toLowerCase();
      if (EXT_MAP[ext]) return EXT_MAP[ext];

      // MIMEタイプで判定（拡張子がない場合のフォールバック）
      const mime = file.type.toLowerCase();
      if (mime.includes('kml')) return 'kml';
      if (mime === 'application/geo+json' || mime === 'application/json') return 'geojson';
      if (mime === 'application/gpx+xml' || mime.includes('gpx')) return 'gpx';
      if (mime.startsWith('image/tiff')) return 'geotiff';
      if (mime.startsWith('image/')) return 'image';

      return null;
    }
  };

})(window.GIS = window.GIS || {});
