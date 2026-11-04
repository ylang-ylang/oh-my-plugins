#!/usr/bin/env node
import { execFile } from "node:child_process";
import { isIP } from "node:net";
import { createInterface } from "node:readline/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);
const HELP = `Usage: node ssh-demo.mjs IP [--list | --instance UUID] [--remote-cli PATH] [--ca PATH]

Read-only SSH discovery demo. With only an IP, list reachable OMP sessions
and select one interactively (a single session is selected automatically).

This example is written in Node.js, but clients can use Python, Go, Rust or
any language that can run SSH and parse JSON. For example, Python can invoke
the same remote CLI through subprocess and parse its output with json.
Keep SSH host verification, endpoint restrictions and instance/generation
checks. Reusing the remote cli.mjs still requires Node >=22 on the SSH host;
the LAN RPC HTTP/JSON protocol itself has no client-language requirement.

--list            Print discovered session metadata as JSON without selecting.
--instance UUID   Select a discovered instance without an interactive prompt.
--remote-cli PATH Absolute remote cli.mjs path for a non-default installation.
--ca PATH         Remote CA bundle for HTTPS; TLS verification stays enabled.

Requires working non-interactive SSH authentication and a previously verified
host key. Uses your OpenSSH configuration, including User, Port and ProxyJump.
Unknown/changed host keys and authentication failures are fatal; there is no
direct-network fallback. Establish SSH trust separately before using this demo.
Remote Node >=22 and the installed plugin are required. Standard Homebrew and
user runtime directories are included in the remote non-interactive PATH.
No server install, fixed discovery port, local listening port or remote file
is created. Only list and GET /v1/session are used; no messages are submitted.
HTTP endpoints must be loopback or the supplied machine IP. The HTTP hop runs
on the remote host; existing LAN HTTP exposure is NOT removed by using SSH.
Keep listeners on loopback for the recommended SSH-first setup.
`;

// Every remote argument is quoted for the remote POSIX shell, never interpolated
// as executable syntax. OpenSSH receives the destination as a separate argument.
function quote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

class SshDemo {
  constructor(args) {
    this.ip = args.shift();
    if (!isIP(this.ip ?? "")) throw new Error("Provide a literal IPv4 or IPv6 machine address");
    this.options = {};
    while (args.length) {
      const option = args.shift();
      if (!["--list", "--instance", "--remote-cli", "--ca"].includes(option)) {
        throw new Error(`Unknown option: ${option}`);
      }
      if (Object.hasOwn(this.options, option)) throw new Error(`Repeated option: ${option}`);
      if (option === "--list") this.options[option] = true;
      else {
        const value = args.shift();
        if (!value || value.startsWith("--")) throw new Error(`Missing value for ${option}`);
        this.options[option] = value;
      }
    }
    if (this.options["--list"] && this.options["--instance"]) {
      throw new Error("--list cannot be combined with --instance");
    }
    if (this.options["--remote-cli"] && !this.options["--remote-cli"].startsWith("/")) {
      throw new Error("--remote-cli must be an absolute remote path");
    }
  }

  async remote(args) {
    const cli = this.options["--remote-cli"]
      ? quote(this.options["--remote-cli"])
      : '"$HOME/.omp/plugins/node_modules/omp-lan-rpc/cli.mjs"';
    const command = 'export PATH="$HOME/.local/bin:$HOME/.bun/bin:/home/linuxbrew/.linuxbrew/bin:/opt/homebrew/bin:$PATH"; '
      + `exec node ${cli} ${args.map(quote).join(" ")}`;
    try {
      const { stdout } = await exec("ssh", [
        "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
        "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=10",
        "-o", "ServerAliveCountMax=2", this.ip, command,
      ], { timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
      return JSON.parse(stdout);
    } catch (error) {
      // Do not print the command or arbitrary remote output (which could contain
      // startup-script secrets). Diagnose SSH/runtime setup separately.
      if (error instanceof SyntaxError) throw new Error("Remote CLI did not return valid JSON");
      throw new Error(`SSH/remote CLI failed (exit ${error.code ?? "unknown"}); check SSH trust, authentication, remote Node/plugin path and certificate trust`);
    }
  }

  async session(descriptor) {
    const endpoint = new URL(descriptor.endpoint);
    const host = endpoint.hostname.replace(/^\[|\]$/g, "");
    const loopback = host === "::1" || (isIP(host) === 4 && host.startsWith("127."));
    if (!loopback && host !== this.ip) {
      throw new Error("Endpoint is neither loopback nor the supplied machine IP");
    }
    const args = ["session", "--instance", descriptor.instanceId];
    if (endpoint.protocol === "http:") {
      // Consent applies only to an endpoint on this SSH host, never a direct
      // plaintext connection from this client to the remote machine.
      if (!loopback) args.push("--allow-http");
    } else if (endpoint.protocol === "https:") {
      if (this.options["--ca"]) args.push("--ca", this.options["--ca"]);
    } else throw new Error("Unsupported endpoint protocol");
    const session = await this.remote(args);
    if (session.instanceId !== descriptor.instanceId || session.generation !== descriptor.generation) {
      throw new Error("Session identity changed during discovery; rediscover explicitly");
    }
    return session;
  }

  async run() {
    const listing = await this.remote(["list"]);
    if (!Array.isArray(listing.instances)) throw new Error("Invalid remote instance list");
    const sessions = [];
    const unavailable = [];
    for (const descriptor of listing.instances) {
      if (descriptor.status !== "live") continue;
      try {
        sessions.push({ ...descriptor, ...await this.session(descriptor) });
      } catch (error) {
        unavailable.push({ instanceId: descriptor.instanceId, error: error.message });
      }
    }
    if (this.options["--list"]) {
      console.log(JSON.stringify({ machine: this.ip, sessions, unavailable }, null, 2));
      return;
    }
    for (const entry of unavailable) console.error(`Unavailable ${entry.instanceId}: ${entry.error}`);
    if (!sessions.length) throw new Error("No reachable OMP sessions for this SSH user");
    let selected;
    if (this.options["--instance"]) {
      selected = sessions.find((entry) => entry.instanceId === this.options["--instance"]);
      if (!selected) throw new Error("Selected instance is not reachable; no other instance was selected");
    } else {
      sessions.forEach((entry, index) => {
        console.log(`${index + 1}. ${JSON.stringify(entry.cwd)} | busy=${entry.busy} | queue=${entry.queueDepth} | ${entry.instanceId}`);
      });
      if (sessions.length === 1) selected = sessions[0];
      else {
        if (!process.stdin.isTTY) throw new Error("Multiple sessions; use --instance UUID or an interactive terminal");
        const prompt = createInterface({ input: process.stdin, output: process.stdout });
        try {
          const answer = await prompt.question("Select session number: ");
          const index = /^\d+$/.test(answer) ? Number(answer) - 1 : -1;
          selected = sessions[index];
          if (!selected) throw new Error("Invalid session selection");
        } finally {
          prompt.close();
        }
      }
    }
    // Selection can take time: validate the original identity again, not a
    // newly discovered replacement. Never submit or replay a request here.
    console.log(JSON.stringify(await this.session(selected), null, 2));
  }
}

if (process.argv.includes("--help") || process.argv[2] === "help") {
  console.log(HELP);
} else {
  try {
    await new SshDemo(process.argv.slice(2)).run();
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exitCode = 1;
  }
}
