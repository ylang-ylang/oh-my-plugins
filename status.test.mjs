import test from 'node:test';
import assert from 'node:assert/strict';
import { StatusIndicator } from './status.mjs';

// Model OMP's documented two-layer Settings contract: persistent settings can
// change beneath a runtime override. Assertions exercise the visible preference
// after the indicator is removed, not which setter the implementation calls.
function session() {
  const values = new Map(Object.entries({
    'statusLine.preset': 'default',
    'statusLine.leftSegments': ['model', 'path'],
    'statusLine.rightSegments': ['session_name'],
    'statusLine.separator': 'pipe',
    'statusLine.segmentOptions': {},
    'statusLine.showHookStatus': true,
  }));
  const overrides = new Map();
  const settings = {
    get: key => overrides.has(key) ? overrides.get(key) : values.get(key),
    set: (key, value) => values.set(key, value),
    override: (key, value) => overrides.set(key, value),
    clearOverride: key => overrides.delete(key),
  };
  const indicator = new StatusIndicator({ pi: { settings, getPreset: () => ({
    leftSegments: ['model', 'path'], rightSegments: ['session_name'],
    separator: 'pipe', segmentOptions: {},
  }) } });
  const ctx = { hasUI: true, ui: { setStatus() {} } };
  return { settings, indicator, ctx };
}

test('unloading the indicator exposes a user preference changed while it was active', () => {
  const { settings, indicator, ctx } = session();
  indicator.activate(ctx);
  settings.set('statusLine.preset', 'nerd');
  settings.set('statusLine.leftSegments', ['hostname', 'model', 'path']);
  indicator.dispose(ctx);
  assert.equal(settings.get('statusLine.preset'), 'nerd');
  assert.deepEqual(settings.get('statusLine.leftSegments'), ['hostname', 'model', 'path']);
});

test('unloading does not erase a later runtime layout override owned by another extension', () => {
  const { settings, indicator, ctx } = session();
  indicator.activate(ctx);
  settings.override('statusLine.leftSegments', ['path', 'status', 'time']);
  indicator.dispose(ctx);
  assert.deepEqual(settings.get('statusLine.leftSegments'), ['path', 'status', 'time']);
});
