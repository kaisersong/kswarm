/**
 * KSwarm — Hub task routing and run lease tests
 *
 * Run: node test/hub-task-routing.test.js
 */

import assert from 'node:assert/strict';
import { createHub } from '../src/core/hub.js';
import { createTaskBoard } from '../src/core/task-board.js';

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

function setupXiaokWorkerProject(hub, id) {
  hub.createProject({ id, name: id, goal: 'goal', poAgent: 'po', members: ['xiaok-worker'] });
  const created = hub.handleCreateTasks(id, [
    { id: 'item-1', title: 'First', brief: 'Do first', assignedAgent: 'xiaok-worker', dependencies: [] },
    { id: 'item-2', title: 'Second', brief: 'Do second', assignedAgent: 'xiaok-worker', dependencies: [] },
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

test('request dispatch reserves runtime instances while preserving logical agent identity', () => {
  const bridge = createMockBridge();
  let reservation = 0;
  const runtimeInstanceAllocator = {
    getAgentConcurrency: () => ({ 'xiaok-worker': 2 }),
    reserveWorkerInstance: ({ task }) => {
      reservation += 1;
      return { ok: true, instanceId: `${task.assignedAgent}@inst-${reservation}` };
    },
  };
  const hub = createHub({ bridge, silent: true, runtimeInstanceAllocator });
  setupXiaokWorkerProject(hub, 'proj-pool');

  const dispatch = hub.handleRequestDispatch('proj-pool', 'po');
  assert.equal(dispatch.ok, true);
  assert.deepEqual(dispatch.dispatched, ['proj-pool__item-1', 'proj-pool__item-2']);

  const first = hub.getBoard('proj-pool').getTask('item-1');
  assert.equal(first.assignedAgent, 'xiaok-worker');
  assert.equal(first.assignedRuntimeInstance, 'xiaok-worker@inst-1');
  assert.equal(first.runLease.assignedAgent, 'xiaok-worker');
  assert.equal(first.runLease.assignedRuntimeInstance, 'xiaok-worker@inst-1');

  const [request] = bridge.getSentOf('request_task');
  assert.equal(request.targetParticipantId, 'xiaok-worker@inst-1');

  const runId = first.activeRunId;
  assert.equal(hub.handleAcceptTask('proj-pool', 'item-1', 'xiaok-worker@inst-1', runId).ok, true);
  assert.equal(hub.handleProgress('proj-pool', 'item-1', 'started', 'xiaok-worker@inst-1', runId).ok, true);
  assert.equal(hub.handleSubmitResult('proj-pool', 'item-1', { summary: 'done' }, 'xiaok-worker@inst-1', runId).ok, true);
});

test('runtime instance run validation rejects another instance for the same logical agent', () => {
  const runtimeInstanceAllocator = {
    getAgentConcurrency: () => ({ 'xiaok-worker': 1 }),
    reserveWorkerInstance: ({ task }) => ({ ok: true, instanceId: `${task.assignedAgent}@inst-owner` }),
  };
  const hub = createHub({ silent: true, runtimeInstanceAllocator });
  setupXiaokWorkerProject(hub, 'proj-owner');
  hub.handleRequestDispatch('proj-owner', 'po');
  const task = hub.getBoard('proj-owner').getTask('item-1');

  const wrong = hub.handleAcceptTask('proj-owner', 'item-1', 'xiaok-worker@inst-other', task.activeRunId);
  assert.equal(wrong.ok, false);
  assert.equal(wrong.error, 'wrong_assigned_agent');
  assert.equal(wrong.assignedRuntimeInstance, 'xiaok-worker@inst-owner');
});

test('runtime instance returns to idle when submitted payload fails deliverable contract', () => {
  const idleInstances = [];
  const runtimeInstanceAllocator = {
    getAgentConcurrency: () => ({ 'xiaok-worker': 1 }),
    reserveWorkerInstance: ({ task }) => ({ ok: true, instanceId: `${task.assignedAgent}@inst-contract` }),
    markInstanceIdle: instanceId => idleInstances.push(instanceId),
  };
  const hub = createHub({ silent: true, runtimeInstanceAllocator });
  hub.createProject({ id: 'proj-contract', name: 'Contract', goal: 'goal', poAgent: 'po', members: ['xiaok-worker'] });
  assert.equal(hub.handleCreateTasks('proj-contract', [
    { id: 'item-1', title: 'Write report', brief: 'Create a markdown file', assignedAgent: 'xiaok-worker', dependencies: [], requiredOutputs: ['markdown'] },
  ], 'po').ok, true);
  assert.equal(hub.handleApprove('proj-contract').ok, true);
  assert.deepEqual(hub.handleRequestDispatch('proj-contract', 'po').dispatched, ['proj-contract__item-1']);

  const task = hub.getBoard('proj-contract').getTask('item-1');
  const runId = task.activeRunId;
  assert.equal(hub.handleAcceptTask('proj-contract', 'item-1', 'xiaok-worker@inst-contract', runId).ok, true);
  assert.equal(hub.handleProgress('proj-contract', 'item-1', 'started', 'xiaok-worker@inst-contract', runId).ok, true);

  const submitted = hub.handleSubmitResult('proj-contract', 'item-1', { summary: 'no artifact' }, 'xiaok-worker@inst-contract', runId);
  assert.equal(submitted.ok, false);
  assert.equal(submitted.error, 'deliverable_contract_failed');
  assert.deepEqual(idleInstances, ['xiaok-worker@inst-contract']);
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

test('runtime instance worker failure creates retry run with a fresh runtime instance', () => {
  let reservation = 0;
  const runtimeInstanceAllocator = {
    getAgentConcurrency: () => ({ 'xiaok-worker': 2 }),
    reserveWorkerInstance: ({ task }) => {
      reservation += 1;
      return { ok: true, instanceId: `${task.assignedAgent}@inst-${reservation}` };
    },
    markInstanceFailed: () => {},
  };
  const hub = createHub({ silent: true, runtimeInstanceAllocator });
  hub.createProject({ id: 'proj-runtime-retry', name: 'Runtime Retry', goal: 'goal', poAgent: 'po', members: ['xiaok-worker'] });
  assert.equal(hub.handleCreateTasks('proj-runtime-retry', [
    { id: 'item-1', title: 'First', brief: 'Do first', assignedAgent: 'xiaok-worker', dependencies: [] },
  ], 'po').ok, true);
  assert.equal(hub.handleApprove('proj-runtime-retry').ok, true);
  assert.deepEqual(hub.handleRequestDispatch('proj-runtime-retry', 'po').dispatched, ['proj-runtime-retry__item-1']);

  const board = hub.getBoard('proj-runtime-retry');
  const original = board.getTask('item-1');
  const failed = hub.handleWorkerFailure(
    'proj-runtime-retry',
    'item-1',
    'xiaok-worker@inst-1',
    original.activeRunId,
    'agent_error',
    'no output',
  );

  assert.equal(failed.ok, true);
  assert.equal(failed.retried, true);
  const retry = board.getTask(failed.retryTaskId);
  assert.equal(retry.status, 'dispatched');
  assert.equal(retry.assignedAgent, 'xiaok-worker');
  assert.equal(retry.assignedRuntimeInstance, 'xiaok-worker@inst-2');
  assert.equal(retry.runLease.assignedRuntimeInstance, 'xiaok-worker@inst-2');
});

test('model empty output releases runtime instance for immediate retry instead of failing it', () => {
  const idleInstances = [];
  const failedInstances = [];
  let originalInstanceIdle = false;
  let originalInstanceReserved = false;
  const runtimeInstanceAllocator = {
    getAgentConcurrency: () => ({ 'xiaok-worker': 1 }),
    reserveWorkerInstance: () => {
      if (!originalInstanceReserved) {
        originalInstanceReserved = true;
        return { ok: true, instanceId: 'xiaok-worker@inst-1' };
      }
      if (originalInstanceIdle) return { ok: true, instanceId: 'xiaok-worker@inst-1' };
      return { ok: false, error: 'capacity_full' };
    },
    markInstanceIdle: instanceId => {
      originalInstanceIdle = true;
      idleInstances.push(instanceId);
    },
    markInstanceFailed: instanceId => failedInstances.push(instanceId),
  };
  const hub = createHub({ silent: true, runtimeInstanceAllocator });
  hub.createProject({ id: 'proj-empty-output', name: 'Empty Output', goal: 'goal', poAgent: 'po', members: ['xiaok-worker'] });
  assert.equal(hub.handleCreateTasks('proj-empty-output', [
    { id: 'item-1', title: 'Write report', brief: 'Do first', assignedAgent: 'xiaok-worker', dependencies: [] },
  ], 'po').ok, true);
  assert.equal(hub.handleApprove('proj-empty-output').ok, true);
  assert.deepEqual(hub.handleRequestDispatch('proj-empty-output', 'po').dispatched, ['proj-empty-output__item-1']);

  const board = hub.getBoard('proj-empty-output');
  const original = board.getTask('item-1');
  const failed = hub.handleWorkerFailure(
    'proj-empty-output',
    'item-1',
    'xiaok-worker@inst-1',
    original.activeRunId,
    'model_empty_output',
    'content_too_short',
  );

  assert.equal(failed.ok, true);
  assert.equal(failed.retried, true);
  assert.deepEqual(idleInstances, ['xiaok-worker@inst-1']);
  assert.deepEqual(failedInstances, []);
  const retry = board.getTask(failed.retryTaskId);
  assert.equal(retry.status, 'dispatched');
  assert.equal(retry.assignedRuntimeInstance, 'xiaok-worker@inst-1');
});

test('retry child completion marks failed parent done and unblocks dependents', () => {
  const hub = createHub({ silent: true });
  setupProject(hub, 'proj-a');
  hub.handleRequestDispatch('proj-a', 'po');
  const board = hub.getBoard('proj-a');
  const runId = board.getTask('item-1').activeRunId;

  const failed = hub.handleWorkerFailure('proj-a', 'item-1', 'worker', runId, 'agent_error', 'no output');
  assert.equal(failed.ok, true);

  const retry = board.getTask(failed.retryTaskId);
  const retryRunId = retry.activeRunId;
  assert.equal(hub.handleAcceptTask('proj-a', retry.id, 'worker', retryRunId).ok, true);
  assert.equal(hub.handleProgress('proj-a', retry.id, 'started', 'worker', retryRunId).ok, true);
  assert.equal(hub.handleSubmitResult('proj-a', retry.id, { summary: 'retry produced a usable result' }, 'worker', retryRunId).ok, true);

  const reviewed = hub.handleQualityReview('proj-a', retry.id, { passed: true, feedback: 'OK' }, 'po');
  assert.equal(reviewed.ok, true);

  const original = board.getTask('item-1');
  const completedRetry = board.getTask(retry.id);
  assert.equal(completedRetry.status, 'done');
  assert.equal(original.status, 'done');
  assert.equal(original.completedBy, 'retry_child');
  assert.equal(original.completedByTaskId, retry.id);

  const dispatch = hub.handleRequestDispatch('proj-a', 'po');
  assert.deepEqual(dispatch.dispatched, ['proj-a__item-2']);
});

test('retry child with duplicate title does not break title dependency after reload', () => {
  const hub = createHub({ silent: true });
  setupProject(hub, 'proj-a');
  hub.handleRequestDispatch('proj-a', 'po');
  const board = hub.getBoard('proj-a');
  const runId = board.getTask('item-1').activeRunId;

  const failed = hub.handleWorkerFailure('proj-a', 'item-1', 'worker', runId, 'agent_error', 'no output');
  assert.equal(failed.ok, true);

  const retry = board.getTask(failed.retryTaskId);
  const retryRunId = retry.activeRunId;
  assert.equal(hub.handleAcceptTask('proj-a', retry.id, 'worker', retryRunId).ok, true);
  assert.equal(hub.handleProgress('proj-a', retry.id, 'started', 'worker', retryRunId).ok, true);
  assert.equal(hub.handleSubmitResult('proj-a', retry.id, { summary: 'retry produced a usable result' }, 'worker', retryRunId).ok, true);
  assert.equal(hub.handleQualityReview('proj-a', retry.id, { passed: true, feedback: 'OK' }, 'po').ok, true);

  const reloaded = createTaskBoard('proj-a');
  reloaded.loadTasks(board.getAllTasks().map(task => ({ ...task })));

  const dependent = reloaded.getTask('item-2');
  assert.deepEqual(dependent.dependencies, ['proj-a__item-1']);
  assert.deepEqual(dependent.unresolvedDependencies, []);
  assert.deepEqual(reloaded.getDispatchable().map(task => task.id), ['proj-a__item-2']);
});

test('reassign reopens failed and blocked tasks for redispatch', () => {
  const hub = createHub({ silent: true });
  setupProject(hub, 'proj-a');
  hub.handleRequestDispatch('proj-a', 'po');
  const board = hub.getBoard('proj-a');
  const runId = board.getTask('item-1').activeRunId;

  const failed = hub.handleWorkerFailure('proj-a', 'item-1', 'worker', runId, 'agent_error', 'no output');
  const retry = board.getTask(failed.retryTaskId);
  const retryRunId = retry.activeRunId;
  assert.equal(hub.handleWorkerFailure('proj-a', retry.id, 'worker', retryRunId, 'runtime_stalled', 'heartbeat timeout').ok, true);
  assert.equal(board.getTask(retry.id).status, 'failed');

  const reopenedFailed = hub.handleReassignTask('proj-a', retry.id, {
    newAgent: 'worker-2',
    reason: 'manual recovery',
    fromPO: 'po',
  });
  assert.equal(reopenedFailed.ok, true);
  assert.equal(board.getTask(retry.id).status, 'dispatched');
  assert.equal(board.getTask(retry.id).assignedAgent, 'worker-2');
  assert.ok(board.getTask(retry.id).activeRunId);

  hub.createProject({ id: 'proj-b', name: 'B', goal: 'goal', poAgent: 'po', members: ['worker'] });
  hub.handleCreateTasks('proj-b', [{ id: 'blocked', title: 'Blocked', assignedAgent: 'worker', dependencies: [] }], 'po');
  hub.handleApprove('proj-b');
  const boardB = hub.getBoard('proj-b');
  assert.equal(boardB.blockTask('blocked', { blockedReason: 'needs manual recovery' }).ok, true);

  const reopenedBlocked = hub.handleReassignTask('proj-b', 'blocked', {
    newAgent: 'worker-3',
    reason: 'manual recovery',
    fromPO: 'po',
  });
  assert.equal(reopenedBlocked.ok, true);
  assert.equal(boardB.getTask('blocked').status, 'dispatched');
  assert.equal(boardB.getTask('blocked').assignedAgent, 'worker-3');
  assert.equal(boardB.getTask('blocked').blockedReason, null);
});

test('quality review rework redispatches with a fresh run id', () => {
  const bridge = createMockBridge();
  const hub = createHub({ bridge, silent: true });
  hub.createProject({ id: 'proj-quality', name: 'Quality', goal: 'goal', poAgent: 'po', members: ['worker'] });
  assert.equal(hub.handleCreateTasks('proj-quality', [
    { id: 'item-1', title: 'Draft', assignedAgent: 'worker', dependencies: [] },
  ], 'po').ok, true);
  assert.equal(hub.handleApprove('proj-quality').ok, true);
  assert.deepEqual(hub.handleRequestDispatch('proj-quality', 'po').dispatched, ['proj-quality__item-1']);

  const board = hub.getBoard('proj-quality');
  const firstRunId = board.getTask('item-1').activeRunId;
  assert.equal(hub.handleAcceptTask('proj-quality', 'item-1', 'worker', firstRunId).ok, true);
  assert.equal(hub.handleProgress('proj-quality', 'item-1', 'started', 'worker', firstRunId).ok, true);
  assert.equal(hub.handleSubmitResult('proj-quality', 'item-1', { summary: 'too vague' }, 'worker', firstRunId).ok, true);

  const review = hub.handleQualityReview('proj-quality', 'item-1', {
    passed: false,
    feedback: 'needs concrete story text',
  }, 'po');

  const task = board.getTask('item-1');
  assert.equal(review.ok, true);
  assert.equal(review.rework, true);
  assert.deepEqual(review.dispatched, ['proj-quality__item-1']);
  assert.equal(task.status, 'dispatched');
  assert.ok(task.activeRunId);
  assert.notEqual(task.activeRunId, firstRunId);
  assert.equal(task.failureReason, 'needs concrete story text');

  const requests = bridge.getSentOf('request_task');
  assert.equal(requests.length, 2);
  assert.equal(requests[1].runId, task.activeRunId);
});

test('manual dispatch recovers rework-ready in-progress task without active run', () => {
  const bridge = createMockBridge();
  const hub = createHub({ bridge, silent: true });
  hub.createProject({ id: 'proj-rework', name: 'Rework', goal: 'goal', poAgent: 'po', members: ['worker'] });
  assert.equal(hub.handleCreateTasks('proj-rework', [
    { id: 'item-1', title: 'Draft', assignedAgent: 'worker', dependencies: [] },
    { id: 'item-2', title: 'Review', assignedAgent: 'worker', dependencies: ['Draft'] },
  ], 'po').ok, true);
  assert.equal(hub.handleApprove('proj-rework').ok, true);

  const board = hub.getBoard('proj-rework');
  const task = board.getTask('item-1');
  task.status = 'in_progress';
  task.activeRunId = null;
  task.runLease = null;
  task.qualityFailureCount = 1;
  task.reviewResult = { passed: false, feedback: 'needs actual story text' };
  task.failureReason = 'needs actual story text';

  const dispatch = hub.handleRequestDispatch('proj-rework', 'po');
  const updated = board.getTask('item-1');

  assert.equal(dispatch.ok, true);
  assert.deepEqual(dispatch.dispatched, ['proj-rework__item-1']);
  assert.equal(updated.status, 'dispatched');
  assert.ok(updated.activeRunId);
  assert.deepEqual(dispatch.blocked, [
    { taskId: 'proj-rework__item-2', reason: 'dependency_pending', dependencies: ['proj-rework__item-1'] },
  ]);
  assert.equal(bridge.getSentOf('request_task').length, 1);
});

test('manual dispatch recovers quality-gate blocked task for another attempt', () => {
  const bridge = createMockBridge();
  const hub = createHub({ bridge, silent: true });
  hub.createProject({ id: 'proj-blocked-rework', name: 'Blocked Rework', goal: 'goal', poAgent: 'po', members: ['worker'] });
  assert.equal(hub.handleCreateTasks('proj-blocked-rework', [
    { id: 'item-1', title: 'Draft', assignedAgent: 'worker', dependencies: [] },
    { id: 'item-2', title: 'Review', assignedAgent: 'worker', dependencies: ['Draft'] },
  ], 'po').ok, true);
  assert.equal(hub.handleApprove('proj-blocked-rework').ok, true);

  const board = hub.getBoard('proj-blocked-rework');
  assert.equal(board.blockTask('item-1', {
    blockKind: 'quality_gate_blocked',
    blockedReason: 'submitted a report instead of the actual story',
    failureClass: 'quality_content_failed',
    qualityFailureCount: 2,
  }).ok, true);
  const task = board.getTask('item-1');
  task.reviewResult = { passed: false, feedback: 'submitted a report instead of the actual story' };

  const dispatch = hub.handleRequestDispatch('proj-blocked-rework', 'po');
  const updated = board.getTask('item-1');

  assert.equal(dispatch.ok, true);
  assert.deepEqual(dispatch.dispatched, ['proj-blocked-rework__item-1']);
  assert.equal(updated.status, 'dispatched');
  assert.equal(updated.blockedReason, null);
  assert.equal(updated.blockKind, null);
  assert.ok(updated.activeRunId);
  assert.deepEqual(dispatch.blocked, [
    { taskId: 'proj-blocked-rework__item-2', reason: 'dependency_pending', dependencies: ['proj-blocked-rework__item-1'] },
  ]);
  assert.equal(bridge.getSentOf('request_task').length, 1);
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
