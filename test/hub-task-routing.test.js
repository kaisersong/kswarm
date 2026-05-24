/**
 * KSwarm — Hub task routing and run lease tests
 *
 * Run: node test/hub-task-routing.test.js
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

test('createProject preserves user fields and sends planningGuidance only as plan context', () => {
  const bridge = createMockBridge();
  const hub = createHub({ bridge, silent: true });
  const project = hub.createProject({
    id: 'proj-guidance',
    name: 'Guidance',
    goal: '本月产品分析，给高层报告',
    requirements: '不要改写我的目标和要求。',
    planningGuidance: '计划中细化：最终任务交付 Markdown 报告。',
    poAgent: 'po',
    members: ['worker'],
  });

  assert.equal(project.goal, '本月产品分析，给高层报告');
  assert.equal(project.requirements, '不要改写我的目标和要求。');
  assert.equal(project.planningGuidance, '计划中细化：最终任务交付 Markdown 报告。');
  assert.deepEqual(project.qualityRuleSet.knowledgePacks.map(pack => pack.id), ['executive_report', 'research']);
  assert.equal(project.qualityRuleSet.requestSignals.explicitCountRequirement, null);
  assert.equal(
    project.qualityRuleSet.rules.some(rule => rule.severity === 'hard' && rule.metadata?.kind === 'fixed_count'),
    false,
  );

  const [assignPo] = bridge.getSentOf('assign_po');
  assert.equal(assignPo.payload.goal, '本月产品分析，给高层报告');
  assert.equal(assignPo.payload.requirements, '不要改写我的目标和要求。');
  assert.match(assignPo.payload.planningGuidance, /^计划中细化：最终任务交付 Markdown 报告。/);
  assert.match(assignPo.payload.planningGuidance, /Effective project-management rules/);
  assert.match(assignPo.payload.planningGuidance, /research\.source_date_gap_disclosure/);
  assert.match(assignPo.payload.planningGuidance, /executive_report\.final_artifact_polish/);
  assert.doesNotMatch(assignPo.payload.planningGuidance, /至少10|at least 10/);

  const retry = hub.handleRetryPlan('proj-guidance');
  assert.equal(retry.ok, true);
  const retryAssignPo = bridge.getSentOf('assign_po').at(-1);
  assert.equal(retryAssignPo.payload.goal, '本月产品分析，给高层报告');
  assert.equal(retryAssignPo.payload.requirements, '不要改写我的目标和要求。');
  assert.equal(retryAssignPo.payload.planningGuidance, assignPo.payload.planningGuidance);
});

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
  assert.match(request.handoffPath, /handoffs\/.+\/request\.json$/);
  const handoff = JSON.parse(readFileSync(request.handoffPath, 'utf-8'));
  assert.equal(handoff.kind, 'kswarm_task_handoff_v1');
  assert.equal(handoff.runId, request.runId);
  assert.equal(handoff.contextPolicy.largeContent, 'file_reference_only');
  assert.equal(JSON.stringify(handoff).includes('apiKey'), false);
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

test('basic invocation failure replaces default-selected worker without creating retry child', () => {
  const agents = [
    { id: 'bad-worker', roles: ['worker'], runtimeHealth: { state: 'degraded', outputCapabilities: ['markdown'], taskCapabilities: ['research'] } },
    { id: 'xiaok-worker', roles: ['worker'], runtimeHealth: { state: 'healthy', outputCapabilities: ['markdown'], taskCapabilities: ['research'] } },
  ];
  const hub = createHub({ silent: true, getAgentProfiles: () => agents });
  hub.createProject({
    id: 'proj-replace',
    name: 'Replace',
    goal: 'goal',
    poAgent: 'po',
    members: ['bad-worker', 'xiaok-worker'],
    agentSelection: {
      poAgent: { agentId: 'po', source: 'system_migration' },
      members: [
        { agentId: 'bad-worker', source: 'default_seed' },
        { agentId: 'xiaok-worker', source: 'default_seed' },
      ],
    },
  });
  assert.equal(hub.handleCreateTasks('proj-replace', [
    { id: 'item-1', title: 'Research', brief: 'Do research', assignedAgent: 'bad-worker', requiredOutputs: ['markdown'], requiredCapabilities: ['research'] },
  ], 'po').ok, true);
  assert.equal(hub.handleApprove('proj-replace').ok, true);

  const failed = hub.handleTaskFail('proj-replace', 'item-1', 'runtime_offline', 'offline');

  assert.equal(failed.ok, true);
  assert.equal(failed.replaced, true);
  assert.equal(failed.replacementDispatched, true);
  assert.equal(failed.retryTaskId, undefined);
  const tasks = hub.getBoard('proj-replace').getAllTasks();
  assert.equal(tasks.length, 1);
  const task = hub.getBoard('proj-replace').getTask('item-1');
  assert.equal(task.status, 'dispatched');
  assert.equal(task.assignedAgent, 'xiaok-worker');
  assert.ok(task.activeRunId);
  assert.equal(task.replacementHistory.length, 1);
  assert.equal(task.replacementHistory[0].fromAgentId, 'bad-worker');
});

test('output contract failure keeps same agent and uses repair intervention', () => {
  const hub = createHub({ silent: true, getAgentProfiles: () => [
    { id: 'xiaok-po', roles: ['worker'], runtimeHealth: { state: 'healthy', outputCapabilities: ['markdown'], taskCapabilities: ['research'] } },
    { id: 'xiaok-worker', roles: ['worker'], runtimeHealth: { state: 'healthy', outputCapabilities: ['markdown'], taskCapabilities: ['research'] } },
  ] });
  hub.createProject({
    id: 'proj-contract-failure',
    name: 'Contract failure',
    goal: 'goal',
    poAgent: 'po',
    members: ['xiaok-po', 'xiaok-worker'],
    agentSelection: {
      poAgent: { agentId: 'po', source: 'system_migration' },
      members: [
        { agentId: 'xiaok-po', source: 'default_seed' },
        { agentId: 'xiaok-worker', source: 'default_seed' },
      ],
    },
  });
  assert.equal(hub.handleCreateTasks('proj-contract-failure', [
    { id: 'item-1', title: 'OpenAI search', brief: 'Write markdown', assignedAgent: 'xiaok-po', requiredOutputs: ['markdown'] },
  ], 'po').ok, true);
  assert.equal(hub.handleApprove('proj-contract-failure').ok, true);

  const failed = hub.handleTaskFail('proj-contract-failure', 'item-1', 'artifact_type_mismatch', 'missing markdown');

  assert.equal(failed.ok, true);
  assert.equal(failed.replaced, undefined);
  const task = hub.getBoard('proj-contract-failure').getTask('item-1');
  assert.equal(task.assignedAgent, 'xiaok-po');
  const intervention = hub.getProjectIntervention('proj-contract-failure');
  assert.equal(intervention.primaryAction.strategy, 'repair_output_contract');
});

test('explicit worker runtime failure blocks for replacement confirmation', () => {
  const hub = createHub({ silent: true, getAgentProfiles: () => [
    { id: 'cli-qoder', roles: ['worker'], runtimeHealth: { state: 'degraded', outputCapabilities: ['markdown'], taskCapabilities: ['research'] } },
    { id: 'xiaok-worker', roles: ['worker'], runtimeHealth: { state: 'healthy', outputCapabilities: ['markdown'], taskCapabilities: ['research'] } },
  ] });
  hub.createProject({
    id: 'proj-explicit-replace',
    name: 'Explicit replace',
    goal: 'goal',
    poAgent: 'po',
    members: ['cli-qoder', 'xiaok-worker'],
    agentSelection: {
      poAgent: { agentId: 'po', source: 'system_migration' },
      members: [
        { agentId: 'cli-qoder', source: 'explicit_user' },
        { agentId: 'xiaok-worker', source: 'default_seed' },
      ],
    },
  });
  assert.equal(hub.handleCreateTasks('proj-explicit-replace', [
    { id: 'item-1', title: 'Research', brief: 'Do research', assignedAgent: 'cli-qoder', requiredOutputs: ['markdown'] },
  ], 'po').ok, true);
  assert.equal(hub.handleApprove('proj-explicit-replace').ok, true);

  const failed = hub.handleTaskFail('proj-explicit-replace', 'item-1', 'runtime_offline', 'offline');

  assert.equal(failed.ok, true);
  assert.equal(failed.replaced, false);
  assert.equal(failed.replacement?.action, 'needs_user_confirmation');
  const task = hub.getBoard('proj-explicit-replace').getTask('item-1');
  assert.equal(task.status, 'blocked');
  assert.equal(task.blockKind, 'agent_replacement_confirmation_required');
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

test('repeated model empty output replaces the retry task agent without adding another retry child', () => {
  const hub = createHub({ silent: true, getAgentProfiles: () => [
    { id: 'bad-worker', roles: ['worker'], runtimeHealth: { state: 'healthy', outputCapabilities: ['markdown'], taskCapabilities: ['research'] } },
    { id: 'xiaok-worker', roles: ['worker'], runtimeHealth: { state: 'healthy', outputCapabilities: ['markdown'], taskCapabilities: ['research'] } },
  ] });
  hub.createProject({
    id: 'proj-empty-replace',
    name: 'Repeated Empty',
    goal: 'goal',
    poAgent: 'po',
    members: ['bad-worker', 'xiaok-worker'],
    agentSelection: {
      poAgent: { agentId: 'po', source: 'system_migration' },
      members: [
        { agentId: 'bad-worker', source: 'default_seed' },
        { agentId: 'xiaok-worker', source: 'default_seed' },
      ],
    },
  });
  assert.equal(hub.handleCreateTasks('proj-empty-replace', [
    { id: 'item-1', title: 'Research', brief: 'Do research', assignedAgent: 'bad-worker', requiredOutputs: ['markdown'], requiredCapabilities: ['research'] },
  ], 'po').ok, true);
  assert.equal(hub.handleApprove('proj-empty-replace').ok, true);

  const first = hub.handleTaskFail('proj-empty-replace', 'item-1', 'model_empty_output', 'empty');
  assert.equal(first.ok, true);
  assert.equal(first.retried, true);
  const second = hub.handleTaskFail('proj-empty-replace', first.retryTaskId, 'model_empty_output', 'empty again');

  assert.equal(second.ok, true);
  assert.equal(second.replaced, true);
  assert.equal(second.retryTaskId, undefined);
  const tasks = hub.getBoard('proj-empty-replace').getAllTasks();
  assert.equal(tasks.length, 2);
  const retryTask = hub.getBoard('proj-empty-replace').getTask(first.retryTaskId);
  assert.equal(retryTask.status, 'dispatched');
  assert.equal(retryTask.assignedAgent, 'xiaok-worker');
  assert.equal(retryTask.replacementHistory.at(-1).fromAgentId, 'bad-worker');
});

test('retry child preserves parent dependencies for final render tasks', () => {
  const hub = createHub({ silent: true });
  hub.createProject({ id: 'proj-render-retry', name: 'Render Retry', goal: 'goal', poAgent: 'po', members: ['worker'] });
  assert.equal(hub.handleCreateTasks('proj-render-retry', [
    { id: 'draft', title: '第二轮分析修订与定稿', brief: 'draft', assignedAgent: 'worker', dependencies: [] },
    {
      id: 'final',
      title: '使用report renderer生成HTML报告',
      brief: '将第二轮分析定稿的Markdown内容转换为HTML',
      assignedAgent: 'worker',
      dependencies: ['draft'],
      requiredOutputs: [{ type: 'report_html', enforcement: 'hard' }],
    },
  ], 'po').ok, true);
  assert.equal(hub.handleApprove('proj-render-retry').ok, true);
  assert.deepEqual(hub.handleRequestDispatch('proj-render-retry', 'po').dispatched, ['proj-render-retry__draft']);

  const board = hub.getBoard('proj-render-retry');
  const draft = board.getTask('draft');
  assert.equal(hub.handleAcceptTask('proj-render-retry', draft.id, 'worker', draft.activeRunId).ok, true);
  assert.equal(hub.handleProgress('proj-render-retry', draft.id, 'started', 'worker', draft.activeRunId).ok, true);
  assert.equal(hub.handleSubmitResult('proj-render-retry', draft.id, { summary: 'draft completed with enough useful detail for downstream rendering.' }, 'worker', draft.activeRunId).ok, true);
  assert.equal(hub.handleQualityReview('proj-render-retry', draft.id, { passed: true, feedback: 'OK' }, 'po').ok, true);

  const dispatch = hub.handleRequestDispatch('proj-render-retry', 'po');
  assert.deepEqual(dispatch.dispatched, ['proj-render-retry__final']);
  const finalTask = board.getTask('final');
  const failed = hub.handleWorkerFailure('proj-render-retry', finalTask.id, 'worker', finalTask.activeRunId, 'model_empty_output', 'placeholder');
  assert.equal(failed.ok, true);

  const retry = board.getTask(failed.retryTaskId);
  assert.deepEqual(retry.dependencies, finalTask.dependencies);
  assert.deepEqual(retry.dependencyRefs, finalTask.dependencyRefs);
  assert.equal(retry.requiredOutputs[0].type, 'report_html');
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

test('historical failed retry child does not block project delivery after parent is done', () => {
  const hub = createHub({ silent: true });
  hub.createProject({ id: 'proj-deliver-history', name: 'Deliver', goal: 'goal', poAgent: 'po', members: ['worker'] });
  assert.equal(hub.handleCreateTasks('proj-deliver-history', [
    { id: 'item-1', title: 'Final report', assignedAgent: 'worker' },
    { id: 'item-1-retry-1', title: 'Final report retry', assignedAgent: 'worker', parentTaskId: 'item-1' },
  ], 'po').ok, true);
  assert.equal(hub.handleApprove('proj-deliver-history').ok, true);

  const board = hub.getBoard('proj-deliver-history');
  board.getTask('item-1').status = 'done';
  board.getTask('item-1-retry-1').status = 'failed';
  board.getTask('item-1-retry-1').failureReason = 'model_empty_output';

  assert.equal(board.isAllDone(), true);
  const delivered = hub.handleDeliver('proj-deliver-history', { synthesis: true }, 'po');
  assert.equal(delivered.ok, true);
  assert.equal(hub.getProject('proj-deliver-history').status, 'delivered');
});

test('failed root final task blocks project delivery', () => {
  const hub = createHub({ silent: true });
  hub.createProject({ id: 'proj-deliver-failed-root', name: 'Deliver', goal: 'goal', poAgent: 'po', members: ['worker'] });
  assert.equal(hub.handleCreateTasks('proj-deliver-failed-root', [
    { id: 'item-1', title: 'Research', assignedAgent: 'worker' },
    { id: 'item-2', title: '使用 report renderer 生成HTML报告', assignedAgent: 'worker', dependencies: ['item-1'] },
  ], 'po').ok, true);
  assert.equal(hub.handleApprove('proj-deliver-failed-root').ok, true);

  const board = hub.getBoard('proj-deliver-failed-root');
  board.getTask('item-1').status = 'done';
  board.getTask('item-2').status = 'failed';
  board.getTask('item-2').failureReason = 'artifact_type_mismatch';

  assert.equal(board.isAllDone(), false);
  const delivered = hub.handleDeliver('proj-deliver-failed-root', { synthesis: true }, 'po');
  assert.equal(delivered.ok, false);
  assert.equal(delivered.error, 'tasks_not_all_done');
  assert.equal(hub.getProject('proj-deliver-failed-root').status, 'active');
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

  const secondRunId = task.activeRunId;
  assert.equal(hub.handleAcceptTask('proj-quality', 'item-1', 'worker', secondRunId).ok, true);
  assert.equal(hub.handleProgress('proj-quality', 'item-1', 'started', 'worker', secondRunId).ok, true);
  assert.equal(hub.handleSubmitResult('proj-quality', 'item-1', {
    summary: 'concrete draft',
    artifactManifest: [{ filename: 'draft.md', path: 'artifacts/draft.md' }],
  }, 'worker', secondRunId).ok, true);

  assert.equal(task.status, 'submitted');
  assert.equal(task.reviewResult, null);
  assert.equal(hub.getProjectIntervention('proj-quality').primaryAction.strategy, 'notify_po_review');
});

test('quality review reports effective failure when evidence contract rejects a raw PO pass', () => {
  const hub = createHub({ silent: true });
  hub.createProject({ id: 'proj-quality-gate', name: 'Quality Gate', goal: 'goal', poAgent: 'po', members: ['worker'] });
  assert.equal(hub.handleCreateTasks('proj-quality-gate', [
    {
      id: 'item-1',
      title: '验证信息准确性与完整性',
      assignedAgent: 'worker',
      dependencies: [],
      evidenceContract: {
        kind: 'review_iteration_v1',
        requiredArtifacts: ['review-evidence.json'],
        requiredFields: ['verdict', 'findings'],
      },
    },
  ], 'po').ok, true);
  assert.equal(hub.handleApprove('proj-quality-gate').ok, true);
  const board = hub.getBoard('proj-quality-gate');
  const task = board.getTask('item-1');
  task.status = 'submitted';
  task.result = {
    summary: '完成信息准确性与完整性验证，核对了关键产品动态、发布日期、来源链接、竞品对照和后续报告可引用边界。',
    artifacts: [{ filename: 'review-evidence.json', relativePath: 'artifacts/review-evidence.json' }],
  };

  const review = hub.handleQualityReview('proj-quality-gate', 'item-1', {
    passed: true,
    feedback: 'Accepted by PO.',
  }, 'po');

  assert.equal(review.ok, true);
  assert.equal(review.effectivePassed, false);
  assert.equal(review.rework, true);
  assert.equal(task.status, 'dispatched');
  assert.match(task.failureReason, /missing required review evidence field: verdict/);
});

test('quality review accepts valid artifact-backed result even when runtime summary is low signal', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kswarm-short-summary-'));
  try {
    mkdirSync(join(dir, 'artifacts'), { recursive: true });
    writeFileSync(
      join(dir, 'artifacts', 'kingdee-report.html'),
      `<!doctype html><html><body><main data-template="kai-report-creator"><h1>金蝶本月产品分析报告</h1><p>${'报告正文内容 '.repeat(80)}</p></main></body></html>`,
      'utf8',
    );

    const hub = createHub({ silent: true });
    hub.createProject({ id: 'proj-short-summary', name: 'Quality Gate', goal: 'goal', poAgent: 'po', members: ['worker'] });
    assert.equal(hub.handleCreateTasks('proj-short-summary', [
      {
        id: 'item-1',
        title: '使用report renderer生成HTML报告',
        assignedAgent: 'worker',
        dependencies: [],
        evidenceContract: { kind: 'external_source_v1', required: true },
      },
    ], 'po').ok, true);
    assert.equal(hub.handleApprove('proj-short-summary').ok, true);
    assert.deepEqual(hub.handleRequestDispatch('proj-short-summary', 'po').dispatched, ['proj-short-summary__item-1']);

    const board = hub.getBoard('proj-short-summary');
    const runId = board.getTask('item-1').activeRunId;
    assert.equal(hub.handleAcceptTask('proj-short-summary', 'item-1', 'worker', runId).ok, true);
    assert.equal(hub.handleProgress('proj-short-summary', 'item-1', 'started', 'worker', runId).ok, true);
    assert.equal(hub.handleSubmitResult('proj-short-summary', 'item-1', {
      summary: '模型没有返回内容。',
      workFolder: dir,
      workspacePath: dir,
      artifacts: [{
        filename: 'kingdee-report.html',
        relativePath: 'artifacts/kingdee-report.html',
        mimeType: 'text/html',
      }],
    }, 'worker', runId).ok, true);

    const review = hub.handleQualityReview('proj-short-summary', 'item-1', {
      passed: true,
      feedback: 'HTML 报告内容完整，验收通过。',
    }, 'po');

    const task = board.getTask('item-1');
    assert.equal(review.ok, true);
    assert.equal(review.effectivePassed, true);
    assert.equal(task.status, 'done');
    assert.match(task.result.summary, /kingdee-report\.html/);
    assert.ok(task.result.summary.length >= 50);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
