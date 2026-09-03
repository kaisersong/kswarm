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

// design §5.1.1（Contract kind registry 与 fail-closed）：
// "生成点必须按 executionGateSchemaVersion 显式选 kind，并由 contract test
// 扫描所有 kind ===/!== 分支；禁止局部 accepted set 与局部默认值漂移。"
//
// 现状核实（2026-09-02）：inferEvidenceContract 此前完全没有 schemaVersion
// 输入，永远产出 external_source_v1，即使调用方项目是 schema v2——这是
// auto-worker.js 从未真正调用 collectSearchEvidenceV2 的根本原因之一
// （生成点本身就没有产 v2 kind 的能力，不是 auto-worker.js 单独的接线缺失）。
test('schemaVersion=2 时产出 external_source_v2（此前完全没有这个能力，永远只产 v1）', () => {
  const contract = inferEvidenceContract({
    title: '收集金蝶2026年AI产品公开信息',
    brief: '搜索金蝶官网、新闻稿、发布会记录，整理来源链接。',
    acceptanceCriteria: '每条信息有来源链接或明确出处。',
    projectGoal: '金蝶今年AI产品分析',
  }, { now, schemaVersion: 2 });

  assert.equal(contract.version, 2);
  assert.equal(contract.kind, 'external_source_v2');
  assert.equal(contract.required, true);
  assert.ok(contract.minFetchedPages >= 1);
});

test('schemaVersion 未传时保持默认 v1 行为（不引入回归）', () => {
  const contract = inferEvidenceContract({
    title: '收集金蝶2026年AI产品公开信息',
    brief: '搜索金蝶官网、新闻稿、发布会记录，整理来源链接。',
    acceptanceCriteria: '每条信息有来源链接或明确出处。',
    projectGoal: '金蝶今年AI产品分析',
  }, { now });

  assert.equal(contract.version, 1);
  assert.equal(contract.kind, 'external_source_v1');
});

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
