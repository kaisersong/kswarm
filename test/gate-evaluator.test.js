/**
 * KSwarm — gate-evaluator.js unit tests
 *
 * 设计依据：mydocs/xiaok-cli/design/2026-08-31-collaboration-room-evidence-first-execution-and-gate-design.md v8
 *   §3.3 依赖边分类
 *   §8.2 唯一 gate evaluator
 *
 * 这些是纯函数单元测试，不依赖 hub/board，直接验证 evaluateDependencySatisfaction
 * 对三种 DependencyPolicy（completed / completed_for_remediation / verified_pass）
 * 以及 schema v2 fail-closed 规则的判定是否符合设计文档。
 *
 * Run: node test/gate-evaluator.test.js
 */

import assert from 'node:assert/strict';
import { evaluateDependencySatisfaction } from '../src/core/gate-evaluator.js';

const tests = [];

const currentFacts = {
  sourceRunId: 'run-current',
  evaluationSourceArtifact: { artifactId: 'eval-source', sha256: 'eval-hash' },
  canonicalArtifacts: [
    { taskId: 'review', artifactId: 'a1', sha256: 'hash-a1' },
    { taskId: 'review', artifactId: 'a2', sha256: 'hash-a2' },
  ],
};
const validEvaluation = {
  schemaVersion: 'gate-evaluation-v1',
  sourceArtifactId: 'eval-source',
  sourceArtifactSha256: 'eval-hash',
  sourceRunId: 'run-current',
  subjectArtifacts: [
    { artifactId: 'a1', sha256: 'hash-a1' },
    { artifactId: 'a2', sha256: 'hash-a2' },
  ],
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
function test(name, fn) { tests.push({ name, fn }); }

test('completed policy: satisfied when dependency task is done', () => {
  const result = evaluateDependencySatisfaction({
    task: { id: 't2', dependencies: ['t1'] },
    dependencyTasks: [{ id: 't1', status: 'done' }],
    dependencyPolicies: { t1: 'completed' },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.blockedDependencies, []);
});

test('completed policy: blocked when dependency task is not done', () => {
  const result = evaluateDependencySatisfaction({
    task: { id: 't2', dependencies: ['t1'] },
    dependencyTasks: [{ id: 't1', status: 'pending' }],
    dependencyPolicies: { t1: 'completed' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.blockedDependencies[0].reason, 'dependency_not_completed');
});

test('completed_for_remediation policy: satisfied even when review task result is blocked, as long as it is done', () => {
  const result = evaluateDependencySatisfaction({
    task: { id: 'revision', dependencies: ['review'] },
    dependencyTasks: [{ id: 'review', status: 'done' }],
    dependencyPolicies: { review: 'completed_for_remediation' },
    gateEvaluationsByTaskId: {
      review: [{ verdict: 'blocked', subjectArtifacts: [], evaluator: { independence: 'independent' } }],
    },
  });
  assert.equal(result.ok, true, 'completed_for_remediation 允许 blocked review 派发修订任务');
});

test('verified_pass policy: missing consumed declaration fails closed', () => {
  const result = evaluateDependencySatisfaction({
    task: { id: 'consumer', dependencies: ['review'] },
    dependencyTasks: [{ id: 'review', status: 'done' }],
    dependencyPolicies: { review: 'verified_pass' },
    gateEvaluationsByTaskId: { review: [validEvaluation] },
    currentGateFactsByTaskId: { review: currentFacts },
  });
  assert.equal(result.blockedDependencies[0].reason, 'consumed_artifacts_missing');
});

test('verified_pass policy: current facts are mandatory', () => {
  const result = evaluateDependencySatisfaction({
    task: { id: 'consumer', dependencies: ['review'] },
    dependencyTasks: [{ id: 'review', status: 'done' }],
    dependencyPolicies: { review: 'verified_pass' },
    gateEvaluationsByTaskId: { review: [validEvaluation] },
    consumedArtifactIdsByDependencyTaskId: { review: ['a1'] },
  });
  assert.equal(result.blockedDependencies[0].reason, 'current_gate_facts_missing');
});

test('verified_pass policy: one atomic evaluation must provide independence and complete coverage', () => {
  const result = evaluateDependencySatisfaction({
    task: { id: 'consumer', dependencies: ['review'] },
    dependencyTasks: [{ id: 'review', status: 'done' }],
    dependencyPolicies: { review: 'verified_pass' },
    gateEvaluationsByTaskId: { review: [
      { ...validEvaluation, evaluator: { independence: 'degraded' } },
      { ...validEvaluation, subjectArtifacts: [{ artifactId: 'a1', sha256: 'hash-a1' }] },
    ] },
    consumedArtifactIdsByDependencyTaskId: { review: ['a1', 'a2'] },
    currentGateFactsByTaskId: { review: currentFacts },
  });
  assert.equal(result.ok, false);
});

test('verified_pass policy: exact current GateEvaluationV1 passes', () => {
  const result = evaluateDependencySatisfaction({
    task: { id: 'consumer', dependencies: ['review'] },
    dependencyTasks: [{ id: 'review', status: 'done' }],
    dependencyPolicies: { review: 'verified_pass' },
    gateEvaluationsByTaskId: { review: [validEvaluation] },
    consumedArtifactIdsByDependencyTaskId: { review: ['a1', 'a2'] },
    currentGateFactsByTaskId: { review: currentFacts },
  });
  assert.equal(result.ok, true);
});

for (const [field, reason] of [
  ['schemaVersion', 'evaluation_schema_invalid'],
  ['sourceRunId', 'evaluation_source_run_id_missing'],
  ['sourceArtifactId', 'evaluation_source_artifact_invalid'],
  ['sourceArtifactSha256', 'evaluation_source_artifact_invalid'],
]) {
  test(`verified_pass policy: missing ${field} fails closed`, () => {
    const evaluation = { ...validEvaluation };
    delete evaluation[field];
    const result = evaluateDependencySatisfaction({
      task: { id: 'consumer', dependencies: ['review'] },
      dependencyTasks: [{ id: 'review', status: 'done' }],
      dependencyPolicies: { review: 'verified_pass' },
      gateEvaluationsByTaskId: { review: [evaluation] },
      consumedArtifactIdsByDependencyTaskId: { review: ['a1'] },
      currentGateFactsByTaskId: { review: currentFacts },
    });
    assert.equal(result.blockedDependencies[0].reason, reason);
  });
}

test('verified_pass policy: missing subject artifact id or sha fails closed', () => {
  for (const subject of [{ sha256: 'hash-a1' }, { artifactId: 'a1' }]) {
    const result = evaluateDependencySatisfaction({
      task: { id: 'consumer', dependencies: ['review'] },
      dependencyTasks: [{ id: 'review', status: 'done' }],
      dependencyPolicies: { review: 'verified_pass' },
      gateEvaluationsByTaskId: { review: [{ ...validEvaluation, subjectArtifacts: [subject] }] },
      consumedArtifactIdsByDependencyTaskId: { review: ['a1'] },
      currentGateFactsByTaskId: { review: currentFacts },
    });
    assert.equal(result.blockedDependencies[0].reason, 'evaluation_subject_artifacts_invalid');
  }
});

test('verified_pass policy: stale run, source binding, or subject hash fails closed', () => {
  for (const [evaluation, reason] of [
    [{ ...validEvaluation, sourceRunId: 'superseded-run' }, 'evaluation_source_run_stale'],
    [{ ...validEvaluation, sourceArtifactSha256: 'old-eval-hash' }, 'evaluation_source_artifact_stale'],
    [{ ...validEvaluation, subjectArtifacts: [{ artifactId: 'a1', sha256: 'old-hash' }] }, 'evaluation_subject_artifact_stale'],
  ]) {
    const result = evaluateDependencySatisfaction({
      task: { id: 'consumer', dependencies: ['review'] },
      dependencyTasks: [{ id: 'review', status: 'done' }],
      dependencyPolicies: { review: 'verified_pass' },
      gateEvaluationsByTaskId: { review: [evaluation] },
      consumedArtifactIdsByDependencyTaskId: { review: ['a1'] },
      currentGateFactsByTaskId: { review: currentFacts },
    });
    assert.equal(result.blockedDependencies[0].reason, reason);
  }
});

test('verified_pass policy: complete GateEvaluationV1 metadata is mandatory', () => {
  for (const field of ['reasonCode', 'findingIds', 'conditionIds', 'createdAt']) {
    const evaluation = { ...validEvaluation };
    delete evaluation[field];
    const result = evaluateDependencySatisfaction({
      task: { id: 'consumer', dependencies: ['review'] },
      dependencyTasks: [{ id: 'review', status: 'done' }],
      dependencyPolicies: { review: 'verified_pass' },
      gateEvaluationsByTaskId: { review: [evaluation] },
      consumedArtifactIdsByDependencyTaskId: { review: ['a1'] },
      currentGateFactsByTaskId: { review: currentFacts },
    });
    assert.equal(result.blockedDependencies[0].reason, 'evaluation_schema_invalid', field);
  }
});

test('verified_pass policy: evaluator identity and role are mandatory', () => {
  for (const evaluator of [
    { role: 'independent_reviewer', independence: 'independent' },
    { participantId: 'reviewer-1', independence: 'independent' },
    { participantId: 'reviewer-1', role: 'worker', independence: 'independent' },
  ]) {
    const result = evaluateDependencySatisfaction({
      task: { id: 'consumer', dependencies: ['review'] },
      dependencyTasks: [{ id: 'review', status: 'done' }],
      dependencyPolicies: { review: 'verified_pass' },
      gateEvaluationsByTaskId: { review: [{ ...validEvaluation, evaluator }] },
      consumedArtifactIdsByDependencyTaskId: { review: ['a1'] },
      currentGateFactsByTaskId: { review: currentFacts },
    });
    assert.equal(result.blockedDependencies[0].reason, 'evaluation_evaluator_invalid');
  }
});

test('verified_pass policy: consumed and subject artifact identities must be unique non-empty strings', () => {
  for (const consumedArtifactIds of [[''], ['a1', 'a1'], [1]]) {
    const result = evaluateDependencySatisfaction({
      task: { id: 'consumer', dependencies: ['review'] },
      dependencyTasks: [{ id: 'review', status: 'done' }],
      dependencyPolicies: { review: 'verified_pass' },
      gateEvaluationsByTaskId: { review: [validEvaluation] },
      consumedArtifactIdsByDependencyTaskId: { review: consumedArtifactIds },
      currentGateFactsByTaskId: { review: currentFacts },
    });
    assert.equal(result.blockedDependencies[0].reason, 'consumed_artifacts_invalid');
  }

  const duplicateSubjects = evaluateDependencySatisfaction({
    task: { id: 'consumer', dependencies: ['review'] },
    dependencyTasks: [{ id: 'review', status: 'done' }],
    dependencyPolicies: { review: 'verified_pass' },
    gateEvaluationsByTaskId: {
      review: [{ ...validEvaluation, subjectArtifacts: [validEvaluation.subjectArtifacts[0], validEvaluation.subjectArtifacts[0]] }],
    },
    consumedArtifactIdsByDependencyTaskId: { review: ['a1'] },
    currentGateFactsByTaskId: { review: currentFacts },
  });
  assert.equal(duplicateSubjects.blockedDependencies[0].reason, 'evaluation_subject_artifacts_invalid');
});

test('schema v2: missing dependency policy fails closed (no silent default to completed)', () => {
  const result = evaluateDependencySatisfaction({
    task: { id: 't2', dependencies: ['t1'] },
    dependencyTasks: [{ id: 't1', status: 'done' }],
    dependencyPolicies: {},
    schemaV2: true,
  });
  assert.equal(result.ok, false);
  assert.equal(result.blockedDependencies[0].reason, 'dependency_policy_missing');
});

test('schema v1 legacy: missing dependency policy falls back to completed semantics', () => {
  const result = evaluateDependencySatisfaction({
    task: { id: 't2', dependencies: ['t1'] },
    dependencyTasks: [{ id: 't1', status: 'done' }],
    dependencyPolicies: {},
    schemaV2: false,
  });
  assert.equal(result.ok, true);
});

test('unresolved dependency task (not found in dependencyTasks) is blocked', () => {
  const result = evaluateDependencySatisfaction({
    task: { id: 't2', dependencies: ['ghost'] },
    dependencyTasks: [],
    dependencyPolicies: { ghost: 'completed' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.blockedDependencies[0].reason, 'dependency_task_not_found');
});

test('no dependencies: trivially satisfied', () => {
  const result = evaluateDependencySatisfaction({
    task: { id: 't1', dependencies: [] },
    dependencyTasks: [],
    dependencyPolicies: {},
  });
  assert.equal(result.ok, true);
});

let passed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    passed++;
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(err.message || err);
    process.exitCode = 1;
  }
}
console.log(`\n${passed}/${tests.length} gate-evaluator unit tests passed`);
