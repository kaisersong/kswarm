/**
 * KSwarm — execution/evidence contract tests
 *
 * Run: node test/execution-contract.test.js
 */

import assert from 'node:assert/strict';
import {
  enrichTaskWithExecutionContract,
  inferExecutionContract,
  validateTaskResultAgainstContract,
} from '../src/core/execution-contract.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('review tasks receive a structured evidence contract', () => {
  const task = enrichTaskWithExecutionContract({
    id: 'review-slides',
    title: '对技术大会演讲报告做质量评审',
    brief: '检查报告是否满足演讲目标并给出修改建议',
    assignedAgent: 'reviewer',
  });

  assert.equal(task.evidenceContract.kind, 'review_iteration_v1');
  assert.equal(task.executionContract.minSummaryChars, 50);
  assert.ok(task.evidenceContract.requiredArtifacts.includes('review-evidence.json'));
  assert.ok(task.evidenceContract.requiredFields.includes('verdict'));
  assert.ok(task.evidenceContract.requiredFields.includes('findings'));
});

test('plain deliverable tasks still reject empty or placeholder results', () => {
  const contract = inferExecutionContract({
    id: 'draft-report',
    title: '生成技术大会演讲报告初稿',
    brief: '输出可直接审阅的报告',
  });

  const empty = validateTaskResultAgainstContract(contract.task, { summary: 'done', artifacts: [] });
  assert.equal(empty.ok, false);
  assert.equal(empty.failureClass, 'quality_evidence_missing');
  assert.ok(empty.errors.some(e => e.includes('summary')));
});

test('review evidence must include verdict and findings before acceptance', () => {
  const task = enrichTaskWithExecutionContract({
    id: 'review-slides',
    title: '质量评审：技术大会演讲报告',
    assignedAgent: 'reviewer',
  });

  const missing = validateTaskResultAgainstContract(task, {
    summary: '完成评审，整体还可以。',
    artifacts: [{ name: 'notes.md', path: 'notes.md' }],
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.failureClass, 'quality_evidence_missing');
  assert.ok(missing.errors.some(e => e.includes('review-evidence.json')));
  assert.ok(missing.errors.some(e => e.includes('verdict')));

  const valid = validateTaskResultAgainstContract(task, {
    summary: '完成质量评审，已覆盖结构、事实、受众匹配、可执行修改意见和最终判断，确认产物具备进入下一阶段的依据。',
    artifacts: [{ name: 'review-evidence.json', path: 'review-evidence.json' }],
    reviewEvidence: {
      verdict: 'pass',
      findings: [
        { severity: 'minor', message: '标题页需要更明确的技术主题。' },
      ],
    },
  });
  assert.equal(valid.ok, true);
});

test('contract validation accepts artifact manifests with filename or relativePath', () => {
  const task = enrichTaskWithExecutionContract({
    id: 'review-report',
    title: 'Review generated report',
    assignedAgent: 'reviewer',
  });

  const result = validateTaskResultAgainstContract(task, {
    summary: 'The review checked narrative structure, evidence quality, audience fit, and implementation details.',
    artifacts: [{ filename: 'review-evidence.json', relativePath: 'qa/review-evidence.json' }],
    evidence: {
      verdict: 'needs_changes',
      findings: [{ severity: 'major', message: 'Need stronger opening.' }],
    },
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
    console.error(err);
    process.exitCode = 1;
    break;
  }
}
if (process.exitCode !== 1) {
  console.log(`\n${passed}/${tests.length} execution contract tests passed`);
}
