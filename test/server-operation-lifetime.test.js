import test from 'node:test';
import assert from 'node:assert/strict';
import { createServerOperations, shutdownSleep } from '../src/server/server-operation-lifetime.js';
import { sendTaskToBrokerParticipant } from '../src/server/broker-task-delivery.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
test('operation seal precedes abort reentry and drain waits actual pending body', async () => {
  const owner = createServerOperations();
  let release;
  const held = owner.run(() => new Promise(resolve => { release = resolve; }));
  let called = false;
  owner.signal.addEventListener('abort', () => {
    assert.equal(owner.closed, true);
    owner.run(() => { called = true; }).catch(() => {});
  });
  owner.seal(); owner.abort();
  const drain = owner.drain();
  assert.strictEqual(owner.drain(), drain);
  let done = false; drain.then(() => { done = true; });
  await tick(); assert.equal(done, false); assert.equal(called, false);
  release(); await held; await drain;
  await assert.rejects(owner.run(() => {}), { code: 'server_shutting_down' });
});
test('operation is recorded before body can seal and drain reentrantly', async () => {
  const owner = createServerOperations();
  let release, drain, done = false;
  const pending = owner.run(() => {
    owner.seal(); drain = owner.drain(); drain.then(() => { done = true; });
    return new Promise(resolve => { release = resolve; });
  });
  await tick(); assert.equal(done, false); release(); await pending; await drain;
});
test('abort cancels the actual delay, not an abandoned race', async () => {
  const owner = createServerOperations();
  const delay = shutdownSleep(8_000, owner.signal);
  owner.seal(); owner.abort();
  await assert.rejects(delay, { code: 'server_shutting_down' });
});
test('actual broker delivery polling abort does not send or continue polling', async () => {
  const owner = createServerOperations();
  let checks = 0, sends = 0;
  const work = sendTaskToBrokerParticipant({
    brokerClient: { sendTo: async () => { sends++; } },
    targetId: 'worker', kind: 'request_task', request: { taskId: 'task' },
    isOnline: async () => { checks++; return false; },
    waitTimeoutMs: 8_000, waitIntervalMs: 5_000, signal: owner.signal,
  });
  await tick(); owner.seal(); owner.abort();
  await assert.rejects(work, { code: 'server_shutting_down' });
  assert.equal(checks, 1); assert.equal(sends, 0);
});
test('abort after online check cannot enter broker send', async () => {
  const owner = createServerOperations(); let sends = 0;
  await assert.rejects(sendTaskToBrokerParticipant({
    brokerClient: { sendTo: async () => { sends++; } }, targetId: 'worker',
    kind: 'request_task', request: { taskId: 'task' }, signal: owner.signal,
    isOnline: async () => { owner.seal(); owner.abort(); return true; },
  }), { code: 'server_shutting_down' });
  assert.equal(sends, 0);
});
