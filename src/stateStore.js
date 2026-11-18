import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const VALID_MODES = new Set(['static', 'rainbow', 'reactive', 'off']);
const MAX_BATTERY_HISTORY = 24;

const NAMED_COLORS = Object.freeze({
    black: '#000000',
    white: '#ffffff',
    red: '#ff0000',
    lime: '#00ff00',
    green: '#008000',
    blue: '#0000ff',
    yellow: '#ffff00',
    cyan: '#00ffff',
    aqua: '#00ffff',
    magenta: '#ff00ff',
    fuchsia: '#ff00ff',
    purple: '#800080',
    orange: '#ffa500',
    pink: '#ffc0cb',
    silver: '#c0c0c0',
    gray: '#808080',
    grey: '#808080',
    maroon: '#800000',
    olive: '#808000',
    navy: '#000080',
    teal: '#008080',
    off: '#000000',
    disable: '#000000',
});

export const DEFAULT_STATE = Object.freeze({
    mode: 'static',
    zoneTarget: 'all',
    colors: Object.freeze({}),
    brightness: 100,
    reactiveColor: '#9b59b6',
    lightEffect: null,
    defaultLighting: null,
    pollingRate: 1000,
    sleepTimer: 5,
    dimTimer: 30,
    dpiPresets: Object.freeze([400, 800, 1200, 2400, 3200]),
    batteryHistory: Object.freeze([]),
});

function getConfigDir() {
    const xdg = GLib.getenv('XDG_CONFIG_HOME');
    if (xdg && xdg.length > 0)
        return xdg;
    const home = GLib.getenv('HOME');
    if (home && home.length > 0)
        return GLib.build_filenamev([home, '.config']);
    return GLib.get_user_config_dir();
}

function sanitizeDeviceKey(deviceKey) {
    const raw = typeof deviceKey === 'string' && deviceKey.trim().length > 0
        ? deviceKey.trim().toLowerCase()
        : 'default';
    return raw.replace(/[^a-z0-9._-]+/g, '-').replace(/^-|-$/g, '') || 'default';
}

export function getStateFilePath(deviceKey) {
    const safeKey = sanitizeDeviceKey(deviceKey);
    return GLib.build_filenamev([getConfigDir(), 'rivalcfg-control', `${safeKey}.json`]);
}

function getLegacyAerox3StatePath() {
    return GLib.build_filenamev([getConfigDir(), 'aerox3-control', 'state.json']);
}

function getRivalcfgDeviceFilePath(pid) {
    const normalized = String(pid).trim().toLowerCase().replace(':', '_');
    return GLib.build_filenamev([getConfigDir(), 'rivalcfg', `${normalized}.device.json`]);
}

/**
 * Normalize a CSS named color, 3-digit hex, or 6-digit hex (with or without '#')
 * into lowercase `#rrggbb`. Returns `fallback` when unrecognized.
 */
export function normalizeHexColor(value, fallback = '#000000') {
    if (typeof value !== 'string')
        return fallback;
    const trimmed = value.trim().toLowerCase();
    if (!trimmed)
        return fallback;
    if (Object.hasOwn(NAMED_COLORS, trimmed))
        return NAMED_COLORS[trimmed];

    const rawHex = trimmed.startsWith('#') ? trimmed.slice(1) : trimmed;
    if (/^[0-9a-f]{6}$/.test(rawHex))
        return `#${rawHex}`;
    if (/^[0-9a-f]{3}$/.test(rawHex)) {
        const [r, g, b] = rawHex;
        return `#${r}${r}${g}${g}${b}${b}`;
    }
    return fallback;
}

function cloneDefaultState() {
    return {
        mode: DEFAULT_STATE.mode,
        zoneTarget: DEFAULT_STATE.zoneTarget,
        colors: {},
        brightness: DEFAULT_STATE.brightness,
        reactiveColor: DEFAULT_STATE.reactiveColor,
        lightEffect: DEFAULT_STATE.lightEffect,
        defaultLighting: DEFAULT_STATE.defaultLighting,
        pollingRate: DEFAULT_STATE.pollingRate,
        sleepTimer: DEFAULT_STATE.sleepTimer,
        dimTimer: DEFAULT_STATE.dimTimer,
        dpiPresets: [...DEFAULT_STATE.dpiPresets],
        batteryHistory: [],
    };
}

function clampInt(value, min, max, fallback) {
    const num = Number(value);
    if (!Number.isFinite(num))
        return fallback;
    return Math.min(max, Math.max(min, Math.round(num)));
}

function parseDpiList(raw, min = 50, max = 18000, maxPresets = 5, choices = null) {
    let items;
    if (Array.isArray(raw)) {
        items = raw;
    } else if (typeof raw === 'string') {
        items = raw.split(',');
    } else {
        return null;
    }

    const parsed = items
        .map(v => {
            const token = String(v).trim().split(':')[0];
            return Math.round(Number(token));
        })
        .filter(n => {
            if (!Number.isFinite(n))
                return false;
            if (Array.isArray(choices) && choices.length > 0)
                return choices.includes(n);
            return n >= min && n <= max;
        })
        .slice(0, maxPresets);

    return parsed.length > 0 ? parsed : null;
}

function normalizeBatteryHistory(rawHistory) {
    if (!Array.isArray(rawHistory))
        return [];
    return rawHistory
        .filter(item =>
            item &&
            typeof item === 'object' &&
            Number.isFinite(Number(item.t)) &&
            Number.isFinite(Number(item.level)) &&
            Number(item.level) >= 0 &&
            Number(item.level) <= 100
        )
        .map(item => ({
            t: Number(item.t),
            level: Number(item.level),
        }))
        .slice(-MAX_BATTERY_HISTORY);
}

function resolveColorFromMap(colorMap, zone) {
    if (!colorMap || typeof colorMap !== 'object')
        return null;

    const candidates = [
        zone.id,
        zone.id.replace(/-/g, '_'),
        ...(zone.aliases || []),
        ...(zone.aliases || []).map(a => a.replace(/-/g, '_')),
    ];

    for (const key of candidates) {
        if (typeof colorMap[key] === 'string') {
            const hex = normalizeHexColor(colorMap[key], null);
            if (hex)
                return hex;
        }
    }
    return null;
}

function normalizeState(raw, caps = null) {
    const base = cloneDefaultState();
    if (!raw || typeof raw !== 'object')
        raw = {};

    if (VALID_MODES.has(raw.mode))
        base.mode = raw.mode;

    if (typeof raw.zoneTarget === 'string' && raw.zoneTarget.trim().length > 0)
        base.zoneTarget = raw.zoneTarget.trim();

    if (raw.colors && typeof raw.colors === 'object') {
        for (const [k, v] of Object.entries(raw.colors)) {
            if (typeof v === 'string')
                base.colors[k] = normalizeHexColor(v, '#ff3b30');
        }
    }

    if (caps?.colorZones && Array.isArray(caps.colorZones)) {
        const nextColors = {};
        for (const zone of caps.colorZones) {
            const resolved = resolveColorFromMap(base.colors, zone);
            nextColors[zone.id] = resolved || '#ff3b30';
        }
        base.colors = nextColors;

        if (base.zoneTarget !== 'all' && !caps.colorZones.some(z => z.id === base.zoneTarget))
            base.zoneTarget = 'all';
    }

    base.brightness = clampInt(raw.brightness, 0, 100, base.brightness);
    base.reactiveColor = normalizeHexColor(raw.reactiveColor, base.reactiveColor);

    if (typeof raw.lightEffect === 'string' && raw.lightEffect.trim().length > 0)
        base.lightEffect = raw.lightEffect.trim();

    if (typeof raw.defaultLighting === 'string' && raw.defaultLighting.trim().length > 0)
        base.defaultLighting = raw.defaultLighting.trim();

    if (raw.pollingRate !== null && raw.pollingRate !== undefined && Number.isFinite(Number(raw.pollingRate)))
        base.pollingRate = Number(raw.pollingRate);

    if (raw.sleepTimer !== null && raw.sleepTimer !== undefined && Number.isFinite(Number(raw.sleepTimer)))
        base.sleepTimer = Math.round(Number(raw.sleepTimer));

    if (raw.dimTimer !== null && raw.dimTimer !== undefined && Number.isFinite(Number(raw.dimTimer)))
        base.dimTimer = Math.round(Number(raw.dimTimer));

    const dpiMin = caps?.sensitivity?.min ?? 50;
    const dpiMax = caps?.sensitivity?.max ?? 18000;
    const dpiMaxPresets = caps?.sensitivity?.maxPresets ?? 5;
    const dpiChoices = caps?.sensitivity?.choices ?? null;

    const parsedDpi = parseDpiList(raw.dpiPresets, dpiMin, dpiMax, dpiMaxPresets, dpiChoices);
    if (parsedDpi) {
        base.dpiPresets = parsedDpi;
    } else if (caps?.sensitivity) {
        if (dpiChoices && dpiChoices.length > 0) {
            base.dpiPresets = dpiChoices.slice(0, Math.min(2, dpiMaxPresets));
        } else if (caps.sensitivity.type === 'dual') {
            base.dpiPresets = [
                clampInt(800, dpiMin, dpiMax, dpiMin),
                clampInt(1600, dpiMin, dpiMax, dpiMax),
            ];
        } else {
            base.dpiPresets = [400, 800, 1200, 2400, 3200]
                .filter(d => d >= dpiMin && d <= dpiMax)
                .slice(0, dpiMaxPresets);
            if (base.dpiPresets.length === 0)
                base.dpiPresets = [dpiMin];
        }
    }

    if (caps) {
        if (caps.pollingRate) {
            if (!caps.pollingRate.choices.includes(base.pollingRate)) {
                base.pollingRate = caps.pollingRate.choices.includes(1000)
                    ? 1000
                    : (caps.pollingRate.choices[caps.pollingRate.choices.length - 1] ?? null);
            }
        } else {
            base.pollingRate = null;
        }

        if (caps.sleepTimer) {
            base.sleepTimer = clampInt(
                base.sleepTimer ?? caps.sleepTimer.min,
                caps.sleepTimer.min,
                caps.sleepTimer.max,
                Math.min(caps.sleepTimer.max, Math.max(caps.sleepTimer.min, 5))
            );
        } else {
            base.sleepTimer = null;
        }

        if (caps.dimTimer) {
            base.dimTimer = clampInt(
                base.dimTimer ?? caps.dimTimer.min,
                caps.dimTimer.min,
                caps.dimTimer.max,
                Math.min(caps.dimTimer.max, Math.max(caps.dimTimer.min, 30))
            );
        } else {
            base.dimTimer = null;
        }

        if (caps.defaultLighting) {
            if (!caps.defaultLighting.choices.includes(base.defaultLighting))
                base.defaultLighting = caps.defaultLighting.choices[0] ?? null;
        } else {
            base.defaultLighting = null;
        }

        if (caps.lightEffects && caps.lightEffects.length > 0) {
            const firstChoices = caps.lightEffects[0].choices || [];
            if (!firstChoices.includes(base.lightEffect))
                base.lightEffect = firstChoices[0] ?? null;
        } else {
            base.lightEffect = null;
        }

        const hasColors = Boolean(caps.colorZones && caps.colorZones.length > 0);
        const hasBrightness = Boolean(caps.ledBrightness);
        if (base.mode === 'rainbow' && !caps.rainbowEffect)
            base.mode = hasColors || hasBrightness ? 'static' : 'off';
        else if (base.mode === 'reactive' && !caps.reactiveColor)
            base.mode = hasColors || hasBrightness ? 'static' : 'off';
        else if ((base.mode === 'static' || base.mode === 'off') && !hasColors && !hasBrightness)
            base.mode = 'off';
    }

    base.batteryHistory = normalizeBatteryHistory(raw.batteryHistory);
    return base;
}

function readJsonFile(path) {
    const file = Gio.File.new_for_path(path);
    if (!file.query_exists(null))
        return null;
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        if (!ok || !bytes)
            return null;
        const text = new TextDecoder('utf-8').decode(bytes);
        return JSON.parse(text);
    } catch (_e) {
        return null;
    }
}

function isAerox3WirelessDevice(deviceKey, pids = []) {
    const key = sanitizeDeviceKey(deviceKey);
    if (key.includes('aerox-3-wireless'))
        return true;
    return Array.isArray(pids) && pids.some(p => {
        const lower = String(p).toLowerCase();
        return lower === '1038:183a' || lower === '1038:1838';
    });
}

function seedFromRivalcfg(pids = [], caps = null) {
    const seeded = cloneDefaultState();
    let cfg = null;

    for (const pid of pids) {
        const raw = readJsonFile(getRivalcfgDeviceFilePath(pid));
        if (raw && typeof raw === 'object') {
            cfg = raw.default && typeof raw.default === 'object' ? raw.default : raw;
            break;
        }
    }

    if (!cfg)
        return normalizeState(seeded, caps);

    // Dynamic zone seeding from rivalcfg device JSON keys
    for (const [key, val] of Object.entries(cfg)) {
        if (typeof val !== 'string')
            continue;
        if (key === 'reactive_color') {
            const lower = val.trim().toLowerCase();
            if (lower !== 'off' && lower !== 'disable')
                seeded.reactiveColor = normalizeHexColor(val, seeded.reactiveColor);
            continue;
        }
        if (key === 'color' || key.endsWith('_color')) {
            const zoneBase = key.replace(/_color$/, '');
            const hyphenKey = key.replace(/_/g, '-');
            const hex = normalizeHexColor(val, null);
            if (hex) {
                seeded.colors[key] = hex;
                seeded.colors[hyphenKey] = hex;
                seeded.colors[zoneBase] = hex;
            }
        }
    }

    if (caps?.colorZones) {
        for (const zone of caps.colorZones) {
            const fromCfg = resolveColorFromMap(seeded.colors, zone);
            if (fromCfg)
                seeded.colors[zone.id] = fromCfg;
        }
    }

    if (typeof cfg.default_lighting === 'string') {
        const dl = cfg.default_lighting.trim().toLowerCase();
        seeded.defaultLighting = dl;
        if (dl === 'off')
            seeded.mode = 'off';
        else if (dl === 'reactive')
            seeded.mode = 'reactive';
        else if (dl === 'rainbow' || dl === 'reactive-rainbow')
            seeded.mode = 'rainbow';
    }

    if (typeof cfg.light_effect === 'string')
        seeded.lightEffect = cfg.light_effect.trim();
    else if (typeof cfg.logo_light_effect === 'string')
        seeded.lightEffect = cfg.logo_light_effect.trim();

    if (cfg.led_brightness !== undefined) {
        const rawBr = String(cfg.led_brightness).trim().toLowerCase();
        if (rawBr === 'off')
            seeded.brightness = 0;
        else if (rawBr === 'low')
            seeded.brightness = 33;
        else if (rawBr === 'medium')
            seeded.brightness = 66;
        else if (rawBr === 'high')
            seeded.brightness = 100;
        else if (Number.isFinite(Number(rawBr))) {
            const maxHw = caps?.ledBrightness?.type === 'range' ? caps.ledBrightness.max : 100;
            seeded.brightness = Math.round((Number(rawBr) / maxHw) * 100);
        }
    }

    if (cfg.polling_rate !== undefined && Number.isFinite(Number(cfg.polling_rate)))
        seeded.pollingRate = Number(cfg.polling_rate);
    if (cfg.sleep_timer !== undefined && Number.isFinite(Number(cfg.sleep_timer)))
        seeded.sleepTimer = Number(cfg.sleep_timer);
    if (cfg.dim_timer !== undefined && Number.isFinite(Number(cfg.dim_timer)))
        seeded.dimTimer = Number(cfg.dim_timer);

    if (cfg.sensitivity !== undefined) {
        const parsed = parseDpiList(cfg.sensitivity);
        if (parsed)
            seeded.dpiPresets = parsed;
    } else if (cfg.sensitivity1 !== undefined || cfg.sensitivity2 !== undefined) {
        const list = [cfg.sensitivity1, cfg.sensitivity2].filter(v => v !== undefined);
        const parsed = parseDpiList(list);
        if (parsed)
            seeded.dpiPresets = parsed;
    }

    return normalizeState(seeded, caps);
}

/**
 * Load per-device state from `~/.config/rivalcfg-control/<deviceKey>.json`.
 * Falls back to legacy `~/.config/aerox3-control/state.json` for Aerox 3 Wireless,
 * or seeds from `~/.config/rivalcfg/<vid>_<pid>.device.json` when available.
 */
export function loadState(deviceKey, caps = null, pids = []) {
    const statePath = getStateFilePath(deviceKey);
    const existing = readJsonFile(statePath);
    if (existing !== null)
        return normalizeState(existing, caps);

    if (isAerox3WirelessDevice(deviceKey, pids)) {
        const legacy = readJsonFile(getLegacyAerox3StatePath());
        if (legacy !== null)
            return normalizeState(legacy, caps);
    }

    return seedFromRivalcfg(pids, caps);
}

/**
 * Persist normalized per-device state to `~/.config/rivalcfg-control/<deviceKey>.json`.
 */
export function saveState(deviceKey, state, caps = null) {
    const normalized = normalizeState(state, caps);
    const statePath = getStateFilePath(deviceKey);
    const parentDir = GLib.path_get_dirname(statePath);
    const dirFile = Gio.File.new_for_path(parentDir);

    if (!dirFile.query_exists(null)) {
        try {
            dirFile.make_directory_with_parents(null);
        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
                throw e;
        }
    }

    const json = `${JSON.stringify(normalized, null, 2)}\n`;
    GLib.file_set_contents(statePath, json);
    return normalized;
}

/**
 * Record a battery sample and estimate remaining discharge minutes.
 * Returns `{ state, estimatedMinutes }` where `estimatedMinutes` is `null`
 * while charging or when fewer than 2 distinct discharging samples exist.
 */
export function recordBatterySample(state, level, isCharging, nowMs = Date.now()) {
    const nextState = normalizeState(state);
    const numericLevel = Number(level);
    const timestamp = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();

    if (isCharging || level === null || level === undefined || !Number.isFinite(numericLevel)) {
        nextState.batteryHistory = [];
        return { state: nextState, estimatedMinutes: null };
    }

    const clampedLevel = Math.min(100, Math.max(0, numericLevel));
    let history = [...nextState.batteryHistory];
    const last = history.length > 0 ? history[history.length - 1] : null;

    if (!last) {
        history.push({ t: timestamp, level: clampedLevel });
    } else if (clampedLevel > last.level) {
        history = [{ t: timestamp, level: clampedLevel }];
    } else if (clampedLevel < last.level) {
        history.push({ t: timestamp, level: clampedLevel });
    }

    if (history.length > MAX_BATTERY_HISTORY)
        history = history.slice(-MAX_BATTERY_HISTORY);

    nextState.batteryHistory = history;

    if (history.length < 2)
        return { state: nextState, estimatedMinutes: null };

    const first = history[0];
    const latest = history[history.length - 1];
    const levelDrop = first.level - latest.level;
    const elapsedMinutes = (latest.t - first.t) / 60000;

    if (levelDrop <= 0 || elapsedMinutes <= 0)
        return { state: nextState, estimatedMinutes: null };

    const ratePerMinute = levelDrop / elapsedMinutes;
    const estimatedMinutes = Math.max(0, Math.round(latest.level / ratePerMinute));

    return { state: nextState, estimatedMinutes };
}
