/**
 * KSwarm — evaluatePreApprovalPrerequisites（design §8.2/§8.3，唯一 gate evaluator 三件套之二）
 *
 * 设计依据：mydocs/xiaok-cli/design/2026-08-31-collaboration-room-evidence-first-execution-and-gate-design.md v8
 *   §8.3 最终交付 —— "evaluatePreApprovalPrerequisites 只读取候选 FinalDeliverable、
 *   tasks、conditions、project blockers 和 fresh HydratedGateFactsV1，不读取当前
 *   ReviewGateDecision、raw task result 或磁盘，产生带 project revision、manifest
 *   revision、final artifact hash 和输入 ID/hash 集合的不可变 projectGateSnapshot"
 *
 *   最终状态收敛清单（§8.3 开头）：
 *   - 无 open blocking condition、无项目级 blocker、无 pending plan revision
 *   - 对应 ReviewGateDecision 未涉及（那是提交后才写的，本函数不读取）
 *   - approveFinalDeliverable 实时计算的 service hash 与 final verification 的
 *     subject artifact hash 完全一致（本函数用 hydratedGateFacts.currentArtifacts
 *     里已经算好的 containmentPassed/serviceSha256，不重新读盘复算）
 *   - 所有 final-required gate tasks 对该 hash 有 fresh GateEvaluation(passed)
 *
 * §8.2 三个纯函数的共同约束：绝不读盘、绝不复算 hash、绝不读取 raw task.result。
 *
 * Run: node test/evaluate-pre-approval-prerequisites.test.js
 */

import assert from 'node:assert/strict';
import { evaluatePreApprovalPrerequisites } from '../src/core/gate-evaluator.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function baseHydratedFacts(overrides = {}) {
  return {
    schemaVersion: 'hydrated-gate-facts-v1',
    projectId: 'proj-1',
    projectLifecycleVersion: 1,
    hydratedAt: new Date().toISOString(),
    manifestRevision: 1,
    currentArtifacts: [{ artifactId: 'a1', canonicalRelativePath: 'artifacts/a1.md', serviceSha256: 'h1', manifestSha256: 'h1', containmentPassed: true }],
    derivedGateEvaluations: [],
    deterministicCheckResults: [],
    ...overrides,
  };
}

function baseFinalDeliverable(overrides = {}) {
  return {
    deliverableId: 'fd-1',
    projectId: 'proj-1',
    status: 'candidate',
    kind: 'file',
    artifactRef: { artifactId: 'a1', sha256: 'h1' },
    ...overrides,
  };
}

test('open blocking condition 存在时 fail closed', () => {
  const result = evaluatePreApprovalPrerequisites({
    project: { id: 'proj-1', lifecycleVersion: 1 },
    tasks: [],
    conditions: [{ conditionId: 'c1', blocking: true, status: 'open' }],
    finalDeliverable: baseFinalDeliverable(),
    hydratedGateFacts: baseHydratedFacts(),
    projectBlockers: [],
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'open_blocking_condition');
});

test('存在项目级 blocker 时 fail closed', () => {
  const result = evaluatePreApprovalPrerequisites({
    project: { id: 'proj-1', lifecycleVersion: 1 },
    tasks: [],
    conditions: [],
    finalDeliverable: baseFinalDeliverable(),
    hydratedGateFacts: baseHydratedFacts(),
    projectBlockers: [{ kind: 'waiting_for_capable_agent' }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'project_blocker_present');
});

test('存在 pending plan revision 时 fail closed', () => {
  const result = evaluatePreApprovalPrerequisites({
    project: { id: 'proj-1', lifecycleVersion: 1, planRevisionRequired: { taskId: 't1' } },
    tasks: [],
    conditions: [],
    finalDeliverable: baseFinalDeliverable(),
    hydratedGateFacts: baseHydratedFacts(),
    projectBlockers: [],
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'plan_revision_required');
});

test('finalDeliverable 引用的 artifact containmentPassed=false（hash 不一致）时 fail closed', () => {
  const result = evaluatePreApprovalPrerequisites({
    project: { id: 'proj-1', lifecycleVersion: 1 },
    tasks: [],
    conditions: [],
    finalDeliverable: baseFinalDeliverable(),
    hydratedGateFacts: baseHydratedFacts({
      currentArtifacts: [{ artifactId: 'a1', canonicalRelativePath: 'artifacts/a1.md', serviceSha256: 'tampered', manifestSha256: 'h1', containmentPassed: false }],
    }),
    projectBlockers: [],
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'final_artifact_hash_mismatch');
});

test('finalDeliverable 引用的 artifact 不在 hydratedGateFacts.currentArtifacts 中（未被 hydrate）时 fail closed', () => {
  const result = evaluatePreApprovalPrerequisites({
    project: { id: 'proj-1', lifecycleVersion: 1 },
    tasks: [],
    conditions: [],
    finalDeliverable: baseFinalDeliverable({ artifactRef: { artifactId: 'not-hydrated', sha256: 'h1' } }),
    hydratedGateFacts: baseHydratedFacts(),
    projectBlockers: [],
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'final_artifact_not_hydrated');
});

test('final-required gate task（有 review_iteration_v2 evidenceContract 的 task）缺 fresh GateEvaluation(passed) 时 fail closed', () => {
  const result = evaluatePreApprovalPrerequisites({
    project: { id: 'proj-1', lifecycleVersion: 1 },
    tasks: [
      { id: 't1', status: 'done', evidenceContract: { kind: 'review_iteration_v2' } },
    ],
    conditions: [],
    finalDeliverable: baseFinalDeliverable(),
    hydratedGateFacts: baseHydratedFacts({ derivedGateEvaluations: [] }),
    projectBlockers: [],
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'final_required_gate_task_missing_evaluation');
  assert.deepEqual(result.missingTaskIds, ['t1']);
});

test('final-required gate task 有 fresh GateEvaluation(verdict=passed) 时通过，产出不可变 projectGateSnapshot', () => {
  const result = evaluatePreApprovalPrerequisites({
    project: { id: 'proj-1', lifecycleVersion: 7 },
    tasks: [
      { id: 't1', status: 'done', evidenceContract: { kind: 'review_iteration_v2' } },
    ],
    conditions: [],
    finalDeliverable: baseFinalDeliverable(),
    hydratedGateFacts: baseHydratedFacts({
      projectLifecycleVersion: 7,
      derivedGateEvaluations: [
        { schemaVersion: 'gate-evaluation-v1', sourceArtifactId: 'gate-ev-1', sourceArtifactSha256: 'h', sourceRunId: 'r1', subjectArtifacts: [{ artifactId: 'a1', sha256: 'h1' }], verdict: 'passed', reasonCode: 'ok', findingIds: [], conditionIds: [], evaluator: { participantId: 'x', role: 'independent_reviewer', independence: 'independent' }, createdAt: new Date().toISOString() },
      ],
    }),
    projectBlockers: [],
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(result.snapshot, 'must produce a projectGateSnapshot');
  assert.equal(result.snapshot.projectId, 'proj-1');
  assert.equal(result.snapshot.projectLifecycleVersion, 7);
  assert.equal(result.snapshot.manifestRevision, 1);
  assert.equal(result.snapshot.finalDeliverableId, 'fd-1');
  assert.equal(result.snapshot.finalArtifactSha256, 'h1');
  assert.ok(Object.isFrozen(result.snapshot), 'projectGateSnapshot must be immutable (Object.freeze)');
});

test('final-required gate task 有 GateEvaluation 但 verdict=blocked 时 fail closed（不是缺失而是明确失败）', () => {
  const result = evaluatePreApprovalPrerequisites({
    project: { id: 'proj-1', lifecycleVersion: 1 },
    tasks: [
      { id: 't1', status: 'done', evidenceContract: { kind: 'review_iteration_v2' } },
    ],
    conditions: [],
    finalDeliverable: baseFinalDeliverable(),
    hydratedGateFacts: baseHydratedFacts({
      derivedGateEvaluations: [
        { schemaVersion: 'gate-evaluation-v1', sourceArtifactId: 'gate-ev-1', sourceArtifactSha256: 'h', sourceRunId: 'r1', subjectArtifacts: [{ artifactId: 'a1', sha256: 'h1' }], verdict: 'blocked', reasonCode: 'issue_found', findingIds: ['f1'], conditionIds: [], evaluator: { participantId: 'x', role: 'independent_reviewer', independence: 'independent' }, createdAt: new Date().toISOString() },
      ],
    }),
    projectBlockers: [],
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'final_required_gate_task_evaluation_failed');
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
console.log(`\n${passed}/${tests.length} evaluatePreApprovalPrerequisites tests passed\n`);
if (failed > 0) process.exit(1);
