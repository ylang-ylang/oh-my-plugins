#!/usr/bin/env node

import { isIP } from "node:net";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { listSshInstances, SshRpcClient } from "./sdk.mjs";

const HELP = `Usage: node ssh-demo.mjs MACHINE_IP [--list | --instance UUID]
       [--remote-cli ABSOLUTE_REMOTE_PATH] [--ca ABSOLUTE_REMOTE_CA_PATH]

Discover LAN RPC v2 instances through one existing SSH ingress. With only a
literal machine IP, select a reachable session interactively; a single session
is selected automatically. --list prints reachable session metadata as JSON.

--instance UUID    Select exactly one discovered instance.
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
  ~/.omp/plugins/node_modules/omp-lan-rpc/cli.mjs
`;

function parseArgs(argv) {
  const host = argv.shift();
  if (isIP(host ?? "") === 0) throw new Error("Provide a literal IPv4 or IPv6 machine address");
  const options = { host };
  while (argv.length) {
    const name = argv.shift();
    if (!["--list", "--instance", "--remote-cli", "--ca"].includes(name)) throw new Error(`Unknown option: ${name}`);
    if (Object.hasOwn(options, name)) throw new Error(`Repeated option: ${name}`);
    if (name === "--list") options[name] = true;
    else {
      const value = argv.shift();
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}`);
      options[name] = value;
    }
  }
  if (options["--list"] && options["--instance"]) throw new Error("--list cannot be combined with --instance");
  return options;
}

async function discover(options) {
  const common = {
    host: options.host,
    remoteCli: options["--remote-cli"],
    ca: options["--ca"],
  };
  const listing = await listSshInstances(common);
  const sessions = [];
  const unavailable = [];
  for (const descriptor of listing.instances) {
    if (descriptor?.status !== "live" || typeof descriptor.instanceId !== "string") continue;
    try {
      const client = new SshRpcClient({ ...common, instanceId: descriptor.instanceId });
      const session = await client.session();
      if (session.generation !== descriptor.generation) throw new Error("generation changed during discovery");
      sessions.push({ ...descriptor, ...session });
    } catch (error) {
      unavailable.push({ instanceId: descriptor.instanceId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { common, sessions, unavailable };
}

async function selectSession(options, discovered) {
  if (options["--list"]) {
    console.log(JSON.stringify({ machine: options.host, sessions: discovered.sessions, unavailable: discovered.unavailable }, null, 2));
    return undefined;
  }
  for (const entry of discovered.unavailable) console.error(`Unavailable ${entry.instanceId}: ${entry.error}`);
  if (!discovered.sessions.length) throw new Error("No reachable LAN RPC v2 session for this SSH user");
  if (options["--instance"]) {
    const selected = discovered.sessions.find((entry) => entry.instanceId === options["--instance"]);
    if (!selected) throw new Error("Selected instance is not reachable; no other instance was substituted");
    return selected;
  }
  if (discovered.sessions.length === 1) return discovered.sessions[0];
  discovered.sessions.forEach((entry, index) => {
    console.log(`${index + 1}. ${JSON.stringify(entry.cwd)} | busy=${entry.busy} | queue=${entry.queueDepth} | ${entry.instanceId}`);
  });
  if (!process.stdin.isTTY) throw new Error("Multiple sessions; use --instance UUID or an interactive terminal");
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

  // Selection can take time. Query the same instance again and require the
  // original generation; never substitute or replay against a replacement.
  const client = new SshRpcClient({ ...discovered.common, instanceId: selected.instanceId });
  const current = await client.session();
  if (current.generation !== selected.generation) throw new Error("Session generation changed after selection; rediscover explicitly");
  console.log(JSON.stringify(current, null, 2));
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
