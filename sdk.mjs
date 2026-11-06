import http from "node:http";
import https from "node:https";
import { randomUUID } from "node:crypto";
import { open, rm } from "node:fs/promises";
import { isIP } from "node:net";
import { isAbsolute } from "node:path";
import { spawn } from "node:child_process";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ID_PATTERN, LIMITS, PROTOCOL_VERSION, TERMINAL_STATES, UUID_PATTERN } from "./protocol.mjs";

const DEFAULT_HTTP_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_MS = 250;
const MAX_JSON_RESPONSE_BYTES = LIMITS.nativeBytes + 1024 * 1024;
const MAX_RELAY_INPUT_BYTES = LIMITS.resultBytes + LIMITS.requestBytes + 64 * 1024;
const KNOWN_REQUEST_STATES = new Set(["queued", "running", ...TERMINAL_STATES]);
const SSH_OPTIONS = Object.freeze([
  "-T",
  "-o", "BatchMode=yes",
  "-o", "StrictHostKeyChecking=yes",
  "-o", "ConnectTimeout=10",
  "-o", "ServerAliveInterval=10",
  "-o", "ServerAliveCountMax=2",
]);
const REMOTE_PATH = 'export PATH="$HOME/.local/bin:$HOME/.bun/bin:/home/linuxbrew/.linuxbrew/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; ';

export class RpcError extends Error {
  constructor(message, { status, code, details, uncertain = false, cause } = {}) {
    super(message, { cause });
    this.name = "RpcError";
    if (status !== undefined) this.status = status;
    if (code !== undefined) this.code = code;
    if (details !== undefined) this.details = details;
    if (uncertain) this.uncertain = true;
  }
}

function redact(value, secrets = []) {
  let text = typeof value === "string" ? value : String(value ?? "request failed");
  text = text.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 512);
  for (const secret of secrets) {
    if (secret && text.includes(secret)) text = text.split(secret).join("[redacted]");
  }
  return text;
}

function plainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RpcError(`${label} must be a JSON object`, { code: "invalid_client_argument" });
  }
  return value;
}

function checkedIdentity(value) {
  plainObject(value, "identity");
  if (!UUID_PATTERN.test(value.instanceId ?? "") || !Number.isSafeInteger(value.generation) || value.generation <= 0 || !ID_PATTERN.test(value.requestId ?? "")) {
    throw new RpcError("identity requires a UUID instanceId, positive safe-integer generation, and valid requestId", { code: "invalid_identity" });
  }
  return { instanceId: value.instanceId, generation: value.generation, requestId: value.requestId };
}

function checkedCallId(value) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new RpcError("toolCallId must be a UUID", { code: "invalid_client_argument" });
  }
  return value;
}

function checkedArtifactId(value) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new RpcError("artifactId must be a UUID", { code: "invalid_client_argument" });
  }
  return value;
}

function validateSession(value, expectedInstance) {
  plainObject(value, "session response");
  if (value.protocolVersion !== PROTOCOL_VERSION || !UUID_PATTERN.test(value.instanceId ?? "") || !Number.isSafeInteger(value.generation) || value.generation <= 0) {
    throw new RpcError("server returned invalid LAN RPC v2 session metadata", { code: "invalid_response" });
  }
  if (expectedInstance !== undefined && value.instanceId !== expectedInstance) {
    throw new RpcError("server returned a different instance identity", { code: "instance_mismatch" });
  }
  return value;
}

function validateRecord(value, identity) {
  plainObject(value, "request response");
  if (value.instanceId !== identity.instanceId) {
    throw new RpcError("server returned a request record for a different instance", { code: "instance_mismatch" });
  }
  if (value.generation !== identity.generation) {
    throw new RpcError("server returned a request record for a different generation", { code: "generation_mismatch" });
  }
  if (value.requestId !== identity.requestId) {
    throw new RpcError("server returned a request record for a different requestId", { code: "request_mismatch" });
  }
  if (!KNOWN_REQUEST_STATES.has(value.state)) throw new RpcError("server returned an invalid request state", { code: "invalid_response" });
  return value;
}

function validateToolRecord(value, identity, callId) {
  plainObject(value, "tool-call response");
  if (!UUID_PATTERN.test(value.toolCallId ?? "")) throw new RpcError("server returned an invalid toolCallId", { code: "invalid_response" });
  if (value.instanceId !== identity.instanceId) throw new RpcError("server returned a tool call for a different instance", { code: "instance_mismatch" });
  if (value.generation !== identity.generation) throw new RpcError("server returned a tool call for a different generation", { code: "generation_mismatch" });
  if (value.requestId !== identity.requestId || value.toolCallId !== callId) {
    throw new RpcError("server returned a different tool call identity", { code: "request_mismatch" });
  }
  return value;
}

function validateArtifactMetadata(value) {
  plainObject(value, "artifact metadata");
  if (!UUID_PATTERN.test(value.artifactId ?? "") || typeof value.name !== "string" || !Number.isSafeInteger(value.size) || value.size < 0) {
    throw new RpcError("server returned invalid artifact metadata", { code: "invalid_response" });
  }
  return value;
}

function isLoopback(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (host === "::1") return true;
  return isIP(host) === 4 && Number(host.split(".", 1)[0]) === 127;
}

function parseEndpoint(raw, allowHttp) {
  if (typeof raw !== "string" || !/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]+\/?$/.test(raw)) {
    throw new RpcError("endpoint must be an origin without credentials, path, query, or fragment", { code: "invalid_endpoint" });
  }
  let endpoint;
  try { endpoint = new URL(raw); } catch {
    throw new RpcError("endpoint must be a valid URL origin", { code: "invalid_endpoint" });
  }
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.pathname !== "/" || endpoint.search || endpoint.hash) {
    throw new RpcError("endpoint must be an HTTP(S) origin without credentials, path, query, or fragment", { code: "invalid_endpoint" });
  }
  if (endpoint.protocol === "http:" && !isLoopback(endpoint.hostname) && !allowHttp) {
    throw new RpcError("non-loopback HTTP is anonymous plaintext; pass allowHttp only after accepting that risk", { code: "http_not_allowed" });
  }
  return endpoint;
}

function encodeJson(value, maximum, label) {
  let data;
  try { data = Buffer.from(JSON.stringify(value), "utf8"); } catch (error) {
    throw new RpcError(`${label} is not JSON-serializable`, { code: "invalid_client_argument", cause: error });
  }
  if (data.length > maximum) throw new RpcError(`${label} exceeds the ${maximum}-byte client limit`, { code: "value_too_large" });
  return data;
}

function routeIdentity(identity) {
  return new URLSearchParams({ instanceId: identity.instanceId, generation: String(identity.generation) }).toString();
}
async function writeExclusive(outputPath, producer) {
  if (typeof outputPath !== "string" || outputPath.length === 0) throw new RpcError("outputPath must be a non-empty path", { code: "invalid_client_argument" });
  let handle;
  try {
    handle = await open(outputPath, "wx", 0o600);
    await producer(fileHandleWritable(handle));
    await handle.sync();
  } catch (error) {
    await handle?.close().catch(() => {});
    if (handle) await rm(outputPath, { force: true }).catch(() => {});
    throw error;
  }
  await handle.close();
  return outputPath;
}

function fileHandleWritable(handle) {
  let position = 0;
  return new Writable({
    write(chunk, _encoding, callback) {
      let offset = 0;
      const next = () => {
        handle.write(chunk, offset, chunk.length - offset, position).then(({ bytesWritten }) => {
          if (bytesWritten <= 0) return callback(new RpcError("artifact output write made no progress", { code: "output_failed" }));
          offset += bytesWritten;
          position += bytesWritten;
          if (offset === chunk.length) callback();
          else next();
        }, callback);
      };
      next();
    },
  });
}

class Operations {
  async session() {
    return validateSession(await this._call("session", {}), this.expectedInstanceId);
  }

  async submit(request) {
    plainObject(request, "request");
    const identity = checkedIdentity(request);
    return validateRecord(await this._call("submit", { request }), identity);
  }

  async request(identity) {
    identity = checkedIdentity(identity);
    return validateRecord(await this._call("request", { identity }), identity);
  }

  async cancel(identity) {
    identity = checkedIdentity(identity);
    return validateRecord(await this._call("cancel", { identity }), identity);
  }

  async toolCalls(identity) {
    identity = checkedIdentity(identity);
    const response = plainObject(await this._call("toolCalls", { identity }), "tool-calls response");
    if (!Array.isArray(response.toolCalls)) throw new RpcError("server returned invalid tool-calls response", { code: "invalid_response" });
    for (const call of response.toolCalls) validateToolRecord(call, identity, call.toolCallId);
    return response;
  }

  async toolCall(identity, callId) {
    identity = checkedIdentity(identity);
    callId = checkedCallId(callId);
    return validateToolRecord(await this._call("toolCall", { identity, callId }), identity, callId);
  }

  async claim(identity, callId, claim) {
    identity = checkedIdentity(identity);
    callId = checkedCallId(callId);
    plainObject(claim, "claim");
    return validateToolRecord(await this._call("claim", { identity, callId, claim }), identity, callId);
  }

  async toolResult(identity, callId, reply) {
    identity = checkedIdentity(identity);
    callId = checkedCallId(callId);
    plainObject(reply, "tool result");
    return validateToolRecord(await this._call("toolResult", { identity, callId, reply }), identity, callId);
  }

  async events(identity, after = 0) {
    identity = checkedIdentity(identity);
    if (!Number.isSafeInteger(after) || after < 0) throw new RpcError("after must be a nonnegative safe integer", { code: "invalid_client_argument" });
    const response = plainObject(await this._call("events", { identity, after }), "events response");
    if (!Array.isArray(response.events) || !Number.isSafeInteger(response.nextSequence) || response.nextSequence < after) {
      throw new RpcError("server returned invalid events response", { code: "invalid_response" });
    }
    return response;
  }

  async artifacts(identity) {
    identity = checkedIdentity(identity);
    const response = plainObject(await this._call("artifacts", { identity }), "artifacts response");
    if (!Array.isArray(response.artifacts)) throw new RpcError("server returned invalid artifacts response", { code: "invalid_response" });
    for (const artifact of response.artifacts) validateArtifactMetadata(artifact);
    return response;
  }

  async download(identity, artifactId, outputPath) {
    identity = checkedIdentity(identity);
    artifactId = checkedArtifactId(artifactId);
    return await this._download(identity, artifactId, outputPath);
  }

  async downloadTo(identity, artifactId, writable) {
    identity = checkedIdentity(identity);
    artifactId = checkedArtifactId(artifactId);
    if (!writable || typeof writable.write !== "function") throw new RpcError("writable must be a writable stream", { code: "invalid_client_argument" });
    return await this._downloadTo(identity, artifactId, writable);
  }

  async run(request, { handlers = {}, onEvent, signal, pollMs = DEFAULT_POLL_MS } = {}) {
    plainObject(request, "request");
    plainObject(handlers, "handlers");
    if (onEvent !== undefined && typeof onEvent !== "function") throw new RpcError("onEvent must be a function", { code: "invalid_client_argument" });
    if (!Number.isInteger(pollMs) || pollMs < 25 || pollMs > 60_000) throw new RpcError("pollMs must be an integer from 25 to 60000", { code: "invalid_client_argument" });
    for (const tool of request.tools ?? []) {
      if (typeof handlers[tool.name] !== "function") {
        throw new RpcError(`missing handler for declared caller tool ${tool.name}`, { code: "handler_missing" });
      }
    }
    if (signal?.aborted) throw abortReason(signal);

    const identity = checkedIdentity(request);
    let record;
    try {
      record = await this.submit(request);
    } catch (error) {
      if (error instanceof RpcError && error.uncertain) {
        error.message += `; query request ${identity.requestId} using its original instanceId and generation before retrying`;
      }
      throw error;
    }

    let after = 0;
    const workerId = `sdk_${randomUUID().replaceAll("-", "")}`;
    const workers = new Map();
    const executedToolCalls = new Set();
    const workerAbort = new AbortController();
    const workerSignal = signal ? AbortSignal.any([signal, workerAbort.signal]) : workerAbort.signal;
    let workerFailure;
    let cancelSent = false;

    const cancelForAbort = async () => {
      if (cancelSent) return;
      cancelSent = true;
      await this.cancel(identity).catch(() => {});
    };
    const startWorker = (call) => {
      if (workers.has(call.toolCallId) || executedToolCalls.has(call.toolCallId)) return;
      executedToolCalls.add(call.toolCallId);
      const promise = this._executeTool(identity, call, handlers[call.name], workerId, workerSignal)
        .then((executed) => { if (!executed) executedToolCalls.delete(call.toolCallId); })
        .catch((error) => { workerFailure ??= error; })
        .finally(() => workers.delete(call.toolCallId));
      workers.set(call.toolCallId, promise);
    };

    try {
      while (!TERMINAL_STATES.has(record.state)) {
        if (signal?.aborted) {
          await cancelForAbort();
          throw abortReason(signal);
        }
        if (workerFailure) throw workerFailure;

        const [eventBatch, calls, nextRecord] = await Promise.all([
          this.events(identity, after),
          this.toolCalls(identity),
          this.request(identity),
        ]);
        for (const event of eventBatch.events) {
          if (onEvent) await onEvent(event);
        }
        after = eventBatch.nextSequence;
        for (const call of calls.toolCalls) {
          if (call.state === "pending" && typeof handlers[call.name] === "function") startWorker(call);
        }
        record = nextRecord;
        if (TERMINAL_STATES.has(record.state)) break;
        await delay(pollMs, signal);
      }
    } catch (error) {
      if (signal?.aborted) await cancelForAbort();
      throw error;
    } finally {
      workerAbort.abort(new DOMException("Request pump stopped", "AbortError"));
      if (workers.size) await Promise.all(workers.values());
    }
    if (workerFailure && !TERMINAL_STATES.has(record.state)) throw workerFailure;
    if (onEvent) {
      const finalBatch = await this.events(identity, after);
      for (const event of finalBatch.events) await onEvent(event);
    }
    return record;
  }

  async _executeTool(identity, pendingCall, handler, workerId, runSignal) {
    const callId = pendingCall.toolCallId;
    const claimId = `claim_${randomUUID().replaceAll("-", "")}`;
    let claimed;
    try {
      claimed = await this.claim(identity, callId, { workerId, claimId, leaseMs: LIMITS.leaseMs });
    } catch (error) {
      if (error instanceof RpcError && error.code === "tool_claimed") return false;
      if (!(error instanceof RpcError) || !error.uncertain) throw error;
      const observed = await this.toolCall(identity, callId);
      if (observed.state !== "claimed" || observed.workerId !== workerId || observed.claimId !== claimId) throw error;
      claimed = observed;
    }

    const leaseAbort = new AbortController();
    const handlerSignal = runSignal ? AbortSignal.any([runSignal, leaseAbort.signal]) : leaseAbort.signal;
    let renewing = true;
    let renewalFailure;
    const renew = async () => {
      while (renewing) {
        const remaining = Math.max(0, claimed.leaseExpiresAt - Date.now());
        try { await delay(Math.max(25, Math.floor(remaining / 2)), handlerSignal); } catch { return; }
        if (!renewing) return;
        try {
          claimed = await this.claim(identity, callId, { workerId, claimId, leaseMs: LIMITS.leaseMs, renew: true });
        } catch (error) {
          renewalFailure = error;
          leaseAbort.abort(error);
          return;
        }
      }
    };
    const renewal = renew();

    let outcome;
    try {
      const result = await raceWithAbort(Promise.resolve().then(() => handler(claimed.arguments, { identity, toolCall: claimed, signal: handlerSignal })), handlerSignal);
      outcome = { status: "completed", result };
    } catch (error) {
      if (renewalFailure) throw renewalFailure;
      const message = redact(error instanceof Error ? error.message : error);
      outcome = { status: runSignal?.aborted ? "cancelled" : "failed", error: { code: runSignal?.aborted ? "handler_cancelled" : "handler_failed", message } };
    } finally {
      renewing = false;
      leaseAbort.abort();
      await renewal;
    }
    if (renewalFailure) throw renewalFailure;
    if (runSignal?.aborted) return true;

    const reply = { leaseId: claimed.leaseId, outcome };
    try {
      await this.toolResult(identity, callId, reply);
    } catch (error) {
      if (!(error instanceof RpcError) || !error.uncertain) throw error;
      let observed;
      try { observed = await this.toolCall(identity, callId); } catch (queryError) {
        throw new RpcError("tool-result outcome is uncertain; do not execute the handler again", { code: "tool_result_uncertain", uncertain: true, cause: queryError });
      }
      if (["completed", "failed", "cancelled"].includes(observed.state)) return;
      if (observed.state !== "claimed" || observed.leaseId !== claimed.leaseId) throw error;
      await this.toolResult(identity, callId, reply);
    }
    return true;
  }
}

function raceWithAbort(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", aborted);
      callback(value);
    };
    const aborted = () => finish(reject, abortReason(signal));
    signal.addEventListener("abort", aborted, { once: true });
    promise.then((value) => finish(resolve, value), (error) => finish(reject, error));
    if (signal.aborted) aborted();
  });
}

function abortReason(signal) {
  if (signal.reason instanceof Error) return signal.reason;
  return new DOMException("Operation aborted", "AbortError");
}

function delay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortReason(signal));
    let timer;
    const aborted = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", aborted);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", aborted, { once: true });
  });
}

export class RpcClient extends Operations {
  constructor({ endpoint, token, ca, allowHttp = false, timeoutMs = DEFAULT_HTTP_TIMEOUT_MS } = {}) {
    super();
    this.endpoint = parseEndpoint(endpoint, allowHttp);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new RpcError("timeoutMs must be a positive integer", { code: "invalid_client_argument" });
    if (this.endpoint.protocol === "https:" && (typeof token !== "string" || token.length === 0)) {
      throw new RpcError("HTTPS requires a bearer token", { code: "token_required" });
    }
    if (this.endpoint.protocol === "https:" && (token.length > 4 * 1024 || !/^[\x21-\x7e]+$/.test(token))) {
      throw new RpcError("bearer token must contain visible ASCII without whitespace and fit within 4096 bytes", { code: "token_invalid" });
    }
    if (this.endpoint.protocol === "http:" && token !== undefined) {
      throw new RpcError("HTTP is anonymous; token is forbidden", { code: "token_forbidden" });
    }
    if (this.endpoint.protocol === "http:" && ca !== undefined) {
      throw new RpcError("HTTP does not use TLS; ca is forbidden", { code: "ca_forbidden" });
    }
    this.token = token;
    this.ca = ca;
    this.timeoutMs = timeoutMs;
  }

  async _call(operation, args) {
    const request = httpOperation(operation, args);
    return await this._requestJson(request.method, request.route, request.body, request.maxRequestBytes);
  }

  async _download(identity, artifactId, outputPath) {
    return await writeExclusive(outputPath, async (writable) => {
      await this._downloadTo(identity, artifactId, writable);
    });
  }
  async _downloadTo(identity, artifactId, writable) {
    const route = `/v2/requests/${encodeURIComponent(identity.requestId)}/artifacts/${encodeURIComponent(artifactId)}?${routeIdentity(identity)}`;
    await this._requestDownload(route, writable);
  }

  async _requestJson(method, route, body, maxRequestBytes = LIMITS.resultBytes + 64 * 1024) {
    const requestBody = body === undefined ? undefined : encodeJson(body, maxRequestBytes, "request body");
    const target = new URL(route, this.endpoint);
    const response = await this._request(target, method, requestBody);
    const chunks = [];
    let length = 0;
    try {
      for await (const chunk of response) {
        length += chunk.length;
        if (length > MAX_JSON_RESPONSE_BYTES) {
          response.destroy();
          throw new RpcError("response JSON exceeds the client safety limit", { code: "response_too_large", uncertain: method !== "GET" });
        }
        chunks.push(chunk);
      }
    } catch (error) {
      if (error instanceof RpcError) throw error;
      throw new RpcError("response ended before complete JSON was received", { code: "transport_error", uncertain: method !== "GET", cause: error });
    }
    let payload;
    try { payload = JSON.parse(Buffer.concat(chunks, length).toString("utf8")); } catch {
      throw new RpcError(`server returned non-JSON HTTP ${response.statusCode ?? "response"}`, { status: response.statusCode, code: "invalid_response", uncertain: method !== "GET" });
    }
    if ((response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) >= 300) throw responseError(response.statusCode, payload, this.token);
    return plainObject(payload, "server response");
  }

  async _requestDownload(route, writable) {
    const response = await this._request(new URL(route, this.endpoint), "GET");
    if ((response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) >= 300) {
      const chunks = [];
      let length = 0;
      for await (const chunk of response) {
        length += chunk.length;
        if (length > 64 * 1024) break;
        chunks.push(chunk);
      }
      let payload;
      try { payload = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { payload = undefined; }
      throw responseError(response.statusCode, payload, this.token);
    }
    const expected = response.headers["content-length"] === undefined ? undefined : Number(response.headers["content-length"]);
    if (expected !== undefined && (!Number.isSafeInteger(expected) || expected < 0 || expected > LIMITS.artifactBytes)) {
      response.destroy();
      throw new RpcError("server returned invalid artifact length", { code: "invalid_response" });
    }
    let received = 0;
    const counter = new Transform({ transform(chunk, _encoding, callback) {
      received += chunk.length;
      if (received > LIMITS.artifactBytes) callback(new RpcError("artifact exceeds the client safety limit", { code: "response_too_large" }));
      else callback(null, chunk);
    } });
    await pipeline(response, counter, writable);
    if (expected !== undefined && received !== expected) throw new RpcError("artifact download ended at an unexpected length", { code: "invalid_response" });
  }

  async _request(target, method, body) {
    const headers = { Accept: "application/json" };
    if (this.endpoint.protocol === "https:") headers.Authorization = `Bearer ${this.token}`;
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(body.length);
    }
    const transport = this.endpoint.protocol === "https:" ? https : http;
    return await new Promise((resolve, reject) => {
      let responseStarted = false;
      const request = transport.request(target, {
        method,
        headers,
        ca: this.ca,
        rejectUnauthorized: true,
        maxHeaderSize: 16 * 1024,
        timeout: this.timeoutMs,
      }, (response) => {
        responseStarted = true;
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          response.resume();
          reject(new RpcError(`server returned HTTP ${status}; redirects are forbidden`, { status, code: "redirect_forbidden" }));
        } else resolve(response);
      });
      request.on("timeout", () => request.destroy(new Error("endpoint timeout")));
      request.on("error", (error) => reject(new RpcError(redact(error.message, [this.token]), {
        code: "transport_error",
        uncertain: method !== "GET" && !responseStarted,
        cause: error,
      })));
      request.end(body);
    });
  }
}

function responseError(status, payload, token) {
  const code = typeof payload?.error?.code === "string" ? redact(payload.error.code, [token]) : `http_${status ?? 0}`;
  const message = typeof payload?.error?.message === "string" ? redact(payload.error.message, [token]) : "request rejected";
  return new RpcError(`${code}: ${message} (HTTP ${status ?? 0})`, { status, code, details: redactJson(payload?.error?.details, token) });
}

function redactJson(value, token) {
  if (typeof value === "string") return redact(value, [token]);
  if (Array.isArray(value)) return value.map((entry) => redactJson(entry, token));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactJson(entry, token)]));
  return value;
}

function httpOperation(operation, args) {
  const identity = args.identity;
  const requestPath = identity ? `/v2/requests/${encodeURIComponent(identity.requestId)}` : undefined;
  const query = identity ? routeIdentity(identity) : undefined;
  switch (operation) {
    case "session": return { method: "GET", route: "/v2/session" };
    case "submit": return { method: "POST", route: "/v2/requests", body: args.request, maxRequestBytes: LIMITS.requestBytes };
    case "request": return { method: "GET", route: `${requestPath}?${query}` };
    case "cancel": return { method: "POST", route: `${requestPath}/cancel`, body: { instanceId: identity.instanceId, generation: identity.generation } };
    case "toolCalls": return { method: "GET", route: `${requestPath}/tool-calls?${query}` };
    case "toolCall": return { method: "GET", route: `${requestPath}/tool-calls/${encodeURIComponent(args.callId)}?${query}` };
    case "claim": return { method: "POST", route: `${requestPath}/tool-calls/${encodeURIComponent(args.callId)}/claim`, body: { instanceId: identity.instanceId, generation: identity.generation, ...args.claim } };
    case "toolResult": return { method: "POST", route: `${requestPath}/tool-calls/${encodeURIComponent(args.callId)}/result`, body: { instanceId: identity.instanceId, generation: identity.generation, ...args.reply }, maxRequestBytes: LIMITS.resultBytes + 64 * 1024 };
    case "events": return { method: "GET", route: `${requestPath}/events?${query}&after=${args.after}` };
    case "artifacts": return { method: "GET", route: `${requestPath}/artifacts?${query}` };
    default: throw new RpcError(`unknown client operation: ${operation}`, { code: "invalid_client_argument" });
  }
}

function quoteRemote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function validateSshOptions(options = {}, { allowSessionId = false } = {}) {
  plainObject(options, "SSH options");
  if (Object.hasOwn(options, "instanceId")) {
    throw new RpcError("instanceId is not a public SSH selector; use sessionId", { code: "invalid_client_argument" });
  }
  const { host, sessionId, remoteCli, ca, sshPath = "ssh" } = options;
  if (typeof host !== "string" || isIP(host) === 0) throw new RpcError("SSH host must be a literal IPv4 or IPv6 address", { code: "invalid_ssh_host" });
  if (!allowSessionId && sessionId !== undefined) throw new RpcError("sessionId is valid only when constructing SshRpcClient", { code: "invalid_client_argument" });
  if (allowSessionId && sessionId !== undefined && (typeof sessionId !== "string" || sessionId.length === 0)) {
    throw new RpcError("sessionId must be a non-empty string", { code: "invalid_client_argument" });
  }
  if (remoteCli !== undefined && (typeof remoteCli !== "string" || !remoteCli.startsWith("/") || remoteCli.includes("\n") || remoteCli.includes("\r"))) {
    throw new RpcError("remoteCli must be an absolute remote path", { code: "invalid_client_argument" });
  }
  if (ca !== undefined && (typeof ca !== "string" || !ca.startsWith("/") || ca.includes("\n") || ca.includes("\r"))) {
    throw new RpcError("SSH CA must be an absolute path on the remote machine", { code: "invalid_client_argument" });
  }
  if (typeof sshPath !== "string" || sshPath.length === 0 || (!isAbsolute(sshPath) && sshPath.includes("/"))) {
    throw new RpcError("sshPath must be a command name or absolute local path", { code: "invalid_client_argument" });
  }
  return { host, sessionId, remoteCli, ca, sshPath };
}

function remoteCliCommand(options, relay = true) {
  const cli = options.remoteCli ? quoteRemote(options.remoteCli) : '"$HOME/.omp/plugins/node_modules/omp-lan-rpc/cli.mjs"';
  const args = relay
    ? ["relay", "--instance", options.instanceId, "--machine", options.host, ...(options.ca ? ["--ca", options.ca] : [])]
    : ["list"];
  return `${REMOTE_PATH}exec node ${cli} ${args.map(quoteRemote).join(" ")}`;
}

function spawnSsh(options, command) {
  return spawn(options.sshPath, [...SSH_OPTIONS, options.host, command], { stdio: ["pipe", "pipe", "pipe"] });
}

async function runSshJson(options, payload, relay = true) {
  const input = payload === undefined ? undefined : encodeJson(payload, MAX_RELAY_INPUT_BYTES, "SSH relay input");
  const child = spawnSsh(options, remoteCliCommand(options, relay));
  const completed = waitChild(child);
  const uncertain = payload !== undefined && ["submit", "claim", "toolResult", "cancel"].includes(payload.operation);
  const stdout = [];
  let stdoutBytes = 0;
  child.stdout.on("data", (chunk) => {
    stdoutBytes += chunk.length;
    if (stdoutBytes > MAX_JSON_RESPONSE_BYTES) child.kill();
    else stdout.push(chunk);
  });
  child.stderr.resume();
  child.stdin.on("error", () => {});
  if (input === undefined) child.stdin.end();
  else child.stdin.end(input);
  const { code, spawnError } = await completed;
  if (spawnError) throw new RpcError("unable to start OpenSSH", { code: "ssh_failed", uncertain, cause: spawnError });
  if (stdoutBytes > MAX_JSON_RESPONSE_BYTES) throw new RpcError("SSH relay JSON exceeds the client safety limit", { code: "response_too_large", uncertain });
  let value;
  try { value = JSON.parse(Buffer.concat(stdout, stdoutBytes).toString("utf8")); } catch {
    throw new RpcError(`SSH relay failed (exit ${code ?? "unknown"}); verify host trust, authentication, remote Node/plugin path, and remote CA`, { code: "ssh_failed", uncertain });
  }
  if (code !== 0) {
    if (value?.error && typeof value.error.code === "string") {
      throw new RpcError(`${redact(value.error.code)}: ${redact(value.error.message)}`, { status: value.error.status, code: value.error.code, details: redactJson(value.error.details), uncertain: value.error.uncertain === true });
    }
    throw new RpcError(`SSH relay failed (exit ${code ?? "unknown"}); verify host trust, authentication, remote Node/plugin path, and remote CA`, { code: "ssh_failed", uncertain });
  }
  return value;
}

function waitChild(child) {
  return new Promise((resolve) => {
    let spawnError;
    child.once("error", (error) => { spawnError = error; });
    child.once("close", (code) => resolve({ code, spawnError }));
  });
}

function checkedLiveSshDescriptors(listing) {
  const live = listing.instances.filter((descriptor) => descriptor?.status === "live");
  for (const descriptor of live) {
    if (!UUID_PATTERN.test(descriptor.instanceId ?? "") || !Number.isSafeInteger(descriptor.generation) || descriptor.generation <= 0 || typeof descriptor.sessionId !== "string" || descriptor.sessionId.length === 0) {
      throw new RpcError("remote CLI returned invalid live instance metadata", { code: "invalid_response" });
    }
  }
  return live;
}

function requirePinnedIdentity(args, pinned) {
  const identity = args.identity ?? args.request;
  if (!identity) return;
  if (identity.instanceId !== pinned.instanceId) {
    throw new RpcError("request identity does not match the selected SSH instance", { code: "instance_mismatch" });
  }
  if (identity.generation !== pinned.generation) {
    throw new RpcError("request identity does not match the selected SSH generation", { code: "generation_mismatch" });
  }
}

function validatePinnedSshSession(value, descriptor) {
  const session = validateSession(value, descriptor.instanceId);
  if (session.generation !== descriptor.generation) {
    throw new RpcError("live SSH session generation changed after discovery", { code: "generation_mismatch" });
  }
  if (session.sessionId !== descriptor.sessionId) {
    throw new RpcError("live SSH session does not match the selected sessionId", { code: "session_mismatch" });
  }
  return session;
}

export class SshRpcClient extends Operations {
  constructor(options = {}) {
    super();
    const { sessionId, ...ssh } = validateSshOptions(options, { allowSessionId: true });
    this.ssh = ssh;
    this.sessionId = sessionId;
    this.resolution = undefined;
  }

  async _resolve() {
    this.resolution ??= this._discoverAndPin();
    return await this.resolution;
  }

  async _discoverAndPin() {
    const listing = await listSshInstances(this.ssh);
    const live = checkedLiveSshDescriptors(listing);
    const matches = this.sessionId === undefined ? live : live.filter((descriptor) => descriptor.sessionId === this.sessionId);
    if (matches.length === 0) {
      throw new RpcError(this.sessionId === undefined ? "no live SSH session was discovered" : "selected SSH session was not found", { code: "session_not_found" });
    }
    if (matches.length !== 1) {
      const code = this.sessionId === undefined ? "session_selection_required" : "session_ambiguous";
      throw new RpcError(this.sessionId === undefined ? "multiple live SSH sessions require an explicit sessionId" : "multiple live SSH instances report the selected sessionId", { code });
    }
    const descriptor = matches[0];
    const ssh = { ...this.ssh, instanceId: descriptor.instanceId };
    validatePinnedSshSession(await runSshJson(ssh, { operation: "session" }), descriptor);
    this.expectedInstanceId = descriptor.instanceId;
    return { ssh, descriptor };
  }

  async _call(operation, args) {
    const resolved = await this._resolve();
    if (operation === "session") {
      return validatePinnedSshSession(await runSshJson(resolved.ssh, { operation: "session" }), resolved.descriptor);
    }
    requirePinnedIdentity(args, resolved.descriptor);
    return await runSshJson(resolved.ssh, { operation, ...args });
  }

  async _download(identity, artifactId, outputPath) {
    return await writeExclusive(outputPath, async (writable) => {
      await this._downloadTo(identity, artifactId, writable);
    });
  }

  async _downloadTo(identity, artifactId, writable) {
    const resolved = await this._resolve();
    requirePinnedIdentity({ identity }, resolved.descriptor);
    const payload = encodeJson({ operation: "download", identity, artifactId }, MAX_RELAY_INPUT_BYTES, "SSH relay input");
    const child = spawnSsh(resolved.ssh, remoteCliCommand(resolved.ssh, true));
    const completed = waitChild(child);
    child.stderr.resume();
    child.stdin.on("error", () => {});
    child.stdin.end(payload);
    let received = 0;
    const counter = new Transform({ transform(chunk, _encoding, callback) {
      received += chunk.length;
      if (received > LIMITS.artifactBytes) callback(new RpcError("SSH artifact exceeds the client safety limit", { code: "response_too_large" }));
      else callback(null, chunk);
    } });
    const transfer = pipeline(child.stdout, counter, writable);
    const [{ code, spawnError }] = await Promise.all([completed, transfer]);
    if (spawnError) throw new RpcError("unable to start OpenSSH", { code: "ssh_failed", cause: spawnError });
    if (code !== 0) throw new RpcError(`SSH artifact relay failed (exit ${code ?? "unknown"}); no partial file was retained`, { code: "ssh_failed" });
  }
}

export async function listSshInstances(options = {}) {
  const { sessionId: _sessionId, ...ssh } = validateSshOptions(options);
  const value = plainObject(await runSshJson(ssh, undefined, false), "remote instance list");
  if (!Array.isArray(value.instances)) throw new RpcError("remote CLI returned an invalid instance list", { code: "invalid_response" });
  return value;
}
