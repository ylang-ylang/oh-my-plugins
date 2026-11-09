import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  rename,
  unlink,
} from "node:fs/promises";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { listenerConfig, readConfig, rootDir } from "./config.mjs";
import {
  ID_PATTERN,
  LIMITS,
  PROTOCOL_VERSION,
  UUID_PATTERN,
  failure,
  validateId,
  validateIdentity,
} from "./protocol.mjs";
import { prepareTls } from "./tls.mjs";
import { NOOP_OPERATIONS } from "./operations.mjs";

const BODY_TIMEOUT_MS = 15_000;
const TOOL_RESULT_BODY_BYTES = LIMITS.resultBytes + LIMITS.requestBytes;
const MAX_JSON_RESPONSE_BYTES = Math.max(
  LIMITS.nativeBytes,
  LIMITS.toolCalls * (LIMITS.argumentBytes + LIMITS.resultBytes),
) + LIMITS.requestBytes;
const ERROR_CODE_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const SENSITIVE_DETAIL_KEY = /^(?:apiKey|authorization|cause|credential|credentials|file|filename|password|providerRequest|secret|source|sourcePath|stack|token)$/i;

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

function normalizedSession(value, instanceId) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("controller.session() must return an object");
  }
  if (value.protocolVersion !== PROTOCOL_VERSION || value.instanceId !== instanceId) {
    throw new TypeError("controller session identity does not match the listener");
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
  const capabilities = value.capabilities;
  if (capabilities === null || typeof capabilities !== "object" || Array.isArray(capabilities) ||
      typeof capabilities.structuredResults !== "boolean" ||
      typeof capabilities.callerTools !== "boolean" ||
      typeof capabilities.artifacts !== "boolean" ||
      typeof capabilities.conversationExecution !== "boolean") {
    throw new TypeError("session capabilities are invalid");
  }
  return {
    protocolVersion: PROTOCOL_VERSION,
    instanceId,
    generation: value.generation,
    sessionId: value.sessionId,
    cwd: value.cwd,
    busy: value.busy,
    queueDepth: value.queueDepth,
    capabilities: {
      structuredResults: capabilities.structuredResults,
      callerTools: capabilities.callerTools,
      artifacts: capabilities.artifacts,
      conversationExecution: capabilities.conversationExecution,
    },
  };
}

async function controllerCall(controller, name, argument, options) {
  const callback = controller[name];
  if (argument === undefined) return await callback.call(controller);
  return await callback.call(controller, argument, options);
}

function parseGeneration(value) {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) {
    throw failure(400, "invalid_identity", "generation must be a positive safe integer");
  }
  const generation = Number(value);
  if (!Number.isSafeInteger(generation)) {
    throw failure(400, "invalid_identity", "generation must be a positive safe integer");
  }
  return generation;
}

function decodePathId(value, label, pattern, code) {
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw failure(400, code, `${label} is not valid URL encoding`);
  }
  if (!pattern.test(decoded)) {
    throw failure(400, code, `${label} is invalid`);
  }
  return decoded;
}

function parseRequestId(value) {
  const requestId = decodePathId(value, "requestId", ID_PATTERN, "invalid_request_id");
  return validateId(requestId);
}

function parseUuidId(value, label, code = "invalid_request") {
  return decodePathId(value, label, UUID_PATTERN, code);
}

function discardRequest(req) {
  if (!req.complete && !req.destroyed) req.resume();
}

function responsePayload(value) {
  let body;
  try {
    body = Buffer.from(JSON.stringify(value), "utf8");
  } catch {
    throw failure(500, "internal_error", "internal server error");
  }
  if (body.byteLength > MAX_JSON_RESPONSE_BYTES) {
    throw failure(500, "internal_error", "internal server error");
  }
  return body;
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

function sendError(req, res, status, code, message, headers = undefined, details = undefined) {
  const error = { code, message };
  if (details !== undefined) error.details = details;
  sendJson(req, res, status, { error }, headers);
}

function httpOperation(req) {
  let pathname;
  try { pathname = new URL(req.url ?? "", "http://localhost").pathname; }
  catch { return "unknown"; }
  if (pathname === "/v1" || pathname.startsWith("/v1/")) return "protocol_v1";
  if (pathname === "/v2/session") return "session";
  if (pathname === "/v2/requests") return "submit";
  const segments = pathname.split("/");
  if (segments.length < 4 || segments[1] !== "v2" || segments[2] !== "requests") return "unknown";
  if (segments.length === 4) return "request_get";
  if (segments.length === 5 && segments[4] === "cancel") return "request_cancel";
  if (segments.length === 5 && segments[4] === "events") return "request_events";
  if (segments.length === 5 && segments[4] === "tool-calls") return "tool_list";
  if (segments.length === 6 && segments[4] === "tool-calls") return "tool_get";
  if (segments.length === 7 && segments[4] === "tool-calls" && segments[6] === "claim") return "tool_claim";
  if (segments.length === 7 && segments[4] === "tool-calls" && segments[6] === "result") return "tool_result";
  if (segments.length === 5 && segments[4] === "artifacts") return "artifact_list";
  if (segments.length === 6 && segments[4] === "artifacts") return "artifact_get";
  return "unknown";
}

function logHttpFailure(context, req, status, code) {
  try {
    context.operations.emit("http.failure", {
      operation: httpOperation(req),
      state: String(status),
    });
  } catch {
    // Diagnostics must never alter native HTTP behavior.
  }
}

function sendHttpError(req, res, context, status, code, message, headers = undefined, details = undefined) {
  logHttpFailure(context, req, status, code);
  sendError(req, res, status, code, message, headers, details);
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

function readBody(req, maxBytes) {
  const contentLength = req.headers["content-length"];
  if (contentLength !== undefined) {
    if (!/^[0-9]+$/.test(contentLength)) {
      throw failure(400, "invalid_request", "Content-Length is invalid");
    }
    if (Number(contentLength) > maxBytes) {
      throw failure(413, "body_too_large", "request body exceeds the route limit");
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
      if (size > maxBytes) {
        fail(failure(413, "body_too_large", "request body exceeds the route limit"));
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
      fail(failure(400, "invalid_request", "request body was aborted"));
    };
    const onError = (error) => fail(error);
    const timer = setTimeout(() => {
      fail(failure(408, "request_timeout", "request body timed out"));
    }, BODY_TIMEOUT_MS);
    timer.unref?.();

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("aborted", onAborted);
    req.on("error", onError);
  });
}

async function readJsonBody(req, maxBytes = LIMITS.requestBytes) {
  const contentType = req.headers["content-type"];
  if (typeof contentType !== "string" ||
      contentType.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    throw failure(415, "unsupported_media_type", "Content-Type must be application/json");
  }

  const body = await readBody(req, maxBytes);
  let value;
  try {
    value = JSON.parse(body.toString("utf8"));
  } catch {
    throw failure(400, "invalid_json", "request body is not valid JSON");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw failure(400, "invalid_request", "request body must be a JSON object");
  }
  return value;
}

const UNSAFE_DETAIL = Symbol("unsafe detail");

function sanitizeDetail(value, depth = 0) {
  if (depth > LIMITS.jsonDepth) return UNSAFE_DETAIL;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return Buffer.byteLength(value, "utf8") <= LIMITS.requestBytes ? value : UNSAFE_DETAIL;
  if (typeof value === "number") return Number.isFinite(value) ? value : UNSAFE_DETAIL;
  if (Array.isArray(value)) {
    if (value.length > 1024) return UNSAFE_DETAIL;
    const result = [];
    for (const item of value) {
      const safe = sanitizeDetail(item, depth + 1);
      if (safe === UNSAFE_DETAIL) return UNSAFE_DETAIL;
      result.push(safe);
    }
    return result;
  }
  if (typeof value !== "object" || value instanceof Error) return UNSAFE_DETAIL;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return UNSAFE_DETAIL;
  const entries = Object.entries(value);
  if (entries.length > 64) return UNSAFE_DETAIL;
  const result = Object.create(null);
  for (const [key, item] of entries) {
    if (SENSITIVE_DETAIL_KEY.test(key)) continue;
    const safe = sanitizeDetail(item, depth + 1);
    if (safe === UNSAFE_DETAIL) return UNSAFE_DETAIL;
    result[key] = safe;
  }
  return result;
}

function safeErrorDetails(details) {
  if (details === undefined) return undefined;
  let safe;
  try {
    safe = sanitizeDetail(details);
  } catch {
    return undefined;
  }
  if (safe === UNSAFE_DETAIL) return undefined;
  try {
    if (Buffer.byteLength(JSON.stringify(safe), "utf8") > LIMITS.requestBytes) return undefined;
  } catch {
    return undefined;
  }
  return safe;
}

function errorDetails(error) {
  try {
    const status = error?.status;
    const code = error?.code;
    if (Number.isInteger(status) && status >= 400 && status <= 599 &&
        typeof code === "string" && ERROR_CODE_PATTERN.test(code)) {
      const message = typeof error.message === "string" && error.message.length > 0 && error.message.length <= 2048
        ? error.message
        : "request failed";
      return {
        status,
        code,
        message,
        details: safeErrorDetails(error.details),
        report: status >= 500,
      };
    }
  } catch {
    // Untrusted thrown values are never inspected further or returned.
  }
  return {
    status: 500,
    code: "internal_error",
    message: "internal server error",
    details: undefined,
    report: true,
  };
}

function validateQuery(url, requiredKeys, optionalKeys = []) {
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  const actual = [...url.searchParams.keys()];
  if (actual.some((key) => !allowed.has(key))) {
    throw failure(400, "invalid_query", "query contains an unsupported parameter");
  }
  for (const key of requiredKeys) {
    if (url.searchParams.getAll(key).length !== 1) {
      throw failure(400, "invalid_query", `query must contain exactly one ${key}`);
    }
  }
  for (const key of optionalKeys) {
    if (url.searchParams.getAll(key).length > 1) {
      throw failure(400, "invalid_query", `query may contain at most one ${key}`);
    }
  }
}

function queryIdentity(url, optionalKeys = []) {
  validateQuery(url, ["instanceId", "generation"], optionalKeys);
  const identity = {
    instanceId: url.searchParams.get("instanceId"),
    generation: parseGeneration(url.searchParams.get("generation")),
  };
  validateIdentity(identity);
  return identity;
}

function bodyIdentity(body, allowedKeys, requiredKeys = ["instanceId", "generation"]) {
  const allowed = new Set(allowedKeys);
  if (Object.keys(body).some((key) => !allowed.has(key)) ||
      requiredKeys.some((key) => !Object.hasOwn(body, key))) {
    throw failure(400, "invalid_request", "request body has missing or unsupported fields");
  }
  const identity = { instanceId: body.instanceId, generation: body.generation };
  validateIdentity(identity);
  return identity;
}

function parseAfter(value) {
  if (value === null) return 0;
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw failure(400, "invalid_query", "after must be a non-negative safe integer");
  }
  const after = Number(value);
  if (!Number.isSafeInteger(after)) {
    throw failure(400, "invalid_query", "after must be a non-negative safe integer");
  }
  return after;
}

function requireMethod(req, res, context, method) {
  if (req.method === method) return true;
  sendHttpError(req, res, context, 405, "method_not_allowed", "method is not allowed", { Allow: method });
  return false;
}

function contentDisposition(name) {
  const fallback = name.replace(/[^\x20-\x7e]|["\\]/g, "_") || "download";
  const encoded = encodeURIComponent(name).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

async function sendArtifact(req, res, value) {
  const metadata = value?.metadata;
  const handle = value?.handle;
  if (typeof handle?.createReadStream !== "function" || typeof handle?.close !== "function" ||
      typeof handle?.stat !== "function") {
    throw failure(500, "internal_error", "internal server error");
  }

  let streamError;
  try {
    if (!metadata || typeof metadata.name !== "string" || metadata.name.length === 0 ||
        Buffer.byteLength(metadata.name, "utf8") > 1024 || /[\r\n]/.test(metadata.name) ||
        typeof metadata.mediaType !== "string" || metadata.mediaType.length > 255 ||
        !/^[A-Za-z0-9!#$%&'*+.^_\x60|~-]+\/[A-Za-z0-9!#$%&'*+.^_\x60|~-]+$/.test(metadata.mediaType) ||
        !Number.isSafeInteger(metadata.size) || metadata.size < 0 || metadata.size > LIMITS.artifactBytes) {
      throw failure(500, "internal_error", "internal server error");
    }
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== metadata.size) {
      throw failure(500, "internal_error", "internal server error");
    }
    const stream = metadata.size === 0
      ? undefined
      : handle.createReadStream({ autoClose: false, start: 0, end: metadata.size - 1 });
    res.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Disposition": contentDisposition(metadata.name),
      "Content-Length": metadata.size,
      "Content-Type": metadata.mediaType,
      "X-Content-Type-Options": "nosniff",
    });
    discardRequest(req);
    if (stream === undefined) {
      res.end();
    } else {
      try {
        await pipeline(stream, res);
      } catch (error) {
        if (!req.aborted && !req.destroyed) streamError = error;
      }
    }
  } finally {
    try {
      await handle.close();
    } catch (error) {
      streamError ??= error;
    }
  }
  if (streamError !== undefined) throw streamError;
}

async function routeRequest(req, res, context, signal) {
  if (context.tokenDigest !== undefined && !hasSingleBearerToken(req, context.tokenDigest)) {
    sendHttpError(req, res, context, 401, "unauthorized", "valid Bearer authentication is required", {
      "WWW-Authenticate": 'Bearer realm="omp-lan-rpc"',
    });
    return;
  }
  if (req.headers.origin !== undefined) {
    sendHttpError(req, res, context, 403, "origin_not_allowed", "browser Origin requests are not allowed");
    return;
  }

  let url;
  try {
    url = new URL(req.url ?? "", "http://localhost");
  } catch {
    throw failure(400, "invalid_request", "request URL is invalid");
  }

  if (url.pathname === "/v1" || url.pathname.startsWith("/v1/")) {
    sendHttpError(req, res, context, 410, "protocol_upgraded", "protocol v1 has been replaced by v2");
    return;
  }

  const controller = context.controller;
  const invoke = (name, argument) => controllerCall(controller, name, argument, { signal });

  if (url.pathname === "/v2/session") {
    if (!requireMethod(req, res, context, "GET")) return;
    validateQuery(url, []);
    sendJson(req, res, 200, normalizedSession(await invoke("session"), context.instanceId));
    return;
  }

  if (url.pathname === "/v2/requests") {
    if (!requireMethod(req, res, context, "POST")) return;
    validateQuery(url, []);
    const body = await readJsonBody(req);
    bodyIdentity(body,
      ["instanceId", "generation", "requestId", "message", "instructions", "responseMode", "resultSchema", "tools", "queueTimeoutMs", "timeoutMs", "toolTimeoutMs"],
      ["instanceId", "generation", "requestId", "message"]);
    validateId(body.requestId);
    sendJson(req, res, 202, await invoke("submit", body));
    return;
  }

  const segments = url.pathname.split("/");
  if (segments.length < 4 || segments[0] !== "" || segments[1] !== "v2" || segments[2] !== "requests") {
    sendHttpError(req, res, context, 404, "not_found", "route was not found");
    return;
  }
  const requestId = parseRequestId(segments[3]);

  if (segments.length === 4) {
    if (!requireMethod(req, res, context, "GET")) return;
    const identity = { ...queryIdentity(url), requestId };
    sendJson(req, res, 200, await invoke("get", identity));
    return;
  }

  if (segments.length === 5 && segments[4] === "cancel") {
    if (!requireMethod(req, res, context, "POST")) return;
    validateQuery(url, []);
    const body = await readJsonBody(req);
    const identity = bodyIdentity(body, ["instanceId", "generation"]);
    sendJson(req, res, 200, await invoke("cancel", { ...identity, requestId }));
    return;
  }

  if (segments.length === 5 && segments[4] === "events") {
    if (!requireMethod(req, res, context, "GET")) return;
    const identity = queryIdentity(url, ["after"]);
    const after = parseAfter(url.searchParams.get("after"));
    sendJson(req, res, 200, await invoke("events", { ...identity, requestId, after }));
    return;
  }

  if (segments.length === 5 && segments[4] === "tool-calls") {
    if (!requireMethod(req, res, context, "GET")) return;
    const identity = { ...queryIdentity(url), requestId };
    sendJson(req, res, 200, await invoke("toolCalls", identity));
    return;
  }

  if (segments.length >= 6 && segments[4] === "tool-calls") {
    const toolCallId = parseUuidId(segments[5], "toolCallId");
    if (segments.length === 6) {
      if (!requireMethod(req, res, context, "GET")) return;
      const identity = { ...queryIdentity(url), requestId, toolCallId };
      sendJson(req, res, 200, await invoke("toolCall", identity));
      return;
    }
    if (segments.length === 7 && segments[6] === "claim") {
      if (!requireMethod(req, res, context, "POST")) return;
      validateQuery(url, []);
      const body = await readJsonBody(req);
      const identity = bodyIdentity(body,
        ["instanceId", "generation", "workerId", "claimId", "leaseMs", "renew"],
        ["instanceId", "generation", "workerId", "claimId"]);
      sendJson(req, res, 200, await invoke("claim", { ...body, ...identity, requestId, toolCallId }));
      return;
    }
    if (segments.length === 7 && segments[6] === "result") {
      if (!requireMethod(req, res, context, "POST")) return;
      validateQuery(url, []);
      const body = await readJsonBody(req, TOOL_RESULT_BODY_BYTES);
      const identity = bodyIdentity(body,
        ["instanceId", "generation", "leaseId", "outcome"],
        ["instanceId", "generation", "leaseId", "outcome"]);
      sendJson(req, res, 200, await invoke("toolResult", { ...body, ...identity, requestId, toolCallId }));
      return;
    }
  }

  if (segments.length === 5 && segments[4] === "artifacts") {
    if (!requireMethod(req, res, context, "GET")) return;
    const identity = { ...queryIdentity(url), requestId };
    sendJson(req, res, 200, await invoke("artifacts", identity));
    return;
  }

  if (segments.length === 6 && segments[4] === "artifacts") {
    if (!requireMethod(req, res, context, "GET")) return;
    const artifactId = parseUuidId(segments[5], "artifactId", "invalid_artifact");
    const identity = { ...queryIdentity(url), requestId, artifactId };
    await sendArtifact(req, res, await invoke("artifact", identity));
    return;
  }

  sendHttpError(req, res, context, 404, "not_found", "route was not found");
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

export async function startServer({ controller, operations = NOOP_OPERATIONS, onError } = {}) {
  const requiredMethods = [
    "session", "submit", "get", "cancel", "events", "toolCalls", "toolCall",
    "claim", "toolResult", "artifacts", "artifact",
  ];
  if (controller === null || typeof controller !== "object" ||
      !UUID_PATTERN.test(controller.instanceId ?? "") ||
      requiredMethods.some((name) => typeof controller[name] !== "function")) {
    throw new TypeError("a v2 RequestController is required");
  }
  if (onError !== undefined && typeof onError !== "function") {
    throw new TypeError("onError must be a function when provided");
  }
  if (!operations || typeof operations.emit !== "function") {
    throw new TypeError("operations must implement emit");
  }
  const log = (event, fields) => {
    try { operations.emit(event, fields); } catch {
      // Diagnostics must never alter listener or protocol behavior.
    }
  };

  const config = listenerConfig(await readConfig());
  // Only the actual listener configuration controls authentication, never proxy headers.
  const tls = await prepareTls(config);

  const directory = rootDir();
  const instances = join(directory, "instances");
  await ensurePrivateDirectory(directory);
  await ensurePrivateDirectory(instances);

  const instanceId = controller.instanceId;
  const token = tls ? randomBytes(32).toString("base64url") : undefined;
  const tokenDigest = token === undefined ? undefined : createHash("sha256").update(token, "utf8").digest();
  const tokenFile = tls ? join(instances, `${instanceId}.token`) : undefined;
  const descriptorFile = join(instances, `${instanceId}.json`);
  let server;
  let tokenCreated = false;
  let descriptorCreated = false;

  try {
    if (tokenFile !== undefined) {
      await writePrivateFileExclusive(tokenFile, `${token}\n`);
      tokenCreated = true;
    }

    const context = {
      controller,
      instanceId,
      tokenDigest,
      operations,
    };
    const handler = (req, res) => {
      // Socket failures are peer-controlled and must not become uncaught EventEmitter errors.
      req.on("error", () => {});
      res.on("error", () => {});
      const operation = new AbortController();
      const onAborted = () => operation.abort(failure(409, "validation_aborted", "request connection closed during validation"));
      const onResponseClose = () => {
        if (!res.writableEnded) onAborted();
      };
      req.once("aborted", onAborted);
      res.once("close", onResponseClose);
      void routeRequest(req, res, context, operation.signal).catch((error) => {
        const details = errorDetails(error);
        if (details.report) safeReport(onError, error);
        logHttpFailure(context, req, details.status, details.code);
        try {
          sendError(req, res, details.status, details.code, details.message,
            details.status === 408 || details.status === 413
              ? { Connection: "close" }
              : undefined,
            details.details);
        } catch (responseError) {
          safeReport(onError, responseError);
          res.destroy();
        }
      }).finally(() => {
        req.off("aborted", onAborted);
        res.off("close", onResponseClose);
      });
    };

    server = tls === undefined
      ? createHttpServer({ maxHeaderSize: 16 * 1024 }, handler)
      : createHttpsServer({ cert: tls.cert, key: tls.key, maxHeaderSize: 16 * 1024 }, handler);
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
    const session = normalizedSession(await controllerCall(controller, "session"), instanceId);
    await writeDescriptorAtomic(descriptorFile, {
      instanceId,
      pid: process.pid,
      endpoint,
      protocolVersion: PROTOCOL_VERSION,
      tokenFile,
      generation: session.generation,
      sessionId: session.sessionId,
    });
    descriptorCreated = true;
    log("listener.started", {
      sessionId: session.sessionId,
      instanceId,
      generation: session.generation,
      operation: tls === undefined ? "http" : "https",
      state: "listening",
    });

    let closing;
    const listenerIdentity = {
      sessionId: session.sessionId,
      instanceId,
      generation: session.generation,
      operation: tls === undefined ? "http" : "https",
    };
    return {
      endpoint,
      instanceId,
      token,
      tokenFile,
      certFile: tls?.certFile,
      close() {
        if (closing !== undefined) return closing;
        closing = (async () => {
          log("listener.stop_requested", { ...listenerIdentity, state: "stopping" });
          let closeError;
          try {
            await closeListeningServer(server);
          } catch (error) {
            closeError = error;
          }
          await unlink(descriptorFile).catch((error) => {
            if (error?.code !== "ENOENT" && closeError === undefined) closeError = error;
          });
          if (tokenFile !== undefined) await unlink(tokenFile).catch((error) => {
            if (error?.code !== "ENOENT" && closeError === undefined) closeError = error;
          });
          log("listener.stopped", {
            ...listenerIdentity,
            state: closeError === undefined ? "stopped" : "failed",
            errorCode: closeError?.code,
            errorType: closeError?.name,
          });
          if (closeError !== undefined) throw closeError;
        })();
        return closing;
      },
    };
  } catch (error) {
    log("listener.start_failed", {
      instanceId,
      generation: controller.generation,
      sessionId: controller.sessionId,
      state: "failed",
      errorCode: error?.code,
      errorType: error?.name,
    });
    if (server !== undefined) {
      await closeListeningServer(server).catch(() => {});
    }
    if (descriptorCreated) await unlink(descriptorFile).catch(() => {});
    if (tokenCreated) await unlink(tokenFile).catch(() => {});
    throw error;
  }
}
