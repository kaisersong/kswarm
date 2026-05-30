/**
 * KSwarm — workflow acceptance rubric and gate reducer contract tests
 *
 * Run: node test/workflow-acceptance-rubric.test.js
 */

import assert from 'node:assert/strict';
import {
  reduceWorkflowGate,
  validateAcceptanceRubric,
  validateWorkflowGateDecision,
} from '../src/core/workflow-spec.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function validRubric(overrides = {}) {
  return {
    id: 'report-final-review-v1',
    title: '报告终审验收标准',
    machineChecks: [
      {
        id: 'artifact_exists',
        title: '报告文件存在',
        checkKind: 'file_exists',
        required: true,
        inputRefs: ['final_report_path'],
      },
      {
        id: 'renderer_metadata',
        title: 'renderer metadata 可验证',
        checkKind: 'renderer_metadata',
        required: true,
        inputRefs: ['final_report_path'],
      },
    ],
    judgmentChecks: [
      {
        id: 'claim_evidence',
        title: '关键结论有来源支撑',
        prompt: '检查报告中的关键结论是否有独立来源或项目证据支撑。',
        evidenceRequired: true,
        reviewerCount: 2,
        required: true,
      },
    ],
    disagreementPolicy: 'adversarial_review',
    ...overrides,
  };
}

test('accepts rubric with machine checks and evidence-required judgment checks', () => {
  const result = validateAcceptanceRubric(validRubric(), { workflowKind: 'artifact' });

  assert.equal(result.ok, true);
  assert.equal(result.normalized.requiredMachineCheckIds.length, 2);
  assert.deepEqual(result.normalized.requiredJudgmentCheckIds, ['claim_evidence']);
});

test('rejects artifact workflow rubric without required machine check', () => {
  const result = validateAcceptanceRubric(validRubric({
    machineChecks: [{ id: 'optional_schema', title: '可选结构检查', checkKind: 'schema', required: false, inputRefs: ['artifact'] }],
  }), { workflowKind: 'artifact' });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'required_machine_check_required');
});

test('rejects judgment checks that can gate pass without evidence', () => {
  const rubric = validRubric();
  rubric.judgmentChecks[0].evidenceRequired = false;

  const result = validateAcceptanceRubric(rubric, { workflowKind: 'artifact' });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'judgment_evidence_required');
  assert.equal(result.checkId, 'claim_evidence');
});

test('returns needs_rubric_clarification for contradictory or unmapped rubric', () => {
  const contradictory = validateAcceptanceRubric(validRubric({
    machineChecks: [
      { id: 'artifact_exists', title: '报告文件存在', checkKind: 'file_exists', required: true, inputRefs: ['final_report_path'] },
      { id: 'artifact_exists', title: '重复检查', checkKind: 'schema', required: true, inputRefs: ['final_report_path'] },
    ],
  }), { workflowKind: 'artifact' });

  assert.equal(contradictory.ok, false);
  assert.equal(contradictory.error, 'rubric_duplicate_check_id');
  assert.equal(contradictory.decision.status, 'needs_rubric_clarification');
});

test('gate reducer never lets reviewer majority override required machine check failure', () => {
  const gate = reduceWorkflowGate({
    rubric: validRubric(),
    machineResults: [
      { id: 'artifact_exists', status: 'passed' },
      { id: 'renderer_metadata', status: 'failed', reason: 'metadata missing' },
    ],
    judgmentResults: [
      { id: 'claim_evidence', status: 'passed', reviewerId: 'reviewer-a', evidenceRefs: ['artifact:report'] },
      { id: 'claim_evidence', status: 'passed', reviewerId: 'reviewer-b', evidenceRefs: ['artifact:report'] },
    ],
  });

  assert.equal(gate.status, 'blocked');
  assert.match(gate.reason, /renderer_metadata/);
  assert.equal(gate.failedMachineChecks[0].id, 'renderer_metadata');
});

test('gate reducer sends reviewer disagreement to adversarial review instead of silent pass', () => {
  const gate = reduceWorkflowGate({
    rubric: validRubric(),
    machineResults: [
      { id: 'artifact_exists', status: 'passed' },
      { id: 'renderer_metadata', status: 'passed' },
    ],
    judgmentResults: [
      { id: 'claim_evidence', status: 'passed', reviewerId: 'reviewer-a', evidenceRefs: ['artifact:report'] },
      { id: 'claim_evidence', status: 'needs_rework', reviewerId: 'reviewer-b', reason: '关键结论缺证据', evidenceRefs: ['artifact:report'] },
    ],
  });

  assert.equal(gate.status, 'needs_rework');
  assert.equal(gate.nextAction, 'adversarial_review');
  assert.match(gate.reason, /claim_evidence/);
});

test('validates expanded gate decision statuses', () => {
  for (const status of ['passed', 'needs_rework', 'needs_replanning', 'needs_rubric_clarification', 'blocked']) {
    const result = validateWorkflowGateDecision({ status, reason: `${status} reason`, evidenceRefs: [] });
    assert.equal(result.ok, true, status);
  }

  const invalid = validateWorkflowGateDecision({ status: 'failed', reason: 'old status' });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error, 'gate_decision_status_invalid');
});

let passed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    passed++;
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(err);
    process.exitCode = 1;
    break;
  }
}
if (process.exitCode !== 1) console.log(`\n${passed}/${tests.length} workflow acceptance rubric tests passed`);
