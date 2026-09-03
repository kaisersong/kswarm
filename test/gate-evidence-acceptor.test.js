/**
 * KSwarm — acceptTaskGateEvidence（design §9.1 / §3.2 / §3.4 / §5.1.1）
 *
 * 设计依据：mydocs/xiaok-cli/design/2026-08-31-collaboration-room-evidence-first-execution-and-gate-design.md v8
 *   §9.1 KSwarm service —— "acceptTaskGateEvidence(input, requestSource) // 接受 artifact
 *   后确定性解析，不允许直接写 verdict"
 *   §3.2 GateEvaluation —— v2 gate 解析的 6 步流程（唯一 gateEvidenceArtifactId、
 *   canonical manifest 解析、realpath containment、service hash 重算、schema 校验、
 *   fail closed）
 *   §3.4 ReviewCondition —— review-evidence-v2.json.findings 是条件真实输入
 *
 * 现状核实（2026-09-02）：这个函数、review_iteration_v2 validator、GateEvaluationV1/
 * ChecksV2 的真实构造入口，此前完全不存在。这是让 hydrateGateFacts 未来能读到
 * 真实磁盘证据的第一个写入端。
 *
 * 本文件先证明模块不存在（RED），随后实现应使其变绿。
 *
 * Run: node test/gate-evidence-acceptor.test.js
 */

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { acceptTaskGateEvidence } from '../src/core/gate-evidence-acceptor.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function makeWorkspace() {
  return mkdtempSync(join(tmpdir(), 'kswarm-gate-evidence-'));
}

test('requestSource 缺失或非法时 fail closed（default deny，§9.1 权限要求）', () => {
  const ws = makeWorkspace();
  try {
    const result = acceptTaskGateEvidence({
      projectId: 'proj-1',
      taskId: 'proj-1__item-1',
      runId: 'run-1',
      artifactsDir: ws,
      gateEvidenceArtifactId: 'a1',
      canonicalArtifactLookup: () => null,
    }, undefined);
    assert.equal(result.ok, false);
    assert.equal(result.error, 'request_source_required');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('agent requestSource 但任务未分派给该 agent 时拒绝（§9.1："Agent 只可为自己被分派的 task 提交 evidence"）', () => {
  const ws = makeWorkspace();
  try {
    const result = acceptTaskGateEvidence({
      projectId: 'proj-1',
      taskId: 'proj-1__item-1',
      runId: 'run-1',
      artifactsDir: ws,
      gateEvidenceArtifactId: 'a1',
      assignedAgent: 'worker-a',
      canonicalArtifactLookup: () => null,
    }, { kind: 'agent', participantId: 'worker-b' });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'not_assigned_agent');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('缺失 gateEvidenceArtifactId 时 fail closed（§3.2 步骤 1：task result 必须显式声明唯一 ID）', () => {
  const ws = makeWorkspace();
  try {
    const result = acceptTaskGateEvidence({
      projectId: 'proj-1',
      taskId: 'proj-1__item-1',
      runId: 'run-1',
      artifactsDir: ws,
      gateEvidenceArtifactId: null,
      assignedAgent: 'worker-a',
      canonicalArtifactLookup: () => null,
    }, { kind: 'agent', participantId: 'worker-a' });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'gate_evidence_artifact_id_required');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('canonical manifest 查不到该 artifactId 时 fail closed，不产生 evaluation', () => {
  const ws = makeWorkspace();
  try {
    const result = acceptTaskGateEvidence({
      projectId: 'proj-1',
      taskId: 'proj-1__item-1',
      runId: 'run-1',
      artifactsDir: ws,
      gateEvidenceArtifactId: 'missing-artifact',
      assignedAgent: 'worker-a',
      canonicalArtifactLookup: () => null,
    }, { kind: 'agent', participantId: 'worker-a' });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'canonical_artifact_not_found');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('service 重算 hash 与 canonical manifest hash 不一致时 fail closed（防篡改核心检查）', () => {
  const ws = makeWorkspace();
  try {
    const relativePath = 'tasks/item-1/run-1/review-evidence.json';
    const fullPath = join(ws, relativePath);
    mkdirSync(join(ws, 'tasks/item-1/run-1'), { recursive: true });
    writeFileSync(fullPath, JSON.stringify({
      schemaVersion: 'review-evidence-v2',
      verdict: 'passed',
      subjectArtifacts: [{ artifactId: 'subject-1', sha256: 'x'.repeat(64) }],
      findings: [],
    }));

    const result = acceptTaskGateEvidence({
      projectId: 'proj-1',
      taskId: 'proj-1__item-1',
      runId: 'run-1',
      artifactsDir: ws,
      gateEvidenceArtifactId: 'gate-ev-1',
      assignedAgent: 'worker-a',
      canonicalArtifactLookup: (id) => (id === 'gate-ev-1'
        ? { artifactId: 'gate-ev-1', relativePath, sha256: 'stale-hash-does-not-match' }
        : null),
    }, { kind: 'agent', participantId: 'worker-a' });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'artifact_hash_mismatch');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('schema 不是 review-evidence-v2/checks-v2 时 fail closed，不解析出 evaluation', () => {
  const ws = makeWorkspace();
  try {
    const relativePath = 'tasks/item-1/run-1/review-evidence.json';
    const fullPath = join(ws, relativePath);
    mkdirSync(join(ws, 'tasks/item-1/run-1'), { recursive: true });
    const content = JSON.stringify({ schemaVersion: 'review-evidence-v1', verdict: 'passed' });
    writeFileSync(fullPath, content);
    const hash = sha256(Buffer.from(content, 'utf-8'));

    const result = acceptTaskGateEvidence({
      projectId: 'proj-1',
      taskId: 'proj-1__item-1',
      runId: 'run-1',
      artifactsDir: ws,
      gateEvidenceArtifactId: 'gate-ev-1',
      assignedAgent: 'worker-a',
      canonicalArtifactLookup: (id) => (id === 'gate-ev-1' ? { artifactId: 'gate-ev-1', relativePath, sha256: hash } : null),
    }, { kind: 'agent', participantId: 'worker-a' });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'unsupported_evidence_schema');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('合法 review-evidence-v2（verdict=passed）确定性解析出 GateEvaluationV1，independence 默认 independent', () => {
  const ws = makeWorkspace();
  try {
    const relativePath = 'tasks/item-1/run-1/review-evidence.json';
    const fullPath = join(ws, relativePath);
    mkdirSync(join(ws, 'tasks/item-1/run-1'), { recursive: true });
    const content = JSON.stringify({
      schemaVersion: 'review-evidence-v2',
      verdict: 'passed',
      subjectArtifacts: [{ artifactId: 'subject-1', sha256: 'a'.repeat(64) }],
      findings: [],
    });
    writeFileSync(fullPath, content);
    const hash = sha256(Buffer.from(content, 'utf-8'));

    const result = acceptTaskGateEvidence({
      projectId: 'proj-1',
      taskId: 'proj-1__item-1',
      runId: 'run-1',
      artifactsDir: ws,
      gateEvidenceArtifactId: 'gate-ev-1',
      assignedAgent: 'worker-a',
      reviewerParticipantId: 'reviewer-x',
      producerParticipantId: 'worker-a',
      canonicalArtifactLookup: (id) => (id === 'gate-ev-1' ? { artifactId: 'gate-ev-1', relativePath, sha256: hash } : null),
    }, { kind: 'agent', participantId: 'worker-a' });

    assert.equal(result.ok, true);
    assert.equal(result.evaluation.schemaVersion, 'gate-evaluation-v1');
    assert.equal(result.evaluation.verdict, 'passed');
    assert.equal(result.evaluation.sourceArtifactId, 'gate-ev-1');
    assert.equal(result.evaluation.sourceArtifactSha256, hash);
    assert.equal(result.evaluation.sourceRunId, 'run-1');
    assert.deepEqual(result.evaluation.subjectArtifacts, [{ artifactId: 'subject-1', sha256: 'a'.repeat(64) }]);
    assert.equal(result.evaluation.evaluator.participantId, 'reviewer-x');
    assert.equal(result.evaluation.evaluator.independence, 'independent');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('reviewer 与 producer 是同一 participant 时 independence=degraded（§4.2 独立性约束）', () => {
  const ws = makeWorkspace();
  try {
    const relativePath = 'tasks/item-1/run-1/review-evidence.json';
    const fullPath = join(ws, relativePath);
    mkdirSync(join(ws, 'tasks/item-1/run-1'), { recursive: true });
    const content = JSON.stringify({
      schemaVersion: 'review-evidence-v2',
      verdict: 'passed',
      subjectArtifacts: [{ artifactId: 'subject-1', sha256: 'a'.repeat(64) }],
      findings: [],
    });
    writeFileSync(fullPath, content);
    const hash = sha256(Buffer.from(content, 'utf-8'));

    const result = acceptTaskGateEvidence({
      projectId: 'proj-1',
      taskId: 'proj-1__item-1',
      runId: 'run-1',
      artifactsDir: ws,
      gateEvidenceArtifactId: 'gate-ev-1',
      assignedAgent: 'worker-a',
      reviewerParticipantId: 'worker-a',
      producerParticipantId: 'worker-a',
      canonicalArtifactLookup: (id) => (id === 'gate-ev-1' ? { artifactId: 'gate-ev-1', relativePath, sha256: hash } : null),
    }, { kind: 'agent', participantId: 'worker-a' });

    assert.equal(result.ok, true);
    assert.equal(result.evaluation.evaluator.independence, 'degraded');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }

test('reviewer 与 producer 不同 participant 但共享同一 runnerId 时 independence=degraded（§4.2：runner/model identity 也进入 evaluation，复用 reviewer-independence.js:classifyEvaluatorIndependence，不能只判 participant）', () => {
  const ws = makeWorkspace();
  try {
    const relativePath = 'tasks/item-1/run-1/review-evidence.json';
    const fullPath = join(ws, relativePath);
    mkdirSync(join(ws, 'tasks/item-1/run-1'), { recursive: true });
    const content = JSON.stringify({
      schemaVersion: 'review-evidence-v2',
      verdict: 'passed',
      subjectArtifacts: [{ artifactId: 'subject-1', sha256: 'a'.repeat(64) }],
      findings: [],
    });
    writeFileSync(fullPath, content);
    const hash = sha256(Buffer.from(content, 'utf-8'));

    const result = acceptTaskGateEvidence({
      projectId: 'proj-1',
      taskId: 'proj-1__item-1',
      runId: 'run-1',
      artifactsDir: ws,
      gateEvidenceArtifactId: 'gate-ev-1',
      assignedAgent: 'worker-a',
      reviewerParticipantId: 'reviewer-x',
      producerParticipantId: 'worker-a',
      reviewerRunnerId: 'shared-runner-1',
      producerRunnerId: 'shared-runner-1',
      canonicalArtifactLookup: (id) => (id === 'gate-ev-1' ? { artifactId: 'gate-ev-1', relativePath, sha256: hash } : null),
    }, { kind: 'agent', participantId: 'worker-a' });

    assert.equal(result.ok, true);
    assert.equal(result.evaluation.evaluator.independence, 'degraded');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('reviewer 与 producer 不同 participant 但共享同一 modelFamily 时 independence=degraded', () => {
  const ws = makeWorkspace();
  try {
    const relativePath = 'tasks/item-1/run-1/review-evidence.json';
    const fullPath = join(ws, relativePath);
    mkdirSync(join(ws, 'tasks/item-1/run-1'), { recursive: true });
    const content = JSON.stringify({
      schemaVersion: 'review-evidence-v2',
      verdict: 'passed',
      subjectArtifacts: [{ artifactId: 'subject-1', sha256: 'a'.repeat(64) }],
      findings: [],
    });
    writeFileSync(fullPath, content);
    const hash = sha256(Buffer.from(content, 'utf-8'));

    const result = acceptTaskGateEvidence({
      projectId: 'proj-1',
      taskId: 'proj-1__item-1',
      runId: 'run-1',
      artifactsDir: ws,
      gateEvidenceArtifactId: 'gate-ev-1',
      assignedAgent: 'worker-a',
      reviewerParticipantId: 'reviewer-x',
      producerParticipantId: 'worker-a',
      reviewerModelFamily: 'claude-family',
      producerModelFamily: 'claude-family',
      canonicalArtifactLookup: (id) => (id === 'gate-ev-1' ? { artifactId: 'gate-ev-1', relativePath, sha256: hash } : null),
    }, { kind: 'agent', participantId: 'worker-a' });

    assert.equal(result.ok, true);
    assert.equal(result.evaluation.evaluator.independence, 'degraded');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
});

test('findings 含 blocking finding 时确定性导入为 ReviewConditionV1（§3.4 联动）', () => {
  const ws = makeWorkspace();
  try {
    const relativePath = 'tasks/item-1/run-1/review-evidence.json';
    const fullPath = join(ws, relativePath);
    mkdirSync(join(ws, 'tasks/item-1/run-1'), { recursive: true });
    const content = JSON.stringify({
      schemaVersion: 'review-evidence-v2',
      verdict: 'blocked',
      subjectArtifacts: [{ artifactId: 'subject-1', sha256: 'a'.repeat(64) }],
      findings: [
        {
          id: 'finding-1',
          blocking: true,
          severity: 'high',
          subjectArtifactId: 'subject-1',
          subjectSha256: 'a'.repeat(64),
          description: '数据来源缺少 timestamp',
          requiredEvidence: [{ kind: 'artifact', description: '补充来源 timestamp' }],
        },
      ],
    });
    writeFileSync(fullPath, content);
    const hash = sha256(Buffer.from(content, 'utf-8'));

    const result = acceptTaskGateEvidence({
      projectId: 'proj-1',
      taskId: 'proj-1__item-1',
      runId: 'run-1',
      artifactsDir: ws,
      gateEvidenceArtifactId: 'gate-ev-1',
      assignedAgent: 'worker-a',
      reviewerParticipantId: 'reviewer-x',
      producerParticipantId: 'worker-a',
      canonicalArtifactLookup: (id) => (id === 'gate-ev-1' ? { artifactId: 'gate-ev-1', relativePath, sha256: hash } : null),
    }, { kind: 'agent', participantId: 'worker-a' });

    assert.equal(result.ok, true);
    assert.equal(result.evaluation.verdict, 'blocked');
    assert.equal(result.conditions.length, 1);
    assert.equal(result.conditions[0].schemaVersion, 'review-condition-v1');
    assert.equal(result.conditions[0].findingId, 'finding-1');
    assert.equal(result.conditions[0].blocking, true);
    assert.equal(result.conditions[0].severity, 'high');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('多个候选 artifact 命中同一 endsWith 模式时不再模糊匹配——只认 exact canonical ID（§3.2 步骤 6）', () => {
  const ws = makeWorkspace();
  try {
    // 故意放置两个同名文件在不同目录，模拟旧 endsWith 逻辑可能混淆的场景。
    const relativePath = 'tasks/item-1/run-1/review-evidence.json';
    const decoyPath = 'tasks/item-1/run-0/review-evidence.json';
    mkdirSync(join(ws, 'tasks/item-1/run-1'), { recursive: true });
    mkdirSync(join(ws, 'tasks/item-1/run-0'), { recursive: true });
    const decoyContent = JSON.stringify({ schemaVersion: 'review-evidence-v2', verdict: 'blocked', subjectArtifacts: [], findings: [] });
    writeFileSync(join(ws, decoyPath), decoyContent);
    const realContent = JSON.stringify({ schemaVersion: 'review-evidence-v2', verdict: 'passed', subjectArtifacts: [{ artifactId: 's1', sha256: 'a'.repeat(64) }], findings: [] });
    writeFileSync(join(ws, relativePath), realContent);
    const realHash = sha256(Buffer.from(realContent, 'utf-8'));

    const result = acceptTaskGateEvidence({
      projectId: 'proj-1',
      taskId: 'proj-1__item-1',
      runId: 'run-1',
      artifactsDir: ws,
      gateEvidenceArtifactId: 'gate-ev-1',
      assignedAgent: 'worker-a',
      canonicalArtifactLookup: (id) => (id === 'gate-ev-1' ? { artifactId: 'gate-ev-1', relativePath, sha256: realHash } : null),
    }, { kind: 'agent', participantId: 'worker-a' });

    // 必须解析出 relativePath（run-1）指向的 passed 结果，不能被 decoy（run-0）的 blocked 结果污染。
    assert.equal(result.ok, true);
    assert.equal(result.evaluation.verdict, 'passed');
  } finally {
    rmSync(ws, { recursive: true, force: true });
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
console.log(`\n${passed}/${tests.length} gate-evidence-acceptor tests passed\n`);
if (failed > 0) process.exit(1);
