import { AsyncLocalStorage } from 'node:async_hooks';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { failure } from '../protocol.mjs';

const CHILD_CONSTRUCTION = new AsyncLocalStorage();
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OWN_EXTENSION_PATHS = new Set([
  resolve(PACKAGE_ROOT, 'extension.mjs'),
  resolve(PACKAGE_ROOT, 'host', 'index.mjs'),
]);
const CHILD_BUILTIN_TOOLS = new Set([
  'read',
  'grep',
  'glob',
  'find',
  'bash',
  'edit',
  'write',
  'web_search',
]);
const ARTIFACT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    path: { type: 'string', minLength: 1 },
    name: { type: 'string', minLength: 1 },
    mediaType: {
      type: 'string',
      pattern: "^[A-Za-z0-9!#$%&'*+.^_`|~-]+/[A-Za-z0-9!#$%&'*+.^_`|~-]+$",
    },
  },
  required: ['path', 'mediaType'],
  additionalProperties: false,
});

export function isLanRpcChildConstruction() {
  return CHILD_CONSTRUCTION.getStore() === true;
}

function unsupported(message) {
  return failure(501, 'host_unsupported', message);
}

function abortError(signal) {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error('The isolated RPC request was aborted');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal) {
  if (signal.aborted) throw abortError(signal);
}

function sameSession(parent, ctx) {
  return parent?.sessionManager?.getSessionId?.() === ctx.sessionManager.getSessionId();
}

function resolveParentSession(pi, ctx) {
  const Registry = pi.pi?.AgentRegistry;
  if (typeof Registry?.global !== 'function') return undefined;
  const registry = Registry.global();
  if (ctx.agent && typeof ctx.agent.id === 'string') {
    const parent = registry.get?.(ctx.agent.id)?.session;
    return sameSession(parent, ctx) ? parent : undefined;
  }
  return registry.list?.().find(ref => ref.session && sameSession(ref.session, ctx))?.session;
}

function normalizePreparedPath(prepared) {
  const candidate = prepared?.resolvedPath ?? prepared?.path;
  if (typeof candidate !== 'string' || candidate.length === 0 || candidate.startsWith('<')) return undefined;
  return resolve(candidate);
}

function isOwnExtension(prepared) {
  const candidate = normalizePreparedPath(prepared);
  return candidate !== undefined && OWN_EXTENSION_PATHS.has(candidate);
}

const JSON_SCHEMA_TYPES = new Set(['array', 'boolean', 'integer', 'null', 'number', 'object', 'string']);

function projectedType(schema) {
  const declared = schema?.type;
  if (typeof declared === 'string' && JSON_SCHEMA_TYPES.has(declared)) return [declared];
  if (Array.isArray(declared) && declared.length === 1 && JSON_SCHEMA_TYPES.has(declared[0])) {
    return [declared[0]];
  }
  return undefined;
}

function projectedValueSchema(schema) {
  const type = projectedType(schema);
  return type === undefined ? {} : { type };
}

export function parameterProjection(schema) {
  const projection = {
    type: 'object',
    properties: {},
    additionalProperties: true,
  };
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return projection;

  const required = Array.isArray(schema.required)
    ? [...new Set(schema.required.filter(name => typeof name === 'string'))]
    : [];
  const properties = schema.properties !== null && typeof schema.properties === 'object' && !Array.isArray(schema.properties)
    ? schema.properties
    : {};
  for (const name of required) {
    Object.defineProperty(projection.properties, name, {
      value: projectedValueSchema(properties[name]),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  if (required.length > 0) projection.required = required;

  const declaredNames = Object.keys(properties);
  const hasPatternProperties = schema.patternProperties !== null &&
    typeof schema.patternProperties === 'object' &&
    !Array.isArray(schema.patternProperties) &&
    Object.keys(schema.patternProperties).length > 0;
  if (schema.additionalProperties === false &&
      !hasPatternProperties &&
      declaredNames.every(name => required.includes(name))) {
    projection.additionalProperties = false;
  }
  return projection;
}

function parameterObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Tool arguments must be a JSON object');
  }
  return value;
}

function parameterAdapter(projection) {
  const wireSchema = structuredClone(projection);
  const validate = value => parameterObject(value);
  Object.defineProperties(validate, {
    assert: { value: parameterObject },
    toJsonSchema: { value: () => structuredClone(wireSchema) },
  });
  return validate;
}

export function isolatedParameters(schema) {
  return parameterAdapter(parameterProjection(schema));
}

export function resultParameters(schema) {
  return {
    type: 'object',
    properties: { result: projectedValueSchema(schema) },
    required: ['result'],
    additionalProperties: false,
  };
}

function toolResult(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    details: structuredClone(value),
  };
}

function outcomeError(name, outcome) {
  const code = outcome?.error?.code;
  const message = outcome?.error?.message;
  if (typeof code === 'string' && typeof message === 'string') {
    return new Error(`${name} failed (${code}): ${message}`);
  }
  return new Error(`${name} failed without a valid caller outcome`);
}
function modelToolError(error) {
  if (error?.name === 'AbortError') return error;
  const code = typeof error?.code === 'string' ? `${error.code}: ` : '';
  const message = error instanceof Error ? error.message : String(error);
  const errors = Array.isArray(error?.details?.errors) ? error.details.errors : undefined;
  const converted = new Error(`${code}${message}${errors ? `\nValidation errors: ${JSON.stringify(errors)}` : ''}`, {
    cause: error,
  });
  for (const key of ['status', 'code', 'details']) {
    if (error !== null && typeof error === 'object' && Object.hasOwn(error, key)) converted[key] = error[key];
  }
  return converted;
}

export function buildRequestTools(scope, assertCurrent) {
  const tools = scope.request.tools.map(tool => ({
    name: tool.name,
    label: tool.name,
    description: `${tool.description}\n\nThe host parameter schema is a non-authoritative safety projection. Before caller-side invocation, arguments are checked in an isolated validator against this authoritative JSON Schema: ${JSON.stringify(tool.inputSchema)}`,
    parameters: isolatedParameters(tool.inputSchema),
    async execute(nativeToolCallId, params, _onUpdate, _toolContext, toolSignal) {
      assertCurrent();
      if (toolSignal?.aborted) throw abortError(toolSignal);
      let outcome;
      try { outcome = await scope.invokeTool(tool.name, params, nativeToolCallId); }
      catch (error) { throw modelToolError(error); }
      assertCurrent();
      if (toolSignal?.aborted) throw abortError(toolSignal);
      if (outcome?.status !== 'completed') throw outcomeError(tool.name, outcome);
      return toolResult(outcome.result);
    },
  }));

  if (scope.capabilities?.artifacts !== false) {
    tools.push({
      name: 'rpc_artifact',
      label: 'RPC artifact',
      description: 'Register an immutable artifact file from this request working directory for the RPC caller.',
      parameters: structuredClone(ARTIFACT_SCHEMA),
      approval: 'read',
      async execute(nativeToolCallId, params, _onUpdate, _toolContext, toolSignal) {
        assertCurrent();
        if (toolSignal?.aborted) throw abortError(toolSignal);
        let metadata;
        try { metadata = await scope.registerArtifact(params, nativeToolCallId); }
        catch (error) { throw modelToolError(error); }
        assertCurrent();
        if (toolSignal?.aborted) throw abortError(toolSignal);
        return toolResult(metadata);
      },
    });
  }

  if (scope.request.responseMode === 'structured') {
    tools.push({
      name: 'rpc_result',
      label: 'RPC result',
      description: `Submit the final structured result for this RPC request after every caller tool has settled. The host parameter schema is a non-authoritative safety projection. The result is checked in an isolated validator against this authoritative JSON Schema: ${JSON.stringify(scope.request.resultSchema)}`,
      parameters: parameterAdapter(resultParameters(scope.request.resultSchema)),
      approval: 'read',
      async execute(_nativeToolCallId, params, _onUpdate, _toolContext, toolSignal) {
        assertCurrent();
        if (toolSignal?.aborted) throw abortError(toolSignal);
        let accepted;
        try { accepted = await scope.submitResult(params.result); }
        catch (error) { throw modelToolError(error); }
        assertCurrent();
        if (toolSignal?.aborted) throw abortError(toolSignal);
        return toolResult(accepted);
      },
    });
  }
  return tools;
}

function inspectBoundary(pi, ctx) {
  const api = pi.pi;
  if (!api || typeof api.createAgentSession !== 'function' || typeof api.SessionManager?.inMemory !== 'function') {
    throw unsupported('This OMP host does not expose request-scoped agent sessions');
  }
  const parent = resolveParentSession(pi, ctx);
  if (!parent) throw unsupported('The active parent AgentSession is unavailable through the public agent registry');
  const canIsolateSettings = typeof parent.settings?.overlay === 'function' ||
    (typeof api.Settings?.isolated === 'function' && typeof parent.settings?.getStorage === 'function');
  if (typeof ctx.getSystemPrompt !== 'function' ||
      typeof parent.getEnabledToolNames !== 'function' ||
      typeof parent.getAllToolNames !== 'function' ||
      typeof parent.configuredThinkingLevel !== 'function' ||
      typeof parent.subscribe !== 'function' ||
      !parent.settings || !parent.modelRegistry?.authStorage || !canIsolateSettings ||
      typeof parent.sendUserMessage !== 'function' ||
      !Array.isArray(parent.messages) || !Array.isArray(parent.skills) ||
      !Array.isArray(parent.preparedExtensions)) {
    throw unsupported('This OMP host lacks the public parent-session boundary required for isolated execution');
  }
  const prompt = ctx.getSystemPrompt();
  if (!Array.isArray(prompt) || prompt.some(block => typeof block !== 'string')) {
    throw unsupported('This OMP host did not expose the active system prompt as exact string blocks');
  }
  if (typeof pi.getServiceTiers !== 'function') {
    throw unsupported('This OMP host does not expose the active service-tier policy');
  }
  return parent;
}

async function createChildSession(pi, options) {
  return CHILD_CONSTRUCTION.run(true, () => pi.pi.createAgentSession(options));
}

async function childSettings(pi, parent) {
  if (typeof parent.settings.overlay === 'function') return parent.settings.overlay({});
  if (typeof pi.pi.Settings?.isolated !== 'function' || typeof parent.settings.getStorage !== 'function') {
    throw unsupported('This OMP host cannot isolate child settings from the interactive parent');
  }
  const { SETTINGS_SCHEMA } = await import('@oh-my-pi/pi-coding-agent/config/settings');
  if (!SETTINGS_SCHEMA || typeof SETTINGS_SCHEMA !== 'object') {
    throw unsupported('This OMP host does not expose the legacy settings schema required for isolation');
  }
  const snapshot = {};
  for (const key of Object.keys(SETTINGS_SCHEMA)) snapshot[key] = parent.settings.get(key);
  return pi.pi.Settings.isolated(snapshot, { storage: parent.settings.getStorage() });
}

export function createRequestExecutor(pi, ctx) {
  let parent;
  try {
    parent = inspectBoundary(pi, ctx);
  } catch (error) {
    if (error?.code !== 'host_unsupported') throw error;
    return {
      supported: false,
      unsupportedReason: error.message,
      reservedToolNames: [],
      execute: async () => { throw error; },
    };
  }

  const sessionId = ctx.sessionManager.getSessionId();
  const reservedToolNames = parent.getAllToolNames();

  function assertParentCurrent(signal) {
    throwIfAborted(signal);
    if (ctx.sessionManager.getSessionId() !== sessionId || resolveParentSession(pi, ctx) !== parent) {
      throw failure(409, 'session_changed', 'The interactive parent session changed during isolated execution');
    }
  }

  return {
    supported: true,
    reservedToolNames,
    async execute(scope) {
      assertParentCurrent(scope.signal);

      const systemPrompt = structuredClone(ctx.getSystemPrompt());
      const parentMessages = structuredClone(parent.messages);
      const parentSkills = [...parent.skills];
      const preparedExtensions = parent.preparedExtensions.filter(prepared => !isOwnExtension(prepared));
      const enabledBuiltins = parent.getEnabledToolNames().filter(name => CHILD_BUILTIN_TOOLS.has(name));
      const requestTools = buildRequestTools(scope, () => assertParentCurrent(scope.signal));
      const toolNames = [...new Set([...enabledBuiltins, ...requestTools.map(tool => tool.name)])];
      const settings = await childSettings(pi, parent);
      assertParentCurrent(scope.signal);
      const sessionManager = pi.pi.SessionManager.inMemory(ctx.cwd);
      for (const message of parentMessages) sessionManager.appendMessage(message);

      let session;
      let unsubscribe;
      let nativeEventError;
      let executionResult;
      const abortChild = () => {
        if (session) void session.abort().catch(() => {});
      };
      scope.signal.addEventListener('abort', abortChild, { once: true });

      try {
        assertParentCurrent(scope.signal);
        const created = await createChildSession(pi, {
          cwd: ctx.cwd,
          model: ctx.model,
          modelRegistry: parent.modelRegistry,
          authStorage: parent.modelRegistry.authStorage,
          settings,
          thinkingLevel: parent.configuredThinkingLevel(),
          resolveServiceTierByFamily: () => ({ ...pi.getServiceTiers() }),
          systemPrompt,
          sessionManager,
          customTools: requestTools,
          toolNames,
          restrictToolNames: true,
          allowRestrictedCustomTools: true,
          disableExtensionDiscovery: true,
          preloadedPreparedExtensions: preparedExtensions,
          extensionRoots: () => parent.effectiveExtensionRoots,
          contextFiles: [],
          rules: [],
          skills: parentSkills,
          promptTemplates: [],
          slashCommands: [],
          hasUI: false,
          agentId: `LanRpc-${scope.identity.instanceId}-${scope.identity.generation}-${scope.identity.requestId}`,
          agentDisplayName: `lanrpc:${scope.identity.requestId}`,
          parentAgentId: parent.getAgentId?.(),
          expectedAgentRef: null,
          bindProcessState: false,
          cacheWarming: false,
          deadline: Date.now() + scope.request.timeoutMs,
        });
        session = created.session;
        assertParentCurrent(scope.signal);

        const initialMessageCount = session.messages.length;
        if (scope.request.responseMode === 'native') {
          unsubscribe = session.subscribe(event => {
            if (scope.signal.aborted || nativeEventError) return;
            try {
              scope.emitNative(event);
            } catch (error) {
              nativeEventError = error;
              abortChild();
            }
          });
        }

        await session.sendUserMessage(scope.request.message, { attribution: 'agent' });
        if (nativeEventError) throw nativeEventError;
        assertParentCurrent(scope.signal);
        const messages = session.messages.slice(initialMessageCount);
        assertParentCurrent(scope.signal);
        executionResult = { messages, stopReason: session.getLastAssistantMessage?.()?.stopReason };
      } finally {
        scope.signal.removeEventListener('abort', abortChild);
        unsubscribe?.();
        if (session) await session.dispose();
      }
      assertParentCurrent(scope.signal);
      return executionResult;
    },
  };
}
