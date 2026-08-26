import test from 'node:test';
import assert from 'node:assert/strict';
import { failureRecoveryTaskIds } from '../src/core/failure-recovery-dispatch.js';

test('returns the retry child when an automatic retry was dispatched', () => {
  assert.deepEqual(failureRecoveryTaskIds({
    taskId: 'item-1',
    retryDispatched: true,
    retryTaskId: 'item-1-retry-1',
  }), ['item-1-retry-1']);
});

test('returns the same task when agent replacement redispatched it', () => {
  assert.deepEqual(failureRecoveryTaskIds({
    taskId: 'item-1-retry-1',
    replacementDispatched: true,
  }), ['item-1-retry-1']);
});

test('deduplicates recovery IDs and ignores non-dispatched branches', () => {
  assert.deepEqual(failureRecoveryTaskIds({
    taskId: 'item-1-retry-1',
    retryDispatched: true,
    retryTaskId: 'item-1-retry-1',
    replacementDispatched: true,
  }), ['item-1-retry-1']);
  assert.deepEqual(failureRecoveryTaskIds({
    taskId: 'item-1',
    retryDispatched: false,
    retryTaskId: 'item-1-retry-1',
    replacementDispatched: false,
  }), []);
});
