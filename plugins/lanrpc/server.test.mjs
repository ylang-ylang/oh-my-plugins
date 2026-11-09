import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, open, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import https from 'node:https';
import { startServer } from './server.mjs';
import { writeConfig } from './config.mjs';
import { failure } from './protocol.mjs';

const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const TOOL_CALL_ID = '22222222-2222-4222-8222-222222222222';
const ARTIFACT_ID = '33333333-3333-4333-8333-333333333333';
const LEASE_ID = '44444444-4444-4444-8444-444444444444';
const GENERATION = 17;
const ARTIFACT_BYTES = Buffer.from('immutable artifact bytes');

class FakeController {
  constructor(root) {
    this.instanceId = INSTANCE_ID;
    this.root = root;
    this.calls = new Map();
    this.artifactPath = join(root, 'artifact.bin');
  }

  remember(name, value) {
    const calls = this.calls.get(name) ?? [];
    calls.push(structuredClone(value));
    this.calls.set(name, calls);
  }

  guard(identity) {
    if (identity.instanceId !== this.instanceId) {
      throw failure(409, 'instance_mismatch', 'request belongs to another listener instance');
    }
    if (identity.generation !== GENERATION) {
      throw failure(409, 'generation_mismatch', 'request belongs to another generation');
    }
  }

  session() {
    return {
      protocolVersion: 2,
      instanceId: this.instanceId,
      generation: GENERATION,
      sessionId: 'test-session',
      cwd: this.root,
      busy: false,
      queueDepth: 0,
      capabilities: {
        structuredResults: true,
        callerTools: true,
        artifacts: true,
        conversationExecution: true,
      },
    };
  }

  request(identity, state = 'queued') {
    return {
      instanceId: this.instanceId,
      generation: GENERATION,
      sessionId: 'test-session',
      requestId: identity.requestId,
      responseMode: 'native',
      state,
      createdAt: 1000,
      updatedAt: 1000,
      queueDeadlineAt: 3_601_000,
      deadlineAt: 3_601_000,
    };
  }

  async submit(body) {
    this.guard(body);
    this.remember('submit', body);
    if (body.requestId === 'schema_failure') {
      throw failure(422, 'schema_validation', 'result does not match resultSchema', {
        errors: [{ instancePath: '/answer', schemaPath: '#/properties/answer/type', keyword: 'type', message: 'must be string' }],
        secret: 'must never leave the process',
        stack: 'also private',
      });
    }
    return this.request(body);
  }

  get(identity) {
    this.guard(identity);
    this.remember('get', identity);
    if (identity.requestId === 'explode') throw new Error('provider secret and stack');
    return this.request(identity);
  }

  cancel(identity) {
    this.guard(identity);
    this.remember('cancel', identity);
    return this.request(identity, 'cancelled');
  }

  events(identity) {
    this.guard(identity);
    this.remember('events', identity);
    return { events: [], nextSequence: identity.after };
  }

  toolRecord(identity, state = 'pending') {
    return {
      instanceId: this.instanceId,
      generation: GENERATION,
      sessionId: 'test-session',
      requestId: identity.requestId,
      toolCallId: TOOL_CALL_ID,
      name: 'lookup_item',
      arguments: { id: 42 },
      state,
      createdAt: 2000,
      updatedAt: 2000,
      deadlineAt: 62000,
      attempt: state === 'pending' ? 0 : 1,
    };
  }

  toolCalls(identity) {
    this.guard(identity);
    this.remember('toolCalls', identity);
    return { toolCalls: [this.toolRecord(identity)] };
  }

  toolCall(identity) {
    this.guard(identity);
    this.remember('toolCall', identity);
    return this.toolRecord(identity);
  }

  claim(identity) {
    this.guard(identity);
    this.remember('claim', identity);
    return {
      ...this.toolRecord(identity, 'claimed'),
      workerId: identity.workerId,
      claimId: identity.claimId,
      leaseId: LEASE_ID,
      leaseExpiresAt: 32000,
    };
  }

  async toolResult(identity) {
    this.guard(identity);
    this.remember('toolResult', identity);
    return { ...this.toolRecord(identity, 'completed'), result: identity.outcome.result };
  }

  artifactMetadata() {
    return {
      artifactId: ARTIFACT_ID,
      name: 'réport.txt',
      mediaType: 'text/plain',
      size: ARTIFACT_BYTES.byteLength,
      sha256: '0'.repeat(64),
      createdAt: 3000,
      expiresAt: 1803000,
    };
  }

  artifacts(identity) {
    this.guard(identity);
    this.remember('artifacts', identity);
    return { artifacts: [this.artifactMetadata()] };
  }

  async artifact(identity) {
    this.guard(identity);
    this.remember('artifact', identity);
    if (identity.artifactId !== ARTIFACT_ID) {
      throw failure(404, 'artifact_not_found', 'artifact was not found for this request');
    }
    return { metadata: this.artifactMetadata(), handle: await open(this.artifactPath, 'r') };
  }
}

async function endpoint(t, protocol = 'http') {
  const root = await mkdtemp(join(tmpdir(), 'omp-lan-rpc-test-'));
  const previous = process.env.OMP_LAN_RPC_DIR;
  process.env.OMP_LAN_RPC_DIR = root;
  if (protocol === 'https') await writeConfig({ host: '127.0.0.1', port: 0, protocol });
  await writeFile(join(root, 'artifact.bin'), ARTIFACT_BYTES);
  const controller = new FakeController(root);
  const reportedErrors = [];
  const server = await startServer({ controller, onError: error => reportedErrors.push(error) });
  t.after(async () => {
    await server.close();
    if (previous === undefined) delete process.env.OMP_LAN_RPC_DIR;
    else process.env.OMP_LAN_RPC_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });
  return {
    controller,
    server,
    root,
    reportedErrors,
    headers: { 'Content-Type': 'application/json' },
    identity: { instanceId: INSTANCE_ID, generation: GENERATION },
  };
}

function query(identity, extra = '') {
  return `instanceId=${encodeURIComponent(identity.instanceId)}&generation=${identity.generation}${extra}`;
}

async function json(response) {
  return await response.json();
}

test('v2 exposes every request-scoped route and streams immutable artifact bytes', async t => {
  const h = await endpoint(t);
  const sessionResponse = await fetch(h.server.endpoint + '/v2/session');
  assert.equal(sessionResponse.status, 200);
  assert.deepEqual(await json(sessionResponse), h.controller.session());

  const requestBody = { ...h.identity, requestId: 'job_001', message: 'do the work',
    instructions: 'Only this request: use the supplied lookup tool.', responseMode: 'native', queueTimeoutMs: 7_200_000 };
  const submitted = await fetch(h.server.endpoint + '/v2/requests', {
    method: 'POST', headers: h.headers, body: JSON.stringify(requestBody),
  });
  assert.equal(submitted.status, 202);
  assert.equal((await json(submitted)).requestId, 'job_001');
  assert.deepEqual(h.controller.calls.get('submit')[0], requestBody);

  const base = h.server.endpoint + '/v2/requests/job_001';
  assert.equal((await fetch(`${base}?${query(h.identity)}`)).status, 200);
  const cancelled = await fetch(base + '/cancel', {
    method: 'POST', headers: h.headers, body: JSON.stringify(h.identity),
  });
  assert.equal((await json(cancelled)).state, 'cancelled');
  assert.deepEqual(h.controller.calls.get('get')[0], { ...h.identity, requestId: 'job_001' });
  assert.deepEqual(h.controller.calls.get('cancel')[0], { ...h.identity, requestId: 'job_001' });

  const events = await json(await fetch(`${base}/events?${query(h.identity, '&after=3')}`));
  assert.deepEqual(events, { events: [], nextSequence: 3 });
  assert.deepEqual(h.controller.calls.get('events')[0], { ...h.identity, requestId: 'job_001', after: 3 });

  const toolBase = `${base}/tool-calls`;
  assert.equal((await json(await fetch(`${toolBase}?${query(h.identity)}`))).toolCalls.length, 1);
  assert.equal((await json(await fetch(`${toolBase}/${TOOL_CALL_ID}?${query(h.identity)}`))).toolCallId, TOOL_CALL_ID);
  const claimed = await json(await fetch(`${toolBase}/${TOOL_CALL_ID}/claim`, {
    method: 'POST', headers: h.headers,
    body: JSON.stringify({ ...h.identity, workerId: 'worker_1', claimId: 'claim_1', leaseMs: 30000 }),
  }));
  assert.equal(claimed.leaseId, LEASE_ID);
  const toolResult = await json(await fetch(`${toolBase}/${TOOL_CALL_ID}/result`, {
    method: 'POST', headers: h.headers,
    body: JSON.stringify({ ...h.identity, leaseId: LEASE_ID, outcome: { status: 'completed', result: { title: 'Example' } } }),
  }));
  assert.deepEqual(toolResult.result, { title: 'Example' });
  assert.deepEqual(h.controller.calls.get('toolCalls')[0], { ...h.identity, requestId: 'job_001' });
  assert.deepEqual(h.controller.calls.get('toolCall')[0], { ...h.identity, requestId: 'job_001', toolCallId: TOOL_CALL_ID });
  assert.deepEqual(h.controller.calls.get('claim')[0], {
    ...h.identity, requestId: 'job_001', toolCallId: TOOL_CALL_ID,
    workerId: 'worker_1', claimId: 'claim_1', leaseMs: 30000,
  });
  assert.deepEqual(h.controller.calls.get('toolResult')[0], {
    ...h.identity, requestId: 'job_001', toolCallId: TOOL_CALL_ID, leaseId: LEASE_ID,
    outcome: { status: 'completed', result: { title: 'Example' } },
  });

  const artifactBase = `${base}/artifacts`;
  assert.equal((await json(await fetch(`${artifactBase}?${query(h.identity)}`))).artifacts[0].artifactId, ARTIFACT_ID);
  assert.deepEqual(h.controller.calls.get('artifacts')[0], { ...h.identity, requestId: 'job_001' });
  const download = await fetch(`${artifactBase}/${ARTIFACT_ID}?${query(h.identity)}`);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('content-type'), 'text/plain');
  assert.equal(download.headers.get('content-length'), String(ARTIFACT_BYTES.byteLength));
  assert.match(download.headers.get('content-disposition'), /^attachment; /);
  assert.equal(download.headers.get('cache-control'), 'no-store');
  assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), ARTIFACT_BYTES);
  assert.deepEqual(h.controller.calls.get('artifact')[0], { ...h.identity, requestId: 'job_001', artifactId: ARTIFACT_ID });
});

test('HTTP stays anonymous but rejects origins, old protocol, malformed routes, and oversized bodies', async t => {
  const h = await endpoint(t);
  assert.equal((await fetch(h.server.endpoint + '/v2/session')).status, 200);
  const descriptor = JSON.parse(await readFile(join(h.root, 'instances', INSTANCE_ID + '.json'), 'utf8'));
  assert.equal(descriptor.protocolVersion, 2);
  assert.equal(descriptor.instanceId, INSTANCE_ID);
  assert.equal('token' in descriptor, false);
  assert.equal('tokenFile' in descriptor, false);
  assert.deepEqual(await readdir(join(h.root, 'instances')), [INSTANCE_ID + '.json']);
  assert.equal((await readdir(h.root)).includes('tls'), false);

  const upgraded = await fetch(h.server.endpoint + '/v1/requests/anything', { method: 'DELETE' });
  assert.equal(upgraded.status, 410);
  assert.equal((await json(upgraded)).error.code, 'protocol_upgraded');

  const origin = await fetch(h.server.endpoint + '/v2/requests', {
    method: 'POST', headers: { ...h.headers, Origin: 'https://attacker.invalid' }, body: '{}',
  });
  assert.equal(origin.status, 403);
  assert.equal(h.controller.calls.has('submit'), false);

  const method = await fetch(h.server.endpoint + '/v2/requests');
  assert.equal(method.status, 405);
  assert.equal(method.headers.get('allow'), 'POST');
  const malformed = await fetch(h.server.endpoint + '/v2/requests', {
    method: 'POST', headers: h.headers, body: '{invalid',
  });
  assert.equal(malformed.status, 400);
  assert.equal((await json(malformed)).error.code, 'invalid_json');
  const oversized = await fetch(h.server.endpoint + '/v2/requests', {
    method: 'POST', headers: h.headers, body: JSON.stringify({ message: 'x'.repeat(70 * 1024) }),
  });
  assert.equal(oversized.status, 413);
  assert.equal((await json(oversized)).error.code, 'body_too_large');
  const oversizedToolResult = await fetch(`${h.server.endpoint}/v2/requests/job/tool-calls/${TOOL_CALL_ID}/result`, {
    method: 'POST', headers: h.headers,
    body: JSON.stringify({ ...h.identity, leaseId: LEASE_ID, outcome: { status: 'completed', result: 'x'.repeat(321 * 1024) } }),
  });
  assert.equal(oversizedToolResult.status, 413);
  assert.equal((await json(oversizedToolResult)).error.code, 'body_too_large');


  const duplicateQuery = await fetch(`${h.server.endpoint}/v2/requests/job?instanceId=${INSTANCE_ID}&instanceId=${INSTANCE_ID}&generation=${GENERATION}`);
  assert.equal(duplicateQuery.status, 400);
  assert.equal((await json(duplicateQuery)).error.code, 'invalid_query');
  const extraCancelField = await fetch(h.server.endpoint + '/v2/requests/job/cancel', {
    method: 'POST', headers: h.headers, body: JSON.stringify({ ...h.identity, path: '/etc/passwd' }),
  });
  assert.equal(extraCancelField.status, 400);
  assert.equal((await json(extraCancelField)).error.code, 'invalid_request');
  const encodedPath = await fetch(`${h.server.endpoint}/v2/requests/job/artifacts/%2Fetc%2Fpasswd?${query(h.identity)}`);
  assert.equal(encodedPath.status, 400);
  assert.equal((await json(encodedPath)).error.code, 'invalid_artifact');
  assert.equal(h.controller.calls.has('artifact'), false);
});

test('all scoped routes pass both identity guards and errors expose only safe protocol details', async t => {
  const h = await endpoint(t);
  const wrong = { instanceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', generation: GENERATION };
  const mismatch = await fetch(`${h.server.endpoint}/v2/requests/job?${query(wrong)}`);
  assert.equal(mismatch.status, 409);
  assert.equal((await json(mismatch)).error.code, 'instance_mismatch');
  const stale = await fetch(`${h.server.endpoint}/v2/requests/job?${query({ ...h.identity, generation: GENERATION + 1 })}`);
  assert.equal(stale.status, 409);
  assert.equal((await json(stale)).error.code, 'generation_mismatch');


  const schemaFailure = await fetch(h.server.endpoint + '/v2/requests', {
    method: 'POST', headers: h.headers,
    body: JSON.stringify({ ...h.identity, requestId: 'schema_failure', message: 'structured', responseMode: 'structured', resultSchema: { type: 'object' } }),
  });
  assert.equal(schemaFailure.status, 422);
  const schemaError = (await json(schemaFailure)).error;
  assert.equal(schemaError.code, 'schema_validation');
  assert.deepEqual(schemaError.details, {
    errors: [{ instancePath: '/answer', schemaPath: '#/properties/answer/type', keyword: 'type', message: 'must be string' }],
  });
  assert.equal(JSON.stringify(schemaError).includes('must never leave'), false);
  assert.equal('stack' in schemaError, false);

  const internal = await fetch(`${h.server.endpoint}/v2/requests/explode?${query(h.identity)}`);
  assert.equal(internal.status, 500);
  assert.deepEqual(await json(internal), { error: { code: 'internal_error', message: 'internal server error' } });
  assert.equal(h.reportedErrors.length, 1);
});

test('HTTPS requires verified TLS and its private Bearer credential despite spoofed headers', async t => {
  const h = await endpoint(t, 'https');
  const ca = await readFile(h.server.certFile);
  const get = (headers = {}, trust = ca) => new Promise((resolve, reject) => {
    const request = https.get(h.server.endpoint + '/v2/session', { ca: trust, headers, rejectUnauthorized: true }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    request.on('error', reject);
  });

  await assert.rejects(get({}, null));
  assert.equal((await get({ 'X-Forwarded-Proto': 'http', Forwarded: 'proto=http' })).status, 401);
  assert.equal((await get({ Authorization: 'Bearer invalid' })).status, 401);
  const authorized = await get({ Authorization: 'Bearer ' + h.server.token });
  assert.equal(authorized.status, 200);
  const session = JSON.parse(authorized.body);
  assert.equal(session.protocolVersion, 2);
  assert.equal('token' in session, false);
  assert.equal('tokenFile' in session, false);
  assert.equal(authorized.body.includes(h.server.token), false);
  assert.equal((await get({ Authorization: 'Bearer ' + h.server.token, Origin: 'https://attacker.invalid' })).status, 403);

  const descriptor = JSON.parse(await readFile(join(h.root, 'instances', INSTANCE_ID + '.json'), 'utf8'));
  assert.equal(descriptor.protocolVersion, 2);
  assert.equal(descriptor.tokenFile, h.server.tokenFile);
  assert.equal('token' in descriptor, false);
});
