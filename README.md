# Oh My Plugins

A collection of independently installable OMP/Pi plugins: [ylang-ylang/oh-my-plugins](https://github.com/ylang-ylang/oh-my-plugins).

| Plugin | Package | Hosts | Purpose |
| --- | --- | --- | --- |
| [LAN RPC](plugins/lanrpc/README.md) | `@ylang/lanrpc` | OMP and Pi | HTTP/SSH access to the current interactive session |
| [BTW](#btw) | `@ylang/pi-btw` | Pi | Side questions without changing the main transcript |

OMP already includes native BTW; the collection does not register another BTW command there.

## Repository layout

```text
oh-my-plugins/
├── plugins/
│   ├── lanrpc/
│   │   ├── package.json          # Standalone manifest and lanrpc executable
│   │   ├── extension.mjs        # OMP/Pi extension entry
│   │   ├── host/                # Host adapters and execution lifecycle
│   │   ├── examples/            # RPC client examples
│   │   ├── *.mjs / *.test.mjs   # Implementation and colocated tests
│   │   ├── README.md
│   │   └── PROTOCOL.md
│   └── btw/
│       ├── package.json          # Standalone Pi manifest
│       ├── extension.ts
│       ├── host/                # Pi version adapters
│       └── *.test.mjs
├── scripts/plugins.mjs          # Automatic independent-package checks and publication
├── compat/                      # Shared pinned runtime environments and probes
├── compose.compat.yaml
├── package.json                 # Collection entrypoints and npm workspaces
├── package-lock.json            # Shared development dependency lock
└── README.md
```

Plugin implementations, tests, examples and plugin-specific documentation belong inside their plugin directory. Only collection packaging and cross-plugin verification belong at the root. Relative imports inside a plugin stay local; neither plugin imports its sibling. There are no legacy root forwarding entrypoints.

## Installation

Choose **one installation source per plugin**. Do not load the same extension through an independent repository, the collection, and/or a local link at the same time. Fully exit and restart the host after installation or upgrades; existing sessions are not restarted automatically.

### Independent GitHub repositories (normal installation)

Install only the plugins you want. No manual clone or npm account is needed:

```bash
# OMP: LAN RPC (OMP already has native BTW)
omp plugin install github:ylang-ylang/oh-my-plugin-lanrpc

# Pi: LAN RPC
pi install git:github.com/ylang-ylang/oh-my-plugin-lanrpc

# Pi: optional BTW, with or without LAN RPC
pi install git:github.com/ylang-ylang/oh-my-plugin-btw
```

Each command downloads the selected plugin and its runtime dependencies, not the entire collection. To use both plugins in Pi, run both Pi commands. The Pi BTW package is not an OMP plugin. Package names such as `@ylang/lanrpc` and `@ylang/pi-btw` remain installation metadata; they do not require npm scope ownership or authorization.

For an OMP user-scope standalone installation, the client is `~/.omp/plugins/node_modules/@ylang/lanrpc/cli.mjs`, not the collection path. The SSH client and SDK still default to the collection path: for a standalone remote installation, pass `--remote-cli /home/REMOTE_USER/.omp/plugins/node_modules/@ylang/lanrpc/cli.mjs` (SDK: `remoteCli`; client example: `LAN_RPC_REMOTE_CLI`). Use the remote user's actual absolute path. Pi and custom data roots use different installation locations; resolve the installed package path rather than assuming the OMP path.

These URLs point to generated distribution repositories created by `npm run plugins:publish`, not by CI. They require a successful release run. Development happens only in this collection; do not edit the generated repositories. See [Publishing plugins](#publishing-plugins).

### Local collection (development alternative)

From this checkout, install dependencies once with `npm ci`, then use the applicable host command:

```bash
omp plugin link /absolute/path/to/oh-my-plugins
pi install /absolute/path/to/oh-my-plugins
```

The collection's OMP manifest selects `plugins/lanrpc/extension.mjs`. Its Pi manifest selects that entry plus `plugins/btw/extension.ts`.

### One local plugin (development alternative)

```bash
# LAN RPC only, choose your host:
omp plugin link /absolute/path/to/oh-my-plugins/plugins/lanrpc
pi install /absolute/path/to/oh-my-plugins/plugins/lanrpc

# BTW only (Pi):
pi install /absolute/path/to/oh-my-plugins/plugins/btw
```

### Git collection with selective loading (alternative)

Pi can install the collection directly from Git, without a manually maintained checkout:

```bash
pi install git:github.com/ylang-ylang/oh-my-plugins
```

This downloads the **whole collection**. To load LAN RPC only, replace the collection's package entry in `~/.pi/agent/settings.json` with:

```json
{
  "packages": [{
    "source": "git:github.com/ylang-ylang/oh-my-plugins",
    "extensions": ["+plugins/lanrpc/extension.mjs"],
    "skills": [], "prompts": [], "themes": []
  }]
}
```

Replace that filter with `+plugins/btw/extension.ts` for BTW only. Filters control loading, not which plugin directories are downloaded; use the independent GitHub repositories above for independent downloads. Git collection installation requires a pushed commit containing this layout; uncommitted checkout changes are available only through local installation. Remove overlapping standalone/local entries rather than adding a second copy of the same extension.

### Migration from the old root layout

The root package is now `oh-my-plugins`, not `omp-lan-rpc`. LAN RPC lives under `plugins/lanrpc`; its standalone package is `@ylang/lanrpc` and its executable is `lanrpc`. Update saved local links, CLI commands and SSH remote-CLI overrides before removing the old installation. An OMP-installed collection's CLI is now:

```text
~/.omp/plugins/node_modules/oh-my-plugins/plugins/lanrpc/cli.mjs
```

The SDK uses that collection path by default. For a standalone or Pi-managed install, supply the actual absolute remote path with `--remote-cli` / SDK `remoteCli`. The old root `cli.mjs` and `extension.mjs` paths have no compatibility wrappers. Do not install both the old package and the new collection simultaneously.

This is a packaging/path migration, not an RPC protocol change. `/lanrpc`, `/v2`, the runtime directory `~/.omp/lan-rpc`, `OMP_LAN_RPC_*` variables, request message IDs and operations-log component identifiers remain unchanged. Drain/query in-flight work before a restart; never replay uncertain requests into a new generation. No running remote installation is automatically migrated.

## LAN RPC

Use `/lanrpc` for controls and `/lanrpc info` for connection details. Read [the LAN RPC guide](plugins/lanrpc/README.md) for dependencies, SSH discovery, HTTP/HTTPS security and clients; [the protocol](plugins/lanrpc/PROTOCOL.md) defines request and tool semantics.

From the collection root:

```bash
node plugins/lanrpc/cli.mjs help
node plugins/lanrpc/ssh-demo.mjs MACHINE_IP --list
```

## BTW

Use `/btw <question>`, `/btw + <follow-up>`, `/btw +` for the follow-up sheet, `/btw` for history, and `/btw copy|inject|close`. Only explicit `inject` sends content into the main conversation. History remains in `<session-file>.btw.json` sidecars.

Do not retain an old auto-discovered `~/.pi/agent/extensions/btw.ts` alongside the package. Back it up outside the extension-discovery directory before switching; preserve the history sidecars. Version-specific APIs live in `plugins/btw/host/`.

## Development and packaging

Node.js >=22 is required for LAN RPC; tests importing BTW TypeScript require a Node version with built-in type stripping (Node >=22.18). No host runtime is installed as a duplicate dependency.

```bash
npm ci --ignore-scripts
npm test
npm run test:lanrpc
npm run test:btw
npm run plugins:check              # Check real, independently packed plugin tarballs
npm pack --dry-run                 # Inspect the optional complete collection
```

Each plugin owns its runtime dependencies, package whitelist and tests. The collection also declares the runtime dependencies required by its included entrypoints (currently LAN RPC's Ajv); npm does not install nested workspace dependencies when consuming a packed collection. Keep that aggregate list aligned when adding a plugin dependency. Workspace symlinks are development-only; the collection tarball includes the actual plugin files. Compatibility staging uses npm's real package file lists, not an extra source-directory copy that can hide missing whitelist entries.

### Default contract for a new plugin

Every direct child directory of `plugins/` is discovered automatically and distributed as `ylang-ylang/oh-my-plugin-<directory>`: `plugins/lanrpc` becomes `oh-my-plugin-lanrpc`, and `plugins/btw` becomes `oh-my-plugin-btw`. The source owner and repository come from the root package's `repository`; there is no package-name mapping or manually maintained release list. Add the real implementation and its own `package.json` with:

- A unique package `name`, an independently maintained semver `version`, and `private: true` to prevent accidental npm publication. Git installation still works.
- `repository.directory: "plugins/<directory-name>"`, matching the package's location in this repository.
- A `files` whitelist covering the real extension entrypoints and all runtime files they import or read, while excluding tests and development-only helpers.
- `omp.extensions`, `pi.extensions`, or both, containing package-local entrypoints for the hosts the plugin actually supports. Do not advertise unsupported hosts.
- Its own installable runtime dependencies, test command and tests. Do not rely on root hoisting, sibling source files, `file:`/`workspace:` dependencies, or a consumer cloning this repository.

Update the workspace lockfile when adding a package or dependency. `npm run plugins:check` and `npm run plugins:publish` discover `plugins/*` automatically: no script package list, workflow matrix or release opt-in needs editing for the next plugin. Checks inspect real offline `npm pack` archives after dependencies are installed, including packaged entrypoints, so a development checkout cannot hide omitted package files. Invalid plugins fail the check before any publication starts. The root remains a **private collection**. Its host entrypoint lists and aggregate runtime dependencies still need updating if the new plugin should also load through the optional collection installation; that is separate from automatic independent-plugin discovery.

### Publishing plugins

Run releases locally from the reviewed source collection with Node.js, npm, Git, tar and the GitHub CLI installed. Authenticate once with a GitHub account allowed to create public repositories and push to the distribution repositories:

```bash
gh auth login
npm run plugins:publish
```

The publisher checks every plugin, creates any missing public `oh-my-plugin-<directory>` repositories, and pushes the checked, unpacked package contents at each repository root on `main`, with an annotated `v<package.version>` tag. Each plugin owns its package whitelist. The generated README contains only installation commands for its declared hosts and a link to its source guide. `.plugin-distribution.json` records the source collection and plugin directory to guard against publishing into an unrelated repository.

Versions belong to each plugin. Bump that plugin's `version` whenever its published content changes. A rerun skips an existing version only when its content matches; different content at the same version is rejected, never overwritten or force-pushed. Edit source only in this collection, not in the generated repositories.

`npm run plugins:check` is the credential-free, offline package check; `npm run plugins:publish` performs real GitHub writes using the existing `gh` authentication. npm is used for packing and installing dependencies, not publication. Git authentication is configured per command; no global Git credential settings are changed.

Checks and publication run locally: use `npm ci --ignore-scripts`, `npm run plugins:check` and `npm test` before a release. No GitHub Actions workflow, cross-repository CI token or release secret is required.

## Docker harness compatibility matrix

`compat/matrix.json` is the source of truth for exact harness packages/versions, runtime images, package integrity, expected support and interface-boundary rationale. Docker Engine is required; no real user configuration, credentials, home directories or active sessions should be mounted into compatibility containers.

```bash
npm run compat:list
npm run test:compat
node compat/docker.mjs --case omp-18.8.4
node compat/docker.mjs --all --jobs 2 --report .compat-results/report.json
```

`compat/docker.mjs` is the host-side build/run wrapper; `compat/run.mjs` is the container-internal runner and expects the pinned harness installations under `/opt/harness`. The wrapper writes the JSON report to the host without mounting your home or credentials into a container. Docker Compose runtime networking remains disabled; package downloads occur only while building the image.

The default matrix loads the packed collection manifest. To exercise the independently packed LAN RPC and BTW manifests using the same built image:

```bash
docker compose -f compose.compat.yaml run --rm --no-deps -T \
  -e COMPAT_PLUGIN_LAYOUT=standalone compat --all --jobs 2 --report /tmp/standalone-layout.json
```

Both layouts exercise all eight pinned hosts. The direct Compose invocation prints its report to stdout; use the host wrapper above when a persistent host report is needed for the collection layout.

If a local proxy/fake-IP DNS setup stalls Docker's build-time npm connections, explicitly run `COMPAT_BUILD_NETWORK=host npm run test:compat`; this changes build networking only, not the network-disabled runtime. Builds use pinned lockfiles/integrities and a reusable package-download cache. `npm run compat:list` only reads local matrix data and does not build images. Allow sufficient Docker disk space for several full harness installations; local unit tests which exercise artifact quotas also need at least 256 MiB of scratch space (`TMPDIR` can select a larger filesystem).

The baseline matrix covers these interface boundaries, not every historical release:

| Harness | Exact versions | Why these versions |
| --- | --- | --- |
| OMP | 18.2.6 | Legacy string-key Settings API |
| OMP | 18.6.0 | Transition release exposing registry plus legacy string-key methods |
| OMP | 18.7.0 | First selected release without the legacy string-key methods |
| OMP | 18.8.4 | Registry-based Settings API |
| OMP | 18.17.0 | Current conversation/tool APIs and newer Bun engine requirement |
| Pi (`@mariozechner`) | 0.73.1 | Last release before the package namespace transition |
| Pi (`@earendil-works`) | 0.74.0 | First release after the namespace transition |
| Pi (`@earendil-works`) | 1.5.0 | Current bundled CLI/runtime boundary |

Each container runs the real installed harness. A deterministic local provider drives its agent loop; this is an interface/behavior test, not external-model quality testing. All five OMP and all three Pi rows exercise native replies, structured results, caller tools, cancellation, user-input boundaries, retirement and repeated requests. Pi additionally starts the production HTTP listener, submits and polls a native request, and exercises the connection panel and inline status. Missing-module exceptions, arbitrary startup failures or skipped paths are not accepted as support.

Pi rows also load the real packaged BTW entry and exercise streamed side questions, follow-up/history, cancellation, private sidecar history and preservation of the main conversation. The BTW isolation baseline is taken after the preceding LAN RPC request has completed. OMP keeps its native BTW command; the external Pi plugin is not installed there.

When a harness interface changes, add a pinned row on each relevant side of the boundary and update the centralized adapter. Keep old rows until support is explicitly retired; never relax an assertion merely to make a new version green. New plugins must declare which harnesses/features they support and reuse the compatibility environment rather than assume namespace or version compatibility. Runtime images and package versions must remain pinned; do not replace them with `latest`. Reports are local artifacts under `.compat-results/`, not a promise that untested versions work.


## Unreleased

- Restructure the repository into `plugins/lanrpc` and `plugins/btw`, each independently installable. Root manifest, workspace commands, package staging and SSH default CLI path now use the collection layout.
- Distribute every `plugins/*` package through a generated public GitHub repository named `oh-my-plugin-<directory>`. Normal users install selected plugins without a manual clone or npm account. Retain automatic packed-package checks and one-command local publication through existing `gh` authentication; no Actions setup is required.
