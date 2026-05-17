/**
 * KSwarm — failure supervisor tests
 *
 * Run: node test/failure-supervisor.test.js
 */

import assert from 'node:assert/strict';
import { superviseTaskFailure } from '../src/core/failure-supervisor.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('first quality failure requests rework with explicit evidence requirements', () => {
  const decision = superviseTaskFailure(
    { id: 'review', qualityFailureCount: 0, maxQualityReworks: 1 },
    { source: 'quality_review', failureClass: 'quality_content_failed', feedback: '缺少受众分析' }
  );

  assert.equal(decision.action, 'rework');
  assert.equal(decision.qualityFailureCount, 1);
  assert.ok(decision.nextActions.some(a => a.includes('补充')));
});

test('repeated quality failure blocks instead of looping forever', () => {
  const decision = superviseTaskFailure(
    { id: 'review', qualityFailureCount: 1, maxQualityReworks: 1 },
    { source: 'quality_review', failureClass: 'quality_evidence_missing', feedback: '没有 review-evidence.json' }
  );

  assert.equal(decision.action, 'block');
  assert.equal(decision.blockKind, 'quality_gate_blocked');
  assert.equal(decision.failureClass, 'quality_evidence_missing');
  assert.ok(decision.nextActions.some(a => a.includes('人工')));
});

test('runtime failures retry within attempt budget and block after exhaustion', () => {
  const retry = superviseTaskFailure(
    { id: 'draft', attempt: 1, maxAttempts: 2 },
    { source: 'runtime', failureClass: 'agent_error', feedback: 'CLI returned empty output' }
  );
  assert.equal(retry.action, 'retry');

  const block = superviseTaskFailure(
    { id: 'draft', attempt: 2, maxAttempts: 2 },
    { source: 'runtime', failureClass: 'agent_error', feedback: 'CLI returned empty output again' }
  );
  assert.equal(block.action, 'block');
  assert.equal(block.blockKind, 'runtime_exhausted');
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
  console.log(`\n${passed}/${tests.length} failure supervisor tests passed`);
}
