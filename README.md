# omp-lan-rpc

Local and LAN message access to a running, ordinary OMP session: **anonymous HTTP** or **verified, token-authenticated HTTPS**. Newly started interactive OMP sessions load the installed plugin automatically. No watchdog and no `--mode rpc` conversion are needed.

## Check dependencies first

**Run these steps on the machine that runs OMP, not on a different development machine.**

| Dependency | Purpose |
| --- | --- |
| An installed, working OMP | Hosts the session; this plugin does not install OMP itself |
| Git | Installs the plugin from GitHub |
| Bun | OMP 18.2.6 needs `bun` on PATH during plugin installation; recent OMP releases use embedded Bun |
| Node.js >=22 | Runs the standalone command-line client |
| Homebrew (optional) | One way to install Bun, Git, and Node; not a plugin runtime dependency |
| OpenSSL (for automatic HTTPS) | Generates the managed self-signed certificate; not needed for HTTP or advanced custom certificate paths |
| Nerd Fonts (for the indicator) | The terminal displaying OMP needs the `md-radar` glyph (U+F0437); for SSH, configure the client terminal's font. This does not affect network access |

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

This option still requires Git and, for the standalone client, Node.js >=22.

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

Once prerequisites are ready:

```bash
omp plugin install github:ylang-ylang/omp-lan-rpc
```

To upgrade an existing installation to this release without reusing an older Git dependency cache:

```bash
omp plugin install 'github:ylang-ylang/omp-lan-rpc#v0.4.0'
```

Start an ordinary OMP session:

```bash
omp
```

**Fully exit and relaunch OMP after installation or upgrades.** The radar layout is prepared before the native TUI is created. Neither `/reload-plugins` nor `/lanrpc restart` rebuilds an already-created status bar; `/lanrpc restart` restarts only the network listener.

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

All menus, prompts, confirmations, errors, and help are English. The radar uses the Nerd Fonts `md-radar` glyph and OMP's native theme; local/LAN state is distinguished in the menu. Stopped access shows a small circle; an error shows `!`. If the radar looks like a box, select a supporting [Nerd Font](https://www.nerdfonts.com/) in the terminal displaying OMP. With SSH, this is the local client terminal, not the remote server.

- `/lanrpc on`: enables LAN access. First use asks for a specific local IP and port. Choose **HTTPS (recommended)** or **HTTP (unencrypted, NO authentication)**. HTTPS automatically generates/reuses a private self-signed certificate for that IP without asking for paths; previously configured custom TLS paths are preserved. HTTP requires a clear no-authentication/unencrypted-risk confirmation.
- `/lanrpc off`: disables LAN access while keeping local access. The saved LAN IP, protocol, and certificate paths are retained.
- `/lanrpc configure`: edits the IP, port, and protocol, then confirms before enabling LAN access. Configure advanced custom TLS paths through the standalone `config` command.
- `/lanrpc start`, `/lanrpc stop`, `/lanrpc restart`: starts, stops, or restarts this session's listener using saved settings.

LAN changes save defaults for future sessions and restart only the current listener; other running sessions are unchanged. Restarting rotates the instance and HTTPS token, but reuses a usable managed certificate for the same IP so client trust stays stable. Session changes and reconfiguration are refused while remote work is pending: wait for it to finish or explicitly use `/lanrpc stop`. Earlier command names are removed; use only `/lanrpc`.

## Client and LAN access

Read complete client help at the default user-install path:

```bash
node ~/.omp/plugins/node_modules/omp-lan-rpc/cli.mjs help
```

Custom OMP/XDG data roots may use a different plugin path. The client provides `list`, `session`, `send`, `request`, and `config`; `help` includes complete examples. `send` reads message contents from a file, never from command-line arguments.

### HTTPS LAN access (recommended)

On the machine running OMP, replace the example IP:

```bash
node ~/.omp/plugins/node_modules/omp-lan-rpc/cli.mjs config \
  --host 192.0.2.10 --port 9443 --protocol https
```

Then restart OMP or run `/lanrpc restart`. You can also configure HTTPS through the `/lanrpc` menu with no manual certificate questions. OpenSSL generates a self-signed certificate with the selected IP SAN under `<root>/tls/<IP-hash>/cert.pem`, with `key.pem` beside it. Managed directories are 0700 and files are 0600, with ownership/symlink checks. A usable matching certificate is reused across restarts; a different IP gets its own certificate. If OpenSSL is missing, install it (`sudo apt install openssl` on Debian/Ubuntu, or `brew install openssl` on macOS) and retry.

Open `/lanrpc info` for the actual certificate and token file paths. Securely transfer the **public certificate only, never the private key**, and the token to the client over SSH/SCP or another authenticated channel. Save the token in a private file (`chmod 600 /secure/omp.token`). Explicitly trust the self-signed certificate with `--ca`, or install it in the client's trust store. The client never downloads and auto-trusts an unauthenticated certificate.

```bash
node ~/.omp/plugins/node_modules/omp-lan-rpc/cli.mjs session \
  --endpoint https://192.0.2.10:9443 \
  --token-file /secure/omp.token --ca /secure/server.crt
```

HTTPS always verifies the certificate and hostname. There is no flag that disables TLS verification. Redirects, including HTTPS-to-HTTP redirects, are never followed.

Advanced custom TLS remains available: append `--tls-cert /absolute/path/server.crt --tls-key /absolute/path/server.key` to `config`. Those files are never overwritten. The certificate must be currently valid and its IP SAN must match the bind IP. HTTP and disabled LAN access never read saved TLS files. If a managed certificate expires or is damaged, stop affected listeners and remove only its managed IP directory to regenerate it; securely redistribute the replacement public certificate.

### Anonymous HTTP LAN access (explicit opt-in)

**HTTP is unencrypted with NO authentication. Anyone who can reach the port can control this agent and its tools. Network observers can read or alter all messages and responses.** Choose it only when you accept this risk. HTTPS or an SSH tunnel to the loopback listener is safer.

Explicitly select HTTP on the OMP host:

```bash
node ~/.omp/plugins/node_modules/omp-lan-rpc/cli.mjs config \
  --host 192.0.2.10 --port 9443 --protocol http
```

Restart OMP or run `/lanrpc restart`. HTTP needs no token, certificate, or private key; none are generated or read. Switching protocols or disabling LAN preserves custom certificate paths and managed certificates for later HTTPS use. Existing TLS configurations remain HTTPS; moving from a local host to a LAN host without `--protocol http` defaults to HTTPS rather than silently opening anonymous LAN access.

Every client connection to non-loopback HTTP requires **`--allow-http`**, even when selecting a LAN endpoint through local discovery:

```bash
node ~/.omp/plugins/node_modules/omp-lan-rpc/cli.mjs session \
  --endpoint http://192.0.2.10:9443 --allow-http
node ~/.omp/plugins/node_modules/omp-lan-rpc/cli.mjs send \
  --endpoint http://192.0.2.10:9443 --allow-http \
  --message-file /absolute/path/prompt.txt --request-id my-request --wait
node ~/.omp/plugins/node_modules/omp-lan-rpc/cli.mjs request \
  --endpoint http://192.0.2.10:9443 --allow-http \
  --request-id my-request --generation GENERATION_FROM_SESSION
```

Generated recovery/query commands retain `--allow-http` and omit token files for HTTP. `--token-file` and `--ca` are forbidden for HTTP and rejected before reading those files; credentials are never transmitted over HTTP. The flag does not allow redirects or disable HTTPS verification. Loopback HTTP is also anonymous and works without this flag. Browser-origin rejection remains enabled, but is not network authentication.

### Ports, discovery, and private files

`--port 0` lets each session choose a free port; multiple sessions cannot share the same fixed port. An SSH tunnel can reach the default loopback listener without directly exposing a LAN listener.

The default configuration/runtime root is `~/.omp/lan-rpc`; override it with `OMP_LAN_RPC_DIR`. Saved `config.json` includes `protocol` (`http` or `https`). Instance metadata lives in `instances/<instance-id>.json`; **only HTTPS** has a matching `.token` file and descriptor `tokenFile`. Directories must be private (0700), and files must be owner-readable and inaccessible to other users (0600/0400). Transfer tokens only over a secure channel such as SSH/SCP. Never commit tokens, TLS private keys, or the runtime directory.

`config` updates apply at the next listener startup, not immediately to an already-running session. `--lan off` retains the saved host/protocol/TLS paths; for a saved LAN host it starts a plain loopback listener instead. `list` shows descriptors and whether their PIDs are live, not whether an endpoint is healthy. Stale descriptors are never selected or deleted automatically.

## Security and protocol boundaries

- This is a message-level HTTP/JSON v1 API, not a full network mapping of OMP's native stdio RPC.
- HTTPS requires both verified TLS and a Bearer token. A token authorizes use of the existing agent and its tools; it is not a sandbox. HTTP has no authentication and grants that control to every reachable caller. Browser-origin requests remain forbidden on both transports.
- Busy requests queue, and request IDs are deduplicated within one generation. Limits are 64 unfinished requests and 256 request records.
- Records are memory-only. Exiting, switching sessions, or restarting the listener changes the instance and HTTPS token; managed certificate trust is stable for the same IP.
- After a lost response, query the original instance/generation before taking further action. Resending the same ID into a new session is not cross-restart exactly-once execution.
- `/lanrpc stop` closes access but cannot undo tool side effects that have already happened.

## Development

```bash
omp plugin link /absolute/path/to/omp-lan-rpc
npm test
```

The host API has been verified with OMP 18.2.6. The standalone client requires Node.js >=22. There are no third-party runtime npm dependencies.

## v0.4.0

- Anonymous HTTP on loopback and LAN, with explicit no-authentication warnings and non-loopback client consent. HTTP never creates, reads, requires, or transmits a token.
- Automatic private, IP-matching self-signed HTTPS certificates, stable across listener restarts. HTTPS retains mandatory verified TLS and Bearer authentication; clients explicitly trust the certificate with `--ca` or their trust store.
- Focused English connection details display the HTTPS token with `c` to copy through terminal OSC 52. Esc / Enter closes the panel and removes its hotkey; tokens stay out of logs, status bars, standalone client output, and RPC metadata.

## v0.3.0

- English `/lanrpc` menus, dialogs, notifications, help, and documentation; old command aliases removed.
- Explicit saved HTTP/HTTPS protocol selection, with HTTPS recommended for LAN access and a plaintext-risk confirmation for HTTP.
- Non-loopback HTTP clients require `--allow-http`; authentication, HTTPS verification, redirect refusal, and request-generation semantics are unchanged.
