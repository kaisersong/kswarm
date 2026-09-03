/**
 * KSwarm — reviewer-independence.js unit tests
 *
 * 设计依据：design §4.2 独立性约束
 *
 * Run: node test/reviewer-independence.test.js
 */

import assert from 'node:assert/strict';
import {
  isReviewerExcludedAtPlanningTime,
  classifyEvaluatorIndependence,
  rejectReviewerIfSoleCriticalProducer,
  buildNoIndependentReviewerGate,
} from '../src/core/reviewer-independence.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('[SECURITY] a reviewer cannot be the same as the author at planning time', () => {
  const result = isReviewerExcludedAtPlanningTime({ reviewerId: 'agent-1', authorId: 'agent-1', poId: 'po-1' });
  assert.equal(result.excluded, true);
  assert.equal(result.reasonCode, 'reviewer_is_author');
});

test('[SECURITY] a reviewer cannot be the PO at planning time', () => {
  const result = isReviewerExcludedAtPlanningTime({ reviewerId: 'po-1', authorId: 'agent-1', poId: 'po-1' });
  assert.equal(result.excluded, true);
  assert.equal(result.reasonCode, 'reviewer_is_po');
});

test('a distinct reviewer is not excluded at planning time', () => {
  const result = isReviewerExcludedAtPlanningTime({ reviewerId: 'reviewer-1', authorId: 'agent-1', poId: 'po-1' });
  assert.equal(result.excluded, false);
});

test('[SECURITY] same participant is classified as degraded independence', () => {
  const result = classifyEvaluatorIndependence({
    reviewerParticipantId: 'agent-1', producerParticipantId: 'agent-1',
  });
  assert.equal(result.independence, 'degraded');
  assert.equal(result.reasonCode, 'same_participant');
});

test('[SECURITY] different participants but the same runner are classified as degraded independence', () => {
  const result = classifyEvaluatorIndependence({
    reviewerParticipantId: 'agent-1', producerParticipantId: 'agent-2',
    reviewerRunnerId: 'runner-shared', producerRunnerId: 'runner-shared',
  });
  assert.equal(result.independence, 'degraded');
  assert.equal(result.reasonCode, 'same_runner');
});

test('[SECURITY] different participants but the same model family are classified as degraded independence', () => {
  const result = classifyEvaluatorIndependence({
    reviewerParticipantId: 'agent-1', producerParticipantId: 'agent-2',
    reviewerModelFamily: 'claude-opus', producerModelFamily: 'claude-opus',
  });
  assert.equal(result.independence, 'degraded');
  assert.equal(result.reasonCode, 'same_model_family');
});

test('different participant, different runner, different model family is classified as independent', () => {
  const result = classifyEvaluatorIndependence({
    reviewerParticipantId: 'agent-1', producerParticipantId: 'agent-2',
    reviewerRunnerId: 'runner-a', producerRunnerId: 'runner-b',
    reviewerModelFamily: 'claude', producerModelFamily: 'gpt',
  });
  assert.equal(result.independence, 'independent');
});

// design §4.2："上游关键证据 producer" 在 dispatch 时判定。
test('[SECURITY] a reviewer who is the sole producer of a subject artifact is rejected at dispatch time', () => {
  const result = rejectReviewerIfSoleCriticalProducer({
    reviewerId: 'agent-1',
    subjectArtifacts: [{ artifactId: 'a1', producedBy: ['agent-1'] }],
  });
  assert.equal(result.rejected, true);
  assert.equal(result.reasonCode, 'reviewer_is_sole_critical_producer');
  assert.equal(result.artifactId, 'a1');
});

test('a reviewer who co-produced an artifact with someone else is not rejected (not the sole producer)', () => {
  const result = rejectReviewerIfSoleCriticalProducer({
    reviewerId: 'agent-1',
    subjectArtifacts: [{ artifactId: 'a1', producedBy: ['agent-1', 'agent-2'] }],
  });
  assert.equal(result.rejected, false);
});

test('a reviewer unrelated to any subject artifact producer is not rejected', () => {
  const result = rejectReviewerIfSoleCriticalProducer({
    reviewerId: 'reviewer-1',
    subjectArtifacts: [{ artifactId: 'a1', producedBy: ['agent-1'] }],
  });
  assert.equal(result.rejected, false);
});

test('rejectReviewerIfSoleCriticalProducer requires a reviewerId', () => {
  const result = rejectReviewerIfSoleCriticalProducer({ subjectArtifacts: [] });
  assert.equal(result.rejected, true);
  assert.equal(result.reasonCode, 'reviewer_id_required');
});

test('buildNoIndependentReviewerGate reuses the existing waiting_for_capable_agent gate with the correct reasonCode', () => {
  const gate = buildNoIndependentReviewerGate();
  assert.equal(gate.gate, 'waiting_for_capable_agent');
  assert.equal(gate.reasonCode, 'no_independent_reviewer');
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
console.log(`\n${passed}/${tests.length} reviewer-independence tests passed`);
if (passed !== tests.length) process.exitCode = 1;
