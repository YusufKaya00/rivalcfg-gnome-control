"""Unit tests for metadata, symbolic SVG icon, stylesheet, and color_picker.py."""

import importlib.util
import json
import pathlib
import sys
import unittest
import xml.etree.ElementTree as ET

ROOT_DIR = pathlib.Path(__file__).resolve().parent.parent
SRC_DIR = ROOT_DIR / "src"
ICONS_DIR = SRC_DIR / "icons"
HELPERS_DIR = SRC_DIR / "helpers"


def _load_color_picker_module():
    module_path = HELPERS_DIR / "color_picker.py"
    spec = importlib.util.spec_from_file_location("color_picker", module_path)
    module = importlib.util.module_from_spec(spec)
    assert spec is not None and spec.loader is not None
    spec.loader.exec_module(module)
    return module


class MetadataTests(unittest.TestCase):
    def test_metadata_json_valid_and_complete(self):
        metadata_path = SRC_DIR / "metadata.json"
        self.assertTrue(metadata_path.is_file(), "src/metadata.json must exist")

        data = json.loads(metadata_path.read_text(encoding="utf-8"))
        self.assertEqual(data["uuid"], "rivalcfg-control@yusufkaya00.github.io")
        self.assertEqual(data["name"], "SteelSeries Rivalcfg Control")
        self.assertEqual(data["shell-version"], ["45", "46", "47"])
        self.assertEqual(
            data["url"],
            "https://github.com/YusufKaya00/rivalcfg-gnome-control",
        )
        self.assertEqual(data["version"], 1)
        self.assertIsInstance(data["description"], str)
        self.assertTrue(len(data["description"]) > 10)


class SymbolicSvgTests(unittest.TestCase):
    EXPECTED_ICONS = ("rivalcfg-mouse-symbolic.svg",)

    def test_symbolic_svg_exists_and_is_valid_xml(self):
        svg_files = sorted(p.name for p in ICONS_DIR.glob("*.svg"))
        self.assertEqual(svg_files, sorted(self.EXPECTED_ICONS))

        path = ICONS_DIR / "rivalcfg-mouse-symbolic.svg"
        text = path.read_text(encoding="utf-8")
        root = ET.fromstring(text)
        self.assertEqual(root.tag, "{http://www.w3.org/2000/svg}svg")
        self.assertEqual(root.attrib.get("viewBox"), "0 0 16 16")
        self.assertTrue(
            "#bebebe" in text or "currentColor" in text,
            msg="rivalcfg-mouse-symbolic.svg should use monochrome symbolic fill",
        )


class StylesheetTests(unittest.TestCase):
    REQUIRED_SELECTORS = (
        ".rivalcfg-panel-box",
        ".rivalcfg-panel-label",
        ".rivalcfg-popup-container",
        ".rivalcfg-device-switcher",
        ".rivalcfg-device-chip",
        ".rivalcfg-error-banner",
        ".rivalcfg-header-card",
        ".rivalcfg-device-title",
        ".rivalcfg-conn-badge",
        ".rivalcfg-battery-row",
        ".rivalcfg-battery-pct",
        ".rivalcfg-battery-bar-bg",
        ".rivalcfg-battery-bar-fill",
        ".rivalcfg-refresh-btn",
        ".rivalcfg-section-label",
        ".rivalcfg-pill-row",
        ".rivalcfg-pill-btn",
        ".rivalcfg-swatch-row",
        ".rivalcfg-swatch-btn",
        ".rivalcfg-custom-color-btn",
        ".rivalcfg-slider-row",
    )

    def test_stylesheet_has_required_classes_and_no_legacy_aerox3(self):
        css_path = SRC_DIR / "stylesheet.css"
        self.assertTrue(css_path.is_file(), "src/stylesheet.css must exist")
        css_text = css_path.read_text(encoding="utf-8")
        self.assertNotIn(".aerox3-", css_text)
        for selector in self.REQUIRED_SELECTORS:
            self.assertIn(selector, css_text)


class ColorPickerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cp = _load_color_picker_module()

    def test_app_id_and_dialog_title(self):
        self.assertEqual(self.cp.APP_ID, "io.github.yusufkaya00.RivalcfgColorPicker")
        self.assertEqual(self.cp.DIALOG_TITLE, "Mouse Color Picker")

    def test_default_initial_argument(self):
        args = self.cp.parse_args([])
        self.assertEqual(args.initial, "#ff3b30")

    def test_custom_initial_argument_normalized(self):
        args = self.cp.parse_args(["--initial", "#3584E4"])
        self.assertEqual(args.initial, "#3584e4")

        args_no_hash = self.cp.parse_args(["--initial", "2EC27E"])
        self.assertEqual(args_no_hash.initial, "#2ec27e")

    def test_invalid_initial_argument_exits(self):
        with self.assertRaises(SystemExit) as ctx:
            old_stderr = sys.stderr
            try:
                sys.stderr = open("/dev/null", "w", encoding="utf-8")
                self.cp.parse_args(["--initial", "not-a-color"])
            finally:
                sys.stderr.close()
                sys.stderr = old_stderr
        self.assertNotEqual(ctx.exception.code, 0)

    def test_rgba_to_hex_formatting_and_clamping(self):
        self.assertEqual(self.cp.rgba_to_hex(1.0, 0.0, 0.0), "#ff0000")
        self.assertEqual(self.cp.rgba_to_hex(0.0, 1.0, 0.0), "#00ff00")
        self.assertEqual(self.cp.rgba_to_hex(0.0, 0.0, 1.0), "#0000ff")
        self.assertEqual(self.cp.rgba_to_hex(0.207843, 0.517647, 0.894118), "#3584e4")
        self.assertEqual(self.cp.rgba_to_hex(-0.5, 1.5, 0.5), "#00ff80")

    def test_hex_to_rgba_round_trip(self):
        r, g, b, a = self.cp.hex_to_rgba_floats("#9b59b6")
        self.assertEqual(a, 1.0)
        self.assertEqual(self.cp.rgba_to_hex(r, g, b), "#9b59b6")


if __name__ == "__main__":
    unittest.main()
