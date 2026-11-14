import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostAdapter } from './host/adapters/index.mjs';
import { createRequestExecutor } from './host/execution.mjs';
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

class TestText {}
const testTui = { Text: TestText, matchesKey: (data, key) => data === key };

function preset(name) {
  const value = PRESETS.get(name);
  if (!value) throw new Error(`Unknown test preset: ${name}`);
  return value;
}

async function createSurface(generation) {
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
  let rawSettings;
  let lookup;
  if (generation === 'legacy') {
    rawSettings = {
      get: read,
      override: (key, value) => overrides.set(key, value),
      clearOverride: key => overrides.delete(key),
    };
  } else {
    rawSettings = {};
    const handles = new Map([...persisted.keys()].map(key => [key, {
      get: () => read(key),
      override: (_settings, value) => overrides.set(key, value),
      clearOverride: () => overrides.delete(key),
    }]));
    lookup = key => handles.get(key);
  }
  const loaded = [];
  const adapter = await createHostAdapter({
    pi: {
      VERSION: generation === 'legacy' ? '18.2.6' : '18.17.0',
      Text: TestText,
      AgentRegistry: { global: () => ({ list: () => [] }) },
      Settings: { instance: rawSettings },
    },
  }, {
    async loadModule(specifier) {
      loaded.push(specifier);
      if (specifier === '@oh-my-pi/pi-tui') return testTui;
      if (specifier === '@oh-my-pi/pi-tui/status-line/presets') return { getPreset: preset };
      if (specifier === '@oh-my-pi/pi-coding-agent/config/registry') return { lookup };
      throw new Error(`Unexpected test import: ${specifier}`);
    },
  });
  const settings = await adapter.loadSettings();
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
    adapter,
    loaded,
    settings,
    indicator,
    ctx,
    nativeStatus,
    persist: (key, value) => persisted.set(key, value),
    override: (key, value) => settings.override(key, value),
  };
}

for (const generation of ['legacy', 'modern']) {
  test(`${generation} OMP settings era exposes the LAN indicator through the native status layout`, async () => {
    const { adapter, loaded, settings, indicator, ctx, nativeStatus } = await createSurface(generation);

    await indicator.activate(ctx);
    indicator.set(ctx, 'lan');

    assert.deepEqual(adapter.identity, {
      harness: 'omp',
      version: generation === 'legacy' ? '18.2.6' : '18.17.0',
    });
    assert.equal(adapter.capabilities.features.lanRpcExecution, true);
    assert.equal(adapter.capabilities.features.statusSettings, true);
    assert.equal(loaded.includes('@oh-my-pi/pi-coding-agent/config/registry'), generation === 'modern');
    assert.equal(settings.get('statusLine.preset'), 'custom');
    assert.deepEqual(settings.get('statusLine.leftSegments'), ['model', 'path', 'status']);
    assert.deepEqual(settings.get('statusLine.rightSegments'), ['session_name']);
    assert.equal(settings.get('statusLine.showHookStatus'), false);
    assert.equal(nativeStatus.get(STATUS_KEY), RADAR);
  });

  test(`${generation} OMP settings era restores persisted preferences without erasing a newer override`, async () => {
    const { settings, indicator, ctx, nativeStatus, persist, override } = await createSurface(generation);

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

test('queued requests remain visible as the count changes and clear when waiting ends', async () => {
  for (const generation of ['legacy', 'modern']) {
    const { indicator, ctx, nativeStatus } = await createSurface(generation);
    await indicator.activate(ctx);
    indicator.set(ctx, 'local', 1);
    assert.equal(nativeStatus.get(STATUS_KEY), `${RADAR} queued: 1`);
    indicator.set(ctx, 'local', 2);
    assert.equal(nativeStatus.get(STATUS_KEY), `${RADAR} queued: 2`);
    indicator.set(ctx, 'local', 0);
    assert.equal(nativeStatus.get(STATUS_KEY), RADAR);
    indicator.set(ctx, 'error', 2);
    assert.equal(nativeStatus.get(STATUS_KEY), '!');
    indicator.dispose(ctx);
    assert.equal(nativeStatus.has(STATUS_KEY), false);
  }
});

test('Pi queue status refreshes without adding widgets or loading native settings', async () => {
  let visible;
  const ctx = { hasUI: true };
  const indicator = new StatusIndicator({
    statusMode: 'extension',
    hasUI: current => current.hasUI,
    setStatus: (_ctx, _key, value) => { visible = value; },
  });
  await indicator.activate(ctx);
  indicator.set(ctx, 'local', 3);
  assert.equal(visible, `${RADAR} queued: 3`);
  indicator.set(ctx, 'local', 0);
  assert.equal(visible, RADAR);
  indicator.dispose(ctx);
  assert.equal(visible, undefined);
});

test('extension status mode uses the host inline status slot without native layout settings', async () => {
  const updates = [];
  const ctx = { hasUI: true };
  const indicator = new StatusIndicator({
    statusMode: 'extension',
    loadSettings: async () => { throw new Error('extension mode must not load OMP settings'); },
    hasUI: current => current.hasUI,
    setStatus: (_current, key, value) => updates.push({ key, value }),
  });

  await indicator.prepareAtLoad();
  await indicator.activate(ctx);
  indicator.set(ctx, 'local');
  indicator.dispose(ctx);

  assert.deepEqual(updates, [
    { key: STATUS_KEY, value: RADAR },
    { key: STATUS_KEY, value: undefined },
  ]);
});

test('OMP adapter owns registry lookup and native tool call signature conversion', async () => {
  const parent = { sessionManager: { getSessionId: () => 'session' } };
  const adapter = await createHostAdapter({
    pi: {
      VERSION: '18.17.0',
      Text: TestText,
      Settings: { instance: { get() {}, override() {}, clearOverride() {} } },
      AgentRegistry: { global: () => ({ get: id => id === 'Main' ? { session: parent } : undefined }) },
    },
  }, { loadModule: async specifier => {
    if (specifier === '@oh-my-pi/pi-tui') return testTui;
    throw new Error(`Unexpected test import: ${specifier}`);
  } });
  const ctx = { agent: { id: 'Main' }, sessionManager: { getSessionId: () => 'session' } };
  assert.strictEqual(adapter.resolveSession(ctx), parent);

  let call;
  const definition = adapter.defineTool({
    name: 'lookup',
    parameters: adapter.parameters({ type: 'object' }),
    async execute(value) { call = value; return { content: [] }; },
  });
  const signal = new AbortController().signal;
  const onUpdate = () => {};
  const toolContext = {};
  const result = await definition.execute('call-id', { key: 'value' }, signal, onUpdate, toolContext);

  assert.deepEqual(result, { content: [] });
  assert.equal(call.toolCallId, 'call-id');
  assert.deepEqual(call.params, { key: 'value' });
  assert.strictEqual(call.signal, signal);
  assert.strictEqual(call.onUpdate, onUpdate);
  assert.strictEqual(call.context, toolContext);
});

test('Pi adapter loads without OMP imports and exposes the public conversation boundary', async () => {
  const loaded = [];
  const sessionManager = { getSessionId: () => 'pi-session', getBranch: () => [] };
  const api = {
    on() {},
    registerTool() {},
    sendMessage() {},
    getAllTools: () => [],
    getActiveTools: () => [],
    setActiveTools() {},
  };
  const adapter = await createHostAdapter(api, {
    async loadModule(specifier) {
      loaded.push(specifier);
      if (specifier === '@earendil-works/pi-coding-agent') return { VERSION: '1.5.0' };
      if (specifier === '@earendil-works/pi-tui') return testTui;
      const error = new Error(`Cannot find package ${specifier}`);
      error.code = 'ERR_MODULE_NOT_FOUND';
      throw error;
    },
  });
  const raw = {
    mode: 'tui',
    hasUI: false,
    cwd: '/workspace',
    ui: {},
    sessionManager,
    isIdle: () => true,
    abort() {},
    hasPendingMessages: () => false,
  };
  const ctx = adapter.adaptContext(raw);

  assert.deepEqual(adapter.identity, { harness: 'pi', version: '1.5.0' });
  assert.equal(adapter.capabilities.features.extensionLoad, true);
  assert.equal(adapter.capabilities.features.lanRpcExecution, true);
  assert.equal(adapter.capabilities.features.statusSettings, false);
  assert.equal(adapter.capabilities.statusMode, 'extension');
  assert.equal(ctx.hasUI, true);
  assert.strictEqual(ctx.ui, raw.ui);
  assert.strictEqual(ctx.sessionManager, sessionManager);
  assert.equal(typeof ctx.setInterval, 'function');
  assert.equal(typeof ctx.clearTimer, 'function');
  assert.strictEqual(adapter.resolveSession(ctx), adapter.resolveSession(ctx));
  assert.equal(loaded.some(specifier => specifier.startsWith('@oh-my-pi/')), false);

  const executor = createRequestExecutor(adapter, ctx);
  assert.equal(executor.supported, true);
  assert.deepEqual(executor.reservedToolNames, []);
});

test('unexpected OMP settings failures propagate instead of becoming unsupported-host results', async () => {
  const expected = new Error('settings storage is corrupt');
  const adapter = await createHostAdapter({
    pi: {
      VERSION: '18.17.0',
      Text: TestText,
      AgentRegistry: { global: () => ({ list: () => [] }) },
      Settings: { get instance() { throw expected; } },
    },
  }, { loadModule: async specifier => {
    if (specifier === '@oh-my-pi/pi-tui') return testTui;
    throw new Error(`Unexpected test import: ${specifier}`);
  } });

  await assert.rejects(adapter.loadSettings(), error => error === expected);
});

test('missing OMP settings capability reports a stable unsupported-host error and explicit list', async () => {
  const adapter = await createHostAdapter({ pi: {
    VERSION: 'test',
    Text: TestText,
    AgentRegistry: { global: () => ({ list: () => [] }) },
  } }, {
    loadModule: async specifier => {
      if (specifier === '@oh-my-pi/pi-tui') return testTui;
      throw new Error(`Unexpected test import: ${specifier}`);
    },
  });

  assert.equal(adapter.capabilities.features.lanRpcExecution, true);
  assert.equal(adapter.capabilities.features.statusSettings, false);
  assert.deepEqual(adapter.capabilities.missing, ['statusSettings']);
  await assert.rejects(adapter.loadSettings(), error => error.code === 'host_unsupported');
});

test('OMP capability probe checks selected-session operations when context is supplied', async () => {
  const parent = { sessionManager: { getSessionId: () => 'session' }, messages: [] };
  const adapter = await createHostAdapter({
    pi: {
      VERSION: '18.17.0',
      Text: TestText,
      Settings: { instance: { get() {}, override() {}, clearOverride() {} } },
      AgentRegistry: { global: () => ({ get: () => ({ session: parent }) }) },
    },
  }, {
    agent: { id: 'Main' },
    sessionManager: { getSessionId: () => 'session' },
    loadModule: async specifier => {
      if (specifier === '@oh-my-pi/pi-tui') return testTui;
      throw new Error(`Unexpected test import: ${specifier}`);
    },
  });

  assert.equal(adapter.capabilities.features.lanRpcExecution, false);
  assert.deepEqual(adapter.capabilities.missing.slice(0, 4), [
    'rpcToolRegistry', 'nativePrompt', 'nativeEvents', 'nativeCancellation',
  ]);
  assert.match(adapter.capabilities.reasons.lanRpcExecution, /lacks the public conversation prompt/);
});

for (const [version, callbackOption] of [['18.2.6', false], ['18.8.4', true]]) {
  test(`OMP ${version} adapter normalizes prompt admission ownership`, async () => {
    const listeners = new Set();
    let receivedOptions;
    const parent = {
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      async promptCustomMessage(payload, options) {
        receivedOptions = options;
        if (options?.onPromptAdmitted) options.onPromptAdmitted();
        const event = { type: 'message_start', message: { role: 'custom', ...payload } };
        for (const listener of listeners) listener(event);
        return true;
      },
    };
    const adapter = await createHostAdapter({
      pi: { VERSION: version, Text: TestText, AgentRegistry: { global: () => ({ list: () => [] }) } },
    }, { loadModule: async specifier => {
      if (specifier === '@oh-my-pi/pi-tui') return testTui;
      throw new Error(`Unexpected test import: ${specifier}`);
    } });
    const payload = { customType: 'probe', content: 'probe', details: { requestId: 'request' } };
    let admissions = 0;

    assert.equal(await adapter.promptSession(parent, payload, () => { admissions += 1; }), true);
    assert.equal(Boolean(receivedOptions?.onPromptAdmitted), callbackOption);
    assert.equal(admissions, 1);
  });
}
