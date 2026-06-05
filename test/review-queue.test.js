/**
 * KSwarm — Durable review queue tests
 *
 * Run: node test/review-queue.test.js
 */

import assert from 'node:assert/strict';
import { createReviewQueue, reviewDedupeKey, hashReviewResult } from '../src/core/review-queue.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function entry(overrides = {}) {
  return {
    projectId: 'proj-r',
    taskId: 'proj-r__item-1',
    submittedAt: 1000,
    fromWorker: 'worker',
    result: { summary: 'done', artifacts: [{ filename: 'a.md' }] },
    ...overrides,
  };
}

test('dedupe key is stable for identical submissions and varies by result hash', () => {
  const a = reviewDedupeKey(entry());
  const b = reviewDedupeKey(entry());
  assert.equal(a, b);
  const c = reviewDedupeKey(entry({ result: { summary: 'different' } }));
  assert.notEqual(a, c);
});

test('hashReviewResult is deterministic regardless of key order', () => {
  const h1 = hashReviewResult({ a: 1, b: 2 });
  const h2 = hashReviewResult({ b: 2, a: 1 });
  assert.equal(h1, h2);
});

test('enqueue adds a pending entry and is idempotent on the dedupe key', () => {
  const q = createReviewQueue();
  const first = q.enqueue(entry());
  assert.equal(first.ok, true);
  assert.equal(first.deduped, false);
  assert.equal(first.entry.status, 'pending');

  const second = q.enqueue(entry());
  assert.equal(second.ok, true);
  assert.equal(second.deduped, true);
  assert.equal(q.listSendable().length, 1);
});

test('markSent moves a pending entry to sent and removes it from sendable', () => {
  const q = createReviewQueue();
  const { entry: e } = q.enqueue(entry());
  const r = q.markSent(e.key);
  assert.equal(r.ok, true);
  assert.equal(q.get(e.key).status, 'sent');
  assert.equal(q.listSendable().length, 0);
});

test('markAcked is the only terminal success state and clears the entry from active set', () => {
  const q = createReviewQueue();
  const { entry: e } = q.enqueue(entry());
  q.markSent(e.key);
  const r = q.markAcked(e.key);
  assert.equal(r.ok, true);
  assert.equal(q.get(e.key).status, 'acked');
  assert.equal(q.listSendable().length, 0);
  assert.equal(q.listPending().length, 0);
});

test('markFailed makes a sent entry sendable again for redelivery', () => {
  const q = createReviewQueue();
  const { entry: e } = q.enqueue(entry());
  q.markSent(e.key);
  const r = q.markFailed(e.key, 'broker_unavailable');
  assert.equal(r.ok, true);
  assert.equal(q.get(e.key).status, 'failed');
  assert.equal(q.get(e.key).lastError, 'broker_unavailable');
  assert.equal(q.listSendable().length, 1);
});

test('an acked submission re-enqueued is not resent (dedupe respects terminal ack)', () => {
  const q = createReviewQueue();
  const { entry: e } = q.enqueue(entry());
  q.markSent(e.key);
  q.markAcked(e.key);
  const again = q.enqueue(entry());
  assert.equal(again.deduped, true);
  assert.equal(q.listSendable().length, 0);
});

test('snapshot and restore preserve queue state for durability', () => {
  const q = createReviewQueue();
  const { entry: e } = q.enqueue(entry());
  q.markSent(e.key);
  q.markFailed(e.key, 'oops');
  const snap = q.snapshot();

  const restored = createReviewQueue();
  restored.restore(snap);
  assert.equal(restored.get(e.key).status, 'failed');
  assert.equal(restored.listSendable().length, 1);
});

let passed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    passed++;
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(err);
    process.exitCode = 1;
    break;
  }
}
if (process.exitCode !== 1) {
  console.log(`\n${passed}/${tests.length} review queue tests passed`);
}
