#!/usr/bin/env node

import { isIP } from "node:net";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { listSshInstances, SshRpcClient } from "./sdk.mjs";

const HELP = `Usage: node ssh-demo.mjs MACHINE_IP [--list | --session SESSION_ID]
       [--remote-cli ABSOLUTE_REMOTE_PATH] [--ca ABSOLUTE_REMOTE_CA_PATH]

Discover LAN RPC v2 instances through one existing SSH ingress. With only a
literal machine IP, select a reachable session interactively; a single session
is selected automatically. --list prints reachable session metadata as JSON.

--session ID       Select exactly one discovered session.
--remote-cli PATH  Absolute remote cli.mjs path for a custom installation.
--ca PATH          Absolute CA bundle path on the remote machine for HTTPS.

The demo uses sdk.mjs SshRpcClient. Every session/API operation runs through the
remote CLI over OpenSSH; binary artifact downloads use the same byte stream (the
SDK never creates a local port, daemon, tunnel, or base64 envelope). Existing
bearer credentials stay in private files on the remote machine.

OpenSSH is invoked with BatchMode=yes and StrictHostKeyChecking=yes. Its normal
configuration still supplies User, Port, IdentityFile and ProxyJump. Unknown or
changed host keys, authentication failures, invalid remote output, and missing
Node/plugin/CA paths are fatal. There is no direct HTTP fallback or automatic
host trust. Establish host trust separately.

This file is a Node.js example, not a client-language restriction. Python, Go,
Rust, or any caller that can run OpenSSH and exchange JSON/binary stdin/stdout
can use the same relay contract. The remote cli.mjs still requires Node >=22 on
the OMP machine even when the local caller is written in another language.

The selected descriptor endpoint must be loopback or exactly MACHINE_IP. Remote
Node >=22 is required. Standard Homebrew, Bun and user-local binary directories
are added to the non-interactive remote PATH. The default remote CLI is:
  ~/.omp/plugins/node_modules/oh-my-plugins/plugins/lanrpc/cli.mjs
`;

function parseArgs(argv) {
  const host = argv.shift();
  if (isIP(host ?? "") === 0) throw new Error("Provide a literal IPv4 or IPv6 machine address");
  const options = { host };
  while (argv.length) {
    const name = argv.shift();
    if (!["--list", "--session", "--remote-cli", "--ca"].includes(name)) throw new Error(`Unknown option: ${name}`);
    if (Object.hasOwn(options, name)) throw new Error(`Repeated option: ${name}`);
    if (name === "--list") options[name] = true;
    else {
      const value = argv.shift();
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}`);
      options[name] = value;
    }
  }
  if (options["--list"] && options["--session"]) throw new Error("--list cannot be combined with --session");
  return options;
}

async function discover(options) {
  const common = {
    host: options.host,
    remoteCli: options["--remote-cli"],
    ca: options["--ca"],
  };
  const listing = await listSshInstances(common);
  const descriptors = listing.instances.filter((descriptor) => descriptor?.status === "live" && typeof descriptor.sessionId === "string" && descriptor.sessionId.length > 0);
  const sessions = [];
  const unavailable = [];
  const clients = new Map();
  for (const sessionId of new Set(descriptors.map((descriptor) => descriptor.sessionId))) {
    try {
      const client = new SshRpcClient({ ...common, sessionId });
      const session = await client.session();
      sessions.push(session);
      clients.set(sessionId, client);
    } catch (error) {
      unavailable.push({ sessionId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { common, sessions, unavailable, clients };
}

function displaySession(session) {
  return {
    sessionId: session.sessionId,
    cwd: session.cwd,
    busy: session.busy,
    queueDepth: session.queueDepth,
    capabilities: session.capabilities,
  };
}

async function selectSession(options, discovered) {
  if (options["--list"]) {
    console.log(JSON.stringify({ machine: options.host, sessions: discovered.sessions.map(displaySession), unavailable: discovered.unavailable }, null, 2));
    return undefined;
  }
  for (const entry of discovered.unavailable) console.error(`Unavailable ${JSON.stringify(entry.sessionId)}: ${entry.error}`);
  if (options["--session"]) {
    const selected = discovered.sessions.find((entry) => entry.sessionId === options["--session"]);
    if (!selected) throw new Error("Selected session is not reachable; no other session was substituted");
    return selected;
  }
  if (!discovered.sessions.length) throw new Error("No reachable LAN RPC v2 session for this SSH user");
  if (discovered.sessions.length === 1) return discovered.sessions[0];
  discovered.sessions.forEach((entry, index) => {
    console.log(`${index + 1}. ${JSON.stringify(entry.cwd)} | busy=${entry.busy} | queue=${entry.queueDepth} | ${JSON.stringify(entry.sessionId)}`);
  });
  if (!process.stdin.isTTY) throw new Error("Multiple sessions; use --session SESSION_ID or an interactive terminal");
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question("Select session number: ");
    const index = /^\d+$/.test(answer) ? Number(answer) - 1 : -1;
    const selected = discovered.sessions[index];
    if (!selected) throw new Error("Invalid session selection");
    return selected;
  } finally {
    prompt.close();
  }
}

export async function main(argv) {
  if (argv.includes("--help") || argv[0] === "help") {
    console.log(HELP);
    return 0;
  }
  const options = parseArgs([...argv]);
  const discovered = await discover(options);
  const selected = await selectSession(options, discovered);
  if (!selected) return 0;

  // Reuse the already pinned client after interactive selection. A replacement
  // with the same sessionId requires explicit rediscovery through a new client.
  const client = discovered.clients.get(selected.sessionId);
  const current = await client.session();
  if (current.instanceId !== selected.instanceId || current.generation !== selected.generation) throw new Error("Session identity changed after selection; rediscover explicitly");
  console.log(JSON.stringify(displaySession(current), null, 2));
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (error) => {
      console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    },
  );
}
