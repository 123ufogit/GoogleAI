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

    /**
     * Leaflet マップ上に 森林計画対象森林 ベクトルタイルレイヤーを初期化する
     * @param {L.Map} map 
     */
    initLeafletLayer(map) {
      if (!window.L || !window.L.vectorGrid) {
        console.warn('[VectorTileMask] Leaflet.VectorGrid library not available.');
        return;
      }

      this.vtLayer = L.vectorGrid.protobuf(VT_URL, {
        vectorTileLayerStyles: {
          fr_layer_pbf_2025: {
            fill: true,
            fillColor: '#10b981',
            fillOpacity: 0.2,
            stroke: true,
            color: '#34d399',
            weight: 1.2
          },
          default: {
            fill: true,
            fillColor: '#10b981',
            fillOpacity: 0.2,
            stroke: true,
            color: '#34d399',
            weight: 1.2
          }
        },
        maxNativeZoom: 15,
        minZoom: 6,
        interactive: false
      });

      this.vtLayer.addTo(map);
      this.vtVisible = true;
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
