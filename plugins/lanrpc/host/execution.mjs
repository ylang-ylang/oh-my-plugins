import { failure } from '../protocol.mjs';

const NOOP_OPERATIONS = Object.freeze({ emit() {} });

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


function unsupported(message) {
  return failure(501, 'host_unsupported', message);
}

function abortError(signal) {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error('The RPC request was aborted');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal) {
  if (signal.aborted) throw abortError(signal);
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

function waitForToolOutcome(pending, signal) {
  if (!signal) return pending;
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    // Keep both handlers attached even after abort so a late caller outcome
    // cannot become an unhandled rejection or resume the old tool execution.
    Promise.resolve(pending).then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

async function executeLoggedTool(operations, sessionId, scope, toolName, toolCallId, execute) {
  const startedAt = Date.now();
  const identity = { sessionId, ...scope.identity, toolName, toolCallId };
  try { operations.emit('host.tool.started', { ...identity, state: 'running' }); } catch {}
  try {
    const result = await execute();
    try {
      operations.emit('host.tool.completed', {
        ...identity,
        state: 'completed',
        durationMs: Math.max(0, Date.now() - startedAt),
      });
    } catch {}
    return result;
  } catch (error) {
    const state = error?.name === 'AbortError' ? 'cancelled' : 'failed';
    try {
      operations.emit('host.tool.terminal', {
        ...identity,
        state,
        reason: error?.code ?? state,
        errorCode: error?.code,
        errorType: error?.name,
        durationMs: Math.max(0, Date.now() - startedAt),
      });
    } catch {}
    throw error;
  }
}

export function buildRequestTools(adapter, scope, assertCurrent, operations = NOOP_OPERATIONS, sessionId = undefined) {
  const tools = scope.request.tools.map(tool => adapter.defineTool({
    name: tool.name,
    label: tool.name,
    description: `${tool.description}\n\nThe host parameter schema is a non-authoritative safety projection. Before caller-side invocation, arguments are checked in an isolated validator against this authoritative JSON Schema: ${JSON.stringify(tool.inputSchema)}`,
    parameters: adapter.parameters(parameterProjection(tool.inputSchema)),
    loadMode: 'essential',
    async execute({ toolCallId, params, signal }) {
      return executeLoggedTool(operations, sessionId, scope, tool.name, toolCallId, async () => {
        assertCurrent();
        if (signal?.aborted) throw abortError(signal);
        let outcome;
        try { outcome = await waitForToolOutcome(scope.invokeTool(tool.name, params, toolCallId), signal); }
        catch (error) { throw modelToolError(error); }
        assertCurrent();
        if (signal?.aborted) throw abortError(signal);
        if (outcome?.status !== 'completed') throw outcomeError(tool.name, outcome);
        return toolResult(outcome.result);
      });
    },
  }));

  if (scope.capabilities?.artifacts !== false) {
    tools.push(adapter.defineTool({
      name: 'rpc_artifact',
      label: 'RPC artifact',
      description: 'Register an immutable artifact file from this request working directory for the RPC caller.',
      parameters: structuredClone(ARTIFACT_SCHEMA),
      approval: 'read',
      loadMode: 'essential',
      async execute({ toolCallId, params, signal }) {
        return executeLoggedTool(operations, sessionId, scope, 'rpc_artifact', toolCallId, async () => {
          assertCurrent();
          if (signal?.aborted) throw abortError(signal);
          let metadata;
          try { metadata = await scope.registerArtifact(params, toolCallId); }
          catch (error) { throw modelToolError(error); }
          assertCurrent();
          if (signal?.aborted) throw abortError(signal);
          return toolResult(metadata);
        });
      },
    }));
  }

  if (scope.request.responseMode === 'structured') {
    tools.push(adapter.defineTool({
      name: 'rpc_result',
      label: 'RPC result',
      description: `Submit the final structured result for this RPC request after every caller tool has settled. The host parameter schema is a non-authoritative safety projection. The result is checked in an isolated validator against this authoritative JSON Schema: ${JSON.stringify(scope.request.resultSchema)}`,
      parameters: adapter.parameters(resultParameters(scope.request.resultSchema)),
      approval: 'read',
      loadMode: 'essential',
      concurrency: 'exclusive',
      async execute({ toolCallId, params, signal }) {
        return executeLoggedTool(operations, sessionId, scope, 'rpc_result', toolCallId, async () => {
          assertCurrent();
          if (signal?.aborted) throw abortError(signal);
          let accepted;
          try { accepted = await scope.submitResult(params.result); }
          catch (error) { throw modelToolError(error); }
          // The controller commits before aborting its signal to fence late writes.
          // That successful terminal transition must not turn this result into an error.
          if (!scope.isCompleted?.()) {
            assertCurrent();
            if (signal?.aborted) throw abortError(signal);
          }
          return toolResult(accepted);
        });
      },
    }));
  }
  return tools;
}

const REQUEST_MESSAGE_TYPE = 'omp-lan-rpc.request';

function isRequestMessage(message, identity) {
  return message?.role === 'custom' && message.customType === REQUEST_MESSAGE_TYPE &&
    message.details?.instanceId === identity.instanceId &&
    message.details?.generation === identity.generation &&
    message.details?.requestId === identity.requestId;
}

function isUserMessage(message) {
  return (message?.role === 'user' && message.attribution !== 'agent' && !message.synthetic) ||
    (message?.role === 'custom' && message.attribution === 'user');
}

function inspectBoundary(adapter, ctx) {
  if (!adapter.capabilities.features.lanRpcExecution) {
    throw unsupported(adapter.capabilities.reasons.lanRpcExecution);
  }
  const parent = adapter.resolveSession(ctx);
  if (!parent) throw unsupported('The selected conversation is unavailable through the host adapter');
  if (typeof ctx.isIdle !== 'function' || typeof ctx.hasPendingMessages !== 'function' ||
      typeof parent.refreshRpcHostTools !== 'function' ||
      typeof parent.promptCustomMessage !== 'function' ||
      typeof parent.subscribe !== 'function' || typeof parent.abort !== 'function' ||
      typeof parent.getAllToolNames !== 'function' || typeof parent.hasRpcHostTool !== 'function' ||
      !Array.isArray(parent.agent?.state?.tools) || !Array.isArray(parent.messages)) {
    throw unsupported('This host lacks the required conversation prompt, scoped tool, context, or cancellation APIs');
  }
  // refreshRpcHostTools replaces a host-owned slot. Never take a slot from
  // another host, including inactive tools absent from agent.state.tools.
  if (parent.getAllToolNames().some(name => parent.hasRpcHostTool(name))) {
    throw unsupported('The selected conversation already has tools owned by another RPC host');
  }
  return parent;
}

export function createRequestExecutor(adapter, ctx, operations = NOOP_OPERATIONS) {
  let parent;
  try {
    parent = inspectBoundary(adapter, ctx);
  } catch (error) {
    if (error?.code !== 'host_unsupported') throw error;
    return {
      supported: false,
      unsupportedReason: error.message,
      reservedToolNames: [],
      context: () => undefined,
      reconcileContext: () => {},
      drainTools: async () => {},
      execute: async () => { throw error; },
    };
  }

  const sessionId = ctx.sessionManager.getSessionId();
  const cwd = ctx.cwd;
  let active;
  let toolDrain = Promise.resolve();
  let cleanupError;

  function assertParentCurrent() {
    if (ctx.sessionManager.getSessionId() !== sessionId || adapter.resolveSession(ctx) !== parent) {
      throw failure(409, 'session_changed', 'The selected conversation changed during RPC execution');
    }
  }

  function removeTools(lease) {
    if (!lease.removing) {
      lease.removing = (async () => {
        // Installation may still be rebuilding the native prompt when CLI input
        // arrives. Serialize removal after it, even if installation failed.
        await lease.installing?.catch(() => {});
        if (lease.toolsTouched) await parent.refreshRpcHostTools([]);
      })();
      toolDrain = lease.removing;
      // Input is notification-only: do not make its handler wait for a prompt
      // or consume a key. Native prompt preparation drains just this mutation.
      void toolDrain.catch(error => { cleanupError = error; });
    }
    return lease.removing;
  }

  function releaseScope(reason) {
    const lease = active;
    if (!lease) return;
    try {
      operations.emit('host.scope.released', {
        sessionId,
        ...lease.scope.identity,
        state: lease.scope.isCompleted() ? 'completed' : 'interrupted',
        reason,
      });
    } catch {}
    lease.superseded = true;
    lease.ownsPrompt = false;
    lease.contextActive = false;
    lease.unsubscribe?.();
    void removeTools(lease);
    if (!lease.scope.isCompleted()) lease.scope.interruptFromHost(reason);
  }

  function reconcileContext(hookCtx) {
    const lease = active;
    if (!lease) return;
    if (hookCtx.sessionManager.getSessionId() !== sessionId || hookCtx.cwd !== cwd ||
        adapter.resolveSession(hookCtx) !== parent) {
      releaseScope('session_changed');
    } else if (lease.promptRecorded && !parent.messages.some(message => isRequestMessage(message, lease.scope.identity))) {
      releaseScope('history_changed');
    }
  }

  function context(event, hookCtx) {
    const lease = active;
    if (!lease || !lease.contextActive || lease.superseded ||
        (lease.scope.signal.aborted && !lease.scope.isCompleted()) ||
        hookCtx.sessionManager.getSessionId() !== sessionId || adapter.resolveSession(hookCtx) !== parent) return;
    const index = event.messages.findLastIndex(message => isRequestMessage(message, lease.scope.identity));
    if (index < 0 || event.messages.slice(index + 1).some(isUserMessage)) return;
    const instructions = lease.scope.request.instructions ?? '';
    const format = lease.scope.isCompleted()
      ? 'The RPC result is already accepted. Do not call rpc_result again or restart this request. Finish this native turn according to any applicable post-submission instructions above; later CLI input is unaffected.'
      : lease.scope.request.responseMode === 'structured'
        ? 'For this request only, finish by calling rpc_result with the requested result after all caller tools settle. Do not treat ordinary chat text as a structured result.'
        : '';
    if (!instructions && !format) return;
    return {
      messages: [...event.messages, {
        role: 'user',
        content: [
          'Request-scoped user task context for the current LAN RPC request only. This is subordinate to the conversation system/developer instructions and does not apply to later user turns.',
          instructions,
          format,
        ].filter(Boolean).join('\n\n'),
        timestamp: Date.now(),
      }],
    };
  }

  return {
    supported: true,
    reservedToolNames: parent.getAllToolNames(),
    context,
    reconcileContext,
    drainTools: () => toolDrain,
    async execute(scope) {
      assertParentCurrent();
      throwIfAborted(scope.signal);
      if (cleanupError) throw unsupported(`RPC tools could not be restored: ${cleanupError.message}`);
      if (active || !ctx.isIdle() || ctx.hasPendingMessages() || parent.isStreaming) {
        throw failure(409, 'host_busy', 'The selected conversation is no longer idle');
      }
      if (typeof scope.isCompleted !== 'function' || typeof scope.interruptFromHost !== 'function') {
        throw unsupported('The RPC controller does not expose request commitment and native interruption state');
      }
      if (parent.getAllToolNames().some(name => parent.hasRpcHostTool(name))) {
        throw unsupported('The selected conversation RPC tool slot is already in use');
      }
      const lease = { scope, contextActive: true, ownsPrompt: false, promptRecorded: false, superseded: false, toolsTouched: false };
      active = lease;
      let aborting;
      let nativeEventError;
      const abortOwnedPrompt = () => {
        if (lease.superseded || !lease.ownsPrompt || scope.isCompleted() || aborting) return;
        try { assertParentCurrent(); }
        catch { lease.ownsPrompt = false; return; }
        // Invoke synchronously while ownership is still ours; never schedule a
        // deferred abort that could hit the next user's native turn.
        try { aborting = Promise.resolve(parent.abort()); }
        catch (error) { aborting = Promise.reject(error); }
        void aborting.catch(() => {});
      };
      const onAbort = () => {
        if (scope.isCompleted()) return;
        lease.contextActive = false;
        abortOwnedPrompt();
        try {
          operations.emit('host.execution.cancelled', {
            sessionId,
            ...scope.identity,
            state: 'cancelled',
            reason: scope.signal.reason?.code ?? 'request_terminated',
          });
        } catch {}
        void removeTools(lease);
      };
      scope.signal.addEventListener('abort', onAbort, { once: true });
      try {
        const assertCurrent = () => {
          assertParentCurrent();
          throwIfAborted(scope.signal);
          if (lease.superseded || active !== lease) throw failure(409, 'host_cancelled', 'The host ended this RPC request scope');
        };
        const requestTools = buildRequestTools(adapter, scope, assertCurrent, operations, sessionId);
        const registeredNames = new Set(parent.getAllToolNames());
        if (requestTools.some(tool => registeredNames.has(tool.name))) {
          throw unsupported('A request tool conflicts with the selected conversation tool registry');
        }
        lease.toolsTouched = requestTools.length > 0;
        if (lease.toolsTouched) {
          lease.installing = parent.refreshRpcHostTools(requestTools);
          await lease.installing;
        }
        assertCurrent();
        if (!ctx.isIdle() || ctx.hasPendingMessages() || parent.isStreaming) {
          throw failure(409, 'host_busy', 'The selected conversation became busy before RPC admission');
        }
        lease.unsubscribe = parent.subscribe(event => {
          if (event.type === 'message_start' && isRequestMessage(event.message, scope.identity)) {
            lease.promptRecorded = true;
            lease.ownsPrompt = !lease.superseded;
            if (scope.signal.aborted) abortOwnedPrompt();
          }
          if (lease.superseded) return;
          if (event.type === 'message_start' && isUserMessage(event.message) &&
              !isRequestMessage(event.message, scope.identity)) {
            lease.ownsPrompt = false;
            lease.contextActive = false;
            // The host accepted this input. Do not cancel its turn or a structured
            // RPC: only an explicit rpc_result can publish that reply. Native
            // transcript forwarding must stop before including CLI messages.
            if (scope.request.responseMode === 'native') releaseScope('native_user_message');
            return;
          }
          if (event.type === 'agent_end' && event.isTerminal !== false) lease.ownsPrompt = false;
          if (event.type === 'tool_execution_end' && event.toolName === 'rpc_result' &&
              scope.isCompleted()) {
            void removeTools(lease);
          }
          if (scope.request.responseMode !== 'native' || scope.signal.aborted || nativeEventError) return;
          try { scope.emitNative(event); }
          catch (error) { nativeEventError = error; abortOwnedPrompt(); }
        });
        // No streamingBehavior: the native API must reject a busy race, not
        // silently steer/queue this task into someone else's turn.
        const dispatched = await adapter.promptSession(parent, {
          customType: REQUEST_MESSAGE_TYPE,
          content: scope.request.message,
          display: true,
          details: { ...scope.identity },
          attribution: 'user',
        }, () => {
          lease.ownsPrompt = !lease.superseded;
          if (scope.signal.aborted) abortOwnedPrompt();
        }, scope.signal);
        lease.ownsPrompt = false;
        if (nativeEventError) throw nativeEventError;
        if (lease.superseded && !scope.isCompleted()) throw failure(409, 'host_cancelled', 'The host ended this RPC request scope');
        if (!scope.isCompleted()) throwIfAborted(scope.signal);
        assertParentCurrent();
        if (dispatched !== true) throw failure(409, 'host_cancelled', 'The host declined the RPC prompt before dispatch');
        const messages = parent.messages;
        const requestIndex = messages.findLastIndex(message => isRequestMessage(message, scope.identity));
        if (requestIndex < 0) throw failure(409, 'history_changed', 'The host removed the RPC request from conversation history');
        return {
          messages: messages.slice(requestIndex),
          stopReason: parent.getLastAssistantMessage?.()?.stopReason,
        };
      } finally {
        lease.ownsPrompt = false;
        lease.contextActive = false;
        scope.signal.removeEventListener('abort', onAbort);
        lease.unsubscribe?.();
        try {
          if (aborting) await aborting;
        } finally {
          try { await removeTools(lease); }
          finally { if (active === lease) active = undefined; }
        }
      }
    },
  };
}
