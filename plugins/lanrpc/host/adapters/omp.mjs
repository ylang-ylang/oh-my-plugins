import { failure } from '../../protocol.mjs';

function unsupported(message) {
  return failure(501, 'host_unsupported', message);
}

async function loadOmpModule(specifier) {
  switch (specifier) {
    case '@oh-my-pi/pi-tui': return import('@oh-my-pi/pi-tui');
    case '@oh-my-pi/pi-coding-agent/config/registry':
      return import('@oh-my-pi/pi-coding-agent/config/registry');
    case '@oh-my-pi/pi-tui/status-line/presets':
      return import('@oh-my-pi/pi-tui/status-line/presets');
    default: throw new Error(`Unsupported OMP host module: ${specifier}`);
  }
}

function parameterObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Tool arguments must be a JSON object');
  }
  return value;
}

export function ompParameters(projection) {
  const wireSchema = structuredClone(projection);
  const validate = value => parameterObject(value);
  Object.defineProperties(validate, {
    assert: { value: parameterObject },
    toJsonSchema: { value: () => structuredClone(wireSchema) },
  });
  return validate;
}

export class StatusSettings {
  constructor(settings, getPreset, lookup) {
    this.settings = settings;
    this.getPreset = getPreset;
    this.lookup = lookup;
    if (typeof getPreset !== 'function') {
      throw unsupported('OMP status presets are unavailable');
    }
    if (lookup !== undefined) {
      if (typeof lookup !== 'function') throw unsupported('OMP settings registry is unavailable');
    } else if (['get', 'override', 'clearOverride'].some(method => typeof settings?.[method] !== 'function')) {
      throw unsupported('OMP status settings API is unavailable');
    }
  }

  static async load(api, loadModule) {
    let settings;
    try { settings = api.Settings.instance; }
    catch (error) {
      // Installer validation can execute the factory before settings exist. The
      // real session initializes the adapter before activating native status.
      if (error.message === 'Settings not initialized. Call Settings.init() first.') return undefined;
      throw error;
    }
    let lookup;
    if (typeof settings.get !== 'function') {
      ({ lookup } = await loadModule('@oh-my-pi/pi-coding-agent/config/registry'));
    }
    const getPreset = typeof api.getPreset === 'function'
      ? api.getPreset
      : (await loadModule('@oh-my-pi/pi-tui/status-line/presets')).getPreset;
    return new StatusSettings(settings, getPreset, lookup);
  }

  handle(key) {
    const setting = this.lookup(key);
    if (!setting) throw unsupported(`OMP is missing status setting ${key}`);
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

function sameSession(parent, ctx) {
  return parent?.sessionManager?.getSessionId?.() === ctx.sessionManager.getSessionId();
}

function hasPromptAdmissionCallback(version) {
  const match = /^(\d+)\.(\d+)\./.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 18 || (major === 18 && minor >= 6);
}

function isAdmittedMessage(event, payload) {
  const message = event?.message;
  return event?.type === 'message_start' && message?.role === 'custom' &&
    message.customType === payload.customType && message.details === payload.details;
}

function missingSessionCapabilities(parent) {
  const missing = [];
  if (typeof parent.refreshRpcHostTools !== 'function' ||
      typeof parent.getAllToolNames !== 'function' ||
      typeof parent.hasRpcHostTool !== 'function' ||
      !Array.isArray(parent.agent?.state?.tools)) missing.push('rpcToolRegistry');
  if (typeof parent.promptCustomMessage !== 'function') missing.push('nativePrompt');
  if (typeof parent.subscribe !== 'function') missing.push('nativeEvents');
  if (typeof parent.abort !== 'function') missing.push('nativeCancellation');
  if (!Array.isArray(parent.messages)) missing.push('conversationMessages');
  return missing;
}

function capabilityInfo(version, features, reasons, missing) {
  return Object.freeze({
    harness: 'omp',
    version,
    features: Object.freeze(features),
    reasons: Object.freeze(reasons),
    missing: Object.freeze(missing),
  });
}

export async function createOmpHostAdapter(extensionApi, context = {}) {
  const api = extensionApi.pi;
  const loadModule = context.loadModule ?? loadOmpModule;
  const tui = await loadModule('@oh-my-pi/pi-tui');
  const Text = api.Text ?? tui.Text;
  const matchesKey = api.matchesKey ?? tui.matchesKey;
  const version = typeof api.VERSION === 'string' && api.VERSION ? api.VERSION : 'unknown';
  const hasRegistry = typeof api.AgentRegistry?.global === 'function';
  let executionSupported = hasRegistry;
  const hasSettings = api.Settings !== undefined;
  const promptAdmissionCallback = hasPromptAdmissionCallback(version);
  const hasPanel = typeof Text === 'function' && typeof matchesKey === 'function';
  const reasons = {};
  const missing = [];
  if (!hasRegistry) {
    missing.push('agentRegistry');
    reasons.lanRpcExecution = 'OMP does not expose the public AgentRegistry required for selected-conversation execution.';
  }
  const resolveSession = ctx => {
    if (!hasRegistry) throw unsupported(reasons.lanRpcExecution);
    const registry = api.AgentRegistry.global();
    if (ctx.agent && typeof ctx.agent.id === 'string') {
      const parent = registry.get?.(ctx.agent.id)?.session;
      return sameSession(parent, ctx) ? parent : undefined;
    }
    return registry.list?.().find(ref => ref.session && sameSession(ref.session, ctx))?.session;
  };
  if (executionSupported && typeof context.sessionManager?.getSessionId === 'function') {
    const parent = resolveSession(context);
    if (!parent) {
      executionSupported = false;
      missing.push('selectedAgentSession');
      reasons.lanRpcExecution = 'The selected AgentSession is unavailable through the public agent registry.';
    } else {
      const sessionMissing = missingSessionCapabilities(parent);
      if (sessionMissing.length > 0) {
        executionSupported = false;
        missing.push(...sessionMissing);
        reasons.lanRpcExecution = 'This OMP host lacks the public conversation prompt, scoped tool, context, or cancellation APIs.';
      }
    }
  }
  if (!hasSettings) {
    missing.push('statusSettings');
    reasons.statusSettings = 'OMP does not expose native status settings.';
  }
  if (typeof Text !== 'function') missing.push('Text');
  if (typeof matchesKey !== 'function') missing.push('matchesKey');
  if (!hasPanel) reasons.connectionPanel = 'OMP does not expose the TUI Text and key-matching APIs.';
  const capabilities = capabilityInfo(version, {
    extensionLoad: true,
    lanRpcExecution: executionSupported,
    statusSettings: hasSettings,
    connectionPanel: hasPanel,
  }, reasons, missing);
  const promptSession = async (parent, payload, onPromptAdmitted) => {
    if (promptAdmissionCallback) {
      return parent.promptCustomMessage(payload, { onPromptAdmitted });
    }
    let admitted = false;
    const unsubscribe = parent.subscribe(event => {
      if (admitted || !isAdmittedMessage(event, payload)) return;
      admitted = true;
      onPromptAdmitted();
    });
    try { return await parent.promptCustomMessage(payload); }
    finally { unsubscribe(); }
  };

  return Object.freeze({
    identity: Object.freeze({ harness: capabilities.harness, version: capabilities.version }),
    capabilities,
    statusSettings: StatusSettings,
    async loadSettings() {
      if (!hasSettings) throw unsupported(reasons.statusSettings);
      return StatusSettings.load(api, loadModule);
    },
    matchesKey,
    Text,
    resolveSession,
    promptSession,
    parameters: ompParameters,
    defineTool(definition) {
      const { execute, ...tool } = definition;
      if (typeof execute !== 'function') throw new TypeError('Host tool definition must provide execute()');
      return {
        ...tool,
        async execute(toolCallId, params, signal, onUpdate, toolContext) {
          return execute({ toolCallId, params, signal, onUpdate, context: toolContext });
        },
      };
    },
  });
}
