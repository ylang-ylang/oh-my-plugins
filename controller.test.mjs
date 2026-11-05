import test from 'node:test';
import assert from 'node:assert/strict';
import { RequestController } from './controller.mjs';

const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_INSTANCE_ID = '22222222-2222-4222-8222-222222222222';

function deferred() {
  let resolve;
  const promise = new Promise(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function nextTurn() {
  return new Promise(resolve => setImmediate(resolve));
}

async function waitFor(read, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const value = read();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error('Timed out waiting for controller state');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function fakeArtifactStore() {
  const registrations = [];
  const records = [];
  return {
    registrations,
    closed: 0,
    async register(input) {
      registrations.push(structuredClone(input));
      const metadata = {
        artifactId: `artifact-${records.length + 1}`,
        name: input.name ?? 'report.txt',
        mediaType: input.mediaType,
        size: 4,
        sha256: 'a'.repeat(64),
        createdAt: 1000,
        expiresAt: 1_801_000,
      };
      records.push({ requestId: input.requestId, metadata });
      return structuredClone(metadata);
    },
    list({ requestId }) {
      return records.filter(record => record.requestId === requestId).map(record => structuredClone(record.metadata));
    },
    async open({ requestId, artifactId }) {
      const record = records.find(candidate => candidate.requestId === requestId && candidate.metadata.artifactId === artifactId);
      if (!record) throw Object.assign(new Error('Artifact not found'), { status: 404, code: 'artifact_not_found' });
      return { metadata: structuredClone(record.metadata), handle: { close() {} } };
    },
    async close() { this.closed += 1; },
  };
}

function harness(options = {}) {
  const host = { idle: true, pending: false, time: 1000 };
  const artifactStore = options.artifactStore ?? fakeArtifactStore();
  const controller = new RequestController({
    sessionId: 'session-1',
    cwd: '/project',
    instanceId: INSTANCE_ID,
    isIdle: () => host.idle,
    hasPendingMessages: () => host.pending,
    execute: options.execute ?? (() => Promise.resolve({ messages: [] })),
    artifactStore,
    now: () => host.time,
    reservedToolNames: options.reservedToolNames,
    supported: options.supported,
  });
  const identity = requestId => ({ instanceId: INSTANCE_ID, generation: controller.generation, requestId });
  const request = (requestId, extra = {}) => ({ ...identity(requestId), message: `work ${requestId}`, ...extra });
  return { controller, host, artifactStore, identity, request };
}

const structuredSchema = {
  type: 'object',
  properties: { value: { type: 'string' } },
  required: ['value'],
  additionalProperties: false,
};

const callbackTool = {
  name: 'lookup_item',
  description: 'Look up an item for the isolated request.',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'integer' } },
    required: ['id'],
    additionalProperties: false,
  },
  resultSchema: {
    type: 'object',
    properties: { title: { type: 'string' } },
    required: ['title'],
    additionalProperties: false,
  },
};

test('concurrent normalized duplicate submissions converge while conflicting reuse and wrong identity fail', async () => {
  const h = harness();
  const [first, duplicate] = await Promise.all([
    h.controller.submit(h.request('same')),
    h.controller.submit(h.request('same', {
      responseMode: 'native',
      tools: [],
      timeoutMs: 300_000,
      toolTimeoutMs: 60_000,
    })),
  ]);
  assert.deepEqual(duplicate, first);
  assert.equal(h.controller.requests.size, 1);
  assert.equal(h.controller.queue.length, 1);
  await assert.rejects(
    h.controller.submit(h.request('same', { message: 'different work' })),
    error => error.code === 'request_conflict',
  );
  assert.throws(
    () => h.controller.get({ ...h.identity('same'), generation: h.controller.generation + 1 }),
    error => error.code === 'generation_mismatch',
  );
  assert.throws(
    () => h.controller.get({ ...h.identity('same'), instanceId: OTHER_INSTANCE_ID }),
    error => error.code === 'instance_mismatch',
  );
});

test('CLI takeover aborts request admission that is still compiling schemas', async () => {
  const h = harness();
  const pending = h.controller.submit(h.request('compiling', {
    responseMode: 'structured',
    resultSchema: {
      type: 'object',
      patternProperties: { '^[a-z]+$': { type: 'string' } },
      additionalProperties: false,
    },
  }));

  h.controller.interrupt();
  await assert.rejects(pending, error => error.code === 'validation_aborted');
  assert.equal(h.controller.requests.size, 0);
  assert.equal(h.controller.queue.length, 0);
});

test('queue deadlines include time spent waiting for the interactive host', async () => {
  let executions = 0;
  const h = harness({ execute: async () => { executions += 1; return { messages: [] }; } });
  h.host.idle = false;
  await h.controller.submit(h.request('deadline', { timeoutMs: 1000 }));
  h.host.time += 1000;
  h.controller.tick();
  const record = h.controller.get(h.identity('deadline'));
  assert.equal(record.state, 'failed');
  assert.equal(record.error.code, 'request_timeout');
  assert.equal(executions, 0);
});

test('explicit cancellation is terminal, immutable and idempotent', async () => {
  const h = harness();
  await h.controller.submit(h.request('cancelled'));
  const first = h.controller.cancel(h.identity('cancelled'));
  assert.equal(first.state, 'cancelled');
  assert.equal(first.error.code, 'client_cancelled');
  assert.deepEqual(h.controller.cancel(h.identity('cancelled')), first);
  h.controller.tick();
  assert.equal(h.controller.hasWork(), false);
});

test('native mode preserves wire messages, thinking, tool content and native events without parsing text', async () => {
  const messages = [
    {
      role: 'assistant',
      optional: undefined,
      content: [
        { type: 'thinking', thinking: 'private chain payload' },
        { type: 'text', text: '{"result":{"spoofed":true}}' },
        { type: 'toolCall', id: 'host-tool-1', name: 'read', arguments: { path: '/tmp/a' } },
      ],
    },
    { role: 'toolResult', toolCallId: 'host-tool-1', content: [{ type: 'text', text: 'raw result' }] },
  ];
  const event = { kind: 'delta', optional: undefined, data: { type: 'thinking', text: 'delta' } };
  const h = harness({
    execute: async scope => {
      scope.emitNative(event);
      return { messages, stopReason: 'stop' };
    },
  });
  await h.controller.submit(h.request('native'));
  h.controller.tick();
  await nextTurn();

  const record = h.controller.get(h.identity('native'));
  assert.equal(record.state, 'completed');
  assert.deepEqual(record.result, JSON.parse(JSON.stringify(messages)));
  assert.equal(record.result[0].content[1].text, '{"result":{"spoofed":true}}');

  const history = h.controller.events({ ...h.identity('native'), after: 0 });
  const native = history.events.find(item => item.type === 'native');
  assert.deepEqual(native.data, JSON.parse(JSON.stringify(event)));
  assert.deepEqual(
    h.controller.events({ ...h.identity('native'), after: native.sequence }).events.map(item => item.type),
    ['request.state'],
  );
});

test('structured result validation permits correction and exact retry but rejects a differing retry', async () => {
  const observed = {};
  const h = harness({
    execute: async scope => {
      await assert.rejects(
        scope.submitResult({ value: 3 }),
        error => error.code === 'schema_validation',
      );
      observed.first = await scope.submitResult({ value: 'accepted' });
      observed.retry = await scope.submitResult({ value: 'accepted' });
      await assert.rejects(
        scope.submitResult({ value: 'different' }),
        error => error.code === 'result_conflict',
      );
      observed.abortedAfterCommit = scope.signal.aborted;
      return { messages: [{ role: 'assistant', content: [{ type: 'text', text: 'ignored fallback' }] }] };
    },
  });
  await h.controller.submit(h.request('structured', { responseMode: 'structured', resultSchema: structuredSchema }));
  h.controller.tick();
  await waitFor(() => h.controller.get(h.identity('structured')).state === 'completed');

  assert.deepEqual(observed.first, { accepted: true });
  assert.deepEqual(observed.retry, observed.first);
  assert.equal(observed.abortedAfterCommit, true);
  assert.deepEqual(h.controller.get(h.identity('structured')).result, { value: 'accepted' });
});

test('cancelling a request aborts structured result validation already running in isolation', async () => {
  const started = deferred();
  let validation;
  const h = harness({
    execute: async scope => {
      validation = scope.submitResult({ value: `${'a'.repeat(64 * 1024)}!` });
      started.resolve();
      await validation.catch(() => {});
      return { messages: [] };
    },
  });
  await h.controller.submit(h.request('cancel-validation', {
    responseMode: 'structured',
    resultSchema: {
      type: 'object',
      properties: { value: { type: 'string', pattern: '^(a+)+$' } },
      required: ['value'],
      additionalProperties: false,
    },
  }));
  h.controller.tick();
  await started.promise;

  const cancelled = h.controller.cancel(h.identity('cancel-validation'));
  assert.equal(cancelled.state, 'cancelled');
  await assert.rejects(validation, error => error.code === 'validation_aborted');
  await nextTurn();
  assert.deepEqual(h.controller.get(h.identity('cancel-validation')), cancelled);
});

test('ordinary assistant text never substitutes for a missing structured result', async () => {
  const h = harness({
    execute: async () => ({
      messages: [{ role: 'assistant', content: [{ type: 'text', text: '{"value":"looks valid"}' }] }],
      stopReason: 'stop',
    }),
  });
  await h.controller.submit(h.request('missing', { responseMode: 'structured', resultSchema: structuredSchema }));
  h.controller.tick();
  await nextTurn();

  const record = h.controller.get(h.identity('missing'));
  assert.equal(record.state, 'failed');
  assert.equal(record.error.code, 'result_missing');
  assert.equal(record.result, undefined);
});

test('host failures and malformed native output use bounded safe terminal errors', async () => {
  const huge = `provider secret ${'x'.repeat(4 * 1024 * 1024)}`;
  const rejected = harness({
    execute: async () => { throw Object.assign(new Error(huge), { status: 500, code: 'host_failed' }); },
  });
  await rejected.controller.submit(rejected.request('rejected'));
  rejected.controller.tick();
  await nextTurn();
  assert.deepEqual(rejected.controller.get(rejected.identity('rejected')).error, {
    code: 'host_failed',
    message: 'The isolated host executor failed',
  });
  assert.equal(rejected.controller.hasWork(), false);

  const malformed = harness({ execute: async () => ({ messages: [{ cycle: null }] }) });
  const cyclicMessage = {};
  cyclicMessage.cycle = cyclicMessage;
  malformed.controller.execute = async () => ({ messages: [cyclicMessage] });
  await malformed.controller.submit(malformed.request('malformed'));
  malformed.controller.tick();
  await nextTurn();
  assert.deepEqual(malformed.controller.get(malformed.identity('malformed')).error, {
    code: 'host_failed',
    message: 'The isolated host executor failed',
  });
});

test('callback absolute timeout resolves the agent waiter and expires a late lease result', async () => {
  let agentOutcome;
  const h = harness({
    execute: async scope => {
      agentOutcome = await scope.invokeTool('lookup_item', { id: 4 }, 'timeout-call');
      return { messages: [] };
    },
  });
  await h.controller.submit(h.request('tool-timeout', { tools: [callbackTool], toolTimeoutMs: 1000 }));
  h.controller.tick();
  const call = await waitFor(() => h.controller.toolCalls(h.identity('tool-timeout')).toolCalls[0]);
  const claim = h.controller.claim({
    ...h.identity('tool-timeout'), toolCallId: call.toolCallId,
    workerId: 'worker', claimId: 'claim', leaseMs: 1000,
  });
  h.host.time = call.deadlineAt;
  h.controller.tick();
  await nextTurn();

  assert.deepEqual(agentOutcome, {
    status: 'failed',
    error: { code: 'tool_timeout', message: 'The caller tool deadline expired' },
  });
  await assert.rejects(
    h.controller.toolResult({
      ...h.identity('tool-timeout'), toolCallId: call.toolCallId, leaseId: claim.leaseId,
      outcome: { status: 'completed', result: { title: 'late' } },
    }),
    error => error.code === 'lease_expired',
  );
});

test('a callback result cannot commit after its lease expires during validation', async () => {
  const h = harness({
    execute: async scope => {
      await scope.invokeTool('lookup_item', { id: 9 }, 'lease-race-call');
      return { messages: [] };
    },
  });
  await h.controller.submit(h.request('lease-race', { tools: [callbackTool] }));
  h.controller.tick();
  const call = await waitFor(() => h.controller.toolCalls(h.identity('lease-race')).toolCalls[0]);
  const claim = h.controller.claim({
    ...h.identity('lease-race'), toolCallId: call.toolCallId,
    workerId: 'worker', claimId: 'claim', leaseMs: 1000,
  });

  const pending = h.controller.toolResult({
    ...h.identity('lease-race'), toolCallId: call.toolCallId, leaseId: claim.leaseId,
    outcome: { status: 'completed', result: { title: 'validated' } },
  });
  h.host.time = claim.leaseExpiresAt;
  h.controller.tick();

  await assert.rejects(pending, error => error.code === 'lease_expired');
  assert.equal(h.controller.toolCall({ ...h.identity('lease-race'), toolCallId: call.toolCallId }).state, 'pending');
});

test('event retention rejects an expired cursor after more than 256 native events', async () => {
  const h = harness({
    execute: async scope => {
      for (let index = 0; index < 257; index += 1) scope.emitNative({ index });
      return { messages: [] };
    },
  });
  await h.controller.submit(h.request('events'));
  h.controller.tick();
  await nextTurn();
  assert.throws(
    () => h.controller.events({ ...h.identity('events'), after: 0 }),
    error => error.code === 'event_history_expired' && error.details.nextSequence === 260,
  );
});

test('leases renew explicitly, stale claims cannot revive, and invalid callback results can be corrected idempotently', async () => {
  let agentOutcome;
  const h = harness({
    execute: async scope => {
      agentOutcome = await scope.invokeTool('lookup_item', { id: 7 }, 'native-call-1');
      await scope.submitResult({ value: agentOutcome.result.title });
      return { messages: [] };
    },
  });
  await h.controller.submit(h.request('tools', {
    responseMode: 'structured',
    resultSchema: structuredSchema,
    tools: [callbackTool],
  }));
  h.controller.tick();
  await nextTurn();
  const call = await waitFor(() => h.controller.toolCalls(h.identity('tools')).toolCalls[0]);
  assert.equal(call.nativeToolCallId, 'native-call-1');
  const claimInput = { ...h.identity('tools'), toolCallId: call.toolCallId, workerId: 'worker_1', claimId: 'claim_1', leaseMs: 1000 };
  assert.throws(
    () => h.controller.claim({ ...claimInput, renew: true }),
    error => error.code === 'invalid_claim',
  );
  const claim = h.controller.claim(claimInput);
  h.host.time += 500;
  assert.equal(h.controller.claim(claimInput).leaseExpiresAt, claim.leaseExpiresAt);
  const renewed = h.controller.claim({ ...claimInput, renew: true });
  assert.equal(renewed.leaseExpiresAt, h.host.time + 1000);

  h.host.time = renewed.leaseExpiresAt;
  h.controller.tick();
  assert.equal(h.controller.toolCall({ ...h.identity('tools'), toolCallId: call.toolCallId }).state, 'pending');
  assert.throws(() => h.controller.claim(claimInput), error => error.code === 'lease_expired');
  await assert.rejects(
    h.controller.toolResult({
      ...h.identity('tools'),
      toolCallId: call.toolCallId,
      leaseId: claim.leaseId,
      outcome: { status: 'completed', result: { title: 'stale' } },
    }),
    error => error.code === 'lease_expired',
  );

  const second = h.controller.claim({ ...claimInput, claimId: 'claim_2' });
  const reply = {
    ...h.identity('tools'),
    toolCallId: call.toolCallId,
    leaseId: second.leaseId,
    outcome: { status: 'completed', result: { title: 42 } },
  };
  await assert.rejects(h.controller.toolResult(reply), error => error.code === 'schema_validation');
  assert.equal(h.controller.toolCall({ ...h.identity('tools'), toolCallId: call.toolCallId }).state, 'claimed');

  reply.outcome = { status: 'completed', result: { title: 'answer' } };
  const completed = await h.controller.toolResult(reply);
  assert.equal(completed.state, 'completed');
  assert.deepEqual(await h.controller.toolResult(reply), completed);
  await assert.rejects(
    h.controller.toolResult({ ...reply, outcome: { status: 'completed', result: { title: 'other' } } }),
    error => error.code === 'tool_result_conflict',
  );
  await waitFor(() => h.controller.get(h.identity('tools')).state === 'completed');

  assert.deepEqual(agentOutcome, { status: 'completed', result: { title: 'answer' } });
  assert.deepEqual(h.controller.get(h.identity('tools')).result, { value: 'answer' });
});

test('CLI takeover interrupts queued and running RPCs, resolves callback waiters, and retains the execution slot until settlement', async () => {
  const gate = deferred();
  let callbackOutcome;
  const h = harness({
    execute: async scope => {
      callbackOutcome = await scope.invokeTool('lookup_item', { id: 1 }, 'native-call');
      await gate.promise;
      return { messages: [] };
    },
  });
  await h.controller.submit(h.request('running', { tools: [callbackTool] }));
  await h.controller.submit(h.request('queued'));
  h.controller.tick();
  await waitFor(() => h.controller.toolCalls(h.identity('running')).toolCalls.length === 1);

  h.controller.interrupt();
  await nextTurn();
  assert.equal(h.controller.get(h.identity('running')).error.code, 'cli_takeover');
  assert.equal(h.controller.get(h.identity('queued')).error.code, 'cli_takeover');
  assert.deepEqual(callbackOutcome, {
    status: 'cancelled',
    error: { code: 'request_terminated', message: 'The request terminated before the caller tool completed' },
  });
  assert.equal(h.controller.hasWork(), true);
  assert.equal(h.controller.session().busy, true);

  gate.resolve();
  await nextTurn();
  assert.equal(h.controller.hasWork(), false);
});

test('close bounds an abort-ignoring executor, always cleans artifacts, and preserves the terminal record', async () => {
  const gate = deferred();
  const artifactStore = fakeArtifactStore();
  const h = harness({
    artifactStore,
    execute: async () => {
      await gate.promise;
      throw new Error('late provider failure');
    },
  });
  await h.controller.submit(h.request('closing'));
  h.controller.tick();
  await nextTurn();

  const started = Date.now();
  await assert.rejects(
    h.controller.close(),
    error => error.status === 503 && error.code === 'host_drain_timeout',
  );
  assert.ok(Date.now() - started < 3000);
  assert.equal(artifactStore.closed, 1);
  assert.equal(h.controller.hasWork(), false);
  const terminal = h.controller.get(h.identity('closing'));
  assert.equal(terminal.state, 'interrupted');
  assert.equal(terminal.error.code, 'endpoint_closed');

  gate.resolve();
  await nextTurn();
  assert.deepEqual(h.controller.get(h.identity('closing')), terminal);
  await assert.rejects(h.controller.close(), error => error.code === 'host_drain_timeout');
  assert.equal(artifactStore.closed, 1);
});

test('artifact capability is request-scoped and direct registration fails when unavailable', async () => {
  const artifactStore = fakeArtifactStore();
  artifactStore.registrationSupported = false;
  let observedCapabilities;
  const h = harness({
    artifactStore,
    execute: async scope => {
      observedCapabilities = scope.capabilities;
      await assert.rejects(
        scope.registerArtifact({ path: '/project/report.txt', mediaType: 'text/plain' }, 'artifact-call'),
        error => error.status === 501 && error.code === 'host_unsupported',
      );
      return { messages: [] };
    },
  });
  assert.equal(h.controller.session().capabilities.artifacts, false);
  await h.controller.submit(h.request('no-artifacts'));
  h.controller.tick();
  await nextTurn();
  assert.deepEqual(observedCapabilities, { artifacts: false });
  assert.equal(artifactStore.registrations.length, 0);
  assert.equal(h.controller.get(h.identity('no-artifacts')).state, 'completed');
});

test('artifact registration cannot override closure-bound request ownership', async () => {
  const artifactStore = fakeArtifactStore();
  const resultSchema = {
    type: 'object',
    properties: { artifactId: { type: 'string' } },
    required: ['artifactId'],
    additionalProperties: false,
  };
  const h = harness({
    artifactStore,
    execute: async scope => {
      const metadata = await scope.registerArtifact({
        requestId: 'attacker-request',
        toolCallId: 'attacker-call',
        path: '/project/report.txt',
        mediaType: 'text/plain',
      }, 'native-artifact-call');
      await scope.submitResult({ artifactId: metadata.artifactId });
      return { messages: [] };
    },
  });
  await h.controller.submit(h.request('owner', { responseMode: 'structured', resultSchema }));
  h.controller.tick();
  await waitFor(() => h.controller.get(h.identity('owner')).state === 'completed');

  assert.equal(artifactStore.registrations[0].requestId, 'owner');
  assert.equal(artifactStore.registrations[0].toolCallId, 'native-artifact-call');
  assert.equal(h.controller.artifacts(h.identity('owner')).artifacts.length, 1);
  assert.deepEqual(h.controller.get(h.identity('owner')).result, { artifactId: 'artifact-1' });
});
