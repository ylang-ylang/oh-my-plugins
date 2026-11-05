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
test("SSH transport uses verified BatchMode relay for JSON and raw artifact bytes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "lan-rpc-ssh-sdk-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fakeSsh = join(root, "ssh");
  const capture = join(root, "capture.ndjson");
  const output = join(root, "artifact.bin");
  await writeFile(fakeSsh, `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
(async () => {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const input = Buffer.concat(chunks).toString("utf8");
  appendFileSync(process.env.SSH_CAPTURE, JSON.stringify({ args: process.argv.slice(2), input }) + "\\n");
  const payload = JSON.parse(input);
  if (payload.operation === "download") process.stdout.write(Buffer.from([0, 1, 2, 255]));
  else process.stdout.write(JSON.stringify({ protocolVersion: 2, instanceId: "${INSTANCE}", generation: 7, sessionId: "ssh", cwd: "/remote", busy: false, queueDepth: 0, capabilities: {} }));
})();
`, { mode: 0o700 });
  await chmod(fakeSsh, 0o700);
  const previous = process.env.SSH_CAPTURE;
  process.env.SSH_CAPTURE = capture;
  t.after(() => {
    if (previous === undefined) delete process.env.SSH_CAPTURE;
    else process.env.SSH_CAPTURE = previous;
  });

  const client = new SshRpcClient({ host: "192.0.2.44", instanceId: INSTANCE, sshPath: fakeSsh, remoteCli: "/opt/omp cli/cli.mjs" });
  assert.equal((await client.session()).sessionId, "ssh");
  await client.download({ instanceId: INSTANCE, generation: 7, requestId: "job" }, ARTIFACT_ID, output);
  assert.deepEqual(await readFile(output), Buffer.from([0, 1, 2, 255]));

  const invocations = (await readFile(capture, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(invocations.length, 2);
  for (const invocation of invocations) {
    assert.ok(invocation.args.includes("BatchMode=yes"));
    assert.ok(invocation.args.includes("StrictHostKeyChecking=yes"));
    assert.ok(invocation.args.includes("192.0.2.44"));
    assert.equal(invocation.args.includes("-p"), false);
    assert.equal(invocation.args.includes("-J"), false);
    assert.equal(invocation.input.includes("token"), false);
    assert.equal(invocation.input.includes("endpoint"), false);
  }
  assert.deepEqual(JSON.parse(invocations[0].input), { operation: "session" });
  assert.equal(JSON.parse(invocations[1].input).operation, "download");
  assert.throws(() => new SshRpcClient({ host: "unverified-alias", instanceId: INSTANCE }), (error) => error.code === "invalid_ssh_host");
});
