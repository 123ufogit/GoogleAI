import os
import sys
import zipfile
import threading
import logging
import traceback
import xml.etree.ElementTree as ET
import tkinter as tk
from tkinter import ttk, filedialog, messagebox
import numpy as np
import rasterio
from rasterio.transform import from_origin
from rasterio.warp import calculate_default_transform, reproject, Resampling, transform_bounds
from rasterio.merge import merge as rio_merge
import re
import tempfile
import json

MAP_HTML_TEMPLATE = """<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <title>DEM 変換結果マップ</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <!-- Leaflet CSS -->
    <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=" crossorigin=""/>
    <!-- Google Fonts -->
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;700&family=Noto+Sans+JP:wght@300;400;500;700&display=swap" rel="stylesheet">
    <style>
        :root {
            --primary: #2563eb;
            --primary-hover: #1d4ed8;
            --bg-glass: rgba(255, 255, 255, 0.85);
            --border-glass: rgba(255, 255, 255, 0.4);
            --shadow: 0 8px 32px 0 rgba(31, 38, 135, 0.15);
            --text: #1f2937;
            --text-muted: #4b5563;
        }

        body, html {
            margin: 0;
            padding: 0;
            width: 100%;
            height: 100%;
            font-family: 'Outfit', 'Noto Sans JP', sans-serif;
            color: var(--text);
            overflow: hidden;
        }

        #map {
            width: 100%;
            height: 100%;
            position: absolute;
            top: 0;
            bottom: 0;
            z-index: 1;
        }

        /* Glassmorphic Side Panel */
        .dashboard {
            position: absolute;
            top: 20px;
            left: 20px;
            width: 380px;
            max-height: calc(100% - 40px);
            background: var(--bg-glass);
            backdrop-filter: blur(12px);
            -webkit-backdrop-filter: blur(12px);
            border: 1px solid var(--border-glass);
            border-radius: 16px;
            box-shadow: var(--shadow);
            z-index: 1000;
            display: flex;
            flex-direction: column;
            overflow: hidden;
            transition: all 0.3s ease;
        }

        .dashboard-header {
            padding: 20px;
            background: linear-gradient(135deg, rgba(37, 99, 235, 0.1) 0%, rgba(37, 99, 235, 0.02) 100%);
            border-bottom: 1px solid var(--border-glass);
        }

        .dashboard-title {
            margin: 0 0 5px 0;
            font-size: 1.25rem;
            font-weight: 700;
            color: var(--primary);
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .dashboard-subtitle {
            margin: 0;
            font-size: 0.85rem;
            color: var(--text-muted);
        }

        .stats-grid {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 10px;
            padding: 15px 20px;
            border-bottom: 1px solid var(--border-glass);
            background: rgba(255, 255, 255, 0.5);
        }

        .stat-card {
            padding: 8px 12px;
            background: rgba(255, 255, 255, 0.6);
            border: 1px solid rgba(255, 255, 255, 0.8);
            border-radius: 8px;
            text-align: center;
        }

        .stat-value {
            font-size: 1.2rem;
            font-weight: 700;
            color: var(--primary);
        }

        .stat-label {
            font-size: 0.75rem;
            color: var(--text-muted);
        }

        .search-container {
            padding: 15px 20px 10px 20px;
            position: relative;
        }

        .search-input {
            width: 100%;
            padding: 10px 12px 10px 35px;
            border: 1px solid rgba(0, 0, 0, 0.1);
            border-radius: 8px;
            background: rgba(255, 255, 255, 0.9);
            box-sizing: border-box;
            font-family: inherit;
            font-size: 0.9rem;
            outline: none;
            transition: border-color 0.2s;
        }

        .search-input:focus {
            border-color: var(--primary);
        }

        .search-icon {
            position: absolute;
            left: 32px;
            top: 25px;
            color: var(--text-muted);
            pointer-events: none;
        }

        .file-list-container {
            flex: 1;
            overflow-y: auto;
            padding: 0 20px 20px 20px;
        }

        .file-list {
            list-style: none;
            padding: 0;
            margin: 0;
            display: flex;
            flex-direction: column;
            gap: 8px;
        }

        .file-item {
            padding: 10px 12px;
            background: rgba(255, 255, 255, 0.5);
            border: 1px solid rgba(0, 0, 0, 0.05);
            border-radius: 8px;
            cursor: pointer;
            transition: all 0.2s ease;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .file-item:hover {
            background: rgba(37, 99, 235, 0.08);
            border-color: rgba(37, 99, 235, 0.2);
            transform: translateY(-1px);
        }

        .file-name {
            font-size: 0.85rem;
            font-weight: 500;
            text-overflow: ellipsis;
            overflow: hidden;
            white-space: nowrap;
            max-width: 230px;
        }

        .file-tag {
            font-size: 0.7rem;
            padding: 2px 6px;
            border-radius: 4px;
            font-weight: 600;
        }

        .tag-mesh {
            background: rgba(37, 99, 235, 0.1);
            color: var(--primary);
        }

        .tag-merged {
            background: rgba(234, 88, 12, 0.1);
            color: #ea580c;
        }

        /* Leaflet Controls Styling */
        .leaflet-bar {
            box-shadow: var(--shadow) !important;
            border: 1px solid var(--border-glass) !important;
            border-radius: 8px !important;
            overflow: hidden;
        }

        .leaflet-bar a {
            background: var(--bg-glass) !important;
            backdrop-filter: blur(8px);
            border-bottom: 1px solid var(--border-glass) !important;
            color: var(--text) !important;
            transition: background-color 0.2s;
        }

        .leaflet-bar a:hover {
            background: rgba(255, 255, 255, 0.95) !important;
            color: var(--primary) !important;
        }

        /* Popup Styling */
        .custom-popup .leaflet-popup-content-wrapper {
            background: var(--bg-glass);
            backdrop-filter: blur(10px);
            border: 1px solid var(--border-glass);
            border-radius: 12px;
            box-shadow: var(--shadow);
            color: var(--text);
            font-family: inherit;
        }

        .custom-popup .leaflet-popup-tip {
            background: var(--bg-glass);
            border: 1px solid var(--border-glass);
        }

        .popup-title {
            font-size: 0.95rem;
            font-weight: 700;
            color: var(--primary);
            margin: 0 0 8px 0;
            border-bottom: 1px solid rgba(0, 0, 0, 0.08);
            padding-bottom: 5px;
        }

        .popup-row {
            display: flex;
            justify-content: space-between;
            font-size: 0.8rem;
            margin-bottom: 4px;
        }

        .popup-label {
            color: var(--text-muted);
            font-weight: 500;
        }

        .popup-value {
            font-weight: 600;
            text-align: right;
        }
    </style>
</head>
<body>

    <div id="map"></div>

    <div class="dashboard">
        <div class="dashboard-header">
            <h1 class="dashboard-title">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle;"><polygon points="3 6 9 3 15 6 21 3 21 18 15 21 9 18 3 21"></polygon><line x1="9" y1="3" x2="9" y2="18"></line><line x1="15" y1="6" x2="15" y2="21"></line></svg>
                DEM 変換結果マップ
            </h1>
            <p class="dashboard-subtitle">国土地理院 基盤地図情報 DEM 変換結果</p>
        </div>

        <div class="stats-grid">
            <div class="stat-card">
                <div id="stat-count" class="stat-value">-</div>
                <div class="stat-label">総メッシュ数</div>
            </div>
            <div class="stat-card">
                <div id="stat-type" class="stat-value">-</div>
                <div class="stat-label">出力形式</div>
            </div>
        </div>

        <div class="search-container">
            <svg class="search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
            <input type="text" id="search" class="search-input" placeholder="メッシュコードで検索...">
        </div>

        <div class="file-list-container">
            <ul id="file-list" class="file-list">
                <!-- Dynamic File Items -->
            </ul>
        </div>
    </div>

    <!-- Leaflet JS -->
    <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=" crossorigin=""></script>
    <!-- Load dem_layout.js -->
    <script src="dem_layout.js"></script>
    <script>
        // Check if data is loaded
        if (typeof demLayoutData === 'undefined') {
            alert('Error: dem_layout.js could not be loaded.');
        }

        // Initialize Map centered on Japan
        const map = L.map('map', {
            zoomControl: false
        }).setView([36.2048, 138.2529], 5);

        // Add Zoom Control at top-right
        L.control.zoom({
            position: 'topright'
        }).addTo(map);

        // GSI Standard Map Layer
        const gsiStdLayer = L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png', {
            maxZoom: 18,
            attribution: '&copy; <a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">国土地理院</a>'
        }).addTo(map);

        // Layers for features
        const sourceLayerGroup = L.geoJSON(demLayoutData, {
            filter: function(feature) {
                return feature.properties.type === 'source_mesh';
            },
            style: function(feature) {
                return {
                    color: '#2563eb',
                    weight: 2,
                    fillColor: '#3b82f6',
                    fillOpacity: 0.15,
                    dashArray: ''
                };
            },
            onEachFeature: onEachFeature
        }).addTo(map);

        const mergedLayerGroup = L.geoJSON(demLayoutData, {
            filter: function(feature) {
                return feature.properties.type === 'merged_file';
            },
            style: function(feature) {
                return {
                    color: '#ea580c',
                    weight: 3,
                    fillColor: 'none',
                    fillOpacity: 0,
                    dashArray: '5, 8'
                };
            },
            onEachFeature: onEachFeature
        }).addTo(map);

        // Fit Bounds
        const allBounds = L.featureGroup([sourceLayerGroup, mergedLayerGroup]).getBounds();
        if (allBounds.isValid()) {
            map.fitBounds(allBounds, { padding: [50, 50] });
        }

        // Map interactions
        function onEachFeature(feature, layer) {
            // Popup HTML
            let popupContent = '<div class="custom-popup">';
            if (feature.properties.type === 'merged_file') {
                popupContent += '<div class="popup-title">結合 GeoTIFF</div>';
            } else {
                popupContent += '<div class="popup-title">出力メッシュ</div>';
            }
            popupContent += '<div class="popup-row"><span class="popup-label">ファイル名:</span><span class="popup-value">' + feature.properties.filename + '</span></div>';
            popupContent += '<div class="popup-row"><span class="popup-label">識別コード:</span><span class="popup-value">' + feature.properties.mesh_code + '</span></div>';
            
            // Get coordinates
            const coords = feature.geometry.coordinates[0];
            const lonMin = coords[0][0].toFixed(5);
            const latMin = coords[0][1].toFixed(5);
            const lonMax = coords[2][0].toFixed(5);
            const latMax = coords[2][1].toFixed(5);
            popupContent += '<div class="popup-row"><span class="popup-label">範囲 (南西):</span><span class="popup-value">' + latMin + ', ' + lonMin + '</span></div>';
            popupContent += '<div class="popup-row"><span class="popup-label">範囲 (北東):</span><span class="popup-value">' + latMax + ', ' + lonMax + '</span></div>';
            popupContent += '</div>';

            layer.bindPopup(popupContent, {
                className: 'custom-popup'
            });

            // Tooltip for quick hover info
            layer.bindTooltip(feature.properties.mesh_code, {
                permanent: false,
                direction: 'center',
                className: 'mesh-tooltip'
            });

            // Highlight on hover
            layer.on({
                mouseover: function(e) {
                    const l = e.target;
                    if (feature.properties.type === 'source_mesh') {
                        l.setStyle({
                            weight: 3,
                            color: '#fbbf24',
                            fillColor: '#fbbf24',
                            fillOpacity: 0.3
                        });
                    } else {
                        l.setStyle({
                            weight: 4,
                            color: '#ef4444'
                        });
                    }
                    if (!L.Browser.ie && !L.Browser.opera && !L.Browser.edge) {
                        l.bringToFront();
                    }
                },
                mouseout: function(e) {
                    if (feature.properties.type === 'source_mesh') {
                        sourceLayerGroup.resetStyle(e.target);
                    } else {
                        mergedLayerGroup.resetStyle(e.target);
                    }
                },
                click: function(e) {
                    map.fitBounds(e.target.getBounds(), { padding: [100, 100] });
                }
            });
        }

        // Render Panel list and stats
        const features = demLayoutData.features;
        const sourceFeatures = features.filter(f => f.properties.type === 'source_mesh');
        const hasMerged = features.some(f => f.properties.type === 'merged_file');

        document.getElementById('stat-count').innerText = sourceFeatures.length;
        document.getElementById('stat-type').innerText = hasMerged ? '結合 (1枚)' : '個別';

        const fileListUl = document.getElementById('file-list');

        function renderList(filterText = '') {
            fileListUl.innerHTML = '';
            
            // First render merged if it exists
            features.forEach((feat, index) => {
                const props = feat.properties;
                if (props.type === 'merged_file') {
                    createListItem(feat, 'tag-merged', '結合');
                }
            });

            // Then render source meshes matching search
            features.forEach((feat, index) => {
                const props = feat.properties;
                if (props.type === 'source_mesh') {
                    if (props.mesh_code.toLowerCase().includes(filterText.toLowerCase())) {
                        createListItem(feat, 'tag-mesh', 'メッシュ');
                    }
                }
            });
        }

        function createListItem(feat, tagClass, tagLabel) {
            const props = feat.properties;
            const li = document.createElement('li');
            li.className = 'file-item';
            li.innerHTML = `
                <div class="file-name" title="` + props.filename + `">` + props.filename + `</div>
                <div class="file-tag ` + tagClass + `">` + tagLabel + `</div>
            `;
            
            li.addEventListener('click', () => {
                // Find matching layer
                let targetLayer = null;
                sourceLayerGroup.eachLayer(l => {
                    if (l.feature.properties.filename === props.filename) targetLayer = l;
                });
                mergedLayerGroup.eachLayer(l => {
                    if (l.feature.properties.filename === props.filename) targetLayer = l;
                });

                if (targetLayer) {
                    map.fitBounds(targetLayer.getBounds(), { padding: [100, 100] });
                    targetLayer.openPopup();
                }
            });

            fileListUl.appendChild(li);
        }

        // Search binder
        document.getElementById('search').addEventListener('input', (e) => {
            renderList(e.target.value);
        });

        // Initial render
        renderList();
    </script>
</body>
</html>
"""

def estimate_jgd_zone(lat, lon):
    """緯度と経度から、最適な平面直交座標系の系番号(1〜19)を推定する"""
    # 離島や特殊地域の判定
    # 19系: 南鳥島 (東経153度以東)
    if lon > 150.0:
        return 19
    # 18系: 沖ノ鳥島 (北緯21度以南)
    if lat < 21.0:
        return 18
    # 14系: 小笠原諸島 (北緯28度以南、東経140度以東)
    if lat < 28.0 and lon > 140.0:
        return 14
    # 17系: 八重山 (北緯25度以南、東経124.5度以西)
    if lat < 25.0 and lon < 124.5:
        return 17
    # 16系: 宮古 (北緯25度以南、東経126.0度以西)
    if lat < 25.0 and lon < 126.0:
        return 16
    # 15系: 沖縄本島周辺 (北緯28度以南、東経129.0度以西)
    if lat < 28.0 and lon < 129.0:
        return 15
    # 3系・4系: 奄美・トカラ (北緯30.5度以南、東経131.0度以西)
    if lat < 30.5 and lon < 131.0:
        if lat < 28.5:
            return 3  # 奄美
        else:
            return 4  # トカラ

    # 北海道 (北緯41.3度以北)
    if lat > 41.3:
        if lon < 141.2:
            return 11
        elif lon < 143.3:
            return 12
        else:
            return 13

    # 本州・四国・九州 (北緯30度〜42度)
    if lon < 130.25:
        if lon < 130.1:
            return 1
        else:
            return 2
    elif lon < 132.5:
        return 2
    elif lon < 135.15:
        return 5
    elif lon < 136.6:
        # 石川・福井（7系）と京都・大阪（6系）の境界調整
        if lat > 35.3 and lon > 135.6:
            return 7
        return 6
    elif lon < 137.87:
        return 7
    elif lon < 139.16:
        return 8
    elif lon < 140.33:
        if lat > 38.7:
            return 10
        return 9
    else:
        if lat > 38.9:
            return 10
        return 9

def parse_xml_metadata(xml_content):
    """XML文字列から境界座標(lat_min, lon_min, lat_max, lon_max)、グリッド解像度、SRS名などを解析して辞書で返す"""
    root = ET.fromstring(xml_content)
    FGD_NS = '{http://fgd.gsi.go.jp/spec/2008/FGD_GMLSchema}'
    GML_NS = '{http://www.opengis.net/gml/3.2}'

    dem_elem = root.find(f'.//{FGD_NS}DEM')
    if dem_elem is None:
        dem_elem = root.find('.//DEM')
        if dem_elem is None:
            raise ValueError("XML内に DEM 要素が見つかりません。")

    coverage_elem = dem_elem.find(f'.//{FGD_NS}coverage')
    if coverage_elem is None:
        coverage_elem = dem_elem.find('.//coverage')
        if coverage_elem is None:
            raise ValueError("DEM要素内に coverage 要素が見つかりません。")

    envelope = coverage_elem.find(f'.//{GML_NS}Envelope')
    if envelope is None:
        raise ValueError("gml:Envelope が見つかりません。")

    srs_name = envelope.get('srsName', '')
    is_jgd2000 = 'jgd2000' in srs_name.lower()

    lower_corner = envelope.find(f'.//{GML_NS}lowerCorner')
    upper_corner = envelope.find(f'.//{GML_NS}upperCorner')
    if lower_corner is None or upper_corner is None:
        raise ValueError("lowerCorner または upperCorner が見つかりません。")

    c1_low, c2_low = map(float, lower_corner.text.strip().split())
    c1_up, c2_up = map(float, upper_corner.text.strip().split())

    if c1_low > c2_low:
        lon_min, lat_min = c1_low, c2_low
        lon_max, lat_max = c1_up, c2_up
    else:
        lat_min, lon_min = c1_low, c2_low
        lat_max, lon_max = c1_up, c2_up

    # グリッドサイズも取得
    grid_envelope = coverage_elem.find(f'.//{GML_NS}GridEnvelope')
    width, height = 1, 1
    if grid_envelope is not None:
        low_elem = grid_envelope.find(f'.//{GML_NS}low')
        high_elem = grid_envelope.find(f'.//{GML_NS}high')
        if low_elem is not None and high_elem is not None:
            low_x, low_y = map(int, low_elem.text.strip().split())
            high_x, high_y = map(int, high_elem.text.strip().split())
            width = high_x - low_x + 1
            height = high_y - low_y + 1

    return {
        'lat_min': lat_min,
        'lon_min': lon_min,
        'lat_max': lat_max,
        'lon_max': lon_max,
        'width': width,
        'height': height,
        'is_jgd2000': is_jgd2000,
        'srs_name': srs_name
    }

def extract_mesh_code(filename):
    """ファイル名からメッシュコード（図郭番号）を抽出する"""
    match = re.search(r'\b(\d{4}-\d{2}-\d{2})\b', filename)
    if match:
        return match.group(1)
    match = re.search(r'\b(\d{8})\b', filename)
    if match:
        return match.group(1)
    match = re.search(r'\b(\d{4}-\d{2})\b', filename)
    if match:
        return match.group(1)
    match = re.search(r'\b(\d{6})\b', filename)
    if match:
        return match.group(1)
    match = re.search(r'\b(\d{4})\b', filename)
    if match:
        return match.group(1)
    return os.path.splitext(filename)[0]

def parse_mesh_code(filename):
    """ファイル名に含まれるメッシュコード（1次/2次/3次）から中心緯度・経度(lat, lon)を算出する"""
    mesh = extract_mesh_code(filename).replace("-", "")
    if len(mesh) < 4 or not mesh[:4].isdigit():
        return None

    p1p2 = int(mesh[:2])
    q1q2 = int(mesh[2:4])
    lat = p1p2 / 1.5
    lon = q1q2 + 100.0

    if len(mesh) >= 6 and mesh[4:6].isdigit():
        r1 = int(mesh[4])
        r2 = int(mesh[5])
        lat += r1 * (5.0 / 60.0)
        lon += r2 * (7.5 / 60.0)

        if len(mesh) >= 8 and mesh[6:8].isdigit():
            s1 = int(mesh[6])
            s2 = int(mesh[7])
            lat += s1 * (0.5 / 60.0)
            lon += s2 * (0.75 / 60.0)
            lat += 0.25 / 60.0
            lon += 0.375 / 60.0
        else:
            lat += 2.5 / 60.0
            lon += 3.75 / 60.0
    else:
        lat += 20.0 / 60.0
        lon += 30.0 / 60.0

    return lat, lon

def scan_input_directory_for_crs(input_dir):
    """入力フォルダをスキャンし、最初に見つかったXML等から推奨の系番号(1〜19)、元データがJGD2000かどうか、座標を返す"""
    for root_dir, _, filenames in os.walk(input_dir):
        for f in filenames:
            ext = os.path.splitext(f)[1].lower()
            file_path = os.path.join(root_dir, f)
            
            # まずファイル名から高速判定 (JGD2011をデフォルトとする)
            coords = parse_mesh_code(f)
            if coords:
                lat, lon = coords
                zone = estimate_jgd_zone(lat, lon)
                if zone:
                    return zone, False, lat, lon

            # ファイル名で判定できなかった場合は中身を解析
            if ext == '.xml':
                try:
                    with open(file_path, 'r', encoding='utf-8', errors='ignore') as file_obj:
                        xml_content = file_obj.read()
                    meta = parse_xml_metadata(xml_content)
                    lat = (meta['lat_min'] + meta['lat_max']) / 2.0
                    lon = (meta['lon_min'] + meta['lon_max']) / 2.0
                    zone = estimate_jgd_zone(lat, lon)
                    if zone:
                        return zone, meta['is_jgd2000'], lat, lon
                except Exception:
                    pass
            elif ext == '.zip':
                try:
                    with zipfile.ZipFile(file_path, 'r') as zf:
                        xml_members = [name for name in zf.namelist() if name.lower().endswith('.xml')]
                        if xml_members:
                            xml_content = zf.read(xml_members[0]).decode('utf-8', errors='ignore')
                            meta = parse_xml_metadata(xml_content)
                            lat = (meta['lat_min'] + meta['lat_max']) / 2.0
                            lon = (meta['lon_min'] + meta['lon_max']) / 2.0
                            zone = estimate_jgd_zone(lat, lon)
                            if zone:
                                return zone, meta['is_jgd2000'], lat, lon
                except Exception:
                    pass
    return None

class ConverterApp(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("国土地理院 DEM XML -> GeoTIFF 変換ツール")
        self.geometry("700x700")
        self.minsize(600, 600)
        self.scanned_metadata_cache = []
        self.metadata_scan_thread_active = False
        self.muni_map = {}
        self.mesh_to_muni = {}
        self.setup_ui()
        self.processing = False

    def setup_ui(self):
        # Configure styles
        style = ttk.Style()
        style.theme_use('vista' if os.name == 'nt' else 'clam')

        # Main container
        main_frame = ttk.Frame(self, padding="15")
        main_frame.pack(fill=tk.BOTH, expand=True)

        # Title
        title_label = ttk.Label(main_frame, text="国土地理院 基盤地図情報 DEM 変換ツール", font=("Helvetica", 14, "bold"))
        title_label.pack(anchor=tk.W, pady=(0, 15))

        # Folder selection frame
        folder_frame = ttk.LabelFrame(main_frame, text="フォルダ設定", padding="10")
        folder_frame.pack(fill=tk.X, pady=(0, 15))

        # Input folder
        ttk.Label(folder_frame, text="入力フォルダ (XML / ZIP):").grid(row=0, column=0, sticky=tk.W, pady=5)
        self.input_dir_var = tk.StringVar()
        self.input_entry = ttk.Entry(folder_frame, textvariable=self.input_dir_var, width=50)
        self.input_entry.grid(row=0, column=1, padx=5, pady=5, sticky=tk.EW)
        self.input_btn = ttk.Button(folder_frame, text="参照...", command=self.browse_input)
        self.input_btn.grid(row=0, column=2, padx=5, pady=5)

        # Output folder
        ttk.Label(folder_frame, text="出力フォルダ (GeoTIFF):").grid(row=1, column=0, sticky=tk.W, pady=5)
        self.output_dir_var = tk.StringVar()
        self.output_entry = ttk.Entry(folder_frame, textvariable=self.output_dir_var, width=50)
        self.output_entry.grid(row=1, column=1, padx=5, pady=5, sticky=tk.EW)
        self.output_btn = ttk.Button(folder_frame, text="参照...", command=self.browse_output)
        self.output_btn.grid(row=1, column=2, padx=5, pady=5)

        # Output filename (for merge mode)
        ttk.Label(folder_frame, text="出力ファイル名 (結合時):").grid(row=2, column=0, sticky=tk.W, pady=5)
        self.output_filename_var = tk.StringVar(value="dem_merged.tif")
        self.output_filename_entry = ttk.Entry(folder_frame, textvariable=self.output_filename_var, width=50)
        self.output_filename_entry.grid(row=2, column=1, padx=5, pady=5, sticky=tk.EW)

        # Download help link for GSI Fundamental Geospatial Data
        gsi_download_label = ttk.Label(folder_frame, text="データダウンロード: 国土地理院 基盤地図情報ダウンロードサービス (https://service.gsi.go.jp/kiban/app/map/?search=base)", font=("Helvetica", 8), cursor="hand2", foreground="blue")
        gsi_download_label.grid(row=3, column=0, columnspan=3, sticky=tk.W, pady=(2, 0))
        gsi_download_label.bind("<Button-1>", lambda e: self.open_gsi_download_url())

        gsi_note_label = ttk.Label(folder_frame, text="※ データのダウンロードおよび利用にあたっては「国土地理院コンテンツ利用規約」をご確認ください。", font=("Helvetica", 8), foreground="#555555")
        gsi_note_label.grid(row=4, column=0, columnspan=3, sticky=tk.W, pady=(0, 2))

        folder_frame.columnconfigure(1, weight=1)

        # Municipality Filter frame
        muni_frame = ttk.LabelFrame(main_frame, text="市区町村フィルター (非必須)", padding="10")
        muni_frame.pack(fill=tk.X, pady=(0, 15))

        # CSV file selection
        ttk.Label(muni_frame, text="メッシュCSV:").grid(row=0, column=0, sticky=tk.W, pady=5)
        self.muni_csv_var = tk.StringVar()
        self.muni_csv_entry = ttk.Entry(muni_frame, textvariable=self.muni_csv_var, width=50)
        self.muni_csv_entry.grid(row=0, column=1, padx=5, pady=5, sticky=tk.EW)
        self.muni_csv_btn = ttk.Button(muni_frame, text="参照...", command=self.browse_muni_csv)
        self.muni_csv_btn.grid(row=0, column=2, padx=5, pady=5)

        # Municipality dropdown
        ttk.Label(muni_frame, text="対象市区町村:").grid(row=1, column=0, sticky=tk.W, pady=5)
        self.muni_select_var = tk.StringVar()
        self.muni_combo = ttk.Combobox(muni_frame, textvariable=self.muni_select_var, state="disabled", width=30)
        self.muni_combo.grid(row=1, column=1, padx=5, pady=5, sticky=tk.W)
        self.muni_combo.bind("<<ComboboxSelected>>", self.on_muni_selected)

        # Filter enable checkbox
        self.muni_filter_enabled_var = tk.BooleanVar(value=False)
        self.muni_filter_check = ttk.Checkbutton(muni_frame, text="この市区町村の範囲のみ変換する", variable=self.muni_filter_enabled_var, state="disabled", command=self.on_muni_filter_toggled)
        self.muni_filter_check.grid(row=1, column=1, padx=(220, 5), pady=5, sticky=tk.W)

        # Download help link
        download_label = ttk.Label(muni_frame, text="CSVダウンロード: 総務省統計局ホームページ (https://www.stat.go.jp/data/mesh/index.html)", font=("Helvetica", 8), cursor="hand2", foreground="blue")
        download_label.grid(row=2, column=0, columnspan=3, sticky=tk.W, pady=(2, 0))
        download_label.bind("<Button-1>", lambda e: self.open_download_url())

        muni_frame.columnconfigure(1, weight=1)

        # Trace muni CSV path changes
        self.muni_csv_var.trace_add("write", self.on_muni_csv_changed)

        # Settings frame
        settings_frame = ttk.LabelFrame(main_frame, text="変換設定", padding="10")
        settings_frame.pack(fill=tk.X, pady=(0, 15))

        ttk.Label(settings_frame, text="座標参照系 (CRS):").grid(row=0, column=0, sticky=tk.W, pady=5)
        self.crs_var = tk.StringVar(value="EPSG:6697 (JGD2011 - 推奨)")
        
        # Base CRS options
        self.base_crs_values = [
            "EPSG:6697 (JGD2011 - 推奨)",
            "EPSG:4612 (JGD2000)",
            "EPSG:4326 (WGS84)"
        ]
        
        # JGD2011 Plane Rect Coordinate System (Zones 1-19)
        for i in range(1, 20):
            self.base_crs_values.append(f"EPSG:{6668 + i} (JGD2011 / 平面直交座標第{i}系)")
            
        # JGD2000 Plane Rect Coordinate System (Zones 1-19)
        for i in range(1, 20):
            self.base_crs_values.append(f"EPSG:{2442 + i} (JGD2000 / 平面直交座標第{i}系)")

        self.crs_combo = ttk.Combobox(settings_frame, textvariable=self.crs_var, values=self.base_crs_values, state="readonly", width=45)
        self.crs_combo.grid(row=0, column=1, padx=5, pady=5, sticky=tk.W)
        self.crs_combo.bind("<<ComboboxSelected>>", self.on_crs_changed)

        # Merge Checkbox
        self.merge_var = tk.BooleanVar(value=True)
        self.merge_check = ttk.Checkbutton(settings_frame, text="1枚のGeoTIFFに結合する (Merge into 1 TIFF)", variable=self.merge_var, command=self.on_merge_toggled)
        self.merge_check.grid(row=1, column=0, columnspan=2, sticky=tk.W, pady=5)

        # Null Fill Checkbox and Method Dropdown
        self.fill_nulls_var = tk.BooleanVar(value=False)
        self.fill_nulls_check = ttk.Checkbutton(settings_frame, text="Null値（水部・計測範囲外）の穴埋めを行う", variable=self.fill_nulls_var, command=self.toggle_fill_options_state)
        self.fill_nulls_check.grid(row=2, column=0, sticky=tk.W, pady=5)

        self.fill_method_var = tk.StringVar(value="標高 0m で一律補完 (Zero Fill)")
        self.fill_method_combo = ttk.Combobox(settings_frame, textvariable=self.fill_method_var, values=["標高 0m で一律補完 (Zero Fill)", "周辺標高から滑らかに補間 (Interpolate)"], state="disabled", width=35)
        self.fill_method_combo.grid(row=2, column=1, padx=5, pady=5, sticky=tk.W)

        # File Size Estimate Label
        self.size_estimate_var = tk.StringVar(value="")
        self.size_estimate_label = ttk.Label(settings_frame, textvariable=self.size_estimate_var, font=("Helvetica", 9, "italic"))
        self.size_estimate_label.grid(row=3, column=0, columnspan=2, sticky=tk.W, pady=2)

        # Progress Bar and Controls
        control_frame = ttk.Frame(main_frame)
        control_frame.pack(fill=tk.X, pady=(0, 10))

        self.start_btn = ttk.Button(control_frame, text="変換開始", command=self.start_conversion)
        self.start_btn.pack(side=tk.LEFT, padx=(0, 10))

        self.progress_var = tk.DoubleVar()
        self.progress_bar = ttk.Progressbar(control_frame, variable=self.progress_var, maximum=100)
        self.progress_bar.pack(side=tk.LEFT, fill=tk.X, expand=True, pady=5)

        # Log frame
        log_frame = ttk.LabelFrame(main_frame, text="処理ログ / 進捗状況", padding="5")
        log_frame.pack(fill=tk.BOTH, expand=True)

        # Log header frame with save button
        log_header_frame = ttk.Frame(log_frame)
        log_header_frame.pack(fill=tk.X, pady=(0, 5))

        self.save_log_btn = ttk.Button(log_header_frame, text="処理ログを保存...", command=self.save_log_file)
        self.save_log_btn.pack(side=tk.RIGHT)

        log_content_frame = ttk.Frame(log_frame)
        log_content_frame.pack(fill=tk.BOTH, expand=True)

        # Text log widget with Scrollbar
        self.log_text = tk.Text(log_content_frame, wrap=tk.WORD, height=12, state=tk.DISABLED, font=("Consolas", 9))
        self.log_text.pack(fill=tk.BOTH, expand=True, side=tk.LEFT)

        scrollbar = ttk.Scrollbar(log_content_frame, command=self.log_text.yview)
        scrollbar.pack(fill=tk.Y, side=tk.RIGHT)
        self.log_text.config(yscrollcommand=scrollbar.set)

        # Trace input directory changes for automatic CRS selection
        self.input_dir_var.trace_add("write", self.on_input_dir_changed)

        # Initialize output filename state
        self.update_output_filename_state()

    def save_log_file(self):
        log_content = self.log_text.get("1.0", tk.END).strip()
        if not log_content:
            messagebox.showinfo("お知らせ", "保存する処理ログが存在しません。")
            return

        initial_dir = self.output_dir_var.get().strip()
        if not initial_dir or not os.path.isdir(initial_dir):
            initial_dir = self.input_dir_var.get().strip()
        if not initial_dir or not os.path.isdir(initial_dir):
            initial_dir = os.path.expanduser("~")

        file_selected = filedialog.asksaveasfilename(
            title="処理ログの保存先を選択",
            initialdir=initial_dir,
            initialfile="conversion_log.txt",
            defaultextension=".txt",
            filetypes=[("テキストファイル", "*.txt"), ("すべてのファイル", "*.*")]
        )
        if file_selected:
            try:
                with open(file_selected, "w", encoding="utf-8") as f:
                    f.write(log_content + "\n")
                messagebox.showinfo("完了", f"処理ログを保存しました:\n{os.path.basename(file_selected)}")
            except Exception as e:
                messagebox.showerror("エラー", f"処理ログの保存に失敗しました:\n{str(e)}")

    def on_input_dir_changed(self, *args):
        input_dir = self.input_dir_var.get().strip()
        if not input_dir or not os.path.isdir(input_dir):
            self.scanned_metadata_cache = []
            self.size_estimate_var.set("")
            return

        self.start_metadata_scan(input_dir)

        res = scan_input_directory_for_crs(input_dir)
        if res:
            zone, is_jgd2000, lat, lon = res
            if is_jgd2000:
                recommended_epsg = 2442 + zone
                crs_name = f"EPSG:{recommended_epsg} (JGD2000 / 平面直交座標第{zone}系) [自動判定・推奨]"
            else:
                recommended_epsg = 6668 + zone
                crs_name = f"EPSG:{recommended_epsg} (JGD2011 / 平面直交座標第{zone}系) [自動判定・推奨]"

            # Insert recommended CRS at the top
            current_values = list(self.base_crs_values)
            current_values.insert(0, crs_name)
            
            self.crs_combo.config(values=current_values)
            self.crs_var.set(crs_name)
            self.log(f"フォルダスキャン結果: 推奨座標系「{crs_name}」 (代表点: 北緯{lat:.3f}, 東経{lon:.3f})")

    def start_metadata_scan(self, input_dir):
        if self.metadata_scan_thread_active:
            return
        self.scanned_metadata_cache = []
        self.size_estimate_var.set("結合後予測サイズ: ファイル情報取得中...")
        self.metadata_scan_thread_active = True
        threading.Thread(target=self.scan_metadata_thread, args=(input_dir,), daemon=True).start()

    def scan_metadata_thread(self, input_dir):
        all_files = []
        for root_dir, _, filenames in os.walk(input_dir):
            for f in filenames:
                ext = os.path.splitext(f)[1].lower()
                if ext in ['.xml', '.zip']:
                    all_files.append(os.path.join(root_dir, f))

        temp_cache = []
        total = len(all_files)
        for idx, file_path in enumerate(all_files):
            basename = os.path.basename(file_path)
            if idx % 5 == 0 or idx == total - 1:
                try:
                    self.after(0, lambda count=idx+1, tot=total: self.size_estimate_var.set(f"結合後予測サイズ: ファイル情報取得中 ({count}/{tot})..."))
                except Exception:
                    pass

            ext = os.path.splitext(file_path)[1].lower()
            if ext == '.xml':
                try:
                    with open(file_path, 'r', encoding='utf-8', errors='ignore') as f:
                        content = f.read()
                    meta = parse_xml_metadata(content)
                    meta['filename'] = basename
                    meta['mesh_code'] = extract_mesh_code(basename)
                    temp_cache.append(meta)
                except Exception:
                    pass
            elif ext == '.zip':
                try:
                    with zipfile.ZipFile(file_path, 'r') as zf:
                        xml_members = [name for name in zf.namelist() if name.lower().endswith('.xml')]
                        for m_name in xml_members:
                            content = zf.read(m_name).decode('utf-8', errors='ignore')
                            meta = parse_xml_metadata(content)
                            meta['filename'] = os.path.basename(m_name)
                            meta['mesh_code'] = extract_mesh_code(os.path.basename(m_name))
                            temp_cache.append(meta)
                except Exception:
                    pass

        self.scanned_metadata_cache = temp_cache
        self.metadata_scan_thread_active = False
        try:
            self.after(0, self.on_metadata_scan_complete)
        except Exception:
            # Fallback if tk event loop is not running (e.g. headless unit tests)
            self.on_metadata_scan_complete()

    def on_metadata_scan_complete(self):
        self.update_size_estimate()
        self.update_merged_filename_if_default()

    def on_crs_changed(self, event=None):
        self.update_size_estimate()

    def on_merge_toggled(self):
        self.update_size_estimate()
        self.update_output_filename_state()
        self.update_merged_filename_if_default()

    def update_size_estimate(self):
        if not self.scanned_metadata_cache:
            self.size_estimate_var.set("変換対象のXML/ZIPファイルが見つかりません。")
            self.size_estimate_label.config(foreground="black")
            return

        total_files = len(self.scanned_metadata_cache)
        
        # Check if municipality filter is active
        is_filtered = False
        muni_name = self.muni_select_var.get().strip()
        filtered_metadata = self.scanned_metadata_cache
        
        if self.muni_filter_enabled_var.get() and muni_name in self.muni_map:
            allowed_meshes = self.muni_map[muni_name]
            filtered_metadata = [
                m for m in self.scanned_metadata_cache
                if m['mesh_code'].replace("-", "") in allowed_meshes
            ]
            is_filtered = True

        # Update recommended CRS dynamically based on filtered metadata
        if filtered_metadata:
            lats = [m['lat_min'] for m in filtered_metadata if m.get('lat_min') is not None]
            lons = [m['lon_min'] for m in filtered_metadata if m.get('lon_min') is not None]
            if lats and lons:
                rep_lat = sum(lats) / len(lats)
                rep_lon = sum(lons) / len(lons)
                zone = estimate_jgd_zone(rep_lat, rep_lon)
                is_jgd2000 = any(m.get('is_jgd2000', False) for m in filtered_metadata)
                
                if is_jgd2000:
                    recommended_epsg = 2442 + zone
                    crs_name = f"EPSG:{recommended_epsg} (JGD2000 / 平面直交座標第{zone}系) [自動判定・推奨]"
                else:
                    recommended_epsg = 6668 + zone
                    crs_name = f"EPSG:{recommended_epsg} (JGD2011 / 平面直交座標第{zone}系) [自動判定・推奨]"
                
                current_values = list(self.base_crs_values)
                current_values.insert(0, crs_name)
                self.crs_combo.config(values=current_values)
                
                curr_sel = self.crs_var.get()
                if "[自動判定・推奨]" in curr_sel or not curr_sel:
                    self.crs_var.set(crs_name)

        filtered_count = len(filtered_metadata)
        if filtered_count == 0:
            self.size_estimate_var.set(f"対象範囲外: 選択した市区町村 ({muni_name}) の範囲内にDEMファイルが見つかりません。")
            self.size_estimate_label.config(foreground="red")
            return

        if not self.merge_var.get():
            if is_filtered:
                self.size_estimate_var.set(f"個別出力: 選択した市区町村 ({muni_name}) のメッシュのみ出力します (出力数: {filtered_count} / 総ファイル数: {total_files} 件)。")
            else:
                self.size_estimate_var.set(f"各ファイルを個別にGeoTIFF出力します (ファイル数: {total_files}件)。")
            self.size_estimate_label.config(foreground="black")
            return

        crs_selection = self.crs_var.get()
        match = re.search(r'EPSG:(\d+)', crs_selection)
        target_epsg = int(match.group(1)) if match else 6697

        try:
            xs = []
            ys = []
            
            for m in filtered_metadata:
                src_epsg = 4612 if m['is_jgd2000'] else 6697
                left, bottom, right, top = transform_bounds(
                    f"EPSG:{src_epsg}", f"EPSG:{target_epsg}",
                    m['lon_min'], m['lat_min'], m['lon_max'], m['lat_max']
                )
                xs.extend([left, right])
                ys.extend([bottom, top])
                
            global_left = min(xs)
            global_right = max(xs)
            global_bottom = min(ys)
            global_top = max(ys)
            
            m0 = filtered_metadata[0]
            src_epsg0 = 4612 if m0['is_jgd2000'] else 6697
            l0, b0, r0, t0 = transform_bounds(
                f"EPSG:{src_epsg0}", f"EPSG:{target_epsg}",
                m0['lon_min'], m0['lat_min'], m0['lon_max'], m0['lat_max']
            )
            dx_target = (r0 - l0) / m0['width']
            dy_target = (t0 - b0) / m0['height']
            
            merged_width = max(1, int(round((global_right - global_left) / dx_target)))
            merged_height = max(1, int(round((global_top - global_bottom) / dy_target)))
            
            predicted_bytes = merged_width * merged_height * 4
            size_mb = predicted_bytes / (1024 * 1024)
            
            if size_mb >= 1024:
                size_str = f"{size_mb / 1024:.2f} GB"
            else:
                size_str = f"{size_mb:.1f} MB"
                
            comp_min = size_mb * 0.1
            comp_max = size_mb * 0.25
            
            if comp_min >= 1024:
                comp_str = f"{comp_min/1024:.2f}〜{comp_max/1024:.2f} GB"
            else:
                comp_str = f"{comp_min:.1f}〜{comp_max:.1f} MB"
                
            info_text = f"結合後予測サイズ: 未圧縮 {size_str} / LZW圧縮後 約 {comp_str} ({merged_width} × {merged_height} px)"
            if is_filtered:
                info_text += f"\n({muni_name}の範囲: {filtered_count}/{total_files} メッシュを結合)"
            
            if size_mb > 4096:
                self.size_estimate_label.config(foreground="red")
                self.size_estimate_var.set(info_text + "\n⚠️ 警告: 結合サイズが極端に大きいため、処理に時間がかかる、またはメモリが不足する可能性があります。")
            else:
                self.size_estimate_label.config(foreground="green")
                self.size_estimate_var.set(info_text)
                
        except Exception as e:
            self.size_estimate_var.set(f"結合後の予測サイズ: 計算エラー ({str(e)})")
            self.size_estimate_label.config(foreground="red")

    def browse_input(self):
        dir_selected = filedialog.askdirectory(title="入力フォルダの選択")
        if dir_selected:
            self.input_dir_var.set(os.path.normpath(dir_selected))

    def browse_output(self):
        if self.merge_var.get():
            initial_dir = self.output_dir_var.get().strip() or self.input_dir_var.get().strip() or os.getcwd()
            if initial_dir and os.path.isdir(initial_dir):
                pass
            elif initial_dir and os.path.isfile(initial_dir):
                initial_dir = os.path.dirname(initial_dir)
            else:
                initial_dir = os.getcwd()
                
            initial_file = self.output_filename_var.get().strip() or "dem_merged.tif"
            
            file_selected = filedialog.asksaveasfilename(
                title="出力ファイルの保存先を指定",
                initialdir=initial_dir,
                initialfile=initial_file,
                filetypes=[("GeoTIFF Files", "*.tif;*.tiff"), ("All Files", "*.*")],
                defaultextension=".tif"
            )
            if file_selected:
                file_selected = os.path.normpath(file_selected)
                self.output_dir_var.set(os.path.dirname(file_selected))
                self.output_filename_var.set(os.path.basename(file_selected))
        else:
            dir_selected = filedialog.askdirectory(title="出力フォルダの選択")
            if dir_selected:
                self.output_dir_var.set(os.path.normpath(dir_selected))

    def browse_muni_csv(self):
        file_selected = filedialog.askopenfilename(
            title="市区町村別メッシュCSVの選択",
            filetypes=[("CSV Files", "*.csv"), ("All Files", "*.*")]
        )
        if file_selected:
            self.muni_csv_var.set(os.path.normpath(file_selected))

    def open_download_url(self):
        import webbrowser
        webbrowser.open("https://www.stat.go.jp/data/mesh/index.html")

    def open_gsi_download_url(self):
        import webbrowser
        webbrowser.open("https://service.gsi.go.jp/kiban/app/map/?search=base")

    def on_muni_csv_changed(self, *args):
        csv_path = self.muni_csv_var.get().strip()
        if not csv_path or not os.path.isfile(csv_path):
            self.muni_map = {}
            self.mesh_to_muni = {}
            self.muni_combo.config(values=[], state="disabled")
            self.muni_filter_check.config(state="disabled")
            self.muni_filter_enabled_var.set(False)
            self.update_size_estimate()
            return
            
        try:
            self.load_municipality_csv(csv_path)
            if self.muni_map:
                muni_names = sorted(list(self.muni_map.keys()))
                self.muni_combo.config(values=muni_names, state="readonly")
                self.muni_filter_check.config(state="normal")
                self.muni_combo.current(0)
                self.muni_filter_enabled_var.set(True)
                self.log(f"CSV読込成功: {len(self.muni_map)} 市区町村のデータを読み込みました。")
            else:
                self.log("CSV読込警告: 有効な市区町村データが見つかりませんでした。", "WARNING")
        except Exception as e:
            self.log(f"CSV読込エラー: {str(e)}", "ERROR")
            messagebox.showerror("エラー", f"CSVファイルの読み込みに失敗しました:\n{str(e)}")
            
        self.update_size_estimate()

    def load_municipality_csv(self, csv_path):
        import csv
        encodings = ['cp932', 'shift_jis', 'utf-8', 'utf-8-sig']
        content = None
        for enc in encodings:
            try:
                with open(csv_path, 'r', encoding=enc) as f:
                    content = f.read()
                break
            except Exception:
                continue
                
        if content is None:
            raise ValueError("CSVファイルの文字コードを自動判定できませんでした。Shift_JISまたはUTF-8であることをご確認ください。")
            
        lines = content.splitlines()
        reader = csv.reader(lines)
        
        self.muni_map = {}
        self.mesh_to_muni = {}
        for row in reader:
            if not row or len(row) < 3:
                continue
                
            code_candidate = row[0].strip().replace('"', '').replace("'", "")
            name_candidate = row[1].strip().replace('"', '').replace("'", "")
            mesh_candidate = row[2].strip().replace('"', '').replace("'", "").replace("-", "")
            
            # Skip headers
            if "市区町村" in name_candidate or "メッシュ" in mesh_candidate:
                continue
                
            # Must be 8 digit code
            if not mesh_candidate.isdigit() or len(mesh_candidate) != 8:
                continue
                
            code_and_name = f"{code_candidate} ({name_candidate})"
            if code_and_name not in self.muni_map:
                self.muni_map[code_and_name] = set()
            self.muni_map[code_and_name].add(mesh_candidate)
            self.mesh_to_muni[mesh_candidate] = code_and_name

    def get_muni_for_mesh(self, mesh_code):
        if not hasattr(self, 'mesh_to_muni') or not self.mesh_to_muni:
            return None
            
        clean_mesh = mesh_code.replace("-", "")
        
        # 8桁で直接一致
        if clean_mesh in self.mesh_to_muni:
            return self.mesh_to_muni[clean_mesh]
            
        # 6桁（2次メッシュ）などで前方一致
        if len(clean_mesh) >= 6:
            prefix = clean_mesh[:6]
            for m, muni in self.mesh_to_muni.items():
                if m.startswith(prefix):
                    return muni
                    
        # 4桁（1次メッシュ）で前方一致
        if len(clean_mesh) >= 4:
            prefix = clean_mesh[:4]
            for m, muni in self.mesh_to_muni.items():
                if m.startswith(prefix):
                    return muni
                    
        return None

    def get_default_merged_filename(self):
        input_dir = self.input_dir_var.get().strip()
        input_folder_name = os.path.basename(os.path.abspath(input_dir)) if input_dir else "dem"
        if not input_folder_name:
            input_folder_name = "dem"
            
        if self.muni_filter_enabled_var.get():
            muni_name = self.muni_select_var.get().strip()
            if muni_name:
                match_muni = re.match(r'^(\d{5})', muni_name)
                if match_muni:
                    return f"{match_muni.group(1)}_dem_merged.tif"
                muni_en = romanize_municipality(muni_name)
                return f"{input_folder_name}_merged_{muni_en}.tif"
                
        # フィルターが無効でも、スキャンされた全ファイルが同じ市町村に属する場合
        if self.scanned_metadata_cache:
            muni_names = set()
            for m in self.scanned_metadata_cache:
                mesh = m.get('mesh_code', '')
                if mesh:
                    muni = self.get_muni_for_mesh(mesh)
                    if muni:
                        muni_names.add(muni)
            if len(muni_names) == 1:
                muni_name = list(muni_names)[0]
                match_muni = re.match(r'^(\d{5})', muni_name)
                if match_muni:
                    return f"{match_muni.group(1)}_dem_merged.tif"
                muni_en = romanize_municipality(muni_name)
                return f"{input_folder_name}_merged_{muni_en}.tif"
                
        return f"{input_folder_name}_merged.tif"

    def on_muni_selected(self, event=None):
        self.update_size_estimate()
        self.update_merged_filename_if_default()

    def on_muni_filter_toggled(self):
        self.update_size_estimate()
        self.update_merged_filename_if_default()

    def update_output_filename_state(self):
        if not hasattr(self, 'output_filename_entry'):
            return
        if self.merge_var.get():
            self.output_filename_entry.config(state="normal")
        else:
            self.output_filename_entry.config(state="disabled")

    def toggle_fill_options_state(self):
        if not hasattr(self, 'fill_method_combo'):
            return
        if self.fill_nulls_var.get():
            self.fill_method_combo.config(state="readonly")
        else:
            self.fill_method_combo.config(state="disabled")

    def update_merged_filename_if_default(self):
        if not self.merge_var.get():
            return
        curr = self.output_filename_var.get().strip()
        default_name = self.get_default_merged_filename()
        if not curr or curr == "dem_merged.tif" or curr.endswith("_merged.tif") or "_merged_" in curr:
            self.output_filename_var.set(default_name)

    def log(self, message, level="INFO"):
        self.log_text.config(state=tk.NORMAL)
        tag = level.lower()

        # Add tags for colored logging
        if tag not in self.log_text.tag_names():
            if tag == "error":
                self.log_text.tag_config("error", foreground="red")
            elif tag == "warning":
                self.log_text.tag_config("warning", foreground="orange")
            elif tag == "success":
                self.log_text.tag_config("success", foreground="green")

        self.log_text.insert(tk.END, f"[{level}] {message}\n", tag)
        self.log_text.see(tk.END)
        self.log_text.config(state=tk.DISABLED)

    def start_conversion(self):
        if self.processing:
            return

        input_dir = self.input_dir_var.get().strip()
        output_dir = self.output_dir_var.get().strip()

        if not input_dir or not os.path.isdir(input_dir):
            messagebox.showerror("エラー", "有効な入力フォルダを選択してください。")
            return
        if not output_dir:
            messagebox.showerror("エラー", "有効な出力フォルダを選択してください。")
            return

        if self.muni_filter_enabled_var.get():
            muni_name = self.muni_select_var.get().strip()
            if not muni_name or muni_name not in self.muni_map:
                messagebox.showerror("エラー", "有効な市区町村を選択してください。")
                return

            # 事前チェック: 選択された市区町村に合致するDEMメッシュファイルが存在するか確認
            if self.scanned_metadata_cache:
                allowed_meshes = self.muni_map[muni_name]
                matching_count = sum(
                    1 for m in self.scanned_metadata_cache
                    if m.get('mesh_code', '').replace("-", "") in allowed_meshes
                )
                if matching_count == 0:
                    messagebox.showwarning(
                        "対象外の市区町村",
                        f"選択した市区町村 ({muni_name}) の範囲内に対象となるDEMファイルが存在しません。\n"
                        f"対象市区町村を選択し直すか、フィルターを解除してください。"
                    )
                    return

        try:
            os.makedirs(output_dir, exist_ok=True)
        except Exception as e:
            messagebox.showerror("エラー", f"出力フォルダを作成できませんでした:\n{str(e)}")
            return

        self.processing = True
        self.start_btn.config(state=tk.DISABLED)
        self.input_btn.config(state=tk.DISABLED)
        self.output_btn.config(state=tk.DISABLED)
        self.crs_combo.config(state=tk.DISABLED)
        self.muni_csv_btn.config(state=tk.DISABLED)
        self.muni_combo.config(state=tk.DISABLED)
        self.muni_filter_check.config(state=tk.DISABLED)

        self.log_text.config(state=tk.NORMAL)
        self.log_text.delete("1.0", tk.END)
        self.log_text.config(state=tk.DISABLED)
        self.progress_var.set(0)

        # Run conversion in background thread to avoid freezing GUI
        threading.Thread(target=self.run_conversion_thread, args=(input_dir, output_dir), daemon=True).start()

    def run_conversion_thread(self, input_dir, output_dir):
        success_count = 0
        error_count = 0
        skipped_count = 0
        total_files = 0
        should_merge = self.merge_var.get()
        merged_filename = "merged.tif"
        temp_dir = None

        def log_msg(msg, level="INFO"):
            self.log(msg, level)

        try:
            log_msg("変換処理を開始します。")
            log_msg(f"入力フォルダ: {input_dir}")
            log_msg(f"出力フォルダ: {output_dir}")

            crs_selection = self.crs_var.get()
            match = re.search(r'EPSG:(\d+)', crs_selection)
            if match:
                default_epsg = int(match.group(1))
            else:
                default_epsg = 6697

            log_msg(f"デフォルト座標系 (EPSG): {default_epsg}")

            # Scan for target files
            all_files = []
            for root_dir, _, filenames in os.walk(input_dir):
                for f in filenames:
                    ext = os.path.splitext(f)[1].lower()
                    if ext in ['.xml', '.zip']:
                        all_files.append(os.path.join(root_dir, f))

            total_files = len(all_files)
            if total_files == 0:
                log_msg("入力フォルダ内に XML または ZIP ファイルが見つかりませんでした。", "WARNING")
                self.after(0, lambda: messagebox.showinfo("お知らせ", "処理対象のファイルが見つかりませんでした。"))
                return

            log_msg(f"処理対象ファイルを検出しました: {total_files} 件")

            # Features list for GeoJSON
            success_features = []
            temp_tiff_paths = []

            # Determine final merged filename
            if should_merge:
                merged_filename = self.output_filename_var.get().strip()
                if not merged_filename:
                    merged_filename = self.get_default_merged_filename()
                if not merged_filename.lower().endswith(('.tif', '.tiff')):
                    merged_filename += ".tif"

            # Create temporary directory if merging
            work_dir = output_dir
            if should_merge:
                temp_dir = tempfile.TemporaryDirectory()
                work_dir = temp_dir.name
                log_msg(f"結合モード: 一時作業ディレクトリを作成しました: {work_dir}")

            # Determine filter mode
            should_filter = self.muni_filter_enabled_var.get()
            muni_name = self.muni_select_var.get().strip()
            allowed_meshes = self.muni_map.get(muni_name, set()) if should_filter else set()
            
            if should_filter:
                log_msg(f"市区町村フィルター有効: {muni_name} のメッシュのみ変換します。")

            # Process each file sequentially
            for idx, file_path in enumerate(all_files):
                basename = os.path.basename(file_path)
                log_msg(f"[{idx+1}/{total_files}] ファイルを処理中: {basename}")

                progress_percent = (idx / total_files) * 90  # Save 10% for merge/export
                self.progress_var.set(progress_percent)

                ext = os.path.splitext(file_path)[1].lower()
                if ext == '.xml':
                    try:
                        mesh_code = extract_mesh_code(basename)
                        if should_filter and mesh_code.replace("-", "") not in allowed_meshes:
                            self.log(f"スキップ: {basename} (市区町村 {muni_name} 範囲外)")
                            skipped_count += 1
                            continue

                        with open(file_path, 'r', encoding='utf-8', errors='ignore') as f:
                            xml_content = f.read()

                        muni_suffix = ""
                        muni_name_for_file = self.get_muni_for_mesh(mesh_code)
                        if muni_name_for_file:
                            match_muni = re.match(r'^(\d{5})', muni_name_for_file)
                            if match_muni:
                                muni_suffix = f"_{match_muni.group(1)}"
                            else:
                                clean_name = re.sub(r'^\d+\s*\(?', '', muni_name_for_file).replace(')', '').strip()
                                muni_suffix = f"_{clean_name}"

                        out_name = os.path.splitext(basename)[0] + muni_suffix + ".tif"
                        out_path = os.path.join(work_dir, out_name)

                        # If merging, we convert to geographic JGD2011 (EPSG:6697) first to avoid seam gaps,
                        # and reproject the merged raster at the end.
                        conv_epsg = 6697 if should_merge else default_epsg
                        bounds = self.convert_xml_content(xml_content, out_path, conv_epsg)
                        log_msg(f"変換完了: {out_name}", "SUCCESS")
                        success_count += 1
                        
                        success_features.append({
                            'filename': out_name if not should_merge else merged_filename,
                            'mesh_code': mesh_code,
                            'lon_min': bounds[0], 'lat_min': bounds[1],
                            'lon_max': bounds[2], 'lat_max': bounds[3]
                        })
                        if should_merge:
                            temp_tiff_paths.append(out_path)
                    except Exception as e:
                        err_msg = f"ファイル {basename} の変換中にエラーが発生しました:\n{traceback.format_exc()}"
                        log_msg(err_msg, "ERROR")
                        error_count += 1

                elif ext == '.zip':
                    try:
                        with zipfile.ZipFile(file_path, 'r') as zf:
                            xml_members = [name for name in zf.namelist() if name.lower().endswith('.xml')]

                            if not xml_members:
                                log_msg(f"ZIP内にXMLファイルが含まれていません: {basename}", "WARNING")
                                skipped_count += 1
                                continue

                            for member_name in xml_members:
                                member_basename = os.path.basename(member_name)
                                mesh_code = extract_mesh_code(member_basename)
                                
                                if should_filter and mesh_code.replace("-", "") not in allowed_meshes:
                                    self.log(f"スキップ: ZIP内ファイル {member_basename} (市区町村 {muni_name} 範囲外)")
                                    skipped_count += 1
                                    continue

                                log_msg(f"  ZIP内ファイルを処理中: {member_basename}")

                                xml_content = zf.read(member_name).decode('utf-8', errors='ignore')

                                muni_suffix = ""
                                muni_name_for_file = self.get_muni_for_mesh(mesh_code)
                                if muni_name_for_file:
                                    match_muni = re.match(r'^(\d{5})', muni_name_for_file)
                                    if match_muni:
                                        muni_suffix = f"_{match_muni.group(1)}"
                                    else:
                                        clean_name = re.sub(r'^\d+\s*\(?', '', muni_name_for_file).replace(')', '').strip()
                                        muni_suffix = f"_{clean_name}"

                                out_name = os.path.splitext(member_basename)[0] + muni_suffix + ".tif"
                                out_path = os.path.join(work_dir, out_name)

                                # If merging, we convert to geographic JGD2011 (EPSG:6697) first to avoid seam gaps,
                                # and reproject the merged raster at the end.
                                conv_epsg = 6697 if should_merge else default_epsg
                                bounds = self.convert_xml_content(xml_content, out_path, conv_epsg)
                                log_msg(f"  変換完了: {out_name}", "SUCCESS")
                                success_count += 1
                                
                                success_features.append({
                                    'filename': out_name if not should_merge else merged_filename,
                                    'mesh_code': mesh_code,
                                    'lon_min': bounds[0], 'lat_min': bounds[1],
                                    'lon_max': bounds[2], 'lat_max': bounds[3]
                                })
                                if should_merge:
                                    temp_tiff_paths.append(out_path)
                    except Exception as e:
                        err_msg = f"ZIPファイル {basename} の処理中にエラーが発生しました:\n{traceback.format_exc()}"
                        log_msg(err_msg, "ERROR")
                        error_count += 1

            # Perform raster merging if enabled
            if should_merge and success_count > 0:
                self.progress_var.set(90)
                log_msg("--- 一時ファイルの結合処理を開始します ---")
                try:
                    merged_filepath = os.path.join(output_dir, merged_filename)
                    src_datasets = [rasterio.open(fp) for fp in temp_tiff_paths]
                    
                    log_msg("ラスターデータを結合中 (rasterio.merge.merge)...")
                    merged_data, merged_transform = rio_merge(src_datasets, nodata=-9999.0)
                    
                    # Close source datasets
                    for ds in src_datasets:
                        ds.close()

                    # Reproject the merged dataset to the target CRS to ensure seamless boundaries
                    if default_epsg == 6697:
                        dst_data = merged_data
                        dst_transform = merged_transform
                        dst_width = merged_data.shape[2]
                        dst_height = merged_data.shape[1]
                    else:
                        log_msg(f"結合データを対象座標系 (EPSG:{default_epsg}) へ再投影中...")
                        dst_crs = f"EPSG:{default_epsg}"
                        src_crs = "EPSG:6697"
                        
                        # Get geographic bounds of merged data
                        left = merged_transform.c
                        top = merged_transform.f
                        right = left + merged_transform.a * merged_data.shape[2]
                        bottom = top + merged_transform.e * merged_data.shape[1]
                        
                        dst_transform, dst_width, dst_height = calculate_default_transform(
                            src_crs, dst_crs, 
                            merged_data.shape[2], merged_data.shape[1],
                            left=left, bottom=bottom, right=right, top=top
                        )
                        
                        dst_data = np.full((1, dst_height, dst_width), -9999.0, dtype=np.float32)
                        
                        reproject(
                            source=merged_data[0],
                            destination=dst_data[0],
                            src_transform=merged_transform,
                            src_crs=src_crs,
                            dst_transform=dst_transform,
                            dst_crs=dst_crs,
                            resampling=Resampling.bilinear,
                            src_nodata=-9999.0,
                            dst_nodata=-9999.0
                        )
                    
                    # Update metadata for output
                    meta = {
                        "driver": "GTiff",
                        "dtype": "float32",
                        "nodata": -9999.0,
                        "width": dst_width,
                        "height": dst_height,
                        "count": 1,
                        "crs": f"EPSG:{default_epsg}",
                        "transform": dst_transform,
                        "compress": "lzw"
                    }
                    
                    # Null values hole-fill logic for merged data
                    if self.fill_nulls_var.get():
                        fill_mode = self.fill_method_var.get()
                        log_msg(f"Null値（水部・計測範囲外）の穴埋め処理を実行中 ({fill_mode})...")
                        if "Zero Fill" in fill_mode:
                            dst_data[dst_data == -9999.0] = 0.0
                        elif "Interpolate" in fill_mode:
                            try:
                                from rasterio.fill import fillnodata
                                mask = (dst_data[0] != -9999.0)
                                filled_layer = fillnodata(dst_data[0], mask, max_search_distance=100.0)
                                dst_data[0] = filled_layer
                            except Exception as ex:
                                log_msg(f"Null値補完中にエラーが発生しました: {ex}", "WARNING")


                    # Write merged GeoTIFF
                    log_msg(f"結合ファイルを書き込み中: {merged_filename}")
                    with rasterio.open(merged_filepath, "w", **meta) as dst:
                        dst.write(dst_data[0], 1)
                        
                    log_msg(f"結合完了: {merged_filename}", "SUCCESS")
                except Exception as e:
                    err_msg = f"ファイルの結合処理中にエラーが発生しました:\n{traceback.format_exc()}"
                    log_msg(err_msg, "ERROR")
                    error_count += 1

            # Output GeoJSON, JS, and HTML viewer
            if success_count > 0:
                self.progress_var.set(95)
                log_msg("--- 図郭・メタデータ (GeoJSON, HTML) の出力処理を開始します ---")
                
                # Build GeoJSON features
                geojson_features = []
                
                # If merged, add merged polygon at the top
                if should_merge and success_count > 0:
                    global_lon_min = min(sf['lon_min'] for sf in success_features)
                    global_lat_min = min(sf['lat_min'] for sf in success_features)
                    global_lon_max = max(sf['lon_max'] for sf in success_features)
                    global_lat_max = max(sf['lat_max'] for sf in success_features)
                    
                    merged_feat = {
                        "type": "Feature",
                        "geometry": {
                            "type": "Polygon",
                            "coordinates": [[
                                [global_lon_min, global_lat_min],
                                [global_lon_max, global_lat_min],
                                [global_lon_max, global_lat_max],
                                [global_lon_min, global_lat_max],
                                [global_lon_min, global_lat_min]
                            ]]
                        },
                        "properties": {
                            "filename": merged_filename,
                            "mesh_code": "Merged (結合ファイル)",
                            "type": "merged_file"
                        }
                    }
                    geojson_features.append(merged_feat)
                    
                # Add individual source mesh features
                for sf in success_features:
                    feat = {
                        "type": "Feature",
                        "geometry": {
                            "type": "Polygon",
                            "coordinates": [[
                                [sf['lon_min'], sf['lat_min']],
                                [sf['lon_max'], sf['lat_min']],
                                [sf['lon_max'], sf['lat_max']],
                                [sf['lon_min'], sf['lat_max']],
                                [sf['lon_min'], sf['lat_min']]
                            ]]
                        },
                        "properties": {
                            "filename": sf['filename'],
                            "mesh_code": sf['mesh_code'],
                            "type": "source_mesh"
                        }
                    }
                    geojson_features.append(feat)
                    
                geojson_data = {
                    "type": "FeatureCollection",
                    "features": geojson_features
                }
                
                # Write dem_layout.geojson
                geojson_path = os.path.join(output_dir, "dem_layout.geojson")
                with open(geojson_path, "w", encoding="utf-8") as f:
                    json.dump(geojson_data, f, ensure_ascii=False, indent=2)
                log_msg(f"GeoJSONを出力しました: dem_layout.geojson")
                
                # Write dem_layout.js
                js_path = os.path.join(output_dir, "dem_layout.js")
                with open(js_path, "w", encoding="utf-8") as f:
                    f.write(f"const demLayoutData = {json.dumps(geojson_data, ensure_ascii=False, indent=2)};\n")
                log_msg(f"JavaScript用データを出力しました: dem_layout.js")
                
                # Write map.html
                html_path = os.path.join(output_dir, "map.html")
                with open(html_path, "w", encoding="utf-8") as f:
                    f.write(MAP_HTML_TEMPLATE)
                log_msg(f"Leaflet地図ビューアを出力しました: map.html")

        except Exception as e:
            err_msg = f"変換処理全体で予期せぬエラーが発生しました:\n{traceback.format_exc()}"
            self.log(err_msg, "ERROR")
            error_count += 1
        finally:
            if temp_dir:
                try:
                    temp_dir.cleanup()
                    log_msg("一時作業ディレクトリを削除しました。")
                except Exception:
                    pass
            
            # Reset UI and notify user safely on GUI thread
            try:
                self.after(0, lambda: self.progress_var.set(100))
                self.after(0, self.finish_conversion)
                if success_count > 0:
                    self.after(0, lambda: self.show_completion_dialog(
                        output_dir, success_count, error_count, skipped_count, merged_filename, should_merge
                    ))
                elif total_files > 0:
                    self.after(0, lambda: messagebox.showerror(
                        "エラー", "変換に成功したファイルがありませんでした。選択した市区町村とメッシュが一致しているか、処理ログをご確認ください。"
                    ))
            except Exception:
                # Fallback for headless testing
                self.progress_var.set(100)
                self.finish_conversion()

    def convert_xml_content(self, xml_content, output_filepath, default_epsg):
        root = ET.fromstring(xml_content)

        FGD_NS = '{http://fgd.gsi.go.jp/spec/2008/FGD_GMLSchema}'
        GML_NS = '{http://www.opengis.net/gml/3.2}'

        dem_elem = root.find(f'.//{FGD_NS}DEM')
        if dem_elem is None:
            dem_elem = root.find('.//DEM')
            if dem_elem is None:
                raise ValueError("XML内に DEM 要素が見つかりません。")

        coverage_elem = dem_elem.find(f'.//{FGD_NS}coverage')
        if coverage_elem is None:
            coverage_elem = dem_elem.find('.//coverage')
            if coverage_elem is None:
                raise ValueError("DEM要素内に coverage 要素が見つかりません。")

        envelope = coverage_elem.find(f'.//{GML_NS}Envelope')
        if envelope is None:
            raise ValueError("gml:Envelope が見つかりません。")

        srs_name = envelope.get('srsName', '')

        lower_corner = envelope.find(f'.//{GML_NS}lowerCorner')
        upper_corner = envelope.find(f'.//{GML_NS}upperCorner')
        if lower_corner is None or upper_corner is None:
            raise ValueError("lowerCorner または upperCorner が見つかりません。")

        grid_envelope = coverage_elem.find(f'.//{GML_NS}GridEnvelope')
        if grid_envelope is None:
            raise ValueError("gml:GridEnvelope が見つかりません。")

        low_elem = grid_envelope.find(f'.//{GML_NS}low')
        high_elem = grid_envelope.find(f'.//{GML_NS}high')
        if low_elem is None or high_elem is None:
            raise ValueError("low または high が見つかりません。")

        grid_func = coverage_elem.find(f'.//{GML_NS}GridFunction')
        start_point_elem = grid_func.find(f'.//{GML_NS}startPoint') if grid_func is not None else None
        start_point_text = start_point_elem.text if start_point_elem is not None else "0 0"

        tuple_list_elem = coverage_elem.find(f'.//{GML_NS}tupleList')
        if tuple_list_elem is None:
            raise ValueError("gml:tupleList が見つかりません。")

        lower_text = lower_corner.text
        upper_text = upper_corner.text
        low_text = low_elem.text
        high_text = high_elem.text
        tuple_list_text = tuple_list_elem.text

        # Extract envelope corners
        c1_low, c2_low = map(float, lower_text.strip().split())
        c1_up, c2_up = map(float, upper_text.strip().split())

        # Safely identify latitude and longitude
        # Since longitude in Japan is > 100 and latitude is < 50, the larger coordinate is always longitude.
        if c1_low > c2_low:
            lon_min, lat_min = c1_low, c2_low
            lon_max, lat_max = c1_up, c2_up
        else:
            lat_min, lon_min = c1_low, c2_low
            lat_max, lon_max = c1_up, c2_up

        low_x, low_y = map(int, low_text.strip().split())
        high_x, high_y = map(int, high_text.strip().split())

        width = high_x - low_x + 1
        height = high_y - low_y + 1

        # Calculate grid cell sizes
        dx = (lon_max - lon_min) / width
        dy = (lat_max - lat_min) / height

        # Parse start point relative to low
        sp_parts = start_point_text.strip().split()
        start_x = int(sp_parts[0]) if len(sp_parts) >= 1 else 0
        start_y = int(sp_parts[1]) if len(sp_parts) >= 2 else 0

        # Pre-allocate array filled with NoData
        data = np.full((height, width), -9999.0, dtype=np.float32)

        if tuple_list_text:
            lines = tuple_list_text.strip().split()

            x_offset = start_x - low_x
            y_offset = start_y - low_y

            x, y = x_offset, y_offset
            max_x = high_x - low_x
            max_y = high_y - low_y

            for line in lines:
                parts = line.split(',')
                if len(parts) >= 2:
                    val_str = parts[1]
                    try:
                        val = float(val_str)
                        if val <= -9999.0:
                            data[y, x] = -9999.0
                        else:
                            data[y, x] = val
                    except ValueError:
                        data[y, x] = -9999.0
                x += 1
                if x > max_x:
                    x = 0
                    y += 1
                    if y > max_y:
                        break

        # Determine source CRS (from XML)
        src_epsg = 6697
        if 'jgd2011' in srs_name.lower():
            src_epsg = 6697
        elif 'jgd2000' in srs_name.lower():
            src_epsg = 4612
        src_crs = f"EPSG:{src_epsg}"

        # Determine target CRS (from user selection)
        dst_epsg = default_epsg
        dst_crs = f"EPSG:{dst_epsg}"

        # Origin of source data (latitude/longitude)
        src_transform = from_origin(lon_min, lat_max, dx, dy)

        if src_epsg == dst_epsg:
            # No reprojection needed
            out_crs = src_crs
            out_transform = src_transform
            out_width = width
            out_height = height
            out_data = data
        else:
            # Reprojection needed
            
            # Calculate output transform and dimensions
            out_transform, out_width, out_height = calculate_default_transform(
                src_crs, dst_crs, width, height,
                left=lon_min, bottom=lat_min, right=lon_max, top=lat_max
            )
            
            out_data = np.full((out_height, out_width), -9999.0, dtype=np.float32)
            
            reproject(
                source=data,
                destination=out_data,
                src_transform=src_transform,
                src_crs=src_crs,
                dst_transform=out_transform,
                dst_crs=dst_crs,
                resampling=Resampling.bilinear,
                src_nodata=-9999.0,
                dst_nodata=-9999.0
            )
            out_crs = dst_crs

        # Null values hole-fill logic for individual data
        if self.fill_nulls_var.get():
            fill_mode = self.fill_method_var.get()
            if "Zero Fill" in fill_mode:
                out_data[out_data == -9999.0] = 0.0
            elif "Interpolate" in fill_mode:
                try:
                    from rasterio.fill import fillnodata
                    mask = (out_data != -9999.0)
                    out_data = fillnodata(out_data, mask, max_search_distance=100.0)
                except Exception as ex:
                    self.log(f"Null値補完中にエラーが発生しました: {ex}", "WARNING")

        # Write data to GeoTIFF using rasterio with LZW compression
        with rasterio.open(
            output_filepath,
            'w',
            driver='GTiff',
            height=out_height,
            width=out_width,
            count=1,
            dtype='float32',
            crs=out_crs,
            transform=out_transform,
            nodata=-9999.0,
            compress='lzw'
        ) as dst:
            dst.write(out_data, 1)

        return lon_min, lat_min, lon_max, lat_max

    def finish_conversion(self):
        self.processing = False
        self.start_btn.config(state=tk.NORMAL)
        self.input_btn.config(state=tk.NORMAL)
        self.output_btn.config(state=tk.NORMAL)
        self.crs_combo.config(state="readonly")
        self.muni_csv_btn.config(state=tk.NORMAL)
        if hasattr(self, 'muni_map') and self.muni_map:
            self.muni_combo.config(state="readonly")
            self.muni_filter_check.config(state="normal")

    def show_completion_dialog(self, output_dir, success_count, error_count, skipped_count, merged_filename, should_merge):
        dialog = tk.Toplevel(self)
        dialog.title("処理完了 (Processing Completed)")
        dialog.geometry("520x280")
        dialog.resizable(False, False)
        dialog.transient(self)
        dialog.grab_set()
        
        dialog.update_idletasks()
        width = dialog.winfo_width()
        height = dialog.winfo_height()
        x = self.winfo_x() + (self.winfo_width() // 2) - (width // 2)
        y = self.winfo_y() + (self.winfo_height() // 2) - (height // 2)
        dialog.geometry(f"+{x}+{y}")

        main_frame = ttk.Frame(dialog, padding="20")
        main_frame.pack(fill=tk.BOTH, expand=True)

        # Title
        title_label = ttk.Label(main_frame, text="🎉 変換処理が完了しました！", font=("Helvetica", 12, "bold"), foreground="green")
        title_label.pack(anchor=tk.W, pady=(0, 10))

        # Stats
        stats_text = f"成功: {success_count}件"
        if error_count > 0:
            stats_text += f" / エラー: {error_count}件"
        if skipped_count > 0:
            stats_text += f" / スキップ: {skipped_count}件"
            
        ttk.Label(main_frame, text=stats_text, font=("Helvetica", 10)).pack(anchor=tk.W, pady=(0, 15))

        # Path input
        ttk.Label(main_frame, text="出力先フォルダ (Output Directory):", font=("Helvetica", 9, "bold")).pack(anchor=tk.W)
        
        path_frame = ttk.Frame(main_frame)
        path_frame.pack(fill=tk.X, pady=(2, 15))
        
        path_entry = ttk.Entry(path_frame, font=("Consolas", 9))
        path_entry.insert(0, os.path.abspath(output_dir))
        path_entry.config(state="readonly")
        path_entry.pack(fill=tk.X, side=tk.LEFT, expand=True)

        # Actions
        def open_folder():
            import subprocess
            abs_dir = os.path.abspath(output_dir)
            if sys.platform == 'win32':
                os.startfile(abs_dir)
            elif sys.platform == 'darwin':
                subprocess.Popen(['open', abs_dir])
            else:
                subprocess.Popen(['xdg-open', abs_dir])

        def open_map():
            import webbrowser
            html_path = os.path.abspath(os.path.join(output_dir, "map.html"))
            if os.path.exists(html_path):
                webbrowser.open(f"file:///{html_path.replace(os.sep, '/')}")

        btn_frame = ttk.Frame(main_frame)
        btn_frame.pack(fill=tk.X, pady=(10, 0))

        ttk.Button(btn_frame, text="フォルダを開く", command=open_folder).pack(side=tk.LEFT, padx=(0, 10))
        
        html_path = os.path.join(output_dir, "map.html")
        if os.path.exists(html_path):
            ttk.Button(btn_frame, text="地図をブラウザで開く (map.html)", command=open_map).pack(side=tk.LEFT, padx=(0, 10))

        ttk.Button(btn_frame, text="閉じる", command=dialog.destroy).pack(side=tk.RIGHT)

def main():
    app = ConverterApp()
    app.mainloop()

if __name__ == "__main__":
    main()

