/**
 * appState.js - アプリケーション中央状態管理
 * GIS Browser - Leaflet WebGIS
 */
(function (GIS) {
  'use strict';

  /**
   * アプリケーションの全状態を一元管理するシングルトン
   */
  GIS.AppState = {
    /** Leaflet マップインスタンス */
    map: null,

    /** 読み込まれたレイヤーのマップ
     * key: UUID文字列
     * value: { id, name, type, layer, visible, file }
     */
    layers: new Map(),

    /** 確定済みピンの配列
     * { id, latlng, filename, thumbnail, is360, marker }
     */
    pins: [],

    /** 位置情報なし画像の処理キュー
     * { file, dataUrl, filename, is360 }
     */
    pendingImages: [],

    /** 現在処理中のキューインデックス */
    currentPendingIndex: 0,

    /** 撮影位置特定モード中か */
    locationMode: false,

    /** 撮影位置特定モード中の仮マーカー */
    tempMarker: null,

    /** イベントリスナーのマップ */
    _listeners: {},

    /**
     * イベントを購読する
     * @param {string} event - イベント名
     * @param {Function} callback - コールバック
     */
    on(event, callback) {
      if (!this._listeners[event]) this._listeners[event] = [];
      this._listeners[event].push(callback);
    },

    /**
     * イベントを発火する
     * @param {string} event - イベント名
     * @param {*} data - 渡すデータ
     */
    emit(event, data) {
      if (!this._listeners[event]) return;
      this._listeners[event].forEach(cb => {
        try { cb(data); } catch (e) { console.error('[AppState] Event error:', event, e); }
      });
    },

    /**
     * UUID v4 を生成する（crypto.randomUUID のフォールバック付き）
     * @returns {string}
     */
    generateId() {
      if (crypto && crypto.randomUUID) return crypto.randomUUID();
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
      });
    },

    /**
     * レイヤーを追加する
     * @param {object} layerObj - { name, type, layer, file }
     * @returns {string} 追加したレイヤーのID
     */
    addLayer(layerObj) {
      const id = this.generateId();
      const entry = { id, visible: true, ...layerObj };
      this.layers.set(id, entry);
      entry.layer.addTo(this.map);
      this.emit('layerAdded', entry);
      return id;
    },

    /**
     * レイヤーを削除する
     * @param {string} id
     */
    removeLayer(id) {
      const entry = this.layers.get(id);
      if (!entry) return;
      if (this.map.hasLayer(entry.layer)) this.map.removeLayer(entry.layer);
      this.layers.delete(id);
      this.emit('layerRemoved', { id });
    },

    /**
     * レイヤーの表示/非表示を切り替える
     * @param {string} id
     */
    toggleLayer(id) {
      const entry = this.layers.get(id);
      if (!entry) return;
      if (entry.visible) {
        this.map.removeLayer(entry.layer);
        entry.visible = false;
      } else {
        entry.layer.addTo(this.map);
        entry.visible = true;
      }
      this.emit('layerToggled', { id, visible: entry.visible });
    },

    /**
     * 全レイヤーを削除する
     */
    clearAllLayers() {
      this.layers.forEach((entry, id) => this.removeLayer(id));
      this.pins = [];
      this.emit('allLayersCleared', {});
    },

    /**
     * ピンを追加する
     * @param {object} pinObj - { latlng, filename, thumbnail, is360, marker }
     * @returns {string} pinId
     */
    addPin(pinObj) {
      const id = this.generateId();
      const pin = { id, ...pinObj };
      this.pins.push(pin);
      this.emit('pinAdded', pin);
      return id;
    },

    /**
     * 指定IDでピンを追加する（imageHandlerがポップアップHTML生成前に事前知る必要がある場合用）
     * @param {string} id
     * @param {object} pinObj - { latlng, filename, thumbnail, dataUrl, is360, marker }
     */
    addPinWithId(id, pinObj) {
      const pin = { id, ...pinObj };
      this.pins.push(pin);
      this.emit('pinAdded', pin);
    },

    /**
     * IDからピンを取得する
     * @param {string} id
     * @returns {object|undefined}
     */
    getPinById(id) {
      return this.pins.find(p => p.id === id);
    },

    /**
     * 位置情報なし画像をキューに追加する
     * @param {object} imgObj - { file, dataUrl, filename, is360 }
     */
    enqueuePendingImage(imgObj) {
      this.pendingImages.push(imgObj);
      this.emit('pendingQueueUpdated', { count: this.pendingImages.length });
    },

    /**
     * 処理中のキューをリセットする
     */
    resetPendingQueue() {
      this.pendingImages = [];
      this.currentPendingIndex = 0;
      this.locationMode = false;
      if (this.tempMarker && this.map) {
        try { this.map.removeLayer(this.tempMarker); } catch (_) {}
      }
      this.tempMarker = null;
    }
  };

})(window.GIS = window.GIS || {});
