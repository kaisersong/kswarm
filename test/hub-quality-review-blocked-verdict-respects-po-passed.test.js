/**
 * KSwarm — handleQualityReview 对 review_iteration_v2 blocked verdict 的处理
 * 必须尊重 PO 明确声明的 review.passed，不能被 gate evaluation verdict 无条件
 * 覆盖（design §3.2 权威关系表格）
 *
 * 设计依据：mydocs/xiaok-cli/design/2026-08-31-collaboration-room-evidence-first-execution-and-gate-design.md v8
 *   §3.2 —— "task.reviewResult.passed 唯一含义是 PO 接受该任务的执行质量；
 *   service-owned gateEvaluations[].verdict 唯一含义是该 review/check 对精确
 *   subject artifact 版本的业务结论...两者独立"
 *   §14.4 —— "该核验 task 本身可标 done"（即使核验结论是 blocked）
 *
 * 现状核实（2026-09-02，由 §14.4 端到端场景驱动发现）：此前实现让
 * gateResult.evaluation.verdict !== 'passed' 无条件把 effectiveReview.passed
 * 覆盖为 false，导致一个真实完成了核验工作、只是核验结论恰好是 blocked 的
 * 独立 verifier 任务永远无法被 PO 标记 done——只会不断触发 rework 重新
 * dispatch。这与设计文档"执行完成"和"结论通过"必须独立表达的核心原则冲突，
 * 此前也没有任何测试真正覆盖这个合法 blocked 场景（只有防篡改测试和
 * verdict=passed 正常场景）。
 *
 * Run: node test/hub-quality-review-blocked-verdict-respects-po-passed.test.js
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

test('design §3.2/§14.4：PO 声明 passed:true 时，即使 gate evaluation verdict=blocked，任务本身仍应标 done（执行完成 ≠ 结论通过，两者独立）', () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'kswarm-blocked-verdict-'));
  try {
    const hub = createHub({ silent: true });
    const projectId = 'proj-blocked-verdict-respects-po';
    hub.createProject({
      id: projectId, name: projectId, goal: 'goal', poAgent: 'po', members: ['verifier'],
      executionGateSchemaVersion: 2,
    });
    const created = hub.handleCreateTasks(projectId, [
      { id: 'item-1', title: 'General verification task', assignedAgent: 'verifier', dependencies: [], evidenceContract: { kind: 'review_iteration_v2' } },
    ], 'po');
    hub.handleApprove(projectId);
    const board = hub.getBoard(projectId);
    const taskId = created.taskIds[0];

    board.transition(taskId, 'dispatched', { assignedAgent: 'verifier', runId: 'run-1' });
    board.transition(taskId, 'accepted', { assignedAgent: 'verifier' });
    board.transition(taskId, 'in_progress');

    mkdirSync(join(workspaceRoot, 'tasks/item-1/run-1'), { recursive: true });
    const evidence = JSON.stringify({
      schemaVersion: 'review-evidence-v2',
      verdict: 'blocked',
      subjectArtifacts: [{ artifactId: 'subject-1', sha256: 'a'.repeat(64) }],
      findings: [{
        id: 'finding-1', blocking: true, severity: 'high',
        subjectArtifactId: 'subject-1', subjectSha256: 'a'.repeat(64),
        description: '真实发现的问题', requiredEvidence: [],
      }],
    });
    writeFileSync(join(workspaceRoot, 'tasks/item-1/run-1/review-evidence.json'), evidence);

    const submit = hub.handleSubmitResult(projectId, taskId, {
      summary: '核验任务已完整执行：核对了目标 artifact 的关键属性，发现存在真实问题需要记录并明确阻断，避免误判。',
      workspacePath: workspaceRoot,
      gateEvidenceArtifactId: 'gate-ev-1',
      canonicalArtifactManifest: [{ artifactId: 'gate-ev-1', relativePath: 'tasks/item-1/run-1/review-evidence.json', sha256: sha256(evidence) }],
    }, 'verifier', 'run-1');
    assert.equal(submit.ok, true, JSON.stringify(submit));

    // PO 判断：这次核验工作本身做得完整、可信——即使核验结论是 blocked。
    const review = hub.handleQualityReview(projectId, taskId, { passed: true, feedback: '核验过程严谨，问题记录清晰' }, 'po');
    assert.equal(review.ok, true, JSON.stringify(review));

    assert.equal(board.getTask(taskId).status, 'done', 'design §3.2/§14.4：PO 声明 passed 时任务应该标 done，不能被 gate verdict 覆盖为 rework');

    // gate evaluation 本身仍然如实记录 verdict=blocked（不因为 PO 认可执行
    // 质量就伪造成 passed）——这是设计文档"两者独立"的另一半：只是不再让
    // blocked 反向覆盖 PO 的判断，PO 的判断也不能污染 evaluation 的真实记录。
    const evaluations = hub.getProject(projectId).gateEvaluations?.[taskId] || [];
    assert.ok(evaluations.length > 0);
    assert.equal(evaluations[0].verdict, 'blocked', 'design §3.2：GateEvaluation 的 verdict 必须如实记录，不受 PO review.passed 影响');
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('design §3.2：PO 明确声明 passed:false 时，任务仍然按 PO 判断走 rework（本次修复不改变 PO 主动判定失败的路径）', () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'kswarm-blocked-verdict-po-fail-'));
  try {
    const hub = createHub({ silent: true });
    const projectId = 'proj-blocked-verdict-po-fail';
    hub.createProject({
      id: projectId, name: projectId, goal: 'goal', poAgent: 'po', members: ['verifier'],
      executionGateSchemaVersion: 2,
    });
    const created = hub.handleCreateTasks(projectId, [
      { id: 'item-1', title: 'General verification task', assignedAgent: 'verifier', dependencies: [], evidenceContract: { kind: 'review_iteration_v2' } },
    ], 'po');
    hub.handleApprove(projectId);
    const board = hub.getBoard(projectId);
    const taskId = created.taskIds[0];

    board.transition(taskId, 'dispatched', { assignedAgent: 'verifier', runId: 'run-1' });
    board.transition(taskId, 'accepted', { assignedAgent: 'verifier' });
    board.transition(taskId, 'in_progress');

    mkdirSync(join(workspaceRoot, 'tasks/item-1/run-1'), { recursive: true });
    const evidence = JSON.stringify({
      schemaVersion: 'review-evidence-v2',
      verdict: 'passed',
      subjectArtifacts: [{ artifactId: 'subject-1', sha256: 'a'.repeat(64) }],
      findings: [],
    });
    writeFileSync(join(workspaceRoot, 'tasks/item-1/run-1/review-evidence.json'), evidence);

    const submit = hub.handleSubmitResult(projectId, taskId, {
      summary: '核验任务执行完成，但提交内容本身不完整，缺少必要的分析说明和结论依据支撑材料，需要重新补充完善后再次提交审核。',
      workspacePath: workspaceRoot,
      gateEvidenceArtifactId: 'gate-ev-1',
      canonicalArtifactManifest: [{ artifactId: 'gate-ev-1', relativePath: 'tasks/item-1/run-1/review-evidence.json', sha256: sha256(evidence) }],
    }, 'verifier', 'run-1');
    assert.equal(submit.ok, true, JSON.stringify(submit));

    // PO 即使看到 verdict=passed，仍然可以主动判定这次提交本身质量不合格
    // （比如认为核验方法有问题），这条路径完全不受本次修复影响。
    const review = hub.handleQualityReview(projectId, taskId, { passed: false, feedback: '核验方法不够严谨，需要重做' }, 'po');
    assert.equal(review.ok, true, JSON.stringify(review));
    assert.equal(review.rework, true, 'PO 主动判定失败时应该触发 rework');
    // rework 后 handleQualityReview 内部立即调用 handleRequestDispatch 重新
    // 派发（既有行为，不受本次修复影响）：任务因此会直接回到 dispatched，
    // 不会停留在 in_progress。
    assert.equal(board.getTask(taskId).status, 'dispatched', 'PO 主动判定失败时应该正常触发 rework 并被自动重新派发');
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
console.log(`\n${passed}/${tests.length} handleQualityReview blocked verdict respects PO passed tests passed\n`);
if (failed > 0) process.exit(1);
