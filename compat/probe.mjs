#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const workspace = process.env.COMPAT_WORKSPACE ?? '/workspace';
const harnessRoot = process.env.COMPAT_HARNESS_ROOT ?? '/opt/harness';
const matrix = JSON.parse(await readFile(join(workspace, 'compat/matrix.json'), 'utf8'));
const id = valueAfter('--case') ?? process.env.COMPAT_CASE;
const row = matrix.cases.find(candidate => candidate.id === id);
if (!row) throw new Error(`Unknown compatibility case: ${id ?? '<missing>'}`);
const tempRoot = process.env.COMPAT_TEMP_ROOT ?? `/tmp/compat-${row.id}-${process.pid}`;
const harnessDir = join(harnessRoot, row.id);
const collectionRoot = join(harnessDir, 'node_modules/oh-my-plugins');
const standalone = process.env.COMPAT_PLUGIN_LAYOUT === 'standalone';
const pluginRoot = standalone
  ? join(harnessDir, 'node_modules/@ylang/lanrpc')
  : join(collectionRoot, 'plugins/lanrpc');
const btwRoot = join(harnessDir, 'node_modules/@ylang/pi-btw');

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index < 0 ? undefined : process.argv[index + 1];
}

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function moduleUrl(specifier) {
  const parts = specifier.split('/');
  const packageName = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  const subpath = parts.slice(specifier.startsWith('@') ? 2 : 1).join('/');
  const packageDir = join(harnessDir, 'node_modules', ...packageName.split('/'));
  const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
  const key = subpath ? `./${subpath}` : '.';
  let target = manifest.exports?.[key];
  if (target === undefined && subpath) {
    const pattern = Object.keys(manifest.exports ?? {}).find(candidate => candidate.endsWith('*') && key.startsWith(candidate.slice(0, -1)));
    if (pattern) {
      const capture = key.slice(pattern.length - 1);
      target = manifest.exports[pattern];
      const selected = typeof target === 'string' ? target : target?.import ?? target?.default;
      target = selected?.replace('*', capture);
    }
  }
  if (typeof target === 'object') target = target.import ?? target.default;
  if (typeof target !== 'string') throw new Error(`${specifier}: package has no ESM import export`);
  return pathToFileURL(join(packageDir, target)).href;
}

function emptyUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function assistant(model, content, stopReason) {
  return {
    role: 'assistant',
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: emptyUsage(),
    stopReason,
    timestamp: Date.now(),
  };
}

function emitText(Stream, model, text) {
  const stream = new Stream();
  queueMicrotask(() => {
    const message = assistant(model, [{ type: 'text', text }], 'stop');
    stream.push({ type: 'start', partial: message });
    stream.push({ type: 'text_start', contentIndex: 0, partial: message });
    stream.push({ type: 'text_delta', contentIndex: 0, delta: text, partial: message });
    stream.push({ type: 'text_end', contentIndex: 0, content: text, partial: message });
    stream.push({ type: 'done', reason: 'stop', message });
  });
  return stream;
}

function emitToolCall(Stream, model, name, args) {
  const stream = new Stream();
  queueMicrotask(() => {
    const toolCall = { type: 'toolCall', id: 'compat-tool-call', name, arguments: args };
    const message = assistant(model, [toolCall], 'toolUse');
    stream.push({ type: 'start', partial: message });
    stream.push({ type: 'toolcall_start', contentIndex: 0, partial: message });
    stream.push({ type: 'toolcall_delta', contentIndex: 0, delta: JSON.stringify(args), partial: message });
    stream.push({ type: 'toolcall_end', contentIndex: 0, toolCall, partial: message });
    stream.push({ type: 'done', reason: 'toolUse', message });
  });
  return stream;
}
function emitToolCallAfter(Stream, model, name, args, onStart, release) {
  const stream = new Stream();
  const toolCall = { type: 'toolCall', id: 'compat-tool-call', name, arguments: args };
  const message = assistant(model, [toolCall], 'toolUse');
  queueMicrotask(async () => {
    stream.push({ type: 'start', partial: message });
    onStart();
    await release;
    stream.push({ type: 'toolcall_start', contentIndex: 0, partial: message });
    stream.push({ type: 'toolcall_delta', contentIndex: 0, delta: JSON.stringify(args), partial: message });
    stream.push({ type: 'toolcall_end', contentIndex: 0, toolCall, partial: message });
    stream.push({ type: 'done', reason: 'toolUse', message });
  });
  return stream;
}

function emitTextAfter(Stream, model, text, onStart, release) {
  const stream = new Stream();
  const message = assistant(model, [{ type: 'text', text }], 'stop');
  queueMicrotask(async () => {
    stream.push({ type: 'start', partial: message });
    onStart();
    await release;
    stream.push({ type: 'text_start', contentIndex: 0, partial: message });
    stream.push({ type: 'text_delta', contentIndex: 0, delta: text, partial: message });
    stream.push({ type: 'text_end', contentIndex: 0, content: text, partial: message });
    stream.push({ type: 'done', reason: 'stop', message });
  });
  return stream;
}

function emitUntilAbort(Stream, model, signal, onStart, onAbort) {
  const stream = new Stream();
  const message = assistant(model, [], 'aborted');
  queueMicrotask(() => {
    stream.push({ type: 'start', partial: message });
    onStart();
    const abort = () => {
      onAbort();
      message.errorMessage = 'Deterministic local provider aborted';
      stream.push({ type: 'error', reason: 'aborted', error: message });
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
  return stream;
}

async function checkCli() {
  const executable = join(harnessRoot, row.id, 'node_modules/.bin', row.executable);
  const result = spawnSync(executable, ['--version'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: join(tempRoot, 'cli-home'), PI_CONFIG_DIR: join(tempRoot, 'cli-config') },
    timeout: 15000,
  });
  invariant(!result.error, `CLI failed to start: ${result.error?.message}`);
  invariant(result.status === 0, `CLI --version exited ${result.status}: ${result.stderr}`);
  invariant(`${result.stdout}\n${result.stderr}`.includes(row.version), `CLI version did not identify ${row.version}`);
  return { executable, versionOutput: `${result.stdout}\n${result.stderr}`.trim() };
}

async function createSession(harness, model, extensionPaths, tempRoot, providerStream) {
  const common = {
    cwd: workspace,
    agentDir: join(tempRoot, 'agent'),
    model,
    sessionManager: harness.SessionManager.create(workspace, join(tempRoot, 'sessions')),
  };
  common.sessionManager.appendMessage({
    role: 'user',
    content: 'Compatibility transcript seed',
    timestamp: Date.now(),
  });
  if (row.family === 'omp') {
    const created = await harness.createAgentSession({
      ...common,
      getApiKey: async () => 'deterministic-local-provider-no-external-inference',
      additionalExtensionPaths: extensionPaths,
      disableExtensionDiscovery: true,
    });
    created.session.modelRegistry.registerProvider('compat-local', {
      apiKey: 'deterministic-local-provider-no-external-inference',
    });
    return created;
  }

  const settingsManager = harness.SettingsManager.create(workspace, common.agentDir);
  const resourceLoader = new harness.DefaultResourceLoader({
    cwd: workspace,
    agentDir: common.agentDir,
    settingsManager,
    additionalExtensionPaths: extensionPaths,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  const probeState = globalThis[Symbol.for('oh-my-plugins.compat.probe')];
  invariant(probeState?.api, 'fixture extension did not expose its public API after resource loading');
  invariant(typeof probeState.api.registerProvider === 'function', 'Pi public extension API lacks registerProvider()');
  probeState.api.registerProvider(model.provider, {
    baseUrl: model.baseUrl,
    apiKey: 'deterministic-local-provider-no-external-inference',
    api: model.api,
    streamSimple: providerStream,
    models: [{
      id: model.id,
      name: model.name,
      api: model.api,
      reasoning: model.reasoning,
      input: model.input,
      cost: model.cost,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    }],
  });
  return harness.createAgentSession({ ...common, settingsManager, resourceLoader });
}

async function exerciseLifecycle(session) {
  const runner = session.extensionRunner;
  invariant(runner, 'SDK session did not expose its real extension runner');
  await runner.emit({ type: 'session_start' });
  await runner.emitInput('compatibility input', undefined, 'rpc');
  await runner.emitContext([]);
  if (row.family === 'omp') {
    await runner.emitBeforeAgentStart('compatibility prompt', undefined, []);
  } else if (Number.parseInt(row.version, 10) >= 1) {
    await runner.emitBeforeAgentStart({ messageType: 'user', prompt: 'compatibility prompt', images: undefined }, {});
  } else {
    await runner.emitBeforeAgentStart('compatibility prompt', undefined, '', {});
  }

  const state = globalThis[Symbol.for('oh-my-plugins.compat.probe')];
  invariant(state?.factoryCalls === 1, `Probe extension factory ran ${state?.factoryCalls ?? 0} times`);
  const ctxEntry = state.contexts.find(entry => entry.type === 'session_start');
  invariant(ctxEntry?.ctx, 'session_start did not provide a real extension context');
  invariant(typeof ctxEntry.ctx.isIdle === 'function', 'extension context lacks isIdle()');
  invariant(typeof ctxEntry.ctx.hasPendingMessages === 'function', 'extension context lacks hasPendingMessages()');
  invariant(typeof ctxEntry.sessionId === 'string' && ctxEntry.sessionId.length > 0, 'extension context lacks a session id');

  let schema;
  if (row.family === 'omp') {
    invariant(session.getAllToolNames().includes('compat_echo'), 'OMP public tool registry omitted compat_echo');
    const info = session.getAllToolInfos().find(candidate => candidate.name === 'compat_echo');
    invariant(info?.sourceInfo?.source === 'extension', 'OMP tool metadata omitted the extension source');
    schema = info.parameters;
  } else {
    const tool = session.getToolDefinition('compat_echo');
    invariant(tool, 'registered fixture tool is absent from the real session registry');
    schema = typeof tool.parameters?.toJsonSchema === 'function'
      ? tool.parameters.toJsonSchema()
      : tool.parameters;
    const result = await tool.execute('compat-call', { value: 'echoed' }, new AbortController().signal, () => {});
    invariant(result?.content?.[0]?.text === 'echoed', 'registered tool did not receive positional arguments through the harness');
    invariant(state.toolCalls[0]?.toolCallId === 'compat-call' && state.toolCalls[0]?.params?.value === 'echoed', 'tool execution signature was not preserved');

    const abortController = new AbortController();
    const pending = tool.execute('compat-cancel', { value: 'wait-for-abort' }, abortController.signal, () => {});
    abortController.abort(Object.assign(new Error('compat cancel'), { code: 'compat_cancel' }));
    await pending.then(
      () => { throw new Error('registered tool ignored its AbortSignal'); },
      error => invariant(error?.code === 'compat_cancel' || error?.name === 'AbortError', `unexpected tool cancellation: ${error}`),
    );
  }
  invariant(schema?.type === 'object' && schema.properties?.value?.type === 'string', 'registered tool schema changed shape');

  invariant(runner.getCommand('compat_probe'), 'registered fixture command is absent');
  return { state, ctx: ctxEntry.ctx, runner, schema };
}

async function exerciseBtw(session, runner, providerState) {
  if (row.family !== 'pi') return { installed: false, reason: 'OMP uses its native built-in /btw command' };
  const uiCalls = { selects: [], notifications: [], widgets: [], statuses: [], panels: [] };
  const ui = new Proxy({
    select: async (title, options) => {
      uiCalls.selects.push({ title, options });
      return options[0];
    },
    confirm: async () => true,
    input: async () => undefined,
    notify: (message, type) => uiCalls.notifications.push({ message, type }),
    onTerminalInput: () => () => {},
    setStatus: (key, value) => uiCalls.statuses.push({ key, value }),
    setWidget: (key, value) => uiCalls.widgets.push({ key, active: value !== undefined }),
    getEditorText: () => '',
    custom: async factory => {
      const tui = { terminal: { write() {} }, requestRender() {} };
      const component = await factory(tui, {}, {}, () => {});
      const rendered = component.render(200);
      uiCalls.panels.push(Array.isArray(rendered) ? rendered.join('\n') : String(rendered));
      component.dispose?.();
    },
  }, {
    get(target, key) {
      return key in target ? target[key] : () => undefined;
    },
  });
  runner.setUIContext(ui, 'tui');
  await runner.emit({ type: 'session_start' });
  const command = runner.getCommand('btw');
  invariant(command?.handler, 'Pi package manifest did not load the production /btw command');
  invariant(runner.getCommand('btw-history'), 'Pi package manifest did not load /btw-history');
  const lanCommand = runner.getCommand('lanrpc');
  invariant(lanCommand?.handler, 'Pi package manifest did not load the production /lanrpc command exactly once');
  const commandContext = runner.createCommandContext();
  const sessionManager = commandContext.sessionManager;
  const sessionFile = sessionManager.getSessionFile();
  invariant(typeof sessionFile === 'string' && sessionFile.length > 0, 'persistent Pi session file was not created');

  invariant(uiCalls.statuses.some(call => call.key === 'lan-rpc' && typeof call.value === 'string'),
    'Pi lifecycle did not publish LAN RPC state through the inline extension status slot');
  await lanCommand.handler('info', commandContext);
  const panel = uiCalls.panels.at(-1) ?? '';
  invariant(panel.includes('LAN RPC — Connection details'), '/lanrpc info did not render the connection panel');
  const endpoint = panel.match(/http:\/\/(?:127\.0\.0\.1|\[::1\]):\d+/)?.[0];
  invariant(endpoint, '/lanrpc info did not expose the live loopback HTTP endpoint');
  const sessionResponse = await fetch(`${endpoint}/v2/session`);
  invariant(sessionResponse.status === 200, `live Pi listener returned HTTP ${sessionResponse.status}`);
  const liveSession = await sessionResponse.json();
  invariant(liveSession.sessionId === sessionManager.getSessionId(), 'live listener session identity differs from the public extension context');
  providerState.enterPhase('lan-http-native');
  const httpRequestId = 'compat_http_native';
  const submittedResponse = await fetch(`${endpoint}/v2/requests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      instanceId: liveSession.instanceId,
      generation: liveSession.generation,
      requestId: httpRequestId,
      message: 'Complete the deterministic native HTTP compatibility request.',
      responseMode: 'native',
      tools: [],
      queueTimeoutMs: 10_000,
      timeoutMs: 10_000,
    }),
  });
  invariant(submittedResponse.status === 202, `live Pi request submission returned HTTP ${submittedResponse.status}`);
  const submitted = await submittedResponse.json();
  invariant(submitted.requestId === httpRequestId && submitted.state === 'queued', 'live Pi listener returned an invalid queued request record');
  const query = new URLSearchParams({ instanceId: liveSession.instanceId, generation: String(liveSession.generation) });
  let completed;
  const pollDeadline = Date.now() + 10_000;
  while (Date.now() < pollDeadline) {
    const response = await fetch(`${endpoint}/v2/requests/${httpRequestId}?${query}`);
    invariant(response.status === 200, `live Pi request poll returned HTTP ${response.status}`);
    completed = await response.json();
    if (['completed', 'failed', 'interrupted', 'cancelled'].includes(completed.state)) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  invariant(completed?.state === 'completed', `live Pi HTTP request ended in ${completed?.state ?? 'no terminal state'}`);
  invariant(completed.result?.some(message => message.role === 'assistant' &&
    message.content?.some(part => part.type === 'text' && part.text === 'HTTP native complete')),
  'live Pi HTTP request did not return its native assistant message');
  invariant(!completed.result?.some(message => message.role === 'user'),
    'live Pi HTTP native result crossed into unrelated user history');
  invariant(liveSession.capabilities?.conversationExecution === true, 'live Pi listener did not advertise conversation execution');

  const entriesBefore = sessionManager.getEntries().length;
  providerState.enterPhase('btw-first');
  await command.handler('first side question', commandContext);
  providerState.enterPhase('btw-followup');
  await command.handler('+ follow-up side question', commandContext);
  await command.handler('history', commandContext);
  invariant(uiCalls.selects.length === 1, '/btw history did not use the real UI selection contract');

  providerState.enterPhase('btw-cancel');
  const pending = command.handler('cancel this side question', commandContext);
  await providerState.btwCancelStarted.promise;
  await command.handler('close', commandContext);
  await pending;
  invariant(providerState.btwAbortObserved, '/btw close did not cancel the deterministic provider stream');
  invariant(sessionManager.getEntries().length === entriesBefore, '/btw side questions wrote to the main session history');

  const historyFile = `${sessionFile}.btw.json`;
  const history = JSON.parse(await readFile(historyFile, 'utf8'));
  const turns = history.topics.flatMap(topic => topic.turns);
  invariant(turns.length === 3, `/btw persisted ${turns.length} turns instead of 3`);
  invariant(turns[0].answer === 'first side answer' && turns[0].status === 'complete', 'first /btw answer was not streamed and completed');
  invariant(turns[1].answer === 'follow-up side answer' && turns[1].status === 'complete', '/btw follow-up did not retain topic history');
  invariant(turns[2].status === 'cancelled', '/btw cancellation was not persisted');
  const metadata = await stat(historyFile);
  invariant((metadata.mode & 0o777) === 0o600, `/btw sidecar mode was ${(metadata.mode & 0o777).toString(8)}`);
  return {
    installed: true,
    commands: ['btw', 'btw-history'],
    turns: turns.map(turn => ({ question: turn.question, answer: turn.answer, status: turn.status })),
    historyUnchanged: true,
    historyFileMode: '0600',
    historySelections: uiCalls.selects.length,
    listener: { endpoint, panelRendered: true, session: liveSession, statusUpdates: uiCalls.statuses },
    httpNative: { requestId: httpRequestId, state: completed.state, result: completed.result },
    providerCancelled: providerState.btwAbortObserved,
  };
}

async function exerciseLanRpc(state, rawCtx, runner, Stream, providerState) {
  const { createHostAdapter } = await import(pathToFileURL(join(pluginRoot, 'host/adapters/index.mjs')).href);
  const { createRequestExecutor } = await import(pathToFileURL(join(pluginRoot, 'host/execution.mjs')).href);
  const { StatusIndicator } = await import(pathToFileURL(join(pluginRoot, 'status.mjs')).href);
  const adapter = await createHostAdapter(state.api, rawCtx);
  const ctx = adapter.adaptContext?.(rawCtx) ?? rawCtx;
  invariant(adapter.identity.harness === row.expected.adapter, `selected ${adapter.identity.harness} adapter, expected ${row.expected.adapter}`);
  if (adapter.identity.version !== 'unknown') invariant(adapter.identity.version === row.version, `adapter version ${adapter.identity.version} != ${row.version}`);
  invariant(adapter.capabilities.features.extensionLoad === true, 'adapter did not confirm extension loading');
  invariant(adapter.capabilities.features.lanRpcExecution === true, `${adapter.identity.harness} adapter does not advertise LAN RPC execution`);
  invariant(ctx.sessionManager === rawCtx.sessionManager && ctx.ui === rawCtx.ui,
    'context adaptation changed the public session manager or UI identity');
  invariant(typeof ctx.setInterval === 'function' && typeof ctx.clearTimer === 'function',
    'adapted extension context lacks native timer functions');

  const executor = createRequestExecutor(adapter, ctx);
  invariant(executor.supported === true, `${adapter.identity.harness} executor rejected the public host boundary: ${executor.unsupportedReason ?? ''}`);
  const parent = adapter.resolveSession(ctx);
  invariant(parent && adapter.resolveSession(ctx) === parent, 'adapter did not preserve selected-session facade identity');
  invariant(parent.sessionManager === ctx.sessionManager, 'selected-session facade changed the readonly session manager identity');
  invariant(executor.reservedToolNames.includes('compat_echo'), 'public tool registry did not expose the fixture extension tool');

  const statusCalls = [];
  const statusMode = adapter.capabilities.statusMode ?? 'native';
  let originalPreset;
  let settings;
  const indicator = new StatusIndicator({
    statusMode,
    loadSettings: () => adapter.loadSettings(),
    hasUI: () => true,
    setStatus: (_ctx, key, value) => statusCalls.push({ key, value }),
  });
  await indicator.prepareAtLoad();
  if (statusMode === 'extension') {
    invariant(row.family === 'pi', 'OMP unexpectedly selected extension status mode');
    invariant(adapter.capabilities.features.statusSettings === false, 'Pi falsely advertises OMP status settings');
    await indicator.activate(ctx);
  } else {
    invariant(adapter.capabilities.features.statusSettings === true, 'OMP adapter does not advertise native status settings');
    settings = await adapter.loadSettings();
    invariant(settings, 'native status settings were not initialized by the real session');
    originalPreset = settings.get('statusLine.preset');
    await indicator.activate(ctx);
    invariant(settings.get('statusLine.preset') === 'custom', 'status layout did not switch to the native custom preset');
    invariant([
      ...settings.get('statusLine.leftSegments'),
      ...settings.get('statusLine.rightSegments'),
    ].includes('status'), 'status layout omitted the native status segment');
  }
  indicator.set(ctx, 'local');
  invariant(statusCalls.at(-1)?.key === 'lan-rpc' && typeof statusCalls.at(-1)?.value === 'string', 'inline status update was not emitted');
  indicator.dispose(ctx);
  if (settings) invariant(settings.get('statusLine.preset') === originalPreset, 'native status settings were not restored');

  const toolInvocations = [];
  const controller = new AbortController();
  const identity = { instanceId: 'compat-instance', generation: 1, requestId: 'compat-request' };
  const callerTool = {
    name: 'caller_echo',
    description: 'Compatibility caller tool',
    inputSchema: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false,
    },
  };
  const scope = {
    identity,
    signal: controller.signal,
    capabilities: { artifacts: false },
    request: {
      message: 'Run the deterministic compatibility request.',
      responseMode: 'native',
      tools: [callerTool],
    },
    isCompleted: () => false,
    interruptFromHost: reason => { throw new Error(`unexpected host interrupt: ${reason}`); },
    emitNative: event => providerState.nativeEvents.push(event.type),
    invokeTool: async (name, params, toolCallId) => {
      toolInvocations.push({ name, params, toolCallId });
      return { status: 'completed', result: { echoed: params.value } };
    },
  };

  providerState.enterPhase('lan-native');
  const nativePending = executor.execute(scope);
  let capturedTool;
  let capturedExecute;
  if (row.family === 'pi') {
    await Promise.race([providerState.nativeToolStarted.promise, nativePending.then(value => { throw new Error(`Native prompt ended before tool execution: ${JSON.stringify(value)}`); })]);
    capturedTool = runner.getToolDefinition('caller_echo');
    invariant(capturedTool?.execute, 'request-scoped caller tool was not registered in the real Pi tool registry');
    capturedExecute = capturedTool.execute;
    const activeMetadata = state.api.getAllTools().find(tool => tool.name === 'caller_echo');
    invariant(activeMetadata?.description?.startsWith('Compatibility caller tool'), 'active caller tool lost its request description');
    const activeSchema = typeof activeMetadata.parameters?.toJsonSchema === 'function'
      ? activeMetadata.parameters.toJsonSchema()
      : activeMetadata.parameters;
    invariant([activeSchema?.properties?.value?.type].flat().includes('string') && activeSchema.required?.includes('value'),
      'active caller tool schema changed before native execution');
    providerState.nativeToolRelease.resolve();
  }
  const outcome = await nativePending;
  invariant(toolInvocations.length === 1, `request tool ran ${toolInvocations.length} times: ${JSON.stringify(outcome.messages.filter(message => message.role === 'assistant'))}`);
  invariant(toolInvocations[0].name === 'caller_echo' && toolInvocations[0].params.value === 'from-provider', 'request tool arguments changed');
  invariant(outcome.messages.some(message => message.role === 'custom' && message.customType === 'omp-lan-rpc.request'),
    'native request did not enter the real conversation as its custom message');
  invariant(outcome.messages.some(message => message.role === 'assistant'), 'native request produced no assistant message');
  invariant(!parent.hasRpcHostTool('caller_echo'), 'request tool remained owned after native completion');
  invariant(providerState.nativeEvents.includes('tool_execution_start') && providerState.nativeEvents.includes('agent_end'), 'native session events were not forwarded');

  let retirement;
  if (row.family === 'pi') {
    invariant(!state.api.getActiveTools().includes('caller_echo'), 'retired caller tool remained active');
    invariant(!parent.getAllToolNames().includes('caller_echo'), 'retired LAN RPC tombstone leaked into reserved public tool names');
    const tombstone = runner.getToolDefinition('caller_echo');
    const publicTombstone = state.api.getAllTools().find(tool => tool.name === 'caller_echo');
    invariant(tombstone, 'Pi registry lost the retired tool definition');
    invariant(publicTombstone?.description === 'Retired LAN RPC tool; its request scope is no longer active.',
      'retired tool metadata retained request-specific description state');
    const retiredSchema = typeof publicTombstone.parameters?.toJsonSchema === 'function'
      ? publicTombstone.parameters.toJsonSchema()
      : publicTombstone.parameters;
    invariant(retiredSchema?.type === 'object' && Object.keys(retiredSchema.properties ?? {}).length === 0 && retiredSchema.additionalProperties === false,
      'retired tool metadata retained request-specific schema state');
    for (const execute of [capturedExecute, tombstone.execute]) {
      let staleError;
      try { await execute('stale-call', { value: 'stale' }, new AbortController().signal, () => {}, ctx); }
      catch (error) { staleError = error; }
      invariant(staleError?.status === 409 && staleError?.code === 'host_cancelled',
        `retired tool execution was not explicitly fenced: ${staleError?.code ?? 'success'}`);
    }
    retirement = { inactive: true, registryTombstone: true, staleExecutionCode: 'host_cancelled' };
  }

  const cancelController = new AbortController();
  const cancelScope = {
    ...scope,
    identity: { ...identity, requestId: 'compat-cancel-request' },
    signal: cancelController.signal,
    request: { message: 'Wait until this request is cancelled.', responseMode: 'native', tools: [] },
    emitNative: event => providerState.cancelEvents.push(event.type),
  };
  providerState.enterPhase('lan-cancel');
  const pending = executor.execute(cancelScope);
  await providerState.cancelStarted.promise;
  cancelController.abort(Object.assign(new Error('compat request cancelled'), { code: 'request_cancelled' }));
  let cancelError;
  try { await pending; } catch (error) { cancelError = error; }
  invariant(cancelError === cancelController.signal.reason || cancelError?.name === 'AbortError',
    `native cancellation returned ${cancelError?.name ?? 'success'} without preserving an abort reason`);
  invariant(providerState.abortObserved, 'native parent cancellation did not abort the local provider');
  invariant(!parent.isStreaming, 'native parent remained streaming after cancellation');

  let structuredCompleted = false;
  let submittedResult;
  const structuredController = new AbortController();
  const structuredScope = {
    ...scope,
    identity: { ...identity, requestId: 'compat-structured-request' },
    signal: structuredController.signal,
    request: {
      message: 'Return the deterministic structured result.',
      responseMode: 'structured',
      tools: [],
      resultSchema: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
        additionalProperties: false,
      },
    },
    isCompleted: () => structuredCompleted,
    submitResult: async result => {
      submittedResult = result;
      structuredCompleted = true;
      structuredController.abort(Object.assign(new Error('structured result committed'), { code: 'result_committed' }));
      return { accepted: true };
    },
    emitNative: () => {},
  };
  providerState.enterPhase('lan-structured');
  await executor.execute(structuredScope);
  invariant(structuredCompleted, 'rpc_result did not commit the structured request');
  invariant(submittedResult?.value === 'structured-value', 'rpc_result changed the structured value');
  invariant(!parent.hasRpcHostTool('rpc_result'), 'rpc_result remained owned after completion');
  if (row.family === 'pi') invariant(!state.api.getActiveTools().includes('rpc_result'), 'retired rpc_result remained active');
  const structuredPhases = providerState.phaseCalls.filter(call => call.phase === 'lan-structured');
  invariant(structuredPhases.length === 2 && structuredPhases[0].step === 0 && structuredPhases[1].step === 1,
    'structured result did not complete its post-submission provider path');

  let boundaryReason;
  const boundaryEvents = [];
  const boundaryScope = {
    ...scope,
    identity: { ...identity, requestId: 'compat-user-boundary' },
    request: { message: 'Stop native forwarding at the next user message.', responseMode: 'native', tools: [] },
    interruptFromHost: reason => { boundaryReason = reason; },
    emitNative: event => boundaryEvents.push(event),
  };
  providerState.enterPhase('lan-user-boundary');
  const boundaryPending = executor.execute(boundaryScope);
  await providerState.boundaryStarted.promise;
  if (row.family === 'omp') await parent.prompt('Compatibility user boundary', { streamingBehavior: 'steer' });
  else state.api.sendUserMessage('Compatibility user boundary', { deliverAs: 'steer' });
  providerState.boundaryRelease.resolve();
  let boundaryError;
  try { await boundaryPending; } catch (error) { boundaryError = error; }
  invariant(boundaryReason === 'native_user_message', `native request ended at ${boundaryReason ?? 'no'} user boundary`);
  invariant(boundaryError?.code === 'host_cancelled', `user boundary returned ${boundaryError?.code ?? 'success'} instead of host_cancelled`);
  invariant(!boundaryEvents.some(event => event.type === 'message_start' && event.message?.role === 'user'),
    'native forwarding included the later user-message boundary');

  let admissionCancellation;
  if (row.family === 'pi') {
    const gateStarted = Promise.withResolvers();
    const gateRelease = Promise.withResolvers();
    // Legacy custom prompts bypass before_agent_start; context is their awaited pre-provider boundary.
    state.api.on(row.version.startsWith('0.') ? 'context' : 'before_agent_start', async () => {
      if (providerState.phase?.name !== 'lan-admission-cancel') return;
      gateStarted.resolve();
      await gateRelease.promise;
    });
    const admissionController = new AbortController();
    const callsBeforeAdmission = providerState.calls;
    const toolsBeforeAdmission = toolInvocations.length;
    providerState.enterPhase('lan-admission-cancel');
    const admissionPending = executor.execute({
      ...scope,
      identity: { ...identity, requestId: 'compat-admission-cancel' },
      signal: admissionController.signal,
      request: { ...scope.request, message: 'Cancel while native prompt admission is gated.' },
    });
    await Promise.race([gateStarted.promise, admissionPending.then(value => { throw new Error(`Prompt ended before admission gate: ${JSON.stringify(value)}`); })]);
    const admissionReason = Object.assign(new Error('cancelled before provider admission'), { code: 'request_cancelled' });
    admissionController.abort(admissionReason);
    gateRelease.resolve();
    let admissionError;
    try { await admissionPending; } catch (error) { admissionError = error; }
    invariant(admissionError === admissionReason || admissionError?.name === 'AbortError',
      `pre-admission cancellation returned ${admissionError?.code ?? admissionError?.name ?? 'success'}`);
    const cancelledEntries = providerState.calls - callsBeforeAdmission;
    invariant(cancelledEntries === (row.version.startsWith('0.') ? 1 : 0) &&
      providerState.abortedProviderEntries === cancelledEntries,
    'cancelled request entered a provider without an already-aborted signal');
    invariant(toolInvocations.length === toolsBeforeAdmission, 'cancelled pre-admission RPC executed a caller tool');
    invariant(!parent.isStreaming && ctx.isIdle(), 'Pi did not return idle after pre-admission cancellation');
    invariant(!parent.hasRpcHostTool('caller_echo') && !state.api.getActiveTools().includes('caller_echo'),
      'pre-admission cancellation did not retire its request tool');
    admissionCancellation = { providerCalls: cancelledEntries, alreadyAbortedEntries: providerState.abortedProviderEntries,
      toolCalls: 0, idle: true, error: admissionError.code ?? admissionError.name };
  }

  providerState.enterPhase('lan-repeat');
  const repeatOutcome = await executor.execute({
    ...scope,
    identity: { ...identity, requestId: 'compat-repeat-request' },
    request: { ...scope.request, message: 'Reuse the retired caller tool name in a new request.' },
  });
  invariant(toolInvocations.length === 2 && toolInvocations[1].params.value === 'from-repeat',
    'a repeated request could not safely reuse its retired caller tool name');
  invariant(repeatOutcome.messages.some(message => message.role === 'assistant'), 'repeated request produced no assistant message');
  invariant(adapter.resolveSession(ctx) === parent, 'repeated requests changed selected-session facade identity');
  const repeatPhases = providerState.phaseCalls.filter(call => call.phase === 'lan-repeat');
  invariant(repeatPhases.length === 2 && repeatPhases[0].step === 0 && repeatPhases[1].step === 1,
    'cancelled pre-admission work replayed into the next request');
  invariant(!parent.hasRpcHostTool('caller_echo'), 'repeated request left its caller tool owned');

  return {
    supported: true,
    capabilities: adapter.capabilities,
    stateIdentity: { sessionFacadeStable: true, sessionManagerStable: true, uiStable: true },
    requestTools: toolInvocations,
    structuredResult: submittedResult,
    status: { mode: statusMode, restoredPreset: originalPreset, updates: statusCalls },
    nativeEvents: providerState.nativeEvents,
    cancellation: { providerAbortObserved: providerState.abortObserved, error: cancelError.name },
    userBoundary: { reason: boundaryReason, error: boundaryError.code, forwardedUserMessage: false },
    admissionCancellation,
    repeatedRequest: true,
    retirement,
  };
}

const cli = await checkCli();
const harness = await import(moduleUrl(row.package));
invariant(harness.VERSION === row.version, `SDK VERSION ${harness.VERSION} != ${row.version}`);

const aiPackage = row.family === 'omp' ? '@oh-my-pi/pi-ai' : row.package.replace('pi-coding-agent', 'pi-ai');
const ai = await import(moduleUrl(aiPackage));
const modelIdentity = row.family === 'omp'
  ? (await import(moduleUrl('@oh-my-pi/pi-catalog/compat/taxonomy')))
    .classifyModel('compat-local', 'compat-local-model', { lenient: true })
  : undefined;
const providerState = {
  calls: 0,
  phase: undefined,
  phaseCalls: [],
  nativeEvents: [],
  cancelEvents: [],
  abortObserved: false,
  btwAbortObserved: false,
  abortedProviderEntries: 0,
  cancelStarted: Promise.withResolvers(),
  btwCancelStarted: Promise.withResolvers(),
  nativeToolStarted: Promise.withResolvers(),
  nativeToolRelease: Promise.withResolvers(),
  boundaryStarted: Promise.withResolvers(),
  boundaryRelease: Promise.withResolvers(),
  enterPhase(name) {
    this.phase = { name, step: 0 };
    process.stderr.write(`[compat-phase] ${name}\n`);
  },
};
const model = {
  id: 'compat-local-model',
  name: 'Deterministic local compatibility model',
  api: 'compat-local-no-external-inference',
  provider: 'compat-local',
  baseUrl: 'local://compat',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32768,
  ...(modelIdentity === undefined ? {} : { identity: modelIdentity }),
  maxTokens: 4096,
};
const localStream = (selectedModel, context, options) => {
  providerState.calls += 1;
  const phase = providerState.phase;
  invariant(phase, 'deterministic provider was called without an explicit scenario phase');
  const step = phase.step++;
  providerState.phaseCalls.push({ phase: phase.name, step });
  const tools = context.tools ?? ai.getCurrentTools?.(context.messages) ?? [];
  const schemaFor = name => {
    const parameters = tools.find(tool => tool.name === name)?.parameters;
    return typeof parameters?.toJsonSchema === 'function' ? parameters.toJsonSchema() : parameters;
  };
  const onlyStep = expected => invariant(step === expected, `${phase.name} received unexpected provider step ${step}`);

  if (phase.name === 'lan-http-native') {
    onlyStep(0);
    invariant(!tools.some(tool => ['caller_echo', 'rpc_result'].includes(tool.name)),
      'production HTTP native request inherited direct-probe tools');
    return emitText(ai.AssistantMessageEventStream, selectedModel, 'HTTP native complete');
  }
  if (phase.name === 'btw-first') {
    onlyStep(0);
    return emitText(ai.AssistantMessageEventStream, selectedModel, 'first side answer');
  }
  if (phase.name === 'btw-followup') {
    onlyStep(0);
    return emitText(ai.AssistantMessageEventStream, selectedModel, 'follow-up side answer');
  }
  if (phase.name === 'btw-cancel') {
    onlyStep(0);
    return emitUntilAbort(
      ai.AssistantMessageEventStream,
      selectedModel,
      options?.signal,
      () => providerState.btwCancelStarted.resolve(),
      () => { providerState.btwAbortObserved = true; },
    );
  }
  if (phase.name === 'lan-native') {
    if (step === 0) {
      const schema = schemaFor('caller_echo');
      invariant([schema?.properties?.value?.type].flat().includes('string') && schema.required?.includes('value'),
        'request-scoped caller tool schema missing from provider context');
      if (row.family === 'pi') {
        return emitToolCallAfter(
          ai.AssistantMessageEventStream,
          selectedModel,
          'caller_echo',
          { value: 'from-provider' },
          () => providerState.nativeToolStarted.resolve(),
          providerState.nativeToolRelease.promise,
        );
      }
      return emitToolCall(ai.AssistantMessageEventStream, selectedModel, 'caller_echo', { value: 'from-provider' });
    }
    onlyStep(1);
    return emitText(ai.AssistantMessageEventStream, selectedModel, 'compatibility complete');
  }
  if (phase.name === 'lan-cancel') {
    onlyStep(0);
    return emitUntilAbort(
      ai.AssistantMessageEventStream,
      selectedModel,
      options?.signal,
      () => providerState.cancelStarted.resolve(),
      () => { providerState.abortObserved = true; },
    );
  }
  if (phase.name === 'lan-structured') {
    if (step === 0) {
      const schema = schemaFor('rpc_result');
      invariant([schema?.properties?.result?.type].flat().includes('object') && schema.required?.includes('result'),
        'structured rpc_result schema missing from provider context');
      return emitToolCall(ai.AssistantMessageEventStream, selectedModel, 'rpc_result', { result: { value: 'structured-value' } });
    }
    onlyStep(1);
    return emitText(ai.AssistantMessageEventStream, selectedModel, 'structured result accepted');
  }
  if (phase.name === 'lan-user-boundary') {
    if (step === 0) {
      return emitTextAfter(
        ai.AssistantMessageEventStream,
        selectedModel,
        'native reply before user boundary',
        () => providerState.boundaryStarted.resolve(),
        providerState.boundaryRelease.promise,
      );
    }
    onlyStep(1);
    return emitText(ai.AssistantMessageEventStream, selectedModel, 'user boundary handled');
  }
  if (phase.name === 'lan-admission-cancel') {
    onlyStep(0);
    invariant(row.version.startsWith('0.') && options?.signal?.aborted,
      'pre-admission cancellation reached a live provider');
    providerState.abortedProviderEntries += 1;
    return emitUntilAbort(ai.AssistantMessageEventStream, selectedModel, options.signal, () => {}, () => {});
  }
  if (phase.name === 'lan-repeat') {
    if (step === 0) {
      const schema = schemaFor('caller_echo');
      invariant([schema?.properties?.value?.type].flat().includes('string'), 'repeated caller tool schema missing from provider context');
      return emitToolCall(ai.AssistantMessageEventStream, selectedModel, 'caller_echo', { value: 'from-repeat' });
    }
    onlyStep(1);
    return emitText(ai.AssistantMessageEventStream, selectedModel, 'repeat complete');
  }
  throw new Error(`Unknown deterministic provider phase: ${phase.name}`);
};
providerState.stream = localStream;
if (typeof ai.registerCustomApi === 'function') {
  ai.registerCustomApi(model.api, localStream, 'oh-my-plugins/compat');
} else if (typeof ai.registerApiProvider === 'function') {
  ai.registerApiProvider({ api: model.api, stream: localStream, streamSimple: localStream }, 'oh-my-plugins/compat');
}

const extensionPaths = [
  ...(standalone ? [pluginRoot, ...(row.family === 'pi' ? [btwRoot] : [])] : [collectionRoot]),
  join(workspace, 'compat/fixtures/probe-extension.mjs'),
];
const { session } = await createSession(harness, model, extensionPaths, tempRoot, localStream);
const lifecycle = await exerciseLifecycle(session);
const btw = await exerciseBtw(session, lifecycle.runner, providerState);

let settingsBoundary = 'not-applicable';
if (row.family === 'omp') {
  const settingsModule = await import(moduleUrl(`${row.package}/config/settings`));
  settingsBoundary = typeof settingsModule.Settings?.prototype?.get === 'function' ? 'string-path' : 'registry';
  invariant(settingsBoundary === row.expected.settingsBoundary, `settings boundary ${settingsBoundary} != ${row.expected.settingsBoundary}`);
}

const lanContext = row.family === 'pi'
  ? lifecycle.state.contexts.findLast(entry => entry.type === 'session_start')?.ctx
  : lifecycle.ctx;
invariant(lanContext, 'LAN RPC probe did not observe a real session_start extension context');
const lanRpc = await exerciseLanRpc(lifecycle.state, lanContext, lifecycle.runner, ai.AssistantMessageEventStream, providerState);
await lifecycle.runner.emit({ type: 'session_shutdown' });
await session.dispose?.();

process.stdout.write(`${JSON.stringify({
  id: row.id,
  passed: true,
  runtime: { name: row.runtime, version: process.versions.bun ?? process.versions.node },
  package: { name: row.package, version: harness.VERSION },
  cli,
  lifecycle: {
    factoryCalls: lifecycle.state.factoryCalls,
    events: lifecycle.state.events.map(event => event.type),
    toolCalls: lifecycle.state.toolCalls.map(call => ({ toolCallId: call.toolCallId, params: call.params })),
    schema: lifecycle.schema,
  },
  settingsBoundary,
  lanRpc,
  btw,
  inference: { external: false, provider: model.provider, calls: providerState.calls, phases: providerState.phaseCalls },
})}\n`);
