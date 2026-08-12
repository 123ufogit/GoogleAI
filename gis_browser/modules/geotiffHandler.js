/**
 * geotiffHandler.js - GeoTIFFファイルのデコードと地図オーバーレイ表示
 *
 * 【メモリ最適化】
 *   - fromBlob()              : file.arrayBuffer() を回避し初期メモリ削減
 *   - readRasters({w, h})    : 出力解像度で直接読み込みピーク使用量を大幅削減
 *   - チャンク分割描画         : UIスレッドをブロックしない
 *
 * GIS Browser - Leaflet WebGIS
 */
(function (GIS) {
  'use strict';

  /** geotiff.js ライブラリのCDN URL */
  const GEOTIFF_CDN = 'https://cdn.jsdelivr.net/npm/geotiff@2.1.3/dist-browser/geotiff.js';

  /** proj4.js ライブラリのCDN URL */
  const PROJ4_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/proj4js/2.15.0/proj4.js';

  /**
   * 出力画像の最大解像度（ピクセル）
   * これを超える画像は readRasters の段階で縮小する（Canvas確保前に縮小）
   */
  const MAX_RESAMPLE_SIZE = 2048;

  let geotiffReady   = false;
  let geotiffLoading = false;
  let geotiffCallbacks = [];

  let proj4Ready   = false;
  let proj4Loading = false;
  let proj4Callbacks = [];

  /**
   * 日本の平面直交座標系（1系〜19系）の原点パラメータ
   * [北緯 lat, 東経 lon]
   */
  const JGD_PLANE_ZONES = {
    1:  { lat: 33.0, lon: 129.5 },
    2:  { lat: 33.0, lon: 131.0 },
    3:  { lat: 36.0, lon: 132 + 10 / 60 },
    4:  { lat: 33.0, lon: 133.5 },
    5:  { lat: 36.0, lon: 134 + 20 / 60 },
    6:  { lat: 36.0, lon: 136.0 },
    7:  { lat: 36.0, lon: 137 + 10 / 60 },
    8:  { lat: 36.0, lon: 138.5 },
    9:  { lat: 36.0, lon: 139 + 50 / 60 },
    10: { lat: 40.0, lon: 140 + 50 / 60 },
    11: { lat: 44.0, lon: 140.25 },
    12: { lat: 44.0, lon: 142.25 },
    13: { lat: 44.0, lon: 144.25 },
    14: { lat: 26.0, lon: 142.0 },
    15: { lat: 26.0, lon: 127.5 },
    16: { lat: 26.0, lon: 124.0 },
    17: { lat: 26.0, lon: 131.0 },
    18: { lat: 20.0, lon: 136.0 },
    19: { lat: 26.0, lon: 154.0 }
  };

  GIS.GeoTiffHandler = {

    /**
     * GeoTIFFファイルを読み込み、地図にオーバーレイ表示する
     * @param {File} file
     */
    async load(file) {
      const sizeMB = (file.size / 1024 / 1024).toFixed(1);

      GIS.UI.showProgress(
        '🛰️ GeoTIFF 読み込み中',
        `${file.name} (${sizeMB} MB)`
      );

      try {
        // Step 1: ライブラリ読み込み
        GIS.UI.updateProgress(5, 'geotiff.js ライブラリを準備中...');
        await this._ensureGeotiff();

        // Step 2: Blob URL 経由で TIFF を開く
        GIS.UI.updateProgress(15, `TIFFを開いています... (${sizeMB} MB)`);
        await this._yield();
        const tiff  = await window.GeoTIFF.fromBlob(file);
        const image = await tiff.getImage();

        // Step 3: 画像サイズを確認して出力解像度を決定
        GIS.UI.updateProgress(28, 'TIFFヘッダを解析中...');
        await this._yield();
        const origW = image.getWidth();
        const origH = image.getHeight();

        let outW = origW;
        let outH = origH;
        if (origW > MAX_RESAMPLE_SIZE || origH > MAX_RESAMPLE_SIZE) {
          const scale = MAX_RESAMPLE_SIZE / Math.max(origW, origH);
          outW = Math.max(1, Math.round(origW * scale));
          outH = Math.max(1, Math.round(origH * scale));
        }
        const isDownsampled = (outW !== origW || outH !== origH);

        if (isDownsampled) {
          GIS.UI.updateProgress(32,
            `大きな画像 (${origW}×${origH}px) → ${outW}×${outH}px に縮小して読み込みます`);
          await this._yield();
        }

        // Step 4: 地理参照情報を取得
        GIS.UI.updateProgress(38, '地理参照情報と座標系を解析中...');
        await this._yield();
        const boundsInfo = await this._extractBounds(image);
        if (!boundsInfo || !boundsInfo.bounds) {
          throw new Error(
            'GeoTIFFの地理参照情報が見つかりません。\n' +
            '対応座標系: WGS84, Web Mercator, JGD2011/JGD2000 平面直交座標系 (第1系〜第19系)'
          );
        }

        const { bounds, crsName } = boundsInfo;

        // Step 5: ラスタを出力解像度で直接読み込んで Canvas 化
        GIS.UI.updateProgress(45, 'ラスタデータを読み込んでいます...');
        const rasterResult = await this._rasterToCanvas(
          image, outW, outH,
          (pct, msg) => GIS.UI.updateProgress(pct, msg)
        );

        const dataUrl = rasterResult.dataUrl;

        // Step 6: Leaflet へ追加
        GIS.UI.updateProgress(97, '地図に追加中...');
        await this._yield();

        const overlay = L.imageOverlay(dataUrl, bounds, {
          opacity: 0.5,
          interactive: true
        });

        overlay.on('click', () => {
          L.popup()
            .setLatLng(bounds.getCenter())
            .setContent(`
              <div class="geotiff-popup">
                <strong>🛠️ ${GIS.UI.escHtml(file.name)}</strong>
                <div>サイズ: ${sizeMB} MB</div>
                <div>座標系: <span style="color:#38bdf8;font-weight:600;">${GIS.UI.escHtml(crsName || '不明')}</span></div>
                <div>解像度: ${origW.toLocaleString()}×${origH.toLocaleString()}px</div>
                ${isDownsampled
                  ? `<div>表示サイズ: ${outW.toLocaleString()}×${outH.toLocaleString()}px</div>
                     <div class="compressed-badge">縮小表示中</div>`
                  : ''}
                ${rasterResult.minVal !== undefined && rasterResult.minVal !== Infinity
                  ? `<div style="margin-top:4px;font-size:11px;color:#94a3b8;">値範囲: ${rasterResult.minVal.toFixed(2)} 〜 ${rasterResult.maxVal.toFixed(2)}</div>`
                  : ''}
              </div>
            `)
            .openOn(GIS.AppState.map);
        });

        const minV = (rasterResult.minVal !== Infinity) ? rasterResult.minVal : 0;
        const maxV = (rasterResult.maxVal !== -Infinity) ? rasterResult.maxVal : 255;

        GIS.AppState.addLayer({
          name: file.name,
          type: 'geotiff',
          layer: overlay,
          file: file,
          geotiffInfo: {
            rasterData: rasterResult.rasterData,
            minVal: minV,
            maxVal: maxV,
            noData: rasterResult.noData,
            outW: outW,
            outH: outH,
            samplesPerPixel: rasterResult.samplesPerPixel,
            bounds: bounds,
            useForestMask: true,
            threshold: 4.0,
            colorLow: '#00d7ff',
            colorHigh: '#ffff00',
            opacity: 0.5,
            mode: 'profitability',
            initialDataUrl: dataUrl
          }
        });

        // 初回読み込み直後に 0〜9 閾値 ＆ 森林計画ベクトルタイルマスクを自動適用
        if (GIS.ZoningHandler) {
          const newLayerId = Array.from(GIS.AppState.layers.keys()).pop();
          if (newLayerId) {
            GIS.ZoningHandler.updateSymbology(newLayerId);
          }
        }

        GIS.AppState.map.fitBounds(bounds, { padding: [40, 40] });
        GIS.UI.hideProgress();
        GIS.UI.showToast(
          `✅ GeoTIFF読み込み完了 [${crsName}]: ${file.name}`,
          'success'
        );

      } catch (err) {
        GIS.UI.hideProgress();
        throw err;
      }
    },

    // ------------------------------------------------------------------
    // 地理参照情報の取得
    // ------------------------------------------------------------------

    /**
     * GeoTIFFの地理参照情報からLeafletのLatLngBoundsとCRS情報を生成する
     * EPSG:4326, EPSG:3857, JGD2011/JGD2000 平面直交系（第1系〜第19系）に対応
     * @param {GeoTIFF.GeoTIFFImage} image
     * @returns {Promise<{bounds: L.LatLngBounds, crsName: string}|null>}
     */
    async _extractBounds(image) {
      try {
        const bbox = image.getBoundingBox(); // [minX, minY, maxX, maxY]
        if (!bbox || bbox.length < 4) return null;

        const [minX, minY, maxX, maxY] = bbox;
        const geoKeys = image.getGeoKeys() || {};
        let epsg = geoKeys.ProjectedCSTypeGeoKey || geoKeys.GeographicTypeGeoKey;

        // ProjectedCSTypeGeoKey が User-Defined (32767) または未定義の場合のフォールバックチェック
        if (!epsg || epsg === 32767) {
          if (geoKeys.ProjectionGeoKey && geoKeys.ProjectionGeoKey >= 16001 && geoKeys.ProjectionGeoKey <= 16019) {
            epsg = 2442 + (geoKeys.ProjectionGeoKey - 16000); // JGD2000 平面直交 1~19系
          } else if (geoKeys.ProjectionGeoKey && geoKeys.ProjectionGeoKey >= 16101 && geoKeys.ProjectionGeoKey <= 16119) {
            epsg = 6668 + (geoKeys.ProjectionGeoKey - 16100); // JGD2011 平面直交 1~19系
          }
        }

        // 1. 日本の平面直交系 (JGD2011: 6669~6687, JGD2000: 2443~2461)
        if (epsg && ((epsg >= 6669 && epsg <= 6687) || (epsg >= 2443 && epsg <= 2461))) {
          await this._ensureProj4();
          const projInfo = this._registerJgdPlaneZone(epsg);
          if (projInfo) {
            const bounds = this._convertPlaneBboxToBounds(minX, minY, maxX, maxY, projInfo.epsgStr);
            return { bounds, crsName: `${projInfo.name} (EPSG:${epsg})` };
          }
        }

        // 2. EPSG:3857 (Web Mercator)
        if (epsg === 3857 || epsg === 900913) {
          const bounds = L.latLngBounds(
            this._merc2latlon(minX, minY),
            this._merc2latlon(maxX, maxY)
          );
          return { bounds, crsName: `Web Mercator (EPSG:${epsg})` };
        }

        // 3. EPSG:4326 (WGS84) または経緯度数値範囲内 (-180 <= X <= 180, -90 <= Y <= 90)
        if (minX >= -180 && maxX <= 180 && minY >= -90 && maxY <= 90) {
          const bounds = L.latLngBounds([minY, minX], [maxY, maxX]);
          return { bounds, crsName: epsg ? `WGS 84 (EPSG:${epsg})` : 'WGS 84 緯度経度' };
        }

        // 4. 平面座標系（メートル系）で EPSG コード未定義の場合の自動推定
        if (Math.abs(minX) > 180 || Math.abs(maxX) > 180 || Math.abs(minY) > 90 || Math.abs(maxY) > 90) {
          await this._ensureProj4();

          const estimatedZone = this._estimateJgdZone(minX, minY, maxX, maxY);
          if (estimatedZone) {
            const epsgEst = 6668 + estimatedZone;
            const projInfo = this._registerJgdPlaneZone(epsgEst);
            if (projInfo) {
              const bounds = this._convertPlaneBboxToBounds(minX, minY, maxX, maxY, projInfo.epsgStr);
              return { bounds, crsName: `${projInfo.name} (自動推定 EPSG:${epsgEst})` };
            }
          }

          // フォールバック: Web Mercator として変換を試みる
          const sw = this._merc2latlon(minX, minY);
          const ne = this._merc2latlon(maxX, maxY);
          if (sw[0] >= -90 && sw[0] <= 90 && ne[0] >= -90 && ne[0] <= 90) {
            return { bounds: L.latLngBounds(sw, ne), crsName: 'Web Mercator (推定)' };
          }
        }

        return null;
      } catch (e) {
        console.error('[GeoTiffHandler] Bounds extraction error:', e);
        return null;
      }
    },

    /**
     * 日本の平面直交系 EPSG コードを Proj4 に登録する
     * @param {number} epsg
     * @returns {{zone: number, name: string, epsgStr: string}|null}
     */
    _registerJgdPlaneZone(epsg) {
      if (!window.proj4) return null;
      let zone = null;
      let name = '';
      if (epsg >= 6669 && epsg <= 6687) {
        zone = epsg - 6668;
        name = `JGD2011 平面直交第${zone}系`;
      } else if (epsg >= 2443 && epsg <= 2461) {
        zone = epsg - 2442;
        name = `JGD2000 平面直交第${zone}系`;
      }
      if (!zone || !JGD_PLANE_ZONES[zone]) return null;

      const info = JGD_PLANE_ZONES[zone];
      const epsgStr = `EPSG:${epsg}`;
      if (!window.proj4.defs[epsgStr]) {
        const proj4Def = `+proj=tmerc +lat_0=${info.lat} +lon_0=${info.lon} +k=0.9999 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs`;
        window.proj4.defs(epsgStr, proj4Def);
      }
      return { zone, name, epsgStr };
    },

    /**
     * 平面直交系の 4 角バウンディングボックスを WGS84 緯度経度に変換して LatLngBounds を作成
     */
    _convertPlaneBboxToBounds(minX, minY, maxX, maxY, epsgStr) {
      const corners = [
        [minX, minY],
        [minX, maxY],
        [maxX, minY],
        [maxX, maxY]
      ];

      let minLat = Infinity, maxLat = -Infinity;
      let minLon = Infinity, maxLon = -Infinity;

      for (const [x, y] of corners) {
        const [lon, lat] = window.proj4(epsgStr, 'EPSG:4326', [x, y]);
        if (isFinite(lat) && isFinite(lon)) {
          if (lat < minLat) minLat = lat;
          if (lat > maxLat) maxLat = lat;
          if (lon < minLon) minLon = lon;
          if (lon > maxLon) maxLon = lon;
        }
      }

      return L.latLngBounds([minLat, minLon], [maxLat, maxLon]);
    },

    /**
     * 座標値 (X, Y) から最も適した日本の平面直交系 (1〜19) を自動推定する
     */
    _estimateJgdZone(minX, minY, maxX, maxY) {
      const midX = (minX + maxX) / 2;
      const midY = (minY + maxY) / 2;

      // 距離が極端に大きい場合は対象外
      if (Math.abs(midX) > 600000 || Math.abs(midY) > 600000) return null;

      let bestZone = null;
      let minDistance = Infinity;

      for (let zone = 1; zone <= 19; zone++) {
        // 各系の原点からの平面座標上の距離の近似（原点[0,0]からの距離）
        const dist = Math.sqrt(midX * midX + midY * midY);
        if (dist < minDistance) {
          minDistance = dist;
          bestZone = zone;
        }
      }

      return bestZone;
    },

    /**
     * Web Mercator (EPSG:3857) → WGS84 (EPSG:4326) 変換
     */
    _merc2latlon(x, y) {
      const lon = (x * 180) / 20037508.342789244;
      const lat = (Math.atan(Math.exp((y * Math.PI) / 20037508.342789244)) * 360) / Math.PI - 90;
      return [lat, lon];
    },

    // ------------------------------------------------------------------
    // ラスタ → Canvas 変換
    // ------------------------------------------------------------------

    /**
     * GeoTIFFラスタをCanvasに描画してDataURLを返す
     *
     * readRasters({ width: outW, height: outH }) で geotiff.js に内部リサンプルを任せる。
     * これにより元解像度の巨大 ImageData を作成するステップが不要になる。
     *
     * @param {GeoTIFF.GeoTIFFImage} image
     * @param {number} outW   - 出力幅（ピクセル）
     * @param {number} outH   - 出力高（ピクセル）
     * @param {Function} onProgress - (percent: number, message: string) => void
     * @returns {Promise<string>} DataURL (PNG)
     */
    async _rasterToCanvas(image, outW, outH, onProgress = () => {}) {
      const samplesPerPixel = image.getSamplesPerPixel();

      // 出力解像度で直接読み込む（ここがメモリ節約の核心）
      onProgress(50, `ラスタをデコード中 (${outW}×${outH}px)...`);
      await this._yield();

      const data = await image.readRasters({
        interleave: true,
        width:  outW,
        height: outH
      });

      // Canvas 初期化（出力サイズのみ確保）
      const canvas  = document.createElement('canvas');
      canvas.width  = outW;
      canvas.height = outH;
      const ctx     = canvas.getContext('2d');
      const imgData = ctx.createImageData(outW, outH);
      const buf     = imgData.data;
      const noData  = image.noDataValue;

      // チャンク単位で処理する行数
      const ROWS_PER_CHUNK = Math.max(1, Math.ceil(50000 / outW));

      // グレースケール用: 正規化パラメータを事前計算
      let grayMin = Infinity, grayMax = -Infinity;
      if (samplesPerPixel < 3) {
        onProgress(55, '色尺度範囲を分析中...');
        await this._yield();
        const step = Math.max(1, Math.floor(data.length / 20000));
        for (let i = 0; i < data.length; i += step) {
          const v = data[i];
          if (isFinite(v)) {
            if (v < grayMin) grayMin = v;
            if (v > grayMax) grayMax = v;
          }
        }
      }

      // チャンク分割でピクセルデータを書き込む
      for (let row = 0; row < outH; row += ROWS_PER_CHUNK) {
        const rowEnd = Math.min(row + ROWS_PER_CHUNK, outH);

        if (samplesPerPixel >= 3) {
          // RGB / RGBA
          for (let r = row; r < rowEnd; r++) {
            for (let c = 0; c < outW; c++) {
              const i = r * outW + c;
              buf[i * 4]     = data[i * samplesPerPixel];
              buf[i * 4 + 1] = data[i * samplesPerPixel + 1];
              buf[i * 4 + 2] = data[i * samplesPerPixel + 2];
              buf[i * 4 + 3] = samplesPerPixel >= 4 ? data[i * samplesPerPixel + 3] : 255;
            }
          }
        } else {
          // グレースケール（1バンド）
          for (let r = row; r < rowEnd; r++) {
            for (let c = 0; c < outW; c++) {
              const i = r * outW + c;
              const v = data[i];
              const isNoData = noData !== undefined && v === noData;
              let gray = 128;
              if (!isNoData) {
                if (grayMax === grayMin) {
                  gray = 128;
                } else if (data instanceof Uint8Array) {
                  gray = v & 0xFF;
                } else if (data instanceof Uint16Array) {
                  gray = Math.round((v / 65535) * 255);
                } else {
                  gray = Math.round(((v - grayMin) / (grayMax - grayMin)) * 255);
                }
              }
              buf[i * 4]     = gray;
              buf[i * 4 + 1] = gray;
              buf[i * 4 + 2] = gray;
              buf[i * 4 + 3] = isNoData ? 0 : 200;
            }
          }
        }

        // 進捗報告 + UIスレッドへの制御返却
        const pct = 58 + Math.round((rowEnd / outH) * 35); // 58〜93%
        onProgress(pct,
          `描画中... ${Math.round((rowEnd / outH) * 100)}%` +
          ` (${rowEnd.toLocaleString()} / ${outH.toLocaleString()} 行)`
        );
        await this._yield();
      }

      ctx.putImageData(imgData, 0, 0);
      onProgress(95, '画像をエンコード中...');
      await this._yield();

      const dataUrl = canvas.toDataURL('image/png');
      return {
        dataUrl,
        rasterData: data,
        minVal: grayMin,
        maxVal: grayMax,
        noData: noData,
        outW: outW,
        outH: outH,
        samplesPerPixel: samplesPerPixel
      };
    },

    // ------------------------------------------------------------------
    // ユーティリティ
    // ------------------------------------------------------------------

    /**
     * UIスレッドをブロックしないように制御を返す
     * @returns {Promise<void>}
     */
    _yield() {
      return new Promise(resolve => setTimeout(resolve, 0));
    },

    /**
     * geotiff.js ライブラリを動的に読み込む
     * @returns {Promise<void>}
     */
    _ensureGeotiff() {
      if (geotiffReady) return Promise.resolve();
      if (geotiffLoading) {
        return new Promise((resolve, reject) => geotiffCallbacks.push({ resolve, reject }));
      }

      geotiffLoading = true;
      return new Promise((resolve, reject) => {
        geotiffCallbacks.push({ resolve, reject });
        const script = document.createElement('script');
        script.src = GEOTIFF_CDN;
        script.onload = () => {
          geotiffReady    = true;
          geotiffLoading  = false;
          geotiffCallbacks.forEach(cb => cb.resolve());
          geotiffCallbacks = [];
        };
        script.onerror = () => {
          geotiffLoading = false;
          const err = new Error('GeoTIFFライブラリの読み込みに失敗しました。');
          geotiffCallbacks.forEach(cb => cb.reject(err));
          geotiffCallbacks = [];
          reject(err);
        };
        document.head.appendChild(script);
      });
    },

    /**
     * proj4.js ライブラリを動的に読み込む
     * @returns {Promise<void>}
     */
    _ensureProj4() {
      if (proj4Ready) return Promise.resolve();
      if (proj4Loading) {
        return new Promise((resolve, reject) => proj4Callbacks.push({ resolve, reject }));
      }

      proj4Loading = true;
      return new Promise((resolve, reject) => {
        proj4Callbacks.push({ resolve, reject });
        const script = document.createElement('script');
        script.src = PROJ4_CDN;
        script.onload = () => {
          proj4Ready    = true;
          proj4Loading  = false;
          proj4Callbacks.forEach(cb => cb.resolve());
          proj4Callbacks = [];
        };
        script.onerror = () => {
          proj4Loading = false;
          const err = new Error('Proj4ライブラリの読み込みに失敗しました。');
          proj4Callbacks.forEach(cb => cb.reject(err));
          proj4Callbacks = [];
          reject(err);
        };
        document.head.appendChild(script);
      });
    }
  };

})(window.GIS = window.GIS || {});
