/**
 * KSwarm — Run lease tests
 *
 * Run: node test/run-lease.test.js
 */

import assert from 'node:assert/strict';
import { createTaskBoard } from '../src/core/task-board.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function setupBoard() {
  const board = createTaskBoard('proj-lease');
  const added = board.addTasksChecked([
    { id: 'item-1', title: 'Lease task', assignedAgent: 'worker', dependencies: [] },
  ]);
  assert.equal(added.ok, true);
  return board;
}

test('dispatch creates a durable run lease for the active run', () => {
  const board = setupBoard();
  const result = board.transition('item-1', 'dispatched', { assignedAgent: 'worker', runId: 'run-lease-1' });

  assert.equal(result.ok, true);
  const task = board.getTask('item-1');
  assert.equal(task.activeRunId, 'run-lease-1');
  assert.equal(task.runLease.runId, 'run-lease-1');
  assert.equal(task.runLease.status, 'dispatched');
  assert.equal(task.runLease.assignedAgent, 'worker');
  assert.equal(task.runLease.taskId, 'proj-lease__item-1');
});

test('accept and progress update the run lease status and heartbeat', () => {
  const board = setupBoard();
  board.transition('item-1', 'dispatched', { assignedAgent: 'worker', runId: 'run-lease-1' });
  board.transition('item-1', 'accepted', { assignedAgent: 'worker' });
  let task = board.getTask('item-1');
  assert.equal(task.runLease.status, 'accepted');
  assert.equal(typeof task.runLease.lastHeartbeatAt, 'number');

  board.transition('item-1', 'in_progress');
  task = board.getTask('item-1');
  assert.equal(task.runLease.status, 'in_progress');
  assert.equal(typeof task.runLease.lastHeartbeatAt, 'number');
});

test('progress telemetry is stored on active task run', () => {
  const board = setupBoard();
  board.transition('item-1', 'dispatched', { assignedAgent: 'worker', runId: 'run-lease-1' });
  board.transition('item-1', 'accepted', { assignedAgent: 'worker' });
  const result = board.transition('item-1', 'in_progress', {
    runTelemetry: {
    childPid: 123,
    lastStdoutAt: 1779050000000,
    lastStderrAt: 1779050000100,
    },
  });

  assert.equal(result.ok, true);
  assert.equal(board.getTask('item-1').runTelemetry.childPid, 123);
  assert.equal(board.getTask('item-1').runTelemetry.lastStdoutAt, 1779050000000);
});

test('submit moves the active lease to lastRunLease and rejects stale later submits', () => {
  const board = setupBoard();
  board.transition('item-1', 'dispatched', { assignedAgent: 'worker', runId: 'run-lease-1' });
  board.transition('item-1', 'accepted', { assignedAgent: 'worker' });
  board.transition('item-1', 'in_progress');
  const submit = board.transition('item-1', 'submitted', { result: { summary: 'done' }, runId: 'run-lease-1' });
  assert.equal(submit.ok, true);

  const task = board.getTask('item-1');
  assert.equal(task.activeRunId, null);
  assert.equal(task.runLease, null);
  assert.equal(task.lastRunLease.runId, 'run-lease-1');
  assert.equal(task.lastRunLease.status, 'submitted');

  const stale = board.validateRun('item-1', 'run-old', 'worker');
  assert.equal(stale.ok, false);
  assert.equal(stale.error, 'stale_task_run');
});

test('resetStaleRun returns an expired active run to pending with recovery audit', () => {
  const board = setupBoard();
  board.transition('item-1', 'dispatched', { assignedAgent: 'worker', runId: 'run-lease-1' });
  board.transition('item-1', 'accepted', { assignedAgent: 'worker' });
  const reset = board.resetStaleRun('item-1', 'lease_expired');

  assert.equal(reset.ok, true);
  const task = board.getTask('item-1');
  assert.equal(task.status, 'pending');
  assert.equal(task.activeRunId, null);
  assert.equal(task.recoveryStatus, 'redispatch_ready');
  assert.equal(task.recoveryReason, 'lease_expired');
  assert.equal(task.lastRunLease.status, 'expired');
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
  console.log(`\n${passed}/${tests.length} run lease tests passed`);
}
