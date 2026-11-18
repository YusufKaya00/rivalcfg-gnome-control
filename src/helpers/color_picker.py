#!/usr/bin/env python3
"""GTK4 / libadwaita color picker dialog helper for SteelSeries Rivalcfg Control."""

import argparse
import re
import sys
from typing import Optional, Sequence, Tuple

APP_ID = "io.github.yusufkaya00.RivalcfgColorPicker"
DIALOG_TITLE = "Mouse Color Picker"
DEFAULT_INITIAL_COLOR = "#ff3b30"
HEX_COLOR_RE = re.compile(r"^#?([0-9a-fA-F]{6})$")


def normalize_hex_color(value: str) -> str:
    """Validate and normalize a hex color string to lowercase #rrggbb."""
    if not isinstance(value, str):
        raise ValueError(f"Expected string hex color, got {type(value).__name__}")
    match = HEX_COLOR_RE.match(value.strip())
    if not match:
        raise ValueError(f"Invalid hex color '{value}'; expected #RRGGBB")
    return f"#{match.group(1).lower()}"


def _parse_initial_arg(value: str) -> str:
    try:
        return normalize_hex_color(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(str(exc)) from exc


def hex_to_rgba_floats(hex_color: str) -> Tuple[float, float, float, float]:
    """Convert #RRGGBB string into normalized (r, g, b, a) floats in [0.0, 1.0]."""
    normalized = normalize_hex_color(hex_color)
    r = int(normalized[1:3], 16) / 255.0
    g = int(normalized[3:5], 16) / 255.0
    b = int(normalized[5:7], 16) / 255.0
    return (r, g, b, 1.0)


def rgba_to_hex(red: float, green: float, blue: float) -> str:
    """Convert normalized RGB floats [0.0, 1.0] into lowercase #rrggbb."""
    def _channel(val: float) -> int:
        clamped = max(0.0, min(1.0, float(val)))
        return int(round(clamped * 255.0))

    return f"#{_channel(red):02x}{_channel(green):02x}{_channel(blue):02x}"


def build_arg_parser() -> argparse.ArgumentParser:
    """Build CLI argument parser for the color picker helper."""
    parser = argparse.ArgumentParser(
        prog="color_picker.py",
        description="Open a GTK4 color dialog and print the chosen #RRGGBB color.",
    )
    parser.add_argument(
        "--initial",
        type=_parse_initial_arg,
        default=DEFAULT_INITIAL_COLOR,
        metavar="#RRGGBB",
        help=f"Initial hex color (default: {DEFAULT_INITIAL_COLOR})",
    )
    return parser


def parse_args(argv: Optional[Sequence[str]] = None) -> argparse.Namespace:
    """Parse CLI arguments."""
    return build_arg_parser().parse_args(argv)


def run_dialog(initial_hex: str) -> int:
    """Launch the Adw/Gtk4 ColorDialog and return process exit code."""
    import gi

    gi.require_version("Gtk", "4.0")
    gi.require_version("Adw", "1")
    from gi.repository import Adw, Gdk, Gio, GLib, Gtk

    exit_code = 1
    r, g, b, a = hex_to_rgba_floats(initial_hex)
    initial_rgba = Gdk.RGBA()
    initial_rgba.red = r
    initial_rgba.green = g
    initial_rgba.blue = b
    initial_rgba.alpha = a

    app = Adw.Application(
        application_id=APP_ID,
        flags=Gio.ApplicationFlags.NON_UNIQUE,
    )

    def on_activate(application: Adw.Application) -> None:
        application.hold()

        dialog = Gtk.ColorDialog.new()
        dialog.set_title(DIALOG_TITLE)
        dialog.set_with_alpha(False)
        dialog.set_modal(True)

        def on_color_chosen(source: Gtk.ColorDialog, result: Gio.AsyncResult) -> None:
            nonlocal exit_code
            try:
                rgba = source.choose_rgba_finish(result)
                if rgba is not None:
                    print(rgba_to_hex(rgba.red, rgba.green, rgba.blue), flush=True)
                    exit_code = 0
                else:
                    exit_code = 1
            except GLib.Error:
                # User cancelled/dismissed the dialog.
                exit_code = 1
            finally:
                application.release()

        dialog.choose_rgba(None, initial_rgba, None, on_color_chosen)

    app.connect("activate", on_activate)
    app.run([])
    return exit_code


def main(argv: Optional[Sequence[str]] = None) -> int:
    """CLI entrypoint."""
    args = parse_args(argv)
    return run_dialog(args.initial)


if __name__ == "__main__":
    sys.exit(main())
