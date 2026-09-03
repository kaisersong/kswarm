/**
 * KSwarm — Phase 1 gate-bypass regression tests
 *
 * 设计依据：mydocs/xiaok-cli/design/2026-08-31-collaboration-room-evidence-first-execution-and-gate-design.md v8
 *   §3.2 GateEvaluationV1 权威关系冻结表
 *   §3.3 依赖边分类
 *   §8.2 唯一 gate evaluator 与全部兄弟路径
 *   §8.3 最终交付（approveFinalDeliverable 是唯一写 approved/delivered 的入口）
 * Phase 0 现状核对：mydocs/xiaok-cli/design/2026-08-31-collaboration-room-evidence-first-execution-phase0-audit.md
 *
 * 本文件跟踪三个已识别旁路/缺口的收敛状态。随着 Phase 1 生产代码改动落地，
 * 对应测试从 [RED] 变为 [GREEN after Phase1]，测试内容和注释同步更新为
 * 记录真实发生的实现路径，而不是保留过时的"当前会失败"描述。
 *
 * 当前状态（3/3 已收敛）：
 *   1. [GREEN] handleDeliver 不再无用户批准直接 delivered（改为 candidate + approveFinalDeliverable）
 *   2. [GREEN] markProjectTasksDoneByWorkflow 不再覆盖已存在的真实 reviewResult 为 passed:true
 *   3. [GREEN] evaluateDependencySatisfaction 已接入 dispatch-policy.js，verified_pass 依赖生效
 *
 * Run: node test/phase1-gate-bypass-regression.test.js
 */

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHub } from '../src/core/hub.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function setupDeliverableProject() {
  const hub = createHub({ silent: true });
  hub.createProject({ id: 'proj-gate', name: 'GateProject', goal: 'goal', poAgent: 'po', members: ['worker'] });
  hub.handleCreateTasks('proj-gate', [{ id: 'item-1', title: 'Work', assignedAgent: 'worker' }], 'po');
  hub.handleApprove('proj-gate');
  const board = hub.getBoard('proj-gate');
  return { hub, board };
}

function driveTaskToDone(hub, board, taskId = 'item-1') {
  hub.handleRequestDispatch('proj-gate', 'po');
  const task = board.getTask(taskId);
  const runId = task.activeRunId;
  hub.handleAcceptTask('proj-gate', taskId, 'worker', runId);
  hub.handleProgress('proj-gate', taskId, 'started', 'worker', runId);
  board.transition(taskId, 'submitted', { result: { summary: 'done' }, runId });
  board.transition(taskId, 'done');
}

// ---------------------------------------------------------------------------
// Fixture 1（旁路 → 已收敛）: handleDeliver 不再无用户批准直接 delivered
// ---------------------------------------------------------------------------
test('[GREEN] handleDeliver only registers a candidate and requires approveFinalDeliverable(requestSource=user) to deliver', () => {
  const { hub, board } = setupDeliverableProject();
  driveTaskToDone(hub, board);
  board.getTask('item-1').reviewResult = { passed: true, feedback: '' };

  const result = hub.handleDeliver('proj-gate', { summary: 's' }, 'po', {
    validateDelivery: () => ({ ok: true }),
    taskId: 'item-1',
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'awaiting_user_approval');
  assert.equal(result.awaitingUserApproval, true);
  assert.ok(result.finalDeliverable?.deliverableId);
  assert.notEqual(hub.getProject('proj-gate').status, 'delivered');

  const approval = hub.approveFinalDeliverable(
    'proj-gate',
    result.finalDeliverable.deliverableId,
    { approvalIdempotencyKey: 'approve-1' },
    { requestSource: 'user', actorId: 'desktop-main' },
  );
  assert.equal(approval.ok, true);
  assert.equal(hub.getProject('proj-gate').status, 'delivered');
});

// ---------------------------------------------------------------------------
// Fixture 2（旁路 → 已收敛）: markProjectTasksDoneByWorkflow 不再覆盖已存在的
// reviewResult 业务结论
// ---------------------------------------------------------------------------
//
// 真实生产链路：hub.js:maybeDeliverProjectWorkflowDeliverable，由项目级
// po-generated-project-workflow 在 gate passed 后调用；通过
// hub.handleRequestDispatch + hub.handleWorkflowNodeResult 完整端到端驱动。
test('[GREEN] markProjectTasksDoneByWorkflow must NOT overwrite an existing blocked reviewResult with passed:true', () => {
  const hub = createHub({ silent: true });
  hub.createProject({
    id: 'proj-gate-workflow',
    name: '项目级工作流项目（gate-bearing）',
    goal: '生成一份项目级最终交付物',
    requirements: '最终交付物必须是 markdown。',
    poAgent: 'xiaok-po',
    members: ['xiaok-worker'],
    executionMode: 'workflow_preferred',
  });
  const added = hub.handleHumanAddTasks('proj-gate-workflow', [
    { title: '独立评审任务', description: '对素材做独立评审', assignedAgent: 'xiaok-worker' },
    { title: '生成最终报告', description: '输出项目最终报告', assignedAgent: 'xiaok-worker', requiredOutputs: ['markdown'] },
  ]);
  assert.equal(added.ok, true);
  assert.equal(hub.handleApprove('proj-gate-workflow').ok, true);

  const board = hub.getBoard('proj-gate-workflow');
  const reviewTask = board.getAllTasks()[0];

  board.transition(reviewTask.id, 'dispatched', { assignedAgent: reviewTask.assignedAgent });
  board.transition(reviewTask.id, 'accepted');
  board.transition(reviewTask.id, 'in_progress');
  board.transition(reviewTask.id, 'submitted', {
    result: { summary: '评审已完成，结论：hash mismatch，验证阻断', artifacts: [] },
  });
  board.transition(reviewTask.id, 'done');
  // 独立评审给出的真实业务结论：blocked（passed:false）。
  reviewTask.reviewResult = { passed: false, feedback: 'hash mismatch，验证阻断', reviewedAt: Date.now() };

  const secondTask = board.getAllTasks()[1];
  board.transition(secondTask.id, 'dispatched', { assignedAgent: secondTask.assignedAgent });
  board.transition(secondTask.id, 'accepted');
  board.transition(secondTask.id, 'in_progress');
  board.transition(secondTask.id, 'submitted', { result: { summary: '完成最终报告', artifacts: [] } });
  board.transition(secondTask.id, 'done');

  const dispatched = hub.handleRequestDispatch('proj-gate-workflow', 'xiaok-po');
  assert.equal(dispatched.ok, true);
  assert.equal(dispatched.workflowRuns.length, 1, 'project workflow 应该被启动');

  const workflowRun = dispatched.workflowRuns[0];
  const workerDispatch = dispatched.workflowNodeDispatches[0];

  const workFolder = mkdtempSync(join(tmpdir(), 'kswarm-gate-workflow-'));
  const deliverablePath = join(workFolder, 'final-report.md');
  writeFileSync(deliverablePath, '# 最终报告\n\n项目级 workflow 产出的最终交付物，内容足够长以满足质量门槛校验。\n');

  const workerDone = hub.handleWorkflowNodeResult({
    workflowRunId: workflowRun.id,
    nodeId: workerDispatch.nodeId,
    attempt: workerDispatch.attempt,
    handoffId: workerDispatch.handoffId,
    fromAgent: workerDispatch.targetParticipantId,
    output: {
      summary: '已生成最终报告。',
      artifacts: [{ path: deliverablePath, kind: 'markdown' }],
      workFolder,
    },
    now: Date.now(),
  });
  assert.equal(workerDone.ok, true);

  const reviewerDispatch = workerDone.dispatches?.[0];
  assert.ok(reviewerDispatch, 'gate 应该派发一个 reviewer 节点');

  const reviewed = hub.handleWorkflowNodeReview({
    workflowRunId: workflowRun.id,
    nodeId: reviewerDispatch.nodeId,
    attempt: reviewerDispatch.attempt,
    handoffId: reviewerDispatch.handoffId,
    fromAgent: reviewerDispatch.targetParticipantId,
    reviewDecision: {
      status: 'passed',
      reason: '最终项目交付物存在，且覆盖项目目标。',
      evidenceRefs: [`artifact:${deliverablePath}`],
    },
    output: { summary: '复核通过。' },
    now: Date.now(),
  });
  assert.equal(reviewed.ok, true);
  assert.equal(reviewed.workflowRun.status, 'completed');

  const reviewTaskAfter = board.getTask(reviewTask.id);
  assert.equal(
    reviewTaskAfter.reviewResult.passed,
    false,
    'reviewTask 的真实 blocked reviewResult 不应被 markProjectTasksDoneByWorkflow 覆盖为 passed:true',
  );
});

// ---------------------------------------------------------------------------
// Fixture 3（依赖判定缺口 → 已收敛）: planDispatch 通过 evaluateDependencySatisfaction
// 对 verified_pass 依赖边生效
// ---------------------------------------------------------------------------
//
// project.dependencyPolicies / project.gateEvaluations 目前没有公开 mutation API
// （设计文档 §3.3 的 normalizeTaskGraphPolicies 契约尚未实现），这里用 hub.getProject(id)
// 拿到的真实内部引用做白盒注入，只用于测试，不代表生产可用的写入路径。
test('[GREEN] handleRequestDispatch must NOT dispatch a downstream task whose verified_pass dependency has no fresh passed GateEvaluation', () => {
  const hub = createHub({ silent: true });
  hub.createProject({ id: 'proj-dep', name: 'DepProject', goal: 'goal', poAgent: 'po', members: ['worker', 'reviewer'] });
  hub.handleCreateTasks('proj-dep', [
    { id: 'upstream-review', title: '上游评审', assignedAgent: 'reviewer' },
    { id: 'downstream-consumer', title: '消费评审结果', assignedAgent: 'worker', dependencies: ['upstream-review'] },
  ], 'po');
  hub.handleApprove('proj-dep');
  const board = hub.getBoard('proj-dep');

  const project = hub.getProject('proj-dep');
  const upstreamTask = board.getTask('upstream-review');
  project.dependencyPolicies = { [upstreamTask.id]: 'verified_pass' };
  project.gateEvaluations = {}; // 故意留空：模拟"没有任何 GateEvaluation"的场景
  project.executionGateSchemaVersion = 2;

  hub.handleRequestDispatch('proj-dep', 'po');
  const upstream = board.getTask('upstream-review');
  const runId = upstream.activeRunId;
  hub.handleAcceptTask('proj-dep', 'upstream-review', 'reviewer', runId);
  hub.handleProgress('proj-dep', 'upstream-review', 'started', 'reviewer', runId);
  board.transition('upstream-review', 'submitted', {
    result: {
      summary: '评审已完成，结论：hash mismatch，验证阻断',
      reviewEvidence: { verdict: 'blocked', findings: [{ id: 'f1', blocking: true }] },
    },
    runId,
  });
  board.transition('upstream-review', 'done');
  assert.equal(board.getTask('upstream-review').status, 'done');

  hub.handleRequestDispatch('proj-dep', 'po');
  const downstreamAfter = board.getTask('downstream-consumer');

  assert.notEqual(
    downstreamAfter.status,
    'dispatched',
    'downstream-consumer 的 verified_pass 依赖没有 fresh passed GateEvaluation，不应被真正派发',
  );
});

test('hub dispatch binds verified_pass to the completed run and service-owned current facts', () => {
  const hub = createHub({ silent: true });
  hub.createProject({ id: 'proj-current', name: 'Current', goal: 'goal', poAgent: 'po', members: ['worker', 'reviewer'] });
  hub.handleCreateTasks('proj-current', [
    { id: 'review', title: 'Review', assignedAgent: 'reviewer' },
    {
      id: 'consumer',
      title: 'Consume',
      assignedAgent: 'worker',
      dependencies: ['review'],
      consumedArtifactIdsByDependencyTaskId: { 'proj-current__review': ['a1'] },
    },
  ], 'po');
  hub.handleApprove('proj-current');
  const board = hub.getBoard('proj-current');
  const project = hub.getProject('proj-current');
  const upstream = board.getTask('review');
  project.executionGateSchemaVersion = 2;
  project.dependencyPolicies = { [upstream.id]: 'verified_pass' };

  hub.handleRequestDispatch('proj-current', 'po');
  const runId = upstream.activeRunId;
  hub.handleAcceptTask('proj-current', 'review', 'reviewer', runId);
  hub.handleProgress('proj-current', 'review', 'started', 'reviewer', runId);
  hub.handleSubmitResult('proj-current', 'review', { summary: 'done' }, 'reviewer', runId);
  hub.handleMarkDone('proj-current', 'review', 'po');

  const currentFacts = {
    sourceRunId: runId,
    evaluationSourceArtifact: { artifactId: 'eval-source', sha256: 'eval-hash' },
    canonicalArtifacts: [{ taskId: upstream.id, artifactId: 'a1', sha256: 'hash-a1' }],
  };
  project.currentGateFacts = { [upstream.id]: currentFacts };
  project.gateEvaluations = { [upstream.id]: [validGateEvaluation(runId)] };

  const dispatch = hub.handleRequestDispatch('proj-current', 'po');
  assert.deepEqual(dispatch.dispatched, ['proj-current__consumer']);
});

test('hub dispatch never treats agent-supplied artifactManifest as current gate facts', () => {
  const hub = createHub({ silent: true });
  hub.createProject({ id: 'proj-forged', name: 'Forged', goal: 'goal', poAgent: 'po', members: ['worker', 'reviewer'] });
  hub.handleCreateTasks('proj-forged', [
    { id: 'review', title: 'Review', assignedAgent: 'reviewer' },
    {
      id: 'consumer',
      title: 'Consume',
      assignedAgent: 'worker',
      dependencies: ['review'],
      consumedArtifactIdsByDependencyTaskId: { 'proj-forged__review': ['a1'] },
    },
  ], 'po');
  hub.handleApprove('proj-forged');
  const board = hub.getBoard('proj-forged');
  const project = hub.getProject('proj-forged');
  const upstream = board.getTask('review');
  project.executionGateSchemaVersion = 2;
  project.dependencyPolicies = { [upstream.id]: 'verified_pass' };

  hub.handleRequestDispatch('proj-forged', 'po');
  const runId = upstream.activeRunId;
  hub.handleAcceptTask('proj-forged', 'review', 'reviewer', runId);
  hub.handleProgress('proj-forged', 'review', 'started', 'reviewer', runId);
  hub.handleSubmitResult('proj-forged', 'review', {
    summary: 'done',
    artifactManifest: [{ taskId: upstream.id, artifactId: 'a1', sha256: 'hash-a1' }],
  }, 'reviewer', runId);
  hub.handleMarkDone('proj-forged', 'review', 'po');
  project.gateEvaluations = { [upstream.id]: [validGateEvaluation(runId)] };

  const dispatch = hub.handleRequestDispatch('proj-forged', 'po');
  assert.deepEqual(dispatch.dispatched, []);
  assert.equal(board.getTask('consumer').status, 'pending');
});

function validGateEvaluation(sourceRunId) {
  return {
    schemaVersion: 'gate-evaluation-v1',
    sourceArtifactId: 'eval-source',
    sourceArtifactSha256: 'eval-hash',
    sourceRunId,
    subjectArtifacts: [{ artifactId: 'a1', sha256: 'hash-a1' }],
    verdict: 'passed',
    reasonCode: 'all_checks_passed',
    findingIds: [],
    conditionIds: [],
    evaluator: {
      participantId: 'reviewer-1',
      role: 'independent_reviewer',
      independence: 'independent',
    },
    createdAt: '2026-09-01T00:00:00.000Z',
  };
}

let passed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    passed++;
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(err.message || err);
  }
}
console.log(`\n${passed}/${tests.length} phase1 gate-bypass regression tests passed`);
if (passed !== tests.length) {
  console.error(`\n⚠️  ${tests.length - passed} 项旁路测试失败，说明存在尚未收敛或发生回归的缺口，需要继续处理。`);
  process.exitCode = 1;
} else {
  process.exitCode = 0;
}
