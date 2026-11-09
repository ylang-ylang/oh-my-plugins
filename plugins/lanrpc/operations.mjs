import {
  constants,
  chmodSync,
  closeSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

const COMPONENT = 'omp-lan-rpc';
const MAX_BYTES = 10 * 1024 * 1024;
const BACKUPS = 5;
const RETIRED_FAMILIES = 8;
const EVENT_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
const LOG_PATTERN = /^operations-([1-9][0-9]*)\.jsonl(?:\.([1-5]))?$/;
const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/;
const ID_FIELDS = new Set([
  'requestId',
  'messageId',
  'chatId',
  'sessionId',
  'instanceId',
  'toolCallId',
  'artifactId',
]);
const TOKEN_FIELDS = new Set([
  'operation',
  'state',
  'reason',
  'errorCode',
  'errorType',
  'toolName',
]);
const NUMBER_FIELDS = new Set([
  'generation',
  'durationMs',
  'exitCode',
  'stdoutBytes',
  'stderrBytes',
]);
const DIAGNOSTICS = new Set([
  'ssh_host_key_untrusted',
  'ssh_host_key_changed',
  'ssh_authentication_failed',
  'ssh_connection_failed',
  'ssh_remote_command_failed',
]);

function currentUid() {
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

function assertOwned(stat, path) {
  const uid = currentUid();
  if (uid !== undefined && stat.uid !== uid) throw new Error(`${path} must be owned by the current user`);
}

function ensurePrivateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${path} must be a real directory, not a symlink`);
  }
  assertOwned(stat, path);
  if ((stat.mode & 0o777) !== 0o700) chmodSync(path, 0o700);
}

function boundedIdentifier(value) {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, '');
  if (clean.length === 0) return undefined;
  return clean.length <= 256 ? clean : clean.slice(0, 256);
}

function safeToken(value) {
  return typeof value === 'string' && TOKEN_PATTERN.test(value) ? value : undefined;
}

function safeNumber(field, value) {
  if (!Number.isSafeInteger(value)) return undefined;
  if (field !== 'exitCode' && value < 0) return undefined;
  return value;
}

function sanitize(fields) {
  const result = {};
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) return result;
  for (const [field, value] of Object.entries(fields)) {
    if (ID_FIELDS.has(field)) {
      const safe = boundedIdentifier(value);
      if (safe !== undefined) result[field] = safe;
    } else if (TOKEN_FIELDS.has(field)) {
      const safe = safeToken(value);
      if (safe !== undefined) result[field] = safe;
    } else if (NUMBER_FIELDS.has(field)) {
      const safe = safeNumber(field, value);
      if (safe !== undefined) result[field] = safe;
    } else if (field === 'diagnostic' && DIAGNOSTICS.has(value)) {
      result.diagnostic = value;
    }
  }
  return result;
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function safeUnlink(path) {
  try { unlinkSync(path); } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function safeRename(from, to) {
  try { renameSync(from, to); } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function pruneRetiredFamilies(directory) {
  const families = new Map();
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    const match = LOG_PATTERN.exec(entry.name);
    if (!match) continue;
    const pid = Number(match[1]);
    const path = join(directory, entry.name);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) continue;
    assertOwned(stat, path);
    const family = families.get(pid) ?? { pid, modifiedAt: 0, paths: [] };
    family.modifiedAt = Math.max(family.modifiedAt, stat.mtimeMs);
    family.paths.push(path);
    families.set(pid, family);
  }
  const retired = [...families.values()]
    .filter(family => family.pid !== process.pid && !processAlive(family.pid))
    .sort((left, right) => right.modifiedAt - left.modifiedAt);
  for (const family of retired.slice(RETIRED_FAMILIES)) {
    for (const path of family.paths) safeUnlink(path);
  }
}

export const NOOP_OPERATIONS = Object.freeze({
  emit() { return false; },
});

export class OperationsLog {
  #directory;
  #path;
  #lastError;

  constructor(root) {
    if (typeof root !== 'string' || root.length === 0) throw new TypeError('operations log root is required');
    this.#directory = join(root, 'logs');
    this.#path = join(this.#directory, `operations-${process.pid}.jsonl`);
    try {
      ensurePrivateDirectory(root);
      ensurePrivateDirectory(this.#directory);
      pruneRetiredFamilies(this.#directory);
    } catch (error) {
      this.#lastError = error;
    }
  }

  get path() { return this.#path; }
  get lastError() { return this.#lastError; }

  #fallback(record, error) {
    const failure = {
      timestamp: new Date().toISOString(),
      component: COMPONENT,
      pid: process.pid,
      event: 'logging.write_failed',
      state: 'failed',
      reason: 'operations_log_failed',
      errorCode: safeToken(error?.code) ?? 'operations_log_failed',
      errorType: safeToken(error?.name) ?? 'Error',
      operation: record.event,
    };
    try {
      process.stderr.write(`${JSON.stringify(record)}\n${JSON.stringify(failure)}\n`);
    } catch {
      // Logging is best-effort and must not alter the operation it describes.
    }
  }

  #rotate(bytes) {
    let size = 0;
    try { size = statSync(this.#path).size; } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (size === 0 || size + bytes <= MAX_BYTES) return;
    safeUnlink(`${this.#path}.${BACKUPS}`);
    for (let index = BACKUPS - 1; index >= 1; index -= 1) {
      safeRename(`${this.#path}.${index}`, `${this.#path}.${index + 1}`);
    }
    safeRename(this.#path, `${this.#path}.1`);
    pruneRetiredFamilies(this.#directory);
  }

  emit(event, fields = undefined) {
    if (typeof event !== 'string' || !EVENT_PATTERN.test(event)) return false;
    const record = {
      timestamp: new Date().toISOString(),
      component: COMPONENT,
      pid: process.pid,
      event,
      ...sanitize(fields),
    };
    const line = `${JSON.stringify(record)}\n`;
    const bytes = Buffer.byteLength(line, 'utf8');
    try {
      ensurePrivateDirectory(this.#directory);
      this.#rotate(bytes);
      const fd = openSync(
        this.#path,
        constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile()) throw new Error(`${this.#path} must be a regular file`);
        assertOwned(stat, this.#path);
        if ((stat.mode & 0o777) !== 0o600) fchmodSync(fd, 0o600);
        writeSync(fd, line, undefined, 'utf8');
      } finally {
        closeSync(fd);
      }
      this.#lastError = undefined;
      return true;
    } catch (error) {
      this.#lastError = error;
      this.#fallback(record, error);
      return false;
    }
  }
}
