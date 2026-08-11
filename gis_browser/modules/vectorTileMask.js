/**
 * vectorTileMask.js - 森林計画対象森林 ベクトルタイルレイヤー＆GeoTIFFマスク処理
 *
 * ベクトルタイル URL: https://rinya-tiles.geospatial.jp/fr_layer_pbf_2025/{z}/{x}/{y}.pbf
 *
 * 1. Leaflet マップ上での VectorGrid レイヤー表示・非表示切り替え
 * 2. GeoTIFF レンダリング時の Offscreen Canvas マスク処理 (destination-in clipping)
 *    -> ベクトルタイルの範囲外のピクセルは透明化
 */
(function (GIS) {
  'use strict';

  const VT_URL = 'https://rinya-tiles.geospatial.jp/fr_layer_pbf_2025/{z}/{x}/{y}.pbf';
  const tileCache = new Map();

  GIS.VectorTileMask = {
    vtLayer: null,
    vtVisible: false,
    labelGroup: null,

    /**
     * Leaflet マップ上に 森林計画対象森林 ベクトルタイルレイヤーを初期化する
     * （薄いグレーのラインスタイル、zIndex:550最前面、林班番号ラベル表示）
     * @param {L.Map} map 
     */
    initLeafletLayer(map) {
      if (!window.L || !window.L.vectorGrid) {
        console.warn('[VectorTileMask] Leaflet.VectorGrid library not available.');
        return;
      }

      // GeoTIFF より常に手前に表示される専用ペイン (zIndex 550)
      if (!map.getPane('vectorTilePane')) {
        const pane = map.createPane('vectorTilePane');
        pane.style.zIndex = '550';
        pane.style.pointerEvents = 'none';
      }

      // 林班番号ラベル専用ペイン (zIndex 560)
      if (!map.getPane('vectorTileLabelPane')) {
        const labelPane = map.createPane('vectorTileLabelPane');
        labelPane.style.zIndex = '560';
        labelPane.style.pointerEvents = 'none';
      }

      if (!this.labelGroup) {
        this.labelGroup = L.layerGroup([], { pane: 'vectorTileLabelPane' }).addTo(map);
      }

      // 薄いグレーラインのスタイル設定 (#cbd5e1)
      const grayLineStyle = {
        fill: true,
        fillColor: 'rgba(255, 255, 255, 0.04)',
        fillOpacity: 0.04,
        stroke: true,
        color: 'rgba(203, 213, 225, 0.75)', // 薄いグレー
        weight: 1.2
      };

      this.vtLayer = L.vectorGrid.protobuf(VT_URL, {
        pane: 'vectorTilePane',
        vectorTileLayerStyles: {
          fr_layer_pbf_2025: grayLineStyle,
          default: grayLineStyle
        },
        maxNativeZoom: 15,
        minZoom: 6,
        interactive: false
      });

      this.vtLayer.addTo(map);
      this.vtVisible = true;

      // 地図移動・ズーム時に林班番号ラベルを更新
      const onMapMove = () => this.updateRinbanLabels(map);
      map.on('moveend zoomend', onMapMove);
      onMapMove();
    },

    /**
     * 現在の地図範囲に対応する林班番号ラベル (例: "101林班") を抽出して表示する
     * @param {L.Map} map 
     */
    async updateRinbanLabels(map) {
      if (!this.labelGroup || !this.vtVisible || !map) return;

      const zoom = Math.floor(map.getZoom());
      if (zoom < 13) {
        // ズームアウト時はラベルをクリア
        this.labelGroup.clearLayers();
        return;
      }

      const VectorTileClass = window.VectorTile || window.vectorTile?.VectorTile;
      if (!window.Pbf || !VectorTileClass) return;

      const bounds = map.getBounds();
      const tileZoom = Math.min(14, zoom);
      const { minX, maxX, minY, maxY } = this.getTileBounds(bounds, tileZoom);

      const addedKeys = new Set();
      const newMarkers = [];

      for (let tx = minX; tx <= maxX; tx++) {
        for (let ty = minY; ty <= maxY; ty++) {
          const key = `${tileZoom}_${tx}_${ty}`;
          let buffer = tileCache.get(key);

          if (!buffer) {
            const url = VT_URL.replace('{z}', tileZoom).replace('{x}', tx).replace('{y}', ty);
            try {
              const res = await fetch(url);
              if (res.ok) {
                buffer = await res.arrayBuffer();
                tileCache.set(key, buffer);
              }
            } catch (_) {}
          }

          if (buffer) {
            try {
              const pbf = new window.Pbf(new Uint8Array(buffer));
              const vt = new VectorTileClass(pbf);
              const layerName = vt.layers['fr_layer_pbf_2025'] ? 'fr_layer_pbf_2025' : Object.keys(vt.layers)[0];
              const vtLayer = vt.layers[layerName];

              if (vtLayer) {
                const extent = vtLayer.extent || 4096;
                for (let f = 0; f < vtLayer.length; f++) {
                  const feat = vtLayer.feature(f);
                  const props = feat.properties || {};

                  // 林班番号のプロパティ値を取得
                  const rinbanRaw = this._extractRinbanValue(props);
                  if (!rinbanRaw) continue;

                  const rinbanStr = String(rinbanRaw).trim();
                  const labelText = rinbanStr.endsWith('林班') ? rinbanStr : `${rinbanStr}林班`;

                  const rings = feat.loadGeometry();
                  if (!rings || !rings.length) continue;

                  // 重心（センタ）座標の計算
                  let sumLat = 0, sumLng = 0, count = 0;
                  for (const ring of rings) {
                    for (const pt of ring) {
                      const ll = this._tilePointToLatLng(pt.x, pt.y, tx, ty, tileZoom, extent);
                      sumLat += ll.lat;
                      sumLng += ll.lng;
                      count++;
                    }
                  }

                  if (count > 0) {
                    const cLat = sumLat / count;
                    const cLng = sumLng / count;

                    // 重複表示防止用キー
                    const dedupKey = `${labelText}_${cLat.toFixed(3)}_${cLng.toFixed(3)}`;
                    if (addedKeys.has(dedupKey)) continue;
                    addedKeys.add(dedupKey);

                    const icon = L.divIcon({
                      className: 'rinban-label-container',
                      html: `<div class="rinban-label">${labelText}</div>`,
                      iconSize: null
                    });

                    const marker = L.marker([cLat, cLng], {
                      icon,
                      interactive: false,
                      pane: 'vectorTileLabelPane'
                    });
                    newMarkers.push(marker);
                  }
                }
              }
            } catch (_) {}
          }
        }
      }

      this.labelGroup.clearLayers();
      newMarkers.forEach(m => this.labelGroup.addLayer(m));
    },

    /**
     * フィーチャのプロパティから林班番号を検索抽出する
     */
    _extractRinbanValue(props) {
      if (!props) return null;
      const targetKeys = [
        'rinban', 'RINBAN', 'Rinban', 'r_no', 'R_NO',
        'rimban', 'RIMBAN', 'rin_num', 'R_NUM', '林班', '林班番号'
      ];
      for (const k of targetKeys) {
        if (props[k] !== undefined && props[k] !== null && props[k] !== '') {
          return props[k];
        }
      }
      for (const k of Object.keys(props)) {
        if (/rin|rim|林/i.test(k) && props[k]) {
          return props[k];
        }
      }
      return null;
    },

    /**
     * ベクトルタイルを最前面に移動する
     */
    bringToFront() {
      if (this.vtLayer && this.vtLayer.bringToFront) {
        try { this.vtLayer.bringToFront(); } catch (_) {}
      }
    },

    /**
     * 地図上のベクトルタイルレイヤーの表示/非表示をトグルする
     * @param {L.Map} map 
     * @returns {boolean} 現在の表示状態
     */
    toggleLayer(map) {
      if (!this.vtLayer && map) {
        this.initLeafletLayer(map);
        return true;
      }
      if (!this.vtLayer) return false;

      if (this.vtVisible) {
        map.removeLayer(this.vtLayer);
        this.vtVisible = false;
      } else {
        this.vtLayer.addTo(map);
        this.vtVisible = true;
      }
      return this.vtVisible;
    },

    /**
     * LatLngBounds と ズームレベルから タイル座標 (x, y) の範囲を取得する
     * @param {L.LatLngBounds} bounds 
     * @param {number} zoom 
     * @returns {{minX: number, maxX: number, minY: number, maxY: number, zoom: number}}
     */
    getTileBounds(bounds, zoom) {
      const n = Math.pow(2, zoom);
      const nw = bounds.getNorthWest();
      const se = bounds.getSouthEast();

      const minX = Math.floor(((nw.lng + 180) / 360) * n);
      const maxX = Math.floor(((se.lng + 180) / 360) * n);

      const minLatRad = (nw.lat * Math.PI) / 180;
      const minY = Math.floor(((1 - Math.log(Math.tan(minLatRad) + 1 / Math.cos(minLatRad)) / Math.PI) / 2) * n);

      const maxLatRad = (se.lat * Math.PI) / 180;
      const maxY = Math.floor(((1 - Math.log(Math.tan(maxLatRad) + 1 / Math.cos(maxLatRad)) / Math.PI) / 2) * n);

      return {
        minX: Math.min(minX, maxX),
        maxX: Math.max(minX, maxX),
        minY: Math.min(minY, maxY),
        maxY: Math.max(minY, maxY),
        zoom
      };
    },

    /**
     * GeoTIFFの Canvas に対して 森林計画対象ベクトルタイルによるマスク (destination-in) を適用する
     * ベクトルタイルの範囲外のピクセルは透明化される
     *
     * @param {HTMLCanvasElement} geoCanvas GeoTIFFが描画されたCanvas
     * @param {L.LatLngBounds} bounds 
     * @returns {Promise<HTMLCanvasElement>} マスク適用後のCanvas
     */
    async applyMaskToCanvas(geoCanvas, bounds) {
      const VectorTileClass = window.VectorTile || window.vectorTile?.VectorTile;
      if (!window.Pbf || !VectorTileClass || !bounds) {
        return geoCanvas;
      }

      const zoom = 14;
      const { minX, maxX, minY, maxY } = this.getTileBounds(bounds, zoom);

      const outW = geoCanvas.width;
      const outH = geoCanvas.height;

      // オフスクリーンマスクCanvasを生成
      const maskCanvas = document.createElement('canvas');
      maskCanvas.width = outW;
      maskCanvas.height = outH;
      const maskCtx = maskCanvas.getContext('2d');

      maskCtx.fillStyle = '#ffffff';

      const tilesToFetch = [];
      for (let tx = minX; tx <= maxX; tx++) {
        for (let ty = minY; ty <= maxY; ty++) {
          tilesToFetch.push({ tx, ty, zoom });
        }
      }

      let hasPolygons = false;

      for (const { tx, ty, zoom } of tilesToFetch) {
        const key = `${zoom}_${tx}_${ty}`;
        let buffer = tileCache.get(key);

        if (!buffer) {
          const url = VT_URL.replace('{z}', zoom).replace('{x}', tx).replace('{y}', ty);
          try {
            const res = await fetch(url);
            if (res.ok) {
              buffer = await res.arrayBuffer();
              tileCache.set(key, buffer);
            }
          } catch (e) {
            console.warn('[VectorTileMask] Tile fetch error:', url, e);
          }
        }

        if (buffer) {
          try {
            const pbf = new window.Pbf(new Uint8Array(buffer));
            const vt = new VectorTileClass(pbf);

            const layerName = vt.layers['fr_layer_pbf_2025'] ? 'fr_layer_pbf_2025' : Object.keys(vt.layers)[0];
            const vtLayer = vt.layers[layerName];

            if (vtLayer) {
              const extent = vtLayer.extent || 4096;
              const numFeatures = vtLayer.length;

              for (let f = 0; f < numFeatures; f++) {
                const feat = vtLayer.feature(f);
                const rings = feat.loadGeometry();

                maskCtx.beginPath();
                for (const ring of rings) {
                  for (let k = 0; k < ring.length; k++) {
                    const pt = ring[k];
                    const latlng = this._tilePointToLatLng(pt.x, pt.y, tx, ty, zoom, extent);
                    const px = this._latLngToCanvasPx(latlng.lat, latlng.lng, bounds, outW, outH);
                    if (k === 0) maskCtx.moveTo(px.cx, px.cy);
                    else maskCtx.lineTo(px.cx, px.cy);
                  }
                }
                maskCtx.closePath();
                maskCtx.fill('evenodd');
                hasPolygons = true;
              }
            }
          } catch (err) {
            console.warn('[VectorTileMask] Tile parse error:', key, err);
          }
        }
      }

      // ポリゴンが存在する場合、destination-in で範囲外を透明化
      if (hasPolygons) {
        const geoCtx = geoCanvas.getContext('2d');
        geoCtx.globalCompositeOperation = 'destination-in';
        geoCtx.drawImage(maskCanvas, 0, 0);
        geoCtx.globalCompositeOperation = 'source-over';
      }

      return geoCanvas;
    },

    /**
     * ベクトルタイル座標 (x, y) を LatLng に変換
     */
    _tilePointToLatLng(x, y, tileX, tileY, zoom, extent) {
      const n = Math.pow(2, zoom);
      const gx = tileX + x / extent;
      const gy = tileY + y / extent;
      const lng = (gx / n) * 360 - 180;
      const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * gy) / n)));
      const lat = (latRad * 180) / Math.PI;
      return { lat, lng };
    },

    /**
     * LatLng を GeoTIFF Canvas ピクセル座標に変換
     */
    _latLngToCanvasPx(lat, lng, bounds, outW, outH) {
      const minLat = bounds.getSouth();
      const maxLat = bounds.getNorth();
      const minLng = bounds.getWest();
      const maxLng = bounds.getEast();

      const cx = ((lng - minLng) / (maxLng - minLng)) * outW;
      const cy = ((maxLat - lat) / (maxLat - minLat)) * outH;
      return { cx, cy };
    }

  };

})(window.GIS = window.GIS || {});
