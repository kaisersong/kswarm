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
