import { failure } from '../../protocol.mjs';
import {
  adaptPiContext,
  createPiSessionBridge,
  definePiTool,
  piParameters,
} from './pi-session.mjs';

const SETTINGS_REASON = 'Pi uses its extension status slot instead of OMP native status settings.';

function unsupported(message) {
  return failure(501, 'host_unsupported', message);
}

async function loadPiModule(specifier) {
  switch (specifier) {
    case '@earendil-works/pi-coding-agent': return import('@earendil-works/pi-coding-agent');
    case '@earendil-works/pi-tui': return import('@earendil-works/pi-tui');
    case '@mariozechner/pi-coding-agent': return import('@mariozechner/pi-coding-agent');
    case '@mariozechner/pi-tui': return import('@mariozechner/pi-tui');
    default: throw new Error(`Unsupported Pi host module: ${specifier}`);
  }
}

function isMissingModule(error, specifier) {
  const message = String(error?.message);
  return error?.code === 'ERR_MODULE_NOT_FOUND' &&
    (message.startsWith(`Cannot find package '${specifier}'`) ||
      message.startsWith(`Cannot find package ${specifier}`));
}

async function optionalModule(loadModule, specifier) {
  try { return await loadModule(specifier); }
  catch (error) {
    if (isMissingModule(error, specifier)) return undefined;
    throw error;
  }
}

function versionAtLeastOne(version) {
  const match = /^(\d+)\./.exec(version);
  return match !== null && Number(match[1]) >= 1;
}

function detectHost(current, legacy) {
  if (current && legacy && current.VERSION !== legacy.VERSION) return undefined;
  if (current) return { root: current, tui: '@earendil-works/pi-tui' };
  if (legacy) return { root: legacy, tui: '@mariozechner/pi-tui' };
  return undefined;
}

function missingExtensionApis(api) {
  return ['on', 'registerTool', 'sendMessage', 'getAllTools', 'getActiveTools', 'setActiveTools']
    .filter(name => typeof api?.[name] !== 'function');
}

function capabilityInfo(version, connectionPanel, apiMissing, identityReason) {
  const executionSupported = apiMissing.length === 0;
  const missing = [...apiMissing.map(name => `extensionApi.${name}`), 'statusSettings'];
  const reasons = { statusSettings: SETTINGS_REASON };
  if (!executionSupported) {
    reasons.lanRpcExecution = `Pi lacks required public extension APIs: ${apiMissing.join(', ')}`;
  }
  if (!connectionPanel) {
    missing.push('Text', 'matchesKey');
    reasons.connectionPanel = 'The active Pi package does not expose resolvable TUI Text and key-matching APIs.';
  }
  if (version === 'unknown') {
    missing.push('hostVersion');
    reasons.identity = identityReason;
  }
  return Object.freeze({
    harness: 'pi',
    version,
    statusMode: 'extension',
    features: Object.freeze({
      extensionLoad: true,
      lanRpcExecution: executionSupported,
      statusSettings: false,
      connectionPanel,
    }),
    reasons: Object.freeze(reasons),
    missing: Object.freeze(missing),
  });
}

export async function createPiHostAdapter(extensionApi, context = {}) {
  const loadModule = context.loadModule ?? loadPiModule;
  const current = await optionalModule(loadModule, '@earendil-works/pi-coding-agent');
  const legacy = await optionalModule(loadModule, '@mariozechner/pi-coding-agent');
  const active = detectHost(current, legacy);
  const version = typeof active?.root.VERSION === 'string' && active.root.VERSION
    ? active.root.VERSION
    : 'unknown';
  const identityReason = current && legacy
    ? 'Both Pi package namespaces resolve to different versions, so the active host version is ambiguous.'
    : 'Pi does not inject host module identity and its active package namespace is not resolvable.';
  const tui = active ? await loadModule(active.tui) : undefined;
  const connectionPanel = typeof tui?.Text === 'function' && typeof tui?.matchesKey === 'function';
  const apiMissing = missingExtensionApis(extensionApi);
  const capabilities = capabilityInfo(version, connectionPanel, apiMissing, identityReason);
  const failPanel = () => { throw unsupported(capabilities.reasons.connectionPanel); };
  const Text = connectionPanel ? tui.Text : class UnsupportedPiText {
    constructor() { failPanel(); }
  };
  const matchesKey = connectionPanel ? tui.matchesKey : failPanel;
  const bridge = capabilities.features.lanRpcExecution
    ? createPiSessionBridge(extensionApi, { supportsAgentSettled: versionAtLeastOne(version) })
    : undefined;
  const failExecution = () => { throw unsupported(capabilities.reasons.lanRpcExecution); };

  return Object.freeze({
    identity: Object.freeze({ harness: capabilities.harness, version: capabilities.version }),
    capabilities,
    statusSettings: undefined,
    loadSettings: async () => undefined,
    matchesKey,
    Text,
    adaptContext: adaptPiContext,
    resolveSession: bridge?.resolveSession ?? failExecution,
    promptSession(parent, payload, onPromptAdmitted, signal) {
      return parent.promptCustomMessage(payload, { onPromptAdmitted, signal });
    },
    parameters: piParameters,
    defineTool: definePiTool,
  });
}
