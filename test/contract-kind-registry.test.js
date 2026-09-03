/**
 * KSwarm — contract-kind-registry.js unit tests + source-evidence.js fail-closed regression
 *
 * 设计依据：design §5.1.1 Contract kind registry 与 fail-closed
 *
 * Run: node test/contract-kind-registry.test.js
 */

import assert from 'node:assert/strict';
import { CONTRACT_KIND_REGISTRY, lookupContractKind, isRegisteredContractKind, isContractFamily, isExplicitNoContractKind } from '../src/core/contract-kind-registry.js';
import { validateSourceEvidenceArtifact } from '../src/core/source-evidence.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('registry recognizes external_source_v1 and external_source_v2 under the same family', () => {
  assert.equal(isContractFamily('external_source_v1', 'external_source'), true);
  assert.equal(isContractFamily('external_source_v2', 'external_source'), true);
  assert.equal(lookupContractKind('external_source_v1').validator, 'v1');
  assert.equal(lookupContractKind('external_source_v2').validator, 'v2');
});

test('registry recognizes review_iteration_v1 and review_iteration_v2 under the same family', () => {
  assert.equal(isContractFamily('review_iteration_v1', 'review_iteration'), true);
  assert.equal(isContractFamily('review_iteration_v2', 'review_iteration'), true);
});

test('every registered kind is either supported or explicitly unsupported', () => {
  const expected = {
    external_source_v1: { family: 'external_source', supported: true },
    // design §5.1：external_source_v2 现在有真实 v2 validator
    // （search-evidence.js:validateSearchEvidenceV2 提供真实 fetchPageEvidenceV2
    // 落盘证据 + claim→source 映射校验），supported 从 false 改为 true。
    external_source_v2: { family: 'external_source', supported: true },
    review_iteration_v1: { family: 'review_iteration', supported: true },
    // design §3.2/§9.1：review_iteration_v2 现在有真实 v2 validator
    // （gate-evidence-acceptor.js:acceptTaskGateEvidence 提供唯一 gateEvidenceArtifactId
    // 声明、canonical manifest 解析、realpath containment、service hash 重算比对、
    // schema fail-closed 六步流程），supported 从 false 改为 true。
    review_iteration_v2: { family: 'review_iteration', supported: true },
  };

  assert.deepEqual(Object.keys(CONTRACT_KIND_REGISTRY).sort(), Object.keys(expected).sort());
  for (const [kind, expectedStatus] of Object.entries(expected)) {
    const status = lookupContractKind(kind);
    assert.equal(status.kind, kind);
    assert.equal(status.family, expectedStatus.family);
    assert.equal(status.supported, expectedStatus.supported);
    assert.equal(typeof status.validator, expectedStatus.supported ? 'string' : 'object');
  }
});

test('registry returns null for unknown kinds instead of a default entry', () => {
  assert.equal(lookupContractKind('external_source_v3'), null);
  assert.equal(lookupContractKind('made_up_kind'), null);
  assert.equal(isRegisteredContractKind('made_up_kind'), false);
});

test("'none' is an explicit no-contract value, not a registered kind", () => {
  assert.equal(isExplicitNoContractKind('none'), true);
  assert.equal(isRegisteredContractKind('none'), false);
});

// design §5.1.1：source-evidence.js 的核心 fail-closed 修复回归。
test('[FIXED] validateSourceEvidenceArtifact fails closed on an unregistered contract kind instead of returning success()', () => {
  const result = validateSourceEvidenceArtifact({
    title: 'some external research task',
    content: 'some content without any real source citation',
    evidenceContract: { required: true, kind: 'totally_unknown_kind_v99' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unsupported_evidence_contract');
});

test('validateSourceEvidenceArtifact still validates external_source_v1 contracts normally', () => {
  const result = validateSourceEvidenceArtifact({
    title: 'latest news search task',
    content: 'no citations here',
    evidenceContract: { required: true, kind: 'external_source_v1', minResults: 3, minFetchedPages: 1 },
    searchEvidence: { queries: [], fetchedPages: [] },
  });
  assert.equal(result.ok, false);
  assert.notEqual(result.reason, 'unsupported_evidence_contract', 'a known kind must not be misreported as unsupported');
});

test('validateSourceEvidenceArtifact still passes review_iteration_v1 tasks through (not this validator\'s family)', () => {
  const result = validateSourceEvidenceArtifact({
    title: 'review task with 今年 wording',
    content: 'review content',
    evidenceContract: { required: true, kind: 'review_iteration_v1' },
  });
  assert.equal(result.ok, true, 'review_iteration_v1 is a registered kind outside this validator\'s family and must be passed through');
});

test('validateSourceEvidenceArtifact treats explicit kind:"none" as an opt-out, not unsupported', () => {
  const result = validateSourceEvidenceArtifact({
    title: 'some task',
    content: 'some content',
    evidenceContract: { required: false, kind: 'none' },
  });
  assert.equal(result.ok, true);
});

test('validateSourceEvidenceArtifact falls back to heuristic detection when no contract is provided at all', () => {
  const result = validateSourceEvidenceArtifact({
    title: 'a task with no external source signal',
    content: 'plain content',
    evidenceContract: null,
  });
  assert.equal(result.ok, true, 'no contract at all should still use the legacy heuristic path, not be treated as unsupported');
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
console.log(`\n${passed}/${tests.length} contract-kind-registry tests passed`);
if (passed !== tests.length) process.exitCode = 1;
