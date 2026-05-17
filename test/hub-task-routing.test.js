/**
 * KSwarm — Hub task routing and run lease tests
 *
 * Run: node test/hub-task-routing.test.js
 */

import assert from 'node:assert/strict';
import { createHub } from '../src/core/hub.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function createMockBridge() {
  const sent = [];
  return {
    send(msg) { sent.push(msg); },
    requestTask(p) { sent.push({ type: 'intent', kind: 'request_task', ...p }); },
    getSentOf(kind) { return sent.filter(m => m.kind === kind); },
  };
}

function setupProject(hub, id) {
  hub.createProject({ id, name: id, goal: 'goal', poAgent: 'po', members: ['worker'] });
  const created = hub.handleCreateTasks(id, [
    { id: 'item-1', title: 'First', brief: 'Do first', assignedAgent: 'worker', dependencies: [] },
    { id: 'item-2', title: 'Second', brief: 'Do second', assignedAgent: 'worker', dependencies: ['First'] },
  ], 'po');
  assert.equal(created.ok, true);
  assert.equal(hub.handleApprove(id).ok, true);
}

test('same local task IDs in different projects stay isolated', () => {
  const hub = createHub({ silent: true });
  setupProject(hub, 'proj-a');
  setupProject(hub, 'proj-b');

  const aDispatch = hub.handleRequestDispatch('proj-a', 'po');
  assert.deepEqual(aDispatch.dispatched, ['proj-a__item-1']);

  const boardA = hub.getBoard('proj-a');
  const boardB = hub.getBoard('proj-b');
  const taskA = boardA.getTask('item-1');
  const runId = taskA.activeRunId;

  assert.equal(hub.handleAcceptTask('proj-a', 'item-1', 'worker', runId).ok, true);
  assert.equal(hub.handleProgress('proj-a', 'item-1', 'started', 'worker', runId).ok, true);
  assert.equal(hub.handleSubmitResult('proj-a', 'item-1', { summary: 'A done' }, 'worker', runId).ok, true);

  assert.equal(boardA.getTask('item-1').status, 'submitted');
  assert.equal(boardB.getTask('item-1').status, 'pending');
});

test('request dispatch sends runId in bridge request_task', () => {
  const bridge = createMockBridge();
  const hub = createHub({ bridge, silent: true });
  setupProject(hub, 'proj-a');

  hub.handleRequestDispatch('proj-a', 'po');
  const [request] = bridge.getSentOf('request_task');
  assert.equal(request.taskId, 'proj-a__item-1');
  assert.equal(request.projectId, 'proj-a');
  assert.equal(request.localTaskId, 'item-1');
  assert.ok(request.runId);
});

test('worker intents without the active runId are rejected after dispatch', () => {
  const hub = createHub({ silent: true });
  setupProject(hub, 'proj-a');
  hub.handleRequestDispatch('proj-a', 'po');

  const accepted = hub.handleAcceptTask('proj-a', 'item-1', 'worker');
  assert.equal(accepted.ok, false);
  assert.equal(accepted.error, 'missing_run_id');
});

test('stale run submit is rejected after retry creates a new run', () => {
  const hub = createHub({ silent: true });
  setupProject(hub, 'proj-a');
  hub.handleRequestDispatch('proj-a', 'po');
  const board = hub.getBoard('proj-a');
  const task = board.getTask('item-1');
  const oldRunId = task.activeRunId;

  board.transition('item-1', 'pending');
  board.transition('item-1', 'dispatched');
  const newRunId = board.getTask('item-1').activeRunId;
  assert.notEqual(newRunId, oldRunId);

  const submitted = hub.handleSubmitResult('proj-a', 'item-1', { summary: 'late' }, 'worker', oldRunId);
  assert.equal(submitted.ok, false);
  assert.equal(submitted.error, 'stale_task_run');
});

test('duplicate submit is idempotent only for identical payloads', () => {
  const hub = createHub({ silent: true });
  setupProject(hub, 'proj-a');
  hub.handleRequestDispatch('proj-a', 'po');
  const runId = hub.getBoard('proj-a').getTask('item-1').activeRunId;

  assert.equal(hub.handleAcceptTask('proj-a', 'item-1', 'worker', runId).ok, true);
  assert.equal(hub.handleProgress('proj-a', 'item-1', 'started', 'worker', runId).ok, true);
  assert.equal(hub.handleSubmitResult('proj-a', 'item-1', { summary: 'done' }, 'worker', runId).ok, true);

  const same = hub.handleSubmitResult('proj-a', 'item-1', { summary: 'done' }, 'worker', runId);
  assert.equal(same.ok, true);
  assert.equal(same.alreadySubmitted, true);

  const different = hub.handleSubmitResult('proj-a', 'item-1', { summary: 'changed' }, 'worker', runId);
  assert.equal(different.ok, false);
  assert.equal(different.error, 'duplicate_submit_conflict');
});

test('unassigned task is not dispatched', () => {
  const hub = createHub({ silent: true });
  hub.createProject({ id: 'proj-a', name: 'A', goal: 'goal', poAgent: 'po' });
  hub.handleCreateTasks('proj-a', [{ id: 'item-1', title: 'No owner', dependencies: [] }], 'po');
  hub.handleApprove('proj-a');

  const dispatch = hub.handleRequestDispatch('proj-a', 'po');
  assert.deepEqual(dispatch.dispatched, []);
  assert.equal(dispatch.skipped[0].reason, 'unassigned_task');
  assert.equal(hub.getBoard('proj-a').getTask('item-1').status, 'pending');
});

test('dispatch sends at most one active run to the same agent per round', () => {
  const bridge = createMockBridge();
  const hub = createHub({ bridge, silent: true });
  hub.createProject({ id: 'proj-a', name: 'A', goal: 'goal', poAgent: 'po', members: ['worker'] });
  const created = hub.handleCreateTasks('proj-a', [
    { id: 'item-1', title: 'First independent', assignedAgent: 'worker', dependencies: [] },
    { id: 'item-2', title: 'Second independent', assignedAgent: 'worker', dependencies: [] },
  ], 'po');
  assert.equal(created.ok, true);
  assert.equal(hub.handleApprove('proj-a').ok, true);

  const firstDispatch = hub.handleRequestDispatch('proj-a', 'po');
  assert.deepEqual(firstDispatch.dispatched, ['proj-a__item-1']);
  assert.deepEqual(firstDispatch.skipped, [{ taskId: 'proj-a__item-2', reason: 'agent_busy', agent: 'worker' }]);
  assert.equal(bridge.getSentOf('request_task').length, 1);
  assert.equal(hub.getBoard('proj-a').getTask('item-2').status, 'pending');

  const stillBusy = hub.handleRequestDispatch('proj-a', 'po');
  assert.deepEqual(stillBusy.dispatched, []);
  assert.deepEqual(stillBusy.skipped, [{ taskId: 'proj-a__item-2', reason: 'agent_busy', agent: 'worker' }]);

  const runId = hub.getBoard('proj-a').getTask('item-1').activeRunId;
  assert.equal(hub.handleAcceptTask('proj-a', 'item-1', 'worker', runId).ok, true);
  assert.equal(hub.handleProgress('proj-a', 'item-1', 'started', 'worker', runId).ok, true);
  assert.equal(hub.handleSubmitResult('proj-a', 'item-1', { summary: 'done' }, 'worker', runId).ok, true);

  const afterSubmit = hub.handleRequestDispatch('proj-a', 'po');
  assert.deepEqual(afterSubmit.dispatched, ['proj-a__item-2']);
});

test('worker failure requires active runId and creates a retry run', () => {
  const hub = createHub({ silent: true });
  setupProject(hub, 'proj-a');
  hub.handleRequestDispatch('proj-a', 'po');
  const board = hub.getBoard('proj-a');
  const runId = board.getTask('item-1').activeRunId;

  const missingRun = hub.handleWorkerFailure('proj-a', 'item-1', 'worker', null, 'agent_error', 'no output');
  assert.equal(missingRun.ok, false);
  assert.equal(missingRun.error, 'missing_run_id');

  const staleRun = hub.handleWorkerFailure('proj-a', 'item-1', 'worker', 'stale-run', 'agent_error', 'late failure');
  assert.equal(staleRun.ok, false);
  assert.equal(staleRun.error, 'stale_task_run');

  const failed = hub.handleWorkerFailure('proj-a', 'item-1', 'worker', runId, 'agent_error', 'no output');
  assert.equal(failed.ok, true);
  assert.equal(failed.retried, true);

  const original = board.getTask('item-1');
  const retry = board.getTask(failed.retryTaskId);
  assert.equal(original.status, 'failed');
  assert.equal(retry.status, 'dispatched');
  assert.ok(retry.activeRunId);
  assert.notEqual(retry.activeRunId, runId);
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
  console.log(`\n${passed}/${tests.length} hub task routing tests passed`);
}
