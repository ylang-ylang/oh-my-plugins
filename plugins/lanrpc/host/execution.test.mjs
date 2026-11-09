import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRequestTools,
  createRequestExecutor,
  parameterProjection,
  resultParameters,
} from './execution.mjs';
import { ompParameters } from './adapters/omp.mjs';
import { createHostAdapter } from './adapters/index.mjs';

function defineTool(definition) {
  const { execute, ...tool } = definition;
  return {
    ...tool,
    execute(toolCallId, params, signal, onUpdate, context) {
      return execute({ toolCallId, params, signal, onUpdate, context });
    },
  };
}

const TOOL_ADAPTER = Object.freeze({ parameters: ompParameters, defineTool });

test('host parameter projection never carries caller validation programs', () => {
  const source = {
    type: 'object',
    properties: {
      text: { type: 'string', pattern: '^(a+)+$' },
      count: { type: 'number', minimum: 1 },
      optional: { type: 'array', uniqueItems: true },
      referenced: { $ref: '#/$defs/value' },
      ['__proto__']: { type: 'boolean' },
    },
    patternProperties: { '^(x+)+$': { type: 'string' } },
    required: ['text', 'count', 'referenced', '__proto__'],
    additionalProperties: false,
    $defs: { value: { type: 'string', minLength: 1 } },
  };

  assert.deepEqual(parameterProjection(source), {
    type: 'object',
    properties: {
      text: { type: ['string'] },
      count: { type: ['number'] },
      referenced: {},
      ['__proto__']: { type: ['boolean'] },
    },
    required: ['text', 'count', 'referenced', '__proto__'],
    additionalProperties: true,
  });
  assert.equal(source.properties.text.pattern, '^(a+)+$');
  assert.equal(source.patternProperties['^(x+)+$'].type, 'string');
  assert.equal(Object.hasOwn(parameterProjection(source).properties, '__proto__'), true);
});

test('host schema adapter advertises only the safe projection and performs only an object check', () => {
  const source = {
    type: 'object',
    properties: { text: { type: 'string', pattern: '^(a+)+$' } },
    required: ['text'],
    additionalProperties: false,
  };
  const parameters = ompParameters(parameterProjection(source));
  const valueRejectedByCallerSchema = { text: 'not a run of a characters' };

  assert.equal(typeof parameters, 'function');
  assert.strictEqual(parameters(valueRejectedByCallerSchema), valueRejectedByCallerSchema);
  assert.deepEqual(parameters.toJsonSchema(), {
    type: 'object',
    properties: { text: { type: ['string'] } },
    required: ['text'],
    additionalProperties: false,
  });
  assert.throws(() => parameters([]), /must be a JSON object/);
  assert.equal(source.properties.text.pattern, '^(a+)+$');
});

test('rpc_result projection does not rewrite caller reference namespaces', () => {
  const source = {
    $id: 'https://schemas.example.test/result',
    $anchor: 'root',
    $ref: '#/$defs/object',
    $defs: {
      object: {
        type: 'object',
        properties: { next: { $dynamicRef: '#root' } },
      },
    },
  };

  assert.deepEqual(resultParameters(source), {
    type: 'object',
    properties: { result: {} },
    required: ['result'],
    additionalProperties: false,
  });
  assert.equal(source.$id, 'https://schemas.example.test/result');
  assert.equal(source.$ref, '#/$defs/object');
  assert.equal(source.$defs.object.properties.next.$dynamicRef, '#root');
});

test('rpc_result safely projects direct shapes and boolean schemas', () => {
  assert.deepEqual(resultParameters({ type: 'string', pattern: '^(a+)+$' }).properties.result, {
    type: ['string'],
  });
  assert.deepEqual(resultParameters({ type: 'array', uniqueItems: true }).properties.result, {
    type: ['array'],
  });
  assert.deepEqual(resultParameters({ type: 'object', patternProperties: { '^(x+)+$': true } }).properties.result, {
    type: ['object'],
  });
  assert.deepEqual(resultParameters(true).properties.result, {});
  assert.deepEqual(resultParameters(false).properties.result, {});
});

test('rpc_result awaits isolated validation before acknowledging submission', async () => {
  let release;
  const submitted = new Promise(resolve => { release = resolve; });
  let currentChecks = 0;
  const tools = buildRequestTools(TOOL_ADAPTER, {
    request: { tools: [], responseMode: 'structured', resultSchema: { type: 'string', pattern: '^ok$' } },
    capabilities: { artifacts: false },
    submitResult: async () => submitted,
  }, () => { currentChecks += 1; });
  const rpcResult = tools.find(tool => tool.name === 'rpc_result');

  let settled = false;
  const execution = rpcResult.execute('call-id', { result: 'ok' }, undefined, undefined).then(value => {
    settled = true;
    return value;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  release({ accepted: true });
  const result = await execution;

  assert.equal(currentChecks, 2);
  assert.deepEqual(result.details, { accepted: true });
  assert.match(rpcResult.description, /\{"type":"string","pattern":"\^ok\$"\}/);
});

test('isolated validation failures remain correctable model tool errors', async () => {
  const validationError = Object.assign(new Error('input did not match'), {
    status: 422,
    code: 'schema_validation',
    details: { errors: [{ instancePath: '/text', keyword: 'pattern', message: 'must match pattern' }] },
  });
  const tools = buildRequestTools(TOOL_ADAPTER, {
    request: {
      tools: [{
        name: 'caller_tool',
        description: 'Call a remote tool.',
        inputSchema: { type: 'object', properties: { text: { type: 'string', pattern: '^ok$' } }, required: ['text'] },
      }],
      responseMode: 'native',
    },
    capabilities: { artifacts: false },
    invokeTool: async () => { throw validationError; },
  }, () => {});

  await assert.rejects(
    tools[0].execute('call-id', { text: 'wrong' }, undefined, undefined),
    error => {
      assert.equal(error.status, 422);
      assert.equal(error.code, 'schema_validation');
      assert.strictEqual(error.details, validationError.details);
      assert.match(error.message, /schema_validation: input did not match/);
      assert.match(error.message, /must match pattern/);
      return true;
    },
  );
  assert.match(tools[0].description, /\{"type":"object".*"pattern":"\^ok\$"/);
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function conversationHost(run, adapterOverrides = {}) {
  const listeners = new Set();
  const readTool = { name: 'read', approval: () => 'read', execute: async () => ({ content: [] }) };
  const disabledTool = { name: 'disabled', approval: () => 'exec' };
  const registry = new Map([[readTool.name, readTool], [disabledTool.name, disabledTool]]);
  const rpcNames = new Set();
  const history = [];
  const prompts = [];
  const refreshes = [];
  const aborts = [];
  const terminalStops = [];
  const sessionManager = { getSessionId: () => 'selected-session' };
  const parent = {
    sessionManager,
    messages: history,
    isStreaming: false,
    agent: {
      state: { tools: [readTool] },
      abort: reason => { terminalStops.push(reason); },
    },
    getAllToolNames: () => [...registry.keys()],
    hasRpcHostTool: name => rpcNames.has(name),
    getLastAssistantMessage: () => history.findLast(message => message.role === 'assistant'),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async refreshRpcHostTools(tools) {
      refreshes.push(tools);
      const ordinary = this.agent.state.tools.filter(tool => !rpcNames.has(tool.name));
      for (const name of rpcNames) registry.delete(name);
      rpcNames.clear();
      for (const tool of tools) {
        assert.equal(registry.has(tool.name), false);
        registry.set(tool.name, tool);
        rpcNames.add(tool.name);
      }
      this.agent.state.tools = [...ordinary, ...tools];
    },
    async promptCustomMessage(payload, options) {
      assert.strictEqual(this, parent);
      assert.equal(this.isStreaming, false);
      assert.equal(options?.streamingBehavior, undefined);
      prompts.push(payload);
      this.isStreaming = true;
      options?.onPromptAdmitted?.();
      const message = { role: 'custom', ...payload, timestamp: 1 };
      history.push(message);
      emit({ type: 'agent_start' });
      emit({ type: 'message_start', message });
      emit({ type: 'message_end', message });
      try { await run?.({ parent, payload, options, message, emit, append }); }
      finally {
        this.isStreaming = false;
        emit({ type: 'agent_end', messages: [...history], isTerminal: true });
      }
      return true;
    },
    async abort() { aborts.push('abort'); },
  };
  const ctx = {
    agent: { id: 'Main' },
    sessionManager,
    cwd: '/work',
    isIdle: () => !parent.isStreaming,
    hasPendingMessages: () => false,
  };
  const adapter = {
    ...TOOL_ADAPTER,
    capabilities: { features: { lanRpcExecution: true }, reasons: {} },
    resolveSession: () => parent,
    promptSession: (session, payload, onPromptAdmitted) =>
      session.promptCustomMessage(payload, { onPromptAdmitted }),
    ...adapterOverrides,
  };
  function emit(event) { for (const listener of listeners) listener(event); }
  function append(message) {
    history.push(message);
    emit({ type: 'message_start', message });
    emit({ type: 'message_end', message });
  }
  const executor = createRequestExecutor(adapter, ctx);
  return { adapter, ctx, parent, executor, history, prompts, refreshes, aborts, terminalStops, readTool, disabledTool, registry, emit, append };
}

function requestScope(overrides = {}) {
  const cancellation = new AbortController();
  const events = [];
  let completed = false;
  const scope = {
    identity: { instanceId: 'instance', generation: 7, requestId: 'request' },
    request: { message: 'Visible incoming request', instructions: '', tools: [], responseMode: 'native' },
    capabilities: { artifacts: false },
    signal: cancellation.signal,
    isCompleted: () => completed,
    interruptFromHost: reason => cancellation.abort(Object.assign(new Error('Native request scope ended'), { code: reason })),
    emitNative: event => events.push(event),
    submitResult: async () => {
      completed = true;
      cancellation.abort();
      return { accepted: true };
    },
    ...overrides,
  };
  return { scope, cancellation, events };
}

test('RPC prompts and preserves the selected real conversation with native events and messages', async () => {
  const assistant = { role: 'assistant', content: [{ type: 'text', text: 'Native answer' }], stopReason: 'stop' };
  const host = conversationHost(async ({ parent, append }) => {
    assert.equal(parent.agent.state.tools.some(tool => tool.name === 'rpc_result'), false);
    append(assistant);
  });
  const existing = { role: 'user', content: 'Earlier CLI conversation' };
  host.history.push(existing);
  const { scope, events } = requestScope();
  assert.equal(host.executor.supported, true);
  const output = await host.executor.execute(scope);

  assert.strictEqual(host.parent.messages, host.history);
  assert.strictEqual(host.history[0], existing);
  assert.equal(host.history[1].content, scope.request.message);
  assert.equal(host.history[1].display, true);
  assert.deepEqual(host.history[1].details, scope.identity);
  assert.strictEqual(host.history[2], assistant);
  assert.deepEqual(output.messages, host.history.slice(1));
  assert.strictEqual(output.messages.at(-1), assistant);
  assert.equal(output.stopReason, 'stop');
  assert.ok(events.some(event => event.type === 'message_end' && event.message === assistant));
  assert.deepEqual(host.aborts, []);
  assert.deepEqual(host.terminalStops, []);
});

test('pre-admission compaction preserves the request and returns its complete native reply', async () => {
  const answer = { role: 'assistant', content: [{ type: 'text', text: 'After compaction' }], stopReason: 'stop' };
  const host = conversationHost(async ({ append }) => append(answer), {
    promptSession: (parent, payload, onPromptAdmitted) => {
      host.history.splice(0, host.history.length, { role: 'user', content: 'Compacted previous history' });
      host.executor.reconcileContext(host.ctx);
      return parent.promptCustomMessage(payload, { onPromptAdmitted });
    },
  });
  host.history.push(...Array.from({ length: 5 }, () => ({ role: 'user', content: 'Earlier history' })));
  const { scope, cancellation } = requestScope();
  const output = await host.executor.execute(scope);
  assert.equal(cancellation.signal.aborted, false);
  assert.deepEqual(output.messages.map(message => message.role), ['custom', 'assistant']);
  assert.deepEqual(output.messages[0].details, scope.identity);
  assert.deepEqual(output.messages[1], answer);
});

test('native caller tools run in the parent, persist tool results, and restore existing permissions', async () => {
  const remoteWait = deferred();
  const started = deferred();
  let tool;
  const host = conversationHost(async ({ parent, append, emit }) => {
    tool = parent.agent.state.tools.find(candidate => candidate.name === 'lookup');
    assert.equal(tool.loadMode, 'essential');
    append({ role: 'assistant', content: [{ type: 'toolCall', id: 'native-call', name: 'lookup', arguments: { key: 'abc' } }], stopReason: 'toolUse' });
    emit({ type: 'tool_execution_start', toolCallId: 'native-call', toolName: 'lookup', args: { key: 'abc' } });
    started.resolve();
    const result = await tool.execute('native-call', { key: 'abc' }, new AbortController().signal, () => {}, {});
    emit({ type: 'tool_execution_end', toolCallId: 'native-call', toolName: 'lookup', result, isError: false });
    append({ role: 'toolResult', toolCallId: 'native-call', toolName: 'lookup', ...result });
    append({ role: 'assistant', content: [{ type: 'text', text: 'Found actual value' }], stopReason: 'stop' });
  });
  const { scope, events } = requestScope({
    request: {
      message: 'Look up abc', instructions: '', responseMode: 'native',
      tools: [{ name: 'lookup', description: 'Lookup by key', inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } }],
    },
    invokeTool: async (name, args, id) => {
      assert.equal(name, 'lookup');
      assert.deepEqual(args, { key: 'abc' });
      assert.equal(id, 'native-call');
      return remoteWait.promise;
    },
  });
  const execution = host.executor.execute(scope);
  await started.promise;
  assert.equal(host.registry.has('lookup'), true);
  assert.equal(host.history.some(message => message.role === 'toolResult'), false);
  remoteWait.resolve({ status: 'completed', result: { value: 42 } });
  const output = await execution;

  const persisted = host.history.find(message => message.role === 'toolResult');
  assert.deepEqual(persisted.details, { value: 42 });
  assert.ok(output.messages.includes(persisted));
  assert.ok(events.some(event => event.type === 'tool_execution_end' && event.result.details.value === 42));
  assert.equal(host.registry.has('lookup'), false);
  assert.strictEqual(host.parent.agent.state.tools[0], host.readTool);
  assert.strictEqual(host.parent.agent.state.tools[0].approval, host.readTool.approval);
  assert.equal(host.parent.agent.state.tools.includes(host.disabledTool), false);
  assert.strictEqual(host.registry.get('disabled'), host.disabledTool);
  await assert.rejects(tool.execute('late', { key: 'abc' }), error => error.code === 'host_cancelled');
});

test('instructions and structured output guidance affect only the current provider context', async () => {
  let injected;
  let tagged;
  const host = conversationHost(async ({ message }) => {
    tagged = message;
    injected = host.executor.context({ messages: [...host.history] }, host.ctx);
    assert.match(injected.messages.at(-1).content, /Private current-only task context/);
    assert.match(injected.messages.at(-1).content, /rpc_result/);
    assert.equal(injected.messages.at(-1).role, 'user');
    // Another request's identity cannot acquire these rules.
    assert.equal(host.executor.context({ messages: [{ ...message, details: { ...message.details, requestId: 'other' } }] }, host.ctx), undefined);
    // A later native user context excludes the request-specific rules.
    assert.equal(host.executor.context({ messages: [...host.history, { role: 'user', content: 'CLI successor' }] }, host.ctx), undefined);
  });
  const { scope } = requestScope({ request: {
    message: 'Visible only', instructions: 'Private current-only task context', tools: [], responseMode: 'structured', resultSchema: true,
  } });
  await host.executor.execute(scope);
  assert.equal(tagged.content, 'Visible only');
  assert.equal(JSON.stringify(host.history).includes('Private current-only task context'), false);
  assert.equal(host.executor.context({ messages: host.history }, host.ctx), undefined);
  assert.equal(host.parent.agent.state.tools.some(tool => tool.name === 'rpc_result'), false);
  assert.equal(host.prompts[0].content, 'Visible only');
});

test('successful rpc_result preserves its tool result and lets OMP finish normally', async () => {
  let actualResult;
  const host = conversationHost(async ({ parent, append, emit }) => {
    const tool = parent.agent.state.tools.find(candidate => candidate.name === 'rpc_result');
    append({ role: 'assistant', content: [{ type: 'toolCall', id: 'result-call', name: 'rpc_result', arguments: { result: 42 } }], stopReason: 'toolUse' });
    actualResult = await tool.execute('result-call', { result: 42 }, new AbortController().signal, () => {}, {});
    emit({ type: 'tool_execution_end', toolCallId: 'result-call', toolName: 'rpc_result', result: actualResult, isError: false });
    append({ role: 'toolResult', toolCallId: 'result-call', toolName: 'rpc_result', ...actualResult });
    append({ role: 'assistant', content: [{ type: 'text', text: 'Native completion after tool submission' }], stopReason: 'stop' });
  });
  const { scope } = requestScope({ request: {
    message: 'Return a number', instructions: '', tools: [], responseMode: 'structured', resultSchema: { type: 'number' },
  } });
  const output = await host.executor.execute(scope);
  assert.equal(scope.signal.aborted, true);
  assert.deepEqual(actualResult.details, { accepted: true });
  assert.deepEqual(host.aborts, []);
  assert.deepEqual(host.terminalStops, []);
  assert.deepEqual(host.history.find(message => message.role === 'toolResult').details, { accepted: true });
  assert.equal(output.messages.at(-1).stopReason, 'stop');
  assert.equal(host.parent.agent.state.tools.some(tool => tool.name === 'rpc_result'), false);
});

test('native transcript scope ends at an accepted user boundary without aborting OMP', async () => {
  const requestStarted = deferred();
  const releaseParent = deferred();
  const host = conversationHost(async () => {
    requestStarted.resolve();
    await releaseParent.promise;
  });
  const { scope, cancellation, events } = requestScope({ request: {
    message: 'RPC request', instructions: 'RPC-only rule', responseMode: 'native',
    tools: [{ name: 'remote_action', description: 'Remote action', inputSchema: { type: 'object' } }],
  } });
  const execution = host.executor.execute(scope);
  const rejected = assert.rejects(execution, error => error.code === 'host_cancelled');
  await requestStarted.promise;
  host.append({ role: 'user', content: 'Native successor steer' });
  assert.equal(host.executor.context({ messages: host.history }, host.ctx), undefined);
  assert.equal(cancellation.signal.aborted, true);
  // Equivalent to the native before_agent_start barrier: only the registry
  // mutation settles; the still-live parent prompt is deliberately not drained.
  await host.executor.drainTools();
  assert.equal(host.parent.isStreaming, true);
  assert.equal(host.registry.has('remote_action'), false);
  const nativeCount = events.length;
  host.append({ role: 'assistant', content: [{ type: 'text', text: 'Answer to native user' }], stopReason: 'stop' });
  assert.equal(events.length, nativeCount);
  assert.deepEqual(host.aborts, []);
  assert.equal(host.history.at(-1).content[0].text, 'Answer to native user');
  releaseParent.resolve();
  await rejected;
  assert.deepEqual(host.aborts, []);
  assert.deepEqual(host.terminalStops, []);
});

test('structured RPC survives native CLI steering and publishes only its explicit result', async () => {
  let accepted;
  const host = conversationHost(async ({ parent, append, emit }) => {
    append({ role: 'user', content: 'Continue with my clarification' });
    const tool = parent.agent.state.tools.find(candidate => candidate.name === 'rpc_result');
    accepted = await tool.execute('result-after-steer', { result: 'scoped answer' }, new AbortController().signal, () => {}, {});
    emit({ type: 'tool_execution_end', toolName: 'rpc_result', result: accepted, isError: false });
    append({ role: 'assistant', content: [{ type: 'text', text: 'Native turn completed' }], stopReason: 'stop' });
  });
  const { scope } = requestScope({ request: {
    message: 'RPC request', instructions: 'Request-scoped rules', tools: [],
    responseMode: 'structured', resultSchema: { type: 'string' },
  } });
  await host.executor.execute(scope);
  assert.deepEqual(accepted.details, { accepted: true });
  assert.deepEqual(host.aborts, []);
  assert.deepEqual(host.terminalStops, []);
  assert.equal(host.registry.has('rpc_result'), false);
});

test('history reconciliation revokes only a removed request anchor without aborting OMP', async () => {
  const started = deferred();
  const finish = deferred();
  const host = conversationHost(async () => { started.resolve(); await finish.promise; });
  const { scope } = requestScope();
  const execution = host.executor.execute(scope);
  const rejected = assert.rejects(execution, error => error.code === 'host_cancelled');
  await started.promise;
  host.executor.reconcileContext(host.ctx);
  assert.equal(scope.signal.aborted, false);
  host.history.length = 0;
  host.executor.reconcileContext(host.ctx);
  assert.equal(scope.signal.reason.code, 'history_changed');
  assert.deepEqual(host.aborts, []);
  finish.resolve();
  await rejected;
});

test('explicit cancellation aborts the owned prompt once and cannot abort a later CLI turn', async () => {
  const started = deferred();
  const stopped = deferred();
  const host = conversationHost(async () => { started.resolve(); await stopped.promise; });
  host.parent.abort = async () => { host.aborts.push('owned RPC'); stopped.resolve(); };
  const { scope, cancellation } = requestScope();
  const execution = host.executor.execute(scope);
  const rejected = assert.rejects(execution, /client cancellation/);
  await started.promise;
  cancellation.abort(new Error('client cancellation'));
  await rejected;
  host.parent.isStreaming = true;
  host.append({ role: 'user', content: 'Next CLI turn' });
  cancellation.abort();
  await Promise.resolve();
  assert.deepEqual(host.aborts, ['owned RPC']);
});

test('legacy prompt admission aborts only after the exact RPC message starts', async () => {
  const legacy = await createHostAdapter({
    pi: {
      VERSION: '18.2.6',
      Text: class {},
      AgentRegistry: { global: () => ({ list: () => [] }) },
    },
  }, { loadModule: async specifier => {
    if (specifier === '@oh-my-pi/pi-tui') return { Text: class {}, matchesKey() {} };
    throw new Error(`Unexpected test import: ${specifier}`);
  } });
  const started = deferred();
  const stopped = deferred();
  const host = conversationHost(async () => { started.resolve(); await stopped.promise; }, {
    promptSession: legacy.promptSession,
  });
  host.parent.abort = async () => { host.aborts.push('legacy owned RPC'); stopped.resolve(); };
  const { scope, cancellation } = requestScope();
  const execution = host.executor.execute(scope);
  const rejected = assert.rejects(execution, /legacy cancellation/);

  await started.promise;
  cancellation.abort(new Error('legacy cancellation'));
  await rejected;
  assert.deepEqual(host.aborts, ['legacy owned RPC']);
});

test('a busy race after temporary tool installation never steers, queues, or aborts another parent turn', async () => {
  const host = conversationHost();
  const install = host.parent.refreshRpcHostTools.bind(host.parent);
  host.parent.refreshRpcHostTools = async tools => {
    await install(tools);
    if (tools.length) host.parent.isStreaming = true;
  };
  const { scope } = requestScope({ request: {
    message: 'Do not queue this', instructions: '', tools: [], responseMode: 'structured', resultSchema: true,
  } });
  await assert.rejects(host.executor.execute(scope), error => error.code === 'host_busy');
  assert.deepEqual(host.prompts, []);
  assert.deepEqual(host.aborts, []);
  assert.equal(host.registry.has('rpc_result'), false);
  assert.strictEqual(host.parent.agent.state.tools[0], host.readTool);
});

test('unsupported conversation APIs and pre-existing RPC ownership fail closed without children', async () => {
  const host = conversationHost();
  host.parent.promptCustomMessage = undefined;
  const unsupported = createRequestExecutor(host.adapter, host.ctx);
  assert.equal(unsupported.supported, false);
  await assert.rejects(unsupported.execute(requestScope().scope), error => error.code === 'host_unsupported');
  const occupied = conversationHost();
  const owned = { name: 'other_rpc_tool', approval: 'exec' };
  await occupied.parent.refreshRpcHostTools([owned]);
  const cannotReplace = createRequestExecutor(occupied.adapter, occupied.ctx);
  assert.equal(cannotReplace.supported, false);
  assert.strictEqual(occupied.registry.get(owned.name), owned);
});

test('native tool signal is the third argument and can release a pending caller result wait', async () => {
  const pending = deferred();
  const signal = new AbortController();
  const tools = buildRequestTools(TOOL_ADAPTER, {
    request: { tools: [{ name: 'remote', description: 'Wait for caller', inputSchema: { type: 'object' } }], responseMode: 'native' },
    capabilities: { artifacts: false },
    invokeTool: () => pending.promise,
  }, () => {});
  const outcome = tools[0].execute('native', {}, signal.signal, () => {}, {});
  signal.abort();
  await assert.rejects(outcome, error => error.name === 'AbortError');
  pending.reject(new Error('Late caller failure must be handled'));
  await Promise.resolve();
});

test('accepted result retains current-turn completion guidance but not later CLI policy', async () => {
  const marker = 'Request-only completion guidance marker';
  const host = conversationHost(async ({ parent, append, emit }) => {
    const resultTool = parent.agent.state.tools.find(tool => tool.name === 'rpc_result');
    const accepted = await resultTool.execute('completion-call', { result: 'answer' }, new AbortController().signal, () => {}, {});
    append({ role: 'toolResult', toolCallId: 'completion-call', toolName: 'rpc_result', ...accepted });
    emit({ type: 'tool_execution_end', toolName: 'rpc_result', result: accepted, isError: false });
    await host.executor.drainTools();
    assert.equal(host.registry.has('rpc_result'), false);
    const finishing = host.executor.context({ messages: host.history }, host.ctx);
    assert.ok(finishing.messages.at(-1).content.includes(marker));
    append({ role: 'user', content: 'A new ordinary CLI question' });
    assert.equal(host.executor.context({ messages: host.history }, host.ctx), undefined);
  });
  const { scope } = requestScope({ request: {
    message: 'RPC task', instructions: marker, tools: [],
    responseMode: 'structured', resultSchema: { type: 'string' },
  } });
  await host.executor.execute(scope);
  assert.equal(host.executor.context({ messages: host.history }, host.ctx), undefined);
  assert.equal(JSON.stringify(host.history).includes(marker), false);
  assert.deepEqual(host.aborts, []);
  assert.deepEqual(host.terminalStops, []);
});
