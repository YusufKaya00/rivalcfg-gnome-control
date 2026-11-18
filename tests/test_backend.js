import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {
    DEFAULT_STATE,
    getStateFilePath,
    loadState,
    saveState,
    recordBatterySample,
} from '../src/stateStore.js';
import {
    findRivalcfgBin,
    parseListOutput,
    parseHelpCapabilities,
    parseBatteryOutput,
    scaleHexBrightness,
    detectConnectedDevices,
    buildLightingArgs,
    buildSettingsArgs,
    RivalcfgClient,
} from '../src/rivalcfgClient.js';

let passed = 0;
let failed = 0;

function assert(cond, msg) {
    if (!cond)
        throw new Error(`Assertion failed: ${msg}`);
}

function assertEq(actual, expected, msg) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e)
        throw new Error(`${msg}\n  expected: ${e}\n  actual:   ${a}`);
}

async function test(name, fn) {
    try {
        await fn();
        passed += 1;
        print(`PASS: ${name}`);
    } catch (err) {
        failed += 1;
        printerr(`FAIL: ${name}\n  ${err.stack || err}`);
    }
}

function makeTempDir() {
    return GLib.dir_make_tmp('rivalcfg-test-XXXXXX');
}

function rmRf(path) {
    const file = Gio.File.new_for_path(path);
    if (!file.query_exists(null))
        return;
    const type = file.query_file_type(Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
    if (type === Gio.FileType.DIRECTORY) {
        const enumerator = file.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = enumerator.next_file(null)) !== null)
            rmRf(GLib.build_filenamev([path, info.get_name()]));
        enumerator.close(null);
    }
    file.delete(null);
}

function delayMs(ms) {
    return new Promise(resolve => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
}

// Simulated real `rivalcfg --help` outputs across 7+ distinct SteelSeries mouse models
const HELP_AEROX3_WIRELESS = `
usage: rivalcfg [-h] [--no-save]

options:
  -h, --help            show this help message and exit
  --no-save             Do not persist settings in the internal device memory

SteelSeries Aerox 3 Wireless (2.4\u00a0GHz wireless mode) Options:
  -s, --sensitivity SENSITIVITY
                        Set sensitivity presets (DPI) (up to 5 settings, from
                        100 dpi to 18000 dpi, default: '400, 800, 1200, 2400,
                        3200')
  -p, --polling-rate POLLING_RATE
                        Set polling rate (Hz) (values: 125, 250, 500, 1000,
                        default: 1000)
  --top-color, --z1 Z1_COLOR
                        Set the color of the top LED (e.g. red, #ff0000)
  --middle-color, --z2 Z2_COLOR
                        Set the color of the middle LED (e.g. red, #ff0000)
  --bottom-color, --z3 Z3_COLOR
                        Set the color of the bottom LED (e.g. red, #ff0000)
  -a, --reactive-color REACTIVE_COLOR
                        Set the color of the LEDs in reaction to a button
                        click (e.g. off, disable, red, #ff0000, default: off)
  -t, --sleep-timer SLEEP_TIMER
                        Set the IDLE time before the mouse goes to sleep mode
                        (minutes, 0 = disable) (from 0 to 20, default: 5)
  -T, --dim-timer DIM_TIMER
                        Set the IDLE time before the mouse light is dimmed
                        (seconds, 0 = disable) (from 0 to 1200, default: 30)
  -e, --rainbow-effect  Enable the rainbow effect (can be disabled by setting
                        a color)
  -d, --default-lighting DEFAULT_LIGHTING
                        Set default lighting at mouse startup (values: off,
                        reactive, rainbow, reactive-rainbow, default: rainbow)
  -r, --reset           Reset all settings to their factory default
  --battery-level       Print the battery level of the mouse and exit
`;

const HELP_AEROX3_WIRED = `
options:
  --no-save             Do not persist settings in the internal device memory

SteelSeries Aerox 3 Options:
  -s, --sensitivity SENSITIVITY
                        Set sensitivity presets (DPI) (up to 5 settings, from
                        200 dpi to 8500 dpi, default: '800, 1600')
  -p, --polling-rate POLLING_RATE
                        Set polling rate (Hz) (values: 125, 250, 500, 1000,
                        default: 1000)
  --top-color, --z1 Z1_COLOR
                        Set the color of the top LED
  --middle-color, --z2 Z2_COLOR
                        Set the color of the middle LED
  --bottom-color, --z3 Z3_COLOR
                        Set the color of the bottom LED
  -a, --reactive-color REACTIVE_COLOR
                        Set reactive color
  -l, --led-brightness LED_BRIGHTNESS
                        Set the brightness of the LEDs (from 0 to 100,
                        default: 100)
  -e, --rainbow-effect RAINBOW_EFFECT
                        Set the rainbow effect (can be cleared by setting a
                        color) (values: all, bottom, middle, top, bottom-
                        middle, middle-top, bottom-top, default: all)
  -d, --default-lighting DEFAULT_LIGHTING
                        Set default lighting (values: off, reactive, rainbow,
                        reactive-rainbow, default: rainbow)
`;

const HELP_PRIME_WIRELESS = `
options:
  --no-save             Do not persist settings

SteelSeries Prime Wireless (wired mode) Options:
  -s, --sensitivity SENSITIVITY
                        Set sensitivity presets (DPI) (up to 5 settings, from
                        50 dpi to 18000 dpi, default: '400, 800, 1200, 2400,
                        3200')
  -p, --polling-rate POLLING_RATE
                        Set polling rate (Hz) (values: 125, 250, 500, 1000,
                        default: 1000)
  -c, --color COLOR     Set the mouse LED color
  -t, --sleep-timer SLEEP_TIMER
                        Set sleep timer (from 0 to 20, default: 5)
  -T, --dim-timer DIM_TIMER
                        Set dim timer (from 0 to 1200, default: 30)
  -d, --default-lighting DEFAULT_LIGHTING
                        Set default lighting at mouse startup (values: off,
                        rainbow, default: rainbow)
  --battery-level       Print the battery level of the mouse and exit
`;

const HELP_PRIME = `
options:
  --no-save             Do not persist settings

SteelSeries Prime Options:
  -s, --sensitivity SENSITIVITY
                        Set sensitivity presets (DPI) (up to 5 settings, from
                        50 dpi to 18000 dpi, default: '400, 800, 1200, 2400,
                        3200')
  -p, --polling-rate POLLING_RATE
                        Set polling rate (Hz) (values: 125, 250, 500, 1000,
                        default: 1000)
  -c, --color COLOR     Set the color of the wheel LED
  -l, --led-brightness LED_BRIGHTNESS
                        Set the brightness of the wheel LED (from 0 to 256,
                        default: 256)
`;

const HELP_RIVAL_300 = `
options:
  --no-save             Do not persist settings

SteelSeries Rival 300 Options:
  -s, --sensitivity1 SENSITIVITY1
                        Set sensitivity preset 1 (DPI) (from 50 to 6500,
                        default: 800)
  -S, --sensitivity2 SENSITIVITY2
                        Set sensitivity preset 2 (DPI) (from 50 to 6500,
                        default: 1600)
  -p, --polling-rate POLLING_RATE
                        Set polling rate (Hz) (values: 125, 250, 500, 1000,
                        default: 1000)
  -c, --logo-color LOGO_COLOR
                        Set the color of the logo LED
  -C, --wheel-color WHEEL_COLOR
                        Set the color of the wheel LED
  -e, --logo-light-effect LOGO_LIGHT_EFFECT
                        Set the light effect of the logo (values: steady,
                        breath, 1, 2, 3, 4, default: steady)
  -E, --wheel-light-effect WHEEL_LIGHT_EFFECT
                        Set the light effect of the wheel (values: steady,
                        breath, 1, 2, 3, 4, default: steady)
`;

const HELP_RIVAL_650 = `
options:
  --no-save             Do not persist settings

SteelSeries Rival 650 Wireless (2.4\u00a0GHz wireless mode) Options:
  -s, --sensitivity1 SENSITIVITY1
                        Set sensitivity preset 1 (DPI) (from 100 to 12000,
                        default: 800)
  -S, --sensitivity2 SENSITIVITY2
                        Set sensitivity preset 2 (DPI) (from 100 to 12000,
                        default: 1600)
  -p, --polling-rate POLLING_RATE
                        Set polling rate (Hz) (values: 125, 250, 500, 1000,
                        default: 1000)
  -t, --sleep-timer SLEEP_TIMER
                        Set the IDLE time before the mouse goes to sleep mode
                        (minutes) (from 1 to 20, default: 5)
  --battery-level       Print the battery level of the mouse and exit
`;

const HELP_KINZU = `
options:
  --no-save             Do not persist settings

SteelSeries Kinzu v2 Options:
  -s, --sensitivity1 SENSITIVITY1
                        Set sensitivity preset 1 (DPI) (values: 400, 800,
                        1600, 3200, default: 800)
  -S, --sensitivity2 SENSITIVITY2
                        Set sensitivity preset 2 (DPI) (values: 400, 800,
                        1600, 3200, default: 3200)
  -p, --polling-rate POLLING_RATE
                        Set polling rate (Hz) (values: 125, 250, 500, 1000,
                        default: 1000)
`;

const HELP_XY_DEVICE = `
options:
  --no-save             Do not persist settings

SteelSeries XY Mouse Options:
  -s, --sensitivity SENSITIVITY
                        Set sensitivity presets (DPI) (up to 5 settings, from
                        100 dpi to 12000 dpi, default: '800:800, 1600:1600')
`;

await test('parseListOutput handles NBSP, wired-first grouping, and Prime vs Prime Mini distinction', () => {
    const sampleList = `
SteelSeries Aerox 3 Wireless:

  1038:1838 | SteelSeries Aerox 3 Wireless (2.4\u00a0GHz wireless mode)
  1038:183a | SteelSeries Aerox 3 Wireless (wired mode)

SteelSeries Prime Wireless:

  1038:1842 | SteelSeries Prime Wireless (wired mode)
  1038:184a | SteelSeries Prime Mini Wireless (wired mode)

SteelSeries Prime Wireless:

  1038:1840 | SteelSeries Prime Wireless (2.4\u00a0GHz wireless mode)
  1038:1848 | SteelSeries Prime Mini Wireless (2.4\u00a0GHz wireless mode)

SteelSeries Rival 3 Wireless:

  1038:1830 | SteelSeries Rival 3 Wireless (2.4\u00a0GHz mode)
`;
    const parsed = parseListOutput(sampleList);
    assertEq(parsed.length, 4, '4 distinct logical devices');

    const aerox = parsed.find(d => d.name === 'SteelSeries Aerox 3 Wireless');
    assert(aerox, 'Aerox 3 Wireless grouped');
    assertEq(aerox.pids, ['1038:183a', '1038:1838'], 'wired PID ordered before wireless PID');

    const prime = parsed.find(d => d.name === 'SteelSeries Prime Wireless');
    const primeMini = parsed.find(d => d.name === 'SteelSeries Prime Mini Wireless');
    assert(prime && primeMini, 'Prime Wireless and Prime Mini Wireless remain separate');
    assertEq(prime.pids, ['1038:1842', '1038:1840'], 'Prime Wireless PIDs');
    assertEq(primeMini.pids, ['1038:184a', '1038:1848'], 'Prime Mini Wireless PIDs');

    const rival3w = parsed.find(d => d.name === 'SteelSeries Rival 3 Wireless');
    assertEq(rival3w.pids, ['1038:1830'], 'Rival 3 Wireless NBSP stripped');
});

await test('parseHelpCapabilities + buildLightingArgs + buildSettingsArgs across 7 device families', () => {
    // 1. Aerox 3 Wireless (0-arg -e, -a, software brightness)
    const aeroxW = parseHelpCapabilities(HELP_AEROX3_WIRELESS);
    assertEq(aeroxW.hasBattery, true, 'Aerox3W hasBattery');
    assertEq(aeroxW.colorZones.map(z => z.id), ['top-color', 'middle-color', 'bottom-color'], 'Aerox3W zones');
    assertEq(aeroxW.rainbowEffect, { flag: '-e', type: 'none' }, 'Aerox3W 0-arg rainbow');
    assertEq(aeroxW.reactiveColor, { flag: '-a' }, 'Aerox3W reactive');
    assertEq(aeroxW.ledBrightness, null, 'Aerox3W uses software brightness');
    assertEq(
        buildLightingArgs({
            mode: 'static',
            brightness: 50,
            colors: { 'top-color': '#ff0000', 'middle-color': '#00ff00', 'bottom-color': '#0000ff' },
        }, aeroxW, { noSave: true }),
        ['--top-color', '#800000', '--middle-color', '#008000', '--bottom-color', '#000080', '-a', 'off', '--no-save'],
        'Aerox3W static software scaling'
    );
    assertEq(buildLightingArgs({ mode: 'rainbow' }, aeroxW), ['-e'], 'Aerox3W rainbow bare -e');

    // 2. Aerox 3 Wired (choice -e all, -l 0..100, wrapped values)
    const aeroxWired = parseHelpCapabilities(HELP_AEROX3_WIRED);
    assertEq(aeroxWired.hasBattery, false, 'Aerox3 wired no battery');
    assertEq(aeroxWired.rainbowEffect.type, 'choice', 'Aerox3 wired choice -e');
    assert(aeroxWired.rainbowEffect.choices.includes('bottom-middle'), 'wrapped bottom-middle parsed');
    assertEq(aeroxWired.ledBrightness, { flag: '-l', type: 'range', min: 0, max: 100 }, 'Aerox3 wired -l 0..100');
    assertEq(buildLightingArgs({ mode: 'rainbow', brightness: 75 }, aeroxWired), ['-e', 'all', '-l', '75'], 'Aerox3 wired -e all + -l');
    assertEq(
        buildLightingArgs({ mode: 'static', brightness: 50, colors: { 'top-color': '#ff0000' } }, aeroxWired),
        ['--top-color', '#ff0000', '--middle-color', '#ff3b30', '--bottom-color', '#ff3b30', '-l', '50', '-a', 'off'],
        'Aerox3 wired keeps full RGB hex when hw -l exists'
    );

    // 3. Prime Wireless (no -e, no -a, -d rainbow, 50 DPI min)
    const primeW = parseHelpCapabilities(HELP_PRIME_WIRELESS);
    assertEq(primeW.rainbowEffect, null, 'PrimeW no -e');
    assertEq(primeW.reactiveColor, null, 'PrimeW no -a');
    assertEq(primeW.colorZones.map(z => z.flag), ['--color'], 'PrimeW single --color zone');
    assertEq(primeW.sensitivity.min, 50, 'PrimeW min 50 DPI');
    assertEq(
        buildLightingArgs({ mode: 'static', brightness: 100, colors: { color: '#00ff00' } }, primeW),
        ['--color', '#00ff00'],
        'PrimeW never emits -a off'
    );
    assertEq(buildLightingArgs({ mode: 'rainbow' }, primeW), [], 'PrimeW never emits -e');
    assertEq(buildSettingsArgs({ dpiPresets: [50, 800], defaultLighting: 'rainbow' }, primeW), ['-s', '50,800', '-d', 'rainbow'], 'PrimeW settings');

    // 4. Prime (hardware brightness 0..256)
    const prime = parseHelpCapabilities(HELP_PRIME);
    assertEq(prime.ledBrightness, { flag: '-l', type: 'range', min: 0, max: 256 }, 'Prime 0..256 brightness');
    assertEq(
        buildLightingArgs({ mode: 'static', brightness: 50, colors: { color: '#ff0000' } }, prime),
        ['--color', '#ff0000', '-l', '128'],
        'Prime maps 50% -> -l 128'
    );

    // 5. Rival 300 (logo + wheel colors + light effects + dual sensitivity)
    const rival300 = parseHelpCapabilities(HELP_RIVAL_300);
    assertEq(rival300.colorZones.map(z => z.id), ['logo-color', 'wheel-color'], 'Rival 300 logo+wheel');
    assertEq(rival300.lightEffects.length, 2, 'Rival 300 2 light effects');
    assertEq(rival300.sensitivity.type, 'dual', 'Rival 300 dual sensitivity');
    assertEq(
        buildSettingsArgs({ dpiPresets: [400, 1600], lightEffect: 'breath' }, rival300),
        ['-s', '400', '-S', '1600', '-e', 'breath', '-E', 'breath'],
        'Rival 300 dual DPI + light effects'
    );

    // 6. Rival 650 Wireless (sleep 1..20)
    const rival650 = parseHelpCapabilities(HELP_RIVAL_650);
    assertEq(rival650.sleepTimer, { flag: '-t', min: 1, max: 20 }, 'Rival 650 sleep 1..20');
    assertEq(buildSettingsArgs({ sleepTimer: 0 }, rival650), ['-t', '1'], 'Rival 650 clamps sleep=0 to min 1');

    // 7. Kinzu v2 (no LEDs, no battery, discrete sensitivity choices)
    const kinzu = parseHelpCapabilities(HELP_KINZU);
    assertEq(kinzu.hasBattery, false, 'Kinzu no battery');
    assertEq(kinzu.colorZones, [], 'Kinzu no color zones');
    assertEq(kinzu.sensitivity.choices, [400, 800, 1600, 3200], 'Kinzu discrete DPI choices');
    assertEq(buildLightingArgs({ mode: 'static', colors: {} }, kinzu, { noSave: true }), [], 'Kinzu emits no LED args');
    assertEq(buildSettingsArgs({ dpiPresets: [555, 800, 3200] }, kinzu), ['-s', '800', '-S', '3200'], 'Kinzu filters invalid DPI choice');

    // 8. XY sensitivity formatting
    const xyCaps = parseHelpCapabilities(HELP_XY_DEVICE);
    assertEq(xyCaps.sensitivity.hasXY, true, 'detects X:Y sensitivity');
    assertEq(buildSettingsArgs({ dpiPresets: [800, 1600] }, xyCaps), ['-s', '800:800,1600:1600'], 'formats X:Y DPI pairs');
});

await test('parseBatteryOutput handles all states including udev_error', () => {
    assertEq(parseBatteryOutput('Charging [========= ] 95 %'), { status: 'charging', level: 95, isCharging: true }, 'charging');
    assertEq(parseBatteryOutput('Discharging [======    ] 60 %'), { status: 'discharging', level: 60, isCharging: false }, 'discharging');
    assertEq(parseBatteryOutput('Full [==========] 100 %'), { status: 'full', level: 100, isCharging: false }, 'full');
    assertEq(parseBatteryOutput('Unable to get the battery level. Is the mouse turned on?'), { status: 'sleep', level: null, isCharging: false }, 'sleep');
    assertEq(parseBatteryOutput('E: No supported device found'), { status: 'disconnected', level: null, isCharging: false }, 'disconnected');
    assertEq(parseBatteryOutput('Permission denied: unable to open HID device (run rivalcfg --update-udev)'), { status: 'udev_error', level: null, isCharging: false }, 'udev_error');
});

await test('detectConnectedDevices scans USB sysfs and groups wired+wireless PIDs', () => {
    const tmp = makeTempDir();
    try {
        const catalog = parseListOutput(`
  1038:183a | SteelSeries Aerox 3 Wireless (wired mode)
  1038:1838 | SteelSeries Aerox 3 Wireless (2.4\u00a0GHz wireless mode)
  1038:182e | SteelSeries Prime
`);
        const dev1 = GLib.build_filenamev([tmp, '1-1']);
        const dev2 = GLib.build_filenamev([tmp, '1-2']);
        const dev3 = GLib.build_filenamev([tmp, '1-3']);
        for (const d of [dev1, dev2, dev3])
            Gio.File.new_for_path(d).make_directory_with_parents(null);

        GLib.file_set_contents(GLib.build_filenamev([dev1, 'idVendor']), '1038\n');
        GLib.file_set_contents(GLib.build_filenamev([dev1, 'idProduct']), '1838\n');
        GLib.file_set_contents(GLib.build_filenamev([dev2, 'idVendor']), '1038\n');
        GLib.file_set_contents(GLib.build_filenamev([dev2, 'idProduct']), '183a\n');
        GLib.file_set_contents(GLib.build_filenamev([dev3, 'idVendor']), '046d\n');
        GLib.file_set_contents(GLib.build_filenamev([dev3, 'idProduct']), 'c52b\n');

        const detected = detectConnectedDevices(catalog, tmp);
        assertEq(detected.length, 1, '1 SteelSeries logical device');
        assertEq(detected[0].key, 'steelseries-aerox-3-wireless', 'device key');
        assertEq(detected[0].connectedPids, ['1038:183a', '1038:1838'], 'wired ordered before wireless');
    } finally {
        rmRf(tmp);
    }
});

await test('stateStore supports per-device persistence, legacy Aerox 3 migration, and dynamic seeding', () => {
    const tmp = makeTempDir();
    const origXdg = GLib.getenv('XDG_CONFIG_HOME');
    const origHome = GLib.getenv('HOME');

    try {
        GLib.setenv('HOME', tmp, true);
        GLib.setenv('XDG_CONFIG_HOME', GLib.build_filenamev([tmp, '.config']), true);

        const aeroxCaps = parseHelpCapabilities(HELP_AEROX3_WIRELESS);
        const rival300Caps = parseHelpCapabilities(HELP_RIVAL_300);
        const rival650Caps = parseHelpCapabilities(HELP_RIVAL_650);

        // 1. Legacy aerox3-control migration
        const legacyDir = GLib.build_filenamev([tmp, '.config', 'aerox3-control']);
        Gio.File.new_for_path(legacyDir).make_directory_with_parents(null);
        GLib.file_set_contents(
            GLib.build_filenamev([legacyDir, 'state.json']),
            JSON.stringify({
                mode: 'static',
                colors: { z1: '#112233', z2: '#445566', z3: '#778899' },
                brightness: 80,
                pollingRate: 500,
            })
        );

        const migrated = loadState('steelseries-aerox-3-wireless', aeroxCaps, ['1038:183a', '1038:1838']);
        assertEq(migrated.colors, { 'top-color': '#112233', 'middle-color': '#445566', 'bottom-color': '#778899' }, 'legacy z1..z3 migrated');
        assertEq(migrated.brightness, 80, 'legacy brightness migrated');

        // 2. Dynamic seeding from rivalcfg 1038_1710.device.json (Rival 300)
        const rivalDir = GLib.build_filenamev([tmp, '.config', 'rivalcfg']);
        Gio.File.new_for_path(rivalDir).make_directory_with_parents(null);
        GLib.file_set_contents(
            GLib.build_filenamev([rivalDir, '1038_1710.device.json']),
            JSON.stringify({
                default: {
                    sensitivity1: 400,
                    sensitivity2: 1200,
                    polling_rate: 500,
                    logo_color: 'purple',
                    wheel_color: '#00ff00',
                    logo_light_effect: 'breath',
                },
            })
        );

        const rival300State = loadState('steelseries-rival-300', rival300Caps, ['1038:1710']);
        assertEq(rival300State.colors, { 'logo-color': '#800080', 'wheel-color': '#00ff00' }, 'seeded logo+wheel');
        assertEq(rival300State.dpiPresets, [400, 1200], 'seeded sensitivity1/2');
        assertEq(rival300State.lightEffect, 'breath', 'seeded lightEffect');

        // 3. Per-device save/load isolation + caps bounds clamping (Rival 650 sleep min: 1)
        const r650State = loadState('steelseries-rival-650-wireless', rival650Caps, ['1038:1726']);
        r650State.sleepTimer = 0;
        const saved650 = saveState('steelseries-rival-650-wireless', r650State, rival650Caps);
        assertEq(saved650.sleepTimer, 1, 'clamped Rival 650 sleepTimer to min 1');
        assert(Gio.File.new_for_path(getStateFilePath('steelseries-rival-650-wireless')).query_exists(null), 'per-device json saved');

        // 4. Battery estimation
        let bRes = recordBatterySample(saved650, 80, false, 0);
        assertEq(bRes.estimatedMinutes, null, '1 sample -> null');
        bRes = recordBatterySample(bRes.state, 75, false, 600_000);
        assertEq(bRes.estimatedMinutes, 150, '2 samples -> 150 min');
        bRes = recordBatterySample(bRes.state, 76, true, 700_000);
        assertEq(bRes.estimatedMinutes, null, 'charging clears ETA');
        assertEq(bRes.state.batteryHistory, [], 'charging clears history');
    } finally {
        if (origXdg !== null)
            GLib.setenv('XDG_CONFIG_HOME', origXdg, true);
        else
            GLib.unsetenv('XDG_CONFIG_HOME');

        if (origHome !== null)
            GLib.setenv('HOME', origHome, true);
        else
            GLib.unsetenv('HOME');

        rmRf(tmp);
    }
});

await test('RivalcfgClient caches capabilities, handles wired_only/udev_error, and coalesces previews', async () => {
    const executed = [];
    const tmp = makeTempDir();
    try {
        const devDir = GLib.build_filenamev([tmp, '1-1']);
        Gio.File.new_for_path(devDir).make_directory_with_parents(null);
        GLib.file_set_contents(GLib.build_filenamev([devDir, 'idVendor']), '1038\n');
        GLib.file_set_contents(GLib.build_filenamev([devDir, 'idProduct']), '182e\n');

        const client = new RivalcfgClient({
            binPath: '/usr/bin/true',
            usbSysfsDir: tmp,
            runner: async ({ args, profile, env }) => {
                executed.push({ args, profile, env });
                if (args[0] === '--list')
                    return { ok: true, exitCode: 0, combined: '  1038:182e | SteelSeries Prime\n' };
                if (args[0] === '--help')
                    return { ok: true, exitCode: 0, combined: HELP_PRIME };
                await delayMs(20);
                return { ok: true, exitCode: 0, combined: '' };
            },
        });

        const detected = await client.detectDevices();
        assertEq(detected.ok, true, 'detectDevices ok');
        assertEq(detected.devices.length, 1, '1 Prime detected');
        const primeDev = detected.devices[0];
        assertEq(primeDev.caps.ledBrightness.max, 256, 'Prime caps cached');

        // Wired-only mouse skips battery subprocess cleanly
        const batRes = await client.pollBattery(primeDev);
        assertEq(batRes.status, 'wired_only', 'Prime wired_only skips --battery-level');

        // Coalescing rapid noSave previews
        const p1 = client.applyLighting(primeDev, { mode: 'static', brightness: 20, colors: { color: '#ff0000' } }, { noSave: true });
        const p2 = client.applyLighting(primeDev, { mode: 'static', brightness: 40, colors: { color: '#ff0000' } }, { noSave: true });
        const p3 = client.applyLighting(primeDev, { mode: 'static', brightness: 80, colors: { color: '#ff0000' } }, { noSave: true });
        const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
        assertEq(r1.coalesced, undefined, 'p1 executed');
        assertEq(r2.coalesced, true, 'p2 coalesced');
        assertEq(r3.coalesced, undefined, 'p3 executed as latest');

        // udev_error handling on battery poll
        const wirelessDev = {
            key: 'steelseries-aerox-3-wireless',
            name: 'SteelSeries Aerox 3 Wireless',
            pids: ['1038:183a', '1038:1838'],
            connectedPids: ['1038:1838'],
            activeProfile: '1038:1838',
            caps: parseHelpCapabilities(HELP_AEROX3_WIRELESS),
        };
        const udevClient = new RivalcfgClient({
            binPath: '/usr/bin/true',
            runner: async () => ({
                ok: false,
                exitCode: 1,
                combined: 'Permission denied: udev rules missing',
            }),
        });
        const udevBat = await udevClient.pollBattery(wirelessDev);
        assertEq(udevBat.status, 'udev_error', 'detects udev_error on battery poll');

        client.destroy();
        udevClient.destroy();
    } finally {
        rmRf(tmp);
    }
});

await test('RivalcfgClient executes real Gio.Subprocess with timeout guard and destroy', async () => {
    const clientOk = new RivalcfgClient({ binPath: '/bin/sh', timeoutMs: 2000 });
    const okRes = await clientOk._exec(['-c', 'echo "Discharging [=====     ] 50 %"'], '1038:1838', {});
    assertEq(okRes.ok, true, 'real subprocess exits 0');
    assertEq(parseBatteryOutput(okRes.combined).level, 50, 'parsed real output');
    clientOk.destroy();

    const clientTimeout = new RivalcfgClient({ binPath: '/bin/sh', timeoutMs: 120 });
    let timeoutErr = null;
    try {
        await clientTimeout._exec(['-c', 'exec sleep 3'], '1038:1838', {});
    } catch (e) {
        timeoutErr = e;
    }
    assert(timeoutErr !== null && /timed out/i.test(timeoutErr.message), 'real subprocess timed out');
    clientTimeout.destroy();

    assert(findRivalcfgBin() !== null || true, 'findRivalcfgBin runs cleanly without throwing');
});

print(`\nSummary: ${passed} passed, ${failed} failed`);
if (failed > 0)
    imports.system.exit(1);
