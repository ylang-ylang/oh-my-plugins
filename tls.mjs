import { execFile } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { chmod, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createSecureContext } from 'node:tls';
import { promisify } from 'node:util';
import { assertExistingPrivateRoot, ensurePrivateRoot, readPrivateFile, rootDir } from './config.mjs';

const execute = promisify(execFile);

async function loadTls(config, directory) {
  const certFile = directory ? join(directory, 'cert.pem') : config.tlsCert;
  const keyFile = directory ? join(directory, 'key.pem') : config.tlsKey;
  const [cert, key] = directory
    ? await Promise.all([readPrivateFile(certFile, 64 * 1024), readPrivateFile(keyFile, 64 * 1024)])
    : await Promise.all([readFile(certFile), readFile(keyFile)]);
  createSecureContext({ cert, key });
  const certificate = new X509Certificate(cert);
  if (!certificate.checkIP(config.host)) {
    throw new Error('The TLS certificate IP SAN does not match the bind IP. Use a certificate valid for that IP.');
  }
  const now = Date.now();
  if (Date.parse(certificate.validFrom) > now || Date.parse(certificate.validTo) <= now) {
    throw new Error(`TLS certificate is not currently valid: ${certFile}. Replace the custom certificate, or remove this managed certificate directory to regenerate it.`);
  }
  return { cert, key, certFile };
}

// HTTP exits before touching TLS paths. Explicit custom paths are never overwritten.
export async function prepareTls(config) {
  if (config.protocol !== 'https') return undefined;
  if (config.tlsCert) return loadTls(config);

  const root = rootDir();
  await ensurePrivateRoot(root);
  const tlsRoot = join(root, 'tls');
  await ensurePrivateRoot(tlsRoot);
  const directory = join(tlsRoot, createHash('sha256').update(config.host).digest('hex'));
  if (await assertExistingPrivateRoot(directory)) return loadTls(config, directory);

  // Publish the entire pair atomically. Concurrent sessions reuse the winner's
  // certificate, so a listener restart never silently changes client trust.
  const temporary = await mkdtemp(join(tlsRoot, '.generate-'));
  try {
    await chmod(temporary, 0o700);
    try {
      await execute('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256',
        '-days', '3650', '-subj', '/CN=OMP LAN RPC', '-addext', `subjectAltName=IP:${config.host}`,
        '-addext', 'extendedKeyUsage=serverAuth',
        '-keyout', join(temporary, 'key.pem'), '-out', join(temporary, 'cert.pem')],
      { timeout: 30_000, maxBuffer: 64 * 1024 });
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error('OpenSSL is required for automatic HTTPS certificates. Install it with apt install openssl (Debian/Ubuntu) or brew install openssl (macOS), then retry. Alternatively configure --tls-cert and --tls-key.');
      }
      throw new Error('OpenSSL could not generate the HTTPS certificate. Check that OpenSSL supports req -addext and that the private runtime directory is writable.', { cause: error });
    }
    await Promise.all(['cert.pem', 'key.pem'].map(name => chmod(join(temporary, name), 0o600)));
    await loadTls(config, temporary);
    try {
      await rename(temporary, directory);
    } catch (error) {
      if (error.code !== 'EEXIST' && error.code !== 'ENOTEMPTY') throw error;
    }
    await assertExistingPrivateRoot(directory);
    return await loadTls(config, directory);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
