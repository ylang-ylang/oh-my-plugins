import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { join } from "node:path";
import { listenerConfig, readConfig, rootDir } from "./config.mjs";

const PROTOCOL_VERSION = 1;
const MAX_BODY_BYTES = 64 * 1024;
const BODY_TIMEOUT_MS = 15_000;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const ERROR_CODE_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

class HttpError extends Error {
  constructor(status, code, message, options = undefined) {
    super(message, options);
    this.status = status;
    this.code = code;
  }
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

async function ensurePrivateDirectory(path) {
  const created = await mkdir(path, { recursive: true, mode: 0o700 });
  if (created !== undefined) await chmod(path, 0o700);
  assertPrivateDirectoryStat(await lstat(path), path);
}

async function writePrivateFileExclusive(path, contents) {
  const handle = await open(
    path,
    fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      fsConstants.O_WRONLY |
      fsConstants.O_NOFOLLOW,
    0o600,
  );
  let failure;
  try {
    await handle.chmod(0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } catch (error) {
    failure = error;
  }
  try {
    await handle.close();
  } catch (error) {
    failure ??= error;
  }
  if (failure !== undefined) {
    await unlink(path).catch((error) => {
      if (error?.code !== "ENOENT") failure.cleanupError = error;
    });
    throw failure;
  }
}

async function writeDescriptorAtomic(path, descriptor) {
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await writePrivateFileExclusive(
      temporary,
      `${JSON.stringify(descriptor, null, 2)}\n`,
    );
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch((unlinkError) => {
      if (unlinkError?.code !== "ENOENT") throw unlinkError;
    });
    throw error;
  }
}

function normalizedSession(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("getSession() must return an object");
  }
  if (!Number.isSafeInteger(value.generation) || value.generation <= 0) {
    throw new TypeError("session generation must be a positive safe integer");
  }
  if (typeof value.sessionId !== "string" || value.sessionId.length === 0) {
    throw new TypeError("sessionId must be a non-empty string");
  }
  if (typeof value.cwd !== "string" || value.cwd.length === 0) {
    throw new TypeError("session cwd must be a non-empty string");
  }
  if (typeof value.busy !== "boolean") {
    throw new TypeError("session busy must be a boolean");
  }
  if (!Number.isSafeInteger(value.queueDepth) || value.queueDepth < 0) {
    throw new TypeError("session queueDepth must be a non-negative safe integer");
  }
  return {
    generation: value.generation,
    sessionId: value.sessionId,
    cwd: value.cwd,
    busy: value.busy,
    queueDepth: value.queueDepth,
  };
}

function invokeSync(callback, argument, name) {
  const value = argument === undefined ? callback() : callback(argument);
  if (value !== null &&
      (typeof value === "object" || typeof value === "function") &&
      typeof value.then === "function") {
    void Promise.resolve(value).catch(() => {});
    throw new TypeError(`${name} callback must be synchronous`);
  }
  return value;
}

function parseGeneration(value) {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) {
    throw new HttpError(400, "invalid_generation", "generation must be a positive integer");
  }
  const generation = Number(value);
  if (!Number.isSafeInteger(generation)) {
    throw new HttpError(400, "invalid_generation", "generation exceeds the safe integer range");
  }
  return generation;
}

function parseRequestId(value) {
  if (typeof value !== "string" || !REQUEST_ID_PATTERN.test(value)) {
    throw new HttpError(
      400,
      "invalid_request_id",
      "requestId must match [A-Za-z0-9_-]{1,128}",
    );
  }
  return value;
}

function discardRequest(req) {
  if (!req.complete && !req.destroyed) req.resume();
}

function responsePayload(value) {
  try {
    return Buffer.from(JSON.stringify(value), "utf8");
  } catch (error) {
    throw new HttpError(500, "serialization_error", "response could not be serialized", {
      cause: error,
    });
  }
}

function sendJson(req, res, status, value, headers = undefined) {
  if (res.destroyed || res.writableEnded) return;
  const body = responsePayload(value);
  res.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Length": body.byteLength,
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  res.end(body);
  discardRequest(req);
}

function sendError(req, res, status, code, message, headers = undefined) {
  sendJson(req, res, status, { error: { code, message } }, headers);
}

function hasSingleBearerToken(req, expectedDigest) {
  const distinct = req.headersDistinct?.authorization;
  if (distinct !== undefined && distinct.length !== 1) return false;

  const header = distinct?.[0] ?? req.headers.authorization;
  if (typeof header !== "string") return false;
  const separator = header.indexOf(" ");
  if (separator <= 0 || header.slice(0, separator).toLowerCase() !== "bearer") {
    return false;
  }
  const candidate = header.slice(separator + 1);
  if (candidate.length === 0 || candidate.includes(" ")) return false;
  const candidateDigest = createHash("sha256").update(candidate, "utf8").digest();
  return timingSafeEqual(expectedDigest, candidateDigest);
}

function readBody(req) {
  const contentLength = req.headers["content-length"];
  if (contentLength !== undefined) {
    if (!/^[0-9]+$/.test(contentLength)) {
      throw new HttpError(400, "invalid_content_length", "Content-Length is invalid");
    }
    if (Number(contentLength) > MAX_BODY_BYTES) {
      throw new HttpError(413, "payload_too_large", "request body exceeds 64 KiB");
    }
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("aborted", onAborted);
      req.off("error", onError);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      discardRequest(req);
      reject(error);
    };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        fail(new HttpError(413, "payload_too_large", "request body exceeds 64 KiB"));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks, size));
    };
    const onAborted = () => {
      fail(new HttpError(400, "request_aborted", "request body was aborted"));
    };
    const onError = (error) => fail(error);
    const timer = setTimeout(() => {
      fail(new HttpError(408, "request_timeout", "request body timed out"));
    }, BODY_TIMEOUT_MS);
    timer.unref?.();

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("aborted", onAborted);
    req.on("error", onError);
  });
}

async function readJsonBody(req) {
  const contentType = req.headers["content-type"];
  if (typeof contentType !== "string" ||
      contentType.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    throw new HttpError(415, "unsupported_media_type", "Content-Type must be application/json");
  }

  const body = await readBody(req);
  let value;
  try {
    value = JSON.parse(body.toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid_json", "request body is not valid JSON");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "invalid_request", "request body must be a JSON object");
  }
  return value;
}

function errorDetails(error) {
  const status = error?.status;
  const code = error?.code;
  if (Number.isInteger(status) && status >= 400 && status <= 599 &&
      typeof code === "string" && ERROR_CODE_PATTERN.test(code)) {
    return {
      status,
      code,
      message: typeof error.message === "string" && error.message.length > 0
        ? error.message
        : "request failed",
      report: status >= 500,
    };
  }
  return {
    status: 500,
    code: "internal_error",
    message: "internal server error",
    report: true,
  };
}

function validateQuery(url, expectedKeys) {
  const actual = [...url.searchParams.keys()];
  if (actual.some((key) => !expectedKeys.includes(key))) {
    throw new HttpError(400, "invalid_query", "query contains an unsupported parameter");
  }
  for (const key of expectedKeys) {
    if (url.searchParams.getAll(key).length !== 1) {
      throw new HttpError(400, "invalid_query", `query must contain exactly one ${key}`);
    }
  }
}

async function routeRequest(req, res, context) {
  if (!hasSingleBearerToken(req, context.tokenDigest)) {
    sendError(req, res, 401, "unauthorized", "valid Bearer authentication is required", {
      "WWW-Authenticate": 'Bearer realm="omp-lan-rpc"',
    });
    return;
  }
  if (req.headers.origin !== undefined) {
    sendError(req, res, 403, "origin_not_allowed", "browser Origin requests are not allowed");
    return;
  }

  let url;
  try {
    url = new URL(req.url ?? "", "http://localhost");
  } catch {
    throw new HttpError(400, "invalid_url", "request URL is invalid");
  }

  if (url.pathname === "/v1/session") {
    if (req.method !== "GET") {
      sendError(req, res, 405, "method_not_allowed", "method is not allowed", { Allow: "GET" });
      return;
    }
    validateQuery(url, []);
    const session = normalizedSession(invokeSync(context.getSession, undefined, "getSession"));
    sendJson(req, res, 200, {
      protocolVersion: PROTOCOL_VERSION,
      instanceId: context.instanceId,
      ...session,
    });
    return;
  }

  if (url.pathname === "/v1/requests") {
    if (req.method !== "POST") {
      sendError(req, res, 405, "method_not_allowed", "method is not allowed", { Allow: "POST" });
      return;
    }
    validateQuery(url, []);
    const body = await readJsonBody(req);
    const keys = Object.keys(body);
    if (keys.some((key) => !["generation", "requestId", "message"].includes(key))) {
      throw new HttpError(400, "invalid_request", "request body contains an unsupported field");
    }
    if (!Number.isSafeInteger(body.generation) || body.generation <= 0) {
      throw new HttpError(400, "invalid_generation", "generation must be a positive safe integer");
    }
    const requestId = parseRequestId(body.requestId);
    if (typeof body.message !== "string") {
      throw new HttpError(400, "invalid_message", "message must be a string");
    }
    const record = invokeSync(context.submit, {
      generation: body.generation,
      requestId,
      message: body.message,
    }, "submit");
    sendJson(req, res, 202, record);
    return;
  }

  const match = /^\/v1\/requests\/([^/]+)$/.exec(url.pathname);
  if (match !== null) {
    if (req.method !== "GET") {
      sendError(req, res, 405, "method_not_allowed", "method is not allowed", { Allow: "GET" });
      return;
    }
    validateQuery(url, ["generation"]);
    let decodedId;
    try {
      decodedId = decodeURIComponent(match[1]);
    } catch {
      throw new HttpError(400, "invalid_request_id", "requestId is not valid URL encoding");
    }
    const requestId = parseRequestId(decodedId);
    const generation = parseGeneration(url.searchParams.get("generation"));
    const record = invokeSync(context.getRequest, { generation, requestId }, "getRequest");
    if (record === undefined || record === null) {
      throw new HttpError(404, "request_not_found", "request was not found");
    }
    sendJson(req, res, 200, record);
    return;
  }

  sendError(req, res, 404, "not_found", "route was not found");
}

function safeReport(onError, error) {
  if (typeof onError !== "function") return;
  try {
    const result = onError(error);
    if (result !== null &&
        (typeof result === "object" || typeof result === "function") &&
        typeof result.then === "function") {
      void Promise.resolve(result).catch(() => {});
    }
  } catch {
    // Error reporting must never terminate the host OMP session.
  }
}

function closeListeningServer(server) {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => {
      if (error && error.code !== "ERR_SERVER_NOT_RUNNING") reject(error);
      else resolve();
    });
    server.closeAllConnections?.();
  });
}

function listen(server, host, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host, port, exclusive: true });
  });
}

function endpointFor(protocol, host, port) {
  const authorityHost = host.includes(":") ? `[${host}]` : host;
  return `${protocol}://${authorityHost}:${port}`;
}

export async function startServer({ getSession, submit, getRequest, onError } = {}) {
  if (typeof getSession !== "function" ||
      typeof submit !== "function" ||
      typeof getRequest !== "function") {
    throw new TypeError("getSession, submit, and getRequest callbacks are required");
  }
  if (onError !== undefined && typeof onError !== "function") {
    throw new TypeError("onError must be a function when provided");
  }

  const config = listenerConfig(await readConfig());
  let tls;
  if (config.protocol === "https") {
    const [cert, key] = await Promise.all([
      readFile(config.tlsCert),
      readFile(config.tlsKey),
    ]);
    tls = { cert, key };
  }

  const directory = rootDir();
  const instances = join(directory, "instances");
  await ensurePrivateDirectory(directory);
  await ensurePrivateDirectory(instances);

  const instanceId = randomUUID();
  const token = randomBytes(32).toString("base64url");
  const tokenDigest = createHash("sha256").update(token, "utf8").digest();
  const tokenFile = join(instances, `${instanceId}.token`);
  const descriptorFile = join(instances, `${instanceId}.json`);
  let server;
  let tokenCreated = false;
  let descriptorCreated = false;

  try {
    await writePrivateFileExclusive(tokenFile, `${token}\n`);
    tokenCreated = true;

    const context = {
      instanceId,
      tokenDigest,
      getSession,
      submit,
      getRequest,
    };
    const handler = (req, res) => {
      // Socket failures are peer-controlled and must not become uncaught EventEmitter errors.
      req.on("error", () => {});
      res.on("error", () => {});
      void routeRequest(req, res, context).catch((error) => {
        const details = errorDetails(error);
        if (details.report) safeReport(onError, error);
        try {
          sendError(req, res, details.status, details.code, details.message,
            details.status === 408 || details.status === 413
              ? { Connection: "close" }
              : undefined);
        } catch (responseError) {
          safeReport(onError, responseError);
          res.destroy();
        }
      });
    };

    server = tls === undefined
      ? createHttpServer({ maxHeaderSize: 16 * 1024 }, handler)
      : createHttpsServer({ ...tls, maxHeaderSize: 16 * 1024 }, handler);
    server.headersTimeout = 10_000;
    server.requestTimeout = BODY_TIMEOUT_MS;
    server.keepAliveTimeout = 5_000;
    server.maxHeadersCount = 64;
    server.maxRequestsPerSocket = 100;
    server.on("clientError", (_error, socket) => socket.destroy());
    server.on("tlsClientError", () => {});
    server.on("error", (error) => safeReport(onError, error));

    try {
      await listen(server, config.host, config.port);
    } catch (error) {
      if (error?.code === "EADDRINUSE" && config.port !== 0) {
        const collision = new Error(`configured LAN RPC port ${config.port} is already in use`, {
          cause: error,
        });
        collision.code = "EADDRINUSE";
        throw collision;
      }
      throw error;
    }

    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("LAN RPC server did not bind a TCP address");
    }
    const endpoint = endpointFor(tls === undefined ? "http" : "https", config.host, address.port);
    const session = normalizedSession(invokeSync(getSession, undefined, "getSession"));
    await writeDescriptorAtomic(descriptorFile, {
      instanceId,
      pid: process.pid,
      endpoint,
      tokenFile,
      generation: session.generation,
      sessionId: session.sessionId,
    });
    descriptorCreated = true;

    let closing;
    return {
      endpoint,
      instanceId,
      close() {
        if (closing !== undefined) return closing;
        closing = (async () => {
          let closeError;
          try {
            await closeListeningServer(server);
          } catch (error) {
            closeError = error;
          }
          await unlink(descriptorFile).catch((error) => {
            if (error?.code !== "ENOENT" && closeError === undefined) closeError = error;
          });
          await unlink(tokenFile).catch((error) => {
            if (error?.code !== "ENOENT" && closeError === undefined) closeError = error;
          });
          if (closeError !== undefined) throw closeError;
        })();
        return closing;
      },
    };
  } catch (error) {
    if (server !== undefined) {
      await closeListeningServer(server).catch(() => {});
    }
    if (descriptorCreated) await unlink(descriptorFile).catch(() => {});
    if (tokenCreated) await unlink(tokenFile).catch(() => {});
    throw error;
  }
}
