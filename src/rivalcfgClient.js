import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import { normalizeHexColor } from './stateStore.js';

const DEFAULT_TIMEOUT_MS = 5000;
const STEELSERIES_VENDOR_ID = '1038';

const IGNORED_HELP_FLAGS = new Set([
    '--help',
    '--list',
    '--version',
    '--no-save',
    '--update-udev',
    '--print-udev',
    '--print-debug',
    '--reset',
    '--buttons',
    '--btn6-mode',
    '--firmware-version',
]);

const ZONE_FRIENDLY_LABELS = Object.freeze({
    'top-color': 'Top',
    'middle-color': 'Middle',
    'bottom-color': 'Bottom',
    'logo-color': 'Logo',
    'wheel-color': 'Wheel',
    'color': 'Color',
});

let _promisifiedSubprocess = false;

function ensureSubprocessPromisified() {
    if (_promisifiedSubprocess)
        return;
    try {
        Gio._promisify(
            Gio.Subprocess.prototype,
            'communicate_utf8_async',
            'communicate_utf8_finish'
        );
    } catch (_e) {
        // Already promisified elsewhere in the Shell process.
    }
    _promisifiedSubprocess = true;
}

function getHomeDir() {
    const envHome = GLib.getenv('HOME');
    if (envHome && envHome.length > 0)
        return envHome;
    return GLib.get_home_dir();
}

/**
 * Dynamically locate the `rivalcfg` executable on PATH or standard install locations.
 */
export function findRivalcfgBin() {
    const inPath = GLib.find_program_in_path('rivalcfg');
    if (inPath)
        return inPath;

    const candidates = [
        GLib.build_filenamev([getHomeDir(), '.local', 'bin', 'rivalcfg']),
        '/usr/local/bin/rivalcfg',
        '/usr/bin/rivalcfg',
    ];

    for (const candidate of candidates) {
        if (GLib.file_test(candidate, GLib.FileTest.IS_EXECUTABLE))
            return candidate;
    }

    return null;
}

function slugifyModelName(name) {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
}

/**
 * Parse `rivalcfg --list` output into logical devices grouped by exact model name,
 * stripping `(wired mode)` and `(2.4 GHz [wireless] mode)` (including `\u00a0` NBSP).
 * Wired PIDs are ordered before wireless PIDs within each logical device.
 */
export function parseListOutput(text) {
    if (typeof text !== 'string' || !text.trim())
        return [];

    const byModel = new Map();

    for (const line of text.split(/\r?\n/)) {
        const match = line.match(/^\s*([0-9a-f]{4}:[0-9a-f]{4})\s*\|\s*(.+?)\s*$/i);
        if (!match)
            continue;

        const pid = match[1].toLowerCase();
        const rawName = match[2].trim();

        const isWireless = /\(2\.4[\s\u00a0]+GHz(?:\s+wireless)?\s+mode\)\s*$/i.test(rawName);
        const isWired = /\(wired\s+mode\)\s*$/i.test(rawName);

        const cleanName = rawName
            .replace(/\s*\((?:wired|2\.4[\s\u00a0]+GHz(?:\s+wireless)?)\s+mode\)\s*$/i, '')
            .trim();

        if (!byModel.has(cleanName)) {
            byModel.set(cleanName, {
                key: slugifyModelName(cleanName),
                name: cleanName,
                wiredPids: [],
                wirelessPids: [],
            });
        }

        const entry = byModel.get(cleanName);
        if (isWireless && !isWired) {
            if (!entry.wirelessPids.includes(pid))
                entry.wirelessPids.push(pid);
        } else if (!entry.wiredPids.includes(pid)) {
            entry.wiredPids.push(pid);
        }
    }

    return Array.from(byModel.values()).map(entry => ({
        key: entry.key,
        name: entry.name,
        wiredPids: entry.wiredPids,
        wirelessPids: entry.wirelessPids,
        pids: [...entry.wiredPids, ...entry.wirelessPids],
    }));
}

function formatZoneLabel(flagName) {
    if (Object.hasOwn(ZONE_FRIENDLY_LABELS, flagName))
        return ZONE_FRIENDLY_LABELS[flagName];

    const zMatch = flagName.match(/^z(\d+)$/i);
    if (zMatch)
        return `Zone ${zMatch[1]}`;

    const words = flagName
        .replace(/-color$/i, '')
        .replace(/^strip-/i, '')
        .split('-')
        .filter(Boolean)
        .map(w => w.charAt(0).toUpperCase() + w.slice(1));

    return words.join(' ') || flagName;
}

function parseValuesList(description) {
    const match = description.match(/\(values:\s*([^)]+)\)/i);
    if (!match)
        return null;

    const raw = match[1].replace(/,\s*default:.*$/i, '');
    const values = raw
        .split(',')
        .map(v => v.trim())
        .filter(Boolean);

    return values.length > 0 ? values : null;
}

function splitOptionEntries(helpText) {
    const lines = String(helpText || '').split(/\r?\n/);

    // Locate the device-specific Options section (capital 'Options:'), or fall back to full text.
    let startIdx = 0;
    for (let i = 0; i < lines.length; i++) {
        if (/^\S.*Options:\s*$/.test(lines[i])) {
            startIdx = i + 1;
            break;
        }
    }

    const entries = [];
    let current = null;

    for (let i = startIdx; i < lines.length; i++) {
        const line = lines[i];
        if (/^Please report any bug/i.test(line))
            break;

        const optStart = line.match(/^\s{1,4}(-[A-Za-z0-9](?:,\s*-[A-Za-z0-9]|,\s*--[a-z0-9-]+)*|--[a-z0-9-]+(?:,\s*--[a-z0-9-]+)*)(.*)$/i);
        if (optStart) {
            if (current)
                entries.push(current);

            const flagsPart = optStart[1];
            const rest = optStart[2] || '';
            const restParts = rest.match(/^\s*(?:[A-Z0-9_]+)?\s{2,}(.+)$/);

            current = {
                flagsRaw: flagsPart,
                descLines: restParts ? [restParts[1].trim()] : [],
            };
            continue;
        }

        if (current && line.trim().length > 0) {
            // If an option header wrapped onto its own description line (`                        Set ...`)
            // or wrapped mid-argument list, append cleanly.
            const trimmed = line.trim();
            if (current.descLines.length === 0) {
                current.descLines.push(trimmed);
            } else {
                const prev = current.descLines[current.descLines.length - 1];
                if (prev.endsWith('-') && /^[a-z0-9]/i.test(trimmed))
                    current.descLines[current.descLines.length - 1] = `${prev}${trimmed}`;
                else
                    current.descLines.push(trimmed);
            }
        }
    }

    if (current)
        entries.push(current);

    return entries.map(entry => {
        const tokens = entry.flagsRaw.split(',').map(t => t.trim()).filter(Boolean);
        const shortFlag = tokens.find(t => /^-[A-Za-z0-9]$/.test(t)) || null;
        const longFlags = tokens.filter(t => /^--[a-z0-9-]+$/i.test(t));
        const primaryLong = longFlags.find(f => !/^--z\d+$/i.test(f)) || longFlags[0] || shortFlag;
        const description = entry.descLines.join(' ').replace(/\s+/g, ' ').trim();
        return { tokens, shortFlag, longFlags, primaryLong, description };
    });
}

/**
 * Parse `RIVALCFG_DRY=1 RIVALCFG_PROFILE=<pid> rivalcfg --help` output into a structured
 * capability descriptor for dynamic UI and CLI command generation.
 */
export function parseHelpCapabilities(helpText) {
    const caps = {
        hasBattery: false,
        colorZones: [],
        reactiveColor: null,
        rainbowEffect: null,
        lightEffects: [],
        defaultLighting: null,
        ledBrightness: null,
        sensitivity: null,
        pollingRate: null,
        sleepTimer: null,
        dimTimer: null,
        supportsNoSave: /--no-save\b/.test(String(helpText || '')),
    };

    const entries = splitOptionEntries(helpText);

    for (const entry of entries) {
        const { shortFlag, longFlags, primaryLong, description } = entry;
        if (!primaryLong)
            continue;
        if (longFlags.some(f => IGNORED_HELP_FLAGS.has(f)))
            continue;

        if (longFlags.includes('--battery-level')) {
            caps.hasBattery = true;
            continue;
        }

        if (longFlags.includes('--reactive-color') || shortFlag === '-a') {
            caps.reactiveColor = { flag: shortFlag || primaryLong };
            continue;
        }

        // RGB / gradient color zone flags (excluding --reactive-color handled above)
        if (longFlags.some(f => /-color$/i.test(f) || /^--z\d+$/i.test(f)) || primaryLong === '--color') {
            const flag = primaryLong;
            const id = flag.replace(/^--/, '');
            const aliases = longFlags
                .filter(f => f !== flag)
                .map(f => f.replace(/^--/, ''));

            caps.colorZones.push({
                id,
                flag,
                label: formatZoneLabel(id),
                aliases,
                supportsGradient: /rgbgradient/i.test(description),
            });
            continue;
        }

        if (longFlags.includes('--rainbow-effect')) {
            const choices = parseValuesList(description);
            if (choices)
                caps.rainbowEffect = { flag: shortFlag || primaryLong, type: 'choice', choices };
            else
                caps.rainbowEffect = { flag: shortFlag || primaryLong, type: 'none' };
            continue;
        }

        if (longFlags.some(f => f === '--light-effect' || f.endsWith('-light-effect'))) {
            const choices = parseValuesList(description);
            if (choices) {
                const label = primaryLong
                    .replace(/^--/, '')
                    .replace(/-light-effect$/, '')
                    .replace(/^light-effect$/, 'Light Effect');
                caps.lightEffects.push({
                    flag: shortFlag || primaryLong,
                    longFlag: primaryLong,
                    label: label === 'Light Effect' ? 'Light Effect' : `${formatZoneLabel(label)} Effect`,
                    choices,
                });
            }
            continue;
        }

        if (longFlags.includes('--default-lighting') || shortFlag === '-d') {
            const choices = parseValuesList(description);
            if (choices)
                caps.defaultLighting = { flag: shortFlag || primaryLong, choices };
            continue;
        }

        if (longFlags.includes('--led-brightness') || shortFlag === '-l') {
            const rangeMatch = description.match(/\(from\s+(\d+)\s+to\s+(\d+)/i);
            if (rangeMatch) {
                caps.ledBrightness = {
                    flag: shortFlag || primaryLong,
                    type: 'range',
                    min: Number(rangeMatch[1]),
                    max: Number(rangeMatch[2]),
                };
            } else {
                const choices = parseValuesList(description);
                if (choices) {
                    caps.ledBrightness = {
                        flag: shortFlag || primaryLong,
                        type: 'choice',
                        choices,
                    };
                }
            }
            continue;
        }

        if (longFlags.includes('--sensitivity')) {
            const maxPresetsMatch = description.match(/up to\s+(\d+)\s+settings/i);
            const rangeMatch = description.match(/from\s+(\d+)(?:\s*dpi)?\s+to\s+(\d+)(?:\s*dpi)?/i);
            const values = parseValuesList(description);
            const defaultMatch = description.match(/default:\s*'([^']+)'/i);

            caps.sensitivity = {
                type: 'multi',
                flag: shortFlag || primaryLong,
                maxPresets: maxPresetsMatch ? Number(maxPresetsMatch[1]) : 5,
                min: rangeMatch ? Number(rangeMatch[1]) : (values ? Math.min(...values.map(Number)) : 100),
                max: rangeMatch ? Number(rangeMatch[2]) : (values ? Math.max(...values.map(Number)) : 18000),
                choices: values ? values.map(Number).filter(Number.isFinite) : null,
                hasXY: defaultMatch ? defaultMatch[1].includes(':') : false,
            };
            continue;
        }

        if (longFlags.includes('--sensitivity1') || longFlags.includes('--sensitivity2')) {
            const rangeMatch = description.match(/from\s+(\d+)(?:\s*dpi)?\s+to\s+(\d+)(?:\s*dpi)?/i);
            const values = parseValuesList(description);
            const choices = values ? values.map(Number).filter(Number.isFinite) : null;
            const min = rangeMatch ? Number(rangeMatch[1]) : (choices ? Math.min(...choices) : 100);
            const max = rangeMatch ? Number(rangeMatch[2]) : (choices ? Math.max(...choices) : 18000);

            if (!caps.sensitivity || caps.sensitivity.type !== 'dual') {
                caps.sensitivity = {
                    type: 'dual',
                    flags: ['-s', '-S'],
                    maxPresets: 2,
                    min,
                    max,
                    choices,
                    hasXY: false,
                };
            }
            continue;
        }

        if (longFlags.includes('--polling-rate') || shortFlag === '-p') {
            const values = parseValuesList(description);
            if (values) {
                const choices = values.map(Number).filter(Number.isFinite);
                if (choices.length > 0)
                    caps.pollingRate = { flag: shortFlag || primaryLong, choices };
            }
            continue;
        }

        if (longFlags.includes('--sleep-timer') || shortFlag === '-t') {
            const rangeMatch = description.match(/\(from\s+(\d+)\s+to\s+(\d+)/i);
            if (rangeMatch) {
                caps.sleepTimer = {
                    flag: shortFlag || primaryLong,
                    min: Number(rangeMatch[1]),
                    max: Number(rangeMatch[2]),
                };
            }
            continue;
        }

        if (longFlags.includes('--dim-timer') || shortFlag === '-T') {
            const rangeMatch = description.match(/\(from\s+(\d+)\s+to\s+(\d+)/i);
            if (rangeMatch) {
                caps.dimTimer = {
                    flag: shortFlag || primaryLong,
                    min: Number(rangeMatch[1]),
                    max: Number(rangeMatch[2]),
                };
            }
        }
    }

    return caps;
}

/**
 * Parse combined stdout+stderr output from `rivalcfg --battery-level`.
 * Detects udev permission errors and sleep exit-0 messages explicitly.
 */
export function parseBatteryOutput(text) {
    const str = typeof text === 'string' ? text : '';

    if (/(?:Permission denied|Access denied|Failed to open|udev)/i.test(str))
        return { status: 'udev_error', level: null, isCharging: false };

    if (/Unable to get the battery level/i.test(str))
        return { status: 'sleep', level: null, isCharging: false };

    if (/No supported device found/i.test(str))
        return { status: 'disconnected', level: null, isCharging: false };

    const chargingMatch = str.match(/\bCharging\b[^\d\n]*(\d+)\s*%/i);
    if (chargingMatch) {
        const level = Math.min(100, Math.max(0, Number(chargingMatch[1])));
        return { status: 'charging', level, isCharging: true };
    }

    const dischargingMatch = str.match(/\bDischarging\b[^\d\n]*(\d+)\s*%/i);
    if (dischargingMatch) {
        const level = Math.min(100, Math.max(0, Number(dischargingMatch[1])));
        return { status: 'discharging', level, isCharging: false };
    }

    const fullMatch = str.match(/\bFull\b[^\d\n]*(\d+)\s*%/i);
    if (fullMatch) {
        const level = Math.min(100, Math.max(0, Number(fullMatch[1])));
        return { status: 'full', level, isCharging: false };
    }

    return { status: 'unknown', level: null, isCharging: false };
}

/**
 * Scale an RGB hex color by `brightnessPct` (0..100), returning `#rrggbb`.
 */
export function scaleHexBrightness(hex, brightnessPct) {
    const normalized = normalizeHexColor(hex, '#000000');
    const pct = Number.isFinite(Number(brightnessPct))
        ? Math.min(100, Math.max(0, Number(brightnessPct)))
        : 100;

    if (pct <= 0)
        return '#000000';
    if (pct >= 100)
        return normalized;

    const r = Math.min(255, Math.max(0, Math.round((parseInt(normalized.slice(1, 3), 16) * pct) / 100)));
    const g = Math.min(255, Math.max(0, Math.round((parseInt(normalized.slice(3, 5), 16) * pct) / 100)));
    const b = Math.min(255, Math.max(0, Math.round((parseInt(normalized.slice(5, 7), 16) * pct) / 100)));

    const toHex = n => n.toString(16).padStart(2, '0');
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function readSmallSysfsFile(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        if (!ok || !bytes)
            return null;
        return new TextDecoder('utf-8').decode(bytes).trim();
    } catch (_e) {
        return null;
    }
}

/**
 * Scan `/sys/bus/usb/devices/*` for SteelSeries USB devices (`idVendor === '1038'`)
 * and match against the `--list` catalog.
 */
export function detectConnectedDevices(catalog = [], usbSysfsDir = '/sys/bus/usb/devices') {
    const dirFile = Gio.File.new_for_path(usbSysfsDir);
    if (!dirFile.query_exists(null) || !Array.isArray(catalog) || catalog.length === 0)
        return [];

    const connectedPids = new Set();
    let enumerator = null;

    try {
        enumerator = dirFile.enumerate_children(
            'standard::name',
            Gio.FileQueryInfoFlags.NONE,
            null
        );
        let info;
        while ((info = enumerator.next_file(null)) !== null) {
            const devName = info.get_name();
            const devPath = GLib.build_filenamev([usbSysfsDir, devName]);
            const vendor = readSmallSysfsFile(GLib.build_filenamev([devPath, 'idVendor']));
            if (!vendor || vendor.toLowerCase() !== STEELSERIES_VENDOR_ID)
                continue;
            const product = readSmallSysfsFile(GLib.build_filenamev([devPath, 'idProduct']));
            if (product && /^[0-9a-f]{4}$/i.test(product))
                connectedPids.add(`${STEELSERIES_VENDOR_ID}:${product.toLowerCase()}`);
        }
    } catch (_e) {
        return [];
    } finally {
        if (enumerator) {
            try {
                enumerator.close(null);
            } catch (_e) {
                // Ignore enumerator close errors.
            }
        }
    }

    const matched = [];
    for (const device of catalog) {
        const deviceConnected = device.pids.filter(pid => connectedPids.has(pid));
        if (deviceConnected.length === 0)
            continue;

        // Order wired PIDs before wireless PIDs
        const wiredSet = new Set(device.wiredPids || []);
        const orderedConnected = [
            ...deviceConnected.filter(p => wiredSet.has(p)),
            ...deviceConnected.filter(p => !wiredSet.has(p)),
        ];

        matched.push({
            key: device.key,
            name: device.name,
            pids: [...device.pids],
            connectedPids: orderedConnected,
            activeProfile: orderedConnected[0],
        });
    }

    return matched;
}

function resolveZoneColor(colors, zone) {
    if (!colors || typeof colors !== 'object')
        return '#ff3b30';

    const candidates = [
        zone.id,
        ...(zone.aliases || []),
        zone.id.replace(/-/g, '_'),
    ];

    for (const key of candidates) {
        if (typeof colors[key] === 'string')
            return normalizeHexColor(colors[key], '#ff3b30');
    }

    return '#ff3b30';
}

function buildBrightnessArgs(brightnessPct, ledBrightnessCap) {
    if (!ledBrightnessCap)
        return [];

    const pct = Number.isFinite(Number(brightnessPct))
        ? Math.min(100, Math.max(0, Number(brightnessPct)))
        : 100;

    if (ledBrightnessCap.type === 'range') {
        const min = ledBrightnessCap.min ?? 0;
        const max = ledBrightnessCap.max ?? 100;
        const hwVal = Math.round(min + ((max - min) * pct) / 100);
        return [ledBrightnessCap.flag, String(hwVal)];
    }

    if (ledBrightnessCap.type === 'choice' && Array.isArray(ledBrightnessCap.choices)) {
        const choices = ledBrightnessCap.choices;
        let pick;
        if (pct <= 0 && choices.includes('off'))
            pick = 'off';
        else if (pct <= 33 && choices.includes('low'))
            pick = 'low';
        else if (pct <= 66 && choices.includes('medium'))
            pick = 'medium';
        else if (choices.includes('high'))
            pick = 'high';
        else
            pick = choices[choices.length - 1];

        if (pick)
            return [ledBrightnessCap.flag, pick];
    }

    return [];
}

/**
 * Build batched `rivalcfg` CLI arguments for lighting state, strictly emitting only
 * flags supported by `caps`.
 */
export function buildLightingArgs(state, caps, { noSave = false } = {}) {
    if (!caps || typeof caps !== 'object')
        return [];

    const s = state && typeof state === 'object' ? state : {};
    const mode = s.mode || 'static';
    const brightness = s.brightness ?? 100;
    const zones = Array.isArray(caps.colorZones) ? caps.colorZones : [];
    const hasHwBrightness = Boolean(caps.ledBrightness);
    const args = [];

    if (mode === 'rainbow') {
        if (caps.rainbowEffect) {
            if (caps.rainbowEffect.type === 'choice') {
                const choices = caps.rainbowEffect.choices || ['all'];
                const chosen = s.rainbowEffect && choices.includes(s.rainbowEffect)
                    ? s.rainbowEffect
                    : (choices.includes('all') ? 'all' : choices[0]);
                args.push(caps.rainbowEffect.flag, chosen);
            } else {
                args.push(caps.rainbowEffect.flag);
            }
            if (hasHwBrightness)
                args.push(...buildBrightnessArgs(brightness, caps.ledBrightness));
        }
    } else if (mode === 'reactive' && caps.reactiveColor) {
        for (const zone of zones)
            args.push(zone.flag, 'black');
        const reactiveHex = scaleHexBrightness(s.reactiveColor || '#9b59b6', hasHwBrightness ? 100 : brightness);
        args.push(caps.reactiveColor.flag, reactiveHex);
        if (hasHwBrightness)
            args.push(...buildBrightnessArgs(brightness, caps.ledBrightness));
    } else if (mode === 'off') {
        if (caps.ledBrightness?.type === 'choice' && caps.ledBrightness.choices.includes('off')) {
            args.push(caps.ledBrightness.flag, 'off');
        } else {
            for (const zone of zones)
                args.push(zone.flag, 'black');
            if (caps.reactiveColor)
                args.push(caps.reactiveColor.flag, 'off');
            if (zones.length === 0 && caps.ledBrightness?.type === 'range')
                args.push(...buildBrightnessArgs(0, caps.ledBrightness));
        }
    } else {
        // Static mode (or fallback if reactive requested on device without -a)
        const scalePct = hasHwBrightness ? 100 : brightness;
        for (const zone of zones) {
            const hex = resolveZoneColor(s.colors, zone);
            args.push(zone.flag, scaleHexBrightness(hex, scalePct));
        }
        if (hasHwBrightness)
            args.push(...buildBrightnessArgs(brightness, caps.ledBrightness));
        if (caps.reactiveColor)
            args.push(caps.reactiveColor.flag, 'off');
    }

    if (args.length > 0 && noSave && caps.supportsNoSave !== false)
        args.push('--no-save');

    return args;
}

/**
 * Build batched `rivalcfg` CLI arguments for hardware/settings updates, strictly emitting
 * only flags supported by `caps`.
 */
export function buildSettingsArgs(partialSettings, caps) {
    if (!partialSettings || typeof partialSettings !== 'object' || !caps || typeof caps !== 'object')
        return [];

    const args = [];

    if (partialSettings.dpiPresets !== undefined && caps.sensitivity) {
        const rawList = Array.isArray(partialSettings.dpiPresets)
            ? partialSettings.dpiPresets
            : String(partialSettings.dpiPresets).split(',');

        const sens = caps.sensitivity;
        const dpis = rawList
            .map(v => Math.round(Number(String(v).trim().split(':')[0])))
            .filter(n => {
                if (!Number.isFinite(n))
                    return false;
                if (Array.isArray(sens.choices) && sens.choices.length > 0)
                    return sens.choices.includes(n);
                return n >= sens.min && n <= sens.max;
            })
            .slice(0, sens.maxPresets || 5);

        if (dpis.length > 0) {
            if (sens.type === 'dual') {
                if (dpis[0] !== undefined)
                    args.push(sens.flags[0], String(dpis[0]));
                if (dpis[1] !== undefined)
                    args.push(sens.flags[1], String(dpis[1]));
            } else {
                const formatted = sens.hasXY
                    ? dpis.map(d => `${d}:${d}`).join(',')
                    : dpis.join(',');
                args.push(sens.flag, formatted);
            }
        }
    }

    if (partialSettings.pollingRate !== undefined && caps.pollingRate) {
        const rate = Number(partialSettings.pollingRate);
        if (caps.pollingRate.choices.includes(rate))
            args.push(caps.pollingRate.flag, String(rate));
    }

    if (partialSettings.sleepTimer !== undefined && caps.sleepTimer) {
        const sleep = Number(partialSettings.sleepTimer);
        if (Number.isFinite(sleep)) {
            const clamped = Math.min(caps.sleepTimer.max, Math.max(caps.sleepTimer.min, Math.round(sleep)));
            args.push(caps.sleepTimer.flag, String(clamped));
        }
    }

    if (partialSettings.dimTimer !== undefined && caps.dimTimer) {
        const dim = Number(partialSettings.dimTimer);
        if (Number.isFinite(dim)) {
            const clamped = Math.min(caps.dimTimer.max, Math.max(caps.dimTimer.min, Math.round(dim)));
            args.push(caps.dimTimer.flag, String(clamped));
        }
    }

    if (partialSettings.defaultLighting !== undefined && caps.defaultLighting) {
        const dl = String(partialSettings.defaultLighting).trim().toLowerCase();
        if (caps.defaultLighting.choices.includes(dl))
            args.push(caps.defaultLighting.flag, dl);
    }

    if (partialSettings.lightEffect !== undefined && Array.isArray(caps.lightEffects)) {
        const effect = String(partialSettings.lightEffect).trim();
        for (const le of caps.lightEffects) {
            if (le.choices.includes(effect))
                args.push(le.flag, effect);
        }
    }

    if (partialSettings.reactiveColor !== undefined && caps.reactiveColor) {
        const rawRc = String(partialSettings.reactiveColor).trim().toLowerCase();
        if (rawRc === 'off' || rawRc === 'disable') {
            args.push(caps.reactiveColor.flag, 'off');
        } else {
            const scalePct = caps.ledBrightness ? 100 : (partialSettings.brightness ?? 100);
            args.push(caps.reactiveColor.flag, scaleHexBrightness(rawRc, scalePct));
        }
    }

    return args;
}

/**
 * Generalized async client for any SteelSeries device supported by `rivalcfg`.
 * Serializes subprocess calls, caches RIVALCFG_DRY=1 capabilities per PID,
 * coalesces queued `noSave` previews per device, and guards calls with a 5s timeout.
 */
export class RivalcfgClient {
    constructor({
        binPath = undefined,
        timeoutMs = DEFAULT_TIMEOUT_MS,
        runner = null,
        usbSysfsDir = '/sys/bus/usb/devices',
    } = {}) {
        this._explicitBinPath = binPath;
        this._resolvedBinPath = binPath !== undefined ? binPath : undefined;
        this._timeoutMs = timeoutMs;
        this._customRunner = runner;
        this._usbSysfsDir = usbSysfsDir;
        this._catalogCache = null;
        this._capsCache = new Map();
        this._destroyed = false;
        this._queue = [];
        this._running = false;
        this._currentCancellable = null;
        this._currentProc = null;
    }

    get binPath() {
        if (this._resolvedBinPath === undefined)
            this._resolvedBinPath = findRivalcfgBin();
        return this._resolvedBinPath;
    }

    get destroyed() {
        return this._destroyed;
    }

    /**
     * Discover connected SteelSeries devices and load/cache their capabilities.
     */
    async detectDevices() {
        if (this._destroyed)
            throw new Error('RivalcfgClient destroyed');

        if (!this.binPath && !this._customRunner)
            return { ok: false, error: 'binary_not_found', devices: [] };

        if (!this._catalogCache) {
            const listRes = await this._enqueue({
                kind: 'list',
                run: () => this._exec(['--list'], null, {}),
            });
            if (!listRes.ok && !listRes.combined)
                return { ok: false, error: 'list_failed', devices: [] };
            this._catalogCache = parseListOutput(listRes.combined);
        }

        const connected = detectConnectedDevices(this._catalogCache, this._usbSysfsDir);
        for (const dev of connected) {
            const primaryPid = dev.connectedPids[0] || dev.pids[0];
            dev.caps = await this.getCapabilities(primaryPid);
        }

        return { ok: true, error: null, devices: connected };
    }

    /**
     * Introspect and cache capabilities for a PID using `RIVALCFG_DRY=1`.
     */
    async getCapabilities(pid) {
        const key = String(pid).toLowerCase();
        if (this._capsCache.has(key))
            return this._capsCache.get(key);

        const res = await this._enqueue({
            kind: 'help',
            run: () => this._exec(['--help'], key, { RIVALCFG_DRY: '1' }),
        });

        const caps = parseHelpCapabilities(res.combined);
        this._capsCache.set(key, caps);
        return caps;
    }

    /**
     * Poll battery status for a logical device, trying its wired/active profiles first.
     */
    pollBattery(device) {
        if (!device || !device.caps || !device.caps.hasBattery) {
            const profile = device?.activeProfile || device?.connectedPids?.[0] || device?.pids?.[0] || null;
            return Promise.resolve({
                status: 'wired_only',
                level: null,
                isCharging: false,
                connection: 'wired',
                profile,
                raw: '',
            });
        }

        const candidates = this._orderedProfilesForDevice(device);

        return this._enqueue({
            kind: 'pollBattery',
            deviceKey: device.key,
            run: async () => {
                let lastRaw = '';
                let sawSleep = null;

                for (const profile of candidates) {
                    const res = await this._exec(['--battery-level'], profile, {});
                    const parsed = parseBatteryOutput(res.combined);
                    lastRaw = res.combined || lastRaw;

                    if (parsed.status === 'udev_error') {
                        return {
                            ...parsed,
                            connection: 'udev_error',
                            profile,
                            raw: res.combined,
                        };
                    }

                    if (parsed.status === 'charging' ||
                        parsed.status === 'discharging' ||
                        parsed.status === 'full') {
                        device.activeProfile = profile;
                        const isWired = (device.pids || []).indexOf(profile) === 0 &&
                            (device.pids || []).length > 1;
                        const connection = (device.connectedPids?.length === 1 &&
                            device.pids?.length > 1 &&
                            device.pids[1] === profile)
                            ? 'wireless'
                            : (isWired ? 'wired' : (parsed.isCharging ? 'wired' : 'wireless'));

                        return {
                            ...parsed,
                            connection,
                            profile,
                            raw: res.combined,
                        };
                    }

                    if (parsed.status === 'sleep')
                        sawSleep = { parsed, profile, raw: res.combined };
                }

                if (sawSleep) {
                    device.activeProfile = sawSleep.profile;
                    return {
                        ...sawSleep.parsed,
                        connection: 'sleep',
                        profile: sawSleep.profile,
                        raw: sawSleep.raw,
                    };
                }

                device.activeProfile = null;
                return {
                    status: 'disconnected',
                    level: null,
                    isCharging: false,
                    connection: 'disconnected',
                    profile: null,
                    raw: lastRaw,
                };
            },
        });
    }

    /**
     * Apply lighting state to a logical device. Queued `noSave: true` previews for the same
     * device are coalesced so rapid slider drags only transmit the latest state.
     */
    applyLighting(device, state, { noSave = false } = {}) {
        const args = buildLightingArgs(state, device?.caps, { noSave });
        if (args.length === 0)
            return Promise.resolve({ ok: true, skipped: true, args: [] });

        return this._enqueue({
            kind: 'lighting',
            deviceKey: device?.key || 'default',
            noSave: Boolean(noSave),
            run: () => this._execForDevice(device, args),
        });
    }

    /**
     * Apply hardware settings to a logical device.
     */
    applySettings(device, partialSettings) {
        const args = buildSettingsArgs(partialSettings, device?.caps);
        if (args.length === 0)
            return Promise.resolve({ ok: true, skipped: true, args: [] });

        return this._enqueue({
            kind: 'settings',
            deviceKey: device?.key || 'default',
            noSave: false,
            run: () => this._execForDevice(device, args),
        });
    }

    /**
     * Cancel active subprocess and reject queued tasks cleanly.
     */
    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;

        if (this._currentCancellable) {
            try {
                this._currentCancellable.cancel();
            } catch (_e) {
                // Ignore cancel errors.
            }
        }
        if (this._currentProc) {
            try {
                this._currentProc.force_exit();
            } catch (_e) {
                // Ignore force_exit errors.
            }
        }

        const pending = this._queue.splice(0, this._queue.length);
        for (const task of pending)
            task.reject(new Error('RivalcfgClient destroyed'));
    }

    _orderedProfilesForDevice(device) {
        const set = new Set();
        if (device?.activeProfile)
            set.add(device.activeProfile);
        for (const p of device?.connectedPids || [])
            set.add(p);
        for (const p of device?.pids || [])
            set.add(p);
        return Array.from(set);
    }

    async _execForDevice(device, args) {
        const candidates = this._orderedProfilesForDevice(device);
        if (candidates.length === 0)
            return this._exec(args, null, {});

        let lastRes = null;
        for (const profile of candidates) {
            const res = await this._exec(args, profile, {});
            lastRes = { ...res, profile };
            const parsed = parseBatteryOutput(res.combined);
            if (parsed.status === 'udev_error')
                return { ...lastRes, udevError: true };
            if (res.ok && parsed.status !== 'disconnected') {
                device.activeProfile = profile;
                return lastRes;
            }
        }

        return lastRes;
    }

    _enqueue(task) {
        if (this._destroyed)
            return Promise.reject(new Error('RivalcfgClient destroyed'));

        return new Promise((resolve, reject) => {
            if (task.kind === 'lighting') {
                for (let i = this._queue.length - 1; i >= 0; i--) {
                    const queued = this._queue[i];
                    if (queued.kind === 'lighting' && queued.noSave && queued.deviceKey === task.deviceKey) {
                        this._queue.splice(i, 1);
                        queued.resolve({ ok: true, coalesced: true, skipped: true });
                    }
                }
            }

            this._queue.push({ ...task, resolve, reject });
            this._drain();
        });
    }

    async _drain() {
        if (this._running)
            return;
        this._running = true;

        try {
            while (this._queue.length > 0 && !this._destroyed) {
                const task = this._queue.shift();
                try {
                    const result = await task.run();
                    task.resolve(result);
                } catch (err) {
                    task.reject(err);
                }
            }
        } finally {
            this._running = false;
        }
    }

    async _exec(args, profile, extraEnv = {}) {
        if (this._destroyed)
            throw new Error('RivalcfgClient destroyed');

        const bin = this.binPath;
        if (!bin && !this._customRunner)
            throw new Error('rivalcfg binary not found');

        const cancellable = new Gio.Cancellable();
        this._currentCancellable = cancellable;

        let timeoutId = 0;
        let timedOut = false;

        if (this._timeoutMs > 0) {
            timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._timeoutMs, () => {
                timedOut = true;
                timeoutId = 0;
                try {
                    cancellable.cancel();
                } catch (_e) {
                    // Ignore cancel errors.
                }
                if (this._currentProc) {
                    try {
                        this._currentProc.force_exit();
                    } catch (_e) {
                        // Ignore force_exit errors.
                    }
                }
                return GLib.SOURCE_REMOVE;
            });
        }

        try {
            if (this._customRunner) {
                return await this._customRunner({
                    binPath: bin,
                    args,
                    profile,
                    env: extraEnv,
                    cancellable,
                });
            }

            ensureSubprocessPromisified();

            const launcher = new Gio.SubprocessLauncher({
                flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
            });
            if (profile)
                launcher.setenv('RIVALCFG_PROFILE', profile, true);
            for (const [k, v] of Object.entries(extraEnv))
                launcher.setenv(k, String(v), true);

            const proc = launcher.spawnv([bin, ...args]);
            this._currentProc = proc;

            const [stdout, stderr] = await proc.communicate_utf8_async(null, cancellable);
            const exitCode = proc.get_successful() ? 0 : proc.get_exit_status();
            const outStr = stdout || '';
            const errStr = stderr || '';
            const combined = [outStr.trim(), errStr.trim()].filter(Boolean).join('\n');

            return {
                ok: exitCode === 0,
                exitCode,
                stdout: outStr,
                stderr: errStr,
                combined,
            };
        } catch (err) {
            if (timedOut)
                throw new Error(`rivalcfg timed out after ${this._timeoutMs}ms`);
            if (this._destroyed || (err.matches && err.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)))
                throw new Error('rivalcfg subprocess cancelled');
            throw err;
        } finally {
            if (timeoutId !== 0)
                GLib.source_remove(timeoutId);
            this._currentProc = null;
            this._currentCancellable = null;
        }
    }
}
