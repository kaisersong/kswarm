/**
 * KSwarm — review-condition.js unit tests
 *
 * 设计依据：design §3.4 ReviewCondition：条件清单
 *
 * Run: node test/review-condition.test.js
 */

import assert from 'node:assert/strict';
import {
  buildReviewConditionFromFinding,
  submitConditionEvidence,
  resolveReviewCondition,
  supersedeConditionsForChangedArtifact,
  countOpenBlockingConditions,
} from '../src/core/review-condition.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('buildReviewConditionFromFinding constructs an open condition with service-owned reviewer identity', () => {
  const condition = buildReviewConditionFromFinding({
    projectId: 'proj-1',
    sourceTaskId: 'review-task-1',
    sourceReviewRunId: 'run-1',
    originatingReviewerIdentity: ' reviewer-agent ',
    finding: {
      id: 'f1', blocking: true, severity: 'critical',
      reviewer: 'forged-reviewer', agent: 'forged-agent', owner: { kind: 'task', id: 'owner-task' },
    },
  });
  assert.equal(condition.schemaVersion, 'review-condition-v1');
  assert.equal(condition.status, 'open');
  assert.equal(condition.severity, 'critical');
  assert.equal(condition.originatingReviewerIdentity, 'reviewer-agent');
  assert.deepEqual(condition.owner, { kind: 'task', id: 'owner-task' });
});

test('buildReviewConditionFromFinding returns null for a non-blocking finding (only blocking findings become conditions)', () => {
  const condition = buildReviewConditionFromFinding({
    originatingReviewerIdentity: 'reviewer-agent',
    projectId: 'proj-1',
    sourceTaskId: 'review-task-1',
    sourceReviewRunId: 'run-1',
    finding: { id: 'f2', blocking: false },
  });
  assert.equal(condition, null);
});

test('buildReviewConditionFromFinding is idempotent: same (project, task, run, finding) yields the same conditionId', () => {
  const args = {
    projectId: 'proj-1', sourceTaskId: 'review-task-1', sourceReviewRunId: 'run-1',
    originatingReviewerIdentity: 'reviewer-agent',
    finding: { id: 'f1', blocking: true },
  };
  const first = buildReviewConditionFromFinding(args);
  const second = buildReviewConditionFromFinding(args);
  assert.equal(first.conditionId, second.conditionId);
});

test('buildReviewConditionFromFinding ignores an untrusted user owner claim', () => {
  const condition = buildReviewConditionFromFinding({
    originatingReviewerIdentity: 'reviewer-agent',
    projectId: 'proj-1', sourceTaskId: 'review-task-1', sourceReviewRunId: 'run-1',
    finding: { id: 'f3', blocking: true, owner: { kind: 'user', id: 'user-42' } },
  });
  assert.deepEqual(condition.owner, { kind: 'task', id: 'review-task-1' });
});

test('buildReviewConditionFromFinding accepts a user owner only with service authorization', () => {
  const condition = buildReviewConditionFromFinding({
    originatingReviewerIdentity: 'reviewer-agent',
    allowUserOwner: true,
    projectId: 'proj-1', sourceTaskId: 'review-task-1', sourceReviewRunId: 'run-1',
    finding: { id: 'f3', blocking: true, owner: { kind: 'user', id: 'user-42' } },
  });
  assert.deepEqual(condition.owner, { kind: 'user', id: 'user-42' });
});

test('submitConditionEvidence validates source and normalizes evidence refs', () => {
  const condition = buildReviewConditionFromFinding({
    originatingReviewerIdentity: 'reviewer-agent',
    projectId: 'proj-1', sourceTaskId: 't1', sourceReviewRunId: 'r1', finding: { id: 'f1', blocking: true },
  });
  const result = submitConditionEvidence(condition, {
    requestSource: 'agent', evidenceRefs: [' z ', 'a', 'z'],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.condition.pendingEvidenceRefs, ['a', 'z']);
  assert.equal(result.condition.pendingEvidenceRequestSource, 'agent');
  for (const payload of [
    { requestSource: 'agent', evidenceRefs: [] },
    { requestSource: 'agent', evidenceRefs: [' '] },
    { requestSource: 'agent', evidenceRefs: ['ok', 1] },
    { evidenceRefs: ['ok'] },
    { requestSource: 'unknown', evidenceRefs: ['ok'] },
  ]) assert.equal(submitConditionEvidence(condition, payload).ok, false);
});

test('submitConditionEvidence rejects submission on an already-resolved condition', () => {
  const condition = { status: 'resolved' };
  const result = submitConditionEvidence(condition, { requestSource: 'agent', evidenceRefs: ['proof'] });
  assert.equal(result.ok, false);
});

// design §3.4：reviewer 提出条件，但不能自行将自己提出的条件标记 resolved。
test('[SECURITY] resolveReviewCondition rejects self-resolution by the reviewer who raised the condition', () => {
  const condition = buildReviewConditionFromFinding({
    originatingReviewerIdentity: 'reviewer-agent',
    projectId: 'proj-1', sourceTaskId: 'reviewer-task-1', sourceReviewRunId: 'r1', finding: { id: 'f1', blocking: true },
  });
  const result = resolveReviewCondition(condition, {
    verifiedBy: 'reviewer-agent', requestSource: 'agent', evidenceRefs: ['artifact:proof'],
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'condition_self_resolution_forbidden');
});

test('resolveReviewCondition allows a different verifier (independent verification) to resolve a task-owned condition', () => {
  const condition = buildReviewConditionFromFinding({
    originatingReviewerIdentity: 'reviewer-agent',
    projectId: 'proj-1', sourceTaskId: 'reviewer-task-1', sourceReviewRunId: 'r1', finding: { id: 'f1', blocking: true },
  });
  const result = resolveReviewCondition(condition, {
    verifiedBy: 'independent-agent', evidenceRefs: [' z ', 'artifact:new-hash.json', 'z'], requestSource: 'agent',
  });
  assert.equal(result.ok, true);
  assert.equal(result.condition.status, 'resolved');
  assert.equal(result.condition.resolution.verifiedBy, 'independent-agent');
  assert.equal(result.condition.resolution.requestSource, 'agent');
  assert.deepEqual(result.condition.resolution.evidenceRefs, ['artifact:new-hash.json', 'z']);
});

// design §3.4：user-owned 条件只能由用户动作满足。
test('[SECURITY] resolveReviewCondition rejects an agent trying to resolve a user-owned condition', () => {
  const condition = buildReviewConditionFromFinding({
    originatingReviewerIdentity: 'reviewer-agent',
    allowUserOwner: true,
    projectId: 'proj-1', sourceTaskId: 'reviewer-task-1', sourceReviewRunId: 'r1',
    finding: { id: 'f1', blocking: true, owner: { kind: 'user', id: 'user-1' } },
  });
  const result = resolveReviewCondition(condition, {
    verifiedBy: 'some-agent', requestSource: 'agent', evidenceRefs: ['artifact:proof'],
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'user_owned_condition_requires_user_action');
});

test('resolveReviewCondition allows a user action to resolve a user-owned condition', () => {
  const condition = buildReviewConditionFromFinding({
    originatingReviewerIdentity: 'reviewer-agent',
    allowUserOwner: true,
    projectId: 'proj-1', sourceTaskId: 'reviewer-task-1', sourceReviewRunId: 'r1',
    finding: { id: 'f1', blocking: true, owner: { kind: 'user', id: 'user-1' } },
  });
  const result = resolveReviewCondition(condition, {
    verifiedBy: 'user-1', requestSource: 'user', evidenceRefs: ['room-message:approval'],
  });
  assert.equal(result.ok, true);
  assert.equal(result.condition.status, 'resolved');
});

test('resolveReviewCondition rejects resolving an already-superseded condition', () => {
  const condition = {
    status: 'superseded', originatingReviewerIdentity: 'reviewer', sourceTaskId: 't1', owner: { kind: 'task', id: 't1' },
  };
  const result = resolveReviewCondition(condition, {
    verifiedBy: 'someone-else', requestSource: 'agent', evidenceRefs: ['proof'],
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'condition_superseded_cannot_resolve');
});

test('resolveReviewCondition fails closed for legacy records missing reviewer identity', () => {
  const condition = { status: 'open', sourceTaskId: 't1', owner: { kind: 'task', id: 't1' } };
  const result = resolveReviewCondition(condition, {
    verifiedBy: 'someone-else', requestSource: 'agent', evidenceRefs: ['proof'],
  });
  assert.deepEqual(result, { ok: false, error: 'originating_reviewer_identity_required' });
});

test('resolveReviewCondition only accepts exact normalized replay and rejects conflicts without mutation', () => {
  const condition = {
    status: 'resolved', originatingReviewerIdentity: 'reviewer-agent', sourceTaskId: 't1',
    owner: { kind: 'task', id: 't1' },
    resolution: {
      verifiedBy: 'verifier-agent', requestSource: 'agent', evidenceRefs: ['a', 'z'],
      verifiedAt: '2026-01-01T00:00:00.000Z',
    },
  };
  const snapshot = structuredClone(condition);
  const replay = resolveReviewCondition(condition, {
    verifiedBy: 'verifier-agent', requestSource: 'agent', evidenceRefs: [' z ', 'a', 'a'],
  });
  assert.equal(replay.ok, true);
  assert.equal(replay.alreadyResolved, true);
  assert.equal(replay.condition, condition);
  for (const payload of [
    { verifiedBy: 'other', requestSource: 'agent', evidenceRefs: ['a', 'z'] },
    { verifiedBy: 'verifier-agent', requestSource: 'system_reconciler', evidenceRefs: ['a', 'z'] },
    { verifiedBy: 'verifier-agent', requestSource: 'agent', evidenceRefs: ['different'] },
  ]) assert.deepEqual(resolveReviewCondition(condition, payload), { ok: false, error: 'idempotency_conflict' });
  assert.deepEqual(condition, snapshot);
});

test('resolveReviewCondition rejects missing/unknown source and invalid evidence', () => {
  const condition = buildReviewConditionFromFinding({
    projectId: 'p', sourceTaskId: 'task', sourceReviewRunId: 'run',
    originatingReviewerIdentity: 'reviewer', finding: { id: 'f', blocking: true },
  });
  for (const payload of [
    { verifiedBy: 'verifier', evidenceRefs: ['proof'] },
    { verifiedBy: 'verifier', requestSource: 'unknown', evidenceRefs: ['proof'] },
    { verifiedBy: 'verifier', requestSource: 'agent', evidenceRefs: [] },
    { verifiedBy: 'verifier', requestSource: 'agent', evidenceRefs: [' '] },
    { verifiedBy: 'verifier', requestSource: 'agent', evidenceRefs: [42] },
  ]) assert.equal(resolveReviewCondition(condition, payload).ok, false);
});

// design §3.4：artifact hash 变化时，指向旧版本的 resolved condition 自动 superseded。
test('supersedeConditionsForChangedArtifact marks a resolved condition bound to the changed artifact as superseded', () => {
  const resolvedCondition = {
    status: 'resolved',
    resolution: { verifiedBy: 'v1', evidenceRefs: ['artifact:artifact-123'], verifiedAt: '2026-01-01T00:00:00Z' },
  };
  const [updated] = supersedeConditionsForChangedArtifact([resolvedCondition], { changedArtifactId: 'artifact-123', changedSha256: 'newhash' });
  assert.equal(updated.status, 'superseded');
  assert.equal(updated.supersededReason, 'artifact_hash_changed');
});

test('supersedeConditionsForChangedArtifact does not touch conditions unrelated to the changed artifact', () => {
  const resolvedCondition = {
    status: 'resolved',
    resolution: { verifiedBy: 'v1', evidenceRefs: ['artifact:other-artifact'], verifiedAt: '2026-01-01T00:00:00Z' },
  };
  const [updated] = supersedeConditionsForChangedArtifact([resolvedCondition], { changedArtifactId: 'artifact-123', changedSha256: 'newhash' });
  assert.equal(updated.status, 'resolved', 'unrelated condition must not be superseded');
});

test('supersedeConditionsForChangedArtifact does not touch open/evidence_submitted conditions', () => {
  const openCondition = { status: 'open' };
  const [updated] = supersedeConditionsForChangedArtifact([openCondition], { changedArtifactId: 'artifact-123', changedSha256: 'newhash' });
  assert.equal(updated.status, 'open');
});

// design §3.2/§8.2：blocking condition 不为零时，相关 GateEvaluation 不得为 passed。
test('countOpenBlockingConditions counts only open/evidence_submitted blocking conditions', () => {
  const conditions = [
    { blocking: true, status: 'open' },
    { blocking: true, status: 'evidence_submitted' },
    { blocking: true, status: 'resolved' },
    { blocking: true, status: 'superseded' },
    { blocking: false, status: 'open' },
  ];
  assert.equal(countOpenBlockingConditions(conditions), 2);
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
  }
}
console.log(`\n${passed}/${tests.length} review-condition tests passed`);
if (passed !== tests.length) process.exitCode = 1;
