import { isDeepStrictEqual } from 'node:util';

// Nerd Fonts' official glyphnames.json: md-radar = U+F0437.
// OMP sanitizes ANSI in native status segments, so it owns the icon's color.
// Local/LAN details belong in /lanrpc info rather than a second footer or long label.
const RADAR = '\u{F0437}';
const ICONS = Object.freeze({ off: '◌', local: RADAR, lan: RADAR, error: '!' });
const STATUS_KEY = 'lan-rpc';

export class StatusIndicator {
  constructor(host) {
    this.host = host;
    this.settings = undefined;
    this.active = false;
    this.lastMode = undefined;
    this.owned = new Map();
  }

  async prepareAtLoad() {
    // The native TUI captures its layout before session_start. Complete host
    // adaptation and layout preparation while the extension factory is loading.
    if (!process.stdin.isTTY || !process.stdout.isTTY) return;
    this.settings = await this.host.loadSettings();
    if (this.settings) this.applyLayout(this.settings);
  }

  async activate(ctx) {
    if (!this.host.hasUI(ctx)) return;
    this.settings ??= await this.host.loadSettings();
    if (!this.settings) throw new Error('OMP status settings are not initialized');
    this.applyLayout(this.settings);
  }

  applyLayout(settings) {
    if (this.active) return;
    const name = settings.get('statusLine.preset');
    const preset = settings.getPreset(name);
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
    this.host.setStatus(ctx, STATUS_KEY, ICONS[mode]);
  }

  restore() {
    const settings = this.settings;
    for (const [key, { applied }] of [...this.owned].reverse()) {
      // A sibling or operator may have superseded our runtime override.
      if (!isDeepStrictEqual(settings.get(key), applied)) continue;
      settings.clearOverride(key);
    }
    this.owned.clear();
  }

  dispose(ctx) {
    if (this.active) this.host.setStatus(ctx, STATUS_KEY, undefined);
    this.restore();
    this.active = false;
    this.lastMode = undefined;
  }
}
