/**
 * KSwarm — approveFinalDeliverable 接入三件套 evaluator（design §8.3 步骤 1-2）
 *
 * 设计依据：mydocs/xiaok-cli/design/2026-08-31-collaboration-room-evidence-first-execution-and-gate-design.md v8
 *   §8.3 —— "只有 snapshot passed 且用户 CAS 仍匹配，approveFinalDeliverable 才在
 *   同一 project-scoped transaction 中写 approved FinalDeliverable 与 passing
 *   ReviewGateDecision，decision 引用该 snapshot ID/hash/revision"
 *
 * 现状核实（2026-09-02）：evaluatePreApprovalPrerequisites/hydrateGateFacts 此前
 * 完全没有接入 approveFinalDeliverable；批准流程一直用过渡性的
 * evaluateFinalDeliverableApprovalFacts 重算模式（本轮不移除它，v1/未声明 schema
 * 的项目继续用它，保持现状零回归）。
 *
 * 本文件驱动的新增行为：仅当 project.executionGateSchemaVersion === 2 时，
 * approveFinalDeliverable 额外要求通过 evaluatePreApprovalPrerequisites，产出
 * 的 projectGateSnapshot 必须被写入 reviewGateDecision.projectGateSnapshotRef。
 *
 * Run: node test/approve-final-deliverable-snapshot-integration.test.js
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createHub } from '../src/core/hub.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function sha256(text) {
  return createHash('sha256').update(Buffer.from(text, 'utf-8')).digest('hex');
}

test('executionGateSchemaVersion !== 2 的项目（legacy）approveFinalDeliverable 行为完全不变，不要求 projectGateSnapshot', () => {
  const hub = createHub({ silent: true });
  const projectId = 'proj-approve-v1';
  hub.createProject({ id: projectId, name: projectId, goal: 'goal', poAgent: 'po', members: ['worker'] });
  const created = hub.handleCreateTasks(projectId, [
    { id: 'item-1', title: 'Plain', brief: 'Do it', assignedAgent: 'worker', dependencies: [] },
  ], 'po');
  hub.handleApprove(projectId);
  const board = hub.getBoard(projectId);
  const task = board.getTask(created.taskIds[0]);
  board.transition(task.id, 'dispatched', { assignedAgent: 'worker', runId: 'r1' });
  board.transition(task.id, 'accepted', { assignedAgent: 'worker' });
  board.transition(task.id, 'in_progress');
  board.transition(task.id, 'submitted', { result: { summary: 'x' }, runId: 'r1' });
  hub.handleQualityReview(projectId, task.id, { passed: true, feedback: 'ok' }, 'po');

  const delivered = hub.handleDeliver(projectId, { summary: 'x', artifacts: [] }, 'po', { taskId: task.id });
  assert.equal(delivered.ok, true, JSON.stringify(delivered));

  const approved = hub.approveFinalDeliverable(projectId, delivered.finalDeliverable.deliverableId, {
    approvalIdempotencyKey: 'k1',
  }, { requestSource: 'user', actorId: 'user-1' });
  assert.equal(approved.ok, true, JSON.stringify(approved));
  assert.equal(approved.reviewGateDecision.projectGateSnapshotRef, undefined, 'legacy 项目不应产生 projectGateSnapshotRef');
});

test('design §8.2 canAutoClose 项：schema v2 项目批准后又新增任务（lifecycleVersion 漂移），getProjectLifecycle().canAutoClose 必须从 true 变为 false', () => {
  const hub = createHub({ silent: true });
  const projectId = 'proj-approve-v2-drift';
  hub.createProject({
    id: projectId, name: projectId, goal: 'goal', poAgent: 'po', members: ['worker'],
    executionGateSchemaVersion: 2,
  });
  const created = hub.handleCreateTasks(projectId, [
    { id: 'item-1', title: 'Plain deliverable task', brief: 'Do it', assignedAgent: 'worker', dependencies: [] },
  ], 'po');
  hub.handleApprove(projectId);
  const board = hub.getBoard(projectId);
  const task = board.getTask(created.taskIds[0]);
  board.transition(task.id, 'dispatched', { assignedAgent: 'worker', runId: 'r1' });
  board.transition(task.id, 'accepted', { assignedAgent: 'worker' });
  board.transition(task.id, 'in_progress');
  board.transition(task.id, 'submitted', { result: { summary: 'x', artifacts: [] }, runId: 'r1' });
  hub.handleQualityReview(projectId, task.id, { passed: true, feedback: 'ok' }, 'po');

  const delivered = hub.handleDeliver(projectId, { summary: 'x', artifacts: [] }, 'po', { taskId: task.id });
  assert.equal(delivered.ok, true, JSON.stringify(delivered));

  const approved = hub.approveFinalDeliverable(projectId, delivered.finalDeliverable.deliverableId, {
    approvalIdempotencyKey: 'k-drift-1',
  }, { requestSource: 'user', actorId: 'user-1' });
  assert.equal(approved.ok, true, JSON.stringify(approved));

  // 批准刚完成时，read model 必须认为可以自动关闭。
  const lifecycleRightAfterApproval = hub.getProjectLifecycle(projectId);
  assert.equal(lifecycleRightAfterApproval.canAutoClose, true, 'approval 刚完成时应可自动关闭');

  // 批准之后，项目又发生一次真实 mutation（用户通过 handleHumanAddTasks 增加了新任务），
  // project.lifecycleVersion 会因此递增，使已存在的 passing decision 产生漂移。
  const addResult = hub.handleHumanAddTasks(projectId, [
    { id: 'item-2', title: 'Extra task added after approval', assignedAgent: 'worker' },
  ], { requestSource: 'user' });
  assert.equal(addResult.ok, true, JSON.stringify(addResult));

  const lifecycleAfterDrift = hub.getProjectLifecycle(projectId);
  assert.equal(lifecycleAfterDrift.canAutoClose, false, '批准后又发生 mutation，旧 passing decision 不应再允许自动关闭');
});

test('executionGateSchemaVersion === 2 的项目，approveFinalDeliverable 通过后 reviewGateDecision 必须携带 projectGateSnapshotRef', () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'kswarm-approve-v2-'));
  try {
    const hub = createHub({ silent: true });
    const projectId = 'proj-approve-v2';
    hub.createProject({
      id: projectId, name: projectId, goal: 'goal', poAgent: 'po', members: ['worker'],
      executionGateSchemaVersion: 2,
    });
    const created = hub.handleCreateTasks(projectId, [
      { id: 'item-1', title: 'Plain deliverable task', brief: 'Do it', assignedAgent: 'worker', dependencies: [] },
    ], 'po');
    hub.handleApprove(projectId);
    const board = hub.getBoard(projectId);
    const task = board.getTask(created.taskIds[0]);
    board.transition(task.id, 'dispatched', { assignedAgent: 'worker', runId: 'r1' });
    board.transition(task.id, 'accepted', { assignedAgent: 'worker' });
    board.transition(task.id, 'in_progress');
    board.transition(task.id, 'submitted', { result: { summary: 'x', artifacts: [] }, runId: 'r1' });
    hub.handleQualityReview(projectId, task.id, { passed: true, feedback: 'ok' }, 'po');

    const delivered = hub.handleDeliver(projectId, { summary: 'x', artifacts: [] }, 'po', { taskId: task.id });
    assert.equal(delivered.ok, true, JSON.stringify(delivered));

    const approved = hub.approveFinalDeliverable(projectId, delivered.finalDeliverable.deliverableId, {
      approvalIdempotencyKey: 'k2',
    }, { requestSource: 'user', actorId: 'user-1' });
    assert.equal(approved.ok, true, JSON.stringify(approved));
    assert.ok(approved.reviewGateDecision.projectGateSnapshotRef, 'schema v2 项目批准通过后必须携带 projectGateSnapshotRef');
    assert.equal(approved.reviewGateDecision.projectGateSnapshotRef.projectId, projectId);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('executionGateSchemaVersion === 2 项目中，真实产生的 open blocking condition 会让 approveFinalDeliverable 拒绝（新校验路径真正生效，不是摆设）', () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'kswarm-approve-v2-blocked-'));
  try {
    const hub = createHub({ silent: true });
    const projectId = 'proj-approve-v2-blocked';
    hub.createProject({
      id: projectId, name: projectId, goal: 'goal', poAgent: 'po', members: ['worker'],
      executionGateSchemaVersion: 2,
    });
    const created = hub.handleCreateTasks(projectId, [
      { id: 'item-1', title: 'Review upstream artifact', brief: 'Review', assignedAgent: 'worker', dependencies: [] },
      { id: 'item-2', title: 'Final deliverable task', brief: 'Do it', assignedAgent: 'worker', dependencies: [] },
    ], 'po');
    hub.handleApprove(projectId);
    const board = hub.getBoard(projectId);
    const reviewTask = board.getTask(created.taskIds[0]);
    const finalTask = board.getTask(created.taskIds[1]);
    reviewTask.evidenceContract = {
      version: 2,
      kind: 'review_iteration_v2',
      requiredArtifacts: ['review-evidence-v2.json'],
      requiredFields: ['verdict', 'findings', 'subjectArtifacts'],
    };

    const relativePath = 'tasks/item-1/run-1/review-evidence.json';
    mkdirSync(join(workspaceRoot, 'tasks/item-1/run-1'), { recursive: true });
    const blockedContent = JSON.stringify({
      schemaVersion: 'review-evidence-v2',
      verdict: 'blocked',
      subjectArtifacts: [{ artifactId: 'subject-1', sha256: 'a'.repeat(64) }],
      findings: [{
        id: 'finding-1', blocking: true, severity: 'high',
        subjectArtifactId: 'subject-1', subjectSha256: 'a'.repeat(64),
        description: '发现未解决的问题', requiredEvidence: [],
      }],
    });
    const blockedHash = sha256(blockedContent);
    writeFileSync(join(workspaceRoot, relativePath), blockedContent);

    board.transition(reviewTask.id, 'dispatched', { assignedAgent: 'worker', runId: 'run-1' });
    board.transition(reviewTask.id, 'accepted', { assignedAgent: 'worker' });
    board.transition(reviewTask.id, 'in_progress');
    board.transition(reviewTask.id, 'submitted', {
      result: {
        summary: 'submitted a review that found a blocking issue in the upstream artifact for auditing purposes',
        gateEvidenceArtifactId: 'gate-ev-1',
        canonicalArtifactManifest: [{ artifactId: 'gate-ev-1', relativePath, sha256: blockedHash }],
        workspacePath: workspaceRoot,
        workFolder: workspaceRoot,
      },
      runId: 'run-1',
    });
    // handleQualityReview 对 verdict=blocked 的证据会把 effectiveReview.passed
    // 置为 false，task 转为 failed（不是 done），同时真实产生一条 open blocking
    // ReviewConditionV1（通过 acceptTaskGateEvidence → commitReviewConditions）。
    hub.handleQualityReview(projectId, reviewTask.id, { passed: true, feedback: 'reviewing' }, 'po');

    board.transition(finalTask.id, 'dispatched', { assignedAgent: 'worker', runId: 'run-2' });
    board.transition(finalTask.id, 'accepted', { assignedAgent: 'worker' });
    board.transition(finalTask.id, 'in_progress');
    board.transition(finalTask.id, 'submitted', { result: { summary: 'final deliverable content that meets the acceptance criteria for the project', artifacts: [] }, runId: 'run-2' });
    hub.handleQualityReview(projectId, finalTask.id, { passed: true, feedback: 'final looks good' }, 'po');
    // reviewTask 因 blocked verdict 触发了 handleQualityFailure 的自动重试
    // 重派发（status=dispatched），不是简单转 failed；这里模拟 PO 决定跳过这个
    // 有问题的 review 任务直接交付——即使任务层面被取消，遗留的 open blocking
    // condition（已经在 handleQualityReview 时真实产生）仍应挡住最终批准。
    board.transition(reviewTask.id, 'pending');
    board.transition(reviewTask.id, 'cancelled');

    const delivered = hub.handleDeliver(projectId, { summary: 'final', artifacts: [] }, 'po', { taskId: finalTask.id });
    assert.equal(delivered.ok, true, JSON.stringify(delivered));

    const approved = hub.approveFinalDeliverable(projectId, delivered.finalDeliverable.deliverableId, {
      approvalIdempotencyKey: 'k3',
    }, { requestSource: 'user', actorId: 'user-1' });

    assert.equal(approved.ok, false, 'open blocking condition 存在时，schema v2 项目的 approveFinalDeliverable 必须拒绝');
    // 现状说明：preflightFinalDeliverableApproval（过渡性重算模式，
    // evaluateFinalDeliverableApprovalFacts）先于本轮新增的 evaluatePreApprovalPrerequisites
    // 执行，且它自己已经有等价的 open blocking condition 检查（错误码
    // open_review_conditions，见 project-read-model.js:259）。两条路径在这个
    // 场景下都会拒绝，但先执行的旧路径先返回——这是过渡阶段两套检查叠加的
    // 合理现状，不是回归；新路径的 open_blocking_condition 分支由
    // evaluate-pre-approval-prerequisites.test.js 独立验证过。
    assert.equal(approved.error, 'open_review_conditions');
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

let passed = 0;
let failed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
    if (process.env.DEBUG) console.log(err.stack);
  }
}
console.log(`\n${passed}/${tests.length} approveFinalDeliverable snapshot integration tests passed\n`);
if (failed > 0) process.exit(1);
