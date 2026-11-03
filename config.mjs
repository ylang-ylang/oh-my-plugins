import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  rename,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { BlockList, isIP } from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";

const CONFIG_FILENAME = "config.json";
const MAX_CONFIG_BYTES = 64 * 1024;
const DEFAULT_CONFIG = Object.freeze({ host: "127.0.0.1", port: 0 });
const CONFIG_KEYS = new Set(["host", "port", "tlsCert", "tlsKey"]);
const LOOPBACKS = new BlockList();
LOOPBACKS.addSubnet("127.0.0.0", 8, "ipv4");
LOOPBACKS.addAddress("::1", "ipv6");

export function rootDir() {
  const configured = process.env.OMP_LAN_RPC_DIR;
  return resolve(configured && configured.length > 0
    ? configured
    : join(homedir(), ".omp", "lan-rpc"));
}

function currentUid() {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function assertOwned(stat, path) {
  const uid = currentUid();
  if (uid !== undefined && stat.uid !== uid) {
    throw new Error(`${path} must be owned by the current user`);
  }
}

function assertPrivateDirectoryStat(stat, path) {
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${path} must be a real directory, not a symlink`);
  }
  assertOwned(stat, path);
  if ((stat.mode & 0o777) !== 0o700) {
    throw new Error(`${path} must have mode 0700`);
  }
}

function assertPrivateFileStat(stat, path) {
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${path} must be a regular file, not a symlink`);
  }
  assertOwned(stat, path);
  const mode = stat.mode & 0o777;
  if ((mode & 0o400) === 0 || (mode & 0o177) !== 0) {
    throw new Error(`${path} must be owner-readable and inaccessible to group and others`);
  }
}

async function existingStat(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

export async function assertExistingPrivateRoot(path) {
  const stat = await existingStat(path);
  if (stat === undefined) return false;
  assertPrivateDirectoryStat(stat, path);
  return true;
}

async function ensurePrivateRoot(path) {
  const created = await mkdir(path, { recursive: true, mode: 0o700 });
  if (created !== undefined) await chmod(path, 0o700);
  assertPrivateDirectoryStat(await lstat(path), path);
}

export async function readPrivateFile(path, maxBytes) {
  const before = await lstat(path);
  assertPrivateFileStat(before, path);
  if (before.size > maxBytes) {
    throw new Error(`${path} is too large`);
  }

  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const after = await handle.stat();
    assertPrivateFileStat(after, path);
    if (after.dev !== before.dev || after.ino !== before.ino) {
      throw new Error(`${path} changed while it was being opened`);
    }
    if (after.size > maxBytes) {
      throw new Error(`${path} is too large`);
    }
    return await handle.readFile({ encoding: "utf8" });
  } finally {
    await handle.close();
  }
}

function isLoopback(host) {
  const family = isIP(host);
  return family !== 0 && LOOPBACKS.check(host, family === 4 ? "ipv4" : "ipv6");
}

function validateConfig(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("config must be a JSON object");
  }

  for (const key of Object.keys(value)) {
    if (!CONFIG_KEYS.has(key)) {
      throw new TypeError(`unknown config field: ${key}`);
    }
  }

  const host = value.host ?? DEFAULT_CONFIG.host;
  const port = value.port ?? DEFAULT_CONFIG.port;
  if (typeof host !== "string" || isIP(host) === 0) {
    throw new TypeError("config.host must be an IPv4 or IPv6 address literal");
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new TypeError("config.port must be an integer from 0 through 65535");
  }

  const hasCert = value.tlsCert !== undefined;
  const hasKey = value.tlsKey !== undefined;
  if (hasCert !== hasKey) {
    throw new TypeError("config.tlsCert and config.tlsKey must be provided together");
  }

  const normalized = { host, port };
  if (hasCert) {
    if (typeof value.tlsCert !== "string" || value.tlsCert.length === 0) {
      throw new TypeError("config.tlsCert must be a non-empty path");
    }
    if (typeof value.tlsKey !== "string" || value.tlsKey.length === 0) {
      throw new TypeError("config.tlsKey must be a non-empty path");
    }
    if (!isAbsolute(value.tlsCert) || !isAbsolute(value.tlsKey)) {
      throw new TypeError("config TLS paths must be absolute; use the CLI config command to resolve relative paths");
    }
    normalized.tlsCert = value.tlsCert;
    normalized.tlsKey = value.tlsKey;
  }

  if (!isLoopback(host) && !hasCert) {
    throw new TypeError("TLS certificate and key are required for a non-loopback host");
  }

  return normalized;
}

export async function readConfig() {
  const directory = rootDir();
  if (!(await assertExistingPrivateRoot(directory))) {
    return { ...DEFAULT_CONFIG };
  }

  const path = join(directory, CONFIG_FILENAME);
  if ((await existingStat(path)) === undefined) {
    return { ...DEFAULT_CONFIG };
  }

  const source = await readPrivateFile(path, MAX_CONFIG_BYTES);
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error(`${path} does not contain valid JSON`);
  }
  return validateConfig(parsed);
}

export async function writeConfig(config) {
  const normalized = validateConfig(config);
  const directory = rootDir();
  await ensurePrivateRoot(directory);

  const path = join(directory, CONFIG_FILENAME);
  const existing = await existingStat(path);
  if (existing !== undefined) {
    assertPrivateFileStat(existing, path);
  }

  const suffix = randomBytes(12).toString("hex");
  const temporary = join(directory, `.${CONFIG_FILENAME}.${process.pid}.${suffix}.tmp`);
  let handle;
  try {
    handle = await open(
      temporary,
      fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_WRONLY |
        fsConstants.O_NOFOLLOW,
      0o600,
    );
    await handle.chmod(0o600);
    await handle.writeFile(`${JSON.stringify(normalized, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);

    // Persist the directory entry where the platform supports directory fsync.
    let directoryHandle;
    try {
      directoryHandle = await open(dirname(path), fsConstants.O_RDONLY);
      await directoryHandle.sync();
    } finally {
      await directoryHandle?.close();
    }
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch((unlinkError) => {
      if (unlinkError?.code !== "ENOENT") throw unlinkError;
    });
    throw error;
  }

  return normalized;
}
