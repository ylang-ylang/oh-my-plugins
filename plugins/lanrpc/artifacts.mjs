import { constants as fsConstants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rm,
  unlink,
} from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { LIMITS, UUID_PATTERN, failure, validateId } from './protocol.mjs';

const ARTIFACT_DIRECTORY = 'artifacts';
const OWNER_FILE = '.owner.json';
const COPY_BUFFER_BYTES = 64 * 1024;
const MAX_SOURCE_PATH_BYTES = 4096;
const MAX_TOOL_CALL_ID_BYTES = 512;
const MAX_MEDIA_TYPE_BYTES = 127;
const MAX_FILENAME_BYTES = 255;
const MAX_OWNER_BYTES = 4096;
const ORPHAN_RETENTION_MS = LIMITS.artifactTtlMs * 2;
const EXPIRY_SWEEP_MS = Math.min(60_000, LIMITS.artifactTtlMs);
const MEDIA_TYPE_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+\/[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

function protocolFailure(error) {
  return error && Number.isInteger(error.status) && typeof error.code === 'string';
}

function internalFailure(message = 'Artifact storage operation failed') {
  return failure(500, 'internal_error', message);
}

function invalidArtifact(message) {
  return failure(400, 'invalid_artifact', message);
}

function timestamp(now) {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw internalFailure('Artifact clock returned an invalid timestamp');
  }
  return value;
}

function currentUid() {
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

function assertOwned(stat) {
  const uid = currentUid();
  const owner = typeof stat.uid === 'bigint' ? Number(stat.uid) : stat.uid;
  if (uid !== undefined && owner !== uid) {
    throw internalFailure('Artifact storage is not owned by the current user');
  }
}

function assertPrivateDirectory(stat) {
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw internalFailure('Artifact storage must be a real private directory');
  }
  assertOwned(stat);
  if ((stat.mode & 0o777) !== 0o700) {
    throw internalFailure('Artifact storage directory permissions must be 0700');
  }
}

async function ensurePrivateDirectory(path, recursive) {
  const created = await mkdir(path, { recursive, mode: 0o700 });
  if (created !== undefined) await chmod(path, 0o700);
  const stat = await lstat(path);
  assertPrivateDirectory(stat);
  return stat;
}

async function writePrivateFileExclusive(path, contents) {
  let handle;
  try {
    handle = await open(
      path,
      fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_WRONLY |
        fsConstants.O_NOFOLLOW,
      0o600,
    );
    await handle.chmod(0o600);
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } finally {
    await handle?.close().catch(() => {});
  }
}
function isContained(root, path) {
  const child = relative(root, path);
  return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`));
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFingerprint(left, right) {
  return sameIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs;
}

function fingerprint(stat) {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeNs: stat.mtimeNs ?? stat.mtimeMs,
    ctimeNs: stat.ctimeNs ?? stat.ctimeMs,
  };
}

function cloneMetadata(metadata) {
  return { ...metadata };
}

function normalizeToolCallId(value) {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value) > MAX_TOOL_CALL_ID_BYTES || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw invalidArtifact('Artifact tool call identity is invalid');
  }
  return value;
}

function normalizePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || Buffer.byteLength(value) > MAX_SOURCE_PATH_BYTES) {
    throw invalidArtifact('Artifact path must be a non-empty filesystem path');
  }
  return value;
}

function normalizeName(value) {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value) > MAX_FILENAME_BYTES || value === '.' || value === '..' || /[\u0000-\u001f\u007f/\\]/u.test(value)) {
    throw invalidArtifact('Artifact name must be a single safe filename');
  }
  return value;
}

function normalizeMediaType(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > MAX_MEDIA_TYPE_BYTES || !MEDIA_TYPE_PATTERN.test(value)) {
    throw invalidArtifact('Artifact mediaType must be a valid media type without parameters');
  }
  return value;
}

function registrationDigest(candidate, name, mediaType) {
  return createHash('sha256').update(JSON.stringify([candidate, name, mediaType])).digest('hex');
}

function registrationKey(requestId, toolCallId) {
  return `${requestId}\0${toolCallId}`;
}

function artifactNotFound() {
  return failure(404, 'artifact_not_found', 'Artifact was not found for this request');
}

function artifactExpired() {
  return failure(410, 'artifact_expired', 'Artifact has expired');
}

function artifactConflict() {
  return failure(409, 'artifact_conflict', 'Artifact tool call was reused with a different registration');
}

function artifactCapacity(message) {
  return failure(429, 'artifact_capacity', message);
}

function artifactTooLarge() {
  return failure(413, 'artifact_too_large', 'Artifact exceeds the per-file size limit');
}

function artifactUnsupported() {
  return failure(501, 'host_unsupported', 'Secure artifact registration is unavailable on this host');
}

async function readOwnerFile(path, expectedInstanceId) {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_OWNER_BYTES || (stat.mode & 0o777) !== 0o600) return undefined;
    assertOwned(stat);
    const parsed = JSON.parse(await handle.readFile({ encoding: 'utf8' }));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
        Object.keys(parsed).sort().join(',') !== 'createdAt,instanceId,pid' ||
        parsed.instanceId !== expectedInstanceId || !UUID_PATTERN.test(parsed.instanceId) ||
        !Number.isSafeInteger(parsed.pid) || parsed.pid <= 0 ||
        !Number.isSafeInteger(parsed.createdAt) || parsed.createdAt < 0) {
      return undefined;
    }
    return { ...parsed, identity: fingerprint(stat) };
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function processState(pid) {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    if (error?.code === 'EPERM') return 'alive';
    if (error?.code === 'ESRCH') return 'dead';
    return 'unknown';
  }
}

export class ArtifactStore {
  #root;
  #cwd;
  #rootCanonical;
  #cwdCanonical;
  #rootIdentity;
  #cwdIdentity;
  #instanceId;
  #cwdHandle;
  #now;
  #artifactsDirectory;
  #instanceDirectory;
  #instanceIdentity;
  #records = new Map();
  #registrations = new Map();
  #requestUsage = new Map();
  #instanceBytes = 0;
  #initPromise;
  #initialized = false;
  #closed = false;
  #registrationSupported = false;
  #tail = Promise.resolve();
  #expiryTimer;

  constructor({ root, instanceId, cwd, now = Date.now }) {
    if (typeof root !== 'string' || !isAbsolute(root)) {
      throw new TypeError('ArtifactStore root must be an absolute path');
    }
    if (typeof cwd !== 'string' || !isAbsolute(cwd)) {
      throw new TypeError('ArtifactStore cwd must be an absolute path');
    }
    if (!UUID_PATTERN.test(instanceId ?? '')) {
      throw new TypeError('ArtifactStore instanceId must be a UUID');
    }
    if (typeof now !== 'function') {
      throw new TypeError('ArtifactStore now must be a function');
    }

    this.#root = resolve(root);
    this.#cwd = resolve(cwd);
    this.#instanceId = instanceId;
    this.#now = now;
    this.#artifactsDirectory = join(this.#root, ARTIFACT_DIRECTORY);
    this.#instanceDirectory = join(this.#artifactsDirectory, instanceId);
  }

  get registrationSupported() {
    return this.#initialized && !this.#closed && this.#registrationSupported;
  }

  async init() {
    if (this.#closed) throw internalFailure('Artifact store is closed');
    if (this.#initialized) return;
    if (!this.#initPromise) {
      this.#initPromise = this.#initialize().catch(error => {
        this.#initPromise = undefined;
        throw protocolFailure(error) ? error : internalFailure('Artifact storage initialization failed');
      });
    }
    await this.#initPromise;
  }

  async #initialize() {
    let createdInstance = false;
    try {
      await ensurePrivateDirectory(this.#root, true);
      await ensurePrivateDirectory(this.#artifactsDirectory, true);
      this.#rootCanonical = await realpath(this.#root);
      const rootStat = await lstat(this.#rootCanonical, { bigint: true });
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw internalFailure('Artifact runtime root is unavailable');
      this.#rootIdentity = fingerprint(rootStat);

      if (process.platform === 'linux') {
        try {
          const cwdCanonical = await realpath(this.#cwd);
          this.#cwdHandle = await open(cwdCanonical, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
          const cwdStat = await this.#cwdHandle.stat({ bigint: true });
          if (!cwdStat.isDirectory()) throw new Error('cwd is not a directory');
          const descriptorPath = await realpath(`/proc/self/fd/${this.#cwdHandle.fd}`);
          if (descriptorPath !== cwdCanonical) throw new Error('ambiguous cwd descriptor');
          this.#cwdCanonical = cwdCanonical;
          this.#cwdIdentity = fingerprint(cwdStat);
          this.#registrationSupported = true;
        } catch {
          await this.#cwdHandle?.close().catch(() => {});
          this.#cwdHandle = undefined;
          this.#registrationSupported = false;
        }
      }

      await this.#cleanupOrphans(timestamp(this.#now));
      await mkdir(this.#instanceDirectory, { mode: 0o700 });
      createdInstance = true;
      await chmod(this.#instanceDirectory, 0o700);
      const instanceStat = await lstat(this.#instanceDirectory);
      assertPrivateDirectory(instanceStat);
      this.#instanceIdentity = { dev: instanceStat.dev, ino: instanceStat.ino };

      const owner = `${JSON.stringify({
        instanceId: this.#instanceId,
        pid: process.pid,
        createdAt: timestamp(this.#now),
      })}\n`;
      await writePrivateFileExclusive(join(this.#instanceDirectory, OWNER_FILE), owner);
      this.#initialized = true;
      this.#expiryTimer = setInterval(() => {
        this.expire().catch(() => {});
      }, EXPIRY_SWEEP_MS);
      this.#expiryTimer.unref?.();
    } catch (error) {
      if (createdInstance) await rm(this.#instanceDirectory, { recursive: true, force: true }).catch(() => {});
      await this.#cwdHandle?.close().catch(() => {});
      this.#cwdHandle = undefined;
      throw error;
    }
  }

  async #cleanupOrphans(now) {
    const entries = await readdir(this.#artifactsDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !UUID_PATTERN.test(entry.name)) continue;
      const path = join(this.#artifactsDirectory, entry.name);
      try {
        const before = await lstat(path);
        assertPrivateDirectory(before);
        if (now - before.mtimeMs < ORPHAN_RETENTION_MS) continue;

        const owner = await readOwnerFile(join(path, OWNER_FILE), entry.name);
        if (!owner || now - owner.createdAt < ORPHAN_RETENTION_MS || processState(owner.pid) !== 'dead') continue;

        const after = await lstat(path);
        if (!after.isDirectory() || after.isSymbolicLink() || !sameFingerprint(fingerprint(before), fingerprint(after))) continue;
        const currentOwner = await readOwnerFile(join(path, OWNER_FILE), entry.name);
        if (!currentOwner || currentOwner.pid !== owner.pid || currentOwner.createdAt !== owner.createdAt ||
            !sameFingerprint(currentOwner.identity, owner.identity) || processState(currentOwner.pid) !== 'dead') continue;
        await rm(path, { recursive: true, force: false });
      } catch {
        // Missing or uncertain ownership evidence always preserves the store.
      }
    }
  }

  #assertReady() {
    if (!this.#initialized) throw internalFailure('Artifact store is not initialized');
    if (this.#closed) throw internalFailure('Artifact store is closed');
  }

  async #exclusive(operation) {
    const previous = this.#tail;
    let release;
    this.#tail = new Promise(resolvePromise => {
      release = resolvePromise;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async #assertInstanceDirectory() {
    const stat = await lstat(this.#instanceDirectory);
    assertPrivateDirectory(stat);
    if (!sameIdentity(stat, this.#instanceIdentity)) {
      throw internalFailure('Artifact storage directory changed unexpectedly');
    }
  }

  async #openSource(candidate) {
    let handle;
    let directoryHandle = this.#cwdHandle;
    let ownsDirectoryHandle = false;
    try {
      const lexicalPath = relative(this.#cwd, candidate);
      if (lexicalPath === '' || isAbsolute(lexicalPath) || lexicalPath === '..' || lexicalPath.startsWith(`..${sep}`)) {
        throw invalidArtifact('Artifact source is outside the request working directory');
      }

      const cwdStat = await this.#cwdHandle.stat({ bigint: true });
      if (!cwdStat.isDirectory() || !sameIdentity(cwdStat, this.#cwdIdentity) || sameIdentity(cwdStat, this.#rootIdentity)) {
        throw invalidArtifact('Artifact source is outside the permitted request working tree');
      }

      const components = lexicalPath.split(sep);
      for (const component of components.slice(0, -1)) {
        const next = await open(
          join('/proc/self/fd', String(directoryHandle.fd), component),
          fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
        );
        let nextStat;
        try {
          nextStat = await next.stat({ bigint: true });
          if (!nextStat.isDirectory() || sameIdentity(nextStat, this.#rootIdentity)) {
            throw invalidArtifact('Artifact source is outside the permitted request working tree');
          }
        } catch (error) {
          await next.close().catch(() => {});
          throw error;
        }
        if (ownsDirectoryHandle) await directoryHandle.close();
        directoryHandle = next;
        ownsDirectoryHandle = true;
      }

      handle = await open(
        join('/proc/self/fd', String(directoryHandle.fd), components.at(-1)),
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
      );
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile()) throw invalidArtifact('Artifact source must be a regular file');

      const descriptorPath = await realpath(`/proc/self/fd/${handle.fd}`);
      if (!isContained(this.#cwdCanonical, descriptorPath) || isContained(this.#rootCanonical, descriptorPath)) {
        throw invalidArtifact('Artifact source is outside the permitted request working tree');
      }
      return { handle, stat: opened };
    } catch (error) {
      await handle?.close().catch(() => {});
      if (protocolFailure(error)) throw error;
      throw invalidArtifact('Artifact source is not an accessible regular file inside the request working directory');
    } finally {
      if (ownsDirectoryHandle) await directoryHandle.close().catch(() => {});
    }
  }

  async #readSource(source, destination, requestBytes, enforceCapacity) {
    const initial = source.stat;
    if (initial.size > BigInt(LIMITS.artifactBytes)) throw artifactTooLarge();
    if (enforceCapacity) {
      const sourceSize = Number(initial.size);
      if (requestBytes + sourceSize > LIMITS.requestArtifactBytes) throw artifactCapacity('Request artifact byte capacity exceeded');
      if (this.#instanceBytes + sourceSize > LIMITS.instanceArtifactBytes) throw artifactCapacity('Instance artifact byte capacity exceeded');
    }

    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    let size = 0;
    let destinationPosition = 0;
    while (true) {
      let bytesRead;
      try {
        ({ bytesRead } = await source.handle.read(buffer, 0, buffer.length, null));
      } catch {
        throw invalidArtifact('Artifact source could not be read safely');
      }
      if (bytesRead === 0) break;

      const nextSize = size + bytesRead;
      if (nextSize > LIMITS.artifactBytes) throw artifactTooLarge();
      if (enforceCapacity && requestBytes + nextSize > LIMITS.requestArtifactBytes) throw artifactCapacity('Request artifact byte capacity exceeded');
      if (enforceCapacity && this.#instanceBytes + nextSize > LIMITS.instanceArtifactBytes) throw artifactCapacity('Instance artifact byte capacity exceeded');
      hash.update(buffer.subarray(0, bytesRead));

      if (destination) {
        let offset = 0;
        while (offset < bytesRead) {
          const { bytesWritten } = await destination.write(buffer, offset, bytesRead - offset, destinationPosition + offset);
          if (bytesWritten === 0) throw internalFailure();
          offset += bytesWritten;
        }
        destinationPosition += bytesRead;
      }
      size = nextSize;
    }

    let final;
    try {
      final = await source.handle.stat({ bigint: true });
    } catch {
      throw invalidArtifact('Artifact source changed during registration');
    }
    if (!final.isFile() || !sameFingerprint(initial, final)) {
      throw invalidArtifact('Artifact source changed during registration');
    }
    return { size, sha256: hash.digest('hex'), sourceFingerprint: fingerprint(final) };
  }

  async register({ requestId, toolCallId, path, name, mediaType }) {
    await this.init();
    if (!this.#registrationSupported) throw artifactUnsupported();
    try {
      validateId(requestId);
      normalizeToolCallId(toolCallId);
      const sourcePath = normalizePath(path);
      const candidate = resolve(this.#cwd, sourcePath);
      const artifactName = normalizeName(name ?? basename(candidate));
      const artifactMediaType = normalizeMediaType(mediaType);
      const digest = registrationDigest(candidate, artifactName, artifactMediaType);
      const key = registrationKey(requestId, toolCallId);

      return await this.#exclusive(async () => {
        this.#assertReady();
        await this.#assertInstanceDirectory();
        const createdAt = timestamp(this.#now);
        await this.#expireAt(createdAt);

        const registration = this.#registrations.get(key);
        if (registration) {
          if (registration.digest !== digest) throw artifactConflict();
          if (!registration.record.active) return cloneMetadata(registration.record.metadata);

          let source;
          try {
            source = await this.#openSource(candidate);
            const currentFingerprint = fingerprint(source.stat);
            if (sameFingerprint(currentFingerprint, registration.sourceFingerprint)) {
              return cloneMetadata(registration.record.metadata);
            }
            const current = await this.#readSource(source, undefined, 0, false);
            if (current.size !== registration.record.metadata.size || current.sha256 !== registration.record.metadata.sha256) throw artifactConflict();
            registration.sourceFingerprint = current.sourceFingerprint;
            return cloneMetadata(registration.record.metadata);
          } catch (error) {
            if (error?.code === 'artifact_conflict') throw error;
            throw artifactConflict();
          } finally {
            await source?.handle.close().catch(() => {});
          }
        }

        const usage = this.#requestUsage.get(requestId) ?? { count: 0, bytes: 0 };
        if (usage.count >= LIMITS.artifacts) throw artifactCapacity('Request artifact count capacity exceeded');

        const artifactId = randomUUID();
        const snapshotPath = join(this.#instanceDirectory, `${artifactId}.bin`);
        let source;
        let destination;
        let committed = false;
        try {
          source = await this.#openSource(candidate);
          destination = await open(
            snapshotPath,
            fsConstants.O_CREAT |
              fsConstants.O_EXCL |
              fsConstants.O_WRONLY |
              fsConstants.O_NOFOLLOW,
            0o600,
          );
          await destination.chmod(0o600);
          const copied = await this.#readSource(source, destination, usage.bytes, true);
          await destination.sync();
          const snapshotStat = await destination.stat({ bigint: true });
          if (!snapshotStat.isFile() || snapshotStat.size !== BigInt(copied.size)) throw internalFailure();
          await destination.close();
          destination = undefined;

          const metadata = Object.freeze({
            artifactId,
            name: artifactName,
            mediaType: artifactMediaType,
            size: copied.size,
            sha256: copied.sha256,
            createdAt,
            expiresAt: createdAt + LIMITS.artifactTtlMs,
          });
          const record = {
            requestId,
            metadata,
            path: snapshotPath,
            identity: fingerprint(snapshotStat),
            active: true,
            deleted: false,
            accounted: true,
          };
          this.#records.set(artifactId, record);
          this.#registrations.set(key, { digest, record, sourceFingerprint: copied.sourceFingerprint });
          this.#requestUsage.set(requestId, { count: usage.count + 1, bytes: usage.bytes + copied.size });
          this.#instanceBytes += copied.size;
          committed = true;
          return cloneMetadata(metadata);
        } finally {
          await source?.handle.close().catch(() => {});
          await destination?.close().catch(() => {});
          if (!committed) await unlink(snapshotPath).catch(() => {});
        }
      });
    } catch (error) {
      if (protocolFailure(error)) throw error;
      throw internalFailure();
    }
  }

  list({ requestId }) {
    this.#assertReady();
    validateId(requestId);
    const now = timestamp(this.#now);
    const artifacts = [];
    for (const record of this.#records.values()) {
      if (record.requestId === requestId && record.active && record.metadata.expiresAt > now) {
        artifacts.push(cloneMetadata(record.metadata));
      }
    }
    return artifacts;
  }

  async open({ requestId, artifactId }) {
    await this.init();
    try {
      validateId(requestId);
      if (typeof artifactId !== 'string') throw artifactNotFound();
      return await this.#exclusive(async () => {
        this.#assertReady();
        await this.#assertInstanceDirectory();
        await this.#expireAt(timestamp(this.#now));
        const record = this.#records.get(artifactId);
        if (!record || record.requestId !== requestId) throw artifactNotFound();
        if (!record.active || record.deleted) throw artifactExpired();

        let handle;
        try {
          handle = await open(record.path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
          const stat = await handle.stat({ bigint: true });
          if (!stat.isFile() || !sameFingerprint(stat, record.identity) || stat.size !== BigInt(record.metadata.size) || (Number(stat.mode) & 0o777) !== 0o600) {
            throw artifactExpired();
          }
          return { metadata: cloneMetadata(record.metadata), handle };
        } catch (error) {
          await handle?.close().catch(() => {});
          if (error?.code === 'artifact_expired') {
            this.#deactivate(record);
            await this.#deleteSnapshot(record);
            throw error;
          }
          if (protocolFailure(error)) throw error;
          this.#deactivate(record);
          await this.#deleteSnapshot(record);
          throw artifactExpired();
        }
      });
    } catch (error) {
      if (protocolFailure(error)) throw error;
      throw internalFailure();
    }
  }

  #deactivate(record) {
    record.active = false;
  }

  #releaseUsage(record) {
    if (!record.accounted) return;
    record.accounted = false;
    const usage = this.#requestUsage.get(record.requestId);
    if (usage) {
      const count = usage.count - 1;
      const bytes = usage.bytes - record.metadata.size;
      if (count === 0 && bytes === 0) this.#requestUsage.delete(record.requestId);
      else this.#requestUsage.set(record.requestId, { count, bytes });
    }
    this.#instanceBytes -= record.metadata.size;
  }

  async #deleteSnapshot(record) {
    if (record.deleted) return;
    try {
      await unlink(record.path);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    record.deleted = true;
    this.#releaseUsage(record);
  }

  async #expireAt(now) {
    for (const record of this.#records.values()) {
      if (record.active && record.metadata.expiresAt <= now) this.#deactivate(record);
      if (!record.active && !record.deleted) await this.#deleteSnapshot(record);
    }
  }

  async expire() {
    await this.init();
    try {
      await this.#exclusive(async () => {
        this.#assertReady();
        await this.#assertInstanceDirectory();
        await this.#expireAt(timestamp(this.#now));
      });
    } catch (error) {
      if (protocolFailure(error)) throw error;
      throw internalFailure();
    }
  }

  async close() {
    if (this.#closed) return;
    if (!this.#initPromise && !this.#initialized) {
      this.#closed = true;
      return;
    }
    await this.#initPromise;
    clearInterval(this.#expiryTimer);
    this.#expiryTimer = undefined;
    try {
      await this.#exclusive(async () => {
        if (this.#closed) return;
        try {
          await this.#assertInstanceDirectory();
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
          await this.#cwdHandle?.close();
          this.#cwdHandle = undefined;
          this.#closed = true;
          return;
        }
        await rm(this.#instanceDirectory, { recursive: true, force: true });
        await this.#cwdHandle?.close();
        this.#cwdHandle = undefined;
        this.#closed = true;
      });
    } catch (error) {
      if (protocolFailure(error)) throw error;
      throw internalFailure('Artifact storage cleanup failed');
    }
  }
}
