/**
 * KSwarm — handleQualityReview 的 review_iteration_v2 分支必须委托
 * acceptTaskGateEvidence，不能继续走 extractReviewEvidence（design §3.2 / §8.2）
 *
 * 设计依据：mydocs/xiaok-cli/design/2026-08-31-collaboration-room-evidence-first-execution-and-gate-design.md v8
 *   §3.2 GateEvaluation —— "当前 execution-contract.js:getReviewEvidence 会让 inline
 *   result.reviewEvidence/evidence/qualityEvidence 在内存合并时覆盖磁盘读取结果...
 *   这条现状不能用于 v2 execution validation 或 gate。v2 gate 解析必须：1. task result
 *   显式声明唯一 gateEvidenceArtifactId；...3. service 用 realpath containment 校验后
 *   读取磁盘 artifact，并重新计算 sha256；4. 只有 service hash 与 canonical manifest
 *   hash 一致...才解析 GateEvaluation"
 *   §8.2 表格 —— "handleQualityReview 后 auto-dispatch：只更新 execution review，
 *   再进入统一 evaluator"
 *
 * 现状核实（2026-09-02）：hub.js:handleQualityReview 的 review_iteration family 分支
 * （第 2618-2637 行附近）调用 extractReviewEvidence（execution-contract.js 的旧 v1
 * inline-merge 逻辑）+ 本地 prepareReviewConditions，从未调用新增的
 * gate-evidence-acceptor.js:acceptTaskGateEvidence，也从未做 hash 校验。
 *
 * 本文件用一个可判别的行为差异场景驱动修复：task.result 声明的 gateEvidenceArtifactId
 * 对应的 canonical artifact 已知 hash，但磁盘文件内容已被篡改（hash 不匹配）。
 *   - 旧路径（extractReviewEvidence）：无 hash 校验，会照常读出篡改后的 verdict，
 *     review 判定"成功"（这正是设计文档要修的漏洞）。
 *   - 新路径（acceptTaskGateEvidence）：hash mismatch 必须 fail closed，
 *     不产生 GateEvaluation，task.result 不应被当作已验证的证据消费。
 *
 * Run: node test/hub-quality-review-gate-evidence-v2.test.js
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

test('v2 review evidence 的 gateEvidenceArtifactId 若与磁盘内容 hash 不一致，handleQualityReview 必须拒绝该证据（不能照旧读出篡改后的 verdict）', () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'kswarm-hub-gate-v2-'));
  try {
    const hub = createHub({ silent: true });
    const projectId = 'proj-gate-v2';
    hub.createProject({ id: projectId, name: projectId, goal: 'goal', poAgent: 'po', members: ['worker'] });
    const created = hub.handleCreateTasks(projectId, [
      { id: 'item-1', title: 'Review upstream artifact', brief: 'Review', assignedAgent: 'worker', dependencies: [] },
    ], 'po');
    assert.equal(created.ok, true);
    assert.equal(hub.handleApprove(projectId).ok, true);

    const board = hub.getBoard(projectId);
    const task = board.getTask(created.taskIds[0]);
    // 显式声明持久化的 v2 evidence contract（不依赖 planner 推断路径，聚焦本次要测的分支）。
    task.evidenceContract = {
      version: 2,
      kind: 'review_iteration_v2',
      requiredArtifacts: ['review-evidence-v2.json'],
      requiredFields: ['verdict', 'findings', 'subjectArtifacts'],
    };

    // 构造磁盘证据：canonical manifest 记录的 hash 是"原始内容"的 hash，
    // 但磁盘上实际文件已经被替换成篡改后的内容（verdict 从 blocked 改成 passed）。
    const relativePath = 'tasks/item-1/run-1/review-evidence.json';
    mkdirSync(join(workspaceRoot, 'tasks/item-1/run-1'), { recursive: true });
    const originalContent = JSON.stringify({
      schemaVersion: 'review-evidence-v2',
      verdict: 'blocked',
      subjectArtifacts: [{ artifactId: 'subject-1', sha256: 'a'.repeat(64) }],
      findings: [{ id: 'f1', blocking: true, severity: 'high', subjectArtifactId: 'subject-1', subjectSha256: 'a'.repeat(64), description: 'issue', requiredEvidence: [] }],
    });
    const originalHash = sha256(originalContent);
    const tamperedContent = JSON.stringify({
      schemaVersion: 'review-evidence-v2',
      verdict: 'passed',
      subjectArtifacts: [{ artifactId: 'subject-1', sha256: 'a'.repeat(64) }],
      findings: [],
    });
    writeFileSync(join(workspaceRoot, relativePath), tamperedContent);

    const result = board.transition(task.id, 'dispatched', { assignedAgent: 'worker', runId: 'run-1' });
    assert.equal(result.ok, true);
    assert.equal(board.transition(task.id, 'accepted', { assignedAgent: 'worker' }).ok, true);
    assert.equal(board.transition(task.id, 'in_progress').ok, true);
    assert.equal(board.transition(task.id, 'submitted', {
      result: {
        summary: 'reviewed and confirmed the review artifact meets acceptance criteria with sufficient detail for auditing purposes',
        gateEvidenceArtifactId: 'gate-ev-1',
        // canonical manifest 记录（本次测试直接内嵌在 result 里模拟已注册的 canonical
        // artifact；真实实现中这应该来自独立的 canonical registry 查找）。
        canonicalArtifactManifest: [{ artifactId: 'gate-ev-1', relativePath, sha256: originalHash }],
        workspacePath: workspaceRoot,
        workFolder: workspaceRoot,
      },
      runId: 'run-1',
    }).ok, true);

    const reviewResult = hub.handleQualityReview(projectId, task.id, { passed: true, feedback: 'looks fine' }, 'po');

    assert.equal(reviewResult.ok, false, 'hash mismatch 必须导致 handleQualityReview 拒绝，不能静默通过篡改后的 verdict');
    assert.equal(reviewResult.error, 'artifact_hash_mismatch');
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('合法证据（hash 匹配 + verdict=passed）能通过 handleQualityReview，并把 GateEvaluationV1 真正写入 project.gateEvaluations', () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'kswarm-hub-gate-v2-valid-'));
  try {
    const hub = createHub({ silent: true });
    const projectId = 'proj-gate-v2-valid';
    hub.createProject({ id: projectId, name: projectId, goal: 'goal', poAgent: 'po', members: ['worker'] });
    const created = hub.handleCreateTasks(projectId, [
      { id: 'item-1', title: 'Review upstream artifact', brief: 'Review', assignedAgent: 'worker', dependencies: [] },
    ], 'po');
    assert.equal(created.ok, true);
    assert.equal(hub.handleApprove(projectId).ok, true);

    const board = hub.getBoard(projectId);
    const task = board.getTask(created.taskIds[0]);
    task.evidenceContract = {
      version: 2,
      kind: 'review_iteration_v2',
      requiredArtifacts: ['review-evidence-v2.json'],
      requiredFields: ['verdict', 'findings', 'subjectArtifacts'],
    };

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

    assert.equal(board.transition(task.id, 'dispatched', { assignedAgent: 'worker', runId: 'run-1' }).ok, true);
    assert.equal(board.transition(task.id, 'accepted', { assignedAgent: 'worker' }).ok, true);
    assert.equal(board.transition(task.id, 'in_progress').ok, true);
    assert.equal(board.transition(task.id, 'submitted', {
      result: {
        summary: 'reviewed and confirmed the review artifact meets acceptance criteria with sufficient detail for auditing purposes',
        gateEvidenceArtifactId: 'gate-ev-1',
        canonicalArtifactManifest: [{ artifactId: 'gate-ev-1', relativePath, sha256: validHash }],
        workspacePath: workspaceRoot,
        workFolder: workspaceRoot,
      },
      runId: 'run-1',
    }).ok, true);

    const reviewResult = hub.handleQualityReview(projectId, task.id, { passed: true, feedback: 'looks fine' }, 'po');
    assert.equal(reviewResult.ok, true, JSON.stringify(reviewResult));

    const project = hub.getProject(projectId);
    assert.ok(project.gateEvaluations, 'project.gateEvaluations 必须存在');
    const evaluations = project.gateEvaluations[task.id];
    assert.ok(Array.isArray(evaluations) && evaluations.length === 1, 'GateEvaluationV1 必须真正写入 project.gateEvaluations[taskId]');
    assert.equal(evaluations[0].schemaVersion, 'gate-evaluation-v1');
    assert.equal(evaluations[0].verdict, 'passed');
    assert.equal(evaluations[0].sourceArtifactSha256, validHash);
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
console.log(`\n${passed}/${tests.length} hub quality review gate evidence v2 tests passed\n`);
if (failed > 0) process.exit(1);
