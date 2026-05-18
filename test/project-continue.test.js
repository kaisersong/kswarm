/**
 * KSwarm — safe project continue tests
 *
 * Run: node test/project-continue.test.js
 */

import assert from 'node:assert/strict';
import { createHub } from '../src/core/hub.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function createTestHub(agents = healthyAgents()) {
  return createHub({ silent: true, getAgentProfiles: () => agents });
}

function healthyAgents() {
  return [
    { id: 'cli-codex', status: 'idle', runtimeHealth: { state: 'cooldown', cooldownUntil: Date.now() + 60_000 } },
    { id: 'cli-xiaok', status: 'idle', runtimeHealth: { state: 'healthy' } },
  ];
}

function offlineAgents() {
  return [
    { id: 'cli-codex', status: 'offline', runtimeHealth: { state: 'unhealthy' } },
  ];
}

function setupProject(hub, taskOverrides = {}) {
  const project = hub.createProject({
    id: 'proj-continue',
    name: 'P',
    goal: 'goal',
    poAgent: 'po',
    members: ['cli-codex', 'cli-xiaok'],
  });
  hub.handleCreateTasks(project.id, [
    { id: 'item-1', title: 'T', assignedAgent: 'cli-codex', maxAttempts: 1, ...taskOverrides },
    { id: 'item-2', title: 'Next', assignedAgent: 'cli-xiaok', dependencies: ['item-1'] },
  ], 'po');
  hub.handleApprove(project.id);
  return project;
}

function getTask(hub, localId = 'item-1') {
  return hub.getBoard('proj-continue').getTask(localId);
}

function failRootTask(hub, reason = 'agent_error', message = 'CLI failed') {
  const result = hub.handleTaskFail('proj-continue', 'item-1', reason, message);
  assert.equal(result.ok, true);
  return getTask(hub);
}

test('continue retries failed task with best healthy agent', () => {
  const hub = createTestHub();
  setupProject(hub);
  const failed = failRootTask(hub);

  const result = hub.handleContinueProject('proj-continue', {
    expectedPrimaryTaskId: failed.id,
    expectedTaskUpdatedAt: failed.updatedAt,
    idempotencyKey: 'continue-1',
  });

  const task = getTask(hub);
  assert.equal(result.ok, true);
  assert.equal(result.action, 'continue_project');
  assert.equal(result.strategy, 'retry_best_agent');
  assert.deepEqual(result.dispatched, [failed.id]);
  assert.equal(task.status, 'dispatched');
  assert.equal(task.assignedAgent, 'cli-xiaok');
});

test('stale expected task state returns task_state_changed without mutation', () => {
  const hub = createTestHub();
  setupProject(hub);
  const failed = failRootTask(hub);

  const result = hub.handleContinueProject('proj-continue', {
    expectedPrimaryTaskId: failed.id,
    expectedTaskUpdatedAt: failed.updatedAt - 1,
    idempotencyKey: 'continue-stale',
  });

  const task = getTask(hub);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'task_state_changed');
  assert.equal(result.status, 409);
  assert.equal(task.status, 'failed');
  assert.equal(task.assignedAgent, 'cli-codex');
});

test('repeated idempotency key does not double-dispatch', () => {
  const hub = createTestHub();
  setupProject(hub);
  const failed = failRootTask(hub);

  const first = hub.handleContinueProject('proj-continue', {
    expectedPrimaryTaskId: failed.id,
    expectedTaskUpdatedAt: failed.updatedAt,
    idempotencyKey: 'continue-repeat',
  });
  const runId = getTask(hub).activeRunId;
  const second = hub.handleContinueProject('proj-continue', {
    expectedPrimaryTaskId: failed.id,
    expectedTaskUpdatedAt: failed.updatedAt,
    idempotencyKey: 'continue-repeat',
  });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.idempotent, true);
  assert.deepEqual(second.dispatched, first.dispatched);
  assert.equal(getTask(hub).activeRunId, runId);
});

test('quality feedback stores repair instruction before retry', () => {
  const hub = createTestHub();
  setupProject(hub);
  const failed = failRootTask(hub, 'quality_content_failed', '质量不达标');
  failed.qualityFailureCount = 1;
  failed.qualityReviewHistory.push({ passed: false, feedback: '补充数据来源和关键假设', reviewedAt: Date.now() });

  const result = hub.handleContinueProject('proj-continue', {
    expectedPrimaryTaskId: failed.id,
    expectedTaskUpdatedAt: failed.updatedAt,
    idempotencyKey: 'continue-quality',
  });

  const task = getTask(hub);
  assert.equal(result.ok, true);
  assert.equal(result.strategy, 'retry_with_repair_instruction');
  assert.match(task.repairInstruction, /补充数据来源和关键假设/);
  assert.equal(task.status, 'dispatched');
});

test('durable artifact recovery uses recovered submission', () => {
  const hub = createTestHub();
  setupProject(hub);
  const failed = failRootTask(hub, 'run_interrupted', 'interrupted after writing artifact');
  failed.lastRunLease = {
    runId: 'run-artifact',
    assignedAgent: 'cli-codex',
    artifactManifest: [{ filename: 'report.md', path: '/tmp/report.md' }],
  };

  const result = hub.handleContinueProject('proj-continue', {
    expectedPrimaryTaskId: failed.id,
    expectedTaskUpdatedAt: failed.updatedAt,
    idempotencyKey: 'continue-artifact',
  });

  const task = getTask(hub);
  assert.equal(result.ok, true);
  assert.equal(result.strategy, 'recover_submission');
  assert.equal(task.status, 'submitted');
  assert.equal(task.result.artifactManifest[0].filename, 'report.md');
});

test('durable artifact recovery uses task result artifacts when lease manifest is empty', () => {
  const hub = createTestHub();
  setupProject(hub);
  const failed = failRootTask(hub, 'agent_error', 'quality review rejected but artifacts were captured');
  failed.lastRunLease = {
    runId: 'run-empty-manifest',
    assignedAgent: 'cli-codex',
    artifactManifest: [],
  };
  failed.result = {
    summary: 'partial report with attached data file',
    artifacts: [{ filename: 'data_sources_assumptions.json', path: '/tmp/data_sources_assumptions.json' }],
  };

  const intervention = hub.getProjectIntervention('proj-continue');
  assert.equal(intervention.primaryAction.strategy, 'recover_submission');

  const result = hub.handleContinueProject('proj-continue', {
    expectedPrimaryTaskId: failed.id,
    expectedTaskUpdatedAt: failed.updatedAt,
    idempotencyKey: 'continue-result-artifacts',
  });

  const task = getTask(hub);
  assert.equal(result.ok, true);
  assert.equal(result.strategy, 'recover_submission');
  assert.equal(result.error, undefined);
  assert.equal(task.status, 'submitted');
  assert.equal(task.result.artifacts[0].filename, 'data_sources_assumptions.json');
});

test('continue retries rejected recovered artifact instead of resubmitting it', () => {
  const hub = createTestHub();
  setupProject(hub);
  const failed = failRootTask(hub, 'quality_content_failed', '旧产物不合格');
  const feedback = '补全主要贸易伙伴、人民币汇率、政策变动清单、热点事件列表';
  failed.result = {
    summary: 'Rejected recovered artifact',
    artifacts: [{ filename: 'data_sources_assumptions.json', path: '/tmp/data_sources_assumptions.json' }],
  };
  failed.recoveryStatus = 'recovered';
  failed.recoveredAt = Date.now() - 1_000;
  failed.reviewResult = { passed: false, feedback, reviewedAt: Date.now() };
  failed.qualityReviewHistory.push(failed.reviewResult);
  failed.qualityFailureCount = 2;
  const blocked = hub.getBoard('proj-continue').blockTask(failed.id, {
    blockKind: 'executor_quality_blocked',
    blockedReason: feedback,
    failureClass: 'quality_content_failed',
    qualityFailureCount: 2,
  });
  assert.equal(blocked.ok, true);
  const blockedTask = getTask(hub);

  const result = hub.handleContinueProject('proj-continue', {
    expectedPrimaryTaskId: blockedTask.id,
    expectedTaskUpdatedAt: blockedTask.updatedAt,
    idempotencyKey: 'continue-rejected-recovered-artifact',
  });

  const task = getTask(hub);
  assert.equal(result.ok, true);
  assert.equal(result.strategy, 'retry_with_repair_instruction');
  assert.deepEqual(result.dispatched, [task.id]);
  assert.equal(task.status, 'dispatched');
  assert.notEqual(task.status, 'submitted');
  assert.match(task.repairInstruction, /人民币汇率/);
});

test('unsafe state returns needs conversation and does not mutate', () => {
  const hub = createTestHub(offlineAgents());
  setupProject(hub);
  const failed = failRootTask(hub);

  const result = hub.handleContinueProject('proj-continue', {
    expectedPrimaryTaskId: failed.id,
    expectedTaskUpdatedAt: failed.updatedAt,
    idempotencyKey: 'continue-unsafe',
  });

  const task = getTask(hub);
  assert.equal(result.ok, false);
  assert.equal(result.strategy, 'needs_conversation');
  assert.equal(result.xiaokContext.projectId, 'proj-continue');
  assert.match(result.xiaokContext.summary, /后续 1 个任务/);
  assert.match(result.xiaokContext.lastFailure, /失败|CLI failed|agent_error/);
  assert.equal(task.status, 'failed');
  assert.equal(task.assignedAgent, 'cli-codex');
});

test('automatic continue never marks failed task done without a result', () => {
  const hub = createTestHub();
  setupProject(hub);
  const failed = failRootTask(hub);

  hub.handleContinueProject('proj-continue', {
    expectedPrimaryTaskId: failed.id,
    expectedTaskUpdatedAt: failed.updatedAt,
    idempotencyKey: 'continue-no-done',
  });

  const task = getTask(hub);
  assert.notEqual(task.status, 'done');
  assert.equal(task.result, null);
});

test('automatic continue never cancels required downstream tasks', () => {
  const hub = createTestHub();
  setupProject(hub);
  const failed = failRootTask(hub);

  hub.handleContinueProject('proj-continue', {
    expectedPrimaryTaskId: failed.id,
    expectedTaskUpdatedAt: failed.updatedAt,
    idempotencyKey: 'continue-no-cancel',
  });

  const downstream = hub.getBoard('proj-continue').getTask('item-2');
  assert.equal(downstream.status, 'pending');
});

test('recovery budget prevents repeating the same failed strategy', () => {
  const hub = createTestHub();
  setupProject(hub);
  const failed = failRootTask(hub);

  const first = hub.handleContinueProject('proj-continue', {
    expectedPrimaryTaskId: failed.id,
    expectedTaskUpdatedAt: failed.updatedAt,
    idempotencyKey: 'continue-budget-1',
  });
  assert.equal(first.ok, true);

  const task = getTask(hub);
  const failedAgain = hub.getBoard('proj-continue').transition(task.id, 'failed', { failureReason: 'agent_error' });
  assert.equal(failedAgain.ok, true);
  const afterFailure = getTask(hub);

  const second = hub.handleContinueProject('proj-continue', {
    expectedPrimaryTaskId: afterFailure.id,
    expectedTaskUpdatedAt: afterFailure.updatedAt,
    idempotencyKey: 'continue-budget-2',
  });

  assert.equal(second.ok, false);
  assert.equal(second.error, 'recovery_budget_exceeded');
  assert.equal(second.strategy, 'needs_conversation');
  assert.equal(getTask(hub).status, 'failed');
});

test('budget exceeded returns explicit needs_user_action next action without mutating project', () => {
  const hub = createTestHub();
  setupProject(hub);
  const failed = failRootTask(hub, 'quality_content_failed', '质量不达标');
  failed.qualityFailureCount = 1;
  failed.qualityReviewHistory.push({ passed: false, feedback: '补充数据来源和关键假设', reviewedAt: Date.now() });
  failed.continueRecoveryHistory = [
    { strategy: 'retry_with_repair_instruction', result: 'started', at: Date.now() - 1_000 },
  ];

  const result = hub.handleContinueProject('proj-continue', {
    expectedPrimaryTaskId: failed.id,
    expectedTaskUpdatedAt: failed.updatedAt,
    idempotencyKey: 'continue-budget-next-action',
  });

  const task = getTask(hub);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'recovery_budget_exceeded');
  assert.equal(result.outcome, 'needs_user_action');
  assert.equal(result.projectChanged, false);
  assert.equal(result.humanActionRequired, true);
  assert.equal(result.nextActions[0].id, 'repair_and_submit');
  assert.equal(result.nextActions[0].toolName, 'repair_project_task');
  assert.equal(result.nextActions[0].params.projectId, 'proj-continue');
  assert.equal(result.nextActions[0].params.expectedPrimaryTaskId, failed.id);
  assert.equal(result.nextActions[0].params.expectedTaskUpdatedAt, failed.updatedAt);
  assert.equal(task.status, 'failed');
});

test('successful retry outcome is advanced and projectChanged', () => {
  const hub = createTestHub();
  setupProject(hub);
  const failed = failRootTask(hub);

  const result = hub.handleContinueProject('proj-continue', {
    expectedPrimaryTaskId: failed.id,
    expectedTaskUpdatedAt: failed.updatedAt,
    idempotencyKey: 'continue-advanced-outcome',
  });

  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'advanced');
  assert.equal(result.projectChanged, true);
  assert.equal(result.humanActionRequired, false);
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
  console.log(`\n${passed}/${tests.length} project continue tests passed`);
}
