# LAN RPC

`@ylang/lanrpc` is the LAN RPC plugin in [Oh My Plugins](../../README.md). This directory is an independently installable package; all relative source and example paths below refer to this directory. See the collection README for selecting LAN RPC, BTW, or both.

Local and LAN message access to a running, ordinary OMP or Pi session: **anonymous HTTP** or **verified, token-authenticated HTTPS**. Newly started interactive sessions load the installed plugin automatically. No watchdog and no `--mode rpc` conversion are needed.

**Default cross-machine workflow: authenticated, host-verified SSH must already work.** Discover sessions through SSH and access their HTTP API from the remote host. Keep the default loopback listener when using this workflow; no LAN exposure, discovery daemon or fixed RPC port is needed. Direct LAN HTTP/HTTPS remains an explicit alternative, not an automatic fallback when SSH fails.

**Protocol v2 runs in the selected real OMP conversation.** `native` (default) returns that request's native messages/events without parsing free text; it stops forwarding at a later native user-message boundary. `structured` uses a caller-defined JSON Schema and explicit native `rpc_result` submission. Neither mode starts a child agent. OMP owns steering, interruption and history navigation: CLI input does not cancel structured work, and a successful result does not abort the native turn. Request-specific instructions do not override later CLI input, and temporary tools are removed when their request ends. See [PROTOCOL.md](PROTOCOL.md) for precise boundaries.

One machine's sessions share its existing **SSH ingress**, not a new shared HTTP daemon. User bindings identify IP + Session ID. Each new request resolves that session and pins its runtime internally; submitted or uncertain work never changes runtime or replays automatically. Same-session history navigation keeps the listener and retained request records. HTTP/HTTPS remains an explicit direct-connect alternative.

### Independent package installation

Install LAN RPC alone from its generated GitHub distribution repository. No manual clone or npm account is needed:

```bash
# OMP:
omp plugin install github:ylang-ylang/oh-my-plugin-lanrpc

# Pi:
pi install git:github.com/ylang-ylang/oh-my-plugin-lanrpc
```

The distribution repository is published by the collection's `npm run plugins:publish` command, not CI; these commands require a successful release run. Develop only in the [source collection](../../README.md#publishing-plugins), not the generated repository. `@ylang/lanrpc` remains package metadata, not an npm authorization requirement. Do not also enable LAN RPC from a collection or an old installation. Fully exit and restart the host after installation; active sessions are not upgraded automatically.

### Pi installation and execution

Pi 0.73.1, 0.74.0 and 1.5.0 are verified with the pinned real-runtime matrix. Use the GitHub command above for normal installation. For development, install this plugin alone with `pi install /absolute/path/to/oh-my-plugins/plugins/lanrpc`, then fully restart Pi. To develop both plugins together, install the local collection root instead. Do not enable the same plugin through both installations. Working-tree changes require local installation until published.

Use `/lanrpc info` to inspect the listener and `/lanrpc` for controls. Local CLI discovery and the SSH client use the same v2 API and runtime directory as OMP. Pi displays the radar in its native extension status slot; no separate endpoint footer is installed.

Pi runs requests through public extension message, event, context and cancellation APIs in the current conversation. Native results, structured `rpc_result`, caller tools and request-owned artifacts share the existing protocol. Pi has no public tool-unregister API: after a request, its tool names become inactive, non-executable entries with generic empty schemas/descriptions; request handlers and metadata are cleared, and captured old handlers reject with `host_cancelled`. Historical conversation/tool records remain intentionally visible. Names may be reused with new schemas. At most 8192 distinct RPC-owned names are retained per extension lifetime; exhaustion refuses execution before installation (the controller reports `host_failed`). Restart Pi after draining requests to clear that registry.

Cancellation respects the host boundary. Pi 1.5 can cancel a gated custom prompt before provider entry. Legacy Pi 0.73/0.74 custom prompts bypass `before_agent_start`; cancellation during context preparation can enter the stream callback with an already-aborted signal. Providers must honor that signal. The matrix verifies no caller-tool side effects or replay into the next request, rather than claiming a stream callback was never entered.

## Check dependencies first

The **OMP host** needs the host-side items below. A separate client machine has different requirements, described after the table.

| OMP-host dependency | Purpose |
| --- | --- |
| An installed, working OMP | Hosts the session; this plugin does not install OMP itself |
| Git | Installs or updates the plugin from a repository reference |
| Bun | OMP 18.2.6 needs `bun` on PATH during plugin installation; recent OMP releases use embedded Bun |
| Node.js >=22 | Required on the OMP host for isolated schema validation, and for `cli.mjs` / SSH relay access |
| npm package dependencies | This package declares Ajv for bounded JSON Schema validation; the plugin installation must include its dependencies |
| Homebrew (optional) | One way to install Bun, Git, and Node; not a plugin runtime dependency |
| OpenSSL (for automatic HTTPS) | Generates the managed self-signed certificate; not needed for HTTP or advanced custom certificate paths |
| Nerd Fonts (for the indicator) | The terminal displaying OMP needs the `md-radar` glyph (U+F0437); for SSH, configure the client terminal's font. This does not affect network access |

A client machine running `ssh-demo.mjs`, `examples/client.mjs`, or `sdk.mjs` needs Node.js >=22 and the corresponding files from a complete checkout or installation. SSH mode additionally needs system OpenSSH plus an already trusted/authenticated account; it does not need OMP locally. A non-Node client may implement the documented HTTP/JSON or SSH relay contract in another language, but the OMP host still needs Node.js >=22 for its installed CLI. Direct HTTP/HTTPS clients do not need OpenSSH.

If you see:

```text
Executable not found in $PATH: "bun"
```

OMP's installer could not find Bun **before downloading the plugin**. The plugin has not run yet and cannot report the missing prerequisite. Install Bun and configure PATH below, then retry; repeatedly reinstalling the plugin will not fix it.

## Option A: Install dependencies with Homebrew

If `brew` already works, skip to step 3. If you only need Bun and do not want Homebrew, use option B instead.

### 1. Install Homebrew

Run the Homebrew installer and `brew install` as your normal user, not with `sudo`. The installer requests elevation itself when necessary.

On Ubuntu/Debian, install missing basic tools first:

```bash
sudo apt-get update
sudo apt-get install -y build-essential procps curl file git ca-certificates unzip
```

On other Linux distributions, install the corresponding packages; see [Homebrew on Linux](https://docs.brew.sh/Homebrew-on-Linux). On macOS, follow the installer's developer-tool instructions; if needed, run `xcode-select --install` and complete the system dialog before continuing.

Official Linux/macOS installation command:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

This downloads and executes the official installer and requires access to GitHub. See the [official installation requirements](https://docs.brew.sh/Installation) for supported platforms and prerequisites.

### 2. Add Homebrew to PATH

**Follow the installer's final Next steps.** Common defaults are shown below; run only the command matching your system.

Linux:

```bash
eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"
```

macOS Apple Silicon:

```bash
eval "$(/opt/homebrew/bin/brew shellenv)"
```

Traditional macOS Intel default:

```bash
eval "$(/usr/local/bin/brew shellenv)"
```

The `eval` affects only the current terminal. Add the **same literal command line** once to your shell startup file: usually `~/.bashrc` for Bash or `~/.zshrc` for Zsh. For a macOS login Zsh, follow the installer's `~/.zprofile` instructions. Do not paste the command's expanded output or duplicate an existing entry.

Open a new terminal and check:

```bash
brew --version
```

### 3. Install Bun, Git, and Node

```bash
brew install oven-sh/bun/bun
```

If Git or Node.js >=22 is missing:

```bash
brew install git node
```

Check the same shell that will launch OMP:

```bash
command -v bun
bun --version
git --version
node --version
```

If `brew` works but `bun` is still missing, load the appropriate `brew shellenv` command and open a new terminal. Existing tmux panes and running OMP processes do not inherit later environment changes; restart the affected terminal/OMP process.

## Option B: Install Bun directly, without Homebrew

This option still requires Git and Node.js >=22 on the OMP host for isolated schema validation, even when OMP itself uses embedded Bun.

Bun's Linux installer needs `unzip`. On Ubuntu/Debian:

```bash
sudo apt-get update
sudo apt-get install -y curl ca-certificates unzip git
```

Use the [official Bun installer](https://bun.com/docs/installation):

```bash
curl -fsSL https://bun.com/install | bash
```

If the current terminal still cannot find Bun:

```bash
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
```

If the installer has not already updated your shell configuration, add those literal lines once to `~/.bashrc` or `~/.zshrc`, then open a new terminal.

```bash
bun --version
```

On a machine with npm, `npm install -g bun` is another option. If a recent npm blocks Bun's installation script, authorize only Bun's script as instructed, for example `npm rebuild --global --allow-scripts=bun bun`, then check `bun --version` again. Do not enable installation scripts for all packages just to install this plugin.

## Install the plugin

For normal installation, use the [independent GitHub repository](#independent-package-installation). The following local-link commands are a development alternative for working-tree changes:

```bash
omp plugin link /absolute/path/to/oh-my-plugins/plugins/lanrpc
# Or, for Pi:
pi install /absolute/path/to/oh-my-plugins/plugins/lanrpc
```

See the [collection installation guide](../../README.md#installation) for installing both plugins. Successful distribution releases create `v<package.version>` tags; editing a local package version does not publish a release. The source repository's historical `v0.4.0` tag implements protocol v1.

V2 is a breaking upgrade. Before replacing a running v1 installation, finish or query its pending work while that old generation still exists. Then install both the v2 host and consuming client, fully restart OMP, and use a new client to rediscover the selected session and pin its new instance/generation. V1 is not preserved behind a compatibility mode: v1 routes return HTTP 410 `protocol_upgraded`. Records are memory-only, so never automatically replay a request whose old outcome is uncertain.

Start an ordinary OMP session:

```bash
omp
```

**Fully exit and relaunch OMP after installation or upgrades.** The radar layout is prepared before the native TUI is created. Neither `/reload-plugins` nor `/lanrpc restart` rebuilds an already-created status bar; `/lanrpc restart` restarts only the network listener.

On OMP 18.20.0, a live-process check confirmed that `/reload-plugins` can report success while the old LAN RPC entrypoint and imported modules remain active. Downloading an update and loading it into a running session are separate steps: fully exit OMP, then resume the original session. Do not replay uncertain requests after the new instance/generation starts.

Use `/lanrpc` to open the English control menu, or run subcommands directly:

```text
/lanrpc
/lanrpc info
/lanrpc on
/lanrpc off
/lanrpc configure
/lanrpc start
/lanrpc stop
/lanrpc restart
```

The default listener uses plain HTTP on **127.0.0.1 only**, with an automatically selected free port and **NO authentication**. Installing the plugin does not expose it to the LAN. Anyone who can reach an HTTP port can control this agent and its tools, including local processes reaching loopback. HTTP creates no token or TLS files.

The native status bar shows a small radar rather than an endpoint or token. `/lanrpc info` and menu **Connection details** open a focused panel. HTTPS shows the endpoint, session metadata, certificate path, token file path, and **actual token**. Press **c — Copy token** to send the exact token to the terminal clipboard using OSC 52, including over SSH; your terminal must support and permit clipboard writes (and your multiplexer must allow them). The panel reports that a clipboard request was sent, not that an OS clipboard accepted it. **Esc / Enter** closes the panel and removes the copy hotkey; `c` is never a global chat shortcut. HTTP explicitly shows no authentication and no token. No token is written to logs, status bars, standalone client output, or RPC session metadata. Avoid opening HTTPS details while screen-sharing.

Connection details show the session ID, endpoint, working directory, and busy/queue state. Internal instance UUID and generation are intentionally omitted from this user-facing panel; they remain in the protocol for request identity checks and safe recovery.

While requests wait for this session to become idle, the same inline status slot shows `queued: N` beside the radar. The count updates as requests start, expire or are cancelled; it disappears when the queue is empty. No popup, extra footer or interruption is introduced.

All menus, prompts, confirmations, errors, and help are English. The radar uses the Nerd Fonts `md-radar` glyph and OMP's native theme; local/LAN state is distinguished in the menu. Stopped access shows a small circle; an error shows `!`. If the radar looks like a box, select a supporting [Nerd Font](https://www.nerdfonts.com/) in the terminal displaying OMP. With SSH, this is the local client terminal, not the remote server.

- `/lanrpc on`: enables LAN access. First use asks for a specific local IP and port. Choose **HTTPS (recommended)** or **HTTP (unencrypted, NO authentication)**. HTTPS automatically generates/reuses a private self-signed certificate for that IP without asking for paths; previously configured custom TLS paths are preserved. HTTP requires a clear no-authentication/unencrypted-risk confirmation.
- `/lanrpc off`: disables LAN access while keeping local access. The saved LAN IP, protocol, and certificate paths are retained.
- `/lanrpc configure`: edits the IP, port, and protocol, then confirms before enabling LAN access. Configure advanced custom TLS paths through the standalone `config` command.
- `/lanrpc start`, `/lanrpc stop`, `/lanrpc restart`: starts, stops, or restarts this session's listener using saved settings.

LAN changes save defaults for future sessions and restart only the current listener; other running sessions are unchanged. Restarting rotates the instance and HTTPS token, but reuses a usable managed certificate for the same IP so client trust stays stable. Session changes and reconfiguration are refused while remote work is pending: wait for it to finish or explicitly use `/lanrpc stop`. Earlier command names are removed; use only `/lanrpc`.

## Client and LAN access

The examples below use an OMP collection installation. An independent OMP GitHub installation instead provides `~/.omp/plugins/node_modules/@ylang/lanrpc/cli.mjs`; replace the collection path in these examples with that path (and set `RPC_CLI` accordingly). Pi/custom-root installation paths differ.

SSH discovery still defaults to the collection's remote CLI path. For an independently installed remote plugin, explicitly set `--remote-cli /home/REMOTE_USER/.omp/plugins/node_modules/@ylang/lanrpc/cli.mjs`, SDK `remoteCli`, or `LAN_RPC_REMOTE_CLI` for the client example. Use the actual absolute path on that remote machine, not a local checkout path.

Read the implemented CLI contract at the collection user-install path:

```bash
node ~/.omp/plugins/node_modules/oh-my-plugins/plugins/lanrpc/cli.mjs help
```

Custom OMP/XDG data roots may use a different plugin path. The v2 CLI commands are `list`, `config`, `session`, `send`, `submit`, `request`, `cancel`, `events`, `tools`, `claim`, `result`, `artifacts`, and `download`. `send` reads a bounded message file and declares no caller tools; use `submit --request-file` for a complete request containing tool declarations. Message, request, schema, and tool-result bodies stay out of argv.

Full requests may include optional `instructions`: subordinate user task context injected only into the current request's provider context, not displayed or persisted as system instructions. It defaults to `""`, preserves supplied whitespace, and is bounded to 48 KiB of UTF-8 like `message`; the entire request remains limited to 64 KiB. It participates in request-ID deduplication but is not a public request-record field. Use `submit --request-file` or SDK `submit()`/`run()` to supply it. The visible `message`, assistant replies, and tool history intentionally remain in the selected conversation.

Each accepted request has a bounded queue wait (`queueTimeoutMs`, default 2 hours, maximum 24 hours) and a separate execution budget (`timeoutMs`, default 2 hours, maximum 24 hours). Execution time starts only when the request becomes `running`; time spent behind another request does not consume it. Queue expiry returns `queue_timeout` without starting the request; expiry after start returns `request_timeout`. CLI `send` may override queue wait with `--queue-timeout SECONDS`; SDK and request-file callers may set `queueTimeoutMs`. This bounded queue is not a durable scheduler for work such as “notify after acceptance”; that follow-up must be scheduled by the business caller.

`--wait` is deliberately passive: it polls only the request record for up to 300 seconds by default (86,400 maximum), does not stream events, does not execute caller tools, and does not cancel on timeout. It exits 0 for `completed`, 2 for `failed`/`interrupted`/`cancelled`, and 3 on wait timeout, printing the exact recovery query. A request with declared caller tools needs a concurrent worker using `tools`/`claim`/`result`, or the SDK `run()` pump below; waiting for final completion before servicing a tool call can deadlock until timeout.

### Local CLI: native result and event output

On the OMP host, select a PID-live descriptor by its stable session ID. Omitting `--session` is allowed only when exactly one PID-live descriptor exists. Ordinary selection does not require a runtime instance UUID; advanced `--instance-id` plus `--generation` identifies one original wire identity for exact recovery operations.

```bash
export RPC_CLI="$HOME/.omp/plugins/node_modules/oh-my-plugins/plugins/lanrpc/cli.mjs"
node "$RPC_CLI" list
export SESSION=SESSION_ID_FROM_LIST
node "$RPC_CLI" session --session "$SESSION"
```

Copy that session's `instanceId` and positive `generation`, then submit a native request and read its event history under the original identity:

```bash
printf '%s\n' 'Reply briefly with one benefit of request-scoped tools.' > /tmp/lan-rpc-prompt.txt
node "$RPC_CLI" send --session "$SESSION" \
  --message-file /tmp/lan-rpc-prompt.txt \
  --request-id native_demo --response-mode native --wait
node "$RPC_CLI" events --session "$SESSION" \
  --instance-id INSTANCE_UUID_FROM_SESSION \
  --request-id native_demo --generation GENERATION_FROM_SESSION --after 0
```

The completed native request record contains the ordered native message array in `result`. The events response separately contains `request.state` and `native` entries; each `native` entry preserves the host event under `data` without text extraction or filtering. Native payload shapes are host-version-dependent, so consumers must accept unknown event types. See [Events and recovery](PROTOCOL.md#events-and-recovery).

### SSH-first discovery: machine IP, then selected session

The SSH prerequisite is an existing account with non-interactive authentication and a previously verified host key. Configure `User`, `Port`, `IdentityFile`, `ProxyJump`, and agents through normal OpenSSH configuration. A literal IP supplies neither credentials nor trust; the plugin never installs/configures sshd, enrolls keys, or accepts an unknown host key.

From this checkout, first discover using only the machine IP, then select one returned session ID:

```bash
node ssh-demo.mjs 192.168.201.231 --list
node ssh-demo.mjs 192.168.201.231 --session OMP_SESSION_ID
```

Running `node ssh-demo.mjs 192.168.201.231` automatically selects the session only when discovery finds exactly one reachable session. With several, the demo prompts on an interactive terminal; a non-interactive run fails and requires `--session`. `--list` reports probe failures separately, and an unavailable explicit selection is never replaced silently. Use `--remote-cli /absolute/remote/path/cli.mjs` for a non-default remote installation and `--ca /absolute/remote/path/cert.pem` for an HTTPS CA file that remains on the remote machine.

This discovery demo is read-only: it runs the remote `cli.mjs list` and v2 `session` operation, verifies the selected session against its descriptor's instance and generation, and never submits work. It invokes system OpenSSH with `BatchMode=yes` and `StrictHostKeyChecking=yes`. Only a descriptor's loopback endpoint or an endpoint exactly matching the supplied machine IP may be relayed. SSH failure never falls back to direct networking, and no RPC port is scanned or forwarded. The relay's instance selector is an internal routing detail, not a public selection interface.

Every later JSON operation and artifact byte stream can use that selected session through the same existing SSH ingress. The remote host needs the installed plugin and Node.js >=22. The local machine needs Node.js >=22 for the supplied JavaScript demos plus system OpenSSH; it does not need OMP. `OMP_LAN_RPC_DIR`, when customized, belongs in the remote SSH environment. Existing remote HTTPS token files remain remote, TLS and hostname verification remain enabled, and SSH does not repair the security of an anonymously exposed LAN HTTP listener.

### Runnable structured tool, artifact, and native example

`examples/client.mjs` is the end-to-end Node SDK example. Run it from this checkout with the selected session; the output path is local and must not already exist:

```bash
export LAN_RPC_SSH_HOST=192.168.201.231
export LAN_RPC_SESSION=OMP_SESSION_ID
node examples/client.mjs /absolute/local/path/rpc-report.txt
```

For a custom remote install, set `LAN_RPC_REMOTE_CLI` to its absolute remote `cli.mjs` path. For remote HTTPS, `LAN_RPC_REMOTE_CA` is an absolute CA path on the remote host. The installed example can likewise run as `node ~/.omp/plugins/node_modules/oh-my-plugins/plugins/lanrpc/examples/client.mjs /absolute/local/path/rpc-report.txt`.

The example performs the complete v2 loop rather than treating `--wait` as a callback worker:

1. It reads `session()` and requires structured-result, caller-tool, and artifact capabilities.
2. It submits `responseMode: "structured"` with an object result schema requiring string `summary` and `artifactId`, plus a declared `lookup_item` tool whose object input requires integer `id` and whose object result requires string `title` and `status`. Caller-defined JSON Schema draft 2020-12 assertions—including `pattern`, `patternProperties`, and `uniqueItems`—are validated in an isolated, terminable Node process, not on OMP's event loop. Compilation and evaluation have resource/time limits; a timeout is an explicit error, not weakened validation. Schemas resolve resources supplied within the document; no external schema is fetched. See [Common conventions](PROTOCOL.md#common-conventions).
3. `client.run()` polls request state, events, and tool calls concurrently. Its `lookup_item` handler receives `{id}` and returns the schema-valid caller-owned data while the SDK claims and renews the lease.
4. The prompt asks the selected conversation's Agent to create `report.txt`, register it with native `rpc_artifact`, and submit exactly one schema-valid `rpc_result({result:{summary,artifactId}})`. The request and tool history remain visible in that real conversation. Assistant prose is never accepted as the structured result.
5. `client.download(identity, artifactId, outputPath)` transfers the immutable artifact bytes through SSH without a base64 envelope and creates the local output exclusively; partial output is removed on failure.
6. It then runs a separate `native` request, collects every `event.data` whose type is `native`, and prints both the terminal native result and `nativeEvents`.

The original caller schema remains authoritative. Native tool parameters expose a safe structural projection because current OMP versions synchronously inspect their parameter schemas; the full schema is included in the tool description, and isolated validation enforces every supported assertion before accepting results or publishing caller tool calls. This does not remove business constraints or silently accept invalid values. `native` response mode never applies a structured-result schema or extracts JSON from assistant text. Consumers should keep their own pre-publication business validation; schemas are not a substitute for authorization or business state.

Validation has a 2000 ms wall-clock limit including queue time, at most two simultaneous workers and 32 queued operations, and a 64 MiB Node V8 heap limit per worker (not a total-process RSS limit). Timeout/cancellation kills the worker; `validation_timeout`, `validation_capacity`, `validation_aborted` and `validation_worker_failed` remain distinct from invalid schema/data. For embedded-Bun OMP, set `OMP_LAN_RPC_NODE=/absolute/path/to/node` before starting OMP if Node is not in a standard Homebrew, `/usr/local/bin`, or `/usr/bin` location. A real Node client uses its own executable. No insecure in-process fallback occurs when the worker runtime is missing.

The artifact half currently requires Linux and a verified `/proc/self/fd` facility for descriptor-pinned, no-follow source traversal. Consumers must check `session.capabilities.artifacts` before requesting files. When it is false—including current macOS/non-Linux hosts—`rpc_artifact` is not exposed and registration returns `host_unsupported`; native and structured chat without artifacts still work. The supplied example intentionally fails its initial capability check rather than assuming file support.

For an explicit direct connection instead of SSH, the same example accepts:

```bash
LAN_RPC_ENDPOINT=https://192.0.2.10:9443 \
LAN_RPC_TOKEN_FILE=/secure/omp.token \
LAN_RPC_CA_FILE=/secure/server.crt \
node examples/client.mjs /absolute/local/path/rpc-report.txt
```

Set `LAN_RPC_ALLOW_HTTP=1` only for a non-loopback anonymous HTTP endpoint after accepting that risk. Direct HTTPS requires `LAN_RPC_TOKEN_FILE`; token and CA paths in direct mode are on the local client machine.

The convenience `sdk.mjs` exports `RpcError`, `RpcClient`, `SshRpcClient`, and `listSshInstances`. Direct clients use `new RpcClient({endpoint, token, ca, allowHttp, timeoutMs})`. SSH clients use `new SshRpcClient({host, sessionId, remoteCli, ca, sshPath})`; `sessionId` is optional only when the host has exactly one live descriptor, and the constructor does not accept `instanceId`. The first operation lazily discovers and verifies the selected session, then the client pins that descriptor's `instanceId` and `generation` once. Concurrent first operations share that discovery. A listener restart never silently rebinds the old client: create a new client to rediscover the session, and query the old pinned identity rather than replaying any uncertain request. `listSshInstances({host, remoteCli, ca, sshPath})` remains available for explicit listing. Both client types expose `session`, `submit`, `request`, `cancel`, tool-call operations, `events`, `artifacts`, `download`, `downloadTo`, and `run`. A `run` handler is called as `(arguments, {identity, toolCall, signal})`; `onEvent(event)` receives the raw event wrapper; the return value is the terminal request record. This Node SDK is optional: the HTTP/JSON protocol and remote-CLI JSON/binary relay are not client-language-specific.

`host` must be a literal IPv4 or IPv6 machine address. Calling `session()` again re-queries and revalidates that pinned endpoint, so `busy` and `queueDepth` stay current; it does not rediscover or rebind the client.

Non-interactive discovery reports `session_not_found` when no live exact match exists, `session_ambiguous` when an explicit ID matches multiple live descriptors, and `session_selection_required` when multiple live sessions exist without a selector. Verification against `/v2/session` reports `session_mismatch` instead of substituting another session. After pinning, `instance_not_found`, `instance_mismatch`, or `generation_mismatch` describes the exact internal relay identity; it never triggers rediscovery or rebinding of an old request.

This repository contains no Feishu bot changes. A downstream Feishu developer must adapt that bot's bind syntax separately to store/select `sessionId` rather than a runtime instance UUID.

### V1-to-v2 consumer migration

1. Before upgrading, drain or query v1 work on its original running generation. V1 records cannot be migrated across a listener/session restart.
2. Upgrade the host and consumer together, restart OMP, and create a new client to rediscover the selected session and pin its current `instanceId` plus `generation`. Do not reuse an old identity.
3. Replace every v1 route with `/v2/session` and the `/v2/requests` family. There is no preserved v1 behavior or compatibility flag; v1 routes return HTTP 410 `protocol_upgraded`.
4. Choose `responseMode` explicitly. Use `native` for unmodified host messages/events. For machine data, provide `resultSchema`, use `structured`, and require the conversation's Agent to call native `rpc_result`; do not parse assistant text as an implicit result.
5. Declare caller tools with input/result schemas and service their calls concurrently, using either SDK `run()` or the CLI `tools`/`claim`/`result` flow. Replace any old callback-free `--wait` assumption; CLI waiting only observes request state.
6. Register generated files with `rpc_artifact` and retrieve by request identity plus artifact ID. Never expose or accept arbitrary remote file paths.
7. On an uncertain submit, cancel, claim, or tool-result transport outcome, query the original immutable identity before any retry. Never move the request to a rediscovered generation or automatically replay work.

### Terminal states, cancellation, leases, and artifacts

- Request records finish as immutable `completed`, `failed`, `interrupted`, or `cancelled`. Only `completed` has `result`; the other terminal states carry a structured `error`. Branch on state and machine-readable code, not English wording. Cancellation is idempotent and returns an already-terminal record unchanged. CLI wait timeout is not cancellation. See [Requests and structured results](PROTOCOL.md#requests-and-structured-results) and [Error codes](PROTOCOL.md#error-codes).
- OMP controls native CLI steering, cancellation and history navigation. The plugin does not globally intercept keys, cancel structured requests on raw input, or force a model stop after `rpc_result`. Same-session rewinds preserve the listener; removing an active request from history ends only its association. Actual session/context replacement and explicit endpoint shutdown remain fenced. See [Migration and conversation execution](PROTOCOL.md#migration-and-conversation-execution).
- A caller-tool lease is permission for one attempt, not exactly-once execution. Renewal repeats the same worker/claim with `renew:true`; expiration can make the call pending for another claim. Keep a durable side-effect ledger keyed by server `toolCallId`, and after an uncertain result response query before executing the handler again. See [Caller-executed native tools](PROTOCOL.md#caller-executed-native-tools).
- An artifact is an immutable snapshot owned by its request association, not by a separately authenticated end user. Any caller authorized by the transport and request identity can retrieve it; anonymous HTTP has no per-user ownership. Artifacts expire 30 minutes after registration, remain downloadable after terminal completion only until expiry, and do not survive instance shutdown/generation rotation. Wrong request ownership is 404; expired/deleted data is 410 `artifact_expired`. See [Artifact registration and retrieval](PROTOCOL.md#artifact-registration-and-retrieval).

### HTTPS LAN access (recommended)

On the machine running OMP, replace the example IP:

```bash
node ~/.omp/plugins/node_modules/oh-my-plugins/plugins/lanrpc/cli.mjs config \
  --host 192.0.2.10 --port 9443 --protocol https
```

Then restart OMP or run `/lanrpc restart`. You can also configure HTTPS through the `/lanrpc` menu with no manual certificate questions. OpenSSL generates a self-signed certificate with the selected IP SAN under `<root>/tls/<IP-hash>/cert.pem`, with `key.pem` beside it. Managed directories are 0700 and files are 0600, with ownership/symlink checks. A usable matching certificate is reused across restarts; a different IP gets its own certificate. If OpenSSL is missing, install it (`sudo apt install openssl` on Debian/Ubuntu, or `brew install openssl` on macOS) and retry.

Open `/lanrpc info` for the actual certificate and token file paths. Securely transfer the **public certificate only, never the private key**, and the token to the client over SSH/SCP or another authenticated channel. Save the token in a private file (`chmod 600 /secure/omp.token`). Explicitly trust the self-signed certificate with `--ca`, or install it in the client's trust store. The client never downloads and auto-trusts an unauthenticated certificate.

```bash
node ~/.omp/plugins/node_modules/oh-my-plugins/plugins/lanrpc/cli.mjs session \
  --endpoint https://192.0.2.10:9443 \
  --token-file /secure/omp.token --ca /secure/server.crt
```

HTTPS always verifies the certificate and hostname. There is no flag that disables TLS verification. Redirects, including HTTPS-to-HTTP redirects, are never followed.

Advanced custom TLS remains available: append `--tls-cert /absolute/path/server.crt --tls-key /absolute/path/server.key` to `config`. Those files are never overwritten. The certificate must be currently valid and its IP SAN must match the bind IP. HTTP and disabled LAN access never read saved TLS files. If a managed certificate expires or is damaged, stop affected listeners and remove only its managed IP directory to regenerate it; securely redistribute the replacement public certificate.

### Anonymous HTTP LAN access (explicit opt-in)

**HTTP is unencrypted with NO authentication. Anyone who can reach the port can control this agent and its tools. Network observers can read or alter all messages and responses.** Choose it only when you accept this risk. HTTPS or an SSH tunnel to the loopback listener is safer.

Explicitly select HTTP on the OMP host:

```bash
node ~/.omp/plugins/node_modules/oh-my-plugins/plugins/lanrpc/cli.mjs config \
  --host 192.0.2.10 --port 9443 --protocol http
```

Restart OMP or run `/lanrpc restart`. HTTP needs no token, certificate, or private key; none are generated or read. Switching protocols or disabling LAN preserves custom certificate paths and managed certificates for later HTTPS use. Existing TLS configurations remain HTTPS; moving from a local host to a LAN host without `--protocol http` defaults to HTTPS rather than silently opening anonymous LAN access.

Every client connection to non-loopback HTTP requires **`--allow-http`**, even when selecting a LAN endpoint through local discovery:

```bash
node ~/.omp/plugins/node_modules/oh-my-plugins/plugins/lanrpc/cli.mjs session \
  --endpoint http://192.0.2.10:9443 --allow-http
node ~/.omp/plugins/node_modules/oh-my-plugins/plugins/lanrpc/cli.mjs send \
  --endpoint http://192.0.2.10:9443 --allow-http \
  --message-file /absolute/path/prompt.txt --request-id my-request --wait
node ~/.omp/plugins/node_modules/oh-my-plugins/plugins/lanrpc/cli.mjs request \
  --endpoint http://192.0.2.10:9443 --allow-http \
  --instance-id INSTANCE_UUID_FROM_SESSION \
  --request-id my-request --generation GENERATION_FROM_SESSION
```

The request query above intentionally uses advanced `--instance-id` and `--generation` to address the exact original wire identity. Ordinary local or SSH session selection uses `--session` and does not require callers to supply runtime IDs.

Generated recovery/query commands retain `--allow-http` and omit token files for HTTP. `--token-file` and `--ca` are forbidden for HTTP and rejected before reading those files; credentials are never transmitted over HTTP. The flag does not allow redirects or disable HTTPS verification. Loopback HTTP is also anonymous and works without this flag. Browser-origin rejection remains enabled, but is not network authentication.

### Ports, discovery, and private files

`--port 0` lets each session choose a free internal port; multiple sessions cannot share the same fixed HTTP port. The SSH transport reaches every session through the machine's existing SSH port, including requests, raw events, tool replies and binary artifacts. No RPC port must be exposed or manually provided for this path.

The default configuration/runtime root is `~/.omp/lan-rpc`; override it with `OMP_LAN_RPC_DIR`. Saved `config.json` includes `protocol` (`http` or `https`). Instance metadata lives in `instances/<instance-id>.json`; **only HTTPS** has a matching `.token` file and descriptor `tokenFile`. Directories must be private (0700), and files must be owner-readable and inaccessible to other users (0600/0400). Transfer tokens only over a secure channel such as SSH/SCP. Never commit tokens, TLS private keys, or the runtime directory.

`config` updates apply at the next listener startup, not immediately to an already-running session. `--lan off` retains the saved host/protocol/TLS paths; for a saved LAN host it starts a plain loopback listener instead. `list` shows descriptors and whether their PIDs are live, not whether an endpoint is healthy. Stale descriptors are never selected or deleted automatically.

### Persistent operations log

The host writes privacy-bounded JSONL diagnostics to `~/.omp/lan-rpc/logs/operations-<pid>.jsonl` (or `$OMP_LAN_RPC_DIR/logs/operations-<pid>.jsonl`). Each process owns its file, so logging never waits on another OMP process. A file rotates before 10 MiB and retains five numbered backups (six files total). Cleanup at sink initialization and rotation retains every live PID family plus the eight newest retired PID families; it never prunes a process that is still alive. The runtime and `logs` directories are mode 0700, and log files are mode 0600. Records therefore survive listener replacement and process exit while retired-process retention remains bounded. If private file I/O fails, the original allowlisted record is preserved on stderr followed by a separate `logging.write_failed` record containing only a sanitized error code/type; logging failure never changes the business outcome.

Every record has a UTC `timestamp`, `component: "omp-lan-rpc"`, `pid`, and dot-delimited `event`. When applicable it also carries only allowlisted bounded metadata such as `requestId`, `sessionId`, `instanceId`, `generation`, `toolCallId`, `toolName`, `artifactId`, state/reason/error codes, byte counts, exit status, and duration. It never stores request messages or instructions, conversation history, prompts, tool arguments/results, artifact contents or paths, credentials/tokens, raw URLs, query strings, or arbitrary exception text. HTTP failures record only a fixed operation category and response status.

Lifecycle records correlate admission, execution, terminal outcomes, tools, artifacts and listener changes. `host.event.triggered` records native host events without implying replacement. `host.listener.preserved` records reuse after same-session history navigation; actual stop/start records identify replacement. Request scope termination, native cancellation, explicit wire cancellation and process shutdown remain distinct. Logs are diagnostic evidence, not durable request state, and never authorize replay.

## Security and protocol boundaries

- This is a request-scoped HTTP/JSON v2 API, not a full network mapping of OMP's native stdio RPC. Native mode preserves the host's native output payloads; structured mode never substitutes parsed assistant text for an explicit result tool call.
- HTTPS requires both verified TLS and a Bearer token. A token authorizes use of the existing agent and its tools; it is not a sandbox. HTTP has no authentication and grants that control to every reachable caller. Browser-origin requests remain forbidden on both transports.
- Busy requests queue, and request IDs are deduplicated within one generation. Limits are 64 unfinished requests and 256 request records.
- Records are memory-only. Exiting, switching sessions, or restarting the listener changes the instance and HTTPS token; managed certificate trust is stable for the same IP. An SSH client pins the discovered instance/generation once and never silently follows a restart.
- After a lost response, query the original instance/generation before taking further action. A new client may rediscover the same `sessionId` after restart, but it must not move or replay an uncertain old request into the new generation.
- `/lanrpc stop` closes access but cannot undo tool side effects that have already happened.
- RPC uses the selected real conversation, never a child. Request/tool history remains visible. OMP controls CLI steering and cancellation; structured RPC can continue through steering until its explicit result is submitted. Only explicit tool results are published in structured mode; native transcript mode ends its association at later native user input rather than exposing CLI content. Request tools are cleaned up on terminal paths and ordinary permissions remain intact. Caller tools are real intermediate operations, not textual, shell, HTTP, or rollout substitutes. Artifacts are immutable request-owned snapshots.

## Development

Run dependency and test commands from the collection root:

```bash
npm ci
npm run test:lanrpc
```

The standalone executable is `lanrpc`; from the checkout use `node plugins/lanrpc/cli.mjs`. The runtime directory `~/.omp/lan-rpc`, `OMP_LAN_RPC_*` environment variables, wire identifiers and `/lanrpc` command are unchanged by the package reorganization.

The status/loader compatibility boundary supports legacy string-key settings and newer registry handles. Real-conversation execution is capability-checked via `conversationExecution`; unsupported hosts fail explicitly, with no child-agent fallback. The standalone client requires Node.js >=22. Ajv is installed as a package dependency for bounded JSON Schema validation; OMP/Pi packages are supplied by the host, not installed as duplicate runtimes.

Schema validation remains isolated in killable Node workers; Agent execution does not. These are separate boundaries: worker cancellation/resource limits protect the event loop without changing caller schemas, while the host adapter owns request-scoped tools/context in the selected real conversation. Host acceptance must exercise visible conversation history, native caller tools/results, restoration before later CLI work, and cancellation fencing; earlier child-agent checks do not establish these properties.

### Compatibility verification

The [collection compatibility matrix](../../README.md#docker-harness-compatibility-matrix) owns shared runtime environments. Both collection and independently packaged plugin entrypoints are exercised; no root-level forwarding modules are kept.

### Host API boundary

`extension.mjs` is the stable plugin entry. Host lifecycle integration lives under `host/`; harness-package imports, host detection, settings-generation selection, registry access, and native tool signature adaptation are centralized under `host/adapters/`.

- `host/index.mjs` owns lifecycle observations, listener reuse, command registration, timers, dialogs, and connection-panel keyboard/clipboard handling; it does not implement a global CLI takeover policy.
- `host/adapters/index.mjs` selects the harness adapter. `host/adapters/omp.mjs` owns OMP package access, settings, session lookup and tool conversion. `host/adapters/pi.mjs` and `pi-session.mjs` adapt Pi's public message/event/context/tool APIs, retirement, cancellation and lifecycle boundaries without importing OMP packages or accessing Pi session internals.
- `host/execution.mjs` resolves the selected real AgentSession, prompts visible custom user messages, installs/restores request-local native tools, injects request-only provider context, forwards native events, and fences cancellation to the RPC-owned turn while preserving native CLI scheduling.
- `status.mjs` receives an injected host interface and owns layout/indicator behavior; controller, server, TLS, and configuration modules do not import or call OMP/Pi APIs.

Version differences must be handled inside `host/adapters/`, not spread into listener orchestration, execution policy, or RPC core. Adapter capability reports identify the harness/version and missing features; an unknown failure on a supported path is an error, not a successful unsupported test. New adapters must preserve permissions, cancellation ownership and protocol identity semantics. The async extension factory still awaits native status preparation **before** OMP constructs the TUI. Do not move this work back to `session_start`, persist layout overrides, or introduce a separate endpoint footer.

## Unreleased

- Default queue wait and execution budgets to two hours independently; explicit execution budgets may be up to 24 hours. Network-call and caller-tool timeouts remain separate.
- Show `queued: N` beside the native radar while RPC requests wait, updating on the existing scheduler tick without interrupting the current task.

- Enable LAN RPC in existing interactive Pi sessions (0.73.1, 0.74.0, 1.5.0), including native/structured replies, caller tools, cancellation fences, inline status and bounded tool retirement. Preserve OMP support; all eight pinned runtime rows pass.
- Anchor native replies by request identity instead of a pre-compaction message index; pre-admission compaction no longer incorrectly interrupts the request or drops its reply.

- Move LAN RPC into `plugins/lanrpc` as `@ylang/lanrpc`; `oh-my-plugins` is the collection root. Update installed CLI paths and extension filters as described in the collection migration guide. Wire/runtime identities remain unchanged.
- Install LAN RPC independently from `ylang-ylang/oh-my-plugin-lanrpc` on GitHub without a manual clone or npm account. Keep development in the source collection; publish versioned, whitelisted contents with `npm run plugins:publish` using GitHub CLI authentication. The standalone OMP path retains `@ylang/lanrpc`; SSH clients still require an explicit remote CLI override for that path.
- Keep caller-provided completion guidance through the original native turn after result acceptance, while removing RPC tools immediately and clearing guidance before later CLI work. Presentation remains caller-controlled; the transport does not force an acknowledgement or abort the model.
- Preserve listener identity and retained requests across same-session history navigation. Remove raw-input RPC cancellation and forced native-turn termination after successful results; let OMP own steering, rewind and interruption.
- Simplify the connection panel to session identity and connection/status details; keep instance/generation safety fields in the protocol, not in the ordinary UI.
- Add bounded private per-process operations JSONL with request/tool/listener lifecycle evidence, exact host rotation triggers, and centrally allowlisted privacy metadata. Logging never changes protocol output or business execution; file failures fall back to sanitized stderr records.
- Add protocol v2 with selectable native messages/events or schema-validated native `rpc_result`, visible execution in the selected real conversation, request-scoped `instructions`/tools with restoration, native CLI priority, caller-executed native tool callbacks, and controlled file artifacts. V1 clients must migrate explicitly; transport security remains unchanged.
- Include `ssh-demo.mjs`: IP-only, read-only session discovery and `sessionId` selection through the remote CLI, without new daemons or listening ports. Enforce SSH trust, endpoint locality and pinned instance/generation checks; never fall back to direct networking.
- Isolate OMP/Pi integration under `host/` and adapt both legacy settings methods and newer registry handles. Fix extension loading on OMP 18.8.4 (`settings.get is not a function`) while keeping native inline radar placement.
- Match SDK native `AgentTool.execute(toolCallId, params, signal, onUpdate, ctx)` signatures and advertise safe native parameter structure plus complete caller schemas in tool descriptions. Enforce original schemas in isolated workers, support standard regex/unique/recursive-reference assertions, and recheck request/lease state after asynchronous validation.

## Historical v0.4.0 (protocol v1)

- Anonymous HTTP on loopback and LAN, with explicit no-authentication warnings and non-loopback client consent. HTTP never creates, reads, requires, or transmits a token.
- Automatic private, IP-matching self-signed HTTPS certificates, stable across listener restarts. HTTPS retains mandatory verified TLS and Bearer authentication; clients explicitly trust the certificate with `--ca` or their trust store.
- Focused English connection details display the HTTPS token with `c` to copy through terminal OSC 52. Esc / Enter closes the panel and removes its hotkey; tokens stay out of logs, status bars, standalone client output, and RPC metadata.

## v0.3.0

- English `/lanrpc` menus, dialogs, notifications, help, and documentation; old command aliases removed.
- Explicit saved HTTP/HTTPS protocol selection, with HTTPS recommended for LAN access and a plaintext-risk confirmation for HTTP.
- Non-loopback HTTP clients require `--allow-http`; authentication, HTTPS verification, redirect refusal, and request-generation semantics are unchanged.
