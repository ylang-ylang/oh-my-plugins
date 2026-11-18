import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { createMemoryClient, projectTagFor, readHindsightConfig } from './client.mjs';

const testToken = 'test-only-hindsight-token';

function homeFor(t) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'hindsight-test-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

function nativeConfig(home, config) {
  mkdirSync(path.join(home, '.pi/agent'), { recursive: true });
  writeFileSync(path.join(home, '.pi/agent/hindsight.json'), JSON.stringify(config));
}

function recordingClient(t, options = {}) {
  const calls = [];
  const home = homeFor(t);
  const client = createMemoryClient({
    home, cwd: path.join(home, 'Project-A'), env: { HINDSIGHT_API_TOKEN: testToken },
    fetchImpl: async (url, request) => {
      calls.push({ url, ...request, body: JSON.parse(request.body) });
      return Response.json({ results: [] });
    },
    ...options,
  });
  return { client, calls };
}

test('native URL config, environment precedence and plugin-owned bank default', t => {
  const home = homeFor(t);
  assert.equal(readHindsightConfig({ home, env: {} }).apiUrl, 'http://localhost:8888');
  nativeConfig(home, { apiUrl: 'http://127.0.0.1:9999///', bankId: 'not-native-policy', apiToken: 'not-a-supported-config-key' });
  const config = readHindsightConfig({ home, env: {} });
  assert.equal(config.apiUrl, 'http://127.0.0.1:9999');
  assert.equal(config.bankId, 'ylang-memory');
  assert.equal(config.apiToken, null);
  const overridden = readHindsightConfig({ home, env: {
    HINDSIGHT_API_URL: 'http://127.0.0.1:7777/', HINDSIGHT_BANK_ID: 'isolated-bank', HINDSIGHT_API_TOKEN: ` ${testToken} \n`,
  } });
  assert.equal(overridden.apiUrl, 'http://127.0.0.1:7777');
  assert.equal(overridden.bankId, 'isolated-bank');
  assert.equal(overridden.apiToken, testToken);
});

test('credentials use the private default file or explicit native token file', t => {
  const home = homeFor(t);
  mkdirSync(path.join(home, '.config/hindsight'), { recursive: true });
  const defaultFile = path.join(home, '.config/hindsight/truenas-20111.token');
  writeFileSync(defaultFile, `${testToken}\n`, { mode: 0o600 });
  assert.equal(readHindsightConfig({ home, env: {} }).credentialSource, defaultFile);
  writeFileSync(path.join(home, 'custom.token'), `custom-${testToken}\n`, { mode: 0o600 });
  assert.equal(readHindsightConfig({ home, env: { HINDSIGHT_API_TOKEN_FILE: '~/custom.token' } }).apiToken, `custom-${testToken}`);
  assert.equal(readHindsightConfig({ home, env: { HINDSIGHT_API_TOKEN: testToken, HINDSIGHT_API_TOKEN_FILE: '~/missing' } }).credentialSource, 'HINDSIGHT_API_TOKEN');
  writeFileSync(path.join(home, 'empty.token'), '\n');
  assert.throws(() => readHindsightConfig({ home, env: { HINDSIGHT_API_TOKEN_FILE: '~/empty.token' } }), /credential file is empty/);
});

test('project and global retains never share document IDs or project tags', async t => {
  const { client, calls } = recordingClient(t);
  await client.retain([{ content: 'Project fact' }, { content: 'Distilled preference', scope: 'global' }]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, 'PUT');
  assert.deepEqual(calls[0].body, {});
  const [project, personal] = calls[1].body.items;
  assert.deepEqual(project.tags, ['project:project-a']);
  assert.deepEqual(personal.tags, []);
  assert.notEqual(project.document_id, personal.document_id);
  assert.equal(calls[1].body.async, false);
  assert.equal(calls[1].headers.Authorization, `Bearer ${testToken}`);
});

test('recall bounds the query and restricts request scope to current project plus untagged memory', async t => {
  const { client, calls } = recordingClient(t);
  await client.recall('x'.repeat(1000));
  await client.recall('personal preferences', { personalOnly: true });
  assert.equal(calls.filter(call => call.method === 'PUT').length, 1);
  assert.equal(calls[1].body.query.length, 800);
  assert.deepEqual(calls[1].body.tags, ['project:project-a']);
  assert.equal(calls[1].body.tags_match, 'any');
  assert.deepEqual(calls[1].body.types, ['world', 'experience']);
  assert.deepEqual(calls[2].body.tags, []);
  assert.equal(calls[2].body.tags_match, 'exact');
});

test('missing credentials and invalid explicit inputs reject without network calls', async t => {
  const { client, calls } = recordingClient(t, { env: {} });
  assert.equal(client.available, false);
  await assert.rejects(client.recall('known fact'), /Hindsight is not connected/);
  await assert.rejects(client.retain([{ content: 'fact' }]), /Hindsight is not connected/);
  await assert.rejects(client.recall(' '), /Recall query must be nonempty/);
  await assert.rejects(client.retain([]), /at least one memory/);
  await assert.rejects(client.retain([{ content: ' ' }]), /content must be nonempty/);
  await assert.rejects(client.retain([{ content: 'fact', scope: 'other-project' }]), /scope must be project or global/);
  assert.equal(calls.length, 0);
});

test('explicit transport and HTTP failures redact credentials and do not retry', async t => {
  let calls = 0;
  const { client } = recordingClient(t, { fetchImpl: async () => {
    calls++;
    return new Response(`denied ${testToken}`, { status: 401 });
  } });
  await assert.rejects(client.recall('fact'), error => error.message === 'Hindsight HTTP 401: denied [redacted]');
  assert.equal(calls, 1);
  const { client: transport } = recordingClient(t, { fetchImpl: async () => { throw new Error(`failed ${testToken}`); } });
  await assert.rejects(transport.recall('fact'), error => error.message === 'Hindsight request failed: failed [redacted]');
});

test('linked worktrees share scope while unrelated repositories stay separate', t => {
  const home = homeFor(t);
  const primary = path.join(home, 'Primary');
  const linked = path.join(home, 'Other-Worktree');
  const unrelated = path.join(home, 'Unrelated');
  execFileSync('git', ['init', '--quiet', primary]);
  execFileSync('git', ['-C', primary, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'test fixture']);
  execFileSync('git', ['-C', primary, 'worktree', 'add', '--quiet', '-b', 'test-worktree', linked]);
  execFileSync('git', ['init', '--quiet', unrelated]);
  assert.equal(projectTagFor(linked), 'project:primary');
  assert.equal(projectTagFor(primary), 'project:primary');
  assert.equal(projectTagFor(unrelated), 'project:unrelated');
});
