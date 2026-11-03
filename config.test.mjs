import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readConfig, writeConfig, listenerConfig } from './config.mjs';
import { startServer } from './server.mjs';

const execute = promisify(execFile);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'omp-lan-config-'));
  const previous = process.env.OMP_LAN_RPC_DIR;
  process.env.OMP_LAN_RPC_DIR = root;
  t.after(async () => {
    if (previous === undefined) delete process.env.OMP_LAN_RPC_DIR;
    else process.env.OMP_LAN_RPC_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

test('LAN off keeps saved IP and certificates while exposing only plain loopback', async t => {
  const root = await fixture(t);
  await writeConfig({ host: '192.0.2.10', port: 0, lanEnabled: false,
    tlsCert: join(root, 'not-installed.crt'), tlsKey: join(root, 'not-installed.key') });
  const saved = await readConfig();
  const server = await startServer({
    getSession: () => ({ generation: 1, sessionId: 'fixture', cwd: root, busy: false, queueDepth: 0 }),
    submit: () => { throw new Error('Not used'); }, getRequest: () => undefined,
  });
  try {
    assert.equal(new URL(server.endpoint).hostname, '127.0.0.1');
    assert.equal(new URL(server.endpoint).protocol, 'http:');
    const after = await readConfig();
    assert.equal(after.host, '192.0.2.10');
    assert.equal(after.tlsCert, saved.tlsCert);
    assert.equal(after.tlsKey, saved.tlsKey);
    await assert.rejects(writeConfig({ host: saved.host, port: 0, lanEnabled: true }));
    assert.equal((await readConfig()).lanEnabled, false);
  } finally { await server.close(); }
});

test('existing LAN host configuration retains its enabled behavior', async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'config.json'), JSON.stringify({ host: '192.0.2.11', port: 9443,
    tlsCert: join(root, 'server.crt'), tlsKey: join(root, 'server.key') }), { mode: 0o600 });
  const config = await readConfig();
  assert.equal(config.lanEnabled, true);
  assert.equal(listenerConfig(config).host, '192.0.2.11');
  assert.equal(listenerConfig(config).tlsCert, config.tlsCert);
});

test('CLI host selection enables LAN and explicit off preserves setup for later enable', async t => {
  const root = await fixture(t);
  const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));
  const run = args => execute(process.execPath, [cli, 'config', ...args], {
    env: { ...process.env, OMP_LAN_RPC_DIR: root }, timeout: 10_000,
  });
  await run(['--host', '192.0.2.12', '--tls-cert', join(root, 'cert.pem'), '--tls-key', join(root, 'key.pem')]);
  assert.equal((await readConfig()).lanEnabled, true);
  await run(['--lan', 'off']);
  const disabled = await readConfig();
  assert.equal(disabled.host, '192.0.2.12');
  assert.equal(listenerConfig(disabled).host, '127.0.0.1');
  await run(['--host', '192.0.2.13']);
  assert.equal((await readConfig()).lanEnabled, true);
  await run(['--host', '192.0.2.14', '--lan', 'off']);
  assert.equal((await readConfig()).lanEnabled, false);
});
