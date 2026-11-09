import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIMITS, failure } from './protocol.mjs';

const WORKER_PATH = fileURLToPath(new URL('./schema-worker.mjs', import.meta.url));
const WORKER_DIRECTORY = dirname(WORKER_PATH);
const MAX_REQUEST_FRAME_BYTES = LIMITS.requestBytes + LIMITS.resultBytes + (16 * 1024);
const MAX_RESPONSE_FRAME_BYTES = LIMITS.resultBytes;
const MAX_NODE_PROBE_BYTES = 1024;
const WORKER_ERROR = Symbol('worker error');

let resolvedNodeExecutable;

function runtimeFailure(code, message) {
  const definitions = {
    validation_timeout: [503, 'schema validation operation timed out'],
    validation_capacity: [429, 'schema validation capacity is exhausted'],
    validation_aborted: [409, 'schema validation operation was aborted'],
    validation_worker_failed: [503, 'schema validation worker failed'],
  };
  const [status, fallback] = definitions[code];
  return failure(status, code, message ?? fallback);
}

function internalWorkerError(message) {
  return Object.assign(new Error(message), { [WORKER_ERROR]: true });
}

function isActualNodeRuntime() {
  return process.release?.name === 'node'
    && typeof process.versions?.node === 'string'
    && process.versions?.bun === undefined
    && Number.parseInt(process.versions.node, 10) >= 22
    && isAbsolute(process.execPath);
}

function nodeCandidates() {
  const configured = process.env.OMP_LAN_RPC_NODE;
  if (configured !== undefined) {
    if (!isAbsolute(configured)) {
      throw runtimeFailure('validation_worker_failed', 'OMP_LAN_RPC_NODE must be an absolute path to Node.js 22 or newer');
    }
    return [configured];
  }

  return [
    '/opt/homebrew/bin/node',
    '/home/linuxbrew/.linuxbrew/bin/node',
    '/usr/local/bin/node',
    '/usr/bin/node',
  ];
}

function collectBounded(stream, maximum, onOverflow) {
  const chunks = [];
  let bytes = 0;
  stream.on('data', chunk => {
    bytes += chunk.length;
    if (bytes > maximum) {
      onOverflow();
      return;
    }
    chunks.push(chunk);
  });
  return () => Buffer.concat(chunks, bytes);
}

async function probeNodeExecutable(candidate, signal) {
  try {
    await access(candidate, fsConstants.X_OK);
  } catch {
    return false;
  }
  if (signal?.aborted) throw internalWorkerError('aborted');

  return new Promise((resolve, reject) => {
    const child = spawn(candidate, [
      '--input-type=module',
      '--eval',
      'process.stdout.write(JSON.stringify({release:process.release?.name,node:process.versions?.node,bun:process.versions?.bun??null}))',
    ], {
      cwd: WORKER_DIRECTORY,
      env: { NODE_NO_WARNINGS: '1' },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let overflow = false;
    const output = collectBounded(child.stdout, MAX_NODE_PROBE_BYTES, () => {
      overflow = true;
      child.kill('SIGKILL');
    });
    const abort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', abort, { once: true });
    child.once('error', error => {
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) reject(internalWorkerError('aborted'));
      else if (error?.code === 'ENOENT' || error?.code === 'EACCES') resolve(false);
      else reject(internalWorkerError('node probe failed'));
    });
    child.once('close', code => {
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) {
        reject(internalWorkerError('aborted'));
        return;
      }
      if (overflow || code !== 0) {
        resolve(false);
        return;
      }
      try {
        const result = JSON.parse(output().toString('utf8'));
        resolve(result.release === 'node'
          && typeof result.node === 'string'
          && result.bun === null
          && Number.parseInt(result.node, 10) >= 22);
      } catch {
        resolve(false);
      }
    });
  });
}

async function resolveNodeExecutable(signal) {
  if (resolvedNodeExecutable !== undefined) return resolvedNodeExecutable;
  if (isActualNodeRuntime()) {
    resolvedNodeExecutable = process.execPath;
    return resolvedNodeExecutable;
  }

  const configured = process.env.OMP_LAN_RPC_NODE;
  for (const candidate of nodeCandidates()) {
    if (await probeNodeExecutable(candidate, signal)) {
      resolvedNodeExecutable = candidate;
      return candidate;
    }
    if (configured !== undefined) break;
  }
  throw runtimeFailure(
    'validation_worker_failed',
    configured === undefined
      ? 'Node.js 22 or newer could not be located for isolated schema validation'
      : 'OMP_LAN_RPC_NODE is not an executable Node.js 22 or newer runtime',
  );
}

function encodeFrame(value) {
  let payload;
  try {
    payload = Buffer.from(JSON.stringify(value));
  } catch {
    throw internalWorkerError('request serialization failed');
  }
  if (payload.length > MAX_REQUEST_FRAME_BYTES) throw internalWorkerError('request frame exceeded limit');
  const frame = Buffer.allocUnsafe(payload.length + 4);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

function decodeFrame(frame) {
  if (frame.length < 4) throw internalWorkerError('response frame was truncated');
  const length = frame.readUInt32BE(0);
  if (length > MAX_RESPONSE_FRAME_BYTES || frame.length !== length + 4) {
    throw internalWorkerError('response frame was invalid');
  }
  try {
    return JSON.parse(frame.subarray(4).toString('utf8'));
  } catch {
    throw internalWorkerError('response frame was not JSON');
  }
}

function workerFailure(response) {
  const error = response?.error;
  if (!error || !Number.isInteger(error.status) || typeof error.code !== 'string' || typeof error.message !== 'string') {
    throw internalWorkerError('worker returned an invalid error');
  }
  const allowed = new Map([
    ['invalid_schema', 400],
    ['schema_validation', 422],
    ['validation_worker_failed', 503],
  ]);
  if (allowed.get(error.code) !== error.status) throw internalWorkerError('worker returned an unsupported error');
  return failure(error.status, error.code, error.message, error.details);
}

async function executeWorker(nodeExecutable, request, signal) {
  if (signal.aborted) throw internalWorkerError('aborted');
  const frame = encodeFrame(request);
  return new Promise((resolve, reject) => {
    const child = spawn(nodeExecutable, [
      `--max-old-space-size=${LIMITS.validationHeapMb}`,
      WORKER_PATH,
    ], {
      cwd: WORKER_DIRECTORY,
      env: { NODE_NO_WARNINGS: '1' },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let overflow = false;
    const output = collectBounded(child.stdout, MAX_RESPONSE_FRAME_BYTES + 4, () => {
      overflow = true;
      child.kill('SIGKILL');
    });
    const abort = () => child.kill('SIGKILL');
    signal.addEventListener('abort', abort, { once: true });
    child.stdin.on('error', () => {});
    child.once('error', () => {
      signal.removeEventListener('abort', abort);
      reject(signal.aborted ? internalWorkerError('aborted') : internalWorkerError('worker could not start'));
    });
    child.once('close', code => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) {
        reject(internalWorkerError('aborted'));
        return;
      }
      if (overflow || code !== 0) {
        reject(internalWorkerError('worker exited unsuccessfully'));
        return;
      }
      try {
        const response = decodeFrame(output());
        if (response?.ok === true) resolve();
        else reject(workerFailure(response));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(frame);
  });
}

class ValidationRuntime {
  #active = 0;
  #queue = [];

  run(request, { signal, timeoutMs = LIMITS.validationTimeoutMs } = {}) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > LIMITS.validationTimeoutMs) {
      return Promise.reject(new TypeError(`timeoutMs must be a safe integer from 1 through ${LIMITS.validationTimeoutMs}`));
    }
    if (signal !== undefined && !(signal instanceof AbortSignal)) {
      return Promise.reject(new TypeError('signal must be an AbortSignal'));
    }
    if (signal?.aborted) return Promise.reject(runtimeFailure('validation_aborted'));
    if (this.#active >= LIMITS.validationConcurrency && this.#queue.length >= LIMITS.validationQueue) {
      return Promise.reject(runtimeFailure('validation_capacity'));
    }

    return new Promise((resolve, reject) => {
      const job = {
        request,
        signal,
        timeoutMs,
        controller: new AbortController(),
        resolve,
        reject,
        queued: false,
        cancelError: undefined,
        timer: undefined,
        abort: undefined,
      };
      const cancel = code => {
        if (job.cancelError !== undefined) return;
        job.cancelError = runtimeFailure(code);
        job.controller.abort();
        if (job.queued) {
          const index = this.#queue.indexOf(job);
          if (index !== -1) this.#queue.splice(index, 1);
          job.queued = false;
          this.#finish(job, undefined, job.cancelError);
        }
      };
      job.abort = () => cancel('validation_aborted');
      signal?.addEventListener('abort', job.abort, { once: true });
      job.timer = setTimeout(() => cancel('validation_timeout'), timeoutMs);

      if (this.#active < LIMITS.validationConcurrency) this.#start(job);
      else {
        job.queued = true;
        this.#queue.push(job);
      }
    });
  }

  async #start(job) {
    job.queued = false;
    this.#active += 1;
    let result;
    let error;
    try {
      const nodeExecutable = await resolveNodeExecutable(job.controller.signal);
      if (job.cancelError !== undefined) throw internalWorkerError('aborted');
      await executeWorker(nodeExecutable, job.request, job.controller.signal);
    } catch (caught) {
      error = job.cancelError ?? caught;
      if (error?.[WORKER_ERROR]) error = runtimeFailure('validation_worker_failed');
    } finally {
      this.#active -= 1;
      this.#finish(job, result, error);
      this.#drain();
    }
  }

  #finish(job, result, error) {
    clearTimeout(job.timer);
    job.signal?.removeEventListener('abort', job.abort);
    if (error === undefined) job.resolve(result);
    else job.reject(error);
  }

  #drain() {
    while (this.#active < LIMITS.validationConcurrency && this.#queue.length > 0) {
      const job = this.#queue.shift();
      this.#start(job);
    }
  }
}

const runtime = new ValidationRuntime();

export function runSchemaOperation(request, options) {
  return runtime.run(request, options);
}
