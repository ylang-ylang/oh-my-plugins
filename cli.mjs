#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { open, readdir } from "node:fs/promises";
import { isIP } from "node:net";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assertExistingPrivateRoot, isLoopbackHost, readConfig, readPrivateFile, rootDir, writeConfig } from "./config.mjs";
import { ID_PATTERN, LIMITS, TERMINAL_STATES, UUID_PATTERN } from "./protocol.mjs";
import { RpcClient, RpcError } from "./sdk.mjs";

const MAX_DESCRIPTOR_BYTES = 64 * 1024;
const MAX_TOKEN_BYTES = 4 * 1024;
const MAX_CA_BYTES = 1024 * 1024;
const MAX_RELAY_BYTES = LIMITS.resultBytes + LIMITS.requestBytes + 64 * 1024;
const DEFAULT_WAIT_SECONDS = 300;
const MAX_WAIT_SECONDS = 86_400;
const POLL_MS = 500;

const HELP = `omp-lan-rpc: request-scoped LAN RPC v2 client

USAGE
  node /abs/repo/cli.mjs help [COMMAND]
  node /abs/repo/cli.mjs list
  node /abs/repo/cli.mjs config [--host HOST] [--port PORT]
                                  [--lan on|off] [--protocol http|https]
                                  [--tls-cert PATH] [--tls-key PATH]
  node /abs/repo/cli.mjs session [CONNECTION]
  node /abs/repo/cli.mjs send [CONNECTION] --message-file PATH
      [--request-id ID] [--response-mode native|structured]
      [--result-schema-file PATH] [--wait] [--timeout SECONDS]
  node /abs/repo/cli.mjs submit [CONNECTION] --request-file PATH
      [--wait] [--timeout SECONDS]
  node /abs/repo/cli.mjs request [CONNECTION] IDENTITY
  node /abs/repo/cli.mjs cancel [CONNECTION] IDENTITY
  node /abs/repo/cli.mjs events [CONNECTION] IDENTITY [--after SEQUENCE]
  node /abs/repo/cli.mjs tools [CONNECTION] IDENTITY
  node /abs/repo/cli.mjs claim [CONNECTION] IDENTITY --tool-call-id UUID
      --worker-id ID --claim-id ID [--lease-ms MS] [--renew]
  node /abs/repo/cli.mjs result [CONNECTION] IDENTITY --tool-call-id UUID
      --result-file PATH
  node /abs/repo/cli.mjs artifacts [CONNECTION] IDENTITY
  node /abs/repo/cli.mjs download [CONNECTION] IDENTITY --artifact-id UUID
      --output PATH

CONNECTION
  Local discovery (recommended on the OMP host):
    --instance UUID       Select one private runtime descriptor. With no
                          connection flag, exactly one PID-live instance is required.

  Explicit direct HTTP(S), never an SSH fallback:
    --endpoint ORIGIN     Example: https://192.0.2.10:9443
    --token-file PATH     Required for HTTPS; forbidden and unread for HTTP.
    --ca PATH             Optional trusted CA bundle; HTTPS only.
    --allow-http          Explicit consent for anonymous non-loopback plaintext HTTP.

  --endpoint cannot be combined with --instance. Origins cannot contain URL
  credentials, paths, queries, or fragments. Redirects are never followed.
  HTTPS always verifies its certificate and hostname. --allow-http never weakens
  TLS. HTTP is anonymous and never reads or sends a bearer token.

  Cross-machine access should use sdk.mjs SshRpcClient or ssh-demo.mjs with a
  literal machine IP and selected instance. Every JSON operation and artifact
  byte then runs through the existing, host-verified OpenSSH connection and the
  remote CLI. There is no local port, extra daemon, base64, direct fallback, or
  copied credential. OpenSSH BatchMode and StrictHostKeyChecking are mandatory;
  User, Port and ProxyJump continue to come from system OpenSSH configuration.

  Node is the supplied example, not a local client-language restriction. Python,
  Go, Rust, and other callers can invoke the same OpenSSH + remote-CLI JSON/binary
  contract. The remote cli.mjs still requires Node >=22 on the OMP machine.

IDENTITY
  --request-id ID --generation GEN [--instance-id UUID]

  Local discovery supplies and verifies instanceId, so --instance-id is optional.
  An explicit --endpoint has no descriptor and therefore requires --instance-id.
  Every mutation and query remains pinned to instanceId plus generation. Never
  substitute a newly discovered generation after a timeout or uncertain result.

COMMANDS
  list
    Print local descriptor metadata and PID status as JSON. Token contents and
    token-file paths are omitted. Stale/invalid descriptors are not removed.

  config
    Print or update future listener defaults. Moving from loopback to LAN defaults
    to verified HTTPS unless --protocol http is explicit. --lan off retains saved
    LAN/TLS settings. Key contents are never printed. Restart OMP to apply changes.

  session
    Print v2 identity, queue state, and capabilities.

  send
    Read the user message from a bounded UTF-8 file. Native is the default and
    returns the original host message array, including thinking and tool content.
    Structured requires --result-schema-file and accepts only rpc_result data that
    validates against that draft-2020-12 schema. No assistant-text JSON extraction
    or mode fallback occurs. send declares no caller tools; use submit for those.

  submit
    Submit a complete v2 request object from --request-file, including explicit
    instanceId, generation, requestId, responseMode, schemas, tools and timeouts.
    The file is never placed on argv. A transport error has an uncertain outcome:
    do not resubmit; query the original identity first.

  request / cancel / events
    Query, cancel, or poll one exact request. events preserves native event data
    without filtering. --after defaults to 0. Cancellation is idempotent.

  tools / claim / result
    List tool calls; claim one with a caller worker/claim and optional lease; or
    submit a bounded result-file containing {"leaseId":"...","outcome":{...}}.
    --renew repeats the same workerId/claimId claim with renew:true. A lease is not
    exactly-once execution: durable side effects must deduplicate by toolCallId.

  artifacts / download
    List registered immutable artifact metadata or download one ID to a newly
    created local file. Existing output files are never overwritten; partial files
    are removed. There is no arbitrary remote path download.

WAITING AND EXIT STATUS
  --wait polls the accepted request; default timeout ${DEFAULT_WAIT_SECONDS}s, maximum
  ${MAX_WAIT_SECONDS}s. It does not cancel on timeout. The CLI prints a recovery command.
  completed exits 0; failed/interrupted/cancelled exits 2; wait timeout exits 3.
  The SDK run() helper, unlike passive CLI waiting, concurrently polls native
  events and claims/renews/executes declared caller-tool handlers to avoid deadlock.

LOCAL EXAMPLES
  Native request:
    node /abs/repo/cli.mjs send --instance INSTANCE_UUID \\
      --message-file /abs/prompt.txt --response-mode native --wait

  Complete structured request with caller tools:
    node /abs/repo/cli.mjs submit --instance INSTANCE_UUID \\
      --request-file /abs/request.json
    node /abs/repo/cli.mjs tools --instance INSTANCE_UUID \\
      --request-id job_1 --generation 123
    node /abs/repo/cli.mjs claim --instance INSTANCE_UUID \\
      --request-id job_1 --generation 123 --tool-call-id CALL_UUID \\
      --worker-id worker_1 --claim-id claim_1
    node /abs/repo/cli.mjs result --instance INSTANCE_UUID \\
      --request-id job_1 --generation 123 --tool-call-id CALL_UUID \\
      --result-file /abs/tool-result.json
    node /abs/repo/cli.mjs download --instance INSTANCE_UUID \\
      --request-id job_1 --generation 123 --artifact-id ARTIFACT_UUID \\
      --output /abs/report.txt

  request.json selects semantics explicitly; a minimal native file is:
    {"instanceId":"INSTANCE_UUID","generation":123,"requestId":"job_1",
     "message":"Explain the current task.","responseMode":"native"}

  A structured file adds responseMode:"structured", resultSchema, and optional
  tools entries. See examples/client.mjs for SDK run(), lookup_item handling,
  artifact download, and native raw events.

SECURITY AND RECOVERY
  Runtime/config root is OMP_LAN_RPC_DIR or ~/.omp/lan-rpc. Private directories
  must be owned mode 0700 and descriptor/token files mode 0600/0400. HTTP remains
  anonymous. HTTPS uses its private bearer credential. Tokens are never printed
  by list/session/relay, copied through SSH, or included in request records.
  Unknown/changed SSH hosts fail; establish trust separately. After any uncertain
  submission or tool-result response, query the same immutable identity. Never
  automatically execute a caller handler again merely because the network failed.
`;

class CliError extends Error {
  constructor(message, exitCode = 1, fields = {}) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
    Object.assign(this, fields);
  }
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
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
    const value = equals === -1 ? args[++index] : argument.slice(equals + 1);
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
const IDENTITY_SPEC = Object.freeze({
  "--instance-id": "value",
  "--request-id": "value",
  "--generation": "value",
});
function spec(extra = {}) { return { ...CONNECTION_SPEC, ...extra }; }
function identitySpec(extra = {}) { return spec({ ...IDENTITY_SPEC, ...extra }); }

function requireOption(options, name) {
  if (options[name] === undefined) throw new CliError(`${name} is required`);
  return options[name];
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

function parseWaitSeconds(value) {
  if (!/^(?:[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value)) throw new CliError("--timeout must be a positive number of seconds");
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds > MAX_WAIT_SECONDS) throw new CliError(`--timeout must be at most ${MAX_WAIT_SECONDS} seconds`);
  return seconds;
}

function validateUuid(value, name) {
  if (!UUID_PATTERN.test(value ?? "")) throw new CliError(`${name} must be a UUID`);
  return value;
}

function validateId(value, name) {
  if (!ID_PATTERN.test(value ?? "")) throw new CliError(`${name} must match [A-Za-z0-9_-]{1,128}`);
  return value;
}

function endpointUrl(raw) {
  if (typeof raw !== "string" || !/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]+\/?$/.test(raw)) {
    throw new CliError("endpoint must be an origin without credentials, a path, query, or fragment");
  }
  let url;
  try { url = new URL(raw); } catch { throw new CliError("endpoint must be a valid URL origin"); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new CliError("endpoint must be an HTTP(S) origin without credentials, a path, query, or fragment");
  }
  return url;
}

function loopbackHostname(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  return host === "::1" || (isIP(host) === 4 && Number(host.split(".", 1)[0]) === 127);
}

async function readBoundedFile(filePath, maximum, label) {
  const absolute = resolve(filePath);
  let handle;
  try {
    handle = await open(absolute, "r");
    const stat = await handle.stat();
    if (!stat.isFile()) throw new CliError(`${label} is not a regular file: ${absolute}`);
    if (stat.size > maximum) throw new CliError(`${label} exceeds ${maximum} bytes: ${absolute}`);
    return { data: await handle.readFile(), path: absolute };
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(`cannot read ${label} ${absolute}: ${error.message}`);
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function readUtf8File(filePath, maximum, label) {
  const source = await readBoundedFile(filePath, maximum, label);
  try { return { text: new TextDecoder("utf-8", { fatal: true }).decode(source.data), path: source.path }; } catch {
    throw new CliError(`${label} is not valid UTF-8: ${source.path}`);
  }
}

async function readJsonFile(filePath, maximum, label, objectRequired = true) {
  const { text, path } = await readUtf8File(filePath, maximum, label);
  let value;
  try { value = JSON.parse(text); } catch (error) { throw new CliError(`${label} is not valid JSON (${path}): ${error.message}`); }
  if (objectRequired && (!value || typeof value !== "object" || Array.isArray(value))) throw new CliError(`${label} must contain a JSON object: ${path}`);
  return value;
}

async function readPrivateToken(filePath) {
  const absolute = resolve(filePath);
  const token = (await readPrivateFile(absolute, MAX_TOKEN_BYTES)).trim();
  if (!token || token.length > MAX_TOKEN_BYTES || /[\r\n]/.test(token) || !/^[\x21-\x7e]+$/.test(token)) {
    throw new CliError(`token file does not contain one valid ASCII bearer token: ${absolute}`);
  }
  return { token, path: absolute };
}

function isPidLive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}

function validateDescriptor(value, fileName) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  if (!UUID_PATTERN.test(value.instanceId ?? "") || `${value.instanceId}.json` !== fileName) return undefined;
  if (!Number.isSafeInteger(value.pid) || value.pid <= 0 || typeof value.endpoint !== "string") return undefined;
  let url;
  try { url = endpointUrl(value.endpoint); } catch { return undefined; }
  if (url.protocol === "https:") {
    if (typeof value.tokenFile !== "string" || !isAbsolute(value.tokenFile)) return undefined;
    if (value.tokenFile !== join(rootDir(), "instances", `${value.instanceId}.token`)) return undefined;
  } else if (value.tokenFile !== undefined) return undefined;
  if (!Number.isSafeInteger(value.generation) || value.generation <= 0) return undefined;
  if (value.sessionId !== null && typeof value.sessionId !== "string") return undefined;
  return value;
}

async function loadDescriptorEntries() {
  const instances = join(rootDir(), "instances");
  if (!(await assertExistingPrivateRoot(rootDir())) || !(await assertExistingPrivateRoot(instances))) return [];
  let entries;
  try { entries = await readdir(instances, { withFileTypes: true }); } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw new CliError(`cannot read local instance directory ${instances}: ${error.message}`);
  }
  const result = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(await readPrivateFile(join(instances, entry.name), MAX_DESCRIPTOR_BYTES));
      const descriptor = validateDescriptor(parsed, entry.name);
      result.push(descriptor ? { descriptor, status: isPidLive(descriptor.pid) ? "live" : "stale" } : { file: entry.name, status: "invalid" });
    } catch (error) {
      if (error?.code !== "ENOENT") result.push({ file: entry.name, status: "invalid" });
    }
  }
  result.sort((left, right) => (left.descriptor?.instanceId ?? left.file).localeCompare(right.descriptor?.instanceId ?? right.file));
  return result;
}

async function selectDescriptor(instanceId) {
  const entries = await loadDescriptorEntries();
  const valid = entries.filter((entry) => entry.descriptor);
  if (instanceId !== undefined) {
    validateUuid(instanceId, "--instance");
    const selected = valid.find((entry) => entry.descriptor.instanceId === instanceId);
    if (!selected) throw new CliError(`local instance not found: ${instanceId}`, 1, { code: "instance_not_found" });
    if (selected.status !== "live") throw new CliError(`local instance PID is stale: ${instanceId}`, 1, { code: "instance_not_found" });
    return selected.descriptor;
  }
  const live = valid.filter((entry) => entry.status === "live");
  if (live.length === 0) throw new CliError("no PID-live local instance found; start OMP or select an explicit endpoint", 1, { code: "instance_not_found" });
  if (live.length !== 1) throw new CliError(`multiple PID-live local instances found (${live.map((entry) => entry.descriptor.instanceId).join(", ")}); use --instance UUID`, 1, { code: "instance_selection_required" });
  return live[0].descriptor;
}

async function resolveConnection(options, { relayMachine } = {}) {
  const instance = options["--instance"];
  const endpoint = options["--endpoint"];
  const tokenFile = options["--token-file"];
  const caFile = options["--ca"];
  const allowHttp = options["--allow-http"] === true;
  if (instance !== undefined && (endpoint !== undefined || tokenFile !== undefined)) throw new CliError("--instance cannot be combined with --endpoint or --token-file");
  if (endpoint === undefined && tokenFile !== undefined) throw new CliError("--token-file requires an explicit HTTPS --endpoint");

  let descriptor;
  let rawEndpoint;
  let tokenPath;
  let mode;
  if (endpoint !== undefined) {
    rawEndpoint = endpoint;
    tokenPath = tokenFile;
    mode = "remote";
  } else {
    descriptor = await selectDescriptor(instance);
    rawEndpoint = descriptor.endpoint;
    tokenPath = descriptor.tokenFile;
    mode = "local";
  }
  const url = endpointUrl(rawEndpoint);

  if (relayMachine !== undefined) {
    if (isIP(relayMachine) === 0) throw new CliError("--machine must be a literal IPv4 or IPv6 address");
    if (!descriptor) throw new CliError("SSH relay requires local instance discovery");
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
    if (!loopbackHostname(host) && host !== relayMachine.toLowerCase()) throw new CliError("discovered endpoint is neither loopback nor the supplied SSH machine address");
  }
  if (caFile !== undefined && url.protocol !== "https:") throw new CliError("--ca is valid only for an HTTPS endpoint");
  let token;
  let tokenFilePath;
  let ca;
  let caPath;
  if (url.protocol === "http:") {
    if (tokenFile !== undefined) throw new CliError("HTTP has NO authentication; --token-file is forbidden and was not read");
  } else {
    if (!tokenPath) throw new CliError("HTTPS requires a private bearer token file");
    ({ token, path: tokenFilePath } = await readPrivateToken(tokenPath));
    if (caFile !== undefined) {
      const source = await readBoundedFile(caFile, MAX_CA_BYTES, "CA file");
      ca = source.data;
      caPath = source.path;
    }
  }
  let client;
  try { client = new RpcClient({ endpoint: url.origin, token, ca, allowHttp: allowHttp || relayMachine !== undefined }); } catch (error) { throw cliError(error); }
  return { client, descriptor, instanceId: descriptor?.instanceId, endpoint: url, tokenFile: tokenFilePath, caFile: caPath, allowHttp, mode };
}

function assertSession(connection, session) {
  if (connection.descriptor && session.instanceId !== connection.descriptor.instanceId) {
    throw new CliError("session instance changed after discovery; rediscover explicitly", 1, { code: "instance_mismatch" });
  }
  if (connection.descriptor && session.generation !== connection.descriptor.generation) {
    throw new CliError("session generation changed after discovery; rediscover explicitly", 1, { code: "generation_mismatch" });
  }
  return session;
}

function identityFrom(options, connection) {
  const instanceId = options["--instance-id"] ?? connection.instanceId;
  if (!instanceId) throw new CliError("--instance-id is required with an explicit --endpoint");
  if (connection.instanceId && instanceId !== connection.instanceId) throw new CliError("--instance-id does not match the selected local descriptor", 1, { code: "instance_mismatch" });
  return {
    instanceId: validateUuid(instanceId, "--instance-id"),
    generation: parsePositiveInteger(requireOption(options, "--generation"), "--generation"),
    requestId: validateId(requireOption(options, "--request-id"), "--request-id"),
  };
}

function recordExitCode(record) {
  return record.state === "completed" || !TERMINAL_STATES.has(record.state) ? 0 : 2;
}

function shellQuote(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }

function recoveryCommand(connection, identity) {
  const parts = [process.execPath, resolve(process.argv[1]), "request"];
  if (connection.mode === "local") parts.push("--instance", connection.instanceId);
  else {
    parts.push("--endpoint", connection.endpoint.origin, "--instance-id", identity.instanceId);
    if (connection.tokenFile) parts.push("--token-file", connection.tokenFile);
  }
  if (connection.caFile) parts.push("--ca", connection.caFile);
  if (connection.allowHttp) parts.push("--allow-http");
  parts.push("--request-id", identity.requestId, "--generation", String(identity.generation));
  return parts.map(shellQuote).join(" ");
}

async function submitAndWait(connection, request, wait, timeoutSeconds) {
  const identity = { instanceId: request.instanceId, generation: request.generation, requestId: request.requestId };
  let record;
  try { record = await connection.client.submit(request); } catch (error) {
    const converted = cliError(error);
    if (error?.uncertain) {
      converted.message = `submission outcome is unknown for ${identity.requestId}: ${converted.message}\nDo not resubmit; query the original identity with:\n  ${recoveryCommand(connection, identity)}`;
    }
    throw converted;
  }
  if (!wait || TERMINAL_STATES.has(record.state)) return record;
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (!TERMINAL_STATES.has(record.state)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new CliError(`timed out waiting for accepted request ${identity.requestId}; it was not cancelled. Query it with:\n  ${recoveryCommand(connection, identity)}`, 3);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.min(POLL_MS, remaining)));
    try { record = await connection.client.request(identity); } catch (error) {
      throw new CliError(`request ${identity.requestId} was accepted, but polling failed: ${cliError(error).message}\nIt was not cancelled. Query it with:\n  ${recoveryCommand(connection, identity)}`);
    }
  }
  return record;
}

function parseWait(options) {
  const wait = options["--wait"] === true;
  if (!wait && options["--timeout"] !== undefined) throw new CliError("--timeout requires --wait");
  return { wait, timeout: options["--timeout"] === undefined ? DEFAULT_WAIT_SECONDS : parseWaitSeconds(options["--timeout"]) };
}

async function commandList(args) {
  const options = parseOptions(args, {});
  if (options.help) return showHelp();
  const entries = await loadDescriptorEntries();
  printJson({ rootDir: rootDir(), instances: entries.map((entry) => entry.descriptor ? {
    instanceId: entry.descriptor.instanceId,
    pid: entry.descriptor.pid,
    status: entry.status,
    endpoint: entry.descriptor.endpoint,
    generation: entry.descriptor.generation,
    sessionId: entry.descriptor.sessionId,
  } : { file: entry.file, status: "invalid" }) });
  return 0;
}

async function commandConfig(args) {
  const options = parseOptions(args, { "--host": "value", "--port": "value", "--lan": "value", "--protocol": "value", "--tls-cert": "value", "--tls-key": "value" });
  if (options.help) return showHelp();
  const current = await readConfig();
  const next = { ...current };
  let changed = false;
  if (options["--host"] !== undefined) {
    next.host = options["--host"];
    if (!isLoopbackHost(next.host) && isLoopbackHost(current.host)) next.protocol = "https";
    if (options["--lan"] === undefined) next.lanEnabled = !isLoopbackHost(next.host);
    changed = true;
  }
  if (options["--port"] !== undefined) {
    next.port = parseNonnegativeInteger(options["--port"], "--port");
    if (next.port > 65_535) throw new CliError("--port must be between 0 and 65535");
    changed = true;
  }
  if (options["--protocol"] !== undefined) { next.protocol = options["--protocol"]; changed = true; }
  if (options["--lan"] !== undefined) {
    if (!['on', 'off'].includes(options["--lan"])) throw new CliError("--lan must be on or off");
    next.lanEnabled = options["--lan"] === "on";
    changed = true;
  }
  if (options["--tls-cert"] !== undefined) { next.tlsCert = resolve(options["--tls-cert"]); changed = true; }
  if (options["--tls-key"] !== undefined) { next.tlsKey = resolve(options["--tls-key"]); changed = true; }
  const config = changed ? await writeConfig(next) : current;
  printJson({ host: config.host, port: config.port, lanEnabled: config.lanEnabled, protocol: config.protocol, tlsCert: config.tlsCert ?? null, tlsKey: config.tlsKey ?? null });
  return 0;
}

async function commandSession(args) {
  const options = parseOptions(args, spec());
  if (options.help) return showHelp();
  const connection = await resolveConnection(options);
  printJson(assertSession(connection, await connection.client.session()));
  return 0;
}

async function commandSend(args) {
  const options = parseOptions(args, spec({ "--message-file": "value", "--request-id": "value", "--response-mode": "value", "--result-schema-file": "value", "--wait": "boolean", "--timeout": "value" }));
  if (options.help) return showHelp();
  const { text: message, path } = await readUtf8File(requireOption(options, "--message-file"), LIMITS.messageBytes, "message file");
  if (!message.trim()) throw new CliError(`message file contains no non-whitespace text: ${path}`);
  const responseMode = options["--response-mode"] ?? "native";
  if (!['native', 'structured'].includes(responseMode)) throw new CliError("--response-mode must be native or structured");
  if (responseMode === "native" && options["--result-schema-file"] !== undefined) throw new CliError("native mode forbids --result-schema-file");
  if (responseMode === "structured" && options["--result-schema-file"] === undefined) throw new CliError("structured mode requires --result-schema-file");
  const connection = await resolveConnection(options);
  const session = assertSession(connection, await connection.client.session());
  const request = {
    instanceId: session.instanceId,
    generation: session.generation,
    requestId: options["--request-id"] === undefined ? randomUUID() : validateId(options["--request-id"], "--request-id"),
    message,
    responseMode,
    ...(responseMode === "structured" ? { resultSchema: await readJsonFile(options["--result-schema-file"], LIMITS.requestBytes, "result schema", false) } : {}),
  };
  const waiting = parseWait(options);
  const record = await submitAndWait(connection, request, waiting.wait, waiting.timeout);
  printJson(record);
  return recordExitCode(record);
}

async function commandSubmit(args) {
  const options = parseOptions(args, spec({ "--request-file": "value", "--wait": "boolean", "--timeout": "value" }));
  if (options.help) return showHelp();
  const request = await readJsonFile(requireOption(options, "--request-file"), LIMITS.requestBytes, "request file");
  const connection = await resolveConnection(options);
  if (connection.instanceId && request.instanceId !== connection.instanceId) throw new CliError("request-file instanceId does not match the selected local descriptor", 1, { code: "instance_mismatch" });
  if (connection.descriptor && request.generation !== connection.descriptor.generation) throw new CliError("request-file generation does not match the selected local descriptor", 1, { code: "generation_mismatch" });
  const waiting = parseWait(options);
  const record = await submitAndWait(connection, request, waiting.wait, waiting.timeout);
  printJson(record);
  return recordExitCode(record);
}

async function commandIdentity(args, extra, operation) {
  const options = parseOptions(args, identitySpec(extra));
  if (options.help) return showHelp();
  const connection = await resolveConnection(options);
  const identity = identityFrom(options, connection);
  const value = await operation({ options, connection, identity });
  if (value !== undefined) printJson(value);
  return value?.state ? recordExitCode(value) : 0;
}

async function commandRequest(args) { return await commandIdentity(args, {}, ({ connection, identity }) => connection.client.request(identity)); }
async function commandCancel(args) { return await commandIdentity(args, {}, ({ connection, identity }) => connection.client.cancel(identity)); }
async function commandEvents(args) {
  return await commandIdentity(args, { "--after": "value" }, ({ options, connection, identity }) => connection.client.events(identity, options["--after"] === undefined ? 0 : parseNonnegativeInteger(options["--after"], "--after")));
}
async function commandTools(args) { return await commandIdentity(args, {}, ({ connection, identity }) => connection.client.toolCalls(identity)); }
async function commandArtifacts(args) { return await commandIdentity(args, {}, ({ connection, identity }) => connection.client.artifacts(identity)); }

async function commandClaim(args) {
  return await commandIdentity(args, { "--tool-call-id": "value", "--worker-id": "value", "--claim-id": "value", "--lease-ms": "value", "--renew": "boolean" }, ({ options, connection, identity }) => {
    const callId = validateUuid(requireOption(options, "--tool-call-id"), "--tool-call-id");
    const claim = {
      workerId: validateId(requireOption(options, "--worker-id"), "--worker-id"),
      claimId: validateId(requireOption(options, "--claim-id"), "--claim-id"),
      ...(options["--lease-ms"] === undefined ? {} : { leaseMs: parsePositiveInteger(options["--lease-ms"], "--lease-ms") }),
      ...(options["--renew"] ? { renew: true } : {}),
    };
    return connection.client.claim(identity, callId, claim);
  });
}

async function commandResult(args) {
  return await commandIdentity(args, { "--tool-call-id": "value", "--result-file": "value" }, async ({ options, connection, identity }) => {
    const callId = validateUuid(requireOption(options, "--tool-call-id"), "--tool-call-id");
    const reply = await readJsonFile(requireOption(options, "--result-file"), LIMITS.resultBytes + 64 * 1024, "tool result file");
    try { return await connection.client.toolResult(identity, callId, reply); } catch (error) {
      if (error?.uncertain) throw new CliError(`tool-result outcome is unknown; do not execute the caller tool again. Query tools for request ${identity.requestId} before retrying the identical leaseId/outcome`);
      throw error;
    }
  });
}

async function commandDownload(args) {
  return await commandIdentity(args, { "--artifact-id": "value", "--output": "value" }, async ({ options, connection, identity }) => {
    const artifactId = validateUuid(requireOption(options, "--artifact-id"), "--artifact-id");
    const output = resolve(requireOption(options, "--output"));
    await connection.client.download(identity, artifactId, output);
    return { artifactId, output };
  });
}

function assertRelayKeys(payload, keys) {
  const allowed = new Set(["operation", ...keys]);
  for (const key of Object.keys(payload)) if (!allowed.has(key)) throw new CliError(`unknown relay field: ${key}`);
}

async function readRelayInput() {
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > MAX_RELAY_BYTES) throw new CliError(`relay stdin exceeds ${MAX_RELAY_BYTES} bytes`);
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks, length).toString("utf8")); } catch { throw new CliError("relay stdin must contain one JSON object"); }
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.operation !== "string") throw new CliError("relay stdin must contain an operation object");
  return value;
}

function relayError(error) {
  const converted = cliError(error);
  return { error: {
    code: typeof error?.code === "string" ? error.code : "relay_failed",
    message: converted.message.slice(0, 512),
    ...(Number.isInteger(error?.status) ? { status: error.status } : {}),
    ...(error?.uncertain === true ? { uncertain: true } : {}),
  } };
}

async function commandRelay(args) {
  const options = parseOptions(args, { "--instance": "value", "--machine": "value", "--ca": "value" });
  if (options.help) return showHelp();
  let binary = false;
  try {
    const payload = await readRelayInput();
    binary = payload.operation === "download";
    const machine = requireOption(options, "--machine");
    const connection = await resolveConnection(options, { relayMachine: machine });
    let value;
    switch (payload.operation) {
      case "session":
        assertRelayKeys(payload, []);
        value = assertSession(connection, await connection.client.session());
        break;
      case "submit":
        assertRelayKeys(payload, ["request"]);
        assertRelayIdentity(payload.request, connection);
        value = await connection.client.submit(payload.request);
        break;
      case "request": case "cancel": case "toolCalls": case "artifacts": {
        assertRelayKeys(payload, ["identity"]);
        assertRelayIdentity(payload.identity, connection);
        value = await connection.client[payload.operation](payload.identity);
        break;
      }
      case "toolCall":
        assertRelayKeys(payload, ["identity", "callId"]);
        assertRelayIdentity(payload.identity, connection);
        value = await connection.client.toolCall(payload.identity, payload.callId);
        break;
      case "claim":
        assertRelayKeys(payload, ["identity", "callId", "claim"]);
        assertRelayIdentity(payload.identity, connection);
        value = await connection.client.claim(payload.identity, payload.callId, payload.claim);
        break;
      case "toolResult":
        assertRelayKeys(payload, ["identity", "callId", "reply"]);
        assertRelayIdentity(payload.identity, connection);
        value = await connection.client.toolResult(payload.identity, payload.callId, payload.reply);
        break;
      case "events":
        assertRelayKeys(payload, ["identity", "after"]);
        assertRelayIdentity(payload.identity, connection);
        value = await connection.client.events(payload.identity, payload.after);
        break;
      case "download":
        assertRelayKeys(payload, ["identity", "artifactId"]);
        assertRelayIdentity(payload.identity, connection);
        await connection.client.downloadTo(payload.identity, payload.artifactId, process.stdout);
        return 0;
      default: throw new CliError(`unsupported relay operation: ${payload.operation}`);
    }
    process.stdout.write(`${JSON.stringify(value)}\n`);
    return 0;
  } catch (error) {
    if (binary) throw error;
    process.stdout.write(`${JSON.stringify(relayError(error))}\n`);
    return 4;
  }
}

function assertRelayIdentity(identity, connection) {
  if (!identity || identity.instanceId !== connection.instanceId) {
    throw new CliError("relay instance does not match the selected descriptor", 1, { code: "instance_mismatch" });
  }
  if (identity.generation !== connection.descriptor.generation) {
    throw new CliError("relay generation does not match the selected descriptor", 1, { code: "generation_mismatch" });
  }
}

function cliError(error) {
  if (error instanceof CliError) return error;
  if (error instanceof RpcError) return new CliError(error.message, error.status && error.status >= 400 ? 1 : 1, { code: error.code, status: error.status, uncertain: error.uncertain });
  return new CliError(error instanceof Error ? error.message : String(error));
}

function showHelp() { process.stdout.write(HELP); return 0; }

async function main(argv) {
  if (argv.length === 0 || argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") {
    const commands = new Set(["list", "config", "session", "send", "submit", "request", "cancel", "events", "tools", "claim", "result", "artifacts", "download"]);
    if (argv.length > 2 || (argv.length === 2 && !commands.has(argv[1]))) throw new CliError("help accepts at most one known command name");
    return showHelp();
  }
  const [command, ...args] = argv;
  switch (command) {
    case "list": return await commandList(args);
    case "config": return await commandConfig(args);
    case "session": return await commandSession(args);
    case "send": return await commandSend(args);
    case "submit": return await commandSubmit(args);
    case "request": return await commandRequest(args);
    case "cancel": return await commandCancel(args);
    case "events": return await commandEvents(args);
    case "tools": return await commandTools(args);
    case "claim": return await commandClaim(args);
    case "result": return await commandResult(args);
    case "artifacts": return await commandArtifacts(args);
    case "download": return await commandDownload(args);
    case "relay": return await commandRelay(args);
    default: throw new CliError(`unknown command: ${command}\nRun ${process.argv[1]} help for usage.`);
  }
}

export { main };

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (exitCode) => { process.exitCode = exitCode; },
    (error) => {
      const converted = cliError(error);
      process.stderr.write(`error: ${converted.message}\n`);
      process.exitCode = converted.exitCode;
    },
  );
}
