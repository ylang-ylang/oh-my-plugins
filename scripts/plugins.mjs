#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const markerFile = '.plugin-distribution.json';
const usage = `Usage: node scripts/plugins.mjs <check|publish>

check    Validate every plugins/* package and its prepared GitHub payload offline.
publish  Check all packages, then release their independent public GitHub repos.

Requires npm and tar; publishing also requires git and authenticated gh.
Package lifecycle scripts never run. Build generated files before checking.
Identical versions are skipped; changed releases require a version bump.
`;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fail(directory, message) {
  throw new Error(`${directory}: ${message}`);
}

function validName(name) {
  return typeof name === 'string' && name.length <= 214
    && /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name)
    && !['node_modules', 'favicon.ico'].includes(name);
}

function validVersion(version) {
  if (typeof version !== 'string' || version.length > 256) return false;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version);
  return match !== null
    && match.slice(1, 4).every((part) => Number.isSafeInteger(Number(part)))
    && (!match[4] || match[4].split('.').every((part) => !/^0\d+$/.test(part)));
}

function packagePath(value, directory, field, pattern = false) {
  if (typeof value !== 'string' || !value || value !== value.trim()
    || /[\\\x00-\x1f\x7f]/.test(value) || value.startsWith('/') || /^[a-z]:/i.test(value)) {
    fail(directory, `${field} must be a safe package-relative path`);
  }
  const path = value.replace(/^\.\//, '');
  if (path.split('/').includes('..') || (!pattern && (posix.normalize(path) !== path
    || path === '.' || path.endsWith('/') || /[*?\[\]{}!]/.test(path)))) {
    fail(directory, `${field} must stay inside the package and name a file, not a glob or directory`);
  }
  return path;
}

function validateManifest(manifest, directory) {
  if (!isObject(manifest)) fail(directory, 'package.json must contain an object');
  if (!validName(manifest.name)) fail(directory, 'name must be a valid lowercase npm package name');
  if (!validVersion(manifest.version)) fail(directory, 'version must be a complete valid SemVer version');
  if (manifest.private !== true) fail(directory, 'private must be true; plugins are distributed through GitHub, not npm');
  if (manifest.repository?.directory !== directory) fail(directory, `repository.directory must be ${directory}`);
  if (!Array.isArray(manifest.files) || manifest.files.length === 0
    || !manifest.files.some((path) => typeof path === 'string' && !path.startsWith('!'))) {
    fail(directory, 'files must be a nonempty whitelist with at least one inclusion');
  }
  for (const [index, path] of manifest.files.entries()) {
    packagePath(typeof path === 'string' ? path.replace(/^!/, '') : path, directory, `files[${index}]`, true);
  }

  const entries = [];
  for (const host of ['omp', 'pi']) {
    if (manifest[host] === undefined) continue;
    if (!isObject(manifest[host])) fail(directory, `${host} must be an object`);
    const extensions = manifest[host].extensions;
    if (extensions === undefined) continue;
    if (!Array.isArray(extensions)) fail(directory, `${host}.extensions must be an array`);
    for (const [index, path] of extensions.entries()) {
      const field = `${host}.extensions[${index}]`;
      entries.push({ field, path: packagePath(path, directory, field) });
    }
  }
  if (entries.length === 0) fail(directory, 'declare at least one file in omp.extensions or pi.extensions');

  if (manifest.bin !== undefined) {
    const bins = typeof manifest.bin === 'string' ? { bin: manifest.bin } : manifest.bin;
    if (!isObject(bins)) fail(directory, 'bin must be a path or an object of command paths');
    for (const [command, path] of Object.entries(bins)) {
      const field = `bin.${command}`;
      entries.push({ field, path: packagePath(path, directory, field) });
    }
  }
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    const dependencies = manifest[field];
    if (dependencies === undefined) continue;
    if (!isObject(dependencies)) fail(directory, `${field} must be an object`);
    for (const [name, spec] of Object.entries(dependencies)) {
      if (!validName(name) || typeof spec !== 'string' || !spec.trim() || spec !== spec.trim()) {
        fail(directory, `${field}.${name} must declare a package name and nonempty dependency specifier`);
      }
      const target = spec.replace(/^npm:(?:@[^/]+\/)?[^@]+@/, '');
      if (/^(?:(?:git\+)?file|link|workspace|portal|patch):/i.test(target)
        || /^(?:[./~\\]|[a-z]:)/i.test(target)) {
        fail(directory, `${field}.${name} uses a local dependency; use a published package version or remote URL`);
      }
    }
  }
  return entries;
}

async function discoverPlugins() {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const url = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url;
  const match = typeof url === 'string'
    && /^(?:git\+https:\/\/github\.com\/|https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url);
  if (!match) throw new Error('Root repository must identify a GitHub owner/repository');
  const source = `${match[1]}/${match[2]}`;
  const directories = await readdir(join(root, 'plugins'), { withFileTypes: true });
  const plugins = [];
  const names = new Set();
  for (const entry of directories.sort((a, b) => a.name.localeCompare(b.name))) {
    const directory = `plugins/${entry.name}`;
    if (entry.isSymbolicLink()) fail(directory, 'plugin directories must not be symlinks');
    if (!entry.isDirectory()) continue;
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(entry.name) || entry.name.length > 87) {
      fail(directory, 'directory must form a lowercase GitHub repository name with the oh-my-plugin- prefix');
    }
    let manifest;
    try {
      manifest = JSON.parse(await readFile(join(root, directory, 'package.json'), 'utf8'));
    } catch (error) {
      fail(directory, error instanceof SyntaxError ? 'package.json must contain valid JSON'
        : `cannot read package.json (${error.code ?? 'unknown error'})`);
    }
    const entries = validateManifest(manifest, directory);
    if (names.has(manifest.name)) fail(directory, `duplicate package name ${manifest.name}`);
    names.add(manifest.name);
    plugins.push({
      directory, manifest, entries, source,
      repository: `${match[1]}/oh-my-plugin-${entry.name}`,
      description: `Plugin distribution: ${source}/${directory}`,
    });
  }
  if (plugins.length === 0) throw new Error('No plugin directories found in plugins/*');
  return plugins;
}

function run(command, args, cwd = root, allowFailure = false) {
  const env = { ...process.env, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' };
  // Repository-location overrides must never redirect temporary Git operations to the source checkout.
  for (const key of ['GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE']) delete env[key];
  const result = spawnSync(command, args, {
    cwd, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw new Error(`Cannot run ${command} (${result.error.code ?? 'unknown error'})`);
  // Never echo arbitrary tool diagnostics: authentication errors can include credentials.
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`${command} ${args[0]} failed (${result.signal ?? `exit ${result.status}`})`);
  }
  return result;
}

function git(cwd, args) {
  return run('git', [
    '-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential',
    '-c', 'core.autocrlf=false', '-c', 'core.attributesFile=/dev/null', '-c', 'core.filemode=true',
    '-c', 'commit.gpgSign=false', '-c', 'tag.gpgSign=false', ...args,
  ], cwd).stdout.trim();
}

function json(text, context) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${context}: expected valid JSON`);
  }
}

function forbiddenFile(path) {
  const parts = path.toLowerCase().split('/');
  if (parts.some((part) => ['node_modules', '.git', '.gitattributes', '.ssh', '.aws', '__tests__', '__mocks__'].includes(part))) return true;
  return parts.some((part) => /^(?:tests?|test-support)(?:[._-]|$)/.test(part)
    || /\.(?:test|spec)\./.test(part)
    || /^\.(?:env(?:\.|$)|npmrc$|netrc$)/.test(part)
    || /^(?:credentials|secrets?)(?:[._-]|$)/.test(part)
    || /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)/.test(part)
    || /\.(?:env|key|pem|p12|pfx)$/.test(part));
}

function checkEntries(entries, files, directory) {
  for (const { field, path } of entries) {
    if (!files.has(path)) fail(directory, `${field} target ${path} is missing from the payload; include it in files and build it if needed`);
  }
}

async function payloadFiles(payload, directory, prefix = '') {
  const files = new Set();
  for (const entry of await readdir(join(payload, prefix), { withFileTypes: true })) {
    const path = packagePath(`${prefix}${entry.name}`, directory, 'payload path');
    if (forbiddenFile(path)) fail(directory, `forbidden file in payload: ${path}; tighten the files whitelist`);
    if (entry.isDirectory()) {
      for (const file of await payloadFiles(payload, directory, `${path}/`)) files.add(file);
    } else if (entry.isFile()) files.add(path);
    else fail(directory, `payload must contain only regular files and directories: ${path}`);
  }
  return files;
}

async function packPlugin(plugin, destination) {
  const { directory } = plugin;
  await mkdir(destination, { mode: 0o700 });
  const result = run('npm', [
    'pack', '--json', '--ignore-scripts', '--workspaces=false', '--offline', '--dry-run=false',
    `--pack-destination=${destination}`,
  ], join(root, directory));
  const reports = json(result.stdout, `npm pack ${directory}`);
  if (!Array.isArray(reports) || reports.length !== 1) fail(directory, 'npm pack must return exactly one package report');
  const packed = reports[0];
  if (packed.name !== plugin.manifest.name || packed.version !== plugin.manifest.version) {
    fail(directory, 'packed package name/version does not match package.json');
  }
  if (typeof packed.filename !== 'string' || !/^[a-zA-Z0-9._-]+\.tgz$/.test(packed.filename)
    || !Array.isArray(packed.files) || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(packed.integrity)) {
    fail(directory, 'npm pack returned an invalid filename, file list, or integrity hash');
  }
  const files = new Set();
  for (const file of packed.files) {
    const path = packagePath(file.path, directory, 'packed file');
    if (forbiddenFile(path)) fail(directory, `forbidden file in tarball: ${path}; tighten the files whitelist`);
    if (files.has(path)) fail(directory, `duplicate file in tarball: ${path}`);
    files.add(path);
  }
  if (!files.has('package.json')) fail(directory, 'tarball is missing package.json');
  checkEntries(plugin.entries, files, directory);
  const tarball = join(destination, packed.filename);
  if (!(await lstat(tarball)).isFile()) fail(directory, 'npm pack did not create a regular tarball file');
  const hash = createHash('sha512');
  for await (const chunk of createReadStream(tarball)) hash.update(chunk);
  if (`sha512-${hash.digest('base64')}` !== packed.integrity) fail(directory, 'tarball integrity does not match npm pack');

  // Check names and entry types before extraction, including symlinks and hard links.
  const archive = new Set();
  for (const name of run('tar', ['-tzf', tarball, '--quoting-style=literal']).stdout.trimEnd().split('\n')) {
    if (name === 'package/') continue;
    if (!name.startsWith('package/')) fail(directory, 'tarball entries must be under package/');
    const path = packagePath(name.slice(8).replace(/\/$/, ''), directory, 'tar entry');
    if (forbiddenFile(path)) fail(directory, `forbidden tar entry: ${path}`);
    if (name.endsWith('/')) continue;
    if (!files.has(path) || archive.has(path)) fail(directory, `unexpected or duplicate tar entry: ${path}`);
    archive.add(path);
  }
  if (archive.size !== files.size) fail(directory, 'tarball file list does not match npm pack');
  const types = run('tar', ['-tvzf', tarball, '--quoting-style=literal']).stdout.trimEnd().split('\n');
  if (types.some((line) => !/^[-d]/.test(line))) fail(directory, 'tarball must contain only regular files and directories');
  const payload = join(destination, 'payload');
  await mkdir(payload, { mode: 0o700 });
  run('tar', ['-xzf', tarball, '--strip-components=1', '--no-same-owner', '-C', payload]);
  const manifest = json(await readFile(join(payload, 'package.json'), 'utf8'), `${directory}/package.json`);
  if (manifest.name !== plugin.manifest.name || manifest.version !== plugin.manifest.version) fail(directory, 'tarball package identity changed');
  delete manifest.scripts;
  delete manifest.devDependencies;
  delete manifest.publishConfig;
  await writeFile(join(payload, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const readmes = [...files].filter((path) => /^readme(?:\.[^/]*)?$/i.test(path));
  for (const path of readmes) await rm(join(payload, path));
  const commands = [];
  if (manifest.omp?.extensions?.length) commands.push(`omp plugin install github:${plugin.repository}`);
  if (manifest.pi?.extensions?.length) commands.push(`pi install git:github.com/${plugin.repository}`);
  await writeFile(join(payload, 'README.md'), `# ${manifest.name}\n\n\`\`\`sh\n${commands.join('\n')}\n\`\`\`\n\n[Source and usage guide](https://github.com/${plugin.source}/tree/main/${directory})\n`);
  await writeFile(join(payload, markerFile), `${JSON.stringify({ source: plugin.source, directory }, null, 2)}\n`);
  const prepared = await payloadFiles(payload, directory);
  checkEntries(validateManifest(manifest, directory), prepared, directory);
  console.log(`Checked ${manifest.name}@${manifest.version} (${prepared.size} distribution files)`);
  return { ...plugin, manifest, payload, checkout: join(destination, 'git') };
}

async function prepareRelease(plugin, identity) {
  const { repository, directory, checkout } = plugin;
  const result = run('gh', ['api', `repos/${repository}`], root, true);
  const missing = result.status !== 0 && !result.signal && /\(HTTP 404\)/.test(result.stderr);
  if (result.status !== 0 && !missing) fail(directory, `cannot inspect GitHub repository ${repository} (exit ${result.status})`);
  const remote = missing ? null : json(result.stdout, repository);
  if (!missing && (!isObject(remote) || typeof remote.full_name !== 'string'
    || remote.full_name.toLowerCase() !== repository.toLowerCase() || remote.private !== false)) {
    fail(directory, `expected public GitHub repository ${repository}`);
  }
  await mkdir(checkout, { mode: 0o700 });
  git(checkout, ['init', '--initial-branch=main', '--template=']);
  git(checkout, ['config', '--local', 'user.name', identity.login]);
  git(checkout, ['config', '--local', 'user.email', `${identity.id}+${identity.login}@users.noreply.github.com`]);
  git(checkout, ['remote', 'add', 'origin', `https://github.com/${repository}.git`]);
  if (remote) git(checkout, ['fetch', '--no-recurse-submodules', 'origin', 'refs/heads/*:refs/remotes/origin/*', 'refs/tags/*:refs/tags/*']);
  const refs = new Set(git(checkout, ['for-each-ref', '--format=%(refname)']).split('\n').filter(Boolean));
  const main = 'refs/remotes/origin/main';
  if (remote && refs.size === 0) {
    if (remote.description !== plugin.description) fail(directory, 'empty repository lacks the exact distribution description; refusing adoption');
  } else if (remote) {
    if (!refs.has(main) || remote.default_branch !== 'main') fail(directory, 'existing distribution must have main as its default branch');
    if (!/^100644 blob [0-9a-f]+\t/.test(git(checkout, ['ls-tree', main, '--', markerFile]))) {
      fail(directory, 'existing repository has no regular distribution ownership marker; refusing replacement');
    }
    const marker = json(git(checkout, ['show', `${main}:${markerFile}`]), `${repository} ownership marker`);
    if (!isObject(marker) || Object.keys(marker).length !== 2 || marker.source !== plugin.source || marker.directory !== directory) {
      fail(directory, 'existing repository ownership marker does not match; refusing replacement');
    }
  }

  // Start with an empty index rather than checking out or deleting existing repo content.
  // The parent preserves history, while the new tree contains only the checked payload.
  for (const entry of await readdir(plugin.payload)) await cp(join(plugin.payload, entry), join(checkout, entry), { recursive: true });
  git(checkout, ['add', '--force', '--all', '--', '.']);
  const tree = git(checkout, ['write-tree']);
  const tag = `v${plugin.manifest.version}`;
  if (refs.has(`refs/tags/${tag}`)) {
    if (git(checkout, ['cat-file', '-t', `refs/tags/${tag}`]) !== 'tag') fail(directory, `${tag} is not an annotated release tag`);
    if (git(checkout, ['rev-parse', `refs/tags/${tag}^{tree}`]) !== tree) fail(directory, `${tag} already has different contents; bump the package version`);
    console.log(`Skipping ${repository}@${tag}; identical release already exists`);
    return null;
  }
  const commit = git(checkout, ['commit-tree', tree, ...(refs.has(main) ? ['-p', main] : []), '-m', `Release ${tag}`]);
  git(checkout, ['update-ref', 'refs/heads/main', commit]);
  git(checkout, ['tag', '--annotate', tag, commit, '--message', `Release ${plugin.manifest.name}@${plugin.manifest.version}`]);
  return { ...plugin, missing, tag };
}

async function publishPlugins(plugins) {
  const identity = json(run('gh', ['api', 'user']).stdout, 'GitHub identity');
  if (!/^[A-Za-z0-9-]+$/.test(identity?.login) || !Number.isSafeInteger(identity?.id) || identity.id <= 0) {
    throw new Error('gh must authenticate a GitHub user with a valid login and numeric ID');
  }
  const releases = [];
  // Finish every ownership/version check before creating repositories or pushing anything.
  for (const plugin of plugins) {
    const release = await prepareRelease(plugin, identity);
    if (release) releases.push(release);
  }
  for (const release of releases) {
    if (release.missing) run('gh', ['repo', 'create', release.repository, '--public', '--description', release.description]);
    git(release.checkout, ['push', '--atomic', 'origin', 'refs/heads/main:refs/heads/main', `refs/tags/${release.tag}:refs/tags/${release.tag}`]);
    console.log(`Published https://github.com/${release.repository} ${release.tag}`);
  }
  console.log(`Published ${releases.length} plugin(s); skipped ${plugins.length - releases.length} identical release(s).`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && ['--help', '-h', 'help'].includes(args[0])) {
    console.log(usage);
    return;
  }
  if (args.length !== 1 || !['check', 'publish'].includes(args[0])) throw new Error(usage);
  const plugins = await discoverPlugins();
  const temporary = await mkdtemp(join(tmpdir(), 'omp-plugin-pack-'));
  try {
    const packed = [];
    for (const [index, plugin] of plugins.entries()) packed.push(await packPlugin(plugin, join(temporary, String(index))));
    if (args[0] === 'publish') await publishPlugins(packed);
    else console.log(`Checked ${packed.length} independent GitHub plugin payload(s).`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`plugins: ${error.message}`);
  process.exitCode = 1;
});
