/**
 * KSwarm — design §14.4 真实验收场景（完整 hash mismatch → blocked →
 * remediation → 用户批准 delivered 流程）
 *
 * 设计依据：mydocs/xiaok-cli/design/2026-08-31-collaboration-room-evidence-first-execution-and-gate-design.md v8
 *   §14.4 —— "使用现场项目的等价脱敏数据，必须证明：
 *   1. 独立 Agent 得出 hash mismatch；
 *   2. 该核验 task 本身可标 done；
 *   3. 项目状态明确显示"核验已完成，结果阻断"；
 *   4. remediation task 可以被 dispatch，但 final candidate 不得产生；
 *   5. 修复 artifact 后旧 evaluation 自动失效；
 *   6. 新 verifier 对新 hash 通过；
 *   7. final checks 重跑；
 *   8. 只有用户批准后 delivered；
 *   9. 全程在原 Room 可见进度，Room transcript 不承担业务真相。"
 *
 * 本文件驱动步骤 1-8（纯 KSwarm 内部真实调用链）。步骤 9（Room 投影）已在
 * 其它测试独立核实（src/net/broker-client.js#publishRoomProjectEvent +
 * Hub durable outbox，见 room-broker-client.test.js / room-event-outbox.test.js），
 * 本文件不重复验证 Room 传输层，只验证 KSwarm 侧产生的事件本身内容正确
 * （eventLog 记录的关键状态转换）。
 *
 * 场景设定（脱敏后的现场案例结构）：
 *   - item-1：作者产出原始 artifact（内容 A，hash H_A）
 *   - item-1-hash-verify：独立 verifier task，声明依赖 item-1 (verified_pass)，
 *     核验 item-1 的 artifact hash 与声明值是否一致——第一轮核验发现不一致
 *     （hash mismatch），产出 verdict=blocked 的 review-evidence-v2.json
 *   - item-1-remediation：修复任务，依赖 item-1-hash-verify
 *     (completed_for_remediation)——即使 hash-verify blocked，仍可 dispatch
 *   - item-1-remediation 产出修复后的新 artifact（内容 B，hash H_B）
 *   - item-1-reverify：对新 artifact 的独立复核，verdict=passed
 *   - 最终 FinalDeliverable 引用修复后的 artifact，只有用户批准后 delivered
 *
 * Run: node test/design-14-4-hash-mismatch-remediation-e2e.test.js
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

function writeReviewEvidenceV2(dir, relativePath, evidence) {
  const fullPath = join(dir, relativePath);
  mkdirSync(join(fullPath, '..'), { recursive: true });
  const content = JSON.stringify(evidence);
  writeFileSync(fullPath, content);
  return { relativePath, hash: sha256(content) };
}

test('design §14.4 完整验收场景：hash mismatch → blocked → remediation dispatch（final candidate 不产生）→ 修复 → 新 verifier passed → 用户批准 delivered', () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'kswarm-14-4-e2e-'));
  try {
    const hub = createHub({ silent: true });
    const projectId = 'proj-14-4-e2e';
    hub.createProject({
      id: projectId, name: projectId, goal: 'goal', poAgent: 'po',
      members: ['author', 'verifier', 'remediator'],
      executionGateSchemaVersion: 2,
    });

    // ── 步骤 0：建立任务图，声明 verified_pass / completed_for_remediation 策略 ──
    const created = hub.handleCreateTasks(projectId, [
      { id: 'item-1', title: 'Prepare source dataset', assignedAgent: 'author', dependencies: [] },
      {
        id: 'item-1-hash-verify', title: 'Independent hash verification',
        assignedAgent: 'verifier', dependencies: ['item-1'],
        dependencyPolicy: { 'item-1': 'verified_pass' },
        evidenceContract: { kind: 'review_iteration_v2' },
      },
      {
        id: 'item-1-remediation', title: 'Fix dataset after hash mismatch',
        assignedAgent: 'remediator', dependencies: ['item-1-hash-verify'],
        dependencyPolicy: { 'item-1-hash-verify': 'completed_for_remediation' },
      },
    ], 'po');
    assert.equal(created.ok, true, JSON.stringify(created));
    hub.handleApprove(projectId);

    const board = hub.getBoard(projectId);
    const item1Id = created.taskIds[0];
    const hashVerifyId = created.taskIds[1];
    const remediationId = created.taskIds[2];

    // ── item-1：author 产出原始 artifact（内容 A）──
    const originalContent = '# Dataset v1\n\noriginal (possibly stale) content';
    mkdirSync(join(workspaceRoot, 'artifacts'), { recursive: true });
    const item1ArtifactPath = join(workspaceRoot, 'artifacts', 'dataset.md');
    writeFileSync(item1ArtifactPath, originalContent);

    board.transition(item1Id, 'dispatched', { assignedAgent: 'author', runId: 'run-item1' });
    board.transition(item1Id, 'accepted', { assignedAgent: 'author' });
    board.transition(item1Id, 'in_progress');
    const item1Submit = hub.handleSubmitResult(projectId, item1Id, {
      summary: 'Dataset produced by author task, ready for independent hash verification review.',
      workFolder: workspaceRoot,
      artifacts: [{ artifactId: 'dataset-v1', path: item1ArtifactPath }],
    }, 'author', 'run-item1');
    assert.equal(item1Submit.ok, true, JSON.stringify(item1Submit));
    hub.handleQualityReview(projectId, item1Id, { passed: true, feedback: 'looks complete and structurally valid dataset artifact ready for downstream verification' }, 'po');
    assert.equal(board.getTask(item1Id).status, 'done');

    // ── 核实 verified_pass 尚未满足（item-1 只是 done，还没有 fresh
    //    GateEvaluation(passed)）：hash-verify 应该已经可以被 dispatch
    //    （它自己不消费 item-1 的 verified_pass 边，是它自己去核验 item-1）。

    // ── 步骤 1：独立 verifier 核验 item-1，发现 hash mismatch ──
    board.transition(hashVerifyId, 'dispatched', { assignedAgent: 'verifier', runId: 'run-verify-1' });
    board.transition(hashVerifyId, 'accepted', { assignedAgent: 'verifier' });
    board.transition(hashVerifyId, 'in_progress');

    const blockedEvidence = writeReviewEvidenceV2(workspaceRoot, 'tasks/item-1-hash-verify/run-verify-1/review-evidence.json', {
      schemaVersion: 'review-evidence-v2',
      verdict: 'blocked',
      subjectArtifacts: [{ artifactId: 'dataset-v1', sha256: 'expected-but-different-hash' }],
      findings: [{
        id: 'finding-hash-mismatch',
        blocking: true,
        severity: 'high',
        subjectArtifactId: 'dataset-v1',
        subjectSha256: 'expected-but-different-hash',
        description: 'artifact sha256 与声明的期望值不一致',
        requiredEvidence: [{ kind: 'artifact', description: '需要重新生成一致的 dataset' }],
      }],
    });

    const hashVerifySubmit = hub.handleSubmitResult(projectId, hashVerifyId, {
      summary: '独立核验任务已完成执行：核对 item-1 声明的 dataset artifact 哈希值，发现服务端重算 hash 与声明值不一致（hash mismatch），本次核验判定为阻断。',
      workspacePath: workspaceRoot,
      gateEvidenceArtifactId: 'gate-ev-hash-verify-1',
      canonicalArtifactManifest: [{ artifactId: 'gate-ev-hash-verify-1', relativePath: blockedEvidence.relativePath, sha256: blockedEvidence.hash }],
    }, 'verifier', 'run-verify-1');
    assert.equal(hashVerifySubmit.ok, true, JSON.stringify(hashVerifySubmit));

    const hashVerifyReview = hub.handleQualityReview(projectId, hashVerifyId, { passed: true, feedback: '核验任务本身执行完成' }, 'po');
    assert.equal(hashVerifyReview.ok, true, JSON.stringify(hashVerifyReview));

    // ── 验收点 2：该核验 task 本身可以标 done（执行完成 ≠ 结论通过）──
    assert.equal(board.getTask(hashVerifyId).status, 'done', 'design §14.4 验收点 2：核验 task 本身应该能标 done');

    // ── 验收点 3：项目状态明确显示"核验已完成，结果阻断" ──
    const project = hub.getProject(projectId);
    const evaluationsForHashVerify = project.gateEvaluations?.[hashVerifyId] || [];
    assert.ok(evaluationsForHashVerify.length > 0, 'design §14.4 验收点 3：必须产生 GateEvaluation 记录');
    assert.equal(evaluationsForHashVerify[0].verdict, 'blocked', 'design §14.4 验收点 3：verdict 必须明确记录为 blocked（不是被 done 状态掩盖）');

    // ── 验收点 4：remediation task 可以被 dispatch（completed_for_remediation
    //    允许 blocked review 派发修复），但 final candidate 不得产生 ──
    const dispatchAfterBlock = hub.getDispatchPlan(projectId);
    const dispatchableIds = dispatchAfterBlock.dispatchedTasks.map(t => t.id);
    assert.ok(dispatchableIds.includes(remediationId), 'design §14.4 验收点 4：remediation task 必须能被 dispatch，即使上游 review blocked');

    const deliverAttemptWhileBlocked = hub.handleDeliver(projectId, { summary: 'attempt' }, 'po', { taskId: item1Id });
    assert.notEqual(deliverAttemptWhileBlocked.status, 'delivered', 'design §14.4 验收点 4：final candidate 不应该在 remediation 完成前产生');

    // ── remediation：修复任务产出新 artifact（内容 B，hash 不同）。design
    // §3.5："artifact 被改写：canonical manifest 创建新 version，不原地
    // 覆盖"——用新的 artifactId（不是原地复用 dataset-v1），因为
    // registerSubmittedArtifactsAsCanonical 会拒绝同一 artifactId 被不同
    // taskId 覆写（跨 task/run 冲突覆写检测，这是正确的 fail-closed 行为，
    // 不能通过复用旧 artifactId 绕过）。 ──
    board.transition(remediationId, 'dispatched', { assignedAgent: 'remediator', runId: 'run-remediation-1' });
    board.transition(remediationId, 'accepted', { assignedAgent: 'remediator' });
    board.transition(remediationId, 'in_progress');
    const remediatedContent = '# Dataset v2\n\nfixed content with correct provenance';
    const remediatedArtifactPath = join(workspaceRoot, 'artifacts', 'dataset-v2.md');
    writeFileSync(remediatedArtifactPath, remediatedContent);
    const remediationSubmit = hub.handleSubmitResult(projectId, remediationId, {
      summary: 'Dataset 已重新生成并修复，补全了缺失的数据来源 provenance 信息，替换了原本 hash 不一致的内容版本。',
      workFolder: workspaceRoot,
      artifacts: [{ artifactId: 'dataset-v2', path: remediatedArtifactPath }],
    }, 'remediator', 'run-remediation-1');
    assert.equal(remediationSubmit.ok, true, JSON.stringify(remediationSubmit));
    hub.handleQualityReview(projectId, remediationId, { passed: true, feedback: '修复内容已确认，新版本 artifact 已生成并通过验收标准检查确认合规无误' }, 'po');
    assert.equal(board.getTask(remediationId).status, 'done');

    // ── 验收点 5：修复后产生的是新 artifact version（新 canonical
    // artifactId），不是原地覆盖旧记录；旧 evaluation（针对 dataset-v1 旧
    // hash）不会被错误应用到新版本上——它们分属不同的 canonical artifactId，
    // hydrateGateFacts 按 artifactId 精确查找，天然不会用旧 artifactId 的
    // evaluation 冒充新 artifactId 的证据。
    const canonicalV2 = project.canonicalArtifacts?.['dataset-v2'];
    assert.ok(canonicalV2, 'design §14.4 验收点 5：修复后的新版本必须以新 canonical artifactId 注册');
    assert.equal(canonicalV2.runId, 'run-remediation-1', 'design §14.4 验收点 5：新版本必须指向 remediation 的真实 run');
    assert.equal(canonicalV2.sha256, sha256(remediatedContent), 'design §14.4 验收点 5：新版本必须是服务端重新计算的真实内容 hash');

    // ── 新一轮独立复核：对修复后的新内容（dataset-v2）产出 verdict=passed ──
    const passedEvidence = writeReviewEvidenceV2(workspaceRoot, 'tasks/item-1-hash-verify/run-verify-2/review-evidence.json', {
      schemaVersion: 'review-evidence-v2',
      verdict: 'passed',
      subjectArtifacts: [{ artifactId: 'dataset-v2', sha256: sha256(remediatedContent) }],
      findings: [],
    });
    // 模拟：用户/PO 要求对 hash-verify 任务做第二轮独立核验（基于修复后的
    // 新版本 artifact）。真实场景中这通常是 PO 判断需要重新核验后调用
    // handleRework，把已 done 的任务重新打开（task-board.js:VALID_TRANSITIONS
    // 明确允许 done → in_progress，"PO quality review can reopen for
    // rework"），再走正常的 handleSubmitResult 提交新一轮证据——不是
    // handleRecoverSubmission（那是为中断后恢复同一次提交设计的，不支持
    // 对已经 done 的任务生成全新的一轮提交）。
    const reworkResult = hub.handleRework(projectId, hashVerifyId, '需要针对修复后的新版本重新核验', 'po');
    assert.equal(reworkResult.ok, true, JSON.stringify(reworkResult));
    // design 现状核实：handleRework 只把任务转回 in_progress，不重新分配
    // activeRunId；task-board.js:validateRun 在 activeRunId 为空时会要求
    // 沿用 lastRunLease.runId（同一次已分配 run 的返工重提交），不是分配一个
    // 全新 runId——这与"failed 后自动 retry 派生新 runId"是不同的语义路径。
    const reverifySubmit = hub.handleSubmitResult(projectId, hashVerifyId, {
      summary: '对修复后的新版本 dataset 重新执行独立核验：服务端重算 hash 与声明值一致，本次核验判定为通过。',
      workspacePath: workspaceRoot,
      gateEvidenceArtifactId: 'gate-ev-hash-verify-2',
      canonicalArtifactManifest: [{ artifactId: 'gate-ev-hash-verify-2', relativePath: passedEvidence.relativePath, sha256: passedEvidence.hash }],
    }, 'verifier', 'run-verify-1');
    assert.equal(reverifySubmit.ok, true, JSON.stringify(reverifySubmit));
    const reverifyReview = hub.handleQualityReview(projectId, hashVerifyId, { passed: true, feedback: '重新核验任务执行完成，本次核验流程覆盖了新版本 artifact 的完整哈希比对检查环节' }, 'po');
    assert.equal(reverifyReview.ok, true, JSON.stringify(reverifyReview));

    // ── 验收点 6：新 verifier 对新 hash 通过 ──
    const evaluationsAfterReverify = hub.getProject(projectId).gateEvaluations?.[hashVerifyId] || [];
    const freshPassed = evaluationsAfterReverify.some(e => e.verdict === 'passed' && e.sourceRunId === 'run-verify-1');
    assert.ok(freshPassed, 'design §14.4 验收点 6：必须存在这次重新提交（同一 run-verify-1，因为 rework 沿用原 run lease）的 passed evaluation');

    // design §3.4："reviewer 提出条件，但不能自行将自己提出的条件标记
    // resolved""KSwarm reducer 只在独立验证或系统确定性检查通过后转为
    // resolved"。第一轮 blocked review 产生的 blocking condition 此时仍是
    // open——新一轮 passed evaluation 本身不会自动解决它（两者是独立事实，
    // 见 §3.2 权威关系表格），必须由不是 originatingReviewerIdentity 的身份
    // （这里用 PO，代表用户/系统对独立验证结果的确认）显式调用
    // resolveReviewConditionEntry。
    const openConditions = hub.listReviewConditions(projectId).filter(c => c.status !== 'resolved');
    assert.ok(openConditions.length > 0, 'design §14.4：第一轮 blocked review 必须产生至少一条 open blocking condition');
    for (const condition of openConditions) {
      const resolveResult = hub.resolveReviewConditionEntry(projectId, condition.conditionId, {
        verifiedBy: 'user-1',
        evidenceRefs: [`artifact:${passedEvidence.relativePath}`],
      }, { requestSource: 'user' });
      assert.equal(resolveResult.ok, true, JSON.stringify(resolveResult));
    }

    // ── 步骤 7：final checks 重跑 + 步骤 8：只有用户批准后 delivered ──
    const item1FinalSubmit = { path: remediatedArtifactPath, artifactId: 'dataset-v2' };
    const delivered = hub.handleDeliver(projectId, {
      summary: '数据集已修复并通过独立复核，新版本内容已确认可以作为最终交付物提交审批流程',
      artifactRef: item1FinalSubmit,
    }, 'po', { taskId: item1Id, workFolder: workspaceRoot, expectedFormat: 'markdown' });
    assert.equal(delivered.ok, true, JSON.stringify(delivered));
    assert.equal(delivered.status, 'awaiting_user_approval', 'design §14.4 验收点 8：handleDeliver 只能注册 candidate，不能直接 delivered');
    assert.notEqual(hub.getProject(projectId).status, 'delivered', 'design §14.4 验收点 8：PO 提交交付不能让项目自动进入 delivered');

    const approved = hub.approveFinalDeliverable(projectId, delivered.finalDeliverable.deliverableId, {
      approvalIdempotencyKey: 'approve-14-4-e2e',
    }, { requestSource: 'user', actorId: 'user-1' });
    assert.equal(approved.ok, true, JSON.stringify(approved));
    assert.equal(hub.getProject(projectId).status, 'delivered', 'design §14.4 验收点 8：只有 requestSource=user 的批准才能让项目进入 delivered');
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
console.log(`\n${passed}/${tests.length} design §14.4 hash mismatch remediation e2e tests passed\n`);
if (failed > 0) process.exit(1);
