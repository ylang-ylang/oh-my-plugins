#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const composeFile = resolve(root, 'compose.compat.yaml');
const matrix = JSON.parse(await readFile(resolve(root, 'compat/matrix.json'), 'utf8'));
const input = process.argv.slice(2);
const noBuildIndex = input.indexOf('--no-build');
const noBuild = noBuildIndex >= 0;
if (noBuild) input.splice(noBuildIndex, 1);
if (input.length === 0) input.push('--all');

const listOnly = input.includes('--list');
if (listOnly) {
  for (const row of matrix.cases) {
    process.stdout.write(`${row.id}\t${row.package}@${row.version}\t${row.runtime}\tlan-rpc:${row.expected.lanRpc}\t${row.expected.reason}\n`);
  }
  process.exit(0);
}
let reportPath = resolve(root, '.compat-results/report.json');
const reportIndex = input.indexOf('--report');
if (reportIndex >= 0) {
  const value = input[reportIndex + 1];
  if (!value || value.startsWith('--')) throw new Error('--report requires a host path');
  reportPath = resolve(value);
  input.splice(reportIndex, 2);
}
if (!listOnly) input.push('--report', '/tmp/compat-report.json');

if (!noBuild) {
  const build = spawnSync('docker', ['compose', '-f', composeFile, 'build', 'compat'], {
    cwd: root,
    stdio: 'inherit',
    timeout: 30 * 60 * 1000,
  });
  if (build.error) throw build.error;
  if (build.status !== 0) process.exit(build.status ?? 1);
}

const caseIndex = input.indexOf('--case');
const selectedCount = caseIndex >= 0 ? 1 : matrix.cases.length;
const jobsIndex = input.indexOf('--jobs');
const jobs = jobsIndex >= 0 ? Number(input[jobsIndex + 1]) : 1;
const batches = Math.ceil(selectedCount / (Number.isInteger(jobs) && jobs > 0 ? jobs : 1));
const runTimeout = matrix.timeoutMs * batches + 60_000;
const run = spawnSync(
  'docker',
  ['compose', '-f', composeFile, 'run', '--rm', '--no-deps', '-T', 'compat', ...input],
  { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: runTimeout },
);
if (run.error) throw run.error;
if (run.stderr) process.stderr.write(run.stderr);

let report;
try {
  report = JSON.parse(run.stdout);
} catch (error) {
  throw new Error(`Compatibility container emitted an invalid report: ${error.message}\n${run.stdout}`);
}
await mkdir(dirname(reportPath), { recursive: true });
const temporary = `${reportPath}.${process.pid}.tmp`;
await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
await rename(temporary, reportPath);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (run.status !== 0 || report.summary?.failed > 0) process.exitCode = run.status || 1;
