/**
 * KSwarm — Recovery executor tests
 *
 * Run: node test/recovery-executor.test.js
 */

import assert from 'node:assert/strict';
import { createHub } from '../src/core/hub.js';
import { executeRecoveryAction } from '../src/core/recovery-executor.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function setupHub() {
  const hub = createHub({ silent: true });
  hub.createProject({ id: 'proj-exec', name: 'Exec', goal: 'goal', poAgent: 'po', members: ['worker'] });
  hub.handleSubmitPlan('proj-exec', {
    analysis: 'test',
    phases: [{ id: 'phase-1', name: 'P1', items: [
      { id: 'item-1', title: 'Work', assignedAgent: 'worker', dependencies: [] },
    ] }],
  }, 'po');
  hub.handleCreateTasks('proj-exec', [
    { id: 'item-1', title: 'Work', assignedAgent: 'worker', phaseId: 'phase-1', dependencies: [] },
  ], 'po');
  hub.handleApprove('proj-exec');
  const board = hub.getBoard('proj-exec');
  board.transition('item-1', 'dispatched', { assignedAgent: 'worker', runId: 'run-exec-1' });
  board.transition('item-1', 'accepted', { assignedAgent: 'worker' });
  board.transition('item-1', 'in_progress');
  return { hub, board };
}

test('recover_submission action moves task to submitted and asks PO to review once', async () => {
  const { hub, board } = setupHub();
  const reviewMessages = [];
  const result = await executeRecoveryAction({
    type: 'recover_submission',
    projectId: 'proj-exec',
    taskId: 'proj-exec__item-1',
    runId: 'run-exec-1',
    agentId: 'worker',
    reason: 'journal_artifact_written',
    artifacts: [{ filename: 'result.md', mimeType: 'text/markdown' }],
  }, {
    hub,
    sendReviewSubmission: async msg => reviewMessages.push(msg),
    sendRequestTask: async () => {},
  });

  assert.equal(result.ok, true);
  const task = board.getTask('item-1');
  assert.equal(task.status, 'submitted');
  assert.equal(task.recoveredRunId, 'run-exec-1');
  assert.equal(task.recoveryReason, 'journal_artifact_written');
  assert.equal(task.result.artifacts[0].url, '/projects/proj-exec/artifacts/result.md');
  assert.equal(reviewMessages.length, 1);
  assert.equal(reviewMessages[0].taskId, 'proj-exec__item-1');
});

test('reset_pending action clears an active run for normal redispatch', async () => {
  const { hub, board } = setupHub();
  const result = await executeRecoveryAction({
    type: 'reset_pending',
    projectId: 'proj-exec',
    taskId: 'proj-exec__item-1',
    runId: 'run-exec-1',
    reason: 'lease_expired',
  }, {
    hub,
    sendReviewSubmission: async () => {},
    sendRequestTask: async () => {},
  });

  assert.equal(result.ok, true);
  const task = board.getTask('item-1');
  assert.equal(task.status, 'pending');
  assert.equal(task.recoveryStatus, 'redispatch_ready');
});

test('resume_task action re-sends the current task request without mutating task state', async () => {
  const { hub, board } = setupHub();
  const requests = [];
  const result = await executeRecoveryAction({
    type: 'resume_task',
    projectId: 'proj-exec',
    taskId: 'proj-exec__item-1',
    runId: 'run-exec-1',
    agentId: 'worker',
    reason: 'lease_unexpired_agent_online',
  }, {
    hub,
    sendReviewSubmission: async () => {},
    sendRequestTask: async (projectId, taskId) => requests.push({ projectId, taskId }),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(requests, [{ projectId: 'proj-exec', taskId: 'proj-exec__item-1' }]);
  assert.equal(board.getTask('item-1').status, 'in_progress');
});

test('resume_task refreshes the lease and clears any suspend marker', async () => {
  const { hub, board } = setupHub();
  const task = board.getTask('item-1');
  task.suspendedAt = 1_000;
  task.runLease.lastHeartbeatAt = 1_000;
  task.runLease.leaseExpiresAt = 2_000;

  const result = await executeRecoveryAction({
    type: 'resume_task',
    projectId: 'proj-exec',
    taskId: 'proj-exec__item-1',
    runId: 'run-exec-1',
    agentId: 'worker',
    reason: 'resume_after_suspend',
  }, {
    hub,
    sendReviewSubmission: async () => {},
    sendRequestTask: async () => {},
  });

  assert.equal(result.ok, true);
  const refreshed = board.getTask('item-1');
  assert.equal(refreshed.status, 'in_progress');
  assert.equal(refreshed.suspendedAt, undefined);
  assert.ok(refreshed.runLease.lastHeartbeatAt > 1_000);
  assert.ok(refreshed.runLease.leaseExpiresAt > 2_000);
});

test('defer_recovery action defers without mutating task state or re-sending the task', async () => {
  const { hub, board } = setupHub();
  const requests = [];
  const result = await executeRecoveryAction({
    type: 'defer_recovery',
    projectId: 'proj-exec',
    taskId: 'proj-exec__item-1',
    runId: 'run-exec-1',
    agentId: 'worker',
    reason: 'agent_not_yet_online',
  }, {
    hub,
    sendReviewSubmission: async () => {},
    sendRequestTask: async (projectId, taskId) => requests.push({ projectId, taskId }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.deferred, true);
  assert.deepEqual(requests, []);
  assert.equal(board.getTask('item-1').status, 'in_progress');
});

test('notify_po_review without a review sender is not reported as success', async () => {
  const { hub } = setupHub();
  const result = await executeRecoveryAction({
    type: 'notify_po_review',
    projectId: 'proj-exec',
    taskId: 'proj-exec__item-1',
    agentId: 'worker',
    result: { summary: 'done' },
  }, { hub });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'review_delivery_unavailable');
});

test('recover_submission without a review sender does not report success', async () => {
  const { hub, board } = setupHub();
  const result = await executeRecoveryAction({
    type: 'recover_submission',
    projectId: 'proj-exec',
    taskId: 'proj-exec__item-1',
    runId: 'run-exec-1',
    agentId: 'worker',
    reason: 'journal_artifact_written',
    artifacts: [{ filename: 'result.md', mimeType: 'text/markdown' }],
  }, { hub });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'review_delivery_unavailable');
  assert.equal(board.getTask('item-1').status, 'submitted');
});

let passed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
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
  console.log(`\n${passed}/${tests.length} recovery executor tests passed`);
}
