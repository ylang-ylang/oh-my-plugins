// Host-version differences belong here, not in the status layout or RPC code.
// Select public capabilities instead of guessing from a version string.
export class StatusSettings {
  constructor(settings, getPreset, lookup) {
    this.settings = settings;
    this.getPreset = getPreset;
    this.lookup = lookup;
    if (typeof getPreset !== 'function') throw new Error('Unsupported OMP host: status presets are unavailable');
    if (lookup !== undefined) {
      if (typeof lookup !== 'function') throw new Error('Unsupported OMP host: settings registry is unavailable');
    } else if (['get', 'override', 'clearOverride'].some(method => typeof settings[method] !== 'function')) {
      throw new Error('Unsupported OMP host: status settings API is unavailable');
    }
  }

  static async load(api) {
    let settings;
    try { settings = api.Settings.instance; }
    catch (error) {
      // Installer validation can execute the factory before settings exist.
      // The real session will initialize the adapter before activating status.
      if (error.message === 'Settings not initialized. Call Settings.init() first.') return undefined;
      throw error;
    }
    let lookup;
    if (typeof settings.get !== 'function') {
      ({ lookup } = await import('@oh-my-pi/pi-coding-agent/config/registry'));
    }
    const getPreset = typeof api.getPreset === 'function'
      ? api.getPreset
      : (await import('@oh-my-pi/pi-tui/status-line/presets')).getPreset;
    return new StatusSettings(settings, getPreset, lookup);
  }

  handle(key) {
    const setting = this.lookup(key);
    if (!setting) throw new Error(`Unsupported OMP host: missing setting ${key}`);
    return setting;
  }

  get(key) {
    return this.lookup ? this.handle(key).get(this.settings) : this.settings.get(key);
  }

  override(key, value) {
    if (this.lookup) this.handle(key).override(this.settings, value);
    else this.settings.override(key, value);
  }

  clearOverride(key) {
    if (this.lookup) this.handle(key).clearOverride(this.settings);
    else this.settings.clearOverride(key);
  }
}
