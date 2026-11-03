import { randomBytes } from 'node:crypto';

export const MESSAGE_TYPE = 'omp-lan-rpc.request';
const MAX_REQUESTS = 256;
const MAX_PENDING = 64;
const MAX_MESSAGE_BYTES = 48 * 1024;
const MAX_RESULT_BYTES = 256 * 1024;
const DELIVERY_TIMEOUT_MS = 30_000;
const TERMINAL = new Set(['completed', 'failed', 'interrupted']);

export function failure(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

// Each controller belongs to exactly one live session generation. Records are
// intentionally memory-only: losing the process is an UNKNOWN outcome, never a
// reason for the client to automatically resubmit work to a different session.
export class RequestController {
  constructor({ sessionId, cwd, isIdle, hasPendingMessages, deliver, now = Date.now }) {
    this.sessionId = sessionId;
    this.cwd = cwd;
    this.generation = randomBytes(6).readUIntBE(0, 6) + 1;
    this.isIdle = isIdle;
    this.hasPendingMessages = hasPendingMessages;
    this.deliver = deliver;
    this.now = now;
    this.requests = new Map();
    this.queue = [];
    this.active = null;
    this.closed = false;
  }

  session() {
    return { generation: this.generation, sessionId: this.sessionId, cwd: this.cwd,
      busy: Boolean(this.active) || !this.isIdle(), queueDepth: this.queue.length };
  }

  checkGeneration(generation) {
    if (generation !== this.generation) {
      throw failure(409, 'generation_mismatch', 'Session changed; do not automatically replay old requests');
    }
  }

  snapshot(record) {
    const { message, delivered, dispatchedAt, answer, ...publicRecord } = record;
    return structuredClone(publicRecord);
  }

  submit({ generation, requestId, message }) {
    this.checkGeneration(generation);
    if (this.closed) throw failure(503, 'session_closed', 'This session endpoint is closed');
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(requestId)) {
      throw failure(400, 'invalid_request_id', 'requestId must be 1..128 ASCII letters, digits, _ or -');
    }
    if (typeof message !== 'string' || !message.trim() || Buffer.byteLength(message) > MAX_MESSAGE_BYTES) {
      throw failure(400, 'invalid_message', 'message must be nonblank UTF-8 text of at most 48 KiB');
    }
    const existing = this.requests.get(requestId);
    if (existing) {
      if (existing.message !== message) throw failure(409, 'request_conflict', 'requestId already has different content');
      return this.snapshot(existing);
    }
    if (this.queue.length + (this.active ? 1 : 0) >= MAX_PENDING) {
      throw failure(429, 'queue_full', 'At most 64 outstanding requests per session');
    }
    // Never evict an idempotency record silently. A full generation must be
    // rotated explicitly so an old accepted ID cannot accidentally run twice.
    if (this.requests.size >= MAX_REQUESTS) {
      throw failure(429, 'request_capacity', 'Session endpoint has 256 records; drain requests then use /lanrpc restart');
    }
    const timestamp = this.now();
    const record = { generation, requestId, message, state: 'queued', createdAt: timestamp, updatedAt: timestamp };
    this.requests.set(requestId, record);
    this.queue.push(record);
    return this.snapshot(record);
  }

  get({ generation, requestId }) {
    this.checkGeneration(generation);
    const record = this.requests.get(requestId);
    if (!record) throw failure(404, 'request_not_found', 'No request with this ID in this generation');
    return this.snapshot(record);
  }

  finish(record, state, fields = {}) {
    record.state = state;
    record.updatedAt = this.now();
    Object.assign(record, fields);
    delete record.answer;
    if (this.active === record) this.active = null;
  }

  tick() {
    if (this.closed) return;
    if (this.active) {
      if (!this.active.delivered && this.now() - this.active.dispatchedAt > DELIVERY_TIMEOUT_MS) {
        this.finish(this.active, 'failed', { error: 'OMP did not confirm delivery within 30s; outcome unknown. Inspect the session before retrying.' });
        // A delayed host submission might still appear. Do not dispatch another
        // request into a session whose outstanding submission cannot be tracked.
        this.close('Unconfirmed host delivery; restart the endpoint after inspecting the session');
      }
      return;
    }
    if (!this.queue.length || !this.isIdle() || this.hasPendingMessages()) return;
    const record = this.queue.shift();
    this.active = record;
    record.dispatchedAt = this.now();
    try {
      this.deliver({ customType: MESSAGE_TYPE,
        content: record.message,
        display: true,
        attribution: 'agent',
        details: { requestId: record.requestId, generation: record.generation },
      });
    } catch (error) {
      this.finish(record, 'failed', { error: String(error.message || error) });
    }
  }

  observe(message) {
    const record = this.active;
    if (!record || this.closed || !message) return;
    if (message.role === 'custom' && message.customType === MESSAGE_TYPE &&
        message.details?.requestId === record.requestId && message.details?.generation === this.generation) {
      record.delivered = true;
      record.state = 'running';
      record.updatedAt = this.now();
      return;
    }
    // Do not label a human/collaborator's reply as the remote caller's result.
    // Automatic tool-result/advisor messages are not independent user prompts.
    if (record.delivered && (message.role === 'user' ||
        (message.role === 'custom' && message.attribution === 'user'))) {
      this.interrupt('Another user prompt entered this turn; inspect the session for the outcome');
    }
  }

  assistant(message) {
    const record = this.active;
    if (!record?.delivered || message?.role !== 'assistant') return;
    const text = (message.content || []).filter(block => block.type === 'text').map(block => block.text).join('');
    record.answer = { text, stopReason: message.stopReason, errorMessage: message.errorMessage };
  }

  end(event) {
    const record = this.active;
    if (!record?.delivered || event.willContinue || event.isTerminal === false) return;
    const answer = record.answer;
    if (!answer) {
      this.finish(record, 'failed', { error: 'OMP ended without a correlated assistant response' });
    } else if (answer.stopReason === 'aborted') {
      this.finish(record, 'interrupted', { error: 'OMP turn was interrupted; side effects may already have happened' });
    } else if (answer.stopReason === 'error') {
      this.finish(record, 'failed', { error: answer.errorMessage || 'Model request failed' });
    } else if (!['stop', 'length'].includes(answer.stopReason)) {
      this.finish(record, 'failed', { error: `OMP stopped with ${answer.stopReason || 'unknown reason'} before a final answer` });
    } else if (Buffer.byteLength(answer.text) > MAX_RESULT_BYTES) {
      this.finish(record, 'failed', { error: 'Answer exceeds 256 KiB; inspect the local session' });
    } else {
      this.finish(record, 'completed', { result: answer.text, stopReason: answer.stopReason });
    }
  }

  interrupt(reason) {
    if (this.active?.delivered) this.finish(this.active, 'interrupted', { error: reason });
  }

  hasWork() { return Boolean(this.active) || this.queue.length > 0; }

  close(reason = 'Session endpoint closed; already-started effects are not rolled back') {
    this.closed = true;
    for (const record of this.requests.values()) {
      if (!TERMINAL.has(record.state)) this.finish(record, 'interrupted', { error: reason });
    }
    this.queue.length = 0;
  }
}
