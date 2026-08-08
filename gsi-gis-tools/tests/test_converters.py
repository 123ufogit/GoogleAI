import sys
import os
import unittest
import tempfile
import tkinter as tk

sys.path.insert(0, os.path.abspath("."))

from gsi_dem_converter import ConverterApp, parse_mesh_code, extract_mesh_code
from gsi_road_building_merger import VectorConverterApp

class TestGsiGisTools(unittest.TestCase):
    def setUp(self):
        try:
            self.dem_app = ConverterApp()
            self.dem_app.withdraw()
            self.vector_app = VectorConverterApp()
            self.vector_app.withdraw()
        except Exception as e:
            self.skipTest(f"Headless environment without display: {e}")

    def tearDown(self):
        if hasattr(self, 'dem_app') and self.dem_app:
            self.dem_app.destroy()
        if hasattr(self, 'vector_app') and self.vector_app:
            self.vector_app.destroy()

    def test_dem_converter_init(self):
        self.assertIsNotNone(self.dem_app)
        self.assertEqual(str(self.dem_app.start_btn['state']), tk.NORMAL)

    def test_road_merger_init(self):
        self.assertIsNotNone(self.vector_app)
        self.assertTrue(hasattr(self.vector_app, 'input_dir_var'))
        self.assertTrue(hasattr(self.vector_app, 'output_dir_var'))

    def test_mesh_code_parsing(self):
        self.assertEqual(extract_mesh_code("FG-GML-5339-45-DEM5A.xml"), "5339-45")
        lat, lon = parse_mesh_code("5339-45")
        self.assertIsNotNone(lat)
        self.assertIsNotNone(lon)
        self.assertAlmostEqual(lat, 35.708333, places=3)
        self.assertAlmostEqual(lon, 139.6875, places=3)

    def test_finish_conversion_recovery(self):
        self.dem_app.muni_map = {"01101 (札幌市中央区)": {"64414300"}}
        self.dem_app.finish_conversion()
        self.assertEqual(str(self.dem_app.muni_combo['state']), "readonly")

if __name__ == "__main__":
    unittest.main()
