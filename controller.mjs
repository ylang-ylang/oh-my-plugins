import { randomBytes, randomUUID } from 'node:crypto';
import {
  ID_PATTERN,
  LIMITS,
  PROTOCOL_VERSION,
  TERMINAL_STATES,
  failure,
  validateId,
  validateIdentity,
} from './protocol.mjs';
import { canonicalJSON, prepareRequest, validateJson } from './schema.mjs';

const TOOL_TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled', 'timed_out']);
const EXECUTION_SKIPPED = Symbol('execution skipped');

function terminalError(code, message, details) {
  return { code, message, ...(details === undefined ? {} : { details: structuredClone(details) }) };
}

function assertPlainObject(value, code, message) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw failure(400, code, message);
  }
}

function validateNativeCallId(value) {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value) > 512) {
    throw failure(400, 'invalid_tool', 'nativeToolCallId must be a non-empty string of at most 512 bytes');
  }
  return value;
}

function validateClaimId(value, label) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw failure(400, 'invalid_claim', `${label} must contain 1..128 ASCII letters, digits, underscores or hyphens`);
  }
  return value;
}

function validateOutcome(outcome) {
  assertPlainObject(outcome, 'invalid_outcome', 'outcome must be an object');
  const keys = Object.keys(outcome).sort();
  if (outcome.status === 'completed') {
    if (keys.length !== 2 || keys[0] !== 'result' || keys[1] !== 'status') {
      throw failure(400, 'invalid_outcome', 'completed outcome must contain exactly status and result');
    }
    return;
  }
  if (outcome.status !== 'failed' && outcome.status !== 'cancelled') {
    throw failure(400, 'invalid_outcome', 'outcome status must be completed, failed or cancelled');
  }
  if (keys.length !== 2 || keys[0] !== 'error' || keys[1] !== 'status') {
    throw failure(400, 'invalid_outcome', 'failed and cancelled outcomes must contain exactly status and error');
  }
  assertPlainObject(outcome.error, 'invalid_outcome', 'outcome error must be an object');
  const errorKeys = Object.keys(outcome.error).sort();
  if (errorKeys.length !== 2 || errorKeys[0] !== 'code' || errorKeys[1] !== 'message' ||
      typeof outcome.error.code !== 'string' || outcome.error.code.length === 0 ||
      typeof outcome.error.message !== 'string' || outcome.error.message.length === 0) {
    throw failure(400, 'invalid_outcome', 'outcome error must contain non-empty code and message strings');
  }
  validateJson(outcome.error, { maxBytes: LIMITS.resultBytes, maxDepth: LIMITS.jsonDepth });
}

function outcomeKey(outcome) {
  if (outcome.status === 'completed') return `completed:${canonicalJSON(outcome.result)}`;
  return `${outcome.status}:${canonicalJSON(outcome.error)}`;
}

function nativeWireValue(value, label) {
  let json;
  try {
    json = JSON.stringify(value);
  } catch {
    throw failure(400, 'invalid_json', `${label} must be serializable as JSON`);
  }
  if (json === undefined) throw failure(400, 'invalid_json', `${label} must be serializable as JSON`);
  if (Buffer.byteLength(json) > LIMITS.nativeBytes) {
    throw failure(413, 'value_too_large', `${label} exceeds the 4 MiB native payload limit`);
  }
  const wireValue = JSON.parse(json);
  validateJson(wireValue, { maxBytes: LIMITS.nativeBytes, maxDepth: LIMITS.jsonDepth });
  return wireValue;
}

function defaultInterruptMessage(code) {
  switch (code) {
    case 'cli_takeover': return 'Interactive CLI input took over the host session';
    case 'host_cancelled': return 'The host cancelled the isolated request';
    case 'session_changed': return 'The host session changed';
    case 'endpoint_closed': return 'The RPC endpoint closed';
    default: return 'The isolated request was interrupted';
  }
}

function hostExecutionError(error) {
  if (error?.code === 'value_too_large') {
    return terminalError('value_too_large', 'Native host output exceeds the allowed size');
  }
  if (error?.code === 'host_unsupported') {
    return terminalError('host_unsupported', 'The host cannot provide isolated RPC execution');
  }
  return terminalError('host_failed', 'The isolated host executor failed');
}

async function settlesWithin(promise, timeoutMs) {
  let timer;
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([promise.then(() => true, () => true), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export class RequestController {
  constructor({
    sessionId,
    cwd,
    isIdle,
    hasPendingMessages,
    execute,
    artifactStore,
    instanceId = randomUUID(),
    now = Date.now,
    reservedToolNames = [],
    supported = true,
  }) {
    validateIdentity({ instanceId, generation: 1 });
    if (typeof sessionId !== 'string' || typeof cwd !== 'string') throw new TypeError('sessionId and cwd are required');
    if (typeof isIdle !== 'function' || typeof hasPendingMessages !== 'function' || typeof execute !== 'function') {
      throw new TypeError('isIdle, hasPendingMessages and execute must be functions');
    }
    if (!artifactStore || typeof artifactStore.register !== 'function' || typeof artifactStore.list !== 'function' ||
        typeof artifactStore.open !== 'function' || typeof artifactStore.close !== 'function') {
      throw new TypeError('artifactStore must implement register, list, open and close');
    }

    this.sessionId = sessionId;
    this.cwd = cwd;
    this.instanceId = instanceId;
    this.generation = randomBytes(6).readUIntBE(0, 6) + 1;
    this.isIdle = isIdle;
    this.hasPendingMessages = hasPendingMessages;
    this.execute = execute;
    this.artifactStore = artifactStore;
    this.now = now;
    this.reservedToolNames = [...reservedToolNames];
    this.supported = Boolean(supported);
    this.requests = new Map();
    this.queue = [];
    this.active = null;
    this.closed = false;
    this.closePromise = undefined;
  }

  session() {
    return {
      protocolVersion: PROTOCOL_VERSION,
      instanceId: this.instanceId,
      generation: this.generation,
      sessionId: this.sessionId,
      cwd: this.cwd,
      busy: Boolean(this.active) || this.queue.length > 0 || !this.isIdle() || this.hasPendingMessages(),
      queueDepth: this.queue.length,
      capabilities: {
        structuredResults: true,
        callerTools: true,
        artifacts: this.artifactStore.registrationSupported !== false,
        isolatedExecution: this.supported,
      },
    };
  }

  submit(body) {
    this.#checkIdentity(body);
    validateId(body?.requestId);
    this.#sweep();
    if (this.closed) throw failure(503, 'session_closed', 'This session endpoint is closed');
    if (!this.supported) throw failure(501, 'host_unsupported', 'This host cannot isolate RPC execution from the interactive session');

    const prepared = prepareRequest(body, { reservedToolNames: this.reservedToolNames });
    const requestKey = canonicalJSON(prepared.request);
    const existing = this.requests.get(prepared.request.requestId);
    if (existing) {
      if (existing._requestKey !== requestKey) {
        throw failure(409, 'request_conflict', 'requestId already identifies a different normalized request');
      }
      return this.#requestSnapshot(existing);
    }

    let unfinished = 0;
    for (const record of this.requests.values()) {
      if (!TERMINAL_STATES.has(record.state)) unfinished += 1;
    }
    if (unfinished >= LIMITS.pending) throw failure(429, 'queue_full', 'At most 64 unfinished requests may be retained');
    if (this.requests.size >= LIMITS.requests) {
      throw failure(429, 'request_capacity', 'This generation has retained its maximum of 256 request IDs');
    }

    const at = this.now();
    const request = prepared.request;
    const record = {
      instanceId: this.instanceId,
      generation: this.generation,
      sessionId: this.sessionId,
      requestId: request.requestId,
      responseMode: request.responseMode,
      state: 'queued',
      createdAt: at,
      updatedAt: at,
      deadlineAt: at + request.timeoutMs,
      _request: request,
      _requestKey: requestKey,
      _resultValidator: prepared.resultValidator,
      _toolValidators: prepared.toolValidators,
      _toolCalls: new Map(),
      _nativeToolCalls: new Map(),
      _artifactNativeCalls: new Map(),
      _events: [],
      _eventBytes: 0,
      _lastSequence: 0,
    };
    this.requests.set(record.requestId, record);
    this.queue.push(record);
    this.#appendEvent(record, 'request.state', { state: 'queued' }, at);
    return this.#requestSnapshot(record);
  }

  get(identity) {
    const record = this.#getRequest(identity);
    return this.#requestSnapshot(record);
  }

  cancel(identity) {
    const record = this.#getRequest(identity);
    if (TERMINAL_STATES.has(record.state)) return this.#requestSnapshot(record);
    this.#finishRequest(record, 'cancelled', terminalError('client_cancelled', 'The client cancelled this request'));
    return this.#requestSnapshot(record);
  }

  toolCalls(identity) {
    const record = this.#getRequest(identity);
    return { toolCalls: [...record._toolCalls.values()].map(call => this.#toolSnapshot(call)) };
  }

  toolCall(identity) {
    const record = this.#getRequest(identity);
    const call = this.#getToolCall(record, identity?.toolCallId);
    return this.#toolSnapshot(call);
  }

  claim(identity) {
    const record = this.#getRequest(identity);
    const call = this.#getToolCall(record, identity?.toolCallId);
    validateClaimId(identity?.workerId, 'workerId');
    validateClaimId(identity?.claimId, 'claimId');
    const renew = identity?.renew ?? false;
    if (typeof renew !== 'boolean') throw failure(400, 'invalid_claim', 'renew must be a boolean');
    const leaseMs = identity?.leaseMs ?? LIMITS.leaseMs;
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > LIMITS.maxLeaseMs) {
      throw failure(400, 'invalid_claim', `leaseMs must be an integer from 1000 through ${LIMITS.maxLeaseMs}`);
    }
    if (TERMINAL_STATES.has(record.state)) throw failure(409, 'request_terminal', 'The request is already terminal');
    if (TOOL_TERMINAL_STATES.has(call.state)) throw failure(409, 'tool_claimed', 'The tool call is no longer claimable');

    const at = this.now();
    this.#sweepTool(record, call, at);
    if (TOOL_TERMINAL_STATES.has(call.state)) throw failure(409, 'tool_claimed', 'The tool call is no longer claimable');

    if (call.state === 'claimed') {
      if (call.workerId !== identity.workerId || call.claimId !== identity.claimId) {
        throw failure(409, 'tool_claimed', 'Another worker currently holds this tool call lease');
      }
      if (renew) {
        call.leaseExpiresAt = Math.min(call.deadlineAt, at + leaseMs);
        call.updatedAt = at;
      }
      return this.#toolSnapshot(call);
    }

    const claimKey = `${identity.workerId}\0${identity.claimId}`;
    if (call._expiredClaims?.has(claimKey)) {
      throw failure(409, 'lease_expired', 'This claim expired; use a new claimId');
    }
    if (renew) throw failure(400, 'invalid_claim', 'renew requires the matching live worker and claim lease');
    call.state = 'claimed';
    call.updatedAt = at;
    call.attempt += 1;
    call.workerId = identity.workerId;
    call.claimId = identity.claimId;
    call.leaseId = randomUUID();
    call.leaseExpiresAt = Math.min(call.deadlineAt, at + leaseMs);
    this.#appendEvent(record, 'tool.state', { toolCallId: call.toolCallId, state: 'claimed' }, at);
    return this.#toolSnapshot(call);
  }

  toolResult(identity) {
    const record = this.#getRequest(identity);
    const call = this.#getToolCall(record, identity?.toolCallId);
    if (typeof identity?.leaseId !== 'string') throw failure(400, 'invalid_outcome', 'leaseId is required');
    validateOutcome(identity?.outcome);
    if (identity.outcome.status === 'completed') {
      validateJson(identity.outcome.result, { maxBytes: LIMITS.resultBytes, maxDepth: LIMITS.jsonDepth });
    }
    const key = outcomeKey(identity.outcome);

    if (TOOL_TERMINAL_STATES.has(call.state)) {
      if (call._acceptedLeaseId === identity.leaseId) {
        if (call._outcomeKey === key) return this.#toolSnapshot(call);
        throw failure(409, 'tool_result_conflict', 'This lease already submitted a different outcome');
      }
      if (call._expiredLeases?.has(identity.leaseId)) throw failure(409, 'lease_expired', 'The supplied lease has expired');
      throw failure(409, 'lease_mismatch', 'The supplied lease does not own this tool call');
    }
    if (TERMINAL_STATES.has(record.state)) throw failure(409, 'request_terminal', 'The request is already terminal');

    const at = this.now();
    this.#sweepTool(record, call, at);
    if (call.state !== 'claimed') {
      if (call._expiredLeases?.has(identity.leaseId)) throw failure(409, 'lease_expired', 'The supplied lease has expired');
      throw failure(409, 'lease_mismatch', 'The supplied lease does not own this tool call');
    }
    if (call.leaseId !== identity.leaseId) throw failure(409, 'lease_mismatch', 'The supplied lease does not own this tool call');
    if (identity.outcome.status === 'completed') call._validator.result(identity.outcome.result);

    call._acceptedLeaseId = identity.leaseId;
    call._outcomeKey = key;
    const outcome = structuredClone(identity.outcome);
    if (outcome.status === 'completed') {
      this.#settleTool(record, call, 'completed', outcome, at);
    } else {
      this.#settleTool(record, call, outcome.status, outcome, at);
    }
    return this.#toolSnapshot(call);
  }

  events(identity) {
    const record = this.#getRequest(identity);
    const after = identity?.after ?? 0;
    if (!Number.isSafeInteger(after) || after < 0) {
      throw failure(400, 'invalid_query', 'after must be a non-negative safe integer');
    }
    const first = record._events[0]?.sequence;
    if (first !== undefined && after < first - 1) {
      throw failure(410, 'event_history_expired', 'The requested event cursor is older than retained history', {
        nextSequence: record._lastSequence,
      });
    }
    return {
      events: structuredClone(record._events.filter(event => event.sequence > after)),
      nextSequence: record._lastSequence,
    };
  }

  artifacts(identity) {
    const record = this.#getRequest(identity);
    return { artifacts: structuredClone(this.artifactStore.list({ requestId: record.requestId })) };
  }

  async artifact(identity) {
    const record = this.#getRequest(identity);
    if (typeof identity?.artifactId !== 'string' || identity.artifactId.length === 0) {
      throw failure(400, 'invalid_artifact', 'artifactId is required');
    }
    return this.artifactStore.open({ requestId: record.requestId, artifactId: identity.artifactId });
  }

  tick() {
    if (this.closed) return;
    this.#sweep();
    if (this.active || this.queue.length === 0 || !this.isIdle() || this.hasPendingMessages()) return;

    let record;
    while (this.queue.length > 0 && !record) {
      const candidate = this.queue.shift();
      if (!TERMINAL_STATES.has(candidate.state)) record = candidate;
    }
    if (!record) return;

    const at = this.now();
    if (at >= record.deadlineAt) {
      this.#finishRequest(record, 'failed', terminalError('request_timeout', 'The request deadline expired before execution began'), at);
      this.tick();
      return;
    }

    record.state = 'running';
    record.startedAt = at;
    record.updatedAt = at;
    record._abortController = new AbortController();
    this.active = record;
    this.#appendEvent(record, 'request.state', { state: 'running' }, at);

    const scope = {
      identity: { instanceId: this.instanceId, generation: this.generation, requestId: record.requestId },
      request: structuredClone(record._request),
      signal: record._abortController.signal,
      capabilities: { artifacts: this.artifactStore.registrationSupported !== false },
      submitResult: value => this.#submitResult(record, value),
      invokeTool: (name, args, nativeToolCallId) => this.#invokeTool(record, name, args, nativeToolCallId),
      registerArtifact: (args, nativeToolCallId) => this.#registerArtifact(record, args, nativeToolCallId),
      emitNative: event => this.#emitNative(record, event),
    };

    const execution = Promise.resolve().then(() => {
      if (TERMINAL_STATES.has(record.state)) return EXECUTION_SKIPPED;
      return this.execute(scope);
    });
    const handled = execution.then(
      value => this.#executionResolved(record, value),
      error => this.#executionRejected(record, error),
    ).catch(() => {
      if (!TERMINAL_STATES.has(record.state)) {
        this.#finishRequest(record, 'failed', terminalError('host_failed', 'The isolated host executor failed'));
      }
    });
    const release = () => {
      if (this.active === record) this.active = null;
      delete record._abortController;
      delete record._settling;
    };
    record._settling = handled.then(release, release);
  }

  interrupt(code = 'cli_takeover', message) {
    const description = message ?? defaultInterruptMessage(code);
    this.queue.length = 0;
    for (const record of this.requests.values()) {
      if (!TERMINAL_STATES.has(record.state)) {
        this.#finishRequest(record, 'interrupted', terminalError(code, description));
      }
    }
  }

  hasWork() {
    if (this.active) return true;
    for (const record of this.requests.values()) {
      if (!TERMINAL_STATES.has(record.state)) return true;
    }
    return false;
  }

  async close(code = 'endpoint_closed', message) {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.interrupt(code, message);
    const active = this.active;
    const settling = active?._settling;
    this.closePromise = (async () => {
      let drainTimedOut = false;
      let artifactError;
      if (settling) drainTimedOut = !(await settlesWithin(settling, LIMITS.hostDrainMs));
      if (drainTimedOut && this.active === active) {
        this.active = null;
        delete active._abortController;
        delete active._settling;
      }
      try {
        await this.artifactStore.close();
      } catch (error) {
        artifactError = error;
      }
      if (drainTimedOut) {
        throw failure(503, 'host_drain_timeout', 'The isolated host executor may still be stopping after the shutdown drain budget expired');
      }
      if (artifactError) throw artifactError;
    })();
    return this.closePromise;
  }

  #checkIdentity(identity) {
    validateIdentity(identity);
    if (identity.instanceId !== this.instanceId) {
      throw failure(409, 'instance_mismatch', 'The request targets a different server instance');
    }
    if (identity.generation !== this.generation) {
      throw failure(409, 'generation_mismatch', 'The request targets a different session generation');
    }
  }

  #getRequest(identity) {
    this.#checkIdentity(identity);
    validateId(identity?.requestId);
    this.#sweep();
    const record = this.requests.get(identity.requestId);
    if (!record) throw failure(404, 'request_not_found', 'No request with this ID exists in this generation');
    return record;
  }

  #getToolCall(record, toolCallId) {
    if (typeof toolCallId !== 'string' || toolCallId.length === 0) {
      throw failure(400, 'invalid_request', 'toolCallId is required');
    }
    const call = record._toolCalls.get(toolCallId);
    if (!call) throw failure(404, 'tool_call_not_found', 'No tool call with this ID belongs to the request');
    return call;
  }

  #requestSnapshot(record) {
    const snapshot = {
      instanceId: record.instanceId,
      generation: record.generation,
      sessionId: record.sessionId,
      requestId: record.requestId,
      responseMode: record.responseMode,
      state: record.state,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      deadlineAt: record.deadlineAt,
    };
    if (record.startedAt !== undefined) snapshot.startedAt = record.startedAt;
    if (record.finishedAt !== undefined) snapshot.finishedAt = record.finishedAt;
    if (Object.hasOwn(record, 'result')) snapshot.result = structuredClone(record.result);
    if (record.error !== undefined) snapshot.error = structuredClone(record.error);
    return snapshot;
  }

  #toolSnapshot(call) {
    const snapshot = {
      instanceId: call.instanceId,
      generation: call.generation,
      sessionId: call.sessionId,
      requestId: call.requestId,
      toolCallId: call.toolCallId,
      name: call.name,
      nativeToolCallId: call.nativeToolCallId,
      arguments: structuredClone(call.arguments),
      state: call.state,
      createdAt: call.createdAt,
      updatedAt: call.updatedAt,
      deadlineAt: call.deadlineAt,
      attempt: call.attempt,
    };
    for (const key of ['workerId', 'claimId', 'leaseId', 'leaseExpiresAt']) {
      if (call[key] !== undefined) snapshot[key] = call[key];
    }
    if (Object.hasOwn(call, 'result')) snapshot.result = structuredClone(call.result);
    if (call.error !== undefined) snapshot.error = structuredClone(call.error);
    return snapshot;
  }

  #appendEvent(record, type, data, at = this.now()) {
    validateJson(data, { maxBytes: LIMITS.nativeBytes, maxDepth: LIMITS.jsonDepth });
    const event = { sequence: record._lastSequence + 1, at, type, data: structuredClone(data) };
    const bytes = Buffer.byteLength(JSON.stringify(event));
    if (bytes > LIMITS.nativeBytes) throw failure(413, 'value_too_large', 'A single event exceeds the 4 MiB event history limit');
    record._lastSequence = event.sequence;
    record._events.push(event);
    record._eventBytes += bytes;
    while (record._events.length > LIMITS.events || record._eventBytes > LIMITS.nativeBytes) {
      const removed = record._events.shift();
      record._eventBytes -= Buffer.byteLength(JSON.stringify(removed));
    }
  }

  #finishRequest(record, state, error, at = this.now(), result) {
    if (TERMINAL_STATES.has(record.state)) return false;
    record.state = state;
    record.updatedAt = at;
    record.finishedAt = at;
    if (state === 'completed') record.result = structuredClone(result);
    else record.error = structuredClone(error);
    if (state !== 'completed') delete record.result;

    for (const call of record._toolCalls.values()) {
      if (!TOOL_TERMINAL_STATES.has(call.state)) {
        if (call.leaseId) {
          call._expiredLeases ??= new Set();
          call._expiredLeases.add(call.leaseId);
        }
        const toolError = terminalError('request_terminated', 'The request terminated before the caller tool completed');
        this.#settleTool(record, call, 'cancelled', { status: 'cancelled', error: toolError }, at);
      }
    }
    this.queue = this.queue.filter(candidate => candidate !== record);
    this.#appendEvent(record, 'request.state', { state, ...(error === undefined ? {} : { error }) }, at);
    if (record._abortController && !record._abortController.signal.aborted) record._abortController.abort(error);
    return true;
  }

  #sweep() {
    const at = this.now();
    for (const record of this.requests.values()) {
      if (TERMINAL_STATES.has(record.state)) continue;
      if (at >= record.deadlineAt) {
        this.#finishRequest(record, 'failed', terminalError('request_timeout', 'The request deadline expired'), at);
        continue;
      }
      for (const call of record._toolCalls.values()) this.#sweepTool(record, call, at);
    }
  }

  #sweepTool(record, call, at) {
    if (TOOL_TERMINAL_STATES.has(call.state)) return;
    if (at >= call.deadlineAt) {
      if (call.leaseId) {
        call._expiredLeases ??= new Set();
        call._expiredLeases.add(call.leaseId);
      }
      const error = terminalError('tool_timeout', 'The caller tool deadline expired');
      this.#settleTool(record, call, 'timed_out', { status: 'failed', error }, at);
      return;
    }
    if (call.state === 'claimed' && at >= call.leaseExpiresAt) {
      call._expiredClaims ??= new Set();
      call._expiredClaims.add(`${call.workerId}\0${call.claimId}`);
      call._expiredLeases ??= new Set();
      call._expiredLeases.add(call.leaseId);
      call.state = 'pending';
      call.updatedAt = at;
      delete call.workerId;
      delete call.claimId;
      delete call.leaseId;
      delete call.leaseExpiresAt;
      this.#appendEvent(record, 'tool.state', { toolCallId: call.toolCallId, state: 'pending' }, at);
    }
  }

  #settleTool(record, call, state, outcome, at = this.now()) {
    if (TOOL_TERMINAL_STATES.has(call.state)) return;
    call.state = state;
    call.updatedAt = at;
    call._settledOutcome = structuredClone(outcome);
    if (state === 'completed') call.result = structuredClone(outcome.result);
    else call.error = structuredClone(outcome.error);
    this.#appendEvent(record, 'tool.state', { toolCallId: call.toolCallId, state }, at);
    call._resolve?.(call._settledOutcome);
    delete call._resolve;
  }

  #submitResult(record, value) {
    if (record.responseMode !== 'structured') {
      throw failure(400, 'invalid_request', 'Native response mode does not expose rpc_result');
    }
    validateJson(value, { maxBytes: LIMITS.resultBytes, maxDepth: LIMITS.jsonDepth });
    const key = canonicalJSON(value);
    if (record.state === 'completed' && record._resultKey !== undefined) {
      if (record._resultKey === key) return { accepted: true };
      throw failure(409, 'result_conflict', 'This request already committed a different result');
    }
    if (TERMINAL_STATES.has(record.state)) throw failure(409, 'request_terminal', 'The request is already terminal');
    if (record.state !== 'running') throw failure(409, 'request_terminal', 'The request is not running');
    for (const call of record._toolCalls.values()) {
      if (!TOOL_TERMINAL_STATES.has(call.state)) {
        throw failure(409, 'tools_pending', 'All caller tool calls must settle before submitting the final result');
      }
    }
    record._resultValidator(value);
    record._resultKey = key;
    this.#finishRequest(record, 'completed', undefined, this.now(), value);
    return { accepted: true };
  }

  #invokeTool(record, name, args, nativeToolCallId) {
    validateNativeCallId(nativeToolCallId);
    if (TERMINAL_STATES.has(record.state) || record.state !== 'running') {
      throw failure(409, 'request_terminal', 'The request is not running');
    }
    const validator = record._toolValidators.get(name);
    if (!validator) throw failure(400, 'invalid_tool', `Tool ${String(name)} is not declared for this request`);
    validateJson(args, { maxBytes: LIMITS.argumentBytes, maxDepth: LIMITS.jsonDepth });
    validator.input(args);
    const argsKey = canonicalJSON(args);
    const previous = record._nativeToolCalls.get(nativeToolCallId);
    if (previous) {
      if (previous.name !== name || previous._argsKey !== argsKey) {
        throw failure(409, 'tool_result_conflict', 'nativeToolCallId was reused for a different tool invocation');
      }
      return this.#toolOutcomePromise(previous);
    }
    if (record._toolCalls.size >= LIMITS.toolCalls) {
      throw failure(429, 'tool_capacity', 'A request may create at most 64 caller tool calls');
    }

    const at = this.now();
    const call = {
      instanceId: this.instanceId,
      generation: this.generation,
      sessionId: this.sessionId,
      requestId: record.requestId,
      toolCallId: randomUUID(),
      name,
      nativeToolCallId,
      arguments: structuredClone(args),
      state: 'pending',
      createdAt: at,
      updatedAt: at,
      deadlineAt: Math.min(record.deadlineAt, at + record._request.toolTimeoutMs),
      attempt: 0,
      _validator: validator,
      _argsKey: argsKey,
    };
    call._promise = new Promise(resolve => { call._resolve = resolve; });
    record._toolCalls.set(call.toolCallId, call);
    record._nativeToolCalls.set(nativeToolCallId, call);
    this.#appendEvent(record, 'tool.state', { toolCallId: call.toolCallId, state: 'pending' }, at);
    if (at >= call.deadlineAt) this.#sweepTool(record, call, at);
    return this.#toolOutcomePromise(call);
  }

  #toolOutcomePromise(call) {
    if (call._settledOutcome) return Promise.resolve(structuredClone(call._settledOutcome));
    return call._promise.then(outcome => structuredClone(outcome));
  }

  async #registerArtifact(record, args, nativeToolCallId) {
    if (this.artifactStore.registrationSupported === false) {
      throw failure(501, 'host_unsupported', 'This host cannot safely register request artifacts');
    }
    validateNativeCallId(nativeToolCallId);
    if (TERMINAL_STATES.has(record.state) || record.state !== 'running') {
      throw failure(409, 'request_terminal', 'The request is not running');
    }
    const metadata = await this.artifactStore.register({ ...args, requestId: record.requestId, toolCallId: nativeToolCallId });
    if (TERMINAL_STATES.has(record.state)) throw failure(409, 'request_terminal', 'The request terminated during artifact registration');
    const previous = record._artifactNativeCalls.get(nativeToolCallId);
    if (!previous) {
      record._artifactNativeCalls.set(nativeToolCallId, metadata.artifactId);
      this.#appendEvent(record, 'artifact.registered', { artifactId: metadata.artifactId });
    } else if (previous !== metadata.artifactId) {
      throw failure(409, 'artifact_conflict', 'nativeToolCallId was reused for a different artifact');
    }
    return structuredClone(metadata);
  }

  #emitNative(record, event) {
    if (record.responseMode !== 'native') return;
    if (TERMINAL_STATES.has(record.state) || record.state !== 'running') {
      throw failure(409, 'request_terminal', 'The request is not running');
    }
    const wireEvent = nativeWireValue(event, 'Native host event');
    assertPlainObject(wireEvent, 'invalid_request', 'Native host events must serialize to JSON objects');
    this.#appendEvent(record, 'native', wireEvent);
  }

  #executionResolved(record, executionResult) {
    if (executionResult === EXECUTION_SKIPPED || TERMINAL_STATES.has(record.state)) return;
    try {
      if (record.responseMode === 'structured') {
        this.#finishRequest(record, 'failed', terminalError('result_missing', 'The isolated request completed without submitting a structured result'));
        return;
      }
      assertPlainObject(executionResult, 'host_failed', 'The host executor returned malformed native output');
      if (!Array.isArray(executionResult.messages)) {
        throw failure(500, 'host_failed', 'The host executor returned malformed native output');
      }
      if (['aborted', 'cancelled', 'interrupted'].includes(executionResult.stopReason)) {
        this.#finishRequest(record, 'interrupted', terminalError('host_cancelled', 'The host stopped the isolated request'));
        return;
      }
      if (['error', 'failed'].includes(executionResult.stopReason)) {
        this.#finishRequest(record, 'failed', terminalError('host_failed', 'The isolated host executor failed'));
        return;
      }
      const messages = nativeWireValue(executionResult.messages, 'Native host messages');
      if (!Array.isArray(messages)) throw failure(500, 'host_failed', 'The host executor returned malformed native output');
      this.#finishRequest(record, 'completed', undefined, this.now(), messages);
    } catch (error) {
      if (!TERMINAL_STATES.has(record.state)) this.#finishRequest(record, 'failed', hostExecutionError(error));
    }
  }

  #executionRejected(record, error) {
    if (TERMINAL_STATES.has(record.state)) return;
    this.#finishRequest(record, 'failed', hostExecutionError(error));
  }
}
