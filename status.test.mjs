import test from 'node:test';
import assert from 'node:assert/strict';
import { StatusSettings } from './host/settings.mjs';
import { StatusIndicator } from './status.mjs';

const RADAR = '\u{F0437}';
const STATUS_KEY = 'lan-rpc';
const PRESETS = new Map([
  ['default', {
    leftSegments: ['model', 'path'],
    rightSegments: ['session_name'],
    separator: 'pipe',
    segmentOptions: {},
  }],
  ['nerd', {
    leftSegments: ['hostname', 'model', 'path'],
    rightSegments: ['session_name'],
    separator: 'powerline',
    segmentOptions: {},
  }],
]);

function createSurface(generation) {
  const persisted = new Map(Object.entries({
    'statusLine.preset': 'default',
    'statusLine.leftSegments': ['model', 'path'],
    'statusLine.rightSegments': ['session_name'],
    'statusLine.separator': 'pipe',
    'statusLine.segmentOptions': {},
    'statusLine.showHookStatus': true,
  }));
  const overrides = new Map();
  const read = key => {
    if (!persisted.has(key)) throw new Error(`Unknown test setting: ${key}`);
    return overrides.has(key) ? overrides.get(key) : persisted.get(key);
  };
  const getPreset = name => {
    const preset = PRESETS.get(name);
    if (!preset) throw new Error(`Unknown test preset: ${name}`);
    return preset;
  };

  let rawSettings;
  let settings;
  if (generation === 'legacy') {
    // OMP 18.2.x resolves string keys through methods on Settings.instance.
    rawSettings = {
      get: read,
      override: (key, value) => overrides.set(key, value),
      clearOverride: key => overrides.delete(key),
    };
    settings = new StatusSettings(rawSettings, getPreset);
  } else {
    // OMP 18.8.x Settings.instance has no legacy get/override methods. Registry
    // handles own the typed access to each setting instead.
    rawSettings = {};
    const handles = new Map([...persisted.keys()].map(key => [key, {
      get: () => read(key),
      override: (_settings, value) => overrides.set(key, value),
      clearOverride: () => overrides.delete(key),
    }]));
    settings = new StatusSettings(rawSettings, getPreset, key => handles.get(key));
  }

  const nativeStatus = new Map();
  const ctx = { hasUI: true };
  const indicator = new StatusIndicator({
    loadSettings: async () => settings,
    hasUI: current => current.hasUI,
    setStatus: (_current, key, value) => {
      if (value === undefined) nativeStatus.delete(key);
      else nativeStatus.set(key, value);
    },
  });

  return {
    settings,
    indicator,
    ctx,
    nativeStatus,
    persist: (key, value) => persisted.set(key, value),
    override: (key, value) => settings.override(key, value),
  };
}

for (const generation of ['legacy', 'modern']) {
  test(`${generation} host exposes the LAN indicator through the native status layout`, async () => {
    const { settings, indicator, ctx, nativeStatus } = createSurface(generation);

    await indicator.activate(ctx);
    indicator.set(ctx, 'lan');

    assert.equal(settings.get('statusLine.preset'), 'custom');
    assert.deepEqual(settings.get('statusLine.leftSegments'), ['model', 'path', 'status']);
    assert.deepEqual(settings.get('statusLine.rightSegments'), ['session_name']);
    assert.equal(settings.get('statusLine.showHookStatus'), false);
    assert.equal(nativeStatus.get(STATUS_KEY), RADAR);
  });

  test(`${generation} host restores persisted preferences without erasing a newer override`, async () => {
    const { settings, indicator, ctx, nativeStatus, persist, override } = createSurface(generation);

    await indicator.activate(ctx);
    indicator.set(ctx, 'local');
    persist('statusLine.preset', 'nerd');
    override('statusLine.leftSegments', ['path', 'status', 'time']);

    indicator.dispose(ctx);

    assert.equal(settings.get('statusLine.preset'), 'nerd');
    assert.equal(settings.get('statusLine.showHookStatus'), true);
    assert.deepEqual(settings.get('statusLine.leftSegments'), ['path', 'status', 'time']);
    assert.equal(nativeStatus.has(STATUS_KEY), false);
  });
}
