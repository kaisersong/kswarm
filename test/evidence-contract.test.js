/**
 * KSwarm — evidence contract inference tests
 *
 * Run: node test/evidence-contract.test.js
 */

import assert from 'node:assert/strict';
import {
  inferEvidenceContract,
  hasSpeculativeSourceLanguage,
} from '../src/core/evidence-contract.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const now = Date.UTC(2026, 4, 21, 5, 0, 0);

test('infers required recent external evidence for current public research tasks', () => {
  const contract = inferEvidenceContract({
    title: '收集金蝶2026年AI产品公开信息',
    brief: '搜索金蝶官网、新闻稿、发布会记录，整理来源链接。',
    acceptanceCriteria: '每条信息有来源链接或明确出处。',
    projectGoal: '金蝶今年AI产品分析',
  }, { now });

  assert.equal(contract.version, 1);
  assert.equal(contract.kind, 'external_source_v1');
  assert.equal(contract.required, true);
  assert.equal(contract.requiresRecentEvidence, true);
  assert.equal(contract.requireSourceUrls, true);
  assert.equal(contract.requiredArtifact, 'search-evidence.json');
  assert.ok(contract.minQueries >= 2);
  assert.ok(contract.minFetchedPages >= 1);
});

test('respects explicit evidence opt out for dependency-only synthesis tasks', () => {
  const contract = inferEvidenceContract({
    title: '根据已有材料撰写第一轮分析报告',
    brief: '基于 phase-1 的材料写初稿，不新增事实。',
    projectGoal: '金蝶今年AI产品分析',
    evidenceContract: { required: false, reason: 'uses_dependency_artifacts_only' },
  }, { now });

  assert.equal(contract.required, false);
  assert.equal(contract.reason, 'uses_dependency_artifacts_only');
});

test('detects speculative source language that must not pass evidence-required gates', () => {
  assert.equal(hasSpeculativeSourceLanguage('由于无法实时爬取最新官网链接，以下基于合理推断'), true);
  assert.equal(hasSpeculativeSourceLanguage('来源：金蝶官网活动页 https://www.kingdee.com/kais2026'), false);
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
  console.log(`\n${passed}/${tests.length} evidence contract tests passed`);
}
