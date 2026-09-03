/**
 * KSwarm — validateSearchEvidenceV2（design §5.1 / §5.1.1，external_source_v2 真实 validator）
 *
 * 设计依据：mydocs/xiaok-cli/design/2026-08-31-collaboration-room-evidence-first-execution-and-gate-design.md v8
 *   §5.1 外部来源任务的硬前置：
 *   1. 至少一个实际 fetched page；只拿搜索摘要不计实取
 *   2. 每个计入结论的来源有 timestamp、content hash 和 snapshot
 *   3. 每个关键 claim 显式关联一个或多个 source evidence ref
 *   4. 所有来源均取回失败时 verdict 只能是 waiting_for_evidence
 *   5. evidence contract 在 draft task 启动前完成
 *   6. 来源变化或 snapshot/hash 不一致会让旧结论失效
 *   §5.1.1 —— external_source_v2 显式支持，未知 kind fail closed
 *
 * 现状核实（2026-09-02）：fetchPageEvidenceV2（真实网络抓取+snapshot 落盘+hash）
 * 此前完全没有生产 caller；external_source_v2 在 contract-kind-registry.js
 * 中标记 supported:false（因为没有真实 v2 validator）。本文件驱动新增
 * validateSearchEvidenceV2，是 external_source_v2 的真实校验实现。
 *
 * Run: node test/search-evidence-v2-validation.test.js
 */

import assert from 'node:assert/strict';
import { validateSearchEvidenceV2 } from '../src/core/search-evidence.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function validPage(overrides = {}) {
  return {
    url: 'https://example.com/report',
    ok: true,
    fetchedAt: new Date().toISOString(),
    contentHash: 'sha256:' + 'a'.repeat(64),
    snapshotRef: 'tasks/item-1/run-1/snapshots/page-1.html',
    truncated: false,
    ...overrides,
  };
}

test('§5.1 步骤 1：零 fetched page 时 verdict 只能是 waiting_for_evidence（只拿搜索摘要不计实取）', () => {
  const result = validateSearchEvidenceV2({
    fetchedPages: [],
    claims: [],
  }, { minFetchedPages: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.verdict, 'waiting_for_evidence');
  assert.ok(result.reasons.includes('source_fetch_missing'));
});

test('§5.1 步骤 2：fetched page 缺 fetchedAt/contentHash/snapshotRef 任一字段时 fail closed', () => {
  const result = validateSearchEvidenceV2({
    fetchedPages: [validPage({ contentHash: null })],
    claims: [],
  }, { minFetchedPages: 1 });
  assert.equal(result.ok, false);
  assert.ok(result.reasons.includes('source_evidence_incomplete'));
});

test('§5.1 步骤 3：claim 缺失关联的 sourceArtifactIds 时 fail closed', () => {
  const result = validateSearchEvidenceV2({
    fetchedPages: [validPage()],
    claims: [{ claimId: 'c1', text: '某个结论', sourceArtifactIds: [] }],
  }, { minFetchedPages: 1 });
  assert.equal(result.ok, false);
  assert.ok(result.reasons.includes('claim_missing_source_ref'));
});

test('§5.1 步骤 3：claim 关联的 sourceArtifactIds 指向不存在的 fetched page 时 fail closed（不能引用不存在的证据）', () => {
  const result = validateSearchEvidenceV2({
    fetchedPages: [validPage({ artifactId: 'page-a1' })],
    claims: [{ claimId: 'c1', text: '某个结论', sourceArtifactIds: ['page-nonexistent'] }],
  }, { minFetchedPages: 1 });
  assert.equal(result.ok, false);
  assert.ok(result.reasons.includes('claim_source_ref_not_found'));
});

test('§5.1 步骤 4：所有来源均 ok=false（取回失败）时 verdict 只能是 waiting_for_evidence，不能是 blocked', () => {
  const result = validateSearchEvidenceV2({
    fetchedPages: [{ url: 'https://example.com/x', ok: false, error: 'timeout' }],
    claims: [],
  }, { minFetchedPages: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.verdict, 'waiting_for_evidence');
});

test('§5.1 步骤 1 备注：truncated=true 的来源不能作为唯一证据满足 high 风险 claim', () => {
  const result = validateSearchEvidenceV2({
    fetchedPages: [validPage({ artifactId: 'page-a1', truncated: true })],
    claims: [{ claimId: 'c1', text: '高风险结论', sourceArtifactIds: ['page-a1'], riskLevel: 'high' }],
  }, { minFetchedPages: 1 });
  assert.equal(result.ok, false);
  assert.ok(result.reasons.includes('truncated_source_insufficient_for_high_risk_claim'));
});

test('全部字段完整、claim 有真实来源引用时通过（verdict=passed）', () => {
  const result = validateSearchEvidenceV2({
    fetchedPages: [validPage({ artifactId: 'page-a1' })],
    claims: [{ claimId: 'c1', text: '某个结论', sourceArtifactIds: ['page-a1'] }],
  }, { minFetchedPages: 1 });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.verdict, 'passed');
});

test('minFetchedPages=0 且用户显式 opt-out 时不要求任何 fetched page（§5.1："0 只能由用户显式 opt-out 并记录原因"）', () => {
  const result = validateSearchEvidenceV2({
    fetchedPages: [],
    claims: [],
    userOptOutReason: '用户确认本任务不需要外部来源核实',
  }, { minFetchedPages: 0 });
  assert.equal(result.ok, true, JSON.stringify(result));
});

test('minFetchedPages=0 但缺失 userOptOutReason 时仍 fail closed（"0 只能由确定性规则确认不需要或用户显式 opt-out"，不能是空缺省）', () => {
  const result = validateSearchEvidenceV2({
    fetchedPages: [],
    claims: [],
  }, { minFetchedPages: 0 });
  assert.equal(result.ok, false);
  assert.ok(result.reasons.includes('min_fetched_pages_zero_requires_opt_out_reason'));
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
console.log(`\n${passed}/${tests.length} search evidence v2 validation tests passed\n`);
if (failed > 0) process.exit(1);
