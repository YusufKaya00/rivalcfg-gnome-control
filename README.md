# SteelSeries Rivalcfg Control

A native GNOME Shell (45 / 46 / 47) extension that brings top-bar battery monitoring, RGB lighting control, and hardware configuration for SteelSeries mice powered by [`rivalcfg`](https://github.com/flozz/rivalcfg).

## Features

- **Universal SteelSeries Support**: Automatically discovers connected SteelSeries devices (`1038:*`) via USB sysfs and dynamically introspects each mouse's exact capabilities (`RIVALCFG_DRY=1 rivalcfg --help`), adapting the UI to single-zone, multi-zone, LED-less, wired-only, and wireless mice.
- **Multi-Device Switcher**: Switch cleanly between multiple connected SteelSeries mice from the popup menu, with per-device persistent state stored in `~/.config/rivalcfg-control/<deviceKey>.json`.
- **Clean Top-Bar Indicator**: Displays a crisp symbolic mouse icon and battery percentage (`95%`, `Sleep`, or `—`) for wireless mice, or a minimal icon for wired-only mice.
- **Battery & Discharge Estimation**: Shows connection mode (`Wired`, `2.4 GHz`, `Sleeping`, `Offline`, `Connected`), battery progress bar, and estimated remaining discharge time. Polls every 60 seconds, on menu open (throttled), and on system resume (`PrepareForSleep`).
- **Dynamic RGB Lighting Controls**:
  - Lighting modes (`Static`, `Rainbow`, `Reactive`, `Off`) tailored to each mouse's supported flags
  - Per-zone color selection (`All` + discovered zones such as `Top`, `Middle`, `Bottom`, `Logo`, `Wheel`, `Zone 1..10`)
  - Preset color swatches and a native GTK4 / libadwaita color picker (`helpers/color_picker.py`)
  - Smooth brightness slider with debounced `--no-save` live preview and settled EEPROM persistence
- **Hardware Settings Submenu**: Dynamically exposes supported options including click reactive color, light effects, startup lighting, polling rate, sleep timer, and DPI preset profiles.
- **Helpful Diagnostics**: Surfaces clear banners if `rivalcfg` is not installed or if udev USB permissions are missing (`rivalcfg --update-udev`).

## Requirements

- **GNOME Shell**: `45`, `46`, or `47`
- **rivalcfg**: Installed on `PATH` or in `~/.local/bin/rivalcfg`, `/usr/local/bin/rivalcfg`, `/usr/bin/rivalcfg`
  ```bash
  pipx install rivalcfg
  sudo rivalcfg --update-udev
  ```
- **Python 3 + PyGObject (GTK 4 / libadwaita)**: Required for the custom color picker dialog (`python3-gi`, `gir1.2-gtk-4.0`, `gir1.2-adw-1` on Debian/Ubuntu)

## Installation

```bash
git clone https://github.com/YusufKaya00/rivalcfg-gnome-control.git
cd rivalcfg-gnome-control
./scripts/install.sh
```

The installer copies `src/` to `~/.local/share/gnome-shell/extensions/rivalcfg-control@yusufkaya00.github.io/`, marks `helpers/color_picker.py` executable, removes any legacy `aerox3-control@ysf.local` install if present, and enables the extension in `org.gnome.shell enabled-extensions`.

### Reload GNOME Shell

- **X11**: Press `Alt+F2`, type `r`, and press `Enter`.
- **Wayland**: Log out and log back in.

## Uninstallation

```bash
./scripts/uninstall.sh
```

## Development & Tests

Run the GJS backend and Python helper test suites:

```bash
gjs -m tests/test_backend.js
python3 -m unittest -v tests/test_helpers.py
python3 -m py_compile src/helpers/color_picker.py
```

## License

MIT License — see [LICENSE](LICENSE).
