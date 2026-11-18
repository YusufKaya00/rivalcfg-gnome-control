import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';

import {RivalcfgClient} from './rivalcfgClient.js';
import {loadState, saveState, recordBatterySample} from './stateStore.js';

const BATTERY_POLL_INTERVAL_SECONDS = 60;
const MENU_OPEN_REFRESH_THROTTLE_MS = 10000;
const SLIDER_PREVIEW_DEBOUNCE_MS = 120;
const SLIDER_SETTLE_SAVE_MS = 700;
const COLOR_PICKER_LAUNCH_DELAY_MS = 80;

const COLOR_PRESETS = [
    {name: 'Red', hex: '#ff3b30'},
    {name: 'Orange', hex: '#ff9500'},
    {name: 'Yellow', hex: '#ffcc00'},
    {name: 'Green', hex: '#34c759'},
    {name: 'Cyan', hex: '#00c7be'},
    {name: 'Blue', hex: '#3584e4'},
    {name: 'Purple', hex: '#9b59b6'},
    {name: 'Pink', hex: '#ff2d55'},
    {name: 'White', hex: '#ffffff'},
];

const REACTIVE_COLOR_PRESETS = [
    {name: 'Purple', hex: '#9b59b6'},
    {name: 'Red', hex: '#ff3b30'},
    {name: 'Orange', hex: '#ff9500'},
    {name: 'Green', hex: '#34c759'},
    {name: 'Cyan', hex: '#00c7be'},
    {name: 'Blue', hex: '#3584e4'},
    {name: 'Pink', hex: '#ff2d55'},
    {name: 'White', hex: '#ffffff'},
];

function formatRemainingMinutes(minutes) {
    if (minutes === null || minutes === undefined || !Number.isFinite(minutes))
        return null;
    const total = Math.max(0, Math.round(minutes));
    const hours = Math.floor(total / 60);
    const mins = total % 60;
    if (hours > 0)
        return `~${hours}h ${mins}m left`;
    return `~${mins}m left`;
}

function formatTimeHHMM(date) {
    const h = String(date.getHours()).padStart(2, '0');
    const m = String(date.getMinutes()).padStart(2, '0');
    return `${h}:${m}`;
}

function formatChoiceLabel(choice) {
    return String(choice)
        .split(/[-_]+/)
        .filter(Boolean)
        .map(w => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
}

function arraysEqual(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length)
        return false;
    for (let i = 0; i < a.length; i++) {
        if (Number(a[i]) !== Number(b[i]))
            return false;
    }
    return true;
}

function setActiveStyle(widget, active) {
    if (active) {
        widget.add_style_class_name('active');
        widget.add_style_pseudo_class('checked');
    } else {
        widget.remove_style_class_name('active');
        widget.remove_style_pseudo_class('checked');
    }
}

function getAvailableModes(caps) {
    if (!caps)
        return [];
    const hasColors = Boolean(caps.colorZones && caps.colorZones.length > 0);
    const hasBrightness = Boolean(caps.ledBrightness);
    const modes = [];

    if (hasColors || hasBrightness)
        modes.push({id: 'static', label: 'Static'});
    if (caps.rainbowEffect)
        modes.push({id: 'rainbow', label: 'Rainbow'});
    if (caps.reactiveColor)
        modes.push({id: 'reactive', label: 'Reactive'});
    if (modes.length > 0)
        modes.push({id: 'off', label: 'Off'});

    return modes;
}

function buildSleepTimerOptions(sleepCap) {
    if (!sleepCap)
        return [];
    const min = sleepCap.min ?? 0;
    const max = sleepCap.max ?? 20;
    const candidates = [0, 1, 2, 5, 10, 15, 20];
    const selected = [];

    if (min === 0)
        selected.push(0);
    else if (min > 0 && min <= max)
        selected.push(min);

    for (const c of candidates) {
        if (c === 0 || c < min || c > max)
            continue;
        if (!selected.includes(c) && selected.length < 5)
            selected.push(c);
    }

    return selected.map(value => ({
        value,
        label: value === 0 ? 'Off' : `${value} min`,
    }));
}

function buildDpiProfiles(sensCap) {
    if (!sensCap)
        return [];

    const min = sensCap.min ?? 100;
    const max = sensCap.max ?? 18000;
    const maxPresets = sensCap.maxPresets || 5;

    if (Array.isArray(sensCap.choices) && sensCap.choices.length > 0) {
        const sorted = [...sensCap.choices].sort((a, b) => a - b);
        const low = sorted.slice(0, Math.min(2, maxPresets));
        const high = sorted.slice(Math.max(0, sorted.length - Math.min(2, maxPresets)));
        const profiles = [{id: 'low', label: `Low: ${low.join('/')}`, presets: low}];
        if (!arraysEqual(low, high))
            profiles.push({id: 'high', label: `High: ${high.join('/')}`, presets: high});
        return profiles;
    }

    if (sensCap.type === 'dual' || maxPresets === 2) {
        const clamp = v => Math.min(max, Math.max(min, v));
        const candidates = [
            {id: 'low', name: 'Low', presets: [clamp(400), clamp(800)]},
            {id: 'standard', name: 'Standard', presets: [clamp(800), clamp(1600)]},
            {id: 'high', name: 'High', presets: [clamp(1600), clamp(3200)]},
        ];
        const seen = new Set();
        return candidates
            .filter(p => {
                const key = p.presets.join(',');
                if (seen.has(key))
                    return false;
                seen.add(key);
                return true;
            })
            .map(p => ({
                id: p.id,
                label: `${p.name}: ${p.presets.join('/')}`,
                presets: p.presets,
            }));
    }

    const baseCandidates = [
        {id: 'gaming', name: 'Gaming', presets: [400, 800, 1200, 1600, 3200]},
        {id: 'standard', name: 'Standard', presets: [800, 1200, 1600, 2400, 3200]},
        {id: 'high', name: 'High', presets: [1200, 2400, 3200, 4800, 6400]},
    ];

    const profiles = [];
    const seen = new Set();
    for (const candidate of baseCandidates) {
        let filtered = candidate.presets
            .filter(d => d >= min && d <= max)
            .slice(0, maxPresets);

        if (filtered.length === 0)
            filtered = [Math.min(max, Math.max(min, 800))];

        const key = filtered.join(',');
        if (seen.has(key))
            continue;
        seen.add(key);
        profiles.push({
            id: candidate.id,
            label: `${candidate.name}: ${filtered.join('/')}`,
            presets: filtered,
        });
    }

    return profiles;
}

const RivalcfgIndicator = GObject.registerClass(
class RivalcfgIndicator extends PanelMenu.Button {
    _init(extensionPath, client) {
        super._init(0.0, 'SteelSeries Rivalcfg Control');

        this._extensionPath = extensionPath;
        this._client = client;
        this._destroyed = false;
        this._polling = false;
        this._lastPollAtMs = 0;

        this._devices = [];
        this._activeDeviceKey = null;
        this._deviceStates = new Map();
        this._lastBatteryByDevice = new Map();
        this._lastRenderedSignature = null;
        this._detectError = null;
        this._udevError = false;
        this._lastBatteryPct = 0;
        this._iconCache = new Map();

        this._pollTimerId = 0;
        this._sliderPreviewTimerId = 0;
        this._sliderSettleTimerId = 0;
        this._colorPickerDelayId = 0;
        this._colorPickerCancellable = null;
        this._sleepSignalId = 0;
        this._menuOpenSignalId = 0;
        this._sliderNotifyId = 0;
        this._sliderDragEndId = 0;
        this._barAllocSignalId = 0;

        this._modeButtons = new Map();
        this._zoneButtons = new Map();
        this._zoneDots = new Map();
        this._swatchButtons = new Map();
        this._reactiveSwatchButtons = new Map();
        this._lightEffectButtons = new Map();
        this._defaultLightingButtons = new Map();
        this._pollingButtons = new Map();
        this._sleepButtons = new Map();
        this._dpiButtons = new Map();
        this._dpiProfiles = [];
        this._brightnessSlider = null;
        this._brightnessValueLabel = null;
        this._batteryBarBg = null;
        this._batteryBarFill = null;

        this._buildPanelButton();
        this._buildPopupMenuShell();
        this._subscribeSignals();

        // Immediate discovery & poll on enable, then every 60 seconds.
        this._refreshAll();
        this._pollTimerId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            BATTERY_POLL_INTERVAL_SECONDS,
            () => {
                if (this._destroyed)
                    return GLib.SOURCE_REMOVE;
                this._refreshAll();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    _getSymbolicIcon(filename) {
        if (this._iconCache.has(filename))
            return this._iconCache.get(filename);
        const iconPath = GLib.build_filenamev([this._extensionPath, 'icons', filename]);
        const gicon = Gio.FileIcon.new(Gio.File.new_for_path(iconPath));
        this._iconCache.set(filename, gicon);
        return gicon;
    }

    _buildPanelButton() {
        const box = new St.BoxLayout({
            style_class: 'rivalcfg-panel-box',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._panelIcon = new St.Icon({
            gicon: this._getSymbolicIcon('rivalcfg-mouse-symbolic.svg'),
            icon_size: 16,
            style_class: 'system-status-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._panelLabel = new St.Label({
            text: '—',
            style_class: 'rivalcfg-panel-label',
            y_align: Clutter.ActorAlign.CENTER,
        });

        box.add_child(this._panelIcon);
        box.add_child(this._panelLabel);
        this.add_child(box);
    }

    _createStaticMenuItem() {
        const item = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        if (item._ornamentIcon)
            item._ornamentIcon.visible = false;
        return item;
    }

    _buildPopupMenuShell() {
        const mainItem = this._createStaticMenuItem();
        this._popupContainer = new St.BoxLayout({
            style_class: 'rivalcfg-popup-container',
            vertical: true,
            x_expand: true,
        });
        mainItem.add_child(this._popupContainer);
        this.menu.addMenuItem(mainItem);

        // Multi-device switcher row (shown when >1 device connected)
        this._deviceSwitcherBox = new St.BoxLayout({
            style_class: 'rivalcfg-device-switcher',
            x_expand: true,
            visible: false,
        });
        this._popupContainer.add_child(this._deviceSwitcherBox);

        // Error banner (missing rivalcfg or udev permissions)
        this._errorBannerBox = new St.BoxLayout({
            style_class: 'rivalcfg-error-banner',
            vertical: true,
            x_expand: true,
            visible: false,
        });
        this._errorBannerLabel = new St.Label({
            text: '',
            x_expand: true,
        });
        this._errorBannerLabel.clutter_text.line_wrap = true;
        this._errorBannerBox.add_child(this._errorBannerLabel);
        this._popupContainer.add_child(this._errorBannerBox);

        // Header card (always present)
        this._buildHeaderCard(this._popupContainer);

        // Dynamic lighting container
        this._lightingContainer = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style: 'spacing: 10px;',
        });
        this._popupContainer.add_child(this._lightingContainer);

        // Collapsible Mouse Settings submenu
        this._settingsSeparator = new PopupMenu.PopupSeparatorMenuItem();
        this.menu.addMenuItem(this._settingsSeparator);
        this._settingsSubMenu = new PopupMenu.PopupSubMenuMenuItem('Mouse Settings');
        this.menu.addMenuItem(this._settingsSubMenu);

        this._settingsSubMenu.visible = false;
        this._settingsSeparator.visible = false;
    }

    _buildHeaderCard(parent) {
        const card = new St.BoxLayout({
            style_class: 'rivalcfg-header-card',
            vertical: true,
            x_expand: true,
        });

        const topRow = new St.BoxLayout({
            style_class: 'rivalcfg-header-top-row',
            x_expand: true,
        });

        this._deviceTitleLabel = new St.Label({
            text: 'No SteelSeries Mouse',
            style_class: 'rivalcfg-device-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._connBadge = new St.Label({
            text: 'Offline',
            style_class: 'rivalcfg-conn-badge offline',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._refreshBtn = new St.Button({
            style_class: 'rivalcfg-refresh-btn',
            accessible_name: 'Refresh mouse status',
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({
                icon_name: 'view-refresh-symbolic',
                icon_size: 14,
            }),
        });
        this._refreshBtn.connect('clicked', () => {
            this._refreshAll();
        });

        topRow.add_child(this._deviceTitleLabel);
        topRow.add_child(this._connBadge);
        topRow.add_child(this._refreshBtn);
        card.add_child(topRow);

        // Battery block (hidden for wired-only mice without battery)
        this._batterySectionBox = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style: 'spacing: 8px;',
            visible: false,
        });

        const batteryRow = new St.BoxLayout({
            style_class: 'rivalcfg-battery-row',
            x_expand: true,
        });

        this._batteryPctLabel = new St.Label({
            text: '—',
            style_class: 'rivalcfg-battery-pct',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._batteryMetaLabel = new St.Label({
            text: 'Checking status...',
            style_class: 'rivalcfg-battery-meta',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        batteryRow.add_child(this._batteryPctLabel);
        batteryRow.add_child(this._batteryMetaLabel);
        this._batterySectionBox.add_child(batteryRow);

        this._batteryBarBg = new St.Widget({
            style_class: 'rivalcfg-battery-bar-bg',
            x_expand: true,
            clip_to_allocation: true,
            layout_manager: new Clutter.BinLayout(),
        });

        this._batteryBarFill = new St.Widget({
            style_class: 'rivalcfg-battery-bar-fill',
            x_expand: false,
            y_expand: true,
            x_align: Clutter.ActorAlign.START,
            width: 0,
        });

        this._batteryBarBg.add_child(this._batteryBarFill);
        this._barAllocSignalId = this._batteryBarBg.connect('notify::width', () => {
            this._updateBatteryBarWidth();
        });

        this._batterySectionBox.add_child(this._batteryBarBg);
        card.add_child(this._batterySectionBox);
        parent.add_child(card);
    }

    _getActiveDevice() {
        if (!this._activeDeviceKey)
            return null;
        return this._devices.find(d => d.key === this._activeDeviceKey) || null;
    }

    _getActiveState() {
        const device = this._getActiveDevice();
        if (!device)
            return null;
        if (!this._deviceStates.has(device.key))
            this._deviceStates.set(device.key, loadState(device.key, device.caps, device.pids));
        return this._deviceStates.get(device.key);
    }

    _disconnectDynamicControlSignals() {
        this._clearSliderTimers();
        if (this._brightnessSlider) {
            if (this._sliderNotifyId !== 0) {
                this._brightnessSlider.disconnect(this._sliderNotifyId);
                this._sliderNotifyId = 0;
            }
            if (this._sliderDragEndId !== 0) {
                this._brightnessSlider.disconnect(this._sliderDragEndId);
                this._sliderDragEndId = 0;
            }
        }
        this._brightnessSlider = null;
        this._brightnessValueLabel = null;

        this._modeButtons.clear();
        this._zoneButtons.clear();
        this._zoneDots.clear();
        this._swatchButtons.clear();
        this._reactiveSwatchButtons.clear();
        this._lightEffectButtons.clear();
        this._defaultLightingButtons.clear();
        this._pollingButtons.clear();
        this._sleepButtons.clear();
        this._dpiButtons.clear();
        this._dpiProfiles = [];
    }

    _rebuildDynamicSections() {
        const device = this._getActiveDevice();
        const devicesSig = this._devices.map(d => d.key).join(',');
        const signature = `${devicesSig}|${device ? device.key : 'none'}`;
        if (this._lastRenderedSignature === signature)
            return;
        this._lastRenderedSignature = signature;

        this._disconnectDynamicControlSignals();
        this._deviceSwitcherBox.destroy_all_children();
        this._lightingContainer.destroy_all_children();
        this._settingsSubMenu.menu.removeAll();

        // Device switcher chips if >1 SteelSeries mouse connected
        if (this._devices.length > 1) {
            this._deviceSwitcherBox.visible = true;
            for (const dev of this._devices) {
                const chip = new St.Button({
                    label: dev.name,
                    style_class: 'rivalcfg-device-chip',
                    x_expand: true,
                    can_focus: true,
                });
                setActiveStyle(chip, dev.key === this._activeDeviceKey);
                chip.connect('clicked', () => this._onSelectDevice(dev.key));
                this._deviceSwitcherBox.add_child(chip);
            }
        } else {
            this._deviceSwitcherBox.visible = false;
        }

        if (!device) {
            this._deviceTitleLabel.text = 'No SteelSeries Mouse';
            this._batterySectionBox.visible = false;
            this._lightingContainer.visible = false;
            this._settingsSubMenu.visible = false;
            this._settingsSeparator.visible = false;
            return;
        }

        const caps = device.caps || {};
        const state = this._getActiveState();

        this._deviceTitleLabel.text = device.name;
        this._batterySectionBox.visible = Boolean(caps.hasBattery);

        // Lighting section (only if mouse supports any LED / lighting control)
        const modes = getAvailableModes(caps);
        const zones = Array.isArray(caps.colorZones) ? caps.colorZones : [];
        const hasBrightness = Boolean(caps.ledBrightness) || zones.length > 0 || Boolean(caps.reactiveColor);

        if (modes.length > 0 || zones.length > 0 || hasBrightness) {
            this._lightingContainer.visible = true;
            this._buildLightingSection(this._lightingContainer, caps, state, modes, zones, hasBrightness);
        } else {
            this._lightingContainer.visible = false;
        }

        // Hardware settings submenu
        const hasSettings = this._buildSettingsSubmenu(caps);
        this._settingsSubMenu.visible = hasSettings;
        this._settingsSeparator.visible = hasSettings;

        this._syncControlsFromState();
    }

    _buildLightingSection(parent, caps, state, modes, zones, hasBrightness) {
        if (modes.length > 1) {
            parent.add_child(new St.Label({
                text: 'Lighting Mode',
                style_class: 'rivalcfg-section-label',
            }));

            const modeRow = new St.BoxLayout({
                style_class: 'rivalcfg-pill-row',
                x_expand: true,
            });
            for (const opt of modes) {
                const btn = new St.Button({
                    label: opt.label,
                    style_class: 'rivalcfg-pill-btn',
                    x_expand: true,
                    can_focus: true,
                });
                btn.connect('clicked', () => this._onModeSelected(opt.id));
                this._modeButtons.set(opt.id, btn);
                modeRow.add_child(btn);
            }
            parent.add_child(modeRow);
        }

        if (zones.length > 0) {
            parent.add_child(new St.Label({
                text: zones.length >= 2 ? 'Zone & Color' : 'Color',
                style_class: 'rivalcfg-section-label',
            }));

            if (zones.length >= 2) {
                const zoneRow = new St.BoxLayout({
                    style_class: 'rivalcfg-pill-row',
                    x_expand: true,
                });

                const allBtn = new St.Button({
                    label: 'All',
                    style_class: 'rivalcfg-pill-btn',
                    x_expand: true,
                    can_focus: true,
                });
                allBtn.connect('clicked', () => this._onZoneSelected('all'));
                this._zoneButtons.set('all', allBtn);
                zoneRow.add_child(allBtn);

                for (const zone of zones) {
                    const content = new St.BoxLayout({
                        y_align: Clutter.ActorAlign.CENTER,
                        x_align: Clutter.ActorAlign.CENTER,
                    });
                    const dot = new St.Widget({
                        style_class: 'rivalcfg-zone-dot',
                        y_align: Clutter.ActorAlign.CENTER,
                    });
                    content.add_child(dot);
                    this._zoneDots.set(zone.id, dot);

                    content.add_child(new St.Label({
                        text: zone.label,
                        y_align: Clutter.ActorAlign.CENTER,
                    }));

                    const btn = new St.Button({
                        child: content,
                        style_class: 'rivalcfg-pill-btn',
                        x_expand: true,
                        can_focus: true,
                    });
                    btn.connect('clicked', () => this._onZoneSelected(zone.id));
                    this._zoneButtons.set(zone.id, btn);
                    zoneRow.add_child(btn);
                }
                parent.add_child(zoneRow);
            }

            const swatchRow = new St.BoxLayout({
                style_class: 'rivalcfg-swatch-row',
                x_expand: true,
            });
            for (const preset of COLOR_PRESETS) {
                const btn = new St.Button({
                    style_class: 'rivalcfg-swatch-btn',
                    style: `background-color: ${preset.hex};`,
                    accessible_name: preset.name,
                    can_focus: true,
                    y_align: Clutter.ActorAlign.CENTER,
                });
                btn.connect('clicked', () => this._applyChosenColor(preset.hex));
                this._swatchButtons.set(preset.hex.toLowerCase(), btn);
                swatchRow.add_child(btn);
            }
            parent.add_child(swatchRow);

            const customContent = new St.BoxLayout({
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            });
            customContent.add_child(new St.Icon({
                icon_name: 'color-select-symbolic',
                icon_size: 14,
                y_align: Clutter.ActorAlign.CENTER,
            }));
            customContent.add_child(new St.Label({
                text: ' Custom Color...',
                y_align: Clutter.ActorAlign.CENTER,
            }));

            const customBtn = new St.Button({
                child: customContent,
                style_class: 'rivalcfg-custom-color-btn',
                x_expand: true,
                can_focus: true,
            });
            customBtn.connect('clicked', () => this._openColorPicker());
            parent.add_child(customBtn);
        }

        if (hasBrightness) {
            parent.add_child(new St.Label({
                text: 'Brightness',
                style_class: 'rivalcfg-section-label',
            }));

            const sliderRow = new St.BoxLayout({
                style_class: 'rivalcfg-slider-row',
                x_expand: true,
            });

            sliderRow.add_child(new St.Icon({
                icon_name: 'display-brightness-symbolic',
                icon_size: 16,
                y_align: Clutter.ActorAlign.CENTER,
            }));

            this._brightnessSlider = new Slider((state?.brightness ?? 100) / 100);
            this._brightnessValueLabel = new St.Label({
                text: `${state?.brightness ?? 100}%`,
                style_class: 'rivalcfg-slider-value',
                y_align: Clutter.ActorAlign.CENTER,
            });

            this._sliderNotifyId = this._brightnessSlider.connect('notify::value', () => {
                this._onSliderValueChanged();
            });
            this._sliderDragEndId = this._brightnessSlider.connect('drag-end', () => {
                this._onSliderDragEnd();
            });

            sliderRow.add_child(this._brightnessSlider);
            sliderRow.add_child(this._brightnessValueLabel);
            parent.add_child(sliderRow);
        }
    }

    _buildSettingsSubmenu(caps) {
        const subItem = this._createStaticMenuItem();
        const section = new St.BoxLayout({
            style_class: 'rivalcfg-submenu-section',
            vertical: true,
            x_expand: true,
        });
        subItem.add_child(section);

        let count = 0;

        if (caps.reactiveColor) {
            count++;
            section.add_child(new St.Label({
                text: 'Click Reactive Color',
                style_class: 'rivalcfg-section-label',
            }));
            const reactiveRow = new St.BoxLayout({
                style_class: 'rivalcfg-swatch-row',
                x_expand: true,
            });
            for (const preset of REACTIVE_COLOR_PRESETS) {
                const btn = new St.Button({
                    style_class: 'rivalcfg-swatch-btn',
                    style: `background-color: ${preset.hex};`,
                    accessible_name: preset.name,
                    can_focus: true,
                });
                btn.connect('clicked', () => this._onReactiveColorSelected(preset.hex));
                this._reactiveSwatchButtons.set(preset.hex.toLowerCase(), btn);
                reactiveRow.add_child(btn);
            }
            section.add_child(reactiveRow);
        }

        if (Array.isArray(caps.lightEffects) && caps.lightEffects.length > 0) {
            const firstEffect = caps.lightEffects[0];
            if (Array.isArray(firstEffect.choices) && firstEffect.choices.length > 0) {
                count++;
                section.add_child(new St.Label({
                    text: firstEffect.label || 'Light Effect',
                    style_class: 'rivalcfg-section-label',
                }));
                const effectRow = new St.BoxLayout({
                    style_class: 'rivalcfg-pill-row',
                    x_expand: true,
                });
                for (const choice of firstEffect.choices.slice(0, 5)) {
                    const btn = new St.Button({
                        label: formatChoiceLabel(choice),
                        style_class: 'rivalcfg-pill-btn',
                        x_expand: true,
                        can_focus: true,
                    });
                    btn.connect('clicked', () => this._onLightEffectSelected(choice));
                    this._lightEffectButtons.set(choice, btn);
                    effectRow.add_child(btn);
                }
                section.add_child(effectRow);
            }
        }

        if (caps.defaultLighting && Array.isArray(caps.defaultLighting.choices) && caps.defaultLighting.choices.length > 0) {
            count++;
            section.add_child(new St.Label({
                text: 'Startup Lighting',
                style_class: 'rivalcfg-section-label',
            }));
            const dlRow = new St.BoxLayout({
                style_class: 'rivalcfg-pill-row',
                x_expand: true,
            });
            for (const choice of caps.defaultLighting.choices.slice(0, 4)) {
                const btn = new St.Button({
                    label: formatChoiceLabel(choice),
                    style_class: 'rivalcfg-pill-btn',
                    x_expand: true,
                    can_focus: true,
                });
                btn.connect('clicked', () => this._onDefaultLightingSelected(choice));
                this._defaultLightingButtons.set(choice, btn);
                dlRow.add_child(btn);
            }
            section.add_child(dlRow);
        }

        if (caps.pollingRate && Array.isArray(caps.pollingRate.choices) && caps.pollingRate.choices.length > 0) {
            count++;
            section.add_child(new St.Label({
                text: 'Polling Rate',
                style_class: 'rivalcfg-section-label',
            }));
            const pollingRow = new St.BoxLayout({
                style_class: 'rivalcfg-pill-row',
                x_expand: true,
            });
            for (const rate of caps.pollingRate.choices) {
                const btn = new St.Button({
                    label: `${rate} Hz`,
                    style_class: 'rivalcfg-pill-btn',
                    x_expand: true,
                    can_focus: true,
                });
                btn.connect('clicked', () => this._onPollingRateSelected(rate));
                this._pollingButtons.set(rate, btn);
                pollingRow.add_child(btn);
            }
            section.add_child(pollingRow);
        }

        const sleepOptions = buildSleepTimerOptions(caps.sleepTimer);
        if (sleepOptions.length > 0) {
            count++;
            section.add_child(new St.Label({
                text: 'Sleep Timer',
                style_class: 'rivalcfg-section-label',
            }));
            const sleepRow = new St.BoxLayout({
                style_class: 'rivalcfg-pill-row',
                x_expand: true,
            });
            for (const opt of sleepOptions) {
                const btn = new St.Button({
                    label: opt.label,
                    style_class: 'rivalcfg-pill-btn',
                    x_expand: true,
                    can_focus: true,
                });
                btn.connect('clicked', () => this._onSleepTimerSelected(opt.value));
                this._sleepButtons.set(opt.value, btn);
                sleepRow.add_child(btn);
            }
            section.add_child(sleepRow);
        }

        this._dpiProfiles = buildDpiProfiles(caps.sensitivity);
        if (this._dpiProfiles.length > 0) {
            count++;
            section.add_child(new St.Label({
                text: 'DPI Presets',
                style_class: 'rivalcfg-section-label',
            }));
            const dpiCol = new St.BoxLayout({
                style_class: 'rivalcfg-pill-row',
                vertical: true,
                x_expand: true,
            });
            for (const profile of this._dpiProfiles) {
                const btn = new St.Button({
                    label: profile.label,
                    style_class: 'rivalcfg-pill-btn',
                    x_expand: true,
                    can_focus: true,
                });
                btn.connect('clicked', () => this._onDpiProfileSelected(profile.presets));
                this._dpiButtons.set(profile.id, btn);
                dpiCol.add_child(btn);
            }
            section.add_child(dpiCol);
        }

        if (count === 0)
            return false;

        this._settingsSubMenu.menu.addMenuItem(subItem);
        return true;
    }

    _subscribeSignals() {
        this._menuOpenSignalId = this.menu.connect('open-state-changed', (_menu, isOpen) => {
            if (!isOpen || this._destroyed)
                return;
            const now = Date.now();
            if (now - this._lastPollAtMs >= MENU_OPEN_REFRESH_THROTTLE_MS)
                this._refreshAll();
        });

        try {
            this._sleepSignalId = Gio.DBus.system.signal_subscribe(
                'org.freedesktop.login1',
                'org.freedesktop.login1.Manager',
                'PrepareForSleep',
                '/org/freedesktop/login1',
                null,
                Gio.DBusSignalFlags.NONE,
                (_conn, _sender, _objPath, _iface, _signal, params) => {
                    if (this._destroyed)
                        return;
                    try {
                        const [goingToSleep] = params.deepUnpack();
                        if (!goingToSleep)
                            this._refreshAll();
                    } catch (err) {
                        console.warn(`[Rivalcfg] PrepareForSleep parse error: ${err.message}`);
                    }
                }
            );
        } catch (err) {
            console.warn(`[Rivalcfg] Failed to subscribe to login1 PrepareForSleep: ${err.message}`);
        }
    }

    _syncControlsFromState() {
        const device = this._getActiveDevice();
        const state = this._getActiveState();
        if (!device || !state)
            return;

        for (const [modeId, btn] of this._modeButtons.entries())
            setActiveStyle(btn, state.mode === modeId);

        for (const [zoneId, btn] of this._zoneButtons.entries())
            setActiveStyle(btn, state.zoneTarget === zoneId);

        for (const [zoneId, dot] of this._zoneDots.entries()) {
            const hex = state.colors[zoneId] || '#ff3b30';
            dot.style = `background-color: ${hex};`;
        }

        const targetHex = this._getActiveTargetHex(device, state).toLowerCase();
        const isStatic = state.mode === 'static';
        for (const [hex, btn] of this._swatchButtons.entries())
            setActiveStyle(btn, isStatic && hex === targetHex);

        const reactiveHex = (state.reactiveColor || '#9b59b6').toLowerCase();
        for (const [hex, btn] of this._reactiveSwatchButtons.entries())
            setActiveStyle(btn, hex === reactiveHex);

        for (const [effect, btn] of this._lightEffectButtons.entries())
            setActiveStyle(btn, state.lightEffect === effect);

        for (const [dl, btn] of this._defaultLightingButtons.entries())
            setActiveStyle(btn, state.defaultLighting === dl);

        for (const [rate, btn] of this._pollingButtons.entries())
            setActiveStyle(btn, state.pollingRate === rate);

        for (const [minutes, btn] of this._sleepButtons.entries())
            setActiveStyle(btn, state.sleepTimer === minutes);

        for (const profile of this._dpiProfiles) {
            const btn = this._dpiButtons.get(profile.id);
            if (btn)
                setActiveStyle(btn, arraysEqual(state.dpiPresets, profile.presets));
        }

        if (this._brightnessSlider && this._sliderNotifyId !== 0) {
            this._brightnessSlider.block_signal_handler(this._sliderNotifyId);
            this._brightnessSlider.value = Math.max(0, Math.min(1, state.brightness / 100));
            this._brightnessSlider.unblock_signal_handler(this._sliderNotifyId);
            if (this._brightnessValueLabel)
                this._brightnessValueLabel.text = `${state.brightness}%`;
        }
    }

    _getActiveTargetHex(device, state) {
        const zones = device?.caps?.colorZones || [];
        if (zones.length === 1)
            return state.colors[zones[0].id] || '#ff3b30';

        const target = state.zoneTarget;
        if (target && target !== 'all' && state.colors[target])
            return state.colors[target];
        const firstZoneId = zones[0]?.id;
        return (firstZoneId && state.colors[firstZoneId]) || '#ff3b30';
    }

    _updateErrorBanner() {
        let msg = null;
        if (this._detectError === 'binary_not_found') {
            msg = 'rivalcfg CLI not found. Install it via: pipx install rivalcfg';
        } else if (this._detectError === 'list_failed') {
            msg = 'Failed to run rivalcfg --list. Check your rivalcfg installation.';
        } else if (this._udevError) {
            msg = 'USB permission denied (udev). Run: rivalcfg --update-udev';
        }

        if (msg) {
            this._errorBannerLabel.text = msg;
            this._errorBannerBox.visible = true;
        } else {
            this._errorBannerLabel.text = '';
            this._errorBannerBox.visible = false;
        }
    }

    _handleCommandResult(res) {
        if (res && res.udevError) {
            this._udevError = true;
            this._updateErrorBanner();
        }
    }

    _saveAndApplyLighting({noSave = false} = {}) {
        const device = this._getActiveDevice();
        const state = this._getActiveState();
        if (!device || !state)
            return;

        if (!noSave) {
            const saved = saveState(device.key, state, device.caps);
            this._deviceStates.set(device.key, saved);
        }

        this._client.applyLighting(device, state, {noSave}).then(res => {
            if (!this._destroyed)
                this._handleCommandResult(res);
        }).catch(err => {
            if (!this._destroyed)
                console.warn(`[Rivalcfg] applyLighting failed: ${err.message}`);
        });
    }

    _onSelectDevice(deviceKey) {
        if (deviceKey === this._activeDeviceKey)
            return;
        this._activeDeviceKey = deviceKey;
        this._rebuildDynamicSections();

        const cached = this._lastBatteryByDevice.get(deviceKey);
        if (cached) {
            this._updateBatteryUI(cached.result, cached.estimatedMinutes);
        } else {
            this._lastBatteryPct = 0;
            this._batteryPctLabel.text = '—';
            this._batteryMetaLabel.text = 'Checking status...';
            this._updateBatteryBarWidth();
        }

        this._refreshActiveDeviceBattery();
    }

    _onModeSelected(modeId) {
        const state = this._getActiveState();
        if (!state)
            return;
        state.mode = modeId;
        this._syncControlsFromState();
        this._saveAndApplyLighting({noSave: false});
    }

    _onZoneSelected(zoneId) {
        const device = this._getActiveDevice();
        const state = this._getActiveState();
        if (!device || !state)
            return;
        state.zoneTarget = zoneId;
        this._deviceStates.set(device.key, saveState(device.key, state, device.caps));
        this._syncControlsFromState();
    }

    _applyChosenColor(hex) {
        const device = this._getActiveDevice();
        const state = this._getActiveState();
        if (!device || !state)
            return;

        const normalized = hex.toLowerCase();
        const zones = device.caps?.colorZones || [];
        const target = zones.length === 1 ? zones[0].id : state.zoneTarget;

        if (target && target !== 'all' && zones.some(z => z.id === target)) {
            state.colors[target] = normalized;
        } else {
            for (const zone of zones)
                state.colors[zone.id] = normalized;
        }

        state.mode = 'static';
        this._syncControlsFromState();
        this._saveAndApplyLighting({noSave: false});
    }

    _openColorPicker() {
        const device = this._getActiveDevice();
        const state = this._getActiveState();
        if (this._destroyed || !device || !state || this._colorPickerCancellable || this._colorPickerDelayId !== 0)
            return;

        const initialHex = this._getActiveTargetHex(device, state);
        const targetDeviceKey = device.key;
        // Close menu first so GNOME Shell releases pointer/keyboard grab before GTK4 opens.
        this.menu.close(false);

        this._colorPickerDelayId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            COLOR_PICKER_LAUNCH_DELAY_MS,
            () => {
                this._colorPickerDelayId = 0;
                if (this._destroyed)
                    return GLib.SOURCE_REMOVE;
                this._spawnColorPicker(initialHex, targetDeviceKey);
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _spawnColorPicker(initialHex, targetDeviceKey) {
        const pickerPath = GLib.build_filenamev([this._extensionPath, 'helpers', 'color_picker.py']);
        const cancellable = new Gio.Cancellable();
        this._colorPickerCancellable = cancellable;

        try {
            const proc = Gio.Subprocess.new(
                ['python3', pickerPath, '--initial', initialHex],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );
            proc.communicate_utf8_async(null, cancellable, (source, res) => {
                if (this._colorPickerCancellable === cancellable)
                    this._colorPickerCancellable = null;
                if (this._destroyed)
                    return;
                try {
                    const [, stdout] = source.communicate_utf8_finish(res);
                    if (!source.get_successful())
                        return;
                    const chosen = (stdout || '').trim().toLowerCase();
                    if (/^#[0-9a-f]{6}$/.test(chosen) && this._activeDeviceKey === targetDeviceKey)
                        this._applyChosenColor(chosen);
                } catch (_err) {
                    // Cancelled during disable or dismissed by user.
                }
            });
        } catch (err) {
            if (this._colorPickerCancellable === cancellable)
                this._colorPickerCancellable = null;
            console.warn(`[Rivalcfg] Failed to launch color picker: ${err.message}`);
        }
    }

    _clearSliderTimers() {
        if (this._sliderPreviewTimerId !== 0) {
            GLib.source_remove(this._sliderPreviewTimerId);
            this._sliderPreviewTimerId = 0;
        }
        if (this._sliderSettleTimerId !== 0) {
            GLib.source_remove(this._sliderSettleTimerId);
            this._sliderSettleTimerId = 0;
        }
    }

    _onSliderValueChanged() {
        const state = this._getActiveState();
        if (!state || !this._brightnessSlider)
            return;

        const pct = Math.round(Math.max(0, Math.min(1, this._brightnessSlider.value)) * 100);
        state.brightness = pct;
        if (this._brightnessValueLabel)
            this._brightnessValueLabel.text = `${pct}%`;

        if (this._sliderPreviewTimerId !== 0) {
            GLib.source_remove(this._sliderPreviewTimerId);
            this._sliderPreviewTimerId = 0;
        }
        this._sliderPreviewTimerId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            SLIDER_PREVIEW_DEBOUNCE_MS,
            () => {
                this._sliderPreviewTimerId = 0;
                if (!this._destroyed)
                    this._saveAndApplyLighting({noSave: true});
                return GLib.SOURCE_REMOVE;
            }
        );

        // Settle timer handles scroll-wheel and keyboard adjustments that do not emit drag-end.
        if (this._sliderSettleTimerId !== 0) {
            GLib.source_remove(this._sliderSettleTimerId);
            this._sliderSettleTimerId = 0;
        }
        this._sliderSettleTimerId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            SLIDER_SETTLE_SAVE_MS,
            () => {
                this._sliderSettleTimerId = 0;
                if (this._sliderPreviewTimerId !== 0) {
                    GLib.source_remove(this._sliderPreviewTimerId);
                    this._sliderPreviewTimerId = 0;
                }
                if (!this._destroyed)
                    this._saveAndApplyLighting({noSave: false});
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _onSliderDragEnd() {
        this._clearSliderTimers();
        if (!this._destroyed)
            this._saveAndApplyLighting({noSave: false});
    }

    _applySettingsAndSave(partial) {
        const device = this._getActiveDevice();
        const state = this._getActiveState();
        if (!device || !state)
            return;

        this._deviceStates.set(device.key, saveState(device.key, state, device.caps));
        this._syncControlsFromState();

        this._client.applySettings(device, partial).then(res => {
            if (!this._destroyed)
                this._handleCommandResult(res);
        }).catch(err => {
            if (!this._destroyed)
                console.warn(`[Rivalcfg] applySettings failed: ${err.message}`);
        });
    }

    _onReactiveColorSelected(hex) {
        const device = this._getActiveDevice();
        const state = this._getActiveState();
        if (!device || !state)
            return;

        state.reactiveColor = hex.toLowerCase();
        this._deviceStates.set(device.key, saveState(device.key, state, device.caps));
        this._syncControlsFromState();

        if (state.mode === 'reactive') {
            this._client.applyLighting(device, state, {noSave: false}).then(res => {
                if (!this._destroyed)
                    this._handleCommandResult(res);
            }).catch(err => {
                if (!this._destroyed)
                    console.warn(`[Rivalcfg] reactive color apply failed: ${err.message}`);
            });
        }
    }

    _onLightEffectSelected(effect) {
        const state = this._getActiveState();
        if (!state)
            return;
        state.lightEffect = effect;
        this._applySettingsAndSave({lightEffect: effect});
    }

    _onDefaultLightingSelected(dl) {
        const state = this._getActiveState();
        if (!state)
            return;
        state.defaultLighting = dl;
        this._applySettingsAndSave({defaultLighting: dl});
    }

    _onPollingRateSelected(rate) {
        const state = this._getActiveState();
        if (!state)
            return;
        state.pollingRate = rate;
        this._applySettingsAndSave({pollingRate: rate});
    }

    _onSleepTimerSelected(minutes) {
        const state = this._getActiveState();
        if (!state)
            return;
        state.sleepTimer = minutes;
        this._applySettingsAndSave({sleepTimer: minutes});
    }

    _onDpiProfileSelected(presets) {
        const state = this._getActiveState();
        if (!state)
            return;
        state.dpiPresets = [...presets];
        this._applySettingsAndSave({dpiPresets: presets});
    }

    async _refreshAll() {
        if (this._destroyed || this._polling)
            return;

        this._polling = true;
        this._refreshBtn.reactive = false;

        try {
            const detectRes = await this._client.detectDevices();
            if (this._destroyed)
                return;

            this._lastPollAtMs = Date.now();
            this._detectError = detectRes.ok ? null : (detectRes.error || 'list_failed');
            this._devices = Array.isArray(detectRes.devices) ? detectRes.devices : [];

            if (this._devices.length === 0) {
                this._activeDeviceKey = null;
                this._udevError = false;
                this._rebuildDynamicSections();
                this._updateErrorBanner();
                this._updateBatteryUI({
                    status: 'disconnected',
                    level: null,
                    isCharging: false,
                    connection: 'disconnected',
                }, null);
                return;
            }

            if (!this._activeDeviceKey || !this._devices.some(d => d.key === this._activeDeviceKey))
                this._activeDeviceKey = this._devices[0].key;

            this._rebuildDynamicSections();
            await this._pollActiveDeviceBatteryLocked();
        } catch (err) {
            if (!this._destroyed) {
                console.warn(`[Rivalcfg] refreshAll failed: ${err.message}`);
                this._updateErrorBanner();
                this._updateBatteryUI({
                    status: 'disconnected',
                    level: null,
                    isCharging: false,
                    connection: 'disconnected',
                }, null);
            }
        } finally {
            this._polling = false;
            if (!this._destroyed && this._refreshBtn)
                this._refreshBtn.reactive = true;
        }
    }

    async _refreshActiveDeviceBattery() {
        if (this._destroyed || this._polling)
            return;
        this._polling = true;
        this._refreshBtn.reactive = false;
        try {
            await this._pollActiveDeviceBatteryLocked();
        } finally {
            this._polling = false;
            if (!this._destroyed && this._refreshBtn)
                this._refreshBtn.reactive = true;
        }
    }

    async _pollActiveDeviceBatteryLocked() {
        const device = this._getActiveDevice();
        if (!device)
            return;

        try {
            const result = await this._client.pollBattery(device);
            if (this._destroyed)
                return;

            this._udevError = result.status === 'udev_error';
            this._updateErrorBanner();

            const state = this._getActiveState();
            const isNotDischarging = result.status !== 'discharging';
            let estimatedMinutes = null;

            if (state && result.level !== null && result.level !== undefined) {
                const sample = recordBatterySample(
                    state,
                    result.level,
                    isNotDischarging,
                    Date.now()
                );
                const saved = saveState(device.key, sample.state, device.caps);
                this._deviceStates.set(device.key, saved);
                estimatedMinutes = sample.estimatedMinutes;
            }

            this._lastBatteryByDevice.set(device.key, {result, estimatedMinutes});
            if (this._activeDeviceKey === device.key)
                this._updateBatteryUI(result, estimatedMinutes);
        } catch (err) {
            if (!this._destroyed) {
                console.warn(`[Rivalcfg] pollBattery failed: ${err.message}`);
                this._updateBatteryUI({
                    status: 'disconnected',
                    level: null,
                    isCharging: false,
                    connection: 'disconnected',
                }, null);
            }
        }
    }

    _updateBatteryUI(result, estimatedMinutes) {
        const device = this._getActiveDevice();
        const hasBattery = Boolean(device?.caps?.hasBattery);
        const status = result?.status || 'disconnected';
        const connection = result?.connection || 'disconnected';
        const level = result?.level ?? null;
        const isCharging = Boolean(result?.isCharging || status === 'charging');
        const timeStr = formatTimeHHMM(new Date());

        // Top bar: always show the clean mouse symbol + percentage/status without emojis.
        this._panelIcon.gicon = this._getSymbolicIcon('rivalcfg-mouse-symbolic.svg');

        if (device && (!hasBattery || status === 'wired_only')) {
            this._panelLabel.text = '';
            this._panelLabel.visible = false;
        } else {
            this._panelLabel.visible = true;
            if (status === 'charging' || status === 'discharging') {
                this._panelLabel.text = level !== null ? `${level}%` : '—';
            } else if (status === 'full') {
                const pct = level !== null ? level : 100;
                this._panelLabel.text = `${pct}%`;
            } else if (status === 'sleep') {
                this._panelLabel.text = 'Sleep';
            } else {
                this._panelLabel.text = '—';
            }
        }

        // Connection badge
        this._connBadge.remove_style_class_name('wired');
        this._connBadge.remove_style_class_name('connected');
        this._connBadge.remove_style_class_name('wireless');
        this._connBadge.remove_style_class_name('sleep');
        this._connBadge.remove_style_class_name('offline');

        if (!device) {
            this._connBadge.text = 'Offline';
            this._connBadge.add_style_class_name('offline');
        } else if (!hasBattery || status === 'wired_only') {
            this._connBadge.text = 'Connected';
            this._connBadge.add_style_class_name('connected');
        } else if (status === 'udev_error') {
            this._connBadge.text = 'Permission';
            this._connBadge.add_style_class_name('offline');
        } else if (connection === 'wired') {
            this._connBadge.text = 'Wired';
            this._connBadge.add_style_class_name('wired');
        } else if (connection === 'wireless') {
            this._connBadge.text = '2.4 GHz';
            this._connBadge.add_style_class_name('wireless');
        } else if (connection === 'sleep' || status === 'sleep') {
            this._connBadge.text = 'Sleeping';
            this._connBadge.add_style_class_name('sleep');
        } else {
            this._connBadge.text = 'Offline';
            this._connBadge.add_style_class_name('offline');
        }

        if (!this._batterySectionBox.visible)
            return;

        // Battery percentage & progress bar
        this._batteryBarFill.remove_style_class_name('low');
        this._batteryBarFill.remove_style_class_name('medium');
        this._batteryBarFill.remove_style_class_name('high');
        this._batteryBarFill.remove_style_class_name('charging');

        if (level !== null) {
            this._lastBatteryPct = Math.max(0, Math.min(100, Number(level)));
            this._batteryPctLabel.text = `${this._lastBatteryPct}%`;

            if (isCharging)
                this._batteryBarFill.add_style_class_name('charging');
            else if (this._lastBatteryPct <= 20)
                this._batteryBarFill.add_style_class_name('low');
            else if (this._lastBatteryPct <= 50)
                this._batteryBarFill.add_style_class_name('medium');
            else
                this._batteryBarFill.add_style_class_name('high');
        } else {
            this._lastBatteryPct = 0;
            this._batteryPctLabel.text = status === 'sleep' ? 'Sleep' : '—';
        }
        this._updateBatteryBarWidth();

        // Meta label (charging / estimated remaining / last updated)
        if (status === 'udev_error') {
            this._batteryMetaLabel.text = 'udev permission error';
        } else if (isCharging) {
            this._batteryMetaLabel.text = `Charging · Updated ${timeStr}`;
        } else if (status === 'full') {
            this._batteryMetaLabel.text = `Fully charged · Updated ${timeStr}`;
        } else if (status === 'discharging') {
            const est = formatRemainingMinutes(estimatedMinutes);
            this._batteryMetaLabel.text = est
                ? `${est} · Updated ${timeStr}`
                : `Estimating · Updated ${timeStr}`;
        } else if (status === 'sleep') {
            this._batteryMetaLabel.text = `Mouse is sleeping · Updated ${timeStr}`;
        } else {
            this._batteryMetaLabel.text = `Device not found · Updated ${timeStr}`;
        }
    }

    _updateBatteryBarWidth() {
        if (!this._batteryBarBg || !this._batteryBarFill)
            return;
        const bgWidth = this._batteryBarBg.width;
        if (!Number.isFinite(bgWidth) || bgWidth <= 0)
            return;
        const pct = this._lastBatteryPct ?? 0;
        this._batteryBarFill.set_width(Math.round((bgWidth * pct) / 100));
    }

    _cleanup() {
        if (this._destroyed)
            return;
        this._destroyed = true;

        if (this._pollTimerId !== 0) {
            GLib.source_remove(this._pollTimerId);
            this._pollTimerId = 0;
        }

        this._disconnectDynamicControlSignals();

        if (this._colorPickerDelayId !== 0) {
            GLib.source_remove(this._colorPickerDelayId);
            this._colorPickerDelayId = 0;
        }

        if (this._colorPickerCancellable) {
            try {
                this._colorPickerCancellable.cancel();
            } catch (_e) {
                // Ignore cancel errors during cleanup.
            }
            this._colorPickerCancellable = null;
        }

        if (this._sleepSignalId !== 0) {
            Gio.DBus.system.signal_unsubscribe(this._sleepSignalId);
            this._sleepSignalId = 0;
        }

        if (this._menuOpenSignalId !== 0 && this.menu) {
            this.menu.disconnect(this._menuOpenSignalId);
            this._menuOpenSignalId = 0;
        }

        if (this._batteryBarBg && this._barAllocSignalId !== 0) {
            this._batteryBarBg.disconnect(this._barAllocSignalId);
            this._barAllocSignalId = 0;
        }

        this._iconCache.clear();
        this._deviceStates.clear();
        this._lastBatteryByDevice.clear();
    }

    destroy() {
        this._cleanup();
        super.destroy();
    }
});

export default class RivalcfgControlExtension extends Extension {
    enable() {
        this._client = new RivalcfgClient();
        this._indicator = new RivalcfgIndicator(this.path, this._client);
        Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'right');
    }

    disable() {
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
        if (this._client) {
            this._client.destroy();
            this._client = null;
        }
    }
}
