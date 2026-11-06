import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";

const execute = promisify(execFile);
const CLI_URL = new URL("./cli.mjs", import.meta.url);
const CLI = fileURLToPath(CLI_URL);
const INSTANCE = "11111111-1111-4111-8111-111111111111";
const INSTANCE_2 = "22222222-2222-4222-8222-222222222222";
const INSTANCE_3 = "33333333-3333-4333-8333-333333333333";
const ARTIFACT = "44444444-4444-4444-8444-444444444444";

async function fixtureRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "lan-rpc-cli-"));
  await mkdir(join(root, "instances"), { mode: 0o700 });
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function listen(t, handler, host = "127.0.0.1") {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, host, resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return server;
}

async function writeDescriptor(root, endpoint, extra = {}) {
  const descriptor = { instanceId: INSTANCE, pid: process.pid, endpoint, generation: 7, sessionId: "fixture", ...extra };
  const path = join(root, "instances", `${descriptor.instanceId}.json`);
  await writeFile(path, JSON.stringify(descriptor), { mode: 0o600 });
  return path;
}

function run(root, args, options = {}) {
  return execute(process.execPath, [CLI, ...args], {
    env: { ...process.env, OMP_LAN_RPC_DIR: root },
    timeout: 10_000,
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
}
async function runMainError(root, args) {
  const script = `import { main } from ${JSON.stringify(CLI_URL.href)}; try { await main(${JSON.stringify(args)}); } catch (error) { process.stdout.write(JSON.stringify({ code: error.code, message: error.message })); }`;
  const result = await execute(process.execPath, ["--input-type=module", "--eval", script, "cli-test-import"], {
    env: { ...process.env, OMP_LAN_RPC_DIR: root },
    timeout: 10_000,
  });
  return JSON.parse(result.stdout);
}


function runWithInput(root, args, input, { buffer = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, OMP_LAN_RPC_DIR: root },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
    child.on("error", reject);
    child.on("close", (code) => {
      const stdoutBuffer = Buffer.concat(stdout);
      const result = {
        code,
        stdout: buffer ? stdoutBuffer : stdoutBuffer.toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (code === 0) resolve(result);
      else reject(Object.assign(new Error(`CLI exited ${code}`), result));
    });
  });
}

async function jsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function json(response, status, value) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}

test("private local discovery reaches only the pinned v2 instance and list omits credentials", async (t) => {
  const root = await fixtureRoot(t);
  const received = [];
  const server = await listen(t, (request, response) => {
    received.push({ url: request.url, authorization: request.headers.authorization });
    json(response, 200, { protocolVersion: 2, instanceId: INSTANCE, generation: 7, sessionId: "fixture", cwd: root, busy: false, queueDepth: 0, capabilities: {} });
  });
  const descriptor = await writeDescriptor(root, `http://127.0.0.1:${server.address().port}`);

  await chmod(descriptor, 0o660);
  await assert.rejects(run(root, ["session", "--session", "fixture"]));
  assert.equal(received.length, 0);
  await chmod(descriptor, 0o600);

  const session = await run(root, ["session", "--session", "fixture"]);
  assert.equal(JSON.parse(session.stdout).instanceId, INSTANCE);
  assert.deepEqual(received, [{ url: "/v2/session", authorization: undefined }]);

  const listing = JSON.parse((await run(root, ["list"])).stdout);
  assert.equal(listing.instances[0].instanceId, INSTANCE);
  assert.equal("tokenFile" in listing.instances[0], false);
});

test("public discovery selects exact live session IDs and rejects missing or ambiguous choices", async (t) => {
  const root = await fixtureRoot(t);
  let firstHits = 0;
  let secondHits = 0;
  const first = await listen(t, (_request, response) => {
    firstHits += 1;
    json(response, 200, { protocolVersion: 2, instanceId: INSTANCE, generation: 7, sessionId: "alpha", cwd: root, busy: false, queueDepth: 0, capabilities: {} });
  });
  const second = await listen(t, (_request, response) => {
    secondHits += 1;
    json(response, 200, { protocolVersion: 2, instanceId: INSTANCE_2, generation: 8, sessionId: "beta", cwd: root, busy: false, queueDepth: 0, capabilities: {} });
  });
  await writeDescriptor(root, `http://127.0.0.1:${first.address().port}`, { sessionId: "alpha" });
  await writeDescriptor(root, `http://127.0.0.1:${second.address().port}`, { instanceId: INSTANCE_2, generation: 8, sessionId: "beta" });

  const help = (await run(root, ["help"])).stdout;
  assert.match(help, /--session SESSION_ID/);
  assert.doesNotMatch(help, /--instance(?:\s|=)/);
  await assert.rejects(run(root, ["session", "--instance", INSTANCE]), (error) => /unknown option: --instance/.test(error.stderr));

  const selected = JSON.parse((await run(root, ["session", "--session", "beta"])).stdout);
  assert.equal(selected.instanceId, INSTANCE_2);
  assert.equal(firstHits, 0);
  assert.equal(secondHits, 1);

  const missing = await runMainError(root, ["session", "--session", "missing"]);
  assert.equal(missing.code, "session_not_found");
  const required = await runMainError(root, ["session"]);
  assert.equal(required.code, "session_selection_required");
  assert.match(required.message, /session IDs: "alpha", "beta"/);
  assert.match(required.message, /use --session SESSION_ID/);

  await writeDescriptor(root, "http://127.0.0.1:9", { instanceId: INSTANCE_3, generation: 9, sessionId: "beta" });
  const ambiguous = await runMainError(root, ["session", "--session", "beta"]);
  assert.equal(ambiguous.code, "session_ambiguous");
  assert.match(ambiguous.message, /multiple PID-live local descriptors match session beta/);
});

test("send and submit preserve explicit v2 mode, identity, schemas, and tools", async (t) => {
  const root = await fixtureRoot(t);
  const posted = [];
  const server = await listen(t, async (request, response) => {
    if (request.method === "GET") return json(response, 200, { protocolVersion: 2, instanceId: INSTANCE, generation: 7, sessionId: "fixture", cwd: root, busy: false, queueDepth: 0, capabilities: { structuredResults: true } });
    const value = await jsonBody(request);
    posted.push(value);
    json(response, 202, { instanceId: value.instanceId, generation: value.generation, sessionId: "fixture", requestId: value.requestId, responseMode: value.responseMode ?? "native", state: "queued", createdAt: 1, updatedAt: 1, deadlineAt: 1000 });
  });
  await writeDescriptor(root, `http://127.0.0.1:${server.address().port}`);
  const message = join(root, "message.txt");
  const schema = join(root, "schema.json");
  await writeFile(message, "Return a structured result.");
  await writeFile(schema, JSON.stringify({ type: "object", required: ["answer"], properties: { answer: { type: "string" } }, additionalProperties: false }));

  await run(root, ["send", "--session", "fixture", "--message-file", message, "--request-id", "send_job", "--response-mode", "structured", "--result-schema-file", schema]);
  assert.equal(posted[0].instanceId, INSTANCE);
  assert.equal(posted[0].generation, 7);
  assert.equal(posted[0].responseMode, "structured");
  assert.deepEqual(posted[0].resultSchema.required, ["answer"]);

  const requestFile = join(root, "request.json");
  const complete = {
    instanceId: INSTANCE,
    generation: 7,
    requestId: "tool_job",
    message: "Use lookup_item.",
    responseMode: "native",
    tools: [{ name: "lookup_item", description: "lookup", inputSchema: { type: "object" }, resultSchema: { type: "object" } }],
  };
  await writeFile(requestFile, JSON.stringify(complete));
  await run(root, ["submit", "--session", "fixture", "--request-file", requestFile]);
  assert.deepEqual(posted[1], complete);
});

test("public and hidden relay session checks reject a descriptor session ID mismatch", async (t) => {
  const root = await fixtureRoot(t);
  let hits = 0;
  const server = await listen(t, (_request, response) => {
    hits += 1;
    json(response, 200, { protocolVersion: 2, instanceId: INSTANCE, generation: 7, sessionId: "replacement", cwd: root, busy: false, queueDepth: 0, capabilities: {} });
  });
  await writeDescriptor(root, `http://127.0.0.1:${server.address().port}`);

  await assert.rejects(run(root, ["session", "--session", "fixture"]), (error) => /session ID changed after discovery/.test(error.stderr));
  const relayed = await runWithInput(root, ["relay", "--instance", INSTANCE, "--machine", "192.0.2.44"], JSON.stringify({ operation: "session" })).catch((error) => error);
  assert.equal(JSON.parse(relayed.stdout).error.code, "session_mismatch");
  assert.equal(hits, 2);
});

test("recovery keeps the original wire identity and rejects a restarted session endpoint", async (t) => {
  const root = await fixtureRoot(t);
  const record = {
    instanceId: INSTANCE,
    generation: 7,
    sessionId: "fixture",
    requestId: "recovery_job",
    responseMode: "native",
    state: "queued",
    createdAt: 1,
    updatedAt: 1,
    deadlineAt: Date.now() + 60_000,
  };
  const original = await listen(t, async (request, response) => {
    const url = new URL(request.url, "http://fixture");
    if (url.pathname === "/v2/session") return json(response, 200, { protocolVersion: 2, instanceId: INSTANCE, generation: 7, sessionId: "fixture", cwd: root, busy: false, queueDepth: 0, capabilities: {} });
    if (request.method === "POST") await jsonBody(request);
    json(response, request.method === "POST" ? 202 : 200, record);
  });
  const descriptor = await writeDescriptor(root, `http://127.0.0.1:${original.address().port}`);
  const message = join(root, "recovery-message.txt");
  await writeFile(message, "Keep this request identity pinned.");

  const timedOut = await run(root, ["send", "--session", "fixture", "--message-file", message, "--request-id", "recovery_job", "--wait", "--timeout", "1"]).catch((error) => error);
  assert.equal(timedOut.code, 3, timedOut.stderr);
  assert.match(timedOut.stderr, /'request' '--session' 'fixture' '--instance-id' '11111111-1111-4111-8111-111111111111'/);
  assert.match(timedOut.stderr, /'--request-id' 'recovery_job' '--generation' '7'/);

  await rm(descriptor);
  let replacementHits = 0;
  const replacement = await listen(t, (_request, response) => {
    replacementHits += 1;
    json(response, 500, { error: { code: "unexpected", message: "must not contact replacement" } });
  });
  await writeDescriptor(root, `http://127.0.0.1:${replacement.address().port}`, { instanceId: INSTANCE_2, generation: 8 });
  await assert.rejects(
    run(root, ["request", "--session", "fixture", "--instance-id", INSTANCE, "--request-id", "recovery_job", "--generation", "7"]),
    (error) => /--instance-id does not match the selected local descriptor/.test(error.stderr),
  );
  assert.equal(replacementHits, 0);
});

test("HTTP credential options are rejected before files are read or requests are sent", async (t) => {
  const root = await fixtureRoot(t);
  let hits = 0;
  const server = await listen(t, (_request, response) => { hits += 1; json(response, 200, {}); });
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  await assert.rejects(
    run(root, ["session", "--endpoint", endpoint, "--token-file", join(root, "does-not-exist")]),
    (error) => /--token-file is forbidden and was not read/.test(error.stderr),
  );
  assert.equal(hits, 0);
});

test("SSH relay restricts descriptors to loopback or the supplied machine before connecting", async (t) => {
  const root = await fixtureRoot(t);
  await writeDescriptor(root, "http://192.0.2.9:43123");
  const result = await runWithInput(root, ["relay", "--instance", INSTANCE, "--machine", "192.0.2.10"], JSON.stringify({ operation: "session" })).catch((error) => error);
  assert.equal(result.code, 4);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.error.code, "relay_failed");
  assert.match(payload.error.message, /neither loopback nor the supplied SSH machine address/);

  await assert.rejects(
    runWithInput(root, ["relay", "--session", "fixture", "--machine", "192.0.2.9"], JSON.stringify({ operation: "session" })),
    (error) => error.code === 1 && /unknown option: --session/.test(error.stderr),
  );
  const unpinned = await runWithInput(root, ["relay", "--machine", "192.0.2.9"], JSON.stringify({ operation: "session" })).catch((error) => error);
  assert.equal(unpinned.code, 4);
  assert.match(JSON.parse(unpinned.stdout).error.message, /--instance is required/);
});

test("relay carries JSON operations and artifact bytes over bounded stdin/stdout", async (t) => {
  const root = await fixtureRoot(t);
  const artifactBytes = Buffer.from([0, 10, 255, 4, 5]);
  const server = await listen(t, (request, response) => {
    const url = new URL(request.url, "http://fixture");
    if (url.pathname === "/v2/session") return json(response, 200, { protocolVersion: 2, instanceId: INSTANCE, generation: 7, sessionId: "relay", cwd: root, busy: false, queueDepth: 0, capabilities: {} });
    if (url.pathname.endsWith(`/artifacts/${ARTIFACT}`)) {
      response.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": artifactBytes.length });
      return response.end(artifactBytes);
    }
    json(response, 404, { error: { code: "not_found", message: "missing" } });
  });
  await writeDescriptor(root, `http://127.0.0.1:${server.address().port}`, { sessionId: "relay" });
  const common = ["relay", "--instance", INSTANCE, "--machine", "192.0.2.44"];
  const session = await runWithInput(root, common, JSON.stringify({ operation: "session" }));
  assert.equal(JSON.parse(session.stdout).sessionId, "relay");

  const download = await runWithInput(root, common, JSON.stringify({ operation: "download", identity: { instanceId: INSTANCE, generation: 7, requestId: "job" }, artifactId: ARTIFACT }), { buffer: true });
  assert.deepEqual(download.stdout, artifactBytes);

  const oversized = await runWithInput(root, common, " ".repeat(400 * 1024)).catch((error) => error);
  assert.equal(oversized.code, 4);
  assert.match(JSON.parse(oversized.stdout).error.message, /relay stdin exceeds/);
});

test("relay reports stable instance and generation mismatch codes", async (t) => {
  const root = await fixtureRoot(t);
  let hits = 0;
  const server = await listen(t, (_request, response) => { hits += 1; json(response, 500, {}); });
  await writeDescriptor(root, `http://127.0.0.1:${server.address().port}`);
  const common = ["relay", "--instance", INSTANCE, "--machine", "192.0.2.44"];
  const invoke = (identity) => runWithInput(root, common, JSON.stringify({ operation: "request", identity })).catch((error) => error);

  const wrongInstance = await invoke({ instanceId: "22222222-2222-4222-8222-222222222222", generation: 7, requestId: "job" });
  assert.equal(JSON.parse(wrongInstance.stdout).error.code, "instance_mismatch");
  const wrongGeneration = await invoke({ instanceId: INSTANCE, generation: 8, requestId: "job" });
  assert.equal(JSON.parse(wrongGeneration.stdout).error.code, "generation_mismatch");
  assert.equal(hits, 0);
});

test("relay reports selected discovery misses with a stable client code", async (t) => {
  const root = await fixtureRoot(t);
  const missing = "22222222-2222-4222-8222-222222222222";
  const result = await runWithInput(root, ["relay", "--instance", missing, "--machine", "192.0.2.44"], JSON.stringify({ operation: "session" })).catch((error) => error);
  assert.equal(JSON.parse(result.stdout).error.code, "instance_not_found");
});
