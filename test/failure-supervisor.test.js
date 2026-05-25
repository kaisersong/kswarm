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

test('quality review requesting future current-month data blocks for plan revision', () => {
  const decision = superviseTaskFailure(
    {
      id: 'p1-item3',
      title: '持续采集并归档原始数据',
      qualityFailureCount: 0,
      maxQualityReworks: 2,
    },
    {
      source: 'quality_review',
      failureClass: 'quality_content_failed',
      feedback: '覆盖范围仅5月1日至20日，缺少5月21-31日数据，请补齐缺失日期。',
    },
    { now: Date.UTC(2026, 4, 20, 12, 0, 0) }
  );

  assert.equal(decision.action, 'block');
  assert.equal(decision.blockKind, 'plan_revision_required');
  assert.equal(decision.failureClass, 'quality_temporal_impossible');
  assert.ok(decision.nextActions.some(a => a.includes('当前日期')));
});

test('quality review requesting past month completion still follows normal rework budget', () => {
  const decision = superviseTaskFailure(
    { id: 'p1-item3', qualityFailureCount: 0, maxQualityReworks: 2 },
    {
      source: 'quality_review',
      failureClass: 'quality_content_failed',
      feedback: '覆盖范围仅5月1日至20日，缺少5月21-31日数据，请补齐缺失日期。',
    },
    { now: Date.UTC(2026, 5, 2, 12, 0, 0) }
  );

  assert.equal(decision.action, 'rework');
  assert.equal(decision.failureClass, 'quality_content_failed');
});

test('quality review mentioning current month and complete evidence does not imply future month completion', () => {
  const decision = superviseTaskFailure(
    { id: 'research', qualityFailureCount: 0, maxQualityReworks: 2 },
    {
      source: 'quality_review',
      failureClass: 'quality_content_failed',
      feedback: '证据文件残缺：缺少完整抓取记录、URL、日期、命中标题。3条动态日期落在5月窗口之前，8条动态仅有月份缺具体日期，需补齐证据文件。',
    },
    { now: Date.UTC(2026, 4, 25, 4, 0, 0) }
  );

  assert.equal(decision.action, 'rework');
  assert.equal(decision.failureClass, 'quality_content_failed');
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
