import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequestExecutor } from '../execution.mjs';
import { createPiHostAdapter } from './pi.mjs';
import { piSessionConstants } from './pi-session.mjs';

function missingPackage(specifier) {
  return Object.assign(new Error(`Cannot find package '${specifier}' imported from test`), {
    code: 'ERR_MODULE_NOT_FOUND',
  });
}

function moduleLoader(version) {
  const legacy = version.startsWith('0.73');
  return async specifier => {
    if (specifier === (legacy ? '@mariozechner/pi-coding-agent' : '@earendil-works/pi-coding-agent')) {
      return { VERSION: version };
    }
    if (specifier === (legacy ? '@mariozechner/pi-tui' : '@earendil-works/pi-tui')) {
      return { Text: class Text {}, matchesKey: (value, key) => value === key };
    }
    throw missingPackage(specifier);
  };
}

function fakePi({ version = '1.5.0', oldAutoActivate = version.startsWith('0.') } = {}) {
  const handlers = new Map();
  const extensionSource = Object.freeze({ path: '/extensions/lan-rpc.mjs' });
  const builtinSource = Object.freeze({ path: '<builtin:read>' });
  const readTool = {
    name: 'read', label: 'Read', description: 'Read a file',
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ content: [] }), sourceInfo: builtinSource,
  };
  const registry = new Map([['read', readTool]]);
  let active = ['read'];
  let busy = false;
  let session = 'pi-session';
  let branch = [];
  let onSend = () => {};
  const sends = [];
  const aborts = [];
  const asyncErrors = [];
  const sessionManager = {
    getSessionId: () => session,
    getBranch: () => [...branch],
  };
  const ui = { setStatus() {} };
  const ctx = {
    mode: 'tui',
    cwd: '/work',
    sessionManager,
    ui,
    isIdle: () => !busy,
    hasPendingMessages: () => false,
    abort() { aborts.push('abort'); },
  };
  const api = {
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {
        const index = list.indexOf(handler);
        if (index >= 0) list.splice(index, 1);
      };
    },
    registerTool(tool) {
      registry.set(tool.name, { ...tool, sourceInfo: extensionSource });
      if (oldAutoActivate && !active.includes(tool.name)) active.push(tool.name);
    },
    sendMessage(message, options) {
      sends.push({ message, options });
      try {
        const pending = onSend(message, options);
        if (pending?.then) pending.catch(error => asyncErrors.push(error));
      } catch (error) {
        throw error;
      }
    },
    getAllTools() {
      return [...registry.values()].map(tool => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        exposure: tool.exposure,
        sourceInfo: tool.sourceInfo,
      }));
    },
    getActiveTools: () => [...active],
    setActiveTools(names) {
      active = [...new Set(names)].filter(name => {
        const tool = registry.get(name);
        return tool && (oldAutoActivate || tool.exposure !== 'hidden');
      });
    },
    registerCommand() {},
  };
  async function emit(type, payload, eventCtx = ctx) {
    for (const handler of [...(handlers.get(type) ?? [])]) await handler({ type, ...payload }, eventCtx);
  }
  function addExternal(tool, activate = false) {
    const definition = { ...tool, sourceInfo: tool.sourceInfo ?? Object.freeze({ path: `/external/${tool.name}` }) };
    registry.set(tool.name, definition);
    if (activate && !active.includes(tool.name)) active.push(tool.name);
    return definition;
  }
  return {
    api, ctx, ui, sessionManager, registry, sends, aborts, asyncErrors, emit, addExternal,
    set busy(value) { busy = value; },
    get busy() { return busy; },
    set branch(value) { branch = value; },
    get branch() { return branch; },
    set sessionId(value) { session = value; },
    set onSend(value) { onSend = value; },
  };
}

async function adapterFor(host, version = '1.5.0') {
  return createPiHostAdapter(host.api, { loadModule: moduleLoader(version) });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function requestPayload(requestId = 'request') {
  return {
    customType: piSessionConstants.REQUEST_MESSAGE_TYPE,
    content: 'Remote request',
    display: true,
    details: { instanceId: 'instance', generation: 1, requestId },
  };
}

function customMessage(payload) {
  return { role: 'custom', ...payload, timestamp: Date.now() };
}

test('Pi adapter reports actual APIs and adapts old and new context shapes', async () => {
  const host = fakePi();
  const adapter = await adapterFor(host);
  assert.equal(adapter.capabilities.features.lanRpcExecution, true);
  assert.equal(adapter.capabilities.statusMode, 'extension');
  assert.equal(adapter.identity.version, '1.5.0');

  const current = adapter.adaptContext({
    mode: 'tui', hasUI: false, sessionManager: host.sessionManager, ui: host.ui,
  });
  assert.equal(current.hasUI, true);
  assert.strictEqual(current.sessionManager, host.sessionManager);
  assert.strictEqual(current.ui, host.ui);
  assert.equal(typeof current.setInterval, 'function');
  assert.equal(typeof current.clearInterval, 'function');
  assert.equal(typeof current.clearTimer, 'function');

  const oldSetInterval = () => 7;
  const oldClearTimer = () => {};
  const legacy = adapter.adaptContext({
    hasUI: true, sessionManager: host.sessionManager, ui: host.ui,
    setInterval: oldSetInterval, clearTimer: oldClearTimer,
  });
  assert.equal(legacy.hasUI, true);
  assert.strictEqual(legacy.setInterval, oldSetInterval);
  assert.strictEqual(legacy.clearTimer, oldClearTimer);

  const parameters = { type: 'object', properties: { value: { type: 'integer' } } };
  const calls = [];
  const tool = adapter.defineTool({
    name: 'result', label: 'Result', description: 'Result',
    parameters: adapter.parameters(parameters), approval: 'read', loadMode: 'essential', concurrency: 'exclusive',
    execute: async invocation => { calls.push(invocation); return { content: [] }; },
  });
  assert.notStrictEqual(tool.parameters, parameters);
  assert.equal(tool.approval, undefined);
  assert.equal(tool.loadMode, undefined);
  assert.equal(tool.executionMode, 'sequential');
  assert.equal(tool.defaultActive, false);
  await tool.execute('call', { value: 1 }, undefined, undefined, host.ctx);
  assert.deepEqual(calls[0], {
    toolCallId: 'call', params: { value: 1 }, signal: undefined, onUpdate: undefined, context: host.ctx,
  });
});

test('current Pi correlates exact custom admission and completes only at agent_settled', async () => {
  const host = fakePi();
  const prior = { role: 'user', content: 'prior conversation' };
  host.branch = [{ type: 'message', id: 'prior', parentId: null, timestamp: new Date().toISOString(), message: prior }];
  const adapter = await adapterFor(host);
  const parent = adapter.resolveSession(host.ctx);
  assert.strictEqual(adapter.resolveSession(host.ctx), parent);
  const payload = requestPayload();
  let admitted = 0;
  let settled = false;
  host.onSend = () => { host.busy = true; };
  const prompt = adapter.promptSession(parent, payload, () => { admitted += 1; });
  prompt.finally(() => { settled = true; });
  const compacted = { role: 'assistant', content: [{ type: 'text', text: 'summary' }], stopReason: 'stop' };
  host.branch = [{ type: 'message', id: 'summary', parentId: null, timestamp: new Date().toISOString(), message: compacted }];
  await host.emit('session_compact', { compactionEntry: {}, fromExtension: false, reason: 'threshold', willRetry: false });
  assert.deepEqual(parent.messages, [compacted]);

  await host.emit('before_agent_start', {
    messageType: 'custom', message: customMessage({ ...payload, details: { ...payload.details, requestId: 'other' } }),
    systemPrompt: '', systemPromptOptions: {},
  });
  assert.equal(admitted, 0);
  await host.emit('before_agent_start', {
    messageType: 'custom', message: customMessage(payload), systemPrompt: '', systemPromptOptions: {},
  });
  assert.equal(admitted, 1);
  await host.emit('agent_start', {});
  const request = customMessage(payload);
  const assistant = { role: 'assistant', content: [{ type: 'text', text: 'answer' }], stopReason: 'stop' };
  await host.emit('message_start', { message: request });
  await host.emit('message_end', { message: request });
  await host.emit('message_start', { message: assistant });
  await host.emit('message_end', { message: assistant });
  await host.emit('agent_end', { messages: [request, assistant] });
  await Promise.resolve();
  assert.equal(settled, false);
  host.busy = false;
  await host.emit('agent_settled', { aborted: false });
  assert.equal(await prompt, true);
  assert.equal(settled, true);
  assert.deepEqual(parent.messages, [compacted, request, assistant]);
  assert.strictEqual(parent.getLastAssistantMessage(), assistant);
  assert.deepEqual(host.sends[0].options, { triggerTurn: true });
});

test('legacy Pi completes the exact admitted run after its stable agent_end boundary', async () => {
  const host = fakePi({ version: '0.73.1' });
  const adapter = await adapterFor(host, '0.73.1');
  const parent = adapter.resolveSession({ ...host.ctx, mode: undefined, hasUI: true });
  const payload = requestPayload('legacy');
  host.onSend = () => { host.busy = true; };
  const prompt = adapter.promptSession(parent, payload, () => {});
  const request = customMessage(payload);
  await host.emit('agent_start', {});
  await host.emit('message_start', { message: request });
  await host.emit('message_end', { message: request });
  host.busy = false;
  await host.emit('agent_end', { messages: [request] });
  assert.equal(await prompt, true);
});

test('Pi tools retire without closures and a later request can replace the same name and schema', async () => {
  const host = fakePi({ oldAutoActivate: true });
  const adapter = await adapterFor(host);
  const parent = adapter.resolveSession(host.ctx);
  const secret = 'request-one-secret';
  const first = adapter.defineTool({
    name: 'caller_echo', label: 'caller_echo', description: `First ${secret}`,
    parameters: adapter.parameters({ type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }),
    execute: async ({ params }) => ({ content: [{ type: 'text', text: params.text }], details: { request: 1 } }),
  });
  await parent.refreshRpcHostTools([first]);
  const captured = host.registry.get('caller_echo');
  assert.equal(host.api.getActiveTools().includes('caller_echo'), true);
  assert.deepEqual((await captured.execute('one', { text: 'hello' })).details, { request: 1 });

  host.addExternal({
    name: 'later_tool', label: 'Later', description: 'Later tool',
    parameters: { type: 'object' }, execute: async () => ({ content: [] }),
  }, true);
  await parent.refreshRpcHostTools([]);
  assert.equal(host.api.getActiveTools().includes('caller_echo'), false);
  assert.equal(host.api.getActiveTools().includes('later_tool'), true);
  assert.equal(parent.hasRpcHostTool('caller_echo'), false);
  assert.equal(parent.getAllToolNames().includes('caller_echo'), false);
  await assert.rejects(captured.execute('stale', { text: secret }), error =>
    error.code === 'host_cancelled' && error.status === 409 && error.message === piSessionConstants.STALE_MESSAGE);
  const retired = host.registry.get('caller_echo');
  assert.equal(retired.description, piSessionConstants.RETIRED_DESCRIPTION);
  assert.deepEqual(retired.parameters, piSessionConstants.RETIRED_SCHEMA);
  assert.equal(retired.exposure, 'hidden');
  assert.equal(JSON.stringify(retired).includes(secret), false);

  const second = adapter.defineTool({
    name: 'caller_echo', label: 'caller_echo', description: 'Second numeric request',
    parameters: adapter.parameters({ type: 'object', properties: { count: { type: 'integer' } }, required: ['count'] }),
    execute: async ({ params }) => ({ content: [], details: { doubled: params.count * 2 } }),
  });
  await parent.refreshRpcHostTools([second]);
  const replacement = host.registry.get('caller_echo');
  assert.deepEqual(replacement.parameters.properties, { count: { type: 'integer' } });
  assert.deepEqual((await replacement.execute('two', { count: 3 })).details, { doubled: 6 });
  await parent.refreshRpcHostTools([]);
});

test('Pi tool collision fails before replacement and retired names never hide a new real collision', async () => {
  const host = fakePi();
  const external = host.addExternal({
    name: 'occupied', label: 'Occupied', description: 'External owner',
    parameters: { type: 'object' }, execute: async () => ({ content: [] }),
  }, true);
  const adapter = await adapterFor(host);
  const parent = adapter.resolveSession(host.ctx);
  const conflicting = adapter.defineTool({
    name: 'occupied', label: 'occupied', description: 'RPC definition',
    parameters: { type: 'object' }, execute: async () => ({ content: [] }),
  });
  await assert.rejects(parent.refreshRpcHostTools([conflicting]), error => error.code === 'host_unsupported');
  assert.strictEqual(host.registry.get('occupied'), external);

  const reusable = adapter.defineTool({
    name: 'reusable', label: 'reusable', description: 'Temporary',
    parameters: { type: 'object' }, execute: async () => ({ content: [] }),
  });
  await parent.refreshRpcHostTools([reusable]);
  await parent.refreshRpcHostTools([]);
  host.addExternal({
    name: 'reusable', label: 'Real', description: 'A new public owner',
    parameters: { type: 'object', properties: { real: { type: 'boolean' } } },
    execute: async () => ({ content: [] }),
  });
  assert.equal(parent.getAllToolNames().includes('reusable'), true);
});

test('pre-admission cancellation aborts only the synchronously started Pi run and fences late admission', async () => {
  const host = fakePi();
  const adapter = await adapterFor(host);
  const parent = adapter.resolveSession(host.ctx);
  const payload = requestPayload('cancel-before-admission');
  const controller = new AbortController();
  let admitted = 0;
  host.onSend = () => { host.busy = true; };
  const prompt = adapter.promptSession(parent, payload, () => { admitted += 1; }, controller.signal);
  controller.abort(Object.assign(new Error('cancel before admission'), { code: 'client_cancelled' }));
  await assert.rejects(prompt, /cancel before admission/);
  assert.deepEqual(host.aborts, ['abort']);
  await assert.rejects(
    adapter.promptSession(parent, requestPayload('too-early'), () => {}),
    error => error.code === 'host_busy',
  );

  await host.emit('before_agent_start', {
    messageType: 'custom', message: customMessage(payload), systemPrompt: '', systemPromptOptions: {},
  });
  await host.emit('agent_start', {});
  await host.emit('message_start', { message: customMessage(payload) });
  assert.equal(admitted, 0);
  assert.deepEqual(host.aborts, ['abort', 'abort']);
  host.busy = false;
  await host.emit('agent_settled', { aborted: true });

  host.onSend = () => { host.busy = true; };
  const next = adapter.promptSession(parent, requestPayload('after-fence'), () => {});
  await host.emit('before_agent_start', {
    messageType: 'custom', message: customMessage(requestPayload('after-fence')), systemPrompt: '', systemPromptOptions: {},
  });
  host.busy = false;
  await host.emit('agent_settled', { aborted: false });
  assert.equal(await next, true);
});

function executionScope(overrides = {}) {
  const cancellation = new AbortController();
  let completed = false;
  const scope = {
    identity: { instanceId: 'instance', generation: 1, requestId: 'steering' },
    request: {
      message: 'Structured work', instructions: '', tools: [],
      responseMode: 'structured', resultSchema: { type: 'string' },
    },
    capabilities: { artifacts: false },
    signal: cancellation.signal,
    isCompleted: () => completed,
    interruptFromHost: reason => cancellation.abort(Object.assign(new Error(reason), { code: reason })),
    submitResult: async () => { completed = true; cancellation.abort(); return { accepted: true }; },
    ...overrides,
  };
  return { scope, cancellation };
}

test('structured Pi steering clears abort ownership so cancellation cannot hit the user turn', async () => {
  const host = fakePi();
  const adapter = await adapterFor(host);
  const steered = deferred();
  const finish = deferred();
  host.onSend = async payload => {
    host.busy = true;
    const request = customMessage(payload);
    await host.emit('before_agent_start', {
      messageType: 'custom', message: request, systemPrompt: '', systemPromptOptions: {},
    });
    await host.emit('agent_start', {});
    await host.emit('message_start', { message: request });
    await host.emit('message_end', { message: request });
    const user = { role: 'user', content: [{ type: 'text', text: 'CLI steer' }], timestamp: Date.now() };
    await host.emit('message_start', { message: user });
    await host.emit('message_end', { message: user });
    steered.resolve();
    await finish.promise;
    await host.emit('agent_end', { messages: [request, user] });
    host.busy = false;
    await host.emit('agent_settled', { aborted: false });
  };
  const executor = createRequestExecutor(adapter, adapter.adaptContext(host.ctx));
  assert.equal(executor.supported, true);
  const { scope, cancellation } = executionScope();
  const execution = executor.execute(scope);
  await steered.promise;
  cancellation.abort(new Error('client cancellation after steering'));
  finish.resolve();
  await assert.rejects(execution, /client cancellation after steering/);
  assert.deepEqual(host.aborts, []);
  assert.equal(host.api.getActiveTools().includes('rpc_result'), false);
});

test('Pi facade follows public history and replaces identity when the session id changes', async () => {
  const host = fakePi();
  const adapter = await adapterFor(host);
  const firstMessage = { role: 'user', content: 'first' };
  host.branch = [{ type: 'message', id: 'one', parentId: null, timestamp: new Date().toISOString(), message: firstMessage }];
  const first = adapter.resolveSession(host.ctx);
  assert.deepEqual(first.messages, [firstMessage]);

  const secondMessage = { role: 'assistant', content: [{ type: 'text', text: 'branch' }], stopReason: 'stop' };
  host.branch = [{ type: 'message', id: 'two', parentId: null, timestamp: new Date().toISOString(), message: secondMessage }];
  await host.emit('session_tree', { newLeafId: 'two', oldLeafId: 'one' });
  assert.deepEqual(first.messages, [secondMessage]);

  const compacted = { role: 'assistant', content: [{ type: 'text', text: 'compacted' }], stopReason: 'stop' };
  host.branch = [{ type: 'message', id: 'three', parentId: null, timestamp: new Date().toISOString(), message: compacted }];
  await host.emit('session_compact', { compactionEntry: {}, fromExtension: false, reason: 'manual', willRetry: false });
  assert.deepEqual(first.messages, [compacted]);

  host.sessionId = 'replacement-session';
  host.branch = [];
  await host.emit('session_start', { reason: 'resume', previousSessionFile: '/old' });
  const replacement = adapter.resolveSession(host.ctx);
  assert.notStrictEqual(replacement, first);
  assert.equal(replacement.sessionManager, host.sessionManager);
});

test('Pi retires extension-global tools across session replacement and reuses their names safely', async () => {
  const host = fakePi({ oldAutoActivate: true });
  const adapter = await adapterFor(host);
  const first = adapter.resolveSession(host.ctx);
  const oldTool = adapter.defineTool({
    name: 'rpc_result', label: 'RPC result', description: 'Old session result schema',
    parameters: adapter.parameters({ type: 'object', properties: { old: { type: 'string' } } }),
    execute: async () => ({ content: [], details: { old: true } }),
  });
  await first.refreshRpcHostTools([oldTool]);
  const captured = host.registry.get('rpc_result');
  await host.emit('session_shutdown', { reason: 'resume', targetSessionFile: '/new' });
  assert.equal(host.api.getActiveTools().includes('rpc_result'), false);
  await assert.rejects(captured.execute('old', { old: 'value' }), error => error.code === 'host_cancelled');

  host.sessionId = 'new-session';
  host.branch = [];
  await host.emit('session_start', { reason: 'resume', previousSessionFile: '/old' });
  const replacement = adapter.resolveSession(host.ctx);
  assert.notStrictEqual(replacement, first);
  assert.equal(replacement.getAllToolNames().includes('rpc_result'), false);
  const newTool = adapter.defineTool({
    name: 'rpc_result', label: 'RPC result', description: 'New session result schema',
    parameters: adapter.parameters({ type: 'object', properties: { next: { type: 'integer' } } }),
    execute: async ({ params }) => ({ content: [], details: { next: params.next } }),
  });
  await replacement.refreshRpcHostTools([newTool]);
  const active = host.registry.get('rpc_result');
  assert.deepEqual(active.parameters.properties, { next: { type: 'integer' } });
  assert.deepEqual((await active.execute('new', { next: 4 })).details, { next: 4 });
  await replacement.refreshRpcHostTools([]);
});

test('unknown Pi import failures surface instead of becoming unsupported capability results', async () => {
  const host = fakePi();
  const failure = new Error('corrupt installed Pi package');
  await assert.rejects(
    createPiHostAdapter(host.api, { loadModule: async () => { throw failure; } }),
    error => error === failure,
  );

  const incomplete = await createPiHostAdapter({ on() {} }, { loadModule: moduleLoader('1.5.0') });
  assert.equal(incomplete.capabilities.features.lanRpcExecution, false);
  assert.match(incomplete.capabilities.reasons.lanRpcExecution, /registerTool/);
});
