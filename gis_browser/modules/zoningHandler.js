/**
 * zoningHandler.js - 森林ゾーニングツール GeoTIFFシンボロジ・スタイル管理
 *
 * GeoTIFFラスタピクセルデータの解析、10分割閾値スライダによる2色色分け
 * （デフォルト #00d7ff, #ffff00）および 5段階透過度（0%, 25%, 50%, 75%, 100%）をリアルタイム適用。
 */
(function (GIS) {
  'use strict';

  GIS.ZoningHandler = {

    /**
     * Hexカラーコードを {r, g, b} オブジェクトに変換
     * @param {string} hex 
     * @returns {{r: number, g: number, b: number}}
     */
    hexToRgb(hex) {
      let c = hex.replace('#', '');
      if (c.length === 3) c = c.split('').map(x => x + x).join('');
      const num = parseInt(c, 16);
      return {
        r: (num >> 16) & 255,
        g: (num >> 8) & 255,
        b: num & 255
      };
    },

    /**
     * GeoTIFFレイヤーのシンボロジ設定を更新し、マップ表示を再描画する（非同期対応）
     * @param {string} layerId 
     * @param {object} updates - { threshold, colorLow, colorHigh, opacity, mode, useForestMask }
     */
    async updateSymbology(layerId, updates = {}) {
      const entry = GIS.AppState.layers.get(layerId);
      if (!entry || entry.type !== 'geotiff' || !entry.geotiffInfo) return;

      const info = entry.geotiffInfo;
      Object.assign(info, updates);

      // 透過度の適用 (Leaflet opacity: 0% 透過 = 1.0 opacity, 100% 透過 = 0.0 opacity)
      if (updates.opacity !== undefined) {
        entry.layer.setOpacity(info.opacity);
      }

      // 閾値2色色分け Canvas を作成
      const geoCanvas = this.createThresholdCanvas(info);
      if (!geoCanvas) return;

      // ベクトルポリゴンによるマスク (destination-in clipping)
      // ベクトルデータの範囲外のピクセルは透明化される。指定なしまたは該当なし時は全表示
      if (GIS.VectorTileMask && info.bounds) {
        await GIS.VectorTileMask.applyMaskToCanvas(geoCanvas, info.bounds, info.maskLayerId);
      }

      const dataUrl = geoCanvas.toDataURL('image/png');
      entry.layer.setUrl(dataUrl);
    },

    /**
     * 閾値に基づきラスタピクセルを2色に高速色分け描画した HTMLCanvasElement を生成する
     * 
     * 【ピクセル可視性条件】
     *  - ピクセル値 0 <= val <= 9 のみを表示対象とし、それ以外 (val < 0 または val > 9, noData, NaN) は【完全透明】とする。
     *  - 表示対象 (0〜9) 内のピクセルを 閾値 t で 2 色に分け（val <= t は colorLow, val > t は colorHigh）に描画。
     * 
     * @param {object} info - entry.geotiffInfo
     * @returns {HTMLCanvasElement} Canvas
     */
    createThresholdCanvas(info) {
      const { rasterData, outW, outH, samplesPerPixel, noData, threshold, colorLow, colorHigh } = info;
      if (!rasterData) return null;

      const canvas = document.createElement('canvas');
      canvas.width = outW;
      canvas.height = outH;
      const ctx = canvas.getContext('2d');
      const imgData = ctx.createImageData(outW, outH);
      const buf = imgData.data;

      const rgbLow = this.hexToRgb(colorLow || '#00d7ff');
      const rgbHigh = this.hexToRgb(colorHigh || '#ffff00');

      const totalPixels = outW * outH;
      const t = parseFloat(threshold !== undefined ? threshold : 4.0);

      for (let i = 0; i < totalPixels; i++) {
        let val;
        if (samplesPerPixel >= 3) {
          val = (rasterData[i * samplesPerPixel] + rasterData[i * samplesPerPixel + 1] + rasterData[i * samplesPerPixel + 2]) / 3;
        } else {
          val = rasterData[i];
        }

        const isNoData = (noData !== undefined && val === noData) || !isFinite(val);
        const bufIdx = i * 4;

        // ピクセル値 0 <= val <= 9 以外（< 0, > 9, noData）は【透明】
        if (isNoData || val < 0 || val > 9) {
          buf[bufIdx]     = 0;
          buf[bufIdx + 1] = 0;
          buf[bufIdx + 2] = 0;
          buf[bufIdx + 3] = 0; // 完全透明
        } else {
          // 0 <= val <= 9 のピクセルを 閾値 t で 2 色に分岐
          if (val <= t) {
            buf[bufIdx]     = rgbLow.r;
            buf[bufIdx + 1] = rgbLow.g;
            buf[bufIdx + 2] = rgbLow.b;
          } else {
            buf[bufIdx]     = rgbHigh.r;
            buf[bufIdx + 1] = rgbHigh.g;
            buf[bufIdx + 2] = rgbHigh.b;
          }
          buf[bufIdx + 3] = 220; // 描画
        }
      }

      ctx.putImageData(imgData, 0, 0);
      return canvas;
    },

    /**
     * スライダのステップ位置 (0〜9) から閾値の数値へ変換
     * @param {number} step 0〜9
     * @returns {number}
     */
    stepToThreshold(step) {
      return Math.max(0, Math.min(9, parseFloat(step)));
    },

    /**
     * 閾値の数値からスライダのステップ位置 (0〜9) へ変換
     * @param {number} threshold 
     * @returns {number}
     */
    thresholdToStep(threshold) {
      if (threshold === undefined || isNaN(threshold)) return 4.0;
      return Math.max(0, Math.min(9, parseFloat(threshold)));
    },

    /**
     * レイヤー一覧アイテム内に組込む GeoTIFF シンボロジ UI ドロワーの HTML を生成
     * @param {object} entry 
     * @returns {string} HTML string
     */
    createDrawerHtml(entry) {
      const info = entry.geotiffInfo;
      if (!info) return '';

      const currentThresh = info.threshold !== undefined ? info.threshold : 4.0;
      const currentStep = this.thresholdToStep(currentThresh);
      const currentMode = info.mode || 'profitability';

      // 0〜9 目盛り表示
      let ticksHtml = '<div class="zoning-ticks">';
      for (let i = 0; i <= 9; i++) {
        ticksHtml += `<span>${i}</span>`;
      }
      ticksHtml += '</div>';

      return `
        <div class="zoning-drawer hidden" id="zoning-drawer-${entry.id}">
          <div class="zoning-drawer-inner">
            
            <!-- レンダリングモード切替 （収益性 vs 災害リスク） -->
            <div class="zoning-section-title">🎨 スタイルモード</div>
            <div class="zoning-mode-pills">
              <button class="zoning-mode-pill ${currentMode === 'profitability' || currentMode === 'threshold' ? 'active' : ''}" 
                      data-id="${entry.id}" data-mode="profitability"
                      title="収益性評価 (≤ t: #00d7ff, > t: #ffff00)">
                🌲 2色ゾーニング／収益性
              </button>
              <button class="zoning-mode-pill ${currentMode === 'disaster_risk' ? 'active' : ''}" 
                      data-id="${entry.id}" data-mode="disaster_risk"
                      title="災害リスク評価 (≤ t: #00d7ff, > t: #ff55ff)">
                ⚠️ 2色ゾーニング／災害リスク
              </button>
            </div>

            <!-- 0〜9 ピクセル値 閾値スライダコントロール (表示範囲: 0〜9固定, それ以外透明) -->
            <div class="zoning-controls-group">
              <div class="zoning-label-row">
                <span class="zoning-label">📊 閾値 (表示ピクセル: 0〜9):</span>
                <span class="zoning-value-badge" id="zoning-val-${entry.id}">
                  閾値: ${currentStep.toFixed(1)}
                </span>
              </div>
              
              <div class="zoning-slider-container">
                <input type="range" class="zoning-slider" id="zoning-slider-${entry.id}"
                       min="0" max="9" step="0.5" value="${currentStep.toFixed(1)}"
                       data-id="${entry.id}">
                ${ticksHtml}
              </div>

              <!-- 2色カラーピッカー -->
              <div class="zoning-color-row">
                <div class="zoning-color-picker-item">
                  <label for="color-low-${entry.id}">閾値以下 (≤ t):</label>
                  <input type="color" id="color-low-${entry.id}" class="zoning-color-input" 
                         value="${info.colorLow || '#00d7ff'}" data-id="${entry.id}" data-type="colorLow">
                  <span class="color-preview-code">${info.colorLow || '#00d7ff'}</span>
                </div>
                <div class="zoning-color-picker-item">
                  <label for="color-high-${entry.id}">閾値超過 (> t):</label>
                  <input type="color" id="color-high-${entry.id}" class="zoning-color-input" 
                         value="${info.colorHigh || '#ffff00'}" data-id="${entry.id}" data-type="colorHigh">
                  <span class="color-preview-code">${info.colorHigh || '#ffff00'}</span>
                </div>
              </div>
            </div>

            <!-- 5段階透過性 (Opacity) 設定 -->
            <div class="zoning-section-title" style="margin-top:12px;">👻 透過性 (オパシティ)</div>
            <div class="zoning-opacity-pills">
              ${[
                { label: '0% (不透明)', opacity: 1.0 },
                { label: '25%',        opacity: 0.75 },
                { label: '50%',        opacity: 0.50 },
                { label: '75%',        opacity: 0.25 },
                { label: '100% (透明)', opacity: 0.0 }
              ].map(item => {
                const isActive = Math.abs((info.opacity ?? 0.5) - item.opacity) < 0.12;
                return `<button class="zoning-opacity-pill ${isActive ? 'active' : ''}" 
                                data-id="${entry.id}" data-opacity="${item.opacity}">
                  ${item.label}
                </button>`;
              }).join('')}
            </div>

            <!-- マスク範囲ポリゴン選択 -->
            <div class="zoning-section-title" style="margin-top:12px;">✂️ マスク範囲 (くり抜きポリゴン)</div>
            <select class="zoning-mask-select" id="zoning-mask-${entry.id}" data-id="${entry.id}">
              <option value="all" ${(!info.maskLayerId || info.maskLayerId === 'all') ? 'selected' : ''}>すべてのポリゴンレイヤー</option>
              <option value="none" ${info.maskLayerId === 'none' ? 'selected' : ''}>なし (全体表示)</option>
              ${this._getVectorLayerOptions(info.maskLayerId)}
            </select>

          </div>
        </div>
      `;
    },

    /**
     * AppState 内のベクトルレイヤーをドロップダウン <option> 要素群として取得
     */
    _getVectorLayerOptions(currentMaskLayerId) {
      if (!GIS.AppState || !GIS.AppState.layers) return '';
      const options = [];
      GIS.AppState.layers.forEach((entry, id) => {
        if (entry.type !== 'geotiff' && entry.type !== 'pin') {
          const selected = currentMaskLayerId === id ? 'selected' : '';
          const name = GIS.UI.escHtml(entry.name || '名称未設定ポリゴン');
          options.push(`<option value="${id}" ${selected}>レイヤー: ${name}</option>`);
        }
      });
      return options.join('');
    },

    /**
     * ドロワー内のUIイベント（スライダ、カラーピッカー、透過度ボタン）のバインド
     * @param {string} layerId 
     * @param {HTMLElement} liElement 
     */
    bindDrawerEvents(layerId, liElement) {
      const entry = GIS.AppState.layers.get(layerId);
      if (!entry || !entry.geotiffInfo) return;

      const info = entry.geotiffInfo;

      // ドロワー開閉トグルボタン
      const drawerBtn = liElement.querySelector('.layer-zoning-toggle-btn');
      const drawer = liElement.querySelector(`#zoning-drawer-${layerId}`);

      if (drawerBtn && drawer) {
        drawerBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const isHidden = drawer.classList.toggle('hidden');
          drawerBtn.classList.toggle('active', !isHidden);
        });
      }

      // モード切り替えボタン (収益性 vs 災害リスク)
      liElement.querySelectorAll(`.zoning-mode-pill[data-id="${layerId}"]`).forEach(btn => {
        btn.addEventListener('click', () => {
          const mode = btn.dataset.mode;
          liElement.querySelectorAll(`.zoning-mode-pill[data-id="${layerId}"]`).forEach(b => b.classList.remove('active'));
          btn.classList.add('active');

          let colorLow = '#00d7ff';
          let colorHigh = '#ffff00';

          if (mode === 'disaster_risk') {
            colorLow = '#00d7ff';
            colorHigh = '#ff55ff';
          } else {
            colorLow = '#00d7ff';
            colorHigh = '#ffff00';
          }

          // カラーピッカー表示の同期更新
          const lowInput = liElement.querySelector(`input[data-type="colorLow"][data-id="${layerId}"]`);
          const highInput = liElement.querySelector(`input[data-type="colorHigh"][data-id="${layerId}"]`);

          if (lowInput) {
            lowInput.value = colorLow;
            if (lowInput.nextElementSibling) lowInput.nextElementSibling.textContent = colorLow;
          }
          if (highInput) {
            highInput.value = colorHigh;
            if (highInput.nextElementSibling) highInput.nextElementSibling.textContent = colorHigh;
          }

          this.updateSymbology(layerId, { mode, colorLow, colorHigh });
        });
      });

      // 0〜9 閾値スライダ
      const slider = liElement.querySelector(`#zoning-slider-${layerId}`);
      const valBadge = liElement.querySelector(`#zoning-val-${layerId}`);
      if (slider) {
        slider.addEventListener('input', (e) => {
          const threshVal = parseFloat(e.target.value);
          if (valBadge) valBadge.textContent = `閾値: ${threshVal.toFixed(1)}`;

          this.updateSymbology(layerId, { threshold: threshVal });
        });
      }

      // カラーピッカー
      ['colorLow', 'colorHigh'].forEach(type => {
        const input = liElement.querySelector(`input[data-type="${type}"][data-id="${layerId}"]`);
        if (input) {
          input.addEventListener('change', (e) => {
            const hex = e.target.value;
            const codeSpan = input.nextElementSibling;
            if (codeSpan) codeSpan.textContent = hex;

            this.updateSymbology(layerId, { [type]: hex, mode: 'threshold' });
          });
        }
      });

      // 透過性ピルボタン
      liElement.querySelectorAll(`.zoning-opacity-pill[data-id="${layerId}"]`).forEach(btn => {
        btn.addEventListener('click', () => {
          const opacity = parseFloat(btn.dataset.opacity);
          liElement.querySelectorAll(`.zoning-opacity-pill[data-id="${layerId}"]`).forEach(b => b.classList.remove('active'));
          btn.classList.add('active');

          this.updateSymbology(layerId, { opacity });
        });
      });

      // マスク範囲ポリゴン選択ドロップダウン
      const maskSelect = liElement.querySelector(`#zoning-mask-${layerId}`);
      if (maskSelect) {
        maskSelect.addEventListener('change', (e) => {
          const maskLayerId = e.target.value;
          this.updateSymbology(layerId, { maskLayerId });
        });
      }
    }

  };

})(window.GIS = window.GIS || {});
