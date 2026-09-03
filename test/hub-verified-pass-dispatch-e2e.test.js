/**
 * KSwarm — verified_pass 依赖策略端到端闭环（design §3.3 / §3.2 / §8.2）
 *
 * 设计依据：mydocs/xiaok-cli/design/2026-08-31-collaboration-room-evidence-first-execution-and-gate-design.md v8
 *   §3.3 依赖边分类 —— "verified_pass 只允许消费已验证 artifact 的任务，要求依赖
 *   task 完成、fresh GateEvaluationV1.verdict=passed，并且下游声明的
 *   consumedArtifactIds 全部包含在 subjectArtifacts 中"
 *
 * 本文件验证的是一条完整的端到端闭环，不是单个函数的单元测试：
 *   task-1（review_iteration_v2）产出 review-evidence-v2.json 证据
 *     → handleQualityReview 通过 acceptTaskGateEvidence 确定性解析
 *     → GateEvaluationV1 写入 project.gateEvaluations[task-1]（增量记录 #5）
 *     → buildDispatchPlan/planDispatch 消费 project.gateEvaluations 作为
 *       gateEvaluationsByTaskId（此前一直存在但从未被真实数据驱动过）
 *     → task-2（dependencyPolicies['task-1']='verified_pass'）现在真正可以
 *       被判定为可派发。
 *
 * 这是本次会话中 §3.2/§3.3/§8.2 三处此前独立验证过的模块第一次被证明
 * 在真实 hub 流程中协同工作，而不是分别测试后假设它们会衔接。
 *
 * Run: node test/hub-verified-pass-dispatch-e2e.test.js
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

test('task-1 产出 fresh GateEvaluation(passed) 后，verified_pass 依赖它的 task-2 变为可派发（此前因缺 evaluation 而 fail closed）', () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'kswarm-verified-pass-e2e-'));
  try {
    const hub = createHub({ silent: true });
    const projectId = 'proj-verified-pass-e2e';
    hub.createProject({
      id: projectId, name: projectId, goal: 'goal', poAgent: 'po', members: ['worker'],
      executionGateSchemaVersion: 2,
    });
    const created = hub.handleCreateTasks(projectId, [
      { id: 'item-1', title: 'Produce reviewed artifact', brief: 'Review', assignedAgent: 'worker', dependencies: [] },
      { id: 'item-2', title: 'Consume verified artifact', brief: 'Consume', assignedAgent: 'worker', dependencies: ['item-1'] },
    ], 'po');
    assert.equal(created.ok, true);
    assert.equal(hub.handleApprove(projectId).ok, true);

    const project = hub.getProject(projectId);
    const board = hub.getBoard(projectId);
    const task1 = board.getTask(created.taskIds[0]);
    const task2 = board.getTask(created.taskIds[1]);

    // design §3.3：schema v2 项目必须显式声明 dependencyPolicies，否则 fail closed。
    project.dependencyPolicies = { [task1.id]: 'verified_pass' };
    task2.consumedArtifactIdsByDependencyTaskId = { [task1.id]: ['subject-1'] };

    task1.evidenceContract = {
      version: 2,
      kind: 'review_iteration_v2',
      requiredArtifacts: ['review-evidence-v2.json'],
      requiredFields: ['verdict', 'findings', 'subjectArtifacts'],
    };

    // 派发前：task-1 尚未完成、尚无 evaluation，task-2 必须 fail closed 不可派发。
    const planBefore = hub.getDispatchPlan(projectId);
    assert.ok(
      !planBefore.dispatchedTasks.some(t => t.id === task2.id),
      'task-1 尚无 fresh GateEvaluation(passed) 时，task-2 不应可派发',
    );

    const relativePath = 'tasks/item-1/run-1/review-evidence.json';
    mkdirSync(join(workspaceRoot, 'tasks/item-1/run-1'), { recursive: true });
    const validContent = JSON.stringify({
      schemaVersion: 'review-evidence-v2',
      verdict: 'passed',
      subjectArtifacts: [{ artifactId: 'subject-1', sha256: 'a'.repeat(64) }],
      findings: [],
    });
    const validHash = sha256(validContent);
    writeFileSync(join(workspaceRoot, relativePath), validContent);

    assert.equal(board.transition(task1.id, 'dispatched', { assignedAgent: 'worker', runId: 'run-1' }).ok, true);
    assert.equal(board.transition(task1.id, 'accepted', { assignedAgent: 'worker' }).ok, true);
    assert.equal(board.transition(task1.id, 'in_progress').ok, true);
    assert.equal(board.transition(task1.id, 'submitted', {
      result: {
        summary: 'produced the reviewed artifact with a passing gate evaluation for downstream consumption purposes',
        gateEvidenceArtifactId: 'gate-ev-1',
        canonicalArtifactManifest: [{ artifactId: 'gate-ev-1', relativePath, sha256: validHash }],
        workspacePath: workspaceRoot,
        workFolder: workspaceRoot,
      },
      runId: 'run-1',
    }).ok, true);

    const reviewResult = hub.handleQualityReview(projectId, task1.id, { passed: true, feedback: 'looks fine' }, 'po');
    assert.equal(reviewResult.ok, true, JSON.stringify(reviewResult));
    assert.equal(board.getTask(task1.id).status, 'done', 'PO review passed 后 task-1 应转为 done');

    // design §3.3：verified_pass 判定链除了 gateEvaluationsByTaskId，还要求
    // service-owned 的 currentGateFacts（独立的 sourceRunId/canonicalArtifacts
    // 交叉验证层，见 gate-evaluator.js:validateCurrentGateFacts）。这一层此前
    // 从未在本测试中构造，导致本测试此前"意外通过"——根因是 executionGateSchemaVersion
    // 在 createProject 中从未被真正持久化（本轮增量记录 #12 修复），本测试实际上
    // 一直走的是 legacy completed 语义（schemaV2 实际是 undefined，不是 true），
    // 从未真正触达 verified_pass 的完整判定链。现在 schemaV2 真正生效后，
    // 必须补齐 currentGateFacts 才能让这条判定链完整通过。
    project.currentGateFacts = {
      [task1.id]: {
        sourceRunId: 'run-1',
        evaluationSourceArtifact: { artifactId: 'gate-ev-1', sha256: validHash },
        canonicalArtifacts: [{ taskId: task1.id, artifactId: 'subject-1', sha256: 'a'.repeat(64) }],
      },
    };
    task1.lastRunLease = { runId: 'run-1' };

    // 派发后：task-1 已 done + fresh GateEvaluation(passed) + consumedArtifactIds 覆盖，
    // task-2 现在应该真正可派发——这是端到端闭环真正生效的证明。
    const planAfter = hub.getDispatchPlan(projectId);
    assert.ok(
      planAfter.dispatchedTasks.some(t => t.id === task2.id),
      `task-1 已产出 fresh GateEvaluation(passed) 后，task-2 应可派发。dispatchedTasks=${JSON.stringify(planAfter.dispatchedTasks.map(t => t.id))} blocked=${JSON.stringify(planAfter.blocked)}`,
    );
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
console.log(`\n${passed}/${tests.length} hub verified_pass dispatch e2e tests passed\n`);
if (failed > 0) process.exit(1);
