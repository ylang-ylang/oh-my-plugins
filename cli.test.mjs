import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { networkInterfaces, tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);

test('untrusted HTTP discovery cannot redirect control; trusted discovery sends no credentials', async t => {
  const root = await mkdtemp(join(tmpdir(), 'omp-lan-cli-test-'));
  const instances = join(root, 'instances');
  await mkdir(instances, { mode: 0o700 });
  const instanceId = randomUUID();
  const descriptorFile = join(instances, instanceId + '.json');
  const received = [];
  const session = { protocolVersion: 1, instanceId, generation: 42, sessionId: 'fixture',
    cwd: root, busy: false, queueDepth: 0 };
  const server = createServer((request, response) => {
    received.push(request.headers.authorization);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(session));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(descriptorFile, JSON.stringify({ instanceId, pid: process.pid,
    endpoint: `http://127.0.0.1:${server.address().port}`, generation: 42, sessionId: 'fixture' }), { mode: 0o600 });
  const args = [fileURLToPath(new URL('./cli.mjs', import.meta.url)), 'session', '--instance', instanceId];
  const options = { env: { ...process.env, OMP_LAN_RPC_DIR: root }, timeout: 10_000 };

  await chmod(descriptorFile, 0o660);
  await assert.rejects(execute(process.execPath, args, options));
  assert.deepEqual(received, []);

  await chmod(descriptorFile, 0o600);
  const response = await execute(process.execPath, args, options);
  assert.equal(JSON.parse(response.stdout).sessionId, 'fixture');
  assert.deepEqual(received, [undefined]);
});

test('LAN HTTP requires consent, never reads or sends credentials, and recovery retains consent', async t => {
  const host = Object.values(networkInterfaces()).flat().find(item => item && !item.internal && item.family === 'IPv4')?.address;
  if (!host) return t.skip('No non-loopback IPv4 interface is available');
  const root = await mkdtemp(join(tmpdir(), 'omp-lan-http-client-'));
  const instances = join(root, 'instances');
  await mkdir(instances, { mode: 0o700 });
  const instanceId = randomUUID();
  const tokenFile = join(instances, instanceId + '.token');
  const messageFile = join(root, 'message.txt');
  const session = { protocolVersion: 1, instanceId, generation: 42, sessionId: 'fixture', cwd: root, busy: false, queueDepth: 0 };
  const received = [];
  let redirect = false;
  const server = createServer((request, response) => {
    received.push({ url: request.url, authorization: request.headers.authorization });
    if (redirect) {
      response.writeHead(302, { Location: '/must-not-follow' });
      response.end();
    } else if (request.method === 'POST') {
      request.socket.destroy();
    } else {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(request.url === '/v1/session' ? session : {
        requestId: 'recover', generation: 42, state: 'queued',
      }));
    }
  });
  await new Promise(resolve => server.listen(0, host, resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const endpoint = `http://${host}:${server.address().port}`;
  await writeFile(messageFile, 'recovery fixture');
  await writeFile(join(instances, instanceId + '.json'), JSON.stringify({
    instanceId, pid: process.pid, endpoint, generation: 42, sessionId: 'fixture',
  }), { mode: 0o600 });
  const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));
  const options = { env: { ...process.env, OMP_LAN_RPC_DIR: root }, timeout: 10_000 };
  const run = args => execute(process.execPath, [cli, ...args], options);
  await assert.rejects(run(['session', '--endpoint', endpoint]));
  await assert.rejects(run(['session', '--instance', instanceId]));
  assert.deepEqual(received, []);
  await assert.rejects(run(['session', '--endpoint', endpoint, '--token-file', tokenFile, '--allow-http']), error => /--token-file is forbidden and was not read/.test(error.stderr));
  await assert.rejects(run(['session', '--endpoint', endpoint, '--ca', tokenFile, '--allow-http']), error => /--ca is valid only/.test(error.stderr));
  assert.deepEqual(received, []);
  const allowed = await run(['session', '--endpoint', endpoint, '--allow-http']);
  assert.equal(JSON.parse(allowed.stdout).sessionId, 'fixture');
  assert.equal(received[0].authorization, undefined);
  const discovered = await run(['session', '--instance', instanceId, '--allow-http']);
  assert.equal(JSON.parse(discovered.stdout).sessionId, 'fixture');
  let recovery;
  await assert.rejects(run(['send', '--endpoint', endpoint, '--allow-http', '--message-file', messageFile, '--request-id', 'recover']), error => {
    recovery = error.stderr.split('Query it with:\n  ')[1]?.trim();
    return Boolean(recovery);
  });
  const queried = await execute('/bin/sh', ['-c', recovery], options);
  assert.equal(JSON.parse(queried.stdout).state, 'queued');
  assert.equal(recovery.includes('--token-file'), false);
  assert.ok(received.every(request => request.authorization === undefined));
  redirect = true;
  const before = received.length;
  await assert.rejects(run(['session', '--instance', instanceId, '--allow-http']));
  assert.equal(received.length, before + 1);
  assert.equal(received.at(-1).url, '/v1/session');
});

test('--allow-http never disables HTTPS certificate verification', async t => {
  const root = await mkdtemp(join(tmpdir(), 'omp-lan-https-client-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const certFile = join(root, 'server.crt');
  const keyFile = join(root, 'server.key');
  try {
    await execute('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', keyFile, '-out', certFile]);
  } catch (error) {
    if (error.code === 'ENOENT') return t.skip('OpenSSL is not installed');
    throw error;
  }
  const received = [];
  const server = createHttpsServer({ cert: await readFile(certFile), key: await readFile(keyFile) }, (request, response) => {
    received.push(request.headers.authorization);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ protocolVersion: 1, instanceId: randomUUID(), generation: 42,
      sessionId: 'tls', cwd: root, busy: false, queueDepth: 0 }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const tokenFile = join(root, 'token');
  await writeFile(tokenFile, 'synthetic-tls-test-token\n', { mode: 0o600 });
  const args = [fileURLToPath(new URL('./cli.mjs', import.meta.url)), 'session',
    '--endpoint', `https://127.0.0.1:${server.address().port}`, '--token-file', tokenFile, '--allow-http'];
  await assert.rejects(execute(process.execPath, [args[0], 'session', '--endpoint', args[3], '--ca', certFile], { timeout: 10_000 }), error => /HTTPS requires --token-file/.test(error.stderr));
  await assert.rejects(execute(process.execPath, args, { timeout: 10_000 }));
  assert.deepEqual(received, []);
  const trusted = await execute(process.execPath, [...args, '--ca', certFile], { timeout: 10_000 });
  assert.equal(JSON.parse(trusted.stdout).sessionId, 'tls');
});
