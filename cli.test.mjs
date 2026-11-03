import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);

test('writable discovery cannot redirect a private token; trusted discovery still connects', async t => {
  const root = await mkdtemp(join(tmpdir(), 'omp-lan-cli-test-'));
  const instances = join(root, 'instances');
  await mkdir(instances, { mode: 0o700 });
  const instanceId = randomUUID();
  const tokenFile = join(instances, instanceId + '.token');
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
  await writeFile(tokenFile, 'synthetic-test-token\n', { mode: 0o600 });
  await writeFile(descriptorFile, JSON.stringify({ instanceId, pid: process.pid,
    endpoint: `http://127.0.0.1:${server.address().port}`, tokenFile, generation: 42, sessionId: 'fixture' }), { mode: 0o600 });
  const args = [fileURLToPath(new URL('./cli.mjs', import.meta.url)), 'session', '--instance', instanceId];
  const options = { env: { ...process.env, OMP_LAN_RPC_DIR: root }, timeout: 10_000 };

  await chmod(descriptorFile, 0o660);
  await assert.rejects(execute(process.execPath, args, options));
  assert.deepEqual(received, []);

  await chmod(descriptorFile, 0o600);
  const response = await execute(process.execPath, args, options);
  assert.equal(JSON.parse(response.stdout).sessionId, 'fixture');
  assert.deepEqual(received, ['Bearer synthetic-test-token']);
});
