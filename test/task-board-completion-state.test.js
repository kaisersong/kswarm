/**
 * KSwarm — task board completion state tests
 *
 * Run: node test/task-board-completion-state.test.js
 */

import assert from 'node:assert/strict';
import { createTaskBoard, restoreTaskBoard } from '../src/core/task-board.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function createBoardWithTask() {
  const board = createTaskBoard('proj-completion');
  const added = board.addTasksChecked([
    { id: 'item-1', title: 'Collect evidence', assignedAgent: 'worker' },
  ]);
  assert.equal(added.ok, true);
  return board;
}

function finishTaskAfterFailure(board, taskId = 'item-1') {
  const failed = board.transition(taskId, 'failed', {
    failureReason: 'runtime_offline',
    failureClass: 'runtime_offline',
  });
  assert.equal(failed.ok, true);
  const failedTask = board.getTask(taskId);
  assert.equal(failedTask.failureReason, 'runtime_offline');
  assert.equal(failedTask.lastFailureClass, 'runtime_offline');
  assert.equal(typeof failedTask.failedAt, 'number');

  assert.equal(board.transition(taskId, 'pending').ok, true);
  assert.equal(board.transition(taskId, 'dispatched', { assignedAgent: 'worker', runId: 'run-1' }).ok, true);
  assert.equal(board.transition(taskId, 'accepted', { assignedAgent: 'worker' }).ok, true);
  assert.equal(board.transition(taskId, 'in_progress').ok, true);
  assert.equal(board.transition(taskId, 'submitted', { result: { summary: 'done' } }).ok, true);
  assert.equal(board.transition(taskId, 'done').ok, true);
}

test('transition to done clears active failure fields from a recovered task', () => {
  const board = createBoardWithTask();
  finishTaskAfterFailure(board);

  const task = board.getTask('item-1');
  assert.equal(task.status, 'done');
  assert.equal(task.failureReason, null);
  assert.equal(task.failedAt, null);
  assert.equal(task.lastFailureClass, null);
  assert.equal(task.blockedAt, null);
  assert.equal(task.blockedReason, null);
  assert.equal(task.blockKind, null);
  assert.deepEqual(task.nextActions, []);
});

test('completeRetryParent clears active failure fields on recovered parent', () => {
  const board = createBoardWithTask();
  const failed = board.transition('item-1', 'failed', {
    failureReason: 'runtime_offline',
    failureClass: 'runtime_offline',
  });
  assert.equal(failed.ok, true);

  const completed = board.completeRetryParent('item-1', { summary: 'retry passed' }, {
    completedBy: 'retry_child',
    completedByTaskId: 'proj-completion__item-1-retry-1',
  });
  assert.equal(completed.ok, true);

  const parent = board.getTask('item-1');
  assert.equal(parent.status, 'done');
  assert.equal(parent.failureReason, null);
  assert.equal(parent.failedAt, null);
  assert.equal(parent.lastFailureClass, null);
  assert.equal(parent.completedBy, 'retry_child');
  assert.equal(parent.completedByTaskId, 'proj-completion__item-1-retry-1');
  assert.equal(parent.recoveredFromStatus, 'failed');
});

test('loadTasks normalizes persisted done tasks with stale active failure fields', () => {
  const board = restoreTaskBoard([
    {
      id: 'item-1',
      title: 'Recovered task',
      status: 'done',
      failureReason: 'runtime_offline',
      failedAt: 1779420000000,
      lastFailureClass: 'runtime_offline',
      blockedAt: 1779420000001,
      blockedReason: 'old blocker',
      blockKind: 'old_block',
      nextActions: ['old action'],
      qualityReviewHistory: [{ passed: false, feedback: 'old feedback' }],
    },
    {
      id: 'item-2',
      title: 'Still failed task',
      status: 'failed',
      failureReason: 'runtime_offline',
      failedAt: 1779420000002,
      lastFailureClass: 'runtime_offline',
    },
  ], 'proj-completion');

  const doneTask = board.getTask('item-1');
  assert.equal(doneTask.status, 'done');
  assert.equal(doneTask.failureReason, null);
  assert.equal(doneTask.failedAt, null);
  assert.equal(doneTask.lastFailureClass, null);
  assert.equal(doneTask.blockedAt, null);
  assert.equal(doneTask.blockedReason, null);
  assert.equal(doneTask.blockKind, null);
  assert.deepEqual(doneTask.nextActions, []);
  assert.deepEqual(doneTask.qualityReviewHistory, [{ passed: false, feedback: 'old feedback' }]);

  const failedTask = board.getTask('item-2');
  assert.equal(failedTask.status, 'failed');
  assert.equal(failedTask.failureReason, 'runtime_offline');
  assert.equal(failedTask.failedAt, 1779420000002);
  assert.equal(failedTask.lastFailureClass, 'runtime_offline');
});

test('plan progress excludes retry attempt children while execution attempts count them', () => {
  const board = createTaskBoard('proj-progress');
  assert.equal(board.addTasksChecked([
    { id: 'item-1', title: 'Collect evidence', assignedAgent: 'worker', phaseId: 'phase-1' },
    { id: 'item-2', title: 'Write report', assignedAgent: 'worker', phaseId: 'phase-1', dependencies: ['item-1'] },
  ]).ok, true);
  assert.equal(board.transition('item-1', 'failed', {
    failureReason: 'runtime_offline',
    failureClass: 'runtime_offline',
  }).ok, true);
  assert.equal(board.addTasksChecked([
    {
      id: 'item-1-retry-1',
      title: 'Collect evidence',
      assignedAgent: 'worker',
      phaseId: 'phase-1',
      parentTaskId: 'item-1',
      attempt: 2,
      failureReason: 'runtime_offline',
    },
  ]).ok, true);

  const progress = board.getPlanProgress();

  assert.equal(progress.total, 2);
  assert.equal(progress.failed, 1);
  assert.equal(progress.pending, 1);
  assert.equal(progress.executionAttempts.total, 3);
  assert.equal(progress.executionAttempts.failed, 1);
  assert.equal(progress.phases[0].total, 2);
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
  console.log(`\n${passed}/${tests.length} task board completion state tests passed`);
}
