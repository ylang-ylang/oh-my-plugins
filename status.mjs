import { isDeepStrictEqual } from 'node:util';

// Nerd Fonts' official glyphnames.json: md-radar = U+F0437.
// OMP sanitizes ANSI in native status segments, so it owns the icon's color.
// Local/LAN details belong in /lan info rather than a second footer or long label.
const RADAR = '\u{F0437}';
const ICONS = Object.freeze({ off: '◌', local: RADAR, lan: RADAR, error: '!' });
const STATUS_KEY = 'lan-rpc';

export class StatusIndicator {
  constructor(pi) {
    this.pi = pi;
    this.active = false;
    this.lastMode = undefined;
    this.owned = new Map();
  }

  prepareAtLoad() {
    // Native OMP 18.2.6 captures this layout in its TUI constructor, before
    // session_start. Only prepare settings here; UI actions still wait for a
    // live context. Installer validation may run without initialized settings.
    if (!process.stdin.isTTY || !process.stdout.isTTY) return;
    let settings;
    try { settings = this.pi.pi.Settings.instance; }
    catch (error) {
      if (error.message === 'Settings not initialized. Call Settings.init() first.') return;
      throw error;
    }
    this.applyLayout(settings);
  }

  activate(ctx) {
    if (ctx.hasUI) this.applyLayout(this.pi.pi.settings);
  }

  applyLayout(settings) {
    if (this.active) return;
    const { getPreset } = this.pi.pi;
    const name = settings.get('statusLine.preset');
    const preset = getPreset(name);
    const custom = name === 'custom';
    const left = [...(custom ? settings.get('statusLine.leftSegments') : preset.leftSegments)];
    const right = [...(custom ? settings.get('statusLine.rightSegments') : preset.rightSegments)];
    const options = structuredClone(preset.segmentOptions || {});
    // Same precedence as OMP's native computeEffectiveSettings: segment options
    // and separator apply to named presets as well as to the custom preset.
    for (const [segment, value] of Object.entries(settings.get('statusLine.segmentOptions') || {})) {
      options[segment] = { ...options[segment], ...value };
    }
    if (!left.includes('status') && !right.includes('status')) {
      const pathIndex = left.indexOf('path');
      const anchor = pathIndex < 0 ? left.indexOf('model') : pathIndex;
      left.splice(anchor < 0 ? left.length : anchor + 1, 0, 'status');
    }
    const changes = {
      'statusLine.leftSegments': left,
      'statusLine.rightSegments': right,
      'statusLine.separator': settings.get('statusLine.separator') ?? preset.separator,
      'statusLine.segmentOptions': options,
      'statusLine.preset': 'custom',
      'statusLine.showHookStatus': false,
    };
    try {
      for (const [key, value] of Object.entries(changes)) {
        const before = settings.get(key);
        if (isDeepStrictEqual(before, value)) continue;
        settings.override(key, value);
        this.owned.set(key, { applied: structuredClone(value) });
      }
      this.active = true;
      this.lastMode = undefined;
    } catch (error) {
      this.restore();
      throw error;
    }
  }

  set(ctx, mode) {
    if (!this.active || mode === this.lastMode) return;
    this.lastMode = mode;
    ctx.ui.setStatus(STATUS_KEY, ICONS[mode]);
  }

  restore() {
    const { settings } = this.pi.pi;
    for (const [key, { applied }] of [...this.owned].reverse()) {
      // A sibling or operator may have superseded our runtime override.
      if (!isDeepStrictEqual(settings.get(key), applied)) continue;
      settings.clearOverride(key);
    }
    this.owned.clear();
  }

  dispose(ctx) {
    if (this.active) ctx.ui.setStatus(STATUS_KEY, undefined);
    this.restore();
    this.active = false;
    this.lastMode = undefined;
  }
}
