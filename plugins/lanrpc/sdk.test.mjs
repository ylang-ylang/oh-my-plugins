import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { RpcClient, RpcError, SshRpcClient } from "./sdk.mjs";

const execute = promisify(execFile);

const INSTANCE = "11111111-1111-4111-8111-111111111111";
const OTHER_INSTANCE = "22222222-2222-4222-8222-222222222222";
const CALL_ID = "33333333-3333-4333-8333-333333333333";
const ARTIFACT_ID = "44444444-4444-4444-8444-444444444444";

async function listen(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

function json(response, status, value) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}

async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

test("HTTP policy rejects plaintext LAN and redirects without following", async (t) => {
  assert.throws(() => new RpcClient({ endpoint: "http://localhost:4312" }), (error) => error instanceof RpcError && error.code === "http_not_allowed");
  assert.throws(() => new RpcClient({ endpoint: "http://192.0.2.9:4312" }), (error) => error instanceof RpcError && error.code === "http_not_allowed");
  assert.throws(() => new RpcClient({ endpoint: "http://127.0.0.1:4312", token: "must-not-send" }), (error) => error instanceof RpcError && error.code === "token_forbidden");
  assert.throws(() => new RpcClient({ endpoint: "http://127.0.0.1:4312", ca: "unused" }), (error) => error instanceof RpcError && error.code === "ca_forbidden");

  let targetRequests = 0;
  const target = await listen(t, (_request, response) => {
    targetRequests += 1;
    json(response, 200, { protocolVersion: 2, instanceId: INSTANCE, generation: 7 });
  });
  const redirector = await listen(t, (_request, response) => {
    response.writeHead(307, { Location: target });
    response.end();
  });
  const client = new RpcClient({ endpoint: redirector });
  await assert.rejects(client.session(), (error) => error instanceof RpcError && error.code === "redirect_forbidden");
  assert.equal(targetRequests, 0);
});


test("HTTPS verification remains mandatory and authenticated errors redact the bearer token", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "lan-rpc-tls-sdk-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cert = join(root, "server.crt");
  const key = join(root, "server.key");
  try {
    await execute("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", cert]);
  } catch (error) {
    if (error.code === "ENOENT") return t.skip("OpenSSL is not installed");
    throw error;
  }
  const token = "synthetic-secret-token";
  let handled = 0;
  const server = createHttpsServer({ cert: await readFile(cert), key: await readFile(key) }, (request, response) => {
    handled += 1;
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    if (request.url === "/v2/session") return json(response, 200, { protocolVersion: 2, instanceId: INSTANCE, generation: 7 });
    return json(response, 500, { error: { code: "host_failed", message: `failed ${token}`, details: { trace: token } } });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const endpoint = `https://127.0.0.1:${server.address().port}`;
  await assert.rejects(new RpcClient({ endpoint, token, allowHttp: true }).session());
  assert.equal(handled, 0);

  const client = new RpcClient({ endpoint, token, ca: await readFile(cert), allowHttp: true });
  assert.equal((await client.session()).instanceId, INSTANCE);
  await assert.rejects(client.request({ instanceId: INSTANCE, generation: 7, requestId: "job" }), (error) => {
    assert.equal(error.code, "host_failed");
    assert.equal(error.message.includes(token), false);
    assert.equal(JSON.stringify(error.details).includes(token), false);
    return true;
  });
});
test("response identities are immutable across request and tool APIs", async (t) => {
  const endpoint = await listen(t, (request, response) => {
    const url = new URL(request.url, "http://fixture");
    if (url.pathname.endsWith("/tool-calls")) {
      return json(response, 200, { toolCalls: [{ instanceId: OTHER_INSTANCE, generation: 7, requestId: "job", toolCallId: CALL_ID, state: "pending" }] });
    }
    return json(response, 200, { instanceId: OTHER_INSTANCE, generation: 7, requestId: "job", state: "running" });
  });
  const client = new RpcClient({ endpoint });
  const identity = { instanceId: INSTANCE, generation: 7, requestId: "job" };
  await assert.rejects(client.request(identity), (error) => error.code === "instance_mismatch");
  await assert.rejects(client.toolCalls(identity), (error) => error.code === "instance_mismatch");
});

async function toolFixture(t, {
  loseFirstResultResponse = false,
  leaseDurationMs = 30_000,
  completeOnClaim = false,
  replayPendingAfterResult = false,
  rejectResult = false,
} = {}) {
  let toolState = "pending";
  let requestState = "running";
  let acceptedOutcome;
  let resultPosts = 0;
  let getsAfterResult = 0;
  let cancelPosts = 0;
  const requests = [];
  const endpoint = await listen(t, async (request, response) => {
    const url = new URL(request.url, "http://fixture");
    const record = () => ({ instanceId: INSTANCE, generation: 7, sessionId: "fixture", requestId: "job", responseMode: "structured", state: requestState });
    const tool = () => ({
      instanceId: INSTANCE,
      generation: 7,
      sessionId: "fixture",
      requestId: "job",
      toolCallId: CALL_ID,
      name: "lookup_item",
      arguments: { id: 42 },
      state: toolState,
      createdAt: 1,
      updatedAt: 1,
      deadlineAt: Date.now() + 60_000,
      ...(toolState === "claimed" ? { workerId: requests.at(-1)?.workerId, claimId: requests.at(-1)?.claimId, leaseId: "lease-fixture", leaseExpiresAt: Date.now() + leaseDurationMs } : {}),
      ...(toolState === "completed" ? { outcome: acceptedOutcome } : {}),
    });

    if (request.method === "POST" && url.pathname === "/v2/requests") {
      requests.push(await body(request));
      return json(response, 202, record());
    }
    if (request.method === "GET" && url.pathname === "/v2/requests/job") {
      if (replayPendingAfterResult && resultPosts > 0 && ++getsAfterResult >= 3) requestState = "completed";
      return json(response, 200, requestState === "completed" ? { ...record(), result: { title: "Example" } } : record());
    }
    if (request.method === "GET" && url.pathname.endsWith("/events")) {
      const after = Number(url.searchParams.get("after"));
      return json(response, 200, { events: after === 0 ? [{ sequence: 1, at: 1, type: "native", data: { kind: "thinking", text: "raw" } }] : [], nextSequence: 1 });
    }
    if (request.method === "GET" && url.pathname.endsWith("/tool-calls")) return json(response, 200, { toolCalls: [tool()] });
    if (request.method === "GET" && url.pathname.endsWith(`/tool-calls/${CALL_ID}`)) return json(response, 200, tool());
    if (request.method === "POST" && url.pathname.endsWith("/claim")) {
      const claim = await body(request);
      requests.push(claim);
      toolState = "claimed";
      if (completeOnClaim) requestState = "completed";
      return json(response, 200, tool());
    }
    if (request.method === "POST" && url.pathname.endsWith("/result")) {
      resultPosts += 1;
      const reply = await body(request);
      if (rejectResult) return json(response, 422, { error: { code: "schema_validation", message: "caller tool result is invalid", details: { errors: [{ keyword: "required" }] } } });
      acceptedOutcome = reply.outcome;
      if (replayPendingAfterResult) toolState = "pending";
      else {
        toolState = "completed";
        requestState = "completed";
      }
      if (loseFirstResultResponse && resultPosts === 1) return request.socket.destroy();
      return json(response, 200, tool());
    }
    if (request.method === "POST" && url.pathname.endsWith("/cancel")) {
      cancelPosts += 1;
      requestState = "cancelled";
      return json(response, 200, record());
    }
    json(response, 404, { error: { code: "not_found", message: "missing" } });
  });
  return {
    endpoint,
    get acceptedOutcome() { return acceptedOutcome; },
    get resultPosts() { return resultPosts; },
    get claims() { return requests.filter((value) => typeof value.workerId === "string"); },
    get cancelPosts() { return cancelPosts; },
  };
}

test("run pumps raw events and caller tools before awaiting the structured result", async (t) => {
  const fixture = await toolFixture(t);
  const client = new RpcClient({ endpoint: fixture.endpoint });
  let handlerCalls = 0;
  const events = [];
  const record = await client.run({
    instanceId: INSTANCE,
    generation: 7,
    requestId: "job",
    message: "Use lookup_item and submit rpc_result.",
    responseMode: "structured",
    resultSchema: { type: "object" },
    tools: [{ name: "lookup_item", description: "lookup", inputSchema: { type: "object" }, resultSchema: { type: "object" } }],
  }, {
    pollMs: 25,
    handlers: { lookup_item: async (arguments_) => { handlerCalls += 1; return { title: `item-${arguments_.id}` }; } },
    onEvent: (event) => events.push(event),
  });
  assert.equal(record.state, "completed");
  assert.equal(handlerCalls, 1);
  assert.deepEqual(fixture.acceptedOutcome, { status: "completed", result: { title: "item-42" } });
  assert.deepEqual(events[0].data, { kind: "thinking", text: "raw" });
});

test("an uncertain tool-result response is recovered without executing the handler again", async (t) => {
  const fixture = await toolFixture(t, { loseFirstResultResponse: true });
  const client = new RpcClient({ endpoint: fixture.endpoint });
  let handlerCalls = 0;
  const record = await client.run({
    instanceId: INSTANCE,
    generation: 7,
    requestId: "job",
    message: "Use the tool.",
    responseMode: "structured",
    resultSchema: { type: "object" },
    tools: [{ name: "lookup_item", description: "lookup", inputSchema: { type: "object" }, resultSchema: { type: "object" } }],
  }, {
    pollMs: 25,
    handlers: { lookup_item: async () => { handlerCalls += 1; return { title: "once" }; } },
  });
  assert.equal(record.state, "completed");
  assert.equal(handlerCalls, 1);
  assert.equal(fixture.resultPosts, 1);
});

test("run renews the same claim while a caller handler is still running", async (t) => {
  const fixture = await toolFixture(t, { leaseDurationMs: 60 });
  const client = new RpcClient({ endpoint: fixture.endpoint });
  const record = await client.run({
    instanceId: INSTANCE,
    generation: 7,
    requestId: "job",
    message: "Use the tool.",
    responseMode: "structured",
    resultSchema: { type: "object" },
    tools: [{ name: "lookup_item", description: "lookup", inputSchema: { type: "object" }, resultSchema: { type: "object" } }],
  }, {
    pollMs: 25,
    handlers: { lookup_item: async () => {
      await new Promise((resolve) => setTimeout(resolve, 140));
      return { title: "renewed" };
    } },
  });
  assert.equal(record.state, "completed");
  assert.ok(fixture.claims.length >= 2);
  assert.equal(fixture.claims[0].renew, undefined);
  assert.ok(fixture.claims.slice(1).every((claim) => claim.renew === true));
  assert.ok(fixture.claims.every((claim) => claim.workerId === fixture.claims[0].workerId && claim.claimId === fixture.claims[0].claimId));
});


test("run keeps pumping a queued native request until execution completes", async (t) => {
  let submitted;
  let requestPolls = 0;
  const queueDeadlineAt = 10_000;
  const record = (state) => ({
    instanceId: INSTANCE,
    generation: 7,
    sessionId: "fixture",
    requestId: "queued_native",
    responseMode: "native",
    state,
    createdAt: 1,
    updatedAt: state === "queued" ? 1 : 5_000,
    queueDeadlineAt,
    deadlineAt: state === "queued" ? queueDeadlineAt : 6_000,
    ...(state === "queued" ? {} : { startedAt: 5_000 }),
    ...(state === "completed" ? { completedAt: 5_100, result: [{ role: "assistant", content: [{ type: "text", text: "done" }] }] } : {}),
  });
  const endpoint = await listen(t, async (request, response) => {
    const url = new URL(request.url, "http://fixture");
    if (request.method === "POST" && url.pathname === "/v2/requests") {
      submitted = await body(request);
      return json(response, 202, record("queued"));
    }
    if (request.method === "GET" && url.pathname === "/v2/requests/queued_native") {
      requestPolls += 1;
      return json(response, 200, record(requestPolls === 1 ? "queued" : requestPolls === 2 ? "running" : "completed"));
    }
    if (request.method === "GET" && url.pathname.endsWith("/events")) {
      const after = Number(url.searchParams.get("after"));
      const events = requestPolls >= 2 && after === 0 ? [{ sequence: 1, at: 5_050, type: "native", data: { kind: "text", text: "done" } }] : [];
      return json(response, 200, { events, nextSequence: events.length ? 1 : after });
    }
    if (request.method === "GET" && url.pathname.endsWith("/tool-calls")) return json(response, 200, { toolCalls: [] });
    json(response, 404, { error: { code: "not_found", message: "missing" } });
  });
  const events = [];
  const completed = await new RpcClient({ endpoint }).run({
    instanceId: INSTANCE,
    generation: 7,
    requestId: "queued_native",
    message: "wait, then run",
    responseMode: "native",
    queueTimeoutMs: 1_000,
    timeoutMs: 1_000,
  }, { pollMs: 25, onEvent: (event) => events.push(event) });

  assert.equal(submitted.queueTimeoutMs, 1_000);
  assert.equal(submitted.timeoutMs, 1_000);
  assert.equal(requestPolls, 3);
  assert.equal(completed.state, "completed");
  assert.equal(completed.queueDeadlineAt, queueDeadlineAt);
  assert.equal(completed.startedAt, 5_000);
  assert.deepEqual(events.map((event) => event.data), [{ kind: "text", text: "done" }]);
});

test("run drains native events even when submit returns a terminal record", async (t) => {
  const endpoint = await listen(t, async (request, response) => {
    const url = new URL(request.url, "http://fixture");
    if (request.method === "POST" && url.pathname === "/v2/requests") {
      const submitted = await body(request);
      return json(response, 202, { instanceId: INSTANCE, generation: 7, sessionId: "fixture", requestId: submitted.requestId, responseMode: "native", state: "completed", result: [{ role: "assistant", content: [{ type: "thinking", text: "raw-final" }] }] });
    }
    if (request.method === "GET" && url.pathname.endsWith("/events")) {
      return json(response, 200, { events: [{ sequence: 1, at: 1, type: "native", data: { kind: "thinking", text: "raw-final" } }], nextSequence: 1 });
    }
    json(response, 404, { error: { code: "not_found", message: "missing" } });
  });
  const events = [];
  const record = await new RpcClient({ endpoint }).run({
    instanceId: INSTANCE,
    generation: 7,
    requestId: "native_terminal",
    message: "native",
    responseMode: "native",
  }, { onEvent: (event) => events.push(event) });
  assert.equal(record.state, "completed");
  assert.deepEqual(events.map((event) => event.data), [{ kind: "thinking", text: "raw-final" }]);
});

test("run cancels the server when its signal interrupts the polling delay", async (t) => {
  const fixture = await toolFixture(t);
  const controller = new AbortController();
  const running = new RpcClient({ endpoint: fixture.endpoint }).run({
    instanceId: INSTANCE,
    generation: 7,
    requestId: "job",
    message: "wait",
    responseMode: "native",
  }, { signal: controller.signal, pollMs: 1000 });
  setTimeout(() => controller.abort(new Error("caller stopped")), 50);
  await assert.rejects(running, /caller stopped/);
  assert.equal(fixture.cancelPosts, 1);
});

test("terminal completion does not wait for a handler that ignores AbortSignal", async (t) => {
  const fixture = await toolFixture(t, { completeOnClaim: true });
  const running = new RpcClient({ endpoint: fixture.endpoint }).run({
    instanceId: INSTANCE,
    generation: 7,
    requestId: "job",
    message: "finish while handler runs",
    responseMode: "structured",
    resultSchema: { type: "object" },
    tools: [{ name: "lookup_item", description: "lookup", inputSchema: { type: "object" }, resultSchema: { type: "object" } }],
  }, { pollMs: 25, handlers: { lookup_item: () => new Promise(() => {}) } });
  let timer;
  try {
    const record = await Promise.race([
      running,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("run remained blocked on handler")), 500); }),
    ]);
    assert.equal(record.state, "completed");
  } finally {
    clearTimeout(timer);
  }
});

test("a stale pending snapshot never executes the same tool call twice", async (t) => {
  const fixture = await toolFixture(t, { replayPendingAfterResult: true });
  let executions = 0;
  const record = await new RpcClient({ endpoint: fixture.endpoint }).run({
    instanceId: INSTANCE,
    generation: 7,
    requestId: "job",
    message: "deduplicate",
    responseMode: "structured",
    resultSchema: { type: "object" },
    tools: [{ name: "lookup_item", description: "lookup", inputSchema: { type: "object" }, resultSchema: { type: "object" } }],
  }, { pollMs: 25, handlers: { lookup_item: async () => { executions += 1; return { title: "once" }; } } });
  assert.equal(record.state, "completed");
  assert.equal(executions, 1);
  assert.equal(fixture.resultPosts, 1);
});

test("tool result schema rejection remains an explicit SDK error", async (t) => {
  const fixture = await toolFixture(t, { rejectResult: true });
  await assert.rejects(new RpcClient({ endpoint: fixture.endpoint }).run({
    instanceId: INSTANCE,
    generation: 7,
    requestId: "job",
    message: "invalid callback result",
    responseMode: "structured",
    resultSchema: { type: "object" },
    tools: [{ name: "lookup_item", description: "lookup", inputSchema: { type: "object" }, resultSchema: { type: "object" } }],
  }, { pollMs: 25, handlers: { lookup_item: async () => ({ wrong: true }) } }), (error) => {
    assert.equal(error.code, "schema_validation");
    assert.deepEqual(error.details, { errors: [{ keyword: "required" }] });
    return true;
  });
});
function sshDescriptor(instanceId, sessionId, generation = 7) {
  return { instanceId, generation, sessionId, status: "live", pid: 1234, endpoint: "http://127.0.0.1:43120" };
}

function sshSession(instanceId, sessionId, generation = 7) {
  return { protocolVersion: 2, instanceId, generation, sessionId, cwd: `/remote/${sessionId}`, busy: false, queueDepth: 0, capabilities: {} };
}

async function fakeSshFixture(t, initial) {
  const root = await mkdtemp(join(tmpdir(), "lan-rpc-ssh-sdk-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sshPath = join(root, "ssh");
  const capture = join(root, "capture.ndjson");
  const scenario = join(root, "scenario.json");
  await writeFile(scenario, JSON.stringify(initial));
  await writeFile(sshPath, `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require("node:fs");
(async () => {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const input = Buffer.concat(chunks).toString("utf8");
  const command = process.argv.at(-1);
  appendFileSync(${JSON.stringify(capture)}, JSON.stringify({ args: process.argv.slice(2), command, input }) + "\\n");
  const config = JSON.parse(readFileSync(${JSON.stringify(scenario)}, "utf8"));
  if (!input) {
    process.stdout.write(JSON.stringify(config.listing));
    return;
  }
  const payload = JSON.parse(input);
  const instanceId = Object.keys(config.sessions).find((candidate) => command.includes("'" + candidate + "'"));
  const session = instanceId === undefined ? undefined : config.sessions[instanceId];
  if (!session) {
    process.stdout.write(JSON.stringify({ error: { code: "instance_not_found", message: "pinned instance is gone" } }));
    process.exitCode = 1;
    return;
  }
  if (payload.operation === "download") {
    process.stdout.write(Buffer.from(config.artifact ?? [0, 1, 2, 255]));
    return;
  }
  if (payload.operation === "session") {
    process.stdout.write(JSON.stringify(session));
    return;
  }
  const identity = payload.identity ?? payload.request;
  process.stdout.write(JSON.stringify({ ...identity, sessionId: session.sessionId, responseMode: payload.request?.responseMode ?? "native", state: "running" }));
})();
`, { mode: 0o700 });
  await chmod(sshPath, 0o700);
  return {
    root,
    sshPath,
    async writeState(value) { await writeFile(scenario, JSON.stringify(value)); },
    async invocations() {
      try { return (await readFile(capture, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse); }
      catch (error) { if (error.code === "ENOENT") return []; throw error; }
    },
  };
}

test("SSH session selection rejects obsolete selectors, missing sessions, and wrong live metadata", async (t) => {
  assert.throws(() => new SshRpcClient({ host: "192.0.2.44", instanceId: INSTANCE }), (error) => error.code === "invalid_client_argument");
  assert.throws(() => new SshRpcClient({ host: "192.0.2.44", sessionId: "" }), (error) => error.code === "invalid_client_argument");
  assert.throws(() => new SshRpcClient({ host: "unverified-alias", sessionId: "ssh" }), (error) => error.code === "invalid_ssh_host");

  const descriptor = sshDescriptor(INSTANCE, "ssh");
  const fixture = await fakeSshFixture(t, { listing: { instances: [descriptor] }, sessions: { [INSTANCE]: sshSession(INSTANCE, "ssh") } });
  const missing = new SshRpcClient({ host: "192.0.2.44", sessionId: "missing", sshPath: fixture.sshPath });
  await assert.rejects(missing.session(), (error) => error.code === "session_not_found");
  await assert.rejects(missing.session(), (error) => error.code === "session_not_found");
  assert.equal((await fixture.invocations()).length, 1);

  await fixture.writeState({ listing: { instances: [descriptor] }, sessions: { [INSTANCE]: sshSession(INSTANCE, "different") } });
  await assert.rejects(new SshRpcClient({ host: "192.0.2.44", sessionId: "ssh", sshPath: fixture.sshPath }).session(), (error) => error.code === "session_mismatch");
});

test("SSH discovery rejects ambiguous selection and supports unambiguous IP-only selection", async (t) => {
  const duplicate = await fakeSshFixture(t, {
    listing: { instances: [sshDescriptor(INSTANCE, "shared"), sshDescriptor(OTHER_INSTANCE, "shared")] },
    sessions: { [INSTANCE]: sshSession(INSTANCE, "shared"), [OTHER_INSTANCE]: sshSession(OTHER_INSTANCE, "shared") },
  });
  await assert.rejects(new SshRpcClient({ host: "192.0.2.44", sessionId: "shared", sshPath: duplicate.sshPath }).session(), (error) => error.code === "session_ambiguous");
  await assert.rejects(new SshRpcClient({ host: "192.0.2.44", sshPath: duplicate.sshPath }).session(), (error) => error.code === "session_selection_required");
  assert.equal((await duplicate.invocations()).every((invocation) => invocation.input === ""), true);

  const single = await fakeSshFixture(t, {
    listing: { instances: [sshDescriptor(INSTANCE, "custom/session:alpha")] },
    sessions: { [INSTANCE]: sshSession(INSTANCE, "custom/session:alpha") },
  });
  const session = await new SshRpcClient({ host: "192.0.2.44", sshPath: single.sshPath }).session();
  assert.equal(session.sessionId, "custom/session:alpha");
});

test("SSH resolution is shared concurrently and keeps relay bytes and credentials private", async (t) => {
  const fixture = await fakeSshFixture(t, {
    listing: { instances: [sshDescriptor(INSTANCE, "ssh")] },
    sessions: { [INSTANCE]: sshSession(INSTANCE, "ssh") },
    artifact: [0, 1, 2, 255],
  });
  const output = join(fixture.root, "artifact.bin");
  const client = new SshRpcClient({ host: "192.0.2.44", sessionId: "ssh", sshPath: fixture.sshPath, remoteCli: "/opt/omp cli/cli.mjs" });
  const identity = { instanceId: INSTANCE, generation: 7, requestId: "job" };
  const [session, record] = await Promise.all([client.session(), client.request(identity)]);
  assert.equal(session.sessionId, "ssh");
  assert.equal(record.requestId, "job");
  const submitted = await client.submit({ ...identity, message: "queued over SSH", responseMode: "native", queueTimeoutMs: 7_000, timeoutMs: 2_000 });
  assert.equal(submitted.queueTimeoutMs, 7_000);
  await client.download(identity, ARTIFACT_ID, output);
  assert.deepEqual(await readFile(output), Buffer.from([0, 1, 2, 255]));

  const invocations = await fixture.invocations();
  assert.equal(invocations.filter((invocation) => invocation.input === "").length, 1);
  assert.equal(invocations.filter((invocation) => JSON.parse(invocation.input || "null")?.operation === "session").length, 2);
  assert.equal(invocations.filter((invocation) => JSON.parse(invocation.input || "null")?.operation === "request").length, 1);
  const submitInvocation = invocations.find((invocation) => JSON.parse(invocation.input || "null")?.operation === "submit");
  assert.equal(JSON.parse(submitInvocation.input).request.queueTimeoutMs, 7_000);
  for (const invocation of invocations) {
    assert.ok(invocation.args.includes("BatchMode=yes"));
    assert.ok(invocation.args.includes("StrictHostKeyChecking=yes"));
    assert.ok(invocation.args.includes("192.0.2.44"));
    assert.equal(invocation.args.includes("-p"), false);
    assert.equal(invocation.args.includes("-J"), false);
    assert.equal(invocation.input.includes("token"), false);
    assert.equal(invocation.input.includes("endpoint"), false);
  }
  assert.match(invocations.at(-1).command, /'relay' '--instance' '11111111-1111-4111-8111-111111111111'/);
});

test("SSH client validates old identities before first operation and never rebinds after restart", async (t) => {
  const initial = { listing: { instances: [sshDescriptor(INSTANCE, "ssh")] }, sessions: { [INSTANCE]: sshSession(INSTANCE, "ssh") } };
  const fixture = await fakeSshFixture(t, initial);
  const wrong = new SshRpcClient({ host: "192.0.2.44", sessionId: "ssh", sshPath: fixture.sshPath });
  await assert.rejects(wrong.request({ instanceId: OTHER_INSTANCE, generation: 7, requestId: "old" }), (error) => error.code === "instance_mismatch");
  await assert.rejects(wrong.request({ instanceId: INSTANCE, generation: 6, requestId: "old" }), (error) => error.code === "generation_mismatch");
  assert.deepEqual((await fixture.invocations()).map((invocation) => invocation.input && JSON.parse(invocation.input).operation).filter(Boolean), ["session"]);

  const client = new SshRpcClient({ host: "192.0.2.44", sessionId: "ssh", sshPath: fixture.sshPath });
  const pinned = await client.session();
  const updated = { ...sshSession(INSTANCE, "ssh"), busy: true, queueDepth: 2 };
  await fixture.writeState({ listing: initial.listing, sessions: { [INSTANCE]: updated } });
  const refreshed = await client.session();
  assert.equal(refreshed.busy, true);
  assert.equal(refreshed.queueDepth, 2);
  await fixture.writeState({ listing: { instances: [sshDescriptor(OTHER_INSTANCE, "ssh", 8)] }, sessions: { [OTHER_INSTANCE]: sshSession(OTHER_INSTANCE, "ssh", 8) } });
  await assert.rejects(client.session(), (error) => error.code === "instance_not_found");
  await assert.rejects(client.request({ instanceId: pinned.instanceId, generation: pinned.generation, requestId: "old" }), (error) => error.code === "instance_not_found");
  const invocations = await fixture.invocations();
  assert.equal(invocations.filter((invocation) => invocation.input === "").length, 2);
  assert.match(invocations.at(-1).command, new RegExp(INSTANCE));
  assert.doesNotMatch(invocations.at(-1).command, new RegExp(OTHER_INSTANCE));
});

test("SSH demo accepts session IDs, lists cwd, and rejects the removed instance selector", async (t) => {
  const fixture = await fakeSshFixture(t, {
    listing: { instances: [sshDescriptor(INSTANCE, "custom/session:alpha")] },
    sessions: { [INSTANCE]: sshSession(INSTANCE, "custom/session:alpha") },
  });
  const environment = { ...process.env, PATH: `${fixture.root}:${process.env.PATH}` };
  const selected = await execute(process.execPath, [join(import.meta.dirname, "ssh-demo.mjs"), "192.0.2.44", "--session", "custom/session:alpha"], { env: environment });
  const output = JSON.parse(selected.stdout);
  assert.equal(output.sessionId, "custom/session:alpha");
  assert.equal(output.cwd, "/remote/custom/session:alpha");
  assert.equal("instanceId" in output, false);

  const listed = await execute(process.execPath, [join(import.meta.dirname, "ssh-demo.mjs"), "192.0.2.44", "--list"], { env: environment });
  const listing = JSON.parse(listed.stdout);
  assert.equal(listing.sessions[0].sessionId, "custom/session:alpha");
  assert.equal(listing.sessions[0].cwd, "/remote/custom/session:alpha");
  assert.equal("instanceId" in listing.sessions[0], false);

  await assert.rejects(execute(process.execPath, [join(import.meta.dirname, "ssh-demo.mjs"), "192.0.2.44", "--instance", INSTANCE], { env: environment }), (error) => {
    assert.match(error.stderr, /Unknown option: --instance/);
    return true;
  });
});
