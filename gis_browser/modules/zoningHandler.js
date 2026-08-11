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
     * GeoTIFFレイヤーのシンボロジ設定を更新し、マップ表示を再描画する
     * @param {string} layerId 
     * @param {object} updates - { threshold, colorLow, colorHigh, opacity, mode }
     */
    updateSymbology(layerId, updates = {}) {
      const entry = GIS.AppState.layers.get(layerId);
      if (!entry || entry.type !== 'geotiff' || !entry.geotiffInfo) return;

      const info = entry.geotiffInfo;
      Object.assign(info, updates);

      // 透過度の適用 (Leaflet opacity: 0% 透過 = 1.0 opacity, 100% 透過 = 0.0 opacity)
      if (updates.opacity !== undefined) {
        entry.layer.setOpacity(info.opacity);
      }

      // レンダリングモードの切り替え
      if (info.mode === 'grayscale') {
        if (info.initialDataUrl) {
          entry.layer.setUrl(info.initialDataUrl);
        }
        return;
      }

      // 閾値2色色分け描画 (Threshold Zoning)
      const dataUrl = this.renderThresholdCanvas(info);
      if (dataUrl) {
        entry.layer.setUrl(dataUrl);
      }
    },

    /**
     * 閾値に基づきラスタピクセルを2色に高速色分け描画した Canvas DataURL を生成する
     * @param {object} info - entry.geotiffInfo
     * @returns {string} DataURL (PNG)
     */
    renderThresholdCanvas(info) {
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

      for (let i = 0; i < totalPixels; i++) {
        let val;
        if (samplesPerPixel >= 3) {
          val = (rasterData[i * samplesPerPixel] + rasterData[i * samplesPerPixel + 1] + rasterData[i * samplesPerPixel + 2]) / 3;
        } else {
          val = rasterData[i];
        }

        const isNoData = (noData !== undefined && val === noData) || !isFinite(val);
        const bufIdx = i * 4;

        if (isNoData) {
          buf[bufIdx]     = 0;
          buf[bufIdx + 1] = 0;
          buf[bufIdx + 2] = 0;
          buf[bufIdx + 3] = 0;
        } else {
          if (val <= threshold) {
            buf[bufIdx]     = rgbLow.r;
            buf[bufIdx + 1] = rgbLow.g;
            buf[bufIdx + 2] = rgbLow.b;
          } else {
            buf[bufIdx]     = rgbHigh.r;
            buf[bufIdx + 1] = rgbHigh.g;
            buf[bufIdx + 2] = rgbHigh.b;
          }
          buf[bufIdx + 3] = 220; // ベースアルファ値
        }
      }

      ctx.putImageData(imgData, 0, 0);
      return canvas.toDataURL('image/png');
    },

    /**
     * スライダのステップ位置 (0〜9) から実際の閾値の数値へ変換
     * @param {number} step 0〜9
     * @param {number} minV 
     * @param {number} maxV 
     * @returns {number}
     */
    stepToThreshold(step, minV, maxV) {
      if (maxV === minV) return minV;
      const s = Math.max(0, Math.min(9, step));
      return minV + (maxV - minV) * (s / 9.0);
    },

    /**
     * 実際の閾値の数値からスライダのステップ位置 (0〜9) へ変換
     * @param {number} threshold 
     * @param {number} minV 
     * @param {number} maxV 
     * @returns {number}
     */
    thresholdToStep(threshold, minV, maxV) {
      if (maxV <= minV) return 0;
      const step = ((threshold - minV) / (maxV - minV)) * 9.0;
      return Math.max(0, Math.min(9, step));
    },

    /**
     * レイヤー一覧アイテム内に組込む GeoTIFF シンボロジ UI ドロワーの HTML を生成
     * @param {object} entry 
     * @returns {string} HTML string
     */
    createDrawerHtml(entry) {
      const info = entry.geotiffInfo;
      if (!info) return '';

      const minV = info.minVal;
      const maxV = info.maxVal;
      const currentThresh = info.threshold !== undefined ? info.threshold : (minV + (maxV - minV) * 0.5);
      const currentStep = this.thresholdToStep(currentThresh, minV, maxV);

      // 0〜9 目盛り表示
      let ticksHtml = '<div class="zoning-ticks">';
      for (let i = 0; i <= 9; i++) {
        ticksHtml += `<span>${i}</span>`;
      }
      ticksHtml += '</div>';

      return `
        <div class="zoning-drawer hidden" id="zoning-drawer-${entry.id}">
          <div class="zoning-drawer-inner">
            
            <!-- レンダリングモード切替 -->
            <div class="zoning-section-title">🎨 スタイルモード</div>
            <div class="zoning-mode-pills">
              <button class="zoning-mode-pill ${info.mode === 'threshold' ? 'active' : ''}" 
                      data-id="${entry.id}" data-mode="threshold">
                ⚡ 2色ゾーニング
              </button>
              <button class="zoning-mode-pill ${info.mode === 'grayscale' ? 'active' : ''}" 
                      data-id="${entry.id}" data-mode="grayscale">
                📷 原画像 / グレースケール
              </button>
            </div>

            <!-- 10分割・閾値スライダコントロール (最小値0〜最大値9) -->
            <div class="zoning-controls-group ${info.mode === 'grayscale' ? 'disabled-group' : ''}">
              <div class="zoning-label-row">
                <span class="zoning-label">📊 閾値 (ステップ 0〜9):</span>
                <span class="zoning-value-badge" id="zoning-val-${entry.id}">
                  S:${currentStep.toFixed(1)} (${currentThresh.toFixed(2)})
                </span>
              </div>
              
              <div class="zoning-slider-container">
                <input type="range" class="zoning-slider" id="zoning-slider-${entry.id}"
                       min="0" max="9" step="0.1" value="${currentStep.toFixed(1)}"
                       data-id="${entry.id}">
                ${ticksHtml}
              </div>

              <!-- 0〜9 クイックステップボタン -->
              <div class="zoning-quick-steps" title="クリックしてステップ0〜9に一発セット">
                ${Array.from({ length: 10 }, (_, i) => {
                  return `<button class="zoning-step-btn" data-id="${entry.id}" data-step="${i}">
                    ${i}
                  </button>`;
                }).join('')}
              </div>

              <!-- 2色カラーピッカー -->
              <div class="zoning-color-row">
                <div class="zoning-color-picker-item">
                  <label for="color-low-${entry.id}">閾値以下 (≤):</label>
                  <input type="color" id="color-low-${entry.id}" class="zoning-color-input" 
                         value="${info.colorLow || '#00d7ff'}" data-id="${entry.id}" data-type="colorLow">
                  <span class="color-preview-code">${info.colorLow || '#00d7ff'}</span>
                </div>
                <div class="zoning-color-picker-item">
                  <label for="color-high-${entry.id}">閾値超過 (>):</label>
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
                const isActive = Math.abs((info.opacity ?? 0.85) - item.opacity) < 0.12;
                return `<button class="zoning-opacity-pill ${isActive ? 'active' : ''}" 
                                data-id="${entry.id}" data-opacity="${item.opacity}">
                  ${item.label}
                </button>`;
              }).join('')}
            </div>

          </div>
        </div>
      `;
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

      // モード切り替えボタン
      liElement.querySelectorAll(`.zoning-mode-pill[data-id="${layerId}"]`).forEach(btn => {
        btn.addEventListener('click', () => {
          const mode = btn.dataset.mode;
          liElement.querySelectorAll(`.zoning-mode-pill[data-id="${layerId}"]`).forEach(b => b.classList.remove('active'));
          btn.classList.add('active');

          const controlsGroup = liElement.querySelector('.zoning-controls-group');
          if (controlsGroup) {
            controlsGroup.classList.toggle('disabled-group', mode === 'grayscale');
          }

          this.updateSymbology(layerId, { mode });
        });
      });

      // 0〜9 閾値スライダ
      const slider = liElement.querySelector(`#zoning-slider-${layerId}`);
      const valBadge = liElement.querySelector(`#zoning-val-${layerId}`);
      if (slider) {
        slider.addEventListener('input', (e) => {
          const stepVal = parseFloat(e.target.value);
          const threshVal = this.stepToThreshold(stepVal, info.minVal, info.maxVal);
          if (valBadge) valBadge.textContent = `S:${stepVal.toFixed(1)} (${threshVal.toFixed(2)})`;

          // 2色モードに自動切り替え＆リアルタイム描画
          const modeBtns = liElement.querySelectorAll(`.zoning-mode-pill[data-id="${layerId}"]`);
          modeBtns.forEach(b => b.classList.toggle('active', b.dataset.mode === 'threshold'));
          const controlsGroup = liElement.querySelector('.zoning-controls-group');
          if (controlsGroup) controlsGroup.classList.remove('disabled-group');

          this.updateSymbology(layerId, { threshold: threshVal, mode: 'threshold' });
        });
      }

      // 0〜9 クイックステップボタン
      liElement.querySelectorAll(`.zoning-step-btn[data-id="${layerId}"]`).forEach(btn => {
        btn.addEventListener('click', () => {
          const stepVal = parseInt(btn.dataset.step, 10);
          const threshVal = this.stepToThreshold(stepVal, info.minVal, info.maxVal);
          if (slider) slider.value = stepVal;
          if (valBadge) valBadge.textContent = `S:${stepVal} (${threshVal.toFixed(2)})`;

          const modeBtns = liElement.querySelectorAll(`.zoning-mode-pill[data-id="${layerId}"]`);
          modeBtns.forEach(b => b.classList.toggle('active', b.dataset.mode === 'threshold'));
          const controlsGroup = liElement.querySelector('.zoning-controls-group');
          if (controlsGroup) controlsGroup.classList.remove('disabled-group');

          this.updateSymbology(layerId, { threshold: threshVal, mode: 'threshold' });
        });
      });

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
    }

  };

})(window.GIS = window.GIS || {});
