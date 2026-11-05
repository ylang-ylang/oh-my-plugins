#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { RpcClient, SshRpcClient } from "../sdk.mjs";
import { readPrivateFile } from "../config.mjs";

const STRUCTURED_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    artifactId: { type: "string" },
  },
  required: ["summary", "artifactId"],
  additionalProperties: false,
};

const LOOKUP_TOOL = {
  name: "lookup_item",
  description: "Look up one caller-owned item by numeric ID.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "integer" } },
    required: ["id"],
    additionalProperties: false,
  },
  resultSchema: {
    type: "object",
    properties: { title: { type: "string" }, status: { type: "string" } },
    required: ["title", "status"],
    additionalProperties: false,
  },
};

async function clientFromEnvironment() {
  const sshHost = process.env.LAN_RPC_SSH_HOST;
  const instanceId = process.env.LAN_RPC_INSTANCE;
  if (sshHost) {
    if (!instanceId) throw new Error("LAN_RPC_INSTANCE is required with LAN_RPC_SSH_HOST");
    return new SshRpcClient({
      host: sshHost,
      instanceId,
      remoteCli: process.env.LAN_RPC_REMOTE_CLI,
      ca: process.env.LAN_RPC_REMOTE_CA,
    });
  }

  const endpoint = process.env.LAN_RPC_ENDPOINT;
  if (!endpoint) throw new Error("Set LAN_RPC_SSH_HOST + LAN_RPC_INSTANCE, or set LAN_RPC_ENDPOINT for an explicit direct connection");
  const protocol = new URL(endpoint).protocol;
  let token;
  if (process.env.LAN_RPC_TOKEN_FILE) token = (await readPrivateFile(resolve(process.env.LAN_RPC_TOKEN_FILE), 4 * 1024)).trim();
  let ca;
  if (process.env.LAN_RPC_CA_FILE) ca = await readFile(process.env.LAN_RPC_CA_FILE);
  if (protocol === "https:" && !token) throw new Error("LAN_RPC_TOKEN_FILE is required for direct HTTPS");
  return new RpcClient({ endpoint, token, ca, allowHttp: process.env.LAN_RPC_ALLOW_HTTP === "1" });
}

export async function runExample({ outputPath = resolve("rpc-report.txt") } = {}) {
  const client = await clientFromEnvironment();
  const session = await client.session();
  if (!session.capabilities?.structuredResults || !session.capabilities?.callerTools || !session.capabilities?.artifacts) {
    throw new Error("Selected session does not provide the required v2 capabilities");
  }

  const structured = await client.run({
    instanceId: session.instanceId,
    generation: session.generation,
    requestId: `example_${randomUUID().replaceAll("-", "")}`,
    message: [
      "Call lookup_item with id 42.",
      "Create report.txt in the request working directory containing a short report about the returned item.",
      "Register it with rpc_artifact using mediaType text/plain.",
      "Then call rpc_result exactly once with {summary, artifactId}; use the registered artifact ID.",
    ].join(" "),
    responseMode: "structured",
    resultSchema: STRUCTURED_SCHEMA,
    tools: [LOOKUP_TOOL],
  }, {
    handlers: {
      lookup_item: async ({ id }) => {
        if (id !== 42) throw new Error(`unknown item ${id}`);
        return { title: "LAN RPC v2 example", status: "ready" };
      },
    },
    onEvent: (event) => {
      if (event.type !== "native") console.error(`event ${event.sequence}: ${event.type}`);
    },
  });
  if (structured.state !== "completed") throw new Error(`structured request ended in ${structured.state}: ${structured.error?.code ?? "unknown"}`);

  await client.download(
    { instanceId: session.instanceId, generation: session.generation, requestId: structured.requestId },
    structured.result.artifactId,
    outputPath,
  );
  console.log(JSON.stringify({ structuredResult: structured.result, downloadedTo: outputPath }, null, 2));

  const nativeEvents = [];
  const native = await client.run({
    instanceId: session.instanceId,
    generation: session.generation,
    requestId: `native_${randomUUID().replaceAll("-", "")}`,
    message: "Reply briefly with one benefit of request-scoped isolation.",
    responseMode: "native",
  }, {
    onEvent: (event) => {
      if (event.type === "native") nativeEvents.push(event.data);
    },
  });
  if (native.state !== "completed") throw new Error(`native request ended in ${native.state}: ${native.error?.code ?? "unknown"}`);
  console.log(JSON.stringify({ nativeResult: native.result, nativeEvents }, null, 2));
  return { structured, native, outputPath };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runExample({ outputPath: resolve(process.argv[2] ?? "rpc-report.txt") }).catch((error) => {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
