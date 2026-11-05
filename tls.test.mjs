import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdtemp, readdir, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import { prepareTls } from './tls.mjs';
import { startServer } from './server.mjs';
import { writeConfig } from './config.mjs';
import { transportController } from './test-support.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'omp-managed-tls-'));
  const previous = process.env.OMP_LAN_RPC_DIR;
  process.env.OMP_LAN_RPC_DIR = root;
  t.after(async () => {
    if (previous === undefined) delete process.env.OMP_LAN_RPC_DIR;
    else process.env.OMP_LAN_RPC_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

test('managed HTTPS has a matching SAN, private files, stable restart trust, and IP-specific certificates', async t => {
  const root = await fixture(t);
  const config = { host: '127.0.0.1', port: 0, protocol: 'https' };
  await writeConfig(config);
  const first = await startServer({ controller: await transportController(t, root, 'tls') });
  const certFile = first.certFile;
  const certificate = new X509Certificate(await readFile(certFile));
  const originalToken = first.token;
  await first.close();
  const second = await startServer({ controller: await transportController(t, root, 'tls') });
  try {
    assert.equal(new X509Certificate(await readFile(second.certFile)).fingerprint256, certificate.fingerprint256);
    assert.ok(second.token !== originalToken);
    assert.equal(certificate.checkIP('127.0.0.1'), '127.0.0.1');
    assert.equal(certificate.checkIP('127.0.0.2'), undefined);
    assert.equal((await lstat(join(root, 'tls'))).mode & 0o777, 0o700);
    assert.equal((await lstat(dirname(certFile))).mode & 0o777, 0o700);
    assert.equal((await lstat(join(dirname(certFile), 'key.pem'))).mode & 0o777, 0o600);
    assert.equal((await lstat(certFile)).mode & 0o777, 0o600);
    const other = await prepareTls({ ...config, host: '127.0.0.2' });
    assert.equal(new X509Certificate(other.cert).checkIP('127.0.0.2'), '127.0.0.2');
    assert.notEqual(other.certFile, certFile);
  } finally { await second.close(); }
});

test('concurrent starts publish one certificate and refuse symlinks or exposed private keys', async t => {
  const root = await fixture(t);
  const config = { host: '::1', protocol: 'https' };
  const pair = await Promise.all([prepareTls(config), prepareTls(config)]);
  assert.equal(new X509Certificate(pair[0].cert).fingerprint256, new X509Certificate(pair[1].cert).fingerprint256);
  assert.equal(new X509Certificate(pair[0].cert).checkIP('::1'), '::1');
  assert.equal((await readdir(join(root, 'tls'))).some(name => name.startsWith('.generate-')), false);
  const key = join(dirname(pair[0].certFile), 'key.pem');
  await chmod(key, 0o644);
  await assert.rejects(prepareTls(config), /inaccessible to group and others/);
  await chmod(key, 0o600);
  const cert = pair[0].certFile;
  const originalKey = await readFile(key);
  await rm(cert);
  await symlink(key, cert);
  await assert.rejects(prepareTls(config), /not a symlink/);
  assert.ok((await readFile(key)).equals(originalKey));
});

test('HTTP never creates TLS state and missing OpenSSL has an actionable error', async t => {
  const root = await fixture(t);
  await prepareTls({ host: '127.0.0.1', protocol: 'http', tlsCert: '/missing', tlsKey: '/missing' });
  assert.deepEqual(await readdir(root), []);
  const previousPath = process.env.PATH;
  process.env.PATH = root;
  try {
    await assert.rejects(prepareTls({ host: '127.0.0.1', protocol: 'https' }), /Install it with apt install openssl/);
    assert.deepEqual(await readdir(join(root, 'tls')), []);
  } finally { process.env.PATH = previousPath; }
});
