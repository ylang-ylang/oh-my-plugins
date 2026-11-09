import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OperationsLog } from './operations.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'omp-lan-rpc-operations-'));
  const operations = new OperationsLog(root);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, operations };
}

test('operations log persists only allowlisted bounded metadata with private permissions', async t => {
  const { root, operations } = await fixture(t);
  operations.emit('request.admission.accepted', {
    requestId: 'request_1',
    sessionId: 'session_1',
    instanceId: '11111111-1111-4111-8111-111111111111',
    generation: 7,
    state: 'queued',
    message: 'private request body',
    instructions: 'private prompt',
    token: 'private credential',
    url: 'https://example.test/?secret=value',
    arguments: { secret: true },
    result: { secret: true },
  });

  const record = JSON.parse((await readFile(operations.path, 'utf8')).trim());
  assert.deepEqual(record, {
    timestamp: record.timestamp,
    component: 'omp-lan-rpc',
    pid: process.pid,
    event: 'request.admission.accepted',
    requestId: 'request_1',
    sessionId: 'session_1',
    instanceId: '11111111-1111-4111-8111-111111111111',
    generation: 7,
    state: 'queued',
  });
  assert.equal(Number.parseInt((await stat(root)).mode.toString(8).slice(-3), 10), 700);
  assert.equal(Number.parseInt((await stat(join(root, 'logs'))).mode.toString(8).slice(-3), 10), 700);
  assert.equal(Number.parseInt((await stat(operations.path)).mode.toString(8).slice(-3), 10), 600);
});

test('operations log rotates the per-process family before it exceeds 10 MiB', async t => {
  const { operations } = await fixture(t);
  operations.emit('listener.started', { state: 'listening' });
  await truncate(operations.path, 10 * 1024 * 1024);

  operations.emit('listener.stopped', { state: 'stopped' });

  assert.equal((await stat(`${operations.path}.1`)).size, 10 * 1024 * 1024);
  const current = JSON.parse((await readFile(operations.path, 'utf8')).trim());
  assert.equal(current.event, 'listener.stopped');
  assert.equal(current.state, 'stopped');
});
