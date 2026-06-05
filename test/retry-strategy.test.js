/**
 * KSwarm — retry strategy failure taxonomy tests (P1-9 / B4)
 *
 * Run: node test/retry-strategy.test.js
 */

import assert from 'node:assert/strict';
import {
  shouldAutoRetry,
  createRetryTask,
  classifyFailure,
  classifyFailureSeverity,
  retryBackoffMs,
} from '../src/core/retry-strategy.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('classifyFailureSeverity separates transient, deterministic, and unknown', () => {
  assert.equal(classifyFailureSeverity('desktop_runtime_error'), 'transient');
  assert.equal(classifyFailureSeverity('runtime_offline'), 'transient');
  assert.equal(classifyFailureSeverity('timeout'), 'transient');
  assert.equal(classifyFailureSeverity('rate_limit'), 'transient');
  assert.equal(classifyFailureSeverity('auth_error'), 'deterministic');
  assert.equal(classifyFailureSeverity('invalid_input'), 'deterministic');
  assert.equal(classifyFailureSeverity('artifact_path_escape'), 'deterministic');
  assert.equal(classifyFailureSeverity('totally_unknown'), 'unknown');
});

test('desktop_runtime_error is now auto-retryable (B4 alignment)', () => {
  assert.equal(shouldAutoRetry({ attempt: 1, maxAttempts: 2, failureReason: 'desktop_runtime_error' }), true);
});

test('deterministic failures are never auto-retried', () => {
  assert.equal(shouldAutoRetry({ attempt: 1, maxAttempts: 3, failureReason: 'auth_error' }), false);
  assert.equal(shouldAutoRetry({ attempt: 1, maxAttempts: 3, failureReason: 'invalid_input' }), false);
});

test('unknown failure classes are not auto-retried', () => {
  assert.equal(shouldAutoRetry({ attempt: 1, maxAttempts: 3, failureReason: 'totally_unknown' }), false);
});

test('attempt cap blocks retry even for transient failures', () => {
  assert.equal(shouldAutoRetry({ attempt: 2, maxAttempts: 2, failureReason: 'timeout' }), false);
});

test('tasks with external side effects are never replayed', () => {
  assert.equal(
    shouldAutoRetry({ attempt: 1, maxAttempts: 3, failureReason: 'timeout', hasExternalSideEffects: true }),
    false,
  );
});

test('missing failureReason yields no auto-retry', () => {
  assert.equal(shouldAutoRetry({ attempt: 1, maxAttempts: 3 }), false);
});

test('retryBackoffMs is zero for the first retry then grows and caps', () => {
  assert.equal(retryBackoffMs(2, 2_000), 0);
  assert.equal(retryBackoffMs(3, 2_000), 2_000);
  assert.equal(retryBackoffMs(4, 2_000), 4_000);
  assert.equal(retryBackoffMs(100, 2_000), 60_000);
});

test('createRetryTask stamps retryNotBefore using backoff and carries side-effect flag', () => {
  const now = 1_000_000;
  const retry = createRetryTask(
    { id: 'task-1', title: 'T', attempt: 1, maxAttempts: 3, failureReason: 'timeout', hasExternalSideEffects: true },
    { now, backoffBaseMs: 2_000 },
  );
  assert.equal(retry.attempt, 2);
  assert.equal(retry.parentTaskId, 'task-1');
  assert.equal(retry.hasExternalSideEffects, true);
  // First retry runs immediately (no backoff).
  assert.equal(retry.retryNotBefore, now);

  const secondRetry = createRetryTask(
    { id: 'task-1-retry-1', title: 'T', attempt: 2, maxAttempts: 4, failureReason: 'timeout' },
    { now, backoffBaseMs: 2_000 },
  );
  assert.equal(secondRetry.attempt, 3);
  assert.equal(secondRetry.retryNotBefore, now + 2_000);
});

test('classifyFailure maps auth ahead of model and is deterministic-aware', () => {
  assert.equal(classifyFailure('Unauthorized: bad token'), 'auth_error');
  assert.equal(classifyFailure('invalid model name'), 'model_error');
  assert.equal(classifyFailure('Request timed out'), 'timeout');
  assert.equal(classifyFailure('rate limit exceeded (429)'), 'rate_limit');
  assert.equal(classifyFailure('connection runtime offline'), 'runtime_offline');
  assert.equal(classifyFailure('something weird happened'), 'agent_error');
});

let passed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    passed++;
    console.log(`\u2713 ${name}`);
  } catch (err) {
    console.error(`\u2717 ${name}`);
    console.error(err);
    process.exitCode = 1;
    break;
  }
}
if (process.exitCode !== 1) {
  console.log(`\n${passed}/${tests.length} retry strategy tests passed`);
}
