import test from 'node:test';
import assert from 'node:assert/strict';
import { RequestController, MESSAGE_TYPE } from './controller.mjs';

function harness() {
  const sent = [];
  const host = { idle: true, pending: false, time: 1000 };
  const controller = new RequestController({ sessionId: 'session', cwd: '/project',
    isIdle: () => host.idle, hasPendingMessages: () => host.pending,
    deliver: message => sent.push(message), now: () => host.time });
  const submit = (requestId, message = requestId) => controller.submit({ generation: controller.generation, requestId, message });
  const get = requestId => controller.get({ generation: controller.generation, requestId });
  const deliver = index => controller.observe({ role: 'custom', ...sent[index] });
  const answer = (text, stopReason = 'stop') => controller.assistant({ role: 'assistant', content: [{ type: 'text', text }], stopReason });
  return { controller, sent, host, submit, get, deliver, answer };
}

test('same request is not dispatched twice; conflicting reuse and old generation fail', () => {
  const h = harness();
  h.submit('a', 'first');
  h.submit('a', 'first');
  assert.throws(() => h.submit('a', 'other'), error => error.status === 409);
  assert.throws(() => h.controller.submit({ generation: -1, requestId: 'b', message: 'old' }), error => error.code === 'generation_mismatch');
  h.controller.tick(); h.deliver(0); h.answer('done'); h.controller.end({});
  assert.equal(h.submit('a', 'first').result, 'done');
  h.controller.tick();
  assert.equal(h.sent.length, 1);
});

test('busy and pending local input retain FIFO work without interrupting the host', () => {
  const h = harness();
  h.submit('a'); h.submit('b');
  h.host.idle = false; h.controller.tick();
  h.host.idle = true; h.host.pending = true; h.controller.tick();
  assert.equal(h.sent.length, 0);
  h.host.pending = false; h.controller.tick();
  assert.equal(h.sent[0].details.requestId, 'a');
  h.deliver(0); h.answer('one'); h.controller.end({}); h.controller.tick();
  assert.equal(h.sent[1].details.requestId, 'b');
});

test('unrelated and intermediate agent ends cannot complete a queued request', () => {
  const h = harness();
  h.submit('a'); h.controller.tick();
  h.answer('unrelated'); h.controller.end({});
  assert.equal(h.get('a').state, 'queued');
  h.deliver(0); h.answer('intermediate'); h.controller.end({ willContinue: true });
  assert.equal(h.get('a').state, 'running');
  h.answer('retry'); h.controller.end({ isTerminal: false });
  assert.equal(h.get('a').state, 'running');
  h.answer('final'); h.controller.end({});
  assert.equal(h.get('a').result, 'final');
});

test('human interruption does not leak another user answer into remote result', () => {
  const h = harness();
  h.submit('a'); h.controller.tick(); h.deliver(0);
  h.controller.observe({ role: 'user', content: 'different task' });
  h.answer('private local answer'); h.controller.end({});
  assert.equal(h.get('a').state, 'interrupted');
  assert.equal(h.get('a').result, undefined);
});

test('host abort and model failure remain non-success outcomes', () => {
  const h = harness();
  h.submit('a'); h.controller.tick(); h.deliver(0); h.answer('partial', 'aborted'); h.controller.end({});
  assert.equal(h.get('a').state, 'interrupted');
  h.submit('b'); h.controller.tick(); h.deliver(1); h.answer('', 'error'); h.controller.end({});
  assert.equal(h.get('b').state, 'failed');
  assert.equal(h.get('b').result, undefined);
});

test('unknown delayed delivery blocks subsequent submissions instead of mixing replies', () => {
  const h = harness();
  h.submit('a'); h.submit('b'); h.controller.tick();
  h.host.time += 31_000; h.controller.tick(); h.controller.tick();
  assert.equal(h.sent.length, 1);
  assert.throws(() => h.submit('c'), error => error.code === 'session_closed');
  assert.equal(h.get('a').state, 'failed');
  assert.match(h.get('a').error, /outcome unknown/);
  assert.equal(h.get('b').state, 'interrupted');
});

test('closing a generation never sends queued work to its successor', () => {
  const h = harness();
  h.submit('a'); h.controller.close(); h.controller.tick();
  assert.equal(h.sent.length, 0);
  assert.equal(h.get('a').state, 'interrupted');
});

test('foreign custom marker cannot claim an active request', () => {
  const h = harness();
  h.submit('a'); h.controller.tick();
  h.controller.observe({ role: 'custom', customType: MESSAGE_TYPE,
    details: { requestId: 'a', generation: h.controller.generation + 1 } });
  h.answer('wrong session'); h.controller.end({});
  assert.equal(h.get('a').state, 'queued');
});
