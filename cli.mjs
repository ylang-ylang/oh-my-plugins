#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { open, readdir } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { TextDecoder } from "node:util";

import { assertExistingPrivateRoot, isLoopbackHost, readConfig, readPrivateFile, rootDir, writeConfig } from "./config.mjs";

const PROTOCOL_VERSION = 1;
const MAX_REQUEST_JSON_BYTES = 64 * 1024;
const MAX_RESPONSE_JSON_BYTES = 2 * 1024 * 1024;
const MAX_MESSAGE_BYTES = 48 * 1024;
const MAX_DESCRIPTOR_BYTES = 64 * 1024;
const MAX_TOKEN_BYTES = 4 * 1024;
const MAX_CA_BYTES = 1024 * 1024;
const HTTP_TIMEOUT_MS = 15_000;
const DEFAULT_WAIT_SECONDS = 300;
const MAX_WAIT_SECONDS = 86_400;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TERMINAL_STATES = new Set(["completed", "failed", "interrupted"]);
const KNOWN_STATES = new Set(["queued", "running", ...TERMINAL_STATES]);

const HELP = `omp-lan-rpc: HTTP/JSON v1 access to one ordinary OMP session

INSTALLATION PREREQUISITES (ON THE MACHINE RUNNING OMP)
  OMP must already work. Git is required; the standalone client needs Node >=22.
  OMP 18.2.6 invokes external bun during plugin installation. A missing-bun
  error occurs BEFORE this plugin is downloaded, so install Bun first.
  Recent OMP releases use their embedded Bun; Homebrew itself is optional.

  Already have Homebrew? Install Bun:
    brew install oven-sh/bun/bun
  If Git or a suitable Node is missing:
    brew install git node

  No Homebrew? Run its official installer as your normal user, not with sudo:
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  Follow the installer's Next steps. Common PATH setup (choose ONE platform):
    Linux:             eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"
    macOS Apple Silicon: eval "$(/opt/homebrew/bin/brew shellenv)"
    macOS Intel:       eval "$(/usr/local/bin/brew shellenv)"
  Add the matching eval line literally once to your shell startup file:
  ~/.bashrc or ~/.zshrc; macOS login Zsh uses ~/.zprofile per the installer.
  Open a new terminal, check brew --version, then install Bun as above.
  Ubuntu/Debian prerequisites, if missing:
    sudo apt-get update
    sudo apt-get install -y build-essential procps curl file git ca-certificates unzip
  Full platform requirements: https://docs.brew.sh/Installation

  Alternative: install Bun directly WITHOUT Homebrew (Linux needs unzip):
    curl -fsSL https://bun.com/install | bash
    export BUN_INSTALL="$HOME/.bun"
    export PATH="$BUN_INSTALL/bin:$PATH"
  Persist those exports once in ~/.bashrc or ~/.zshrc if the installer did not.
  Official Bun instructions: https://bun.com/docs/installation

  Before retrying, check the SAME shell that will launch OMP:
    command -v bun
    bun --version
    git --version
    node --version
  Old tmux panes and running OMP processes need restarting to inherit new PATH.

INSTALL AND START
  Once prerequisites are ready, install from GitHub and restart OMP:
    omp plugin install github:ylang-ylang/omp-lan-rpc
  Fully exit and relaunch OMP after installation/upgrades. The radar layout is
  prepared before native TUI construction; plugin hot reload or /lanrpc restart
  alone cannot rebuild an already-created status bar.

  Default user-install client location (custom/XDG data roots may differ):

    node ~/.omp/plugins/node_modules/omp-lan-rpc/cli.mjs help

  For local development instead: omp plugin link /abs/repo

  A newly started interactive ordinary OMP session owns its server; headless
  task/print sessions do not auto-start a listener. There is no daemon. The
  default is loopback-only on an ephemeral port. Discover local sessions with:

    node /abs/repo/cli.mjs list

  Runtime/config root: OMP_LAN_RPC_DIR, otherwise ~/.omp/lan-rpc.
  Persistent settings: <root>/config.json. Per-session discovery lives under
  <root>/instances/<instance-id>.json. Only HTTPS has a matching private .token
  file. Directories must be owned by you with mode 0700, files mode 0600/0400.
  Do not put this directory in a shared mount or source repository.
  Node >=22 is required for the client; the host API was verified on OMP 18.2.6.

USAGE
  node /abs/repo/cli.mjs help
  node /abs/repo/cli.mjs list
  node /abs/repo/cli.mjs config [--host HOST] [--port PORT]
                                  [--lan on|off] [--protocol http|https]
                                  [--tls-cert PATH] [--tls-key PATH]
  node /abs/repo/cli.mjs session [CONNECTION]
  node /abs/repo/cli.mjs send [CONNECTION] --message-file PATH
                               [--request-id ID] [--wait]
                               [--timeout SECONDS]
  node /abs/repo/cli.mjs request [CONNECTION] --request-id ID
                                  --generation GEN

CONNECTION
  Default cross-machine discovery requires already trusted, authenticated SSH.
  Run the sibling ssh-demo.mjs with only the machine IP for read-only session
  discovery and selection. It uses the remote CLI, without a discovery daemon
  or fixed RPC port. Prefer loopback HTTP; SSH does not remove existing LAN
  HTTP exposure. Explicit direct connections below remain supported and are
  never used as an automatic fallback when SSH fails.

  Local discovery:
    --instance UUID       Select one local runtime descriptor explicitly.

  With no connection flags, exactly one PID-live local instance must exist.
  Stale descriptors are never selected or deleted. A PID-live descriptor only
  says its process exists; endpoint availability is checked by connecting.

  Explicit remote connection:
    --endpoint URL        Server origin, for example https://192.0.2.10:9443
    --token-file PATH     Private bearer token file; required for HTTPS, forbidden for HTTP.
    --ca CERT             Optional CA bundle for TLS verification. This may also
                          be used with local discovery of an HTTPS instance.
    --allow-http          Explicitly allow non-loopback plaintext HTTP, including
                          a LAN endpoint selected through local discovery.

  --endpoint cannot be combined with --instance. HTTPS requires --token-file.
  HTTP is unencrypted with NO authentication and never reads or sends a token.
  Anyone reaching its port can control the agent. Non-loopback HTTP requires
  --allow-http; loopback HTTP works without it. --ca is forbidden for HTTP.
  URLs cannot contain credentials, a path, query, or fragment. Redirects are never
  followed, even with --allow-http. HTTPS always verifies certificates and
  hostnames; --allow-http does not disable TLS verification or allow downgrade.

COMMANDS
  list
    Print local descriptor metadata and PID status as JSON. Token contents and
    token-file paths are omitted. "live" is a PID observation, not an endpoint
    health check. Stale/invalid files are reported but never removed.

  config
    With no flags, print the saved host, port, LAN toggle, protocol, and TLS paths
    (never key contents). --protocol http opts into unencrypted, anonymous access.
    HTTPS automatically generates/reuses a private self-signed IP certificate
    at startup using OpenSSL. --tls-cert and --tls-key together select advanced
    custom certificates instead; existing custom files are never overwritten.
    Legacy TLS configurations remain HTTPS. Moving from loopback to LAN defaults to
    HTTPS unless --protocol http is explicitly given. --host also sets the LAN
    toggle unless --lan is given. Changes apply only to the next server startup,
    not the current listener. --lan off retains the saved host, protocol, and TLS
    paths but exposes only plain HTTP on 127.0.0.1 for a saved LAN host. HTTP never
    reads saved TLS files; switching back to HTTPS reuses them.

  session
    Print current protocol/session metadata as JSON.

  send
    Read the complete message from --message-file; messages are never accepted
    on argv. The client reads current session metadata first and submits against
    that exact generation. If --request-id is omitted, one UUID is generated and
    reused for submission and polling. --wait polls every 500ms. Its default
    timeout is ${DEFAULT_WAIT_SECONDS}s; --timeout must be 1..${MAX_WAIT_SECONDS} and is valid only
    with --wait. A wait timeout does not cancel the accepted request and prints an
    exact request command. failed/interrupted records exit nonzero.

  request
    Fetch one request by its ID and exact generation. failed/interrupted records
    exit nonzero.

OMP LIFECYCLE AND LIMITS
  In OMP, /lanrpc opens the LAN RPC control menu. /lanrpc on enables LAN access
  (first use asks for an IP and port); choose HTTPS (recommended, automatic
  self-signed certificate) or HTTP (unencrypted, NO authentication, explicit consent).
  /lanrpc off keeps loopback access and saved settings. /lanrpc configure edits and enables
  LAN. These actions save future-session defaults and restart only the current
  listener; other running sessions are unchanged.
  The native status line shows a small radar indicator, not the endpoint URL.
  Its md-radar glyph (U+F0437) requires a supporting Nerd Font in your terminal;
  color follows OMP's native theme. Use the menu/info to distinguish local/LAN.
  /lanrpc info and menu Connection details open a focused panel. HTTPS displays
  the actual token, certificate path, and trust instructions. c copies the token
  through terminal OSC 52 (including SSH); terminal support/permission is needed.
  Esc or Enter closes the panel and removes its copy hotkey. HTTP has no token.
  Tokens never appear in the status bar, logs, client output, or RPC metadata.
  /lanrpc start, stop, restart control the current listener. Restart rotates the
  instance and HTTPS token, but reuses a usable managed certificate for the same IP.
  Session/branch/tree switches and listener reconfiguration are refused while remote work is pending.
  /lanrpc stop interrupts protocol records, not already-started agent/tool effects.
  If another extension cancels a transition after the listener closed, restore
  service with /lanrpc start. Earlier command names are no longer registered.

  One generation has 64 queued/running slots and 256 total idempotency records;
  accepted IDs are never silently evicted. Message text is limited to 48 KiB and
  a completed result to 256 KiB. All records remain memory-only.

LOCAL EXAMPLES (NO CURL)
  node /abs/repo/cli.mjs session --instance 01234567-89ab-4cde-8fab-0123456789ab
  node /abs/repo/cli.mjs send --instance 01234567-89ab-4cde-8fab-0123456789ab \\
    --message-file /abs/prompt.txt --wait --timeout 300
  node /abs/repo/cli.mjs request \\
    --instance 01234567-89ab-4cde-8fab-0123456789ab \\
    --request-id REQUEST_ID --generation GENERATION_FROM_SESSION

EXPLICIT LAN TLS
  Configure the session endpoint before restarting OMP:

    node /abs/repo/cli.mjs config --host 192.0.2.10 --port 9443 --protocol https

  No manual certificate paths are needed. OpenSSL must be installed (Debian/Ubuntu:
  apt install openssl; macOS: brew install openssl). Managed files live privately
  under <root>/tls; their IP SAN matches the bind IP. They are reused across
  restarts; changing the IP selects a matching certificate. /lanrpc info shows
  its certificate and token file paths, and displays the token with c-to-copy.
  Advanced custom TLS: add --tls-cert /abs/server.crt --tls-key /abs/server.key.
  The certificate must be currently valid with an IP SAN matching the bind IP.
  Securely transfer ONLY the public certificate (not the key) and token to the
  client via SSH/SCP or another authenticated channel. Keep the token file private
  (chmod 600). Explicitly trust the certificate using --ca or your trust store;
  there is no insecure mode, implicit download trust, or automatic client trust.

    node /abs/repo/cli.mjs session --endpoint https://192.0.2.10:9443 \\
      --token-file /secure/omp.token --ca /secure/omp-ca.crt
    node /abs/repo/cli.mjs send --endpoint https://192.0.2.10:9443 \\
      --token-file /secure/omp.token --ca /secure/omp-ca.crt \\
      --message-file /abs/prompt.txt --request-id client_job_1 --wait
    node /abs/repo/cli.mjs request --endpoint https://192.0.2.10:9443 \\
      --token-file /secure/omp.token --ca /secure/omp-ca.crt \\
      --request-id client_job_1 --generation GENERATION_FROM_SESSION

EXPLICIT PLAINTEXT LAN HTTP (UNENCRYPTED, NO AUTHENTICATION)
  Anyone who can reach this port can control this agent and its tools. Network
  observers can read or alter all messages and responses. Choose HTTPS or an SSH
  tunnel instead unless you explicitly accept this risk.
  On the OMP host, explicitly save HTTP and then restart the listener:

    node /abs/repo/cli.mjs config --host 192.0.2.10 --port 9443 --protocol http

  No token, certificate, or private key is created or required. Saved custom TLS
  paths are retained but never read. --token-file and --ca are rejected without
  reading them. On every non-loopback client connection, opt in explicitly:

    node /abs/repo/cli.mjs session --endpoint http://192.0.2.10:9443 \\
      --allow-http
    node /abs/repo/cli.mjs send --endpoint http://192.0.2.10:9443 \\
      --allow-http --message-file /abs/prompt.txt
    node /abs/repo/cli.mjs request --endpoint http://192.0.2.10:9443 \\
      --allow-http \\
      --request-id REQUEST_ID --generation GENERATION_FROM_SESSION

  --allow-http is also required for a discovered non-loopback HTTP endpoint.
  Generated recovery/query commands retain this flag and contain no HTTP token
  file. The flag never permits redirects or disables HTTPS certificate verification.

SECURITY AND PROTOCOL BOUNDARY
  This is the narrow HTTP/JSON protocol v1 (session metadata, submit, and request
  status), not OMP's native stdio RPC. It exposes no arbitrary shell/tool or
  session-switch endpoint. Nevertheless, a token grants the ability to instruct
  a trusted agent, which may exercise all capabilities/tools configured for that
  agent. It is authentication, not a sandbox. Treat it as a high-value secret.
  HTTP has no authentication: all reachable callers have that same control.

  Tokens, request records, and generation IDs are runtime state. They have no
  durability across OMP shutdown or a committed session change; reconnect and
  rediscover after either event.
  A newly submitted ID is scoped to the generation selected by that send command.
  After a lost response, query the original instance/generation before taking
  further action; repeating send after a restart is NOT an exactly-once retry.
  SSH port forwarding to a loopback listener is an alternative to direct LAN TLS.
`;

class CliError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function safeServerText(value, token) {
  if (typeof value !== "string") return undefined;
  let text = value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 512);
  if (token && text.includes(token)) text = text.split(token).join("[redacted]");
  return text;
}

function parseOptions(args, specification) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      if (args.length !== 1) throw new CliError("--help cannot be combined with other arguments");
      return { help: true };
    }
    if (!argument.startsWith("--")) throw new CliError(`unexpected positional argument: ${argument}`);

    const equals = argument.indexOf("=");
    const name = equals === -1 ? argument : argument.slice(0, equals);
    const kind = specification[name];
    if (!kind) throw new CliError(`unknown option: ${name}`);
    if (Object.hasOwn(options, name)) throw new CliError(`option may be specified only once: ${name}`);

    if (kind === "boolean") {
      if (equals !== -1) throw new CliError(`${name} does not take a value`);
      options[name] = true;
      continue;
    }

    let value;
    if (equals !== -1) {
      value = argument.slice(equals + 1);
    } else {
      index += 1;
      value = args[index];
    }
    if (value === undefined || value.startsWith("--")) throw new CliError(`${name} requires a value`);
    if (value.length === 0) throw new CliError(`${name} cannot be empty`);
    options[name] = value;
  }
  return options;
}

const CONNECTION_SPEC = Object.freeze({
  "--instance": "value",
  "--endpoint": "value",
  "--token-file": "value",
  "--ca": "value",
  "--allow-http": "boolean",
});

function connectionSpec(extra = {}) {
  return { ...CONNECTION_SPEC, ...extra };
}

function requireOption(options, name) {
  const value = options[name];
  if (value === undefined) throw new CliError(`${name} is required`);
  return value;
}

function parseNonnegativeInteger(value, name) {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new CliError(`${name} must be a nonnegative integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new CliError(`${name} is outside the safe integer range`);
  return parsed;
}

function parsePositiveInteger(value, name) {
  const parsed = parseNonnegativeInteger(value, name);
  if (parsed === 0) throw new CliError(`${name} must be a positive integer`);
  return parsed;
}

function parsePort(value) {
  const port = parseNonnegativeInteger(value, "--port");
  if (port > 65_535) throw new CliError("--port must be between 0 and 65535");
  return port;
}

function parseLanMode(value) {
  if (value === "on") return true;
  if (value === "off") return false;
  throw new CliError("--lan must be on or off");
}

function parseWaitSeconds(value) {
  if (!/^(?:[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value)) {
    throw new CliError("--timeout must be a positive number of seconds");
  }
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds > MAX_WAIT_SECONDS) {
    throw new CliError(`--timeout must be at most ${MAX_WAIT_SECONDS} seconds`);
  }
  return seconds;
}

function validateRequestId(value) {
  if (!REQUEST_ID_PATTERN.test(value)) {
    throw new CliError("--request-id must match [A-Za-z0-9_-]{1,128}");
  }
  return value;
}

function validateInstanceId(value) {
  if (!UUID_PATTERN.test(value)) throw new CliError("--instance must be a UUID");
  return value;
}

function isLoopbackHostname(hostname) {
  const unbracketed = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  const normalized = unbracketed.toLowerCase().replace(/\.$/, "");
  if (normalized === "::1") return true;
  if (net.isIP(normalized) !== 4) return false;
  const firstOctet = Number(normalized.split(".", 1)[0]);
  return firstOctet === 127;
}

function parseEndpoint(raw, allowHttp) {
  const originMatch = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]+)\/?$/.exec(raw);
  if (originMatch === null) {
    throw new CliError("endpoint must be an origin without credentials, a path, query, or fragment");
  }
  if (originMatch[1].includes("@")) throw new CliError("endpoint URL credentials are forbidden");

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new CliError("--endpoint (or discovered endpoint) must be a valid URL origin");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new CliError("endpoint scheme must be http or https");
  }
  if (url.username || url.password) throw new CliError("endpoint URL credentials are forbidden");
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new CliError("endpoint must be an origin without a path, query, or fragment");
  }
  if (url.protocol === "http:" && !isLoopbackHostname(url.hostname) && !allowHttp) {
    throw new CliError("Non-loopback HTTP is unencrypted with NO authentication; anyone reaching the port can control the agent. Use HTTPS or explicitly pass --allow-http");
  }
  return url;
}

async function readBoundedFile(filePath, maximum, label) {
  let handle;
  try {
    handle = await open(filePath, "r");
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new CliError(`${label} is not a regular file: ${filePath}`);
    if (metadata.size > maximum) throw new CliError(`${label} exceeds ${maximum} bytes: ${filePath}`);
    return { data: await handle.readFile(), metadata };
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(`cannot read ${label} ${filePath}: ${error.message}`);
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function readPrivateToken(filePath) {
  const absolutePath = resolve(filePath);
  const token = (await readPrivateFile(absolutePath, MAX_TOKEN_BYTES)).trim();
  if (!token || token.length > MAX_TOKEN_BYTES || /[\r\n]/.test(token) || !/^[\x21-\x7e]+$/.test(token)) {
    throw new CliError(`token file does not contain one valid ASCII bearer token: ${absolutePath}`);
  }
  return { token, tokenFile: absolutePath };
}

async function readCa(filePath) {
  if (filePath === undefined) return undefined;
  const absolutePath = resolve(filePath);
  const { data } = await readBoundedFile(absolutePath, MAX_CA_BYTES, "CA file");
  return { ca: data, caFile: absolutePath };
}

function isPidLive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function validateDescriptor(value, fileName) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  if (typeof value.instanceId !== "string" || `${value.instanceId}.json` !== fileName) return undefined;
  if (!UUID_PATTERN.test(value.instanceId)) return undefined;
  if (!Number.isSafeInteger(value.pid) || value.pid <= 0) return undefined;
  if (typeof value.endpoint !== "string") return undefined;
  let protocol;
  try { protocol = new URL(value.endpoint).protocol; } catch { return undefined; }
  if (protocol === "https:") {
    if (typeof value.tokenFile !== "string" || !isAbsolute(value.tokenFile)) return undefined;
    if (value.tokenFile !== join(rootDir(), "instances", `${value.instanceId}.token`)) return undefined;
  } else if (protocol !== "http:" || value.tokenFile !== undefined) return undefined;
  if (!Number.isSafeInteger(value.generation) || value.generation <= 0) return undefined;
  if (value.sessionId !== null && typeof value.sessionId !== "string") return undefined;
  return value;
}

async function loadDescriptorEntries() {
  const instancesDir = join(rootDir(), "instances");
  if (!(await assertExistingPrivateRoot(rootDir())) || !(await assertExistingPrivateRoot(instancesDir))) return [];
  let directoryEntries;
  try {
    directoryEntries = await readdir(instancesDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw new CliError(`cannot read local instance directory ${instancesDir}: ${error.message}`);
  }

  const entries = [];
  for (const directoryEntry of directoryEntries) {
    if (!directoryEntry.isFile() || !directoryEntry.name.endsWith(".json")) continue;
    const descriptorPath = join(instancesDir, directoryEntry.name);
    try {
      const source = await readPrivateFile(descriptorPath, MAX_DESCRIPTOR_BYTES);
      const parsed = JSON.parse(source);
      const descriptor = validateDescriptor(parsed, directoryEntry.name);
      if (!descriptor) {
        entries.push({ file: directoryEntry.name, status: "invalid" });
        continue;
      }
      entries.push({ descriptor, status: isPidLive(descriptor.pid) ? "live" : "stale" });
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      entries.push({ file: directoryEntry.name, status: "invalid" });
    }
  }
  entries.sort((left, right) => {
    const leftName = left.descriptor?.instanceId ?? left.file;
    const rightName = right.descriptor?.instanceId ?? right.file;
    return leftName.localeCompare(rightName);
  });
  return entries;
}

async function selectLocalDescriptor(instanceId) {
  const entries = await loadDescriptorEntries();
  const validEntries = entries.filter((entry) => entry.descriptor);
  if (instanceId !== undefined) {
    const selected = validEntries.find((entry) => entry.descriptor.instanceId === instanceId);
    if (!selected) throw new CliError(`local instance not found: ${instanceId}`);
    if (selected.status !== "live") throw new CliError(`local instance PID is stale: ${instanceId}`);
    return selected.descriptor;
  }

  const liveEntries = validEntries.filter((entry) => entry.status === "live");
  if (liveEntries.length === 0) {
    throw new CliError("no PID-live local instance found; start/restart OMP or use an explicit remote connection");
  }
  if (liveEntries.length !== 1) {
    const ids = liveEntries.map((entry) => entry.descriptor.instanceId).join(", ");
    throw new CliError(`multiple PID-live local instances found (${ids}); select one with --instance UUID`);
  }
  return liveEntries[0].descriptor;
}

async function resolveConnection(options) {
  const instanceOption = options["--instance"];
  const endpointOption = options["--endpoint"];
  const tokenFileOption = options["--token-file"];
  const caOption = options["--ca"];
  const allowHttp = options["--allow-http"] === true;

  if (instanceOption !== undefined && (endpointOption !== undefined || tokenFileOption !== undefined)) {
    throw new CliError("--instance cannot be combined with --endpoint or --token-file");
  }
  if (endpointOption === undefined && tokenFileOption !== undefined) {
    throw new CliError("--token-file requires an explicit HTTPS --endpoint");
  }

  let endpoint;
  let tokenPath;
  let instanceId;
  let mode;
  if (endpointOption !== undefined) {
    endpoint = parseEndpoint(endpointOption, allowHttp);
    tokenPath = tokenFileOption;
    mode = "remote";
  } else {
    const requestedInstance = instanceOption === undefined ? undefined : validateInstanceId(instanceOption);
    const descriptor = await selectLocalDescriptor(requestedInstance);
    endpoint = parseEndpoint(descriptor.endpoint, allowHttp);
    tokenPath = descriptor.tokenFile;
    instanceId = descriptor.instanceId;
    mode = "local";
  }

  if (caOption !== undefined && endpoint.protocol !== "https:") {
    throw new CliError("--ca is valid only for an HTTPS endpoint");
  }
  let credentials;
  let caDetails;
  if (endpoint.protocol === "http:") {
    if (tokenFileOption !== undefined) throw new CliError("HTTP has NO authentication; --token-file is forbidden and was not read");
  } else {
    if (!tokenPath) throw new CliError("HTTPS requires --token-file with a private bearer token file");
    [credentials, caDetails] = await Promise.all([readPrivateToken(tokenPath), readCa(caOption)]);
  }

  return {
    endpoint,
    token: credentials?.token,
    tokenFile: credentials?.tokenFile,
    ca: caDetails?.ca,
    caFile: caDetails?.caFile,
    instanceId,
    mode,
    allowHttp,
  };
}

function stringifyRequestBody(body) {
  let encoded;
  try {
    encoded = Buffer.from(JSON.stringify(body), "utf8");
  } catch (error) {
    throw new CliError(`cannot encode request JSON: ${error.message}`);
  }
  if (encoded.length > MAX_REQUEST_JSON_BYTES) {
    throw new CliError(`request JSON exceeds the ${MAX_REQUEST_JSON_BYTES}-byte protocol limit`);
  }
  return encoded;
}

async function requestJson(connection, method, route, body, timeoutMs = HTTP_TIMEOUT_MS) {
  const target = new URL(route, connection.endpoint);
  const requestBody = body === undefined ? undefined : stringifyRequestBody(body);
  const headers = {
    Accept: "application/json",
  };
  if (target.protocol === "https:") headers.Authorization = `Bearer ${connection.token}`;
  if (requestBody !== undefined) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = String(requestBody.length);
  }

  const transport = target.protocol === "https:" ? https : http;
  return await new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    };
    const request = transport.request(target, {
      method,
      headers,
      ca: connection.ca,
      rejectUnauthorized: true,
      maxHeaderSize: 16 * 1024,
      timeout: Math.max(1, Math.floor(timeoutMs)),
    }, (response) => {
      const chunks = [];
      let length = 0;
      response.on("data", (chunk) => {
        if (settled) return;
        length += chunk.length;
        if (length > MAX_RESPONSE_JSON_BYTES) {
          response.destroy();
          fail(new CliError(`response JSON exceeds the ${MAX_RESPONSE_JSON_BYTES}-byte client safety limit`));
          return;
        }
        chunks.push(chunk);
      });
      response.on("error", fail);
      response.on("end", () => {
        if (settled) return;
        const statusCode = response.statusCode ?? 0;
        if (statusCode >= 300 && statusCode < 400) {
          fail(new CliError(`server returned HTTP ${statusCode}; redirects are forbidden`));
          return;
        }
        let payload;
        try {
          payload = JSON.parse(Buffer.concat(chunks, length).toString("utf8"));
        } catch {
          fail(new CliError(`server returned non-JSON HTTP ${response.statusCode ?? "response"}`));
          return;
        }
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
          fail(new CliError("server returned a non-object JSON response"));
          return;
        }
        if (statusCode < 200 || statusCode >= 300) {
          const code = safeServerText(payload.error?.code, connection.token) ?? `http_${statusCode}`;
          const message = safeServerText(payload.error?.message, connection.token) ?? "request rejected";
          fail(new CliError(`${code}: ${message} (HTTP ${statusCode})`));
          return;
        }
        settled = true;
        resolvePromise({ statusCode, payload });
      });
    });
    request.on("timeout", () => request.destroy(new CliError(`endpoint did not respond within ${Math.ceil(timeoutMs / 1000)}s`)));
    request.on("error", fail);
    request.end(requestBody);
  });
}

function requireHttpStatus(response, expected, operation) {
  if (response.statusCode !== expected) {
    throw new CliError(`${operation} returned HTTP ${response.statusCode}; protocol v${PROTOCOL_VERSION} requires ${expected}`);
  }
  return response.payload;
}

function validateSession(payload) {
  if (payload.protocolVersion !== PROTOCOL_VERSION) {
    throw new CliError(`unsupported protocol version: ${String(payload.protocolVersion)}`);
  }
  if (!Number.isSafeInteger(payload.generation) || payload.generation <= 0) {
    throw new CliError("server returned an invalid session generation");
  }
  return payload;
}

function validateRecord(payload, requestId, generation) {
  if (payload.requestId !== requestId || payload.generation !== generation) {
    throw new CliError("server returned a request record for a different ID or generation");
  }
  if (!KNOWN_STATES.has(payload.state)) throw new CliError(`server returned an unknown request state: ${String(payload.state)}`);
  return payload;
}

function recordExitCode(record) {
  return record.state === "failed" || record.state === "interrupted" ? 2 : 0;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function requestQueryCommand(connection, requestId, generation) {
  const executable = resolve(process.argv[1]);
  const parts = [process.execPath, executable, "request"];
  if (connection.mode === "local") {
    parts.push("--instance", connection.instanceId);
  } else {
    parts.push("--endpoint", connection.endpoint.origin);
    if (connection.tokenFile) parts.push("--token-file", connection.tokenFile);
  }
  if (connection.caFile) parts.push("--ca", connection.caFile);
  if (connection.allowHttp) parts.push("--allow-http");
  parts.push("--request-id", requestId, "--generation", String(generation));
  return parts.map(shellQuote).join(" ");
}

async function readMessage(filePath) {
  const absolutePath = resolve(filePath);
  const { data } = await readBoundedFile(absolutePath, MAX_MESSAGE_BYTES, "message file");
  let message;
  try {
    message = new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    throw new CliError(`message file is not valid UTF-8: ${absolutePath}`);
  }
  if (!message.trim()) throw new CliError(`message file contains no non-whitespace text: ${absolutePath}`);
  return message;
}

async function commandList(args) {
  const options = parseOptions(args, {});
  if (options.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const entries = await loadDescriptorEntries();
  const instances = entries.map((entry) => {
    if (!entry.descriptor) return { file: entry.file, status: "invalid" };
    const { instanceId, pid, endpoint, generation, sessionId } = entry.descriptor;
    return { instanceId, pid, status: entry.status, endpoint, generation, sessionId };
  });
  printJson({ rootDir: rootDir(), instances });
  return 0;
}

async function commandConfig(args) {
  const options = parseOptions(args, {
    "--host": "value",
    "--port": "value",
    "--lan": "value",
    "--protocol": "value",
    "--tls-cert": "value",
    "--tls-key": "value",
  });
  if (options.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const current = await readConfig();
  const next = { ...current };
  let changed = false;
  const host = options["--host"];
  if (host !== undefined) {
    next.host = host;
    changed = true;
  }
  // Moving from local defaults to LAN must not silently opt into plaintext.
  if (host !== undefined && !isLoopbackHost(host) && isLoopbackHost(current.host)) {
    next.protocol = "https";
  }
  if (options["--protocol"] !== undefined) {
    next.protocol = options["--protocol"];
    changed = true;
  }
  if (options["--port"] !== undefined) {
    next.port = parsePort(options["--port"]);
    changed = true;
  }
  if (options["--tls-cert"] !== undefined) {
    next.tlsCert = resolve(options["--tls-cert"]);
    changed = true;
  }
  if (options["--tls-key"] !== undefined) {
    next.tlsKey = resolve(options["--tls-key"]);
    changed = true;
  }

  const lan = options["--lan"];
  if (lan !== undefined) {
    next.lanEnabled = parseLanMode(lan);
    changed = true;
  } else if (host !== undefined) {
    next.lanEnabled = !isLoopbackHost(host);
  }

  const config = changed ? await writeConfig(next) : current;
  printJson({
    host: config.host,
    port: config.port,
    lanEnabled: config.lanEnabled,
    protocol: config.protocol,
    tlsCert: config.tlsCert ?? null,
    tlsKey: config.tlsKey ?? null,
  });
  return 0;
}

async function commandSession(args) {
  const options = parseOptions(args, connectionSpec());
  if (options.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const connection = await resolveConnection(options);
  const response = await requestJson(connection, "GET", "/v1/session");
  const session = validateSession(requireHttpStatus(response, 200, "session request"));
  printJson(session);
  return 0;
}

async function commandRequest(args) {
  const options = parseOptions(args, connectionSpec({
    "--request-id": "value",
    "--generation": "value",
  }));
  if (options.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const requestId = validateRequestId(requireOption(options, "--request-id"));
  const generation = parsePositiveInteger(requireOption(options, "--generation"), "--generation");
  const connection = await resolveConnection(options);
  const route = `/v1/requests/${encodeURIComponent(requestId)}?generation=${encodeURIComponent(String(generation))}`;
  const response = await requestJson(connection, "GET", route);
  const record = validateRecord(requireHttpStatus(response, 200, "request lookup"), requestId, generation);
  printJson(record);
  return recordExitCode(record);
}

async function commandSend(args) {
  const options = parseOptions(args, connectionSpec({
    "--message-file": "value",
    "--request-id": "value",
    "--wait": "boolean",
    "--timeout": "value",
  }));
  if (options.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const wait = options["--wait"] === true;
  if (!wait && options["--timeout"] !== undefined) throw new CliError("--timeout requires --wait");
  const timeoutSeconds = options["--timeout"] === undefined
    ? DEFAULT_WAIT_SECONDS
    : parseWaitSeconds(options["--timeout"]);
  const requestId = options["--request-id"] === undefined
    ? randomUUID()
    : validateRequestId(options["--request-id"]);
  const message = await readMessage(requireOption(options, "--message-file"));
  const connection = await resolveConnection(options);

  const sessionResponse = await requestJson(connection, "GET", "/v1/session");
  const session = validateSession(requireHttpStatus(sessionResponse, 200, "session request"));
  const generation = session.generation;

  let postResponse;
  try {
    postResponse = await requestJson(connection, "POST", "/v1/requests", {
      generation,
      requestId,
      message,
    });
  } catch (error) {
    throw new CliError(
      `submission outcome is unknown for request ${requestId}: ${error.message}\n` +
      "Do not resubmit into a new session: execution may already have happened. " +
      "Query the original instance/generation; if unavailable, inspect that OMP session manually.\n" +
      `Query it with:\n  ${requestQueryCommand(connection, requestId, generation)}`, 
      error.exitCode ?? 1,
    );
  }
  let record = validateRecord(requireHttpStatus(postResponse, 202, "request submission"), requestId, generation);
  if (!wait || TERMINAL_STATES.has(record.state)) {
    printJson(record);
    return recordExitCode(record);
  }

  const deadline = Date.now() + timeoutSeconds * 1000;
  const queryCommand = requestQueryCommand(connection, requestId, generation);
  const route = `/v1/requests/${encodeURIComponent(requestId)}?generation=${encodeURIComponent(String(generation))}`;
  while (!TERMINAL_STATES.has(record.state)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new CliError(
        `timed out waiting for accepted request ${requestId} after ${timeoutSeconds}s. ` +
        "The timeout did not cancel it; the record remains queryable while this OMP session generation is alive.\n" +
        `Query it with:\n  ${queryCommand}`,
        3,
      );
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.min(500, remaining)));
    const afterDelay = deadline - Date.now();
    if (afterDelay <= 0) continue;
    try {
      const pollResponse = await requestJson(connection, "GET", route, undefined, Math.min(HTTP_TIMEOUT_MS, afterDelay));
      record = validateRecord(requireHttpStatus(pollResponse, 200, "request lookup"), requestId, generation);
    } catch (error) {
      throw new CliError(
        `request ${requestId} was accepted, but polling failed: ${error.message}\n` +
        "The request is not canceled; while this OMP session generation is alive, query it with:\n" +
        `  ${queryCommand}`,
        error.exitCode ?? 1,
      );
    }
  }
  printJson(record);
  return recordExitCode(record);
}

async function main(argv) {
  if (argv.length === 0 || argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") {
    if (argv.length > 2 || (argv.length === 2 && !["list", "config", "session", "send", "request"].includes(argv[1]))) {
      throw new CliError("help accepts at most one command name");
    }
    process.stdout.write(HELP);
    return 0;
  }

  const [command, ...args] = argv;
  switch (command) {
    case "list": return await commandList(args);
    case "config": return await commandConfig(args);
    case "session": return await commandSession(args);
    case "send": return await commandSend(args);
    case "request": return await commandRequest(args);
    default: throw new CliError(`unknown command: ${command}\nRun ${process.argv[1]} help for usage.`);
  }
}

main(process.argv.slice(2)).then(
  (exitCode) => { process.exitCode = exitCode; },
  (error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`error: ${message}\n`);
    process.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
  },
);
