#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const matrixPath = join(root, 'compat/matrix.json');
const matrix = JSON.parse(await readFile(matrixPath, 'utf8'));
const args = process.argv.slice(2);

function valueAfter(flag) {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function usage(error) {
  if (error) process.stderr.write(`${error}\n\n`);
  process.stderr.write('Usage: node compat/run.mjs --list | --all | --case <id> [--jobs <count>] [--report <path>]\n');
  process.exit(error ? 2 : 0);
}

if (args.includes('--help')) usage();
if (args.includes('--list')) {
  for (const row of matrix.cases) {
    process.stdout.write(`${row.id}\t${row.package}@${row.version}\t${row.runtime}\tlan-rpc:${row.expected.lanRpc}\t${row.expected.reason}\n`);
  }
  process.exit(0);
}

const oneCase = valueAfter('--case');
const runAll = args.includes('--all');
if (Boolean(oneCase) === runAll) usage('Select exactly one of --all or --case <id>.');
const selected = oneCase ? matrix.cases.filter(row => row.id === oneCase) : matrix.cases;
if (selected.length === 0) usage(`Unknown compatibility case: ${oneCase}`);
const jobs = Number(valueAfter('--jobs') ?? '1');
if (!Number.isInteger(jobs) || jobs < 1 || jobs > 8) usage('--jobs must be an integer from 1 through 8.');
const reportPath = resolve(valueAfter('--report') ?? join(root, '.compat-results/report.json'));

async function runCase(row) {
  const startedAt = new Date();
  const tempRoot = await mkdtemp(join('/tmp', `compat-${row.id}-`));
  try {
    const runtime = row.runtime === 'bun' ? 'bun' : process.execPath;
    const child = spawn(runtime, [join(root, 'compat/probe.mjs'), '--case', row.id], {
      cwd: root,
      env: {
        ...process.env,
        HOME: `${tempRoot}/home`,
        PI_CONFIG_DIR: `${tempRoot}/config`,
        XDG_CACHE_HOME: `${tempRoot}/cache`,
        XDG_CONFIG_HOME: `${tempRoot}/xdg-config`,
        XDG_DATA_HOME: `${tempRoot}/data`,
        XDG_STATE_HOME: `${tempRoot}/state`,
        COMPAT_TEMP_ROOT: tempRoot,
        COMPAT_WORKSPACE: root,
        COMPAT_HARNESS_ROOT: process.env.COMPAT_HARNESS_ROOT ?? '/opt/harness',
        NO_COLOR: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const maxOutputBytes = 4 * 1024 * 1024;
    let stdout = '';
    let stderr = '';
    let outputOverflow = false;
    const capture = (current, chunk) => {
      if (Buffer.byteLength(current) + Buffer.byteLength(chunk) > maxOutputBytes) {
        outputOverflow = true;
        child.kill('SIGTERM');
        return current;
      }
      return current + chunk;
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout = capture(stdout, chunk); });
    child.stderr.on('data', chunk => { stderr = capture(stderr, chunk); });

    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000).unref();
    }, matrix.timeoutMs);
    const { code, signal } = await new Promise((resolveClose, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolveClose({ code, signal }));
    }).finally(() => clearTimeout(timeout));

    if (outputOverflow) throw new Error(`${row.id}: probe output exceeded ${maxOutputBytes} bytes`);
    let detail;
    if (code === 0) {
      const line = stdout.trim().split('\n').findLast(Boolean);
      try { detail = JSON.parse(line); }
      catch (error) { throw new Error(`${row.id}: probe emitted invalid JSON: ${error.message}\n${stdout}`); }
    }
    const finishedAt = new Date();
    return {
      id: row.id,
      passed: code === 0 && detail?.passed === true,
      expected: row.expected,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt - startedAt,
      exit: { code, signal, timedOut },
      detail,
      stdout: code === 0 ? undefined : stdout.trim(),
      stderr: stderr.trim() || undefined,
    };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

const results = new Array(selected.length);
let next = 0;
async function worker() {
  while (true) {
    const index = next++;
    if (index >= selected.length) return;
    const row = selected[index];
    process.stderr.write(`[compat] ${row.id}: running\n`);
    try {
      results[index] = await runCase(row);
    } catch (error) {
      results[index] = {
        id: row.id,
        passed: false,
        expected: row.expected,
        infrastructureError: error instanceof Error ? error.stack ?? error.message : String(error),
      };
    }
    process.stderr.write(`[compat] ${row.id}: ${results[index].passed ? 'passed' : 'FAILED'}\n`);
  }
}
await Promise.all(Array.from({ length: Math.min(jobs, selected.length) }, () => worker()));

const report = {
  schemaVersion: 1,
  matrix: 'compat/matrix.json',
  generatedAt: new Date().toISOString(),
  environment: {
    externalInference: false,
    credentialsMounted: false,
    harnessRoot: process.env.COMPAT_HARNESS_ROOT ?? '/opt/harness',
  },
  summary: {
    total: results.length,
    passed: results.filter(result => result.passed).length,
    failed: results.filter(result => !result.passed).length,
  },
  results,
};
await mkdir(dirname(reportPath), { recursive: true });
const temporaryReport = `${reportPath}.${process.pid}.tmp`;
await writeFile(temporaryReport, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
await rename(temporaryReport, reportPath);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (report.summary.failed > 0) process.exitCode = 1;
