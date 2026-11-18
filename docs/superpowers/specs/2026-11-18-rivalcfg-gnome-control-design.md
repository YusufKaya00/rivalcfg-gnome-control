# SteelSeries Rivalcfg GNOME Shell Control — Design Spec

**Date:** 2026-11-18  
**Target Environment:** GNOME Shell 45 / 46 / 47 (GJS ESM), GTK 4 / libadwaita (`color_picker.py`), `rivalcfg` CLI  
**Extension UUID:** `rivalcfg-control@yusufkaya00.github.io`

## 1. Overview

`rivalcfg-gnome-control` is a general-purpose GNOME Shell top-bar extension supporting all SteelSeries mouse families exposed by `rivalcfg` (33 device modules / 76 USB PIDs). Rather than hardcoding flags or binary paths for a single mouse model, the backend dynamically discovers the `rivalcfg` binary, enumerates connected USB devices via sysfs, matches them against `rivalcfg --list`, and introspects per-PID CLI capabilities via `RIVALCFG_DRY=1 RIVALCFG_PROFILE=<vid:pid> rivalcfg --help`.

## 2. Architecture

1. **`src/rivalcfgClient.js`**
   - **Binary Discovery:** `findRivalcfgBin()` checks `$PATH` via `GLib.find_program_in_path('rivalcfg')`, then falls back to `~/.local/bin/rivalcfg`, `/usr/local/bin/rivalcfg`, and `/usr/bin/rivalcfg`.
   - **Device Catalog & Grouping:** `parseListOutput()` parses `rivalcfg --list`, strips `(wired mode)` and `(2.4 GHz [wireless] mode)` suffixes (including `\u00a0` non-breaking spaces), and groups wired + wireless PIDs of the exact same model into a single logical device with wired PIDs ordered first.
   - **USB Discovery:** `detectConnectedDevices()` scans `/sys/bus/usb/devices/*/idVendor` and `idProduct` for vendor `1038`, matching against the `--list` catalog.
   - **Capability Introspection:** `parseHelpCapabilities()` parses `RIVALCFG_DRY=1` `--help` output into a structured capability descriptor (`hasBattery`, `colorZones`, `reactiveColor`, `rainbowEffect`, `lightEffects`, `defaultLighting`, `ledBrightness`, `sensitivity`, `pollingRate`, `sleepTimer`, `dimTimer`). Results are cached per PID.
   - **Command Building:** `buildLightingArgs(state, caps, { noSave })` and `buildSettingsArgs(partialSettings, caps)` strictly emit only flags supported by `caps`. Brightness uses hardware `-l` when available (`0..100`, `0..256`, or discrete choices) and falls back to software RGB scaling otherwise.
   - **Serialized Async Queue:** All `Gio.Subprocess` invocations run through a single FIFO queue with a 5s `GLib.timeout_add` + `Gio.Cancellable` guard. Queued `{ noSave: true }` previews for the same device are coalesced so rapid slider drags/scrolls only send the latest state.
   - **Output Parsing:** `parseBatteryOutput()` inspects combined `stdout + stderr` (because `rivalcfg` exits `0` on sleep) and classifies `charging`, `discharging`, `full`, `sleep`, `disconnected`, `udev_error`, and `unknown`.

2. **`src/stateStore.js`**
   - **Per-Device Persistence:** Stores JSON at `~/.config/rivalcfg-control/<deviceKey>.json` (respecting `XDG_CONFIG_HOME`).
   - **Migration & Seeding:** Migrates legacy `~/.config/aerox3-control/state.json` when loading Aerox 3 Wireless if no new file exists yet; otherwise seeds from `~/.config/rivalcfg/<vid>_<pid>.device.json` using dynamic zone/setting keys (`z1_color`..`z10_color`, `color`, `logo_color`, `wheel_color`, `strip_*`, `reactive_color`, `default_lighting`, `polling_rate`, `sleep_timer`, `dim_timer`, `sensitivity`, `sensitivity1`, `sensitivity2`).
   - **Capability-Aware Validation:** Clamps DPI presets, sleep/dim timers, polling rates, and modes to `caps` bounds when provided.
   - **Battery Estimation:** `recordBatterySample(state, level, isCharging, nowMs)` records distinct discharging level samples and computes remaining discharge minutes once `>= 2` distinct samples exist.

3. **`src/extension.js`**
   - Native `PanelMenu.Button` showing only `rivalcfg-mouse-symbolic.svg` and clean status text (`95%`, `Sleep`, `—`, or blank/`Connected` on wired-only mice without battery).
   - Dynamically constructs popup sections from `device.caps`, renders a device switcher when multiple SteelSeries mice are connected, surfaces missing-binary / `udev` error banners, handles two-tier slider preview/save (`notify::value` + `drag-end` + `block_signal_handler`), refreshes on `PrepareForSleep(false)`, and cleans up all resources on `disable()`.

4. **`src/helpers/color_picker.py`, `src/icons/*`, `src/stylesheet.css`**
   - Out-of-process GTK 4 / libadwaita color dialog (`io.github.yusufkaya00.RivalcfgColorPicker`) and native `.rivalcfg-*` styling.
