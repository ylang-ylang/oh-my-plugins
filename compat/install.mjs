#!/usr/bin/env node
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const compatDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(compatDir, '..');
const installRoot = resolve(process.argv[2] ?? process.env.COMPAT_HARNESS_ROOT ?? '/opt/harness');
const mode = process.argv[3] ?? '--all';
if (!['--all', '--dependencies-only', '--plugin-only'].includes(mode)) {
  throw new Error(`Unknown install mode: ${mode}`);
}
const locksDir = join(compatDir, 'locks');
const dependencyCases = () => readdirSync(locksDir, { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .sort((left, right) => left.name.localeCompare(right.name))
  .map(entry => {
    const source = join(locksDir, entry.name);
    const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
    const lock = JSON.parse(readFileSync(join(source, 'package-lock.json'), 'utf8'));
    const [packageName, version] = Object.entries(manifest.dependencies ?? {})
      .find(([name]) => name.endsWith('/pi-coding-agent')) ?? [];
    if (!packageName || !version) throw new Error(`${entry.name}: lock manifest has no harness dependency`);
    const integrity = lock.packages?.[`node_modules/${packageName}`]?.integrity;
    if (typeof integrity !== 'string') throw new Error(`${entry.name}: harness lock has no integrity`);
    return { id: entry.name, package: packageName, version, integrity };
  });
const matrix = mode === '--dependencies-only'
  ? { schemaVersion: 1, cases: dependencyCases() }
  : JSON.parse(readFileSync(join(compatDir, 'matrix.json'), 'utf8'));
const packageSources = mode === '--dependencies-only' ? [] : [
  repoRoot,
  ...readdirSync(join(repoRoot, 'plugins'), { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(entry => join(repoRoot, 'plugins', entry.name)),
];
const packedPackages = mode === '--dependencies-only' ? [] : packageSources.map(source => {
  const packed = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts', '--workspaces=false'], {
    cwd: source, encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
  });
  if (packed.error) throw packed.error;
  if (packed.status !== 0) throw new Error(`Cannot inspect package ${source}: ${packed.stderr}`);
  const [manifest] = JSON.parse(packed.stdout);
  return { source, name: manifest.name, files: manifest.files.map(file => file.path) };
});

if (matrix.schemaVersion !== 1 || !Array.isArray(matrix.cases) || matrix.cases.length === 0) {
  throw new Error('compatibility install has an unsupported or empty case set');
}

function assertPinned(row) {
  for (const field of ['id', 'family', 'runtime', 'package', 'version', 'integrity', 'executable']) {
    if (typeof row[field] !== 'string' || row[field].length === 0) throw new Error(`${row.id ?? '<unknown>'}: missing ${field}`);
  }
  if (row.version === 'latest' || /[~^*xX]/.test(row.version)) throw new Error(`${row.id}: harness version is not exact`);
  if (!row.integrity.startsWith('sha512-')) throw new Error(`${row.id}: expected sha512 registry integrity`);
  if (!matrix.runtimes[row.runtime]) throw new Error(`${row.id}: unknown runtime ${row.runtime}`);
}

function copyPlugin(target) {
  for (const packed of packedPackages) {
    const destination = join(target, 'node_modules', ...packed.name.split('/'));
    rmSync(destination, { recursive: true, force: true });
    mkdirSync(destination, { recursive: true });
    for (const entry of packed.files) {
      const output = join(destination, entry);
      mkdirSync(dirname(output), { recursive: true });
      cpSync(join(packed.source, entry), output);
    }
  }
}

mkdirSync(installRoot, { recursive: true });
for (const row of matrix.cases) {
  if (mode !== '--dependencies-only') assertPinned(row);
  const source = join(compatDir, 'locks', row.id);
  const target = join(installRoot, row.id);
  const lock = JSON.parse(readFileSync(join(source, 'package-lock.json'), 'utf8'));
  const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
  const locked = lock.packages?.[`node_modules/${row.package}`];
  if (manifest.dependencies?.[row.package] !== row.version) {
    throw new Error(`${row.id}: lock manifest does not match matrix package/version`);
  }
  if (locked?.version !== row.version || locked?.integrity !== row.integrity) {
    throw new Error(`${row.id}: lockfile registry identity does not match matrix`);
  }

  if (mode !== '--plugin-only') {
    rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true });
    cpSync(join(source, 'package.json'), join(target, 'package.json'));
    cpSync(join(source, 'package-lock.json'), join(target, 'package-lock.json'));
    const installed = spawnSync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: target,
      stdio: 'inherit',
      env: { ...process.env, npm_config_update_notifier: 'false' },
      timeout: 10 * 60 * 1000,
      killSignal: 'SIGTERM',
    });
    if (installed.error) throw new Error(`${row.id}: npm ci failed: ${installed.error.message}`);
    if (installed.status !== 0) throw new Error(`${row.id}: npm ci exited ${installed.status ?? 'without status'}`);
  }
  const actual = JSON.parse(readFileSync(join(target, 'node_modules', ...row.package.split('/'), 'package.json'), 'utf8'));
  if (actual.name !== row.package || actual.version !== row.version) {
    throw new Error(`${row.id}: installed ${actual.name}@${actual.version}, expected ${row.package}@${row.version}`);
  }
  if (mode !== '--dependencies-only') copyPlugin(target);
}
