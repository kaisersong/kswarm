/**
 * KSwarm — verifyCommittedReviewGateDecision（design §8.3 步骤 3，唯一 gate evaluator 三件套之三）
 *
 * 设计依据：mydocs/xiaok-cli/design/2026-08-31-collaboration-room-evidence-first-execution-and-gate-design.md v8
 *   §8.3 —— "提交后 verifyCommittedReviewGateDecision 校验 decision、snapshot、当前
 *   revision/hash 的一致性。任何漂移使 read model 返回不可关闭，并要求重做批准，
 *   不能递归调用 pre-approval evaluator。"
 *
 *   §8.2 三个纯函数共同约束：绝不读盘、绝不复算 hash、绝不读取 raw task.result。
 *   本函数只比对已经存在的三份数据（committed decision / preApprovalSnapshot /
 *   fresh hydratedGateFacts）是否一致，不重新调用 evaluatePreApprovalPrerequisites。
 *
 * Run: node test/verify-committed-review-gate-decision.test.js
 */

import assert from 'node:assert/strict';
import { verifyCommittedReviewGateDecision } from '../src/core/gate-evaluator.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function baseSnapshot(overrides = {}) {
  return Object.freeze({
    schemaVersion: 'project-gate-snapshot-v1',
    projectId: 'proj-1',
    projectLifecycleVersion: 7,
    manifestRevision: 3,
    finalDeliverableId: 'fd-1',
    finalArtifactSha256: 'h1',
    inputConditionIds: [],
    inputTaskIds: ['t1'],
    createdAt: new Date().toISOString(),
    ...overrides,
  });
}

function baseDecision(overrides = {}) {
  return {
    schemaVersion: 'review-gate-decision-v1',
    projectId: 'proj-1',
    finalDeliverableId: 'fd-1',
    decision: 'passed',
    snapshotId: 'snap-1',
    projectGateSnapshotRef: baseSnapshot(),
    autoCloseAllowed: true,
    ...overrides,
  };
}

function baseHydratedFacts(overrides = {}) {
  return {
    schemaVersion: 'hydrated-gate-facts-v1',
    projectId: 'proj-1',
    projectLifecycleVersion: 7,
    manifestRevision: 3,
    currentArtifacts: [{ artifactId: 'a1', canonicalRelativePath: 'artifacts/a1.md', serviceSha256: 'h1', manifestSha256: 'h1', containmentPassed: true }],
    derivedGateEvaluations: [],
    deterministicCheckResults: [],
    ...overrides,
  };
}

test('缺失 reviewGateDecision/preApprovalSnapshot/hydratedGateFacts 任一参数时 fail closed', () => {
  const result = verifyCommittedReviewGateDecision({ project: { id: 'proj-1' } });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'missing_required_input');
});

test('decision.projectGateSnapshotRef 与传入的 preApprovalSnapshot 不是同一个快照（finalDeliverableId 不一致）时判定漂移', () => {
  const result = verifyCommittedReviewGateDecision({
    project: { id: 'proj-1' },
    reviewGateDecision: baseDecision({ projectGateSnapshotRef: baseSnapshot({ finalDeliverableId: 'fd-different' }) }),
    preApprovalSnapshot: baseSnapshot(),
    hydratedGateFacts: baseHydratedFacts(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'snapshot_drift');
});

test('fresh hydratedGateFacts.projectLifecycleVersion 与 snapshot 中锁定的版本不一致（项目在批准后又发生了变化）时判定漂移', () => {
  const result = verifyCommittedReviewGateDecision({
    project: { id: 'proj-1' },
    reviewGateDecision: baseDecision(),
    preApprovalSnapshot: baseSnapshot(),
    hydratedGateFacts: baseHydratedFacts({ projectLifecycleVersion: 8 }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'lifecycle_version_drift');
});

test('fresh hydratedGateFacts.manifestRevision 与 snapshot 中锁定的版本不一致时判定漂移', () => {
  const result = verifyCommittedReviewGateDecision({
    project: { id: 'proj-1' },
    reviewGateDecision: baseDecision(),
    preApprovalSnapshot: baseSnapshot(),
    hydratedGateFacts: baseHydratedFacts({ manifestRevision: 4 }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'manifest_revision_drift');
});

test('fresh hydratedGateFacts 中 final artifact 的当前 hash 与 snapshot 锁定的 finalArtifactSha256 不一致时判定漂移（批准后文件被篡改）', () => {
  const result = verifyCommittedReviewGateDecision({
    project: { id: 'proj-1' },
    reviewGateDecision: baseDecision(),
    preApprovalSnapshot: baseSnapshot(),
    hydratedGateFacts: baseHydratedFacts({
      currentArtifacts: [{ artifactId: 'a1', canonicalRelativePath: 'artifacts/a1.md', serviceSha256: 'tampered-after-approval', manifestSha256: 'h1', containmentPassed: true }],
    }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'final_artifact_hash_drift');
});

test('decision.decision !== "passed" 时不可关闭（未 passing 的 decision 不能被消费为可关闭）', () => {
  const result = verifyCommittedReviewGateDecision({
    project: { id: 'proj-1' },
    reviewGateDecision: baseDecision({ decision: 'blocked' }),
    preApprovalSnapshot: baseSnapshot(),
    hydratedGateFacts: baseHydratedFacts(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'decision_not_passing');
});

test('一切一致且 decision=passed 时通过，返回 canAutoClose 与 decision.autoCloseAllowed 一致', () => {
  const result = verifyCommittedReviewGateDecision({
    project: { id: 'proj-1' },
    reviewGateDecision: baseDecision(),
    preApprovalSnapshot: baseSnapshot(),
    hydratedGateFacts: baseHydratedFacts(),
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.canAutoClose, true);
});

test('decision.autoCloseAllowed=false 时即使一切一致也不可自动关闭', () => {
  const result = verifyCommittedReviewGateDecision({
    project: { id: 'proj-1' },
    reviewGateDecision: baseDecision({ autoCloseAllowed: false }),
    preApprovalSnapshot: baseSnapshot(),
    hydratedGateFacts: baseHydratedFacts(),
  });
  assert.equal(result.ok, true);
  assert.equal(result.canAutoClose, false);
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
console.log(`\n${passed}/${tests.length} verifyCommittedReviewGateDecision tests passed\n`);
if (failed > 0) process.exit(1);
