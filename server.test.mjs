import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from './server.mjs';
import { RequestController } from './controller.mjs';
import { writeConfig } from './config.mjs';
import https from 'node:https';

async function endpoint(t, protocol = 'http') {
  const root = await mkdtemp(join(tmpdir(), 'omp-lan-rpc-test-'));
  const previous = process.env.OMP_LAN_RPC_DIR;
  process.env.OMP_LAN_RPC_DIR = root;
  if (protocol === 'https') await writeConfig({ host: '127.0.0.1', port: 0, protocol });
  const controller = new RequestController({ sessionId: 'test-session', cwd: root,
    isIdle: () => true, hasPendingMessages: () => false, deliver: () => {} });
  const server = await startServer({ getSession: () => controller.session(),
    submit: data => controller.submit(data), getRequest: data => controller.get(data),
    onError: error => { throw error; } });
  t.after(async () => {
    await server.close();
    if (previous === undefined) delete process.env.OMP_LAN_RPC_DIR;
    else process.env.OMP_LAN_RPC_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });
  return { controller, server, root, headers: { 'Content-Type': 'application/json' } };
}

test('HTTP is anonymous, creates no credentials, and still rejects browser origins', async t => {
  const h = await endpoint(t);
  const response = await fetch(h.server.endpoint + '/v1/session');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).sessionId, 'test-session');
  const descriptor = JSON.parse(await readFile(join(h.root, 'instances', h.server.instanceId + '.json'), 'utf8'));
  assert.equal('tokenFile' in descriptor, false);
  assert.deepEqual(await readdir(join(h.root, 'instances')), [h.server.instanceId + '.json']);
  assert.equal((await readdir(h.root)).includes('tls'), false);
  const browser = await fetch(h.server.endpoint + '/v1/requests', {
    method: 'POST', headers: { ...h.headers, Origin: 'https://attacker.invalid' },
    body: JSON.stringify({ generation: h.controller.generation, requestId: 'browser', message: 'should never queue' }),
  });
  assert.equal(browser.status, 403);
  assert.equal(h.controller.session().queueDepth, 0);
});

test('HTTPS requires Bearer auth regardless of spoofed transport headers and verifies TLS', async t => {
  const h = await endpoint(t, 'https');
  const ca = await readFile(h.server.certFile);
  const get = (headers = {}, trust = ca) => new Promise((resolve, reject) => {
    const request = https.get(h.server.endpoint + '/v1/session', { ca: trust, headers, rejectUnauthorized: true }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    request.on('error', reject);
  });
  await assert.rejects(get({}, null));
  const spoofed = await get({ 'X-Forwarded-Proto': 'http', Forwarded: 'proto=http' });
  assert.equal(spoofed.status, 401);
  assert.equal((await get({ Authorization: 'Bearer invalid' })).status, 401);
  const authorized = await get({ Authorization: 'Bearer ' + h.server.token });
  assert.equal(authorized.status, 200);
  assert.equal(authorized.body.includes(h.server.token), false);
  assert.equal((await get({ Authorization: 'Bearer ' + h.server.token, Origin: 'https://attacker.invalid' })).status, 403);
});

test('HTTP request replay is idempotent and rejects stale sessions and conflicting IDs', async t => {
  const h = await endpoint(t);
  const metadata = await (await fetch(h.server.endpoint + '/v1/session', { headers: h.headers })).json();
  const post = body => fetch(h.server.endpoint + '/v1/requests', { method: 'POST', headers: h.headers, body: JSON.stringify(body) });
  const body = { generation: metadata.generation, requestId: 'replay', message: 'same' };
  assert.equal((await post(body)).status, 202);
  assert.equal((await post(body)).status, 202);
  assert.equal((await post({ ...body, message: 'different' })).status, 409);
  assert.equal((await post({ ...body, generation: metadata.generation + 1 })).status, 409);
  assert.equal(h.controller.session().queueDepth, 1);
  const fetched = await fetch(h.server.endpoint + `/v1/requests/replay?generation=${metadata.generation}`, { headers: h.headers });
  assert.equal(fetched.status, 200);
  assert.equal((await fetched.json()).state, 'queued');
});

test('oversized and malformed requests never enter the agent queue', async t => {
  const h = await endpoint(t);
  const post = body => fetch(h.server.endpoint + '/v1/requests', { method: 'POST', headers: h.headers, body });
  assert.equal((await post('{invalid')).status, 400);
  assert.equal((await post(' '.repeat(70 * 1024))).status, 413);
  assert.equal(h.controller.session().queueDepth, 0);
});

test('closing the listener removes discovery and revokes network access', async t => {
  const h = await endpoint(t);
  await h.server.close();
  assert.deepEqual(await readdir(join(h.root, 'instances')), []);
  await assert.rejects(fetch(h.server.endpoint + '/v1/session', { headers: h.headers }));
});
