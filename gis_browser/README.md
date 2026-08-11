# 🗺️ GIS Browser — Leaflet WebGIS ブラウザ

> KML・GeoJSON・画像・GeoTIFFをドラッグ＆ドロップで地図表示。撮影位置の特定・360°全天球画像対応・PDF出力まで対応したスタンドアロン型 WebGIS ブラウザ。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Leaflet](https://img.shields.io/badge/Leaflet-1.9.4-green.svg)](https://leafletjs.com)

---

## ✨ 機能一覧

| 機能 | 説明 |
|------|------|
| 📂 **D&D ファイル読み込み** | KML / GeoJSON / JPEG / PNG / HEIC / GeoTIFF をドラッグ＆ドロップ |
| 📍 **EXIF 位置情報読み取り** | 写真の GPS 情報を自動抽出してピン表示 |
| 🌐 **360°全天球画像プレビュー** | Pannellum ビューアでインタラクティブ表示 |
| 📌 **撮影位置の特定** | 位置情報なし画像を地図クリックでピン付け |
| 🛰️ **GeoTIFF 表示** | 衛星画像・標高データを地理参照付きで重ねる |
| 🗜️ **自動圧縮** | 500MB 超の GeoTIFF は自動リサンプリング（最大 2048px） |
| 💾 **GeoJSON / KML エクスポート** | ピン情報を標準フォーマットで保存 |
| 📄 **PDF / PNG 出力** | 地図画面をそのまま A4 PDF または PNG で保存 |
| 🗾 **ベースマップ切り替え** | 国土地理院標準・空中写真・OpenStreetMap |

---

## 🚀 使い方

### 1. GitHub Pages でホスティング（推奨）

```bash
# リポジトリをクローン
git clone https://github.com/your-username/gis-browser.git
cd gis-browser
```

GitHub の Settings → Pages → Branch: `main` / `/(root)` を選択して保存するだけで公開完了。

### 2. ローカルで開く

`gis_browser.html` をブラウザで直接開くか、簡易サーバーを使用：

```bash
# Python 3 がある場合
python -m http.server 8000
# → http://localhost:8000/gis_browser.html を開く
```

> ⚠️ **注意**: `file://` プロトコルでは CORS 制限により地図タイルが表示されない場合があります。ローカルサーバーを使用してください。

---

## 📁 ファイル構成

```
gis-browser/
├── gis_browser.html      # メインエントリポイント
├── gis_browser.css       # スタイルシート（ダーク・グラスモーフィズム）
├── gis_browser.js        # メインアプリケーション
└── modules/
    ├── appState.js       # 中央状態管理（イベントバス）
    ├── floatingPanel.js  # 折りたたみパネル UI
    ├── fileHandler.js    # ファイルタイプ判定・振り分け
    ├── kmlParser.js      # KML/KMZ 解析（DOMParser のみ）
    ├── geojsonHandler.js # GeoJSON 読み込み・表示
    ├── imageHandler.js   # EXIF 読み取り・ピン生成
    ├── pinEditor.js      # 撮影位置特定フロー・360°ビューア
    ├── geotiffHandler.js # GeoTIFF デコード・圧縮・オーバーレイ
    └── exportHandler.js  # GeoJSON / KML / PDF 出力
```

---

## 📦 使用ライブラリ

| ライブラリ | バージョン | 読み込み方式 | 用途 |
|---|---|---|---|
| [Leaflet](https://leafletjs.com) | 1.9.4 | 常時（CDN） | 地図表示の核 |
| [exifr](https://github.com/MikeKovarik/exifr) | 7.x | 動的（画像投入時のみ） | JPEG/HEIC EXIF 解析 |
| [Pannellum](https://pannellum.org) | 2.5.6 | 動的（360°画像検出時のみ） | 全天球画像ビューア |
| [geotiff.js](https://geotiffjs.github.io) | 2.x | 動的（GeoTIFF 投入時のみ） | GeoTIFF デコード |
| [proj4js](https://github.com/proj4js/proj4js) | 2.15.0 | 動的（平面直交系GeoTIFF投入時のみ） | 平面直交座標系 ➔ 緯度経度 投影変換 |
| [html2canvas](https://html2canvas.hertzen.com) | 1.4.1 | 動的（PDF 出力時のみ） | 地図キャプチャ |
| [jsPDF](https://github.com/parallax/jsPDF) | 2.5.1 | 動的（PDF 出力時のみ） | PDF 生成 |

> **設計方針**: exifr / Pannellum / geotiff.js / proj4js / html2canvas / jsPDF はすべて **動的ロード**（必要時のみ CDN から取得）。通常利用時の初期ロードは Leaflet のみです。

---

## 🌐 対応ブラウザ

| ブラウザ | 対応状況 |
|---|---|
| Chrome 90+ | ✅ 完全対応 |
| Firefox 90+ | ✅ 完全対応 |
| Edge 90+ | ✅ 完全対応 |
| Safari 15+ | ✅ 基本対応（360°ビューアは要確認） |

---

## 📝 対応ファイル形式

| 形式 | 拡張子 | 機能 |
|---|---|---|
| KML | `.kml`, `.kmz` | Point / LineString / Polygon・スタイル反映 |
| GeoJSON | `.geojson`, `.json` | FeatureCollection・SimpleStyle 対応 |
| JPEG / PNG | `.jpg`, `.jpeg`, `.png` | EXIF GPS 読み取り・ピン表示 |
| HEIC | `.heic`, `.heif` | Apple デバイス撮影写真（exifr 経由） |
| GeoTIFF | `.tif`, `.tiff` | 地理参照付き衛星・航空画像（WGS84 / Web Mercator / JGD2011・JGD2000 平面直交第1〜19系 自動変換対応） |
| 360°画像 | 上記画像形式全般 | アスペクト比 2:1 / XMP メタデータで自動検出 |

---

## 📸 360°全天球画像の検出条件

以下のいずれかに該当する場合、360°全天球ビューアで表示されます：

1. ファイル名に `360`, `pano`, `panorama`, `sphere`, `equirect`, `ricoh`, `insta360`, `theta` を含む
2. XMP メタデータに `ProjectionType=equirectangular` が含まれる
3. XMP に `FullPanoWidthPixels` が含まれる（Google フォト VR 形式）

---

## 🔒 プライバシー

- すべての処理はブラウザ内で完結します
- **画像・位置情報はサーバーに送信されません**
- 外部通信は地図タイル取得と CDN ライブラリのダウンロードのみです

---

## 📄 ライセンス

[MIT License](LICENSE) — 自由に使用・改変・再配布可能です。

---

## 🙏 データ提供

地図タイル:
- [国土地理院](https://maps.gsi.go.jp) — 標準地図・空中写真
- [OpenStreetMap](https://www.openstreetmap.org) contributors
