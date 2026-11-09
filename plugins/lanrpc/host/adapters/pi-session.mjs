import { failure } from '../../protocol.mjs';

const REQUEST_MESSAGE_TYPE = 'omp-lan-rpc.request';
const MAX_OWNED_TOOL_NAMES = 8192;
const RETIRED_DESCRIPTION = 'Retired LAN RPC tool; its request scope is no longer active.';
const RETIRED_SCHEMA = Object.freeze({
  type: 'object',
  properties: Object.freeze({}),
  additionalProperties: false,
});
const STALE_MESSAGE = 'The LAN RPC tool request scope is no longer active';

function unsupported(message) {
  return failure(501, 'host_unsupported', message);
}

function staleToolError() {
  return failure(409, 'host_cancelled', STALE_MESSAGE);
}

function sessionId(ctx) {
  return ctx?.sessionManager?.getSessionId?.();
}

function sameIdentity(left, right) {
  return left?.instanceId === right?.instanceId &&
    left?.generation === right?.generation &&
    left?.requestId === right?.requestId;
}

function matchesPrompt(message, payload) {
  return message?.role === 'custom' &&
    message.customType === payload.customType &&
    sameIdentity(message.details, payload.details);
}

function toCustomMessage(entry) {
  return {
    role: 'custom',
    customType: entry.customType,
    content: entry.content,
    display: entry.display,
    details: entry.details,
    timestamp: Date.parse(entry.timestamp) || Date.now(),
  };
}

function branchMessages(sessionManager) {
  const branch = sessionManager.getBranch();
  if (!Array.isArray(branch)) throw unsupported('Pi did not return a readable active session branch');
  const messages = [];
  for (const entry of branch) {
    if (entry?.type === 'message' && entry.message) messages.push(entry.message);
    else if (entry?.type === 'custom_message') messages.push(toCustomMessage(entry));
  }
  return messages;
}

function isPlainSchema(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function replaceObject(target, source) {
  for (const key of Reflect.ownKeys(target)) {
    if (typeof key === 'string') delete target[key];
  }
  Object.assign(target, source);
}

function later(callback) {
  setTimeout(() => setTimeout(callback, 0), 0);
}

export function piParameters(projection) {
  if (!isPlainSchema(projection)) throw new TypeError('Pi tool parameters must be an object schema');
  return structuredClone(projection);
}

export function definePiTool(definition) {
  const { execute, concurrency, loadMode: _loadMode, approval: _approval, ...tool } = definition;
  if (typeof execute !== 'function') throw new TypeError('Host tool definition must provide execute()');
  return {
    ...tool,
    exposure: 'direct',
    defaultActive: false,
    ...(concurrency === 'exclusive' ? { executionMode: 'sequential' } : {}),
    async execute(toolCallId, params, signal, onUpdate, toolContext) {
      return execute({ toolCallId, params, signal, onUpdate, context: toolContext });
    },
  };
}

export function adaptPiContext(ctx) {
  if (!ctx || typeof ctx !== 'object') return ctx;
  const adapted = Object.defineProperties({}, Object.getOwnPropertyDescriptors(ctx));
  if (typeof adapted.mode === 'string') {
    Object.defineProperty(adapted, 'hasUI', {
      configurable: true,
      enumerable: true,
      value: adapted.mode === 'tui',
      writable: true,
    });
  } else if (typeof adapted.hasUI !== 'boolean') {
    adapted.hasUI = false;
  }
  if (typeof adapted.setInterval !== 'function') adapted.setInterval = globalThis.setInterval.bind(globalThis);
  if (typeof adapted.clearInterval !== 'function') adapted.clearInterval = globalThis.clearInterval.bind(globalThis);
  if (typeof adapted.clearTimer !== 'function') adapted.clearTimer = adapted.clearInterval;
  return adapted;
}

class PiSessionFacade {
  constructor(api, ctx, options = {}) {
    this.api = api;
    this.sessionManager = ctx.sessionManager;
    this.sessionId = sessionId(ctx);
    this.ctx = ctx;
    this.messages = [];
    this.listeners = new Set();
    this.toolState = options.toolState;
    this.owned = this.toolState.owned;
    this.activeOwned = this.toolState.activeOwned;
    this.pendingPrompt = undefined;
    this.supportsAgentSettled = options.supportsAgentSettled === true;
    this.invalid = false;
    this.agent = { state: {} };
    Object.defineProperty(this.agent.state, 'tools', {
      enumerable: true,
      get: () => this.activeToolMetadata(),
    });
    this.syncBranch(ctx);
  }

  updateContext(ctx) {
    if (this.invalid || sessionId(ctx) !== this.sessionId || ctx.sessionManager !== this.sessionManager) return false;
    this.ctx = ctx;
    return true;
  }

  syncBranch(ctx = this.ctx) {
    if (!this.updateContext(ctx)) return;
    const next = branchMessages(this.sessionManager);
    this.messages.splice(0, this.messages.length, ...next);
  }

  invalidate(reason = 'session_changed') {
    if (this.invalid) return;
    this.invalid = true;
    this.listeners.clear();
    const pending = this.pendingPrompt;
    this.pendingPrompt = undefined;
    if (pending) {
      pending.signal?.removeEventListener('abort', pending.onAbort);
      pending.reject(failure(409, reason, 'The selected Pi conversation changed during RPC execution'));
    }
  }

  get isStreaming() {
    return !this.ctx.isIdle();
  }

  activeToolMetadata() {
    const active = new Set(this.api.getActiveTools());
    return this.api.getAllTools().filter(tool => active.has(tool.name));
  }

  getLastAssistantMessage() {
    return this.messages.findLast(message => message?.role === 'assistant');
  }

  subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('Pi session listener must be a function');
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event) {
    for (const listener of [...this.listeners]) listener(event);
  }

  receive(event, ctx) {
    if (!this.updateContext(ctx)) return;
    const admissionMessage = event.type === 'message_start'
      ? event.message
      : event.type === 'before_agent_start' && event.messageType === 'custom'
        ? event.message
        : undefined;
    if (event.type === 'message_start' && !this.messages.includes(event.message)) {
      this.messages.push(event.message);
    }
    const candidate = this.pendingPrompt;
    if (candidate && matchesPrompt(admissionMessage, candidate.payload)) {
      if (!candidate.admitted) this.admitPrompt(candidate);
      if (event.type === 'message_start' && candidate.cancelled &&
          !candidate.messageAbortRequested && !this.invalid && !this.ctx.isIdle()) {
        candidate.messageAbortRequested = true;
        this.ctx.abort();
      }
    }

    this.emit(event);

    const pending = this.pendingPrompt;
    if (!pending) return;
    if (event.type === 'agent_settled') {
      if (pending.cancelled) this.releasePrompt(pending);
      else if (pending.admitted) this.finishPrompt(pending);
      else this.rejectPrompt(pending, failure(409, 'host_cancelled', 'Pi ended the RPC prompt before admission'));
    } else if (event.type === 'agent_end' && !this.supportsAgentSettled && pending.admitted) {
      const token = ++pending.terminalToken;
      later(() => {
        if (this.pendingPrompt === pending && pending.terminalToken === token && this.ctx.isIdle()) {
          if (pending.cancelled) this.releasePrompt(pending);
          else this.finishPrompt(pending);
        }
      });
    }
  }

  admitPrompt(pending) {
    if (this.pendingPrompt !== pending || pending.admitted) return;
    pending.admitted = true;
    pending.signal?.removeEventListener('abort', pending.onAbort);
    if (pending.cancelled) {
      if (!pending.abortRequested && !this.invalid && !this.ctx.isIdle()) {
        pending.abortRequested = true;
        this.ctx.abort();
      }
    } else {
      pending.onPromptAdmitted?.();
    }
  }

  releasePrompt(pending) {
    if (this.pendingPrompt !== pending) return;
    this.pendingPrompt = undefined;
    pending.signal?.removeEventListener('abort', pending.onAbort);
  }

  finishPrompt(pending) {
    if (this.pendingPrompt !== pending) return;
    this.releasePrompt(pending);
    if (!pending.promiseSettled) {
      pending.promiseSettled = true;
      pending.resolve(true);
    }
  }

  rejectPrompt(pending, error, retainFence = false) {
    if (this.pendingPrompt !== pending) return;
    if (!pending.promiseSettled) {
      pending.promiseSettled = true;
      pending.reject(error);
    }
    if (!retainFence) this.releasePrompt(pending);
  }

  watchCancelledFence(pending) {
    setTimeout(() => {
      if (this.pendingPrompt !== pending || !pending.cancelled) return;
      if (this.ctx.isIdle()) this.releasePrompt(pending);
      else this.watchCancelledFence(pending);
    }, 100);
  }

  promptCustomMessage(payload, options = {}) {
    if (this.invalid) return Promise.reject(failure(409, 'session_changed', 'The selected Pi conversation changed'));
    if (this.pendingPrompt || !this.ctx.isIdle()) {
      return Promise.reject(failure(409, 'host_busy', 'A Pi RPC prompt is already active'));
    }
    return new Promise((resolve, reject) => {
      const pending = {
        payload,
        onPromptAdmitted: options.onPromptAdmitted,
        signal: options.signal,
        resolve,
        reject,
        admitted: false,
        sent: false,
        cancelled: false,
        abortRequested: false,
        promiseSettled: false,
        messageAbortRequested: false,
        terminalToken: 0,
      };
      pending.onAbort = () => {
        if (this.pendingPrompt !== pending || pending.admitted) return;
        pending.cancelled = true;
        if (pending.sent && !pending.abortRequested && !this.invalid && !this.ctx.isIdle()) {
          pending.abortRequested = true;
          this.ctx.abort();
        }
        this.rejectPrompt(
          pending,
          pending.signal?.reason ?? failure(409, 'host_cancelled', STALE_MESSAGE),
          pending.sent,
        );
        if (pending.sent) this.watchCancelledFence(pending);
      };
      this.pendingPrompt = pending;
      pending.signal?.addEventListener('abort', pending.onAbort, { once: true });
      if (pending.signal?.aborted) return pending.onAbort();
      try {
        pending.sent = true;
        this.api.sendMessage(payload, { triggerTurn: true });
        if (pending.signal?.aborted) pending.onAbort();
      } catch (error) {
        this.rejectPrompt(pending, error);
      }
    });
  }

  abort() {
    const pending = this.pendingPrompt;
    if (!pending || !pending.admitted || pending.abortRequested || this.invalid || this.ctx.isIdle()) return;
    pending.abortRequested = true;
    this.ctx.abort();
  }

  publicTools() {
    return this.api.getAllTools();
  }

  isRetiredMetadata(tool, entry) {
    return entry?.state === 'retired' &&
      entry.sourceInfo !== undefined &&
      tool.description === RETIRED_DESCRIPTION &&
      tool.parameters === entry.parameters &&
      tool.sourceInfo === entry.sourceInfo;
  }

  getAllToolNames() {
    return this.publicTools()
      .filter(tool => !this.isRetiredMetadata(tool, this.owned.get(tool.name)))
      .map(tool => tool.name);
  }

  hasRpcHostTool(name) {
    return this.activeOwned.has(name);
  }

  refreshRpcHostTools(tools) {
    if (!Array.isArray(tools)) return Promise.reject(new TypeError('Pi RPC tools must be an array'));
    const mutation = this.toolState.mutation.then(() => this.replaceTools(tools));
    this.toolState.mutation = mutation.catch(() => {});
    return mutation;
  }

  async replaceTools(tools) {
    await this.retireActiveTools();
    if (tools.length === 0) return;

    const names = new Set();
    for (const tool of tools) {
      if (!tool || typeof tool.name !== 'string' || typeof tool.execute !== 'function') {
        throw new TypeError('Pi RPC tool definitions require a name and execute()');
      }
      if (names.has(tool.name)) throw new TypeError(`Duplicate Pi RPC tool: ${tool.name}`);
      names.add(tool.name);
    }
    const additions = [...names].filter(name => !this.owned.has(name));
    if (this.owned.size + additions.length > MAX_OWNED_TOOL_NAMES) {
      throw failure(503, 'host_capacity', 'Pi LAN RPC exhausted its bounded request-tool name capacity');
    }

    const collisions = new Set(this.getAllToolNames());
    const conflict = tools.find(tool => collisions.has(tool.name));
    if (conflict) throw unsupported(`A request tool conflicts with the selected Pi tool registry: ${conflict.name}`);

    const installed = [];
    try {
      for (const requested of tools) {
        const cell = { active: true, execute: requested.execute };
        const guarded = { ...requested };
        guarded.exposure = 'direct';
        guarded.defaultActive = false;
        guarded.execute = async (...args) => {
          if (!cell.active || typeof cell.execute !== 'function') throw staleToolError();
          return cell.execute(...args);
        };
        this.api.registerTool(guarded);
        const metadata = this.publicTools().find(tool => tool.name === guarded.name);
        if (!metadata || metadata.parameters !== guarded.parameters || metadata.description !== guarded.description) {
          cell.active = false;
          cell.execute = undefined;
          replaceObject(guarded, {
            name: guarded.name,
            label: guarded.name,
            description: RETIRED_DESCRIPTION,
            parameters: structuredClone(RETIRED_SCHEMA),
            exposure: 'hidden',
            defaultActive: false,
            async execute() { throw staleToolError(); },
          });
          this.api.registerTool(guarded);
          this.api.setActiveTools(this.api.getActiveTools().filter(name => name !== guarded.name));
          throw unsupported(`A request tool conflicts with the selected Pi tool registry: ${guarded.name}`);
        }
        const entry = {
          state: 'active',
          definition: guarded,
          cell,
          parameters: guarded.parameters,
          sourceInfo: metadata.sourceInfo,
        };
        this.owned.set(guarded.name, entry);
        this.activeOwned.add(guarded.name);
        installed.push(entry);
      }
      const active = this.api.getActiveTools().filter(name => !this.activeOwned.has(name));
      this.api.setActiveTools([...new Set([...active, ...this.activeOwned])]);
    } catch (error) {
      await this.retireEntries(installed);
      throw error;
    }
  }

  async retireActiveTools() {
    if (this.activeOwned.size === 0) return;
    const entries = [...this.activeOwned].map(name => this.owned.get(name)).filter(Boolean);
    await this.retireEntries(entries);
  }

  async retireEntries(entries) {
    if (entries.length === 0) return;
    for (const entry of entries) {
      entry.cell.active = false;
      entry.cell.execute = undefined;
    }
    const retiring = new Set(entries.map(entry => entry.definition.name));
    this.api.setActiveTools(this.api.getActiveTools().filter(name => !retiring.has(name)));

    for (const entry of entries) {
      const name = entry.definition.name;
      replaceObject(entry.definition, {
        name,
        label: name,
        description: RETIRED_DESCRIPTION,
        parameters: structuredClone(RETIRED_SCHEMA),
        exposure: 'hidden',
        defaultActive: false,
        async execute() { throw staleToolError(); },
      });
      this.api.registerTool(entry.definition);
      const metadata = this.publicTools().find(tool => tool.name === name);
      entry.state = 'retired';
      entry.parameters = entry.definition.parameters;
      entry.sourceInfo = metadata?.sourceInfo;
      entry.cell = undefined;
      this.activeOwned.delete(name);
    }
    const ownedNames = new Set(this.owned.keys());
    this.api.setActiveTools(this.api.getActiveTools().filter(name => !ownedNames.has(name)));
  }
}

export function createPiSessionBridge(api, options = {}) {
  let facades = new WeakMap();
  let currentFacade;
  const toolState = { owned: new Map(), activeOwned: new Set(), mutation: Promise.resolve() };
  const facadeOptions = { ...options, toolState };
  function facadeFor(rawCtx, create = true) {
    const ctx = adaptPiContext(rawCtx);
    const manager = ctx?.sessionManager;
    const id = sessionId(ctx);
    if (!manager || typeof manager !== 'object' || typeof id !== 'string' || !id) return undefined;
    let facade = facades.get(manager);
    if (facade && facade.sessionId !== id) return undefined;
    if (!facade && currentFacade &&
        (currentFacade.sessionManager !== manager || currentFacade.sessionId !== id)) return undefined;
    if (!facade && create) {
      if (typeof manager.getBranch !== 'function' || typeof ctx.isIdle !== 'function' ||
          typeof ctx.abort !== 'function' || typeof ctx.hasPendingMessages !== 'function') {
        throw unsupported('This Pi host lacks the public session transcript, idle, queue, or cancellation APIs');
      }
      facade = new PiSessionFacade(api, ctx, facadeOptions);
      facades.set(manager, facade);
      currentFacade = facade;
    } else {
      facade?.updateContext(ctx);
    }
    return facade;
  }

  const forwardedEvents = [
    'before_agent_start', 'agent_start', 'agent_end', 'agent_settled',
    'message_start', 'message_update', 'message_end',
    'tool_execution_start', 'tool_execution_update', 'tool_execution_end',
  ];
  for (const event of forwardedEvents) {
    api.on(event, (payload, ctx) => facadeFor(ctx)?.receive(payload, adaptPiContext(ctx)));
  }
  api.on('session_start', async (_payload, rawCtx) => {
    const ctx = adaptPiContext(rawCtx);
    const id = sessionId(ctx);
    const previous = currentFacade;
    if (previous && (previous.sessionManager !== ctx.sessionManager || previous.sessionId !== id)) {
      await previous.refreshRpcHostTools([]);
      previous.invalidate('session_changed');
      facades.delete(previous.sessionManager);
      currentFacade = undefined;
    }
    facadeFor(ctx)?.syncBranch(ctx);
  });
  for (const event of ['session_tree', 'session_compact']) {
    api.on(event, (_payload, ctx) => facadeFor(ctx)?.syncBranch(adaptPiContext(ctx)));
  }
  api.on('session_shutdown', async (_payload, rawCtx) => {
    const ctx = adaptPiContext(rawCtx);
    const facade = currentFacade ?? facadeFor(ctx, false);
    if (!facade) return;
    await facade.refreshRpcHostTools([]);
    facade.invalidate('session_changed');
    facades.delete(facade.sessionManager);
    if (currentFacade === facade) currentFacade = undefined;
  });

  return Object.freeze({
    resolveSession: facadeFor,
    reset() {
      currentFacade?.invalidate('session_changed');
      currentFacade = undefined;
      facades = new WeakMap();
    },
  });
}

export const piSessionConstants = Object.freeze({
  REQUEST_MESSAGE_TYPE,
  RETIRED_DESCRIPTION,
  RETIRED_SCHEMA,
  STALE_MESSAGE,
  MAX_OWNED_TOOL_NAMES,
});
