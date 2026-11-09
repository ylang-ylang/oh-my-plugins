import test from 'node:test';
import assert from 'node:assert/strict';
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  truncate,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ArtifactStore } from './artifacts.mjs';
import { LIMITS } from './protocol.mjs';

async function fixture(t, options = {}) {
  const base = await mkdtemp(join(tmpdir(), 'omp-lan-artifacts-'));
  const root = join(base, 'runtime');
  const cwd = join(base, 'work');
  await mkdir(root, { mode: 0o700 });
  await mkdir(cwd, { mode: 0o700 });
  const instanceId = randomUUID();
  const store = new ArtifactStore({ root, cwd, instanceId, ...options });
  await store.init();
  t.after(async () => {
    await store.close().catch(() => {});
    await rm(base, { recursive: true, force: true });
  });
  return { base, root, cwd, instanceId, store };
}

function hasCode(expected) {
  return error => {
    assert.equal(error.code, expected);
    return true;
  };
}

async function streamHandle(handle) {
  const chunks = [];
  try {
    for await (const chunk of handle.createReadStream({ autoClose: false })) chunks.push(chunk);
    return Buffer.concat(chunks);
  } finally {
    await handle.close();
  }
}

function registration(requestId, toolCallId, path, overrides = {}) {
  return { requestId, toolCallId, path, mediaType: 'text/plain', ...overrides };
}

function runProcess(program, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve(child.pid);
      else reject(new Error(`${program} exited with ${code ?? signal}`));
    });
  });
}

function requireRegistration(t, store) {
  if (store.registrationSupported) return true;
  t.skip('secure artifact registration is unavailable on this host');
  return false;
}

test('unsupported registration is advertised and fails closed without breaking store lifecycle', async t => {
  const base = await mkdtemp(join(tmpdir(), 'omp-lan-artifacts-unsupported-'));
  const root = join(base, 'runtime');
  const missingCwd = join(base, 'missing-worktree');
  await mkdir(root, { mode: 0o700 });
  const instanceId = randomUUID();
  const store = new ArtifactStore({ root, cwd: missingCwd, instanceId });
  t.after(async () => {
    await store.close().catch(() => {});
    await rm(base, { recursive: true, force: true });
  });
  assert.equal(store.registrationSupported, false);
  await store.init();
  assert.equal(store.registrationSupported, false);
  await assert.rejects(
    store.register(registration('request', 'call', 'file.txt')),
    hasCode('host_unsupported'),
  );
  assert.deepEqual(store.list({ requestId: 'request' }), []);
  await assert.rejects(store.open({ requestId: 'request', artifactId: randomUUID() }), hasCode('artifact_not_found'));
  await store.close();
  await assert.rejects(access(join(root, 'artifacts', instanceId)), error => error.code === 'ENOENT');
});

test('close succeeds when external lifecycle cleanup already removed the instance root', async t => {
  const base = await mkdtemp(join(tmpdir(), 'omp-lan-artifacts-precleaned-'));
  const root = join(base, 'runtime');
  const cwd = join(base, 'work');
  await mkdir(root, { mode: 0o700 });
  await mkdir(cwd, { mode: 0o700 });
  const store = new ArtifactStore({ root, cwd, instanceId: randomUUID() });
  t.after(async () => {
    await store.close().catch(() => {});
    await rm(base, { recursive: true, force: true });
  });
  await store.init();
  await rm(root, { recursive: true, force: true });
  await store.close();
  assert.equal(store.registrationSupported, false);
});

test('registration snapshots immutable private files and retrieval is request-scoped', async t => {
  const { root, cwd, instanceId, store } = await fixture(t);
  if (!requireRegistration(t, store)) return;
  const source = join(cwd, 'report.txt');
  await writeFile(source, 'original report', { mode: 0o644 });

  const metadata = await store.register(registration('request_a', 'native_call_a', 'report.txt'));
  assert.deepEqual(metadata, {
    artifactId: metadata.artifactId,
    name: 'report.txt',
    mediaType: 'text/plain',
    size: Buffer.byteLength('original report'),
    sha256: createHash('sha256').update('original report').digest('hex'),
    createdAt: metadata.createdAt,
    expiresAt: metadata.createdAt + LIMITS.artifactTtlMs,
  });
  assert.deepEqual(store.list({ requestId: 'request_a' }), [metadata]);
  assert.deepEqual(store.list({ requestId: 'request_b' }), []);
  await assert.rejects(store.open({ requestId: 'request_b', artifactId: metadata.artifactId }), hasCode('artifact_not_found'));

  await writeFile(source, 'mutated after registration');
  const opened = await store.open({ requestId: 'request_a', artifactId: metadata.artifactId });
  assert.deepEqual(opened.metadata, metadata);
  assert.equal((await streamHandle(opened.handle)).toString(), 'original report');

  const instanceDirectory = join(root, 'artifacts', instanceId);
  assert.equal((await lstat(join(root, 'artifacts'))).mode & 0o777, 0o700);
  assert.equal((await lstat(instanceDirectory)).mode & 0o777, 0o700);
  assert.equal((await lstat(join(instanceDirectory, '.owner.json'))).mode & 0o777, 0o600);
  const snapshots = (await readdir(instanceDirectory)).filter(name => name.endsWith('.bin'));
  assert.equal(snapshots.length, 1);
  assert.equal((await lstat(join(instanceDirectory, snapshots[0]))).mode & 0o777, 0o600);
});

test('registration rejects traversal, symlinks, non-files, unsafe names, and parameterized media types without leaking source paths', async t => {
  const { base, root, cwd, store } = await fixture(t);
  const outsideDirectory = join(base, 'outside');
  if (!requireRegistration(t, store)) return;
  const outsideFile = join(outsideDirectory, 'secret.txt');
  await mkdir(outsideDirectory);
  await writeFile(outsideFile, 'secret');
  await symlink(outsideFile, join(cwd, 'file-link'));
  await symlink(outsideDirectory, join(cwd, 'directory-link'));
  await mkdir(join(cwd, 'not-a-file'));
  await mkdir(join(cwd, 'inside'));
  await writeFile(join(cwd, 'inside', 'nested.txt'), 'nested');
  await symlink('inside', join(cwd, 'inside-link'));
  await writeFile(join(cwd, 'safe.txt'), 'safe');

  for (const [toolCallId, path] of [
    ['traversal', '../outside/secret.txt'],
    ['absolute', outsideFile],
    ['file_symlink', 'file-link'],
    ['ancestor_symlink', 'directory-link/secret.txt'],
    ['internal_ancestor_symlink', 'inside-link/nested.txt'],
    ['directory', 'not-a-file'],
  ]) {
    await assert.rejects(store.register(registration('request', toolCallId, path)), error => {
      assert.equal(error.code, 'invalid_artifact');
      assert.equal(error.message.includes(root), false);
      assert.equal(error.message.includes(outsideFile), false);
      return true;
    });
  }

  await assert.rejects(
    store.register(registration('request', 'bad_name', 'safe.txt', { name: '../secret.txt' })),
    hasCode('invalid_artifact'),
  );
  await assert.rejects(
    store.register(registration('request', 'bad_type', 'safe.txt', { mediaType: 'text/plain; charset=utf-8' })),
    hasCode('invalid_artifact'),
  );
  assert.deepEqual(store.list({ requestId: 'request' }), []);
});

test('non-regular replacement cannot block registration under the store lock', { timeout: 2_000 }, async t => {
  if (process.platform !== 'linux') return t.skip('secure descriptor traversal is Linux-only');
  const { cwd, store } = await fixture(t);
  if (!requireRegistration(t, store)) return;
  const fifo = join(cwd, 'pipe');
  await runProcess('mkfifo', [fifo]);
  let fallbackFired = false;
  let unblock = Promise.resolve();
  const timer = setTimeout(() => {
    fallbackFired = true;
    unblock = writeFile(fifo, 'unblock').catch(() => {});
  }, 500);
  await assert.rejects(store.register(registration('request', 'fifo', 'pipe')), hasCode('invalid_artifact'));
  clearTimeout(timer);
  await unblock;
  assert.equal(fallbackFired, false, 'registration waited for a FIFO writer');
  assert.deepEqual(store.list({ requestId: 'request' }), []);
});

test('plugin runtime files cannot be registered even when cwd contains the runtime root', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'omp-lan-broad-cwd-'));
  const root = join(cwd, '.lan-rpc-private');
  await mkdir(root, { mode: 0o700 });
  const store = new ArtifactStore({ root, cwd, instanceId: randomUUID() });
  await store.init();
  t.after(async () => {
    await store.close().catch(() => {});
    await rm(cwd, { recursive: true, force: true });
  });
  if (!requireRegistration(t, store)) return;

  const credential = join(root, 'listener.token');
  await writeFile(credential, 'private credential', { mode: 0o600 });
  await assert.rejects(
    store.register(registration('request', 'credential', '.lan-rpc-private/listener.token')),
    error => {
      assert.equal(error.code, 'invalid_artifact');
      assert.equal(error.message.includes(root), false);
      assert.equal(error.message.includes(credential), false);
      return true;
    },
  );
  assert.deepEqual(store.list({ requestId: 'request' }), []);
});

test('native tool-call registration is idempotent but conflicting arguments or content are rejected', async t => {
  const { cwd, store } = await fixture(t);
  if (!requireRegistration(t, store)) return;
  const source = join(cwd, 'result.txt');
  await writeFile(source, 'first version');
  const input = registration('request_a', 'native_call', 'result.txt', { name: 'answer.txt' });

  const first = await store.register(input);
  assert.deepEqual(await store.register({ ...input }), first);
  assert.equal(store.list({ requestId: 'request_a' }).length, 1);

  await assert.rejects(store.register({ ...input, name: 'other.txt' }), hasCode('artifact_conflict'));
  await writeFile(source, 'different content');
  await assert.rejects(store.register(input), hasCode('artifact_conflict'));
  assert.equal(store.list({ requestId: 'request_a' }).length, 1);

  const otherRequest = await store.register({ ...input, requestId: 'request_b' });
  assert.notEqual(otherRequest.artifactId, first.artifactId);
});

test('expired snapshots are removed while metadata remains distinguishable from unknown artifacts', async t => {
  let now = 10_000;
  const { root, cwd, instanceId, store } = await fixture(t, { now: () => now });
  if (!requireRegistration(t, store)) return;
  await writeFile(join(cwd, 'short-lived.txt'), 'temporary');
  const metadata = await store.register(registration('request', 'call', 'short-lived.txt'));
  assert.equal(metadata.createdAt, now);

  now = metadata.expiresAt;
  assert.deepEqual(store.list({ requestId: 'request' }), []);
  await assert.rejects(store.open({ requestId: 'request', artifactId: metadata.artifactId }), hasCode('artifact_expired'));
  await store.expire();
  await assert.rejects(store.open({ requestId: 'request', artifactId: metadata.artifactId }), hasCode('artifact_expired'));
  await assert.rejects(store.open({ requestId: 'request', artifactId: randomUUID() }), hasCode('artifact_not_found'));

  const snapshots = (await readdir(join(root, 'artifacts', instanceId))).filter(name => name.endsWith('.bin'));
  assert.deepEqual(snapshots, []);
});

test('failed expired deletion remains retriable and blocks new snapshots until bytes are removed', async t => {
  let now = 50_000;
  const { root, cwd, instanceId, store } = await fixture(t, { now: () => now });
  if (!requireRegistration(t, store)) return;
  await writeFile(join(cwd, 'old.txt'), 'old bytes');
  const metadata = await store.register(registration('request', 'old_call', 'old.txt'));
  const instanceDirectory = join(root, 'artifacts', instanceId);
  const snapshotName = (await readdir(instanceDirectory)).find(name => name.endsWith('.bin'));
  assert.ok(snapshotName);
  const snapshot = join(instanceDirectory, snapshotName);

  await rm(snapshot);
  await mkdir(snapshot);
  await writeFile(join(snapshot, 'blocker'), 'not unlinkable as a file');
  now = metadata.expiresAt;
  await assert.rejects(store.expire(), hasCode('internal_error'));
  assert.deepEqual(store.list({ requestId: 'request' }), []);

  await writeFile(join(cwd, 'new.txt'), 'new bytes');
  await assert.rejects(
    store.register(registration('request', 'new_call', 'new.txt')),
    hasCode('internal_error'),
  );

  await rm(snapshot, { recursive: true });
  await writeFile(snapshot, 'stale replacement', { mode: 0o600 });
  await store.expire();
  await assert.rejects(access(snapshot), error => error.code === 'ENOENT');
  const replacement = await store.register(registration('request', 'new_call', 'new.txt'));
  assert.equal(replacement.name, 'new.txt');
});

test('file and per-request artifact quotas are enforced without partial registrations', async t => {
  const { cwd, store } = await fixture(t);
  if (!requireRegistration(t, store)) return;
  const tooLarge = join(cwd, 'too-large.bin');
  await writeFile(tooLarge, '');
  await truncate(tooLarge, LIMITS.artifactBytes + 1);
  await assert.rejects(
    store.register(registration('oversized', 'call', 'too-large.bin', { mediaType: 'application/octet-stream' })),
    hasCode('artifact_too_large'),
  );

  await writeFile(join(cwd, 'tiny.txt'), 'x');
  for (let index = 0; index < LIMITS.artifacts; index += 1) {
    await store.register(registration('count_limited', `call_${index}`, 'tiny.txt'));
  }
  await assert.rejects(
    store.register(registration('count_limited', 'one_too_many', 'tiny.txt')),
    hasCode('artifact_capacity'),
  );
  assert.equal(store.list({ requestId: 'count_limited' }).length, LIMITS.artifacts);
});

test('request and instance byte quotas use copied file sizes', async t => {
  const { cwd, store } = await fixture(t);
  if (!requireRegistration(t, store)) return;
  await Promise.all(['sixteen.bin', 'twenty.bin', 'twelve.bin'].map(name => writeFile(join(cwd, name), '')));
  await truncate(join(cwd, 'sixteen.bin'), 16 * 1024 * 1024);
  await truncate(join(cwd, 'twenty.bin'), LIMITS.artifactBytes);
  await truncate(join(cwd, 'twelve.bin'), 12 * 1024 * 1024);
  await writeFile(join(cwd, 'one.bin'), Buffer.from([1]));
  const binary = { mediaType: 'application/octet-stream' };

  for (let index = 0; index < 4; index += 1) {
    await store.register(registration('full_request', `sixteen_${index}`, 'sixteen.bin', binary));
  }
  await assert.rejects(
    store.register(registration('full_request', 'request_overflow', 'one.bin', binary)),
    hasCode('artifact_capacity'),
  );

  for (let index = 0; index < 9; index += 1) {
    await store.register(registration(`twenty_request_${index}`, `twenty_${index}`, 'twenty.bin', binary));
  }
  await store.register(registration('twelve_request', 'twelve', 'twelve.bin', binary));
  await assert.rejects(
    store.register(registration('instance_overflow', 'one_more', 'one.bin', binary)),
    hasCode('artifact_capacity'),
  );
});

test('startup cleanup requires old private matching dead-owner evidence', async t => {
  const base = await mkdtemp(join(tmpdir(), 'omp-lan-orphans-'));
  const root = join(base, 'runtime');
  const cwd = join(base, 'work');
  await mkdir(root, { mode: 0o700 });
  await mkdir(cwd, { mode: 0o700 });
  const liveId = randomUUID();
  const live = new ArtifactStore({ root, cwd, instanceId: liveId });
  let second;
  t.after(async () => {
    await second?.close().catch(() => {});
    await live.close().catch(() => {});
    await rm(base, { recursive: true, force: true });
  });
  await live.init();
  const artifactsDirectory = join(root, 'artifacts');
  const oldMs = Date.now() - LIMITS.artifactTtlMs * 3;
  const old = new Date(oldMs);
  const deadPid = await runProcess(process.execPath, ['-e', '']);

  async function candidate(owner, mode = 0o600, makeOld = true) {
    const instanceId = randomUUID();
    const directory = join(artifactsDirectory, instanceId);
    await mkdir(directory, { mode: 0o700 });
    await writeFile(join(directory, 'abandoned.bin'), 'abandoned', { mode: 0o600 });
    if (owner !== undefined) {
      const contents = typeof owner === 'string' ? owner : JSON.stringify({ ...owner, instanceId: owner.instanceId ?? instanceId });
      await writeFile(join(directory, '.owner.json'), contents, { mode });
    }
    if (makeOld) await utimes(directory, old, old);
    return { instanceId, directory };
  }

  const removable = await candidate({ pid: deadPid, createdAt: oldMs });
  const missing = await candidate(undefined);
  const malformed = await candidate('{not json');
  const mismatched = await candidate({ instanceId: randomUUID(), pid: deadPid, createdAt: oldMs });
  const unreadable = await candidate({ pid: deadPid, createdAt: oldMs }, 0o000);
  const recent = await candidate({ pid: deadPid, createdAt: oldMs }, 0o600, false);

  await writeFile(join(artifactsDirectory, liveId, '.owner.json'), JSON.stringify({
    instanceId: liveId,
    pid: process.pid,
    createdAt: oldMs,
  }), { mode: 0o600 });
  await utimes(join(artifactsDirectory, liveId), old, old);

  second = new ArtifactStore({ root, cwd, instanceId: randomUUID() });
  await second.init();
  await assert.rejects(access(removable.directory), error => error.code === 'ENOENT');
  for (const preserved of [missing, malformed, mismatched, unreadable, recent]) await access(preserved.directory);
  await access(join(artifactsDirectory, liveId));

  await second.close();
  await live.close();
  for (const preserved of [missing, malformed, mismatched, unreadable, recent]) await access(preserved.directory);
  await assert.rejects(access(join(artifactsDirectory, liveId)), error => error.code === 'ENOENT');
});
