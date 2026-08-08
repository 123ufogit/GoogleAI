import os
import zipfile
import io
import threading
import logging
import traceback
import xml.etree.ElementTree as ET
import tkinter as tk
from tkinter import ttk, filedialog, messagebox
import re
import json
import math

import shapefile
# Logging setup
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger("gsi_road_building_merger")

def latlon_to_jgd_plane(lat_deg, lon_deg, zone):
    """
    緯度・経度(度、JGD2011/GRS80)を平面直交座標系(X, Y)[メートル]に変換する。
    ※国土地理院「平面直交座標への換算式」に基づく。
    """
    zone_origins = {
        1: (33.0, 129.5),
        2: (33.0, 131.0),
        3: (36.0, 132.0 + 10./60.),
        4: (33.0, 133.5),
        5: (36.0, 134.0 + 20./60.),
        6: (36.0, 136.0),
        7: (36.0, 137.0 + 10./60.),
        8: (36.0, 138.5),
        9: (36.0, 139.0 + 50./60.),
        10: (40.0, 140.0 + 50./60.),
        11: (44.0, 140.0 + 15./60.),
        12: (44.0, 142.0 + 15./60.),
        13: (44.0, 144.0 + 15./60.),
        14: (26.0, 142.0),
        15: (26.0, 127.5),
        16: (26.0, 124.0),
        17: (26.0, 123.0),
        18: (20.0, 136.0),
        19: (26.0, 154.0)
    }
    
    if zone not in zone_origins:
        raise ValueError(f"Invalid JGD plane zone: {zone}")
        
    lat0_deg, lon0_deg = zone_origins[zone]
    
    a = 6378137.0
    f = 1.0 / 298.257222101
    m0 = 0.9999
    
    phi = math.radians(lat_deg)
    lambda_ = math.radians(lon_deg)
    phi0 = math.radians(lat0_deg)
    lambda0 = math.radians(lon0_deg)
    
    n = f / (2.0 - f)
    A0 = 1.0 + (n**2)/4.0 + (n**4)/64.0
    A1 = -(3.0/2.0)*(n - (9.0/16.0)*(n**3))
    A2 = (15.0/16.0)*(n**2 - (n**4)/4.0)
    A3 = -(35.0/48.0)*(n**3)
    A4 = (315.0/512.0)*(n**4)
    
    def meridian_arc(p):
        return a * (1.0 - n) * (1.0 - n**2) * (1.0 - n**4) * (
            A0 * p +
            A1 * math.sin(2.0 * p) +
            A2 * math.sin(4.0 * p) +
            A3 * math.sin(6.0 * p) +
            A4 * math.sin(8.0 * p)
        )
        
    S = meridian_arc(phi)
    S0 = meridian_arc(phi0)
    
    d_lambda = lambda_ - lambda0
    sin_phi = math.sin(phi)
    cos_phi = math.cos(phi)
    tan_phi = math.tan(phi)
    
    e2 = f * (2.0 - f)
    eta2 = (e2 * cos_phi**2) / (1.0 - e2)
    N = a / math.sqrt(1.0 - e2 * sin_phi**2)
    t = tan_phi
    
    t2 = t**2
    t4 = t**4
    
    term_x1 = (d_lambda**2 / 2.0) * N * sin_phi * cos_phi
    term_x2 = (d_lambda**4 / 24.0) * N * sin_phi * cos_phi**3 * (5.0 - t2 + 9.0*eta2 + 4.0*eta2**2)
    term_x3 = (d_lambda**6 / 720.0) * N * sin_phi * cos_phi**5 * (61.0 - 58.0*t2 + t4 + 270.0*eta2 - 330.0*t2*eta2)
    
    x = m0 * ((S - S0) + term_x1 + term_x2 + term_x3)
    
    term_y1 = d_lambda * N * cos_phi
    term_y2 = (d_lambda**3 / 6.0) * N * cos_phi**3 * (1.0 - t2 + eta2)
    term_y3 = (d_lambda**5 / 120.0) * N * cos_phi**5 * (5.0 - 18.0*t2 + t4 + 14.0*eta2 - 58.0*t2*eta2)
    
    y = m0 * (term_y1 + term_y2 + term_y3)
    
    # GIS標準(X=東, Y=北)として返す
    return y, x

def parse_pos_list(text):
    parts = text.strip().split()
    if len(parts) % 2 != 0:
        return []
    coords = []
    for i in range(0, len(parts), 2):
        try:
            # GMLでは緯度 経度の順
            lat = float(parts[i])
            lon = float(parts[i+1])
            coords.append((lat, lon))
        except ValueError:
            pass
    return coords

def parse_vector_gml(xml_content):
    """
    基盤地図情報基本項目XMLをパースして、要素のリストを返す。
    名前空間を無視して頑健に動作する。
    """
    root = ET.fromstring(xml_content)
    features = []
    
    for elem in root.iter():
        tag = elem.tag
        if tag.startswith('{'):
            tag = tag.split('}', 1)[1]
            
        if tag in ('BldA', 'RdEdg', 'RdCL'):
            fid = ""
            coords = []
            attrs = {}
            
            # Extract GML attributes
            for child in elem:
                c_tag = child.tag.split('}', 1)[1] if child.tag.startswith('{') else child.tag
                
                # Skip geometry
                if c_tag in ('loc', 'area', 'position'):
                    continue
                    
                sub_elements = list(child)
                if not sub_elements:
                    if child.text:
                        attrs[c_tag] = child.text.strip()
                    # Keep fid separate as well
                    if c_tag == 'fid':
                        fid = child.text.strip() if child.text else ""
                else:
                    # Check for timePosition
                    for sub in sub_elements:
                        sub_tag = sub.tag.split('}', 1)[1] if sub.tag.startswith('{') else sub.tag
                        if sub_tag == 'timePosition' and sub.text:
                            attrs[c_tag] = sub.text.strip()
                            break
                    else:
                        texts = [t.strip() for t in child.itertext() if t.strip()]
                        if texts:
                            attrs[c_tag] = " ".join(texts)
                            
            # Extract coordinates
            for sub_elem in elem.iter():
                sub_tag = sub_elem.tag.split('}', 1)[1] if sub_elem.tag.startswith('{') else sub_elem.tag
                if sub_tag == 'posList':
                    if sub_elem.text:
                        coords = parse_pos_list(sub_elem.text)
                        break
                        
            if coords:
                geom_type = 'Polygon' if tag == 'BldA' else 'LineString'
                features.append({
                    'type': tag,
                    'fid': fid,
                    'geometry_type': geom_type,
                    'coords': coords,
                    'attributes': attrs
                })
                
    return features

def write_shapefile(output_path, geometry_type, features, zone):
    """
    pyshp を用いて、featuresリストからシェープファイル (.shp, .shx, .dbf, .prj) を書き出す。
    """
    # 投影座標系のWKTを取得 (prjファイル用)
    wkt = ""
    try:
        from pyproj import CRS
        epsg_code = 6668 + zone
        crs = CRS.from_user_input(epsg_code)
        wkt = crs.to_wkt()
    except Exception:
        epsg_code = 6668 + zone
        wkt = f'PROJCS["JGD2011 / Japan Plane Rectangular CS IX",GEOGCS["JGD2011",DATUM["Japanese_Geodetic_Datum_2011",SPHEROID["GRS 1980",6378137,298.257222101]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",36],PARAMETER["central_meridian",139.833333333333],PARAMETER["scale_factor",0.9999],PARAMETER["false_easting",0],PARAMETER["false_northing",0],UNIT["metre",1],AUTHORITY["EPSG","{epsg_code}"]]'

    if geometry_type == 'Polygon':
        w = shapefile.Writer(output_path, shapefile.POLYGON)
    else:
        w = shapefile.Writer(output_path, shapefile.POLYLINE)
        
    w.field('FID', 'C', size=80)
    w.field('TYPE', 'C', size=50)
    
    # Collect all attribute keys across all features
    all_attr_keys = set()
    for f in features:
        if 'attributes' in f:
            all_attr_keys.update(f['attributes'].keys())
            
    sorted_keys = sorted(list(all_attr_keys))
    
    field_mappings = {}
    for key in sorted_keys:
        field_name = key[:10].upper()
        # Ensure uniqueness
        counter = 1
        orig_field_name = field_name
        while field_name in [f[0] for f in w.fields if f]:
            suffix = str(counter)
            field_name = f"{orig_field_name[:10-len(suffix)]}{suffix}"
            counter += 1
            
        w.field(field_name, 'C', size=100)
        field_mappings[key] = field_name
        
    for f in features:
        coords = f['coords']
        if not coords:
            continue
            
        plane_coords = []
        for pt in coords:
            if len(pt) == 2:
                if pt[0] < 100.0:  # 経緯度
                    lat, lon = pt
                    x_m, y_m = latlon_to_jgd_plane(lat, lon, zone)
                    plane_coords.append([x_m, y_m])
                else:
                    plane_coords.append(list(pt))
                    
        if len(plane_coords) < 2:
            continue
            
        if geometry_type == 'Polygon':
            if plane_coords[0] != plane_coords[-1]:
                plane_coords.append(plane_coords[0])
            w.poly([plane_coords])
        else:
            w.line([plane_coords])
            
        # Write record
        rec = [f['fid'], f['type']]
        attrs = f.get('attributes', {})
        for key in sorted_keys:
            val = attrs.get(key, "")
            rec.append(str(val))
            
        w.record(*rec)
        
    w.close()
    
    prj_path = os.path.splitext(output_path)[0] + ".prj"
    with open(prj_path, "w", encoding="utf-8") as f_prj:
        f_prj.write(wkt)

def estimate_jgd_zone(lat, lon):
    """緯度と経度から、最適な平面直交座標系の系番号(1〜19)を推定する"""
    if lon > 150.0:
        return 19
    if lat < 21.0:
        return 18
    if lat < 28.0 and lon > 140.0:
        return 14
    if lat < 25.0 and lon < 124.5:
        return 17
    if lat < 25.0 and lon < 126.0:
        return 16
    if lat < 28.0 and lon < 129.0:
        return 15
    if lat < 30.5 and lon < 131.0:
        if lat < 28.5:
            return 3  # 奄美
        else:
            return 4  # トカラ

    if lat > 41.3:
        if lon < 141.2:
            return 11
        elif lon < 143.3:
            return 12
        else:
            return 13

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

def extract_mesh_code(filename):
    """
    ファイル名またはパスから、4桁、6桁、または8桁のメッシュコードを抽出する。
    例: FG-GML-5339-45-BldA.xml -> 533945
    """
    match = re.search(r'FG-GML-(\d{4}-\d{2}-\d{2}|\d{4}-\d{2}|\d{6}|\d{4})', filename)
    if match:
        return match.group(1).replace("-", "")
        
    match2 = re.search(r'\b(\d{4}-\d{2}-\d{2}|\d{4}-\d{2}|\d{6}|\d{4})\b', filename)
    if match2:
        return match2.group(1).replace("-", "")
        
    return os.path.splitext(filename)[0]

def resolve_mesh_code(xml_name, parent_filepath):
    """
    XMLファイル名または親ZIPファイル名から、有効なメッシュコードを特定する。
    """
    code = extract_mesh_code(xml_name)
    if code and code.isdigit() and len(code) in [4, 6, 8]:
        return code
        
    code = extract_mesh_code(os.path.basename(parent_filepath))
    if code and code.isdigit() and len(code) in [4, 6, 8]:
        return code
        
    return ""

def is_mesh_allowed(file_mesh_code, allowed_meshes):
    """
    ファイル名から抽出されたメッシュコード(4桁, 6桁, 8桁)が、
    許可された市区町村の8桁メッシュコードリスト(CSV由来)に含まれるか判定する (前方一致)。
    """
    if not allowed_meshes:
        return False
    if not file_mesh_code:
        return False
    
    # 2次メッシュ(6桁)などが、CSVに記録された8次メッシュ(8桁)に含まれるか
    for m in allowed_meshes:
        if m.startswith(file_mesh_code):
            return True
    return False

def extract_xml_contents_from_file(file_path):
    """
    ファイルをスキャンして、含まれるXMLの内容をyieldする。
    ZIPファイル内のネストしたZIPファイルも再帰的に走査する。
    """
    ext = os.path.splitext(file_path)[1].lower()
    if ext == '.xml':
        try:
            with open(file_path, 'r', encoding='utf-8', errors='ignore') as f:
                yield os.path.basename(file_path), file_path, f.read()
        except Exception:
            pass
    elif ext == '.zip':
        try:
            with zipfile.ZipFile(file_path, 'r') as zf:
                for name in zf.namelist():
                    if name.lower().endswith('.xml'):
                        try:
                            yield name, file_path, zf.read(name).decode('utf-8', errors='ignore')
                        except Exception:
                            pass
                    elif name.lower().endswith('.zip'):
                        try:
                            nested_zip_bytes = zf.read(name)
                            with zipfile.ZipFile(io.BytesIO(nested_zip_bytes), 'r') as nzf:
                                for nname in nzf.namelist():
                                    if nname.lower().endswith('.xml'):
                                        try:
                                            yield nname, name, nzf.read(nname).decode('utf-8', errors='ignore')
                                        except Exception:
                                            pass
                        except Exception:
                            pass
        except Exception:
            pass

class VectorConverterApp(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("国土地理院 道路・建物 Shapefile 変換・結合ツール")
        self.geometry("700x750")
        self.minsize(600, 650)
        self.metadata_scan_thread_active = False
        self.scanned_files_metadata = []
        self.muni_map = {}
        self.mesh_to_muni = {}
        self.log_messages = []
        self.setup_ui()

    def setup_ui(self):
        # Configure styles
        style = ttk.Style()
        style.theme_use('vista' if os.name == 'nt' else 'clam')

        main_frame = ttk.Frame(self, padding="15")
        main_frame.pack(fill=tk.BOTH, expand=True)

        # Title
        title_label = ttk.Label(main_frame, text="国土地理院 道路・建物 Shapefile 変換・結合ツール", font=("Helvetica", 14, "bold"))
        title_label.pack(anchor=tk.W, pady=(0, 15))

        # Folder settings
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
        ttk.Label(folder_frame, text="出力フォルダ (Shapefiles):").grid(row=1, column=0, sticky=tk.W, pady=5)
        self.output_dir_var = tk.StringVar()
        self.output_entry = ttk.Entry(folder_frame, textvariable=self.output_dir_var, width=50)
        self.output_entry.grid(row=1, column=1, padx=5, pady=5, sticky=tk.EW)
        self.output_btn = ttk.Button(folder_frame, text="参照...", command=self.browse_output)
        self.output_btn.grid(row=1, column=2, padx=5, pady=5)

        # Download help link for GSI Fundamental Geospatial Data
        gsi_download_label = ttk.Label(folder_frame, text="データダウンロード: 国土地理院 基盤地図情報ダウンロードサービス (https://service.gsi.go.jp/kiban/app/map/?search=base)", font=("Helvetica", 8), cursor="hand2", foreground="blue")
        gsi_download_label.grid(row=2, column=0, columnspan=3, sticky=tk.W, pady=(2, 0))
        gsi_download_label.bind("<Button-1>", lambda e: self.open_gsi_download_url())

        gsi_note_label = ttk.Label(folder_frame, text="※ データのダウンロードおよび利用にあたっては「国土地理院コンテンツ利用規約」をご確認ください。", font=("Helvetica", 8), foreground="#555555")
        gsi_note_label.grid(row=3, column=0, columnspan=3, sticky=tk.W, pady=(0, 2))

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

        # Settings
        settings_frame = ttk.LabelFrame(main_frame, text="変換・抽出設定", padding="10")
        settings_frame.pack(fill=tk.X, pady=(0, 15))

        # Checkboxes
        self.convert_blda_var = tk.BooleanVar(value=True)
        self.blda_check = ttk.Checkbutton(settings_frame, text="建物 (BldA) 変換", variable=self.convert_blda_var, command=self.update_size_estimate_and_crs)
        self.blda_check.grid(row=0, column=0, sticky=tk.W, padx=5, pady=5)

        # Default road edge is True, road centerline is False (swapped from previous design)
        self.convert_rdedg_var = tk.BooleanVar(value=True)
        self.rdedg_check = ttk.Checkbutton(settings_frame, text="道路縁 (RdEdg) 変換", variable=self.convert_rdedg_var, command=self.update_size_estimate_and_crs)
        self.rdedg_check.grid(row=0, column=1, sticky=tk.W, padx=5, pady=5)

        # Show Advanced Settings checkbox
        self.show_advanced_var = tk.BooleanVar(value=False)
        self.show_advanced_check = ttk.Checkbutton(settings_frame, text="詳細設定を表示", variable=self.show_advanced_var, command=self.toggle_advanced_settings)
        self.show_advanced_check.grid(row=0, column=2, sticky=tk.W, padx=5, pady=5)

        # Road Centerline Checkbox (hidden by default now)
        self.convert_rdcl_var = tk.BooleanVar(value=False)
        self.rdcl_check = ttk.Checkbutton(settings_frame, text="道路中心線 (RdCL) 変換", variable=self.convert_rdcl_var, command=self.update_size_estimate_and_crs)

        # CRS dropdown
        ttk.Label(settings_frame, text="出力座標系 (系1〜19):").grid(row=2, column=0, sticky=tk.W, pady=10, padx=5)
        self.crs_var = tk.StringVar(value="JGD2011 / 平面直交座標第9系 (EPSG:6677)")
        
        self.base_crs_values = []
        for i in range(1, 20):
            self.base_crs_values.append(f"JGD2011 / 平面直交座標第{i}系 (EPSG:{6668 + i})")

        self.crs_combo = ttk.Combobox(settings_frame, textvariable=self.crs_var, values=self.base_crs_values, state="readonly", width=45)
        self.crs_combo.grid(row=2, column=1, columnspan=2, padx=5, pady=10, sticky=tk.W)

        # File Size Estimate Label
        self.size_estimate_var = tk.StringVar(value="")
        self.size_estimate_label = ttk.Label(settings_frame, textvariable=self.size_estimate_var, font=("Helvetica", 9, "italic"))
        self.size_estimate_label.grid(row=3, column=0, columnspan=3, sticky=tk.W, pady=2, padx=5)

        # Progress bar and Status
        control_frame = ttk.Frame(main_frame)
        control_frame.pack(fill=tk.X, pady=(0, 10))

        self.start_btn = ttk.Button(control_frame, text="変換・結合開始", command=self.start_conversion)
        self.start_btn.pack(side=tk.LEFT, padx=(0, 10))

        self.progress_var = tk.DoubleVar()
        self.progress_bar = ttk.Progressbar(control_frame, variable=self.progress_var, maximum=100)
        self.progress_bar.pack(side=tk.LEFT, fill=tk.X, expand=True, pady=5)

        self.progress_label_var = tk.StringVar(value="進行状況: 準備完了")
        self.progress_label = ttk.Label(main_frame, textvariable=self.progress_label_var)
        self.progress_label.pack(anchor=tk.W, pady=(0, 5))

        # Log box
        log_frame = ttk.LabelFrame(main_frame, text="処理ログ / 進捗", padding="5")
        log_frame.pack(fill=tk.BOTH, expand=True)

        self.log_text = tk.Text(log_frame, wrap=tk.WORD, height=12, state=tk.DISABLED, font=("Consolas", 9))
        self.log_text.pack(fill=tk.BOTH, expand=True, side=tk.LEFT)

        scrollbar = ttk.Scrollbar(log_frame, command=self.log_text.yview)
        scrollbar.pack(fill=tk.Y, side=tk.RIGHT)
        self.log_text.config(yscrollcommand=scrollbar.set)

        # Trace input path
        self.input_dir_var.trace_add("write", self.on_input_dir_changed)

    def toggle_advanced_settings(self):
        if self.show_advanced_var.get():
            self.rdcl_check.grid(row=1, column=0, sticky=tk.W, padx=5, pady=5)
        else:
            self.rdcl_check.grid_forget()
            self.convert_rdcl_var.set(False)
            self.update_size_estimate_and_crs()

    def browse_input(self):
        dir_path = filedialog.askdirectory(title="入力フォルダを選択")
        if dir_path:
            self.input_dir_var.set(os.path.abspath(dir_path))

    def browse_output(self):
        dir_path = filedialog.askdirectory(title="出力フォルダを選択")
        if dir_path:
            self.output_dir_var.set(os.path.abspath(dir_path))

    def browse_muni_csv(self):
        file_selected = filedialog.askopenfilename(
            title="市区町村メッシュCSVファイルを選択",
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
            self.update_size_estimate_and_crs()
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
            
        self.update_size_estimate_and_crs()

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

    def on_muni_selected(self, event=None):
        self.update_size_estimate_and_crs()

    def on_muni_filter_toggled(self):
        self.update_size_estimate_and_crs()

    def on_input_dir_changed(self, *args):
        input_dir = self.input_dir_var.get().strip()
        if not input_dir or not os.path.isdir(input_dir):
            self.scanned_files_metadata = []
            self.update_size_estimate_and_crs()
            return
        self.start_metadata_scan(input_dir)

    def start_metadata_scan(self, input_dir):
        if self.metadata_scan_thread_active:
            return
        self.size_estimate_var.set("ファイル情報取得中...")
        self.metadata_scan_thread_active = True
        self.scanned_files_metadata = []
        threading.Thread(target=self.scan_metadata_thread, args=(input_dir,), daemon=True).start()

    def scan_metadata_thread(self, input_dir):
        try:
            all_files = []
            for root_dir, _, filenames in os.walk(input_dir):
                for f in filenames:
                    ext = os.path.splitext(f)[1].lower()
                    if ext in ['.xml', '.zip']:
                        all_files.append(os.path.join(root_dir, f))
            
            total = len(all_files)
            if total == 0:
                self.after(0, lambda: self.size_estimate_var.set("出力予測サイズ: 対象ファイルなし"))
                self.metadata_scan_thread_active = False
                return
                
            for idx, file_path in enumerate(all_files):
                # Show scan progress
                if idx % 5 == 0 or idx == total - 1:
                    self.after(0, lambda count=idx+1, tot=total: self.size_estimate_var.set(f"ファイル情報取得中 ({count}/{tot})..."))
                    
                for xml_name, parent_path, content in extract_xml_contents_from_file(file_path):
                    # Count tags
                    count_blda = content.count('<BldA')
                    count_rdcl = content.count('<RdCL')
                    count_rdedg = content.count('<RdEdg')
                    
                    file_mesh = resolve_mesh_code(xml_name, parent_path)
                    
                    lat, lon = None, None
                    # Find coordinates
                    match_coords = re.search(r'<(?:gml:)?(?:posList|pos|lowerCorner|upperCorner)[^>]*>\s*([\d\.]+)\s+([\d\.]+)', content)
                    if match_coords:
                        c1 = float(match_coords.group(1))
                        c2 = float(match_coords.group(2))
                        if c1 > c2:
                            lon, lat = c1, c2
                        else:
                            lat, lon = c1, c2
                        if not (20.0 < lat < 46.0 and 120.0 < lon < 154.0):
                            lat, lon = None, None
                            
                    # Fallback coordinate detection from mesh code
                    if lat is None and file_mesh:
                        try:
                            # 1次メッシュ(4桁)または2次メッシュ(6桁)から緯度経度近似
                            lat_approx = int(file_mesh[:2]) / 1.5
                            lon_approx = int(file_mesh[2:4]) + 100
                            lat, lon = lat_approx, lon_approx
                        except Exception:
                            pass
                            
                    self.scanned_files_metadata.append({
                        'file_path': file_path,
                        'xml_name': xml_name,
                        'mesh_code': file_mesh,
                        'count_blda': count_blda,
                        'count_rdcl': count_rdcl,
                        'count_rdedg': count_rdedg,
                        'representative_lat': lat,
                        'representative_lon': lon
                    })

            # Auto-detection of data types
            has_blda = any(m['count_blda'] > 0 for m in self.scanned_files_metadata)
            has_rdcl = any(m['count_rdcl'] > 0 for m in self.scanned_files_metadata)
            has_rdedg = any(m['count_rdedg'] > 0 for m in self.scanned_files_metadata)
            
            def apply_auto_detect():
                self.convert_blda_var.set(has_blda)
                self.convert_rdedg_var.set(has_rdedg)
                if self.show_advanced_var.get():
                    self.convert_rdcl_var.set(has_rdcl)
                else:
                    self.convert_rdcl_var.set(False)
                
                detect_str = f"自動検出: 建物={has_blda}, 道路縁={has_rdedg}"
                if has_rdcl:
                    detect_str += f" (道路中心線検出あり)"
                self.log(detect_str)
                self.update_size_estimate_and_crs()

            self.after(0, apply_auto_detect)
                
        except Exception as e:
            self.after(0, lambda: self.size_estimate_var.set("出力予測サイズ: スキャンエラー"))
            logger.error(f"Metadata scan failed: {e}")
        finally:
            self.metadata_scan_thread_active = False

    def update_size_estimate_and_crs(self):
        if not hasattr(self, 'scanned_files_metadata') or not self.scanned_files_metadata:
            self.size_estimate_var.set("")
            return
            
        want_blda = self.convert_blda_var.get()
        want_rdcl = self.convert_rdcl_var.get()
        want_rdedg = self.convert_rdedg_var.get()
        
        muni_filter_enabled = self.muni_filter_enabled_var.get()
        selected_muni = self.muni_select_var.get().strip()
        
        allowed_meshes = set()
        if muni_filter_enabled and selected_muni in self.muni_map:
            allowed_meshes = self.muni_map[selected_muni]
            
        sum_blda = 0
        sum_rdcl = 0
        sum_rdedg = 0
        
        representative_lat = None
        representative_lon = None
        
        filtered_count = 0
        total_count = len(self.scanned_files_metadata)
        
        for meta in self.scanned_files_metadata:
            file_mesh = meta['mesh_code']
            
            # Filter check
            if muni_filter_enabled and allowed_meshes:
                if not is_mesh_allowed(file_mesh, allowed_meshes):
                    continue
            
            filtered_count += 1
            
            if want_blda:
                sum_blda += meta['count_blda']
            if want_rdcl:
                sum_rdcl += meta['count_rdcl']
            if want_rdedg:
                sum_rdedg += meta['count_rdedg']
                
            if representative_lat is None and meta['representative_lat'] is not None:
                representative_lat = meta['representative_lat']
                representative_lon = meta['representative_lon']
                
        # Estimate size
        total_size_bytes = sum_blda * 1200 + sum_rdcl * 800 + sum_rdedg * 800
        if total_size_bytes >= 1024*1024:
            size_str = f"出力予測サイズ: 約 {total_size_bytes / (1024*1024):.2f} MB"
        else:
            size_str = f"出力予測サイズ: 約 {total_size_bytes / 1024:.1f} KB"
            
        if muni_filter_enabled:
            size_str += f" ({selected_muni} の範囲: {filtered_count}/{total_count} ファイル対象)"
            
        self.size_estimate_var.set(size_str)
        
        # Update CRS recommendation
        if representative_lat is not None and representative_lon is not None:
            zone = estimate_jgd_zone(representative_lat, representative_lon)
            recommended_crs = f"JGD2011 / 平面直交座標第{zone}系 (EPSG:{6668 + zone})"
            self.set_recommended_crs(recommended_crs, representative_lat, representative_lon)

    def set_recommended_crs(self, recommended_crs, lat, lon):
        current_values = list(self.base_crs_values)
        recommended_full = f"{recommended_crs} [自動判定・推奨]"
        current_values.insert(0, recommended_full)
        self.crs_combo.config(values=current_values)
        self.crs_var.set(recommended_full)
        self.log(f"フォルダスキャン結果: 推奨座標系「{recommended_crs}」 (代表点: 北緯{lat:.3f}, 東経{lon:.3f})")

    def log(self, message, level="INFO"):
        self.log_messages.append(f"[{level}] {message}")
        self.log_text.config(state=tk.NORMAL)
        prefix = f"[{level}] " if level != "INFO" else ""
        self.log_text.insert(tk.END, f"{prefix}{message}\n")
        self.log_text.see(tk.END)
        self.log_text.config(state=tk.DISABLED)
        self.update_idletasks()

    def start_conversion(self):
        input_dir = self.input_dir_var.get().strip()
        output_dir = self.output_dir_var.get().strip()

        if not input_dir or not os.path.isdir(input_dir):
            messagebox.showerror("エラー", "有効な入力フォルダを選択してください。")
            return
        if not output_dir:
            messagebox.showerror("エラー", "有効な出力フォルダを選択してください。")
            return

        self.start_btn.config(state=tk.DISABLED)
        self.input_btn.config(state=tk.DISABLED)
        self.output_btn.config(state=tk.DISABLED)
        self.crs_combo.config(state=tk.DISABLED)
        self.muni_combo.config(state=tk.DISABLED)
        self.muni_filter_check.config(state=tk.DISABLED)
        self.muni_csv_btn.config(state=tk.DISABLED)

        # Clear logs
        self.log_text.config(state=tk.NORMAL)
        self.log_text.delete("1.0", tk.END)
        self.log_text.config(state=tk.DISABLED)
        self.log_messages = []

        threading.Thread(target=self.run_conversion_thread, args=(input_dir, output_dir), daemon=True).start()

    def finish_conversion(self):
        self.start_btn.config(state=tk.NORMAL)
        self.input_btn.config(state=tk.NORMAL)
        self.output_btn.config(state=tk.NORMAL)
        self.crs_combo.config(state="readonly")
        self.muni_csv_btn.config(state=tk.NORMAL)
        if self.muni_map:
            self.muni_combo.config(state="readonly")
            self.muni_filter_check.config(state="normal")

    def run_conversion_thread(self, input_dir, output_dir):
        try:
            self.progress_label_var.set("進行状況: フォルダ走査中...")
            vector_files = []
            for root, dirs, files in os.walk(input_dir):
                for file in files:
                    ext = os.path.splitext(file)[1].lower()
                    if ext in ['.xml', '.zip']:
                        vector_files.append(os.path.join(root, file))
                        
            total_vector_files = len(vector_files)
            if total_vector_files == 0:
                self.log("入力フォルダにXMLまたはZIPファイルが見つかりませんでした。", "ERROR")
                self.progress_label_var.set("進行状況: エラー終了")
                self.finish_conversion()
                return
                
            self.log(f"解析対象ファイル数: {total_vector_files}件")
            
            want_blda = self.convert_blda_var.get()
            want_rdcl = self.convert_rdcl_var.get()
            want_rdedg = self.convert_rdedg_var.get()
            
            if not (want_blda or want_rdcl or want_rdedg):
                self.log("変換対象（建物、道路中心線、または道路縁）が選択されていません。", "ERROR")
                self.progress_label_var.set("進行状況: エラー終了")
                self.finish_conversion()
                return
                
            muni_filter_enabled = self.muni_filter_enabled_var.get()
            target_code = None
            selected_muni_name = ""
            allowed_meshes = set()
            if muni_filter_enabled:
                selected_muni = self.muni_select_var.get().strip()
                if selected_muni in self.muni_map:
                    allowed_meshes = self.muni_map[selected_muni]
                match_muni = re.match(r'^(\d{5})\s*\((.*)\)', selected_muni)
                if match_muni:
                    target_code = match_muni.group(1)
                    selected_muni_name = match_muni.group(2)
                else:
                    match_code_only = re.match(r'^(\d{5})', selected_muni)
                    if match_code_only:
                        target_code = match_code_only.group(1)
                self.log(f"市区町村フィルタ有効: {selected_muni} (自治体コード: {target_code})")
            
            success_count = 0
            error_count = 0
            
            muni_vectors = {}
            output_key = target_code if (muni_filter_enabled and target_code) else "combined"
            
            self.progress_var.set(10)
            self.progress_label_var.set(f"進行状況: 10% (0/{total_vector_files} ファイル完了)")
            
            min_lat, min_lon = 90.0, 180.0
            max_lat, max_lon = -90.0, -180.0
            coords_count = 0
            
            # Parse files
            for idx, file_path in enumerate(vector_files):
                basename = os.path.basename(file_path)
                self.log(f"ファイルを解析中 ({idx+1}/{total_vector_files}): {basename}")
                
                for name, parent_path, xml_content in extract_xml_contents_from_file(file_path):
                    file_mesh = resolve_mesh_code(name, parent_path)
                    
                    # 1. Mesh code based file filtering
                    if muni_filter_enabled and allowed_meshes and file_mesh:
                        if not is_mesh_allowed(file_mesh, allowed_meshes):
                            self.log(f"  スキップ: {name} (対象市区町村のメッシュ範囲外)")
                            continue
                            
                    try:
                        parsed_features = parse_vector_gml(xml_content)
                        for feat in parsed_features:
                            f_type = feat['type']
                            if f_type == 'BldA' and not want_blda:
                                continue
                            if f_type == 'RdCL' and not want_rdcl:
                                continue
                            if f_type == 'RdEdg' and not want_rdedg:
                                continue
                                
                            if output_key not in muni_vectors:
                                muni_vectors[output_key] = {'BldA': [], 'RdEdg': [], 'RdCL': []}
                                
                            muni_vectors[output_key][f_type].append(feat)
                            
                            # Bounding box tracking
                            for pt in feat['coords']:
                                if len(pt) == 2:
                                    lat, lon = pt
                                    if 20.0 < lat < 46.0 and 120.0 < lon < 154.0:
                                        min_lat = min(min_lat, lat)
                                        min_lon = min(min_lon, lon)
                                        max_lat = max(max_lat, lat)
                                        max_lon = max(max_lon, lon)
                                        coords_count += 1
                    except Exception as e:
                        self.log(f"GMLパースエラー in {name} (from {basename}): {e}", "ERROR")
                        error_count += 1
                        
                progress = 10 + int(70 * (idx + 1) / total_vector_files)
                self.progress_var.set(progress)
                self.progress_label_var.set(f"進行状況: {progress}% ({idx+1}/{total_vector_files} ファイル完了)")
                
            # Determine Coordinate System Zone
            crs_selection = self.crs_var.get()
            zone_number = 9
            match_zone = re.search(r'平面直交座標第(\d+)系', crs_selection)
            if match_zone:
                zone_number = int(match_zone.group(1))
                
            self.log(f"出力座標系: 平面直交座標第 {zone_number} 系")
            
            # Write Shapefiles grouped by key
            self.progress_label_var.set("進行状況: Shapefile書き出し中...")
            for key_prefix, layers in muni_vectors.items():
                self.log(f"[{key_prefix}] のShapefileを出力中...")
                
                # Buildings
                if want_blda and layers['BldA']:
                    shp_name = f"{key_prefix}_buildings"
                    shp_path = os.path.join(output_dir, shp_name + ".shp")
                    try:
                        write_shapefile(shp_path, 'Polygon', layers['BldA'], zone_number)
                        self.log(f"  建物Shapefile出力完了: {shp_name}.shp (レコード数: {len(layers['BldA'])})", "SUCCESS")
                        success_count += 1
                    except Exception as e:
                        self.log(f"  建物Shapefile出力エラー ({key_prefix}): {e}", "ERROR")
                        error_count += 1
                        
                # Road centerlines
                if want_rdcl and layers['RdCL']:
                    shp_name = f"{key_prefix}_road_centerlines"
                    shp_path = os.path.join(output_dir, shp_name + ".shp")
                    try:
                        write_shapefile(shp_path, 'LineString', layers['RdCL'], zone_number)
                        self.log(f"  道路中心線Shapefile出力完了: {shp_name}.shp (レコード数: {len(layers['RdCL'])})", "SUCCESS")
                        success_count += 1
                    except Exception as e:
                        self.log(f"  道路中心線Shapefile出力エラー ({key_prefix}): {e}", "ERROR")
                        error_count += 1
                        
                # Road edges
                if want_rdedg and layers['RdEdg']:
                    shp_name = f"{key_prefix}_road_edges"
                    shp_path = os.path.join(output_dir, shp_name + ".shp")
                    try:
                        write_shapefile(shp_path, 'LineString', layers['RdEdg'], zone_number)
                        self.log(f"  道路縁Shapefile出力完了: {shp_name}.shp (レコード数: {len(layers['RdEdg'])})", "SUCCESS")
                        success_count += 1
                    except Exception as e:
                        self.log(f"  道路縁Shapefile出力エラー ({key_prefix}): {e}", "ERROR")
                        error_count += 1
            
            # Write Bounding Box GeoJSON
            if coords_count > 0:
                self.progress_label_var.set("進行状況: 結合範囲GeoJSON作成中...")
                geojson_name = "combined_bounds.geojson" if output_key == "combined" else f"{output_key}_bounds.geojson"
                
                geojson_data = {
                    "type": "FeatureCollection",
                    "features": [
                        {
                            "type": "Feature",
                            "geometry": {
                                "type": "Polygon",
                                "coordinates": [[
                                    [min_lon, min_lat],
                                    [max_lon, min_lat],
                                    [max_lon, max_lat],
                                    [min_lon, max_lat],
                                    [min_lon, min_lat]
                                ]]
                            },
                            "properties": {
                                "name": f"{output_key} Bounding Box",
                                "municipality_code": output_key,
                                "municipality_name": selected_muni_name if muni_filter_enabled else "",
                                "min_lat": min_lat,
                                "min_lon": min_lon,
                                "max_lat": max_lat,
                                "max_lon": max_lon,
                                "coordinate_system": f"EPSG:{6668 + zone_number}"
                            }
                        }
                    ]
                }
                geojson_path = os.path.join(output_dir, geojson_name)
                try:
                    with open(geojson_path, "w", encoding="utf-8") as f_geo:
                        json.dump(geojson_data, f_geo, ensure_ascii=False, indent=2)
                    self.log(f"結合範囲のGeoJSONを出力しました: {geojson_name}", "SUCCESS")
                except Exception as e:
                    self.log(f"GeoJSON出力エラー: {e}", "ERROR")
            
            # Write Log file
            self.progress_label_var.set("進行状況: ログファイル保存中...")
            log_path = os.path.join(output_dir, "vector_conversion_log.txt")
            try:
                with open(log_path, "w", encoding="utf-8") as f_log:
                    f_log.write("\n".join(self.log_messages))
                self.log(f"処理ログファイルを出力しました: vector_conversion_log.txt", "SUCCESS")
            except Exception as e:
                self.log(f"ログファイル出力エラー: {e}", "ERROR")

            self.progress_var.set(100)
            self.progress_label_var.set("進行状況: 処理完了")
            self.finish_conversion()
            
            # Completion popup
            if success_count > 0:
                self.after(0, lambda: messagebox.showinfo(
                    "処理完了", f"変換処理が完了しました！\n成功: {success_count}件\nエラー: {error_count}件\n出力先: {output_dir}"
                ))
            else:
                self.after(0, lambda: messagebox.showerror(
                    "エラー", "変換に成功したファイルがありませんでした。処理ログをご確認ください。"
                ))
        except Exception as e:
            self.log(f"致命的なエラーが発生しました: {traceback.format_exc()}", "ERROR")
            self.progress_label_var.set("進行状況: エラー終了")
            self.finish_conversion()

def main():
    app = VectorConverterApp()
    app.mainloop()

if __name__ == "__main__":
    main()

