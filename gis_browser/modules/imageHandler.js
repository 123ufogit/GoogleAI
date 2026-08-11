/**
 * imageHandler.js - 画像EXIF解析・360°検出・ピン生成
 * GIS Browser - Leaflet WebGIS
 */
(function (GIS) {
  'use strict';

  /** exifr ライブラリのCDN URL（UMD ブラウザ対応ビルド） */
  const EXIFR_CDN = 'https://cdn.jsdelivr.net/npm/exifr@7.1.3/dist/full.umd.js';

  /** exifr の読み込み状態 */
  let exifrReady = false;
  let exifrLoading = false;
  let exifrCallbacks = [];

  GIS.ImageHandler = {

    /**
     * 画像ファイルを読み込む（EXIF解析→ピン生成 or キューへ）
     * @param {File} file
     */
    async load(file) {
      await this._ensureExifr();

      // DataURL を取得
      const dataUrl = await this._fileToDataUrl(file);

      // EXIF解析
      let exif = null;
      try {
        exif = await window.exifr.parse(file, {
          tiff: true, exif: true, gps: true, xmp: true,
          translateKeys: true, translateValues: true, reviveValues: true
        });
      } catch (e) {
        console.warn('[ImageHandler] EXIF parse error:', e);
      }

      // 360°全天球画像かどうか判定
      const is360 = this._detect360(file.name, dataUrl, exif);

      // GPS情報の取得
      const latlng = this._extractLatLng(exif);

      // 撮影日時の取得
      const timestamp = this._extractTimestamp(exif);

      if (latlng) {
        // 位置情報あり → 地図にピンを追加
        this._addPinToMap(file.name, dataUrl, latlng, is360);
        GIS.UI.showToast(`📍 位置情報を読み取り、ピンを追加しました: ${file.name}`, 'success');
      } else {
        // 位置情報なし → 撮影位置特定キューへ
        GIS.AppState.enqueuePendingImage({ file, dataUrl, filename: file.name, is360, timestamp });
        GIS.UI.showToast(`📷 位置情報なし: ${file.name} — 撮影位置を特定してください`, 'warn');

        // キューが開始されていなければ開始する
        if (!GIS.AppState.locationMode && GIS.AppState.pendingImages.length === 1) {
          GIS.PinEditor.start();
        }
      }
    },

    /**
     * 地図上にピンを追加する（内部共通処理）
     * @param {string} filename
     * @param {string} dataUrl
     * @param {L.LatLng} latlng
     * @param {boolean} is360
     * @returns {string} pinId
     */
    _addPinToMap(filename, dataUrl, latlng, is360 = false) {
      const thumbnail = this._createThumbnail(dataUrl, 240, 180);
      const icon = this._createCameraIcon(is360);

      const marker = L.marker(latlng, { icon, draggable: false });

      const badge360 = is360 ? '<span class="badge-360">360°</span>' : '';
      // pinIdは後で設定する（まず markerを作成）
      const pinId = GIS.AppState.generateId();
      marker.bindPopup(`
        <div class="image-popup">
          <div class="image-popup-header">
            ${badge360}
            <strong>${GIS.UI.escHtml(filename)}</strong>
          </div>
          <img src="${thumbnail}"
               class="image-popup-thumb"
               alt="${GIS.UI.escHtml(filename)}"
               data-src="${thumbnail}"
               data-pin-id="${pinId}"
               data-alt="${GIS.UI.escHtml(filename)}"
               data-is360="${is360}"
               title="クリックで拡大">
          <div class="image-popup-coords">
            📍 ${latlng.lat.toFixed(6)}, ${latlng.lng.toFixed(6)}
          </div>
        </div>
      `, { maxWidth: 280 });

      // ピンを登録（フル解像度dataUrlも保存）
      GIS.AppState.addPinWithId(pinId, { latlng, filename, thumbnail, dataUrl, is360, marker });

      // ピンをレイヤーとしても登録（管理・削除のため）
      GIS.AppState.addLayer({ name: filename, type: 'pin', layer: marker, file: null });

      // 地図をピン位置に移動
      GIS.AppState.map.setView(latlng, Math.max(GIS.AppState.map.getZoom(), 14));

      return pinId;
    },

    /**
     * ピンを地図に追加する（外部からも呼び出し可能）
     * @param {string} filename
     * @param {string} dataUrl
     * @param {L.LatLng} latlng
     * @param {boolean} is360
     * @returns {string}
     */
    addPin(filename, dataUrl, latlng, is360 = false) {
      return this._addPinToMap(filename, dataUrl, latlng, is360);
    },

    /**
     * EXIFからGPS座標を取得する
     * @param {object|null} exif
     * @returns {L.LatLng|null}
     */
    _extractLatLng(exif) {
      if (!exif) return null;

      // exifr が解析した場合（reviveValues:true）
      if (typeof exif.latitude === 'number' && typeof exif.longitude === 'number') {
        const lat = exif.latitude;
        const lon = exif.longitude;
        if (isNaN(lat) || isNaN(lon) || (lat === 0 && lon === 0)) return null;
        return L.latLng(lat, lon);
      }

      return null;
    },

    /**
     * EXIFから撮影日時のタイムスタンプ（ミリ秒）を取得する
     * @param {object|null} exif
     * @returns {number|null}
     */
    _extractTimestamp(exif) {
      if (!exif) return null;
      const dateVal = exif.DateTimeOriginal || exif.CreateDate || exif.ModifyDate || exif.DateTime;
      if (!dateVal) return null;
      if (dateVal instanceof Date && !isNaN(dateVal.getTime())) {
        return dateVal.getTime();
      }
      if (typeof dateVal === 'string') {
        const d = new Date(dateVal);
        if (!isNaN(d.getTime())) return d.getTime();
      }
      return null;
    },

    /**
     * 360°全天球画像かどうかを判定する
     * @param {string} filename
     * @param {string} dataUrl
     * @param {object|null} exif
     * @returns {boolean}
     */
    _detect360(filename, dataUrl, exif) {
      // ファイル名ヒント
      const name = filename.toLowerCase();
      if (/360|pano|panorama|sphere|equirect|ricoh|insta360|theta/i.test(name)) return true;

      // XMP メタデータ
      if (exif) {
        const projType = exif.ProjectionType || exif.projectionType;
        if (projType && String(projType).toLowerCase().includes('equirectangular')) return true;
        if (exif.UsePanoramaViewer === true) return true;
        if (exif.CroppedAreaImageWidthPixels && exif.FullPanoWidthPixels) return true;
      }

      // アスペクト比（2:1 ≒ 全天球）
      // DataURLから画像を読み込んでアスペクト比を確認
      // 非同期になるが、ここでは同期的に判定できないため、後続でチェックする
      // DataURLのBase64サイズから大まかな判定は困難なので、ここではXMPとファイル名のみ
      return false;
    },

    /**
     * アスペクト比から360°かどうかを判定する（非同期）
     * @param {string} dataUrl
     * @returns {Promise<boolean>}
     */
    async _checkAspectRatio(dataUrl) {
      return new Promise(resolve => {
        const img = new Image();
        img.onload = () => {
          const ratio = img.naturalWidth / img.naturalHeight;
          resolve(Math.abs(ratio - 2.0) < 0.2); // 2:1 ± 10%
        };
        img.onerror = () => resolve(false);
        img.src = dataUrl;
      });
    },

    /**
     * サムネイル用DataURLを作成する
     * @param {string} dataUrl
     * @param {number} maxW
     * @param {number} maxH
     * @returns {string}
     */
    _createThumbnail(dataUrl, maxW, maxH) {
      // 注: これは同期的に返せないのでここでは元のdataUrlを返す
      // 実際の圧縮はPinEditor内で行われる
      return dataUrl;
    },

    /**
     * カメラアイコンを作成する（360°の場合は色を変える）
     * @param {boolean} is360
     * @returns {L.DivIcon}
     */
    _createCameraIcon(is360) {
      const color = is360 ? '#ff6b35' : '#00d4ff';
      const emoji = is360 ? '🌐' : '📷';
      return L.divIcon({
        className: 'camera-icon',
        html: `<div class="camera-marker" style="background:${color}">${emoji}</div>`,
        iconSize: [36, 36],
        iconAnchor: [18, 36],
        popupAnchor: [0, -36]
      });
    },

    /**
     * FileをDataURLに変換する
     * @param {File} file
     * @returns {Promise<string>}
     */
    _fileToDataUrl(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = e => resolve(e.target.result);
        reader.onerror = () => reject(new Error('ファイルの読み込みに失敗しました。'));
        reader.readAsDataURL(file);
      });
    },

    /**
     * exifrライブラリを動的に読み込む（初回のみ）
     * @returns {Promise<void>}
     */
    _ensureExifr() {
      if (exifrReady) return Promise.resolve();
      if (exifrLoading) {
        return new Promise((resolve, reject) => exifrCallbacks.push({ resolve, reject }));
      }

      exifrLoading = true;
      return new Promise((resolve, reject) => {
        exifrCallbacks.push({ resolve, reject });
        const script = document.createElement('script');
        script.src = EXIFR_CDN;
        script.onload = () => {
          exifrReady = true;
          exifrLoading = false;
          exifrCallbacks.forEach(cb => cb.resolve());
          exifrCallbacks = [];
        };
        script.onerror = () => {
          exifrLoading = false;
          const err = new Error('EXIFライブラリの読み込みに失敗しました。ネットワーク接続を確認してください。');
          exifrCallbacks.forEach(cb => cb.reject(err));
          exifrCallbacks = [];
          reject(err);
        };
        document.head.appendChild(script);
      });
    }
  };

})(window.GIS = window.GIS || {});
