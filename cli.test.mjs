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
const CLI = fileURLToPath(new URL("./cli.mjs", import.meta.url));
const INSTANCE = "11111111-1111-4111-8111-111111111111";
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
  const path = join(root, "instances", `${INSTANCE}.json`);
  await writeFile(path, JSON.stringify({ instanceId: INSTANCE, pid: process.pid, endpoint, generation: 7, sessionId: "fixture", ...extra }), { mode: 0o600 });
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
  await assert.rejects(run(root, ["session", "--instance", INSTANCE]));
  assert.equal(received.length, 0);
  await chmod(descriptor, 0o600);

  const session = await run(root, ["session", "--instance", INSTANCE]);
  assert.equal(JSON.parse(session.stdout).instanceId, INSTANCE);
  assert.deepEqual(received, [{ url: "/v2/session", authorization: undefined }]);

  const listing = JSON.parse((await run(root, ["list"])).stdout);
  assert.equal(listing.instances[0].instanceId, INSTANCE);
  assert.equal("tokenFile" in listing.instances[0], false);
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

  await run(root, ["send", "--instance", INSTANCE, "--message-file", message, "--request-id", "send_job", "--response-mode", "structured", "--result-schema-file", schema]);
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
  await run(root, ["submit", "--instance", INSTANCE, "--request-file", requestFile]);
  assert.deepEqual(posted[1], complete);
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
  await writeDescriptor(root, `http://127.0.0.1:${server.address().port}`);
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
