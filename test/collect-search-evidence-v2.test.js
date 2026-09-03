/**
 * KSwarm — collectSearchEvidenceV2（design §5.1，external_source_v2 真实证据采集）
 *
 * 设计依据：mydocs/xiaok-cli/design/2026-08-31-collaboration-room-evidence-first-execution-and-gate-design.md v8
 *   §5.1 外部来源任务的硬前置
 *
 * 与 v1 collectSearchEvidence 的关键差异：v1 用 fetchPageEvidence 做内存摘要级
 * 抓取（无落盘、hash 覆盖截断内容）；v2 用 fetchPageEvidenceV2 做真实落盘
 * snapshot + exact stored bytes 的 sha256（不受 MAX_FETCH_BYTES 截断影响 hash
 * 覆盖范围）。
 *
 * 范围边界（诚实记录，不假造未实现的部分）：本函数只负责"搜索 → 真实落盘抓取"
 * 这一段，产出的 fetchedPages 携带 artifactId（可被 claim.sourceArtifactIds
 * 引用）。claims（§5.1 步骤 3 的 claim→source 映射）由调用方在生成最终结论时
 * 显式提供——这是任务语义层面的信息（哪句话依赖哪个来源），不是搜索采集阶段
 * 能自动推导的，本函数不假造这部分逻辑。
 *
 * Run: node test/collect-search-evidence-v2.test.js
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectSearchEvidenceV2 } from '../src/core/search-evidence.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function fakeFetchFn(handlers) {
  return async (url) => {
    const handler = handlers[url];
    if (!handler) throw new Error(`unexpected_fetch: ${url}`);
    return handler();
  };
}

test('collectSearchEvidenceV2 用真实落盘抓取产出携带 artifactId/fetchedAt/contentHash/snapshotRef 的 fetchedPages', async () => {
  const snapshotDir = mkdtempSync(join(tmpdir(), 'kswarm-cse-v2-'));
  try {
    const fetchFn = fakeFetchFn({
      'https://example.com/report': async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        arrayBuffer: async () => Buffer.from('<html>real report content</html>', 'utf-8'),
      }),
    });

    const evidence = await collectSearchEvidenceV2({
      task: { id: 'task-1', title: '核实报告' },
      contract: { minFetchedPages: 1 },
      candidateUrls: ['https://example.com/report'],
      fetchFn,
      snapshotDir,
    });

    assert.equal(evidence.version, 2);
    assert.equal(evidence.kind, 'external_source_v2');
    assert.equal(evidence.fetchedPages.length, 1);
    const page = evidence.fetchedPages[0];
    assert.equal(page.ok, true);
    assert.ok(page.artifactId, 'fetchedPages 中每一项都必须有 artifactId 供 claim 引用');
    assert.ok(page.fetchedAt);
    assert.ok(page.contentHash);
    assert.ok(page.snapshotRef);
    assert.ok(existsSync(join(snapshotDir, page.snapshotRef.split('/').pop())) || existsSync(page.snapshotRef), 'snapshot 文件必须真实落盘');
  } finally {
    rmSync(snapshotDir, { recursive: true, force: true });
  }
});

test('candidateUrls 抓取失败时 fetchedPages 记录 ok:false，不假造成功', async () => {
  const snapshotDir = mkdtempSync(join(tmpdir(), 'kswarm-cse-v2-fail-'));
  try {
    const fetchFn = fakeFetchFn({
      'https://example.com/unreachable': async () => { throw new Error('network_timeout'); },
    });

    const evidence = await collectSearchEvidenceV2({
      task: { id: 'task-1', title: '核实报告' },
      contract: { minFetchedPages: 1 },
      candidateUrls: ['https://example.com/unreachable'],
      fetchFn,
      snapshotDir,
    });

    assert.equal(evidence.fetchedPages.length, 1);
    assert.equal(evidence.fetchedPages[0].ok, false);
    assert.equal(evidence.validation.ok, false);
    assert.equal(evidence.validation.verdict, 'waiting_for_evidence');
  } finally {
    rmSync(snapshotDir, { recursive: true, force: true });
  }
});

test('claims 由调用方显式提供时被原样保留在 evidence.claims 中并参与 validation', async () => {
  const snapshotDir = mkdtempSync(join(tmpdir(), 'kswarm-cse-v2-claims-'));
  try {
    const fetchFn = fakeFetchFn({
      'https://example.com/report': async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        arrayBuffer: async () => Buffer.from('real content', 'utf-8'),
      }),
    });

    const evidence = await collectSearchEvidenceV2({
      task: { id: 'task-1', title: '核实报告' },
      contract: { minFetchedPages: 1 },
      candidateUrls: ['https://example.com/report'],
      fetchFn,
      snapshotDir,
      claims: [{ claimId: 'c1', text: '报告中的结论', sourceArtifactIds: [] }],
    });

    // claims 由调用方提供时，sourceArtifactIds 为空会被 validateSearchEvidenceV2
    // 判定为 claim_missing_source_ref——本函数不自动填充这个映射（诚实边界，
    // 见文件头注释），调用方必须显式声明真实的 claim→source 关系。
    assert.equal(evidence.claims.length, 1);
    assert.equal(evidence.validation.ok, false);
    assert.ok(evidence.validation.reasons.includes('claim_missing_source_ref'));
  } finally {
    rmSync(snapshotDir, { recursive: true, force: true });
  }
});

test('runId 提供时，每个成功抓取的 fetchedPage 都产出对应的 ArtifactEvidenceExtensionV1（design §3.5）', async () => {
  const snapshotDir = mkdtempSync(join(tmpdir(), 'kswarm-cse-v2-ext-'));
  try {
    const fetchFn = fakeFetchFn({
      'https://example.com/report': async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        arrayBuffer: async () => Buffer.from('real report content', 'utf-8'),
      }),
    });

    const evidence = await collectSearchEvidenceV2({
      task: { id: 'task-1', title: '核实报告' },
      contract: { minFetchedPages: 1 },
      candidateUrls: ['https://example.com/report'],
      fetchFn,
      snapshotDir,
      runId: 'run-1',
    });

    assert.equal(evidence.evidenceExtensions.length, 1);
    const extension = evidence.evidenceExtensions[0];
    assert.equal(extension.schemaVersion, 'artifact-evidence-extension-v1');
    assert.equal(extension.artifactId, evidence.fetchedPages[0].artifactId);
    assert.equal(extension.runId, 'run-1');
    assert.ok(extension.fetch);
    assert.equal(extension.fetch.fetchCompleted, true);
  } finally {
    rmSync(snapshotDir, { recursive: true, force: true });
  }
});

test('runId 缺失时不构造 evidenceExtensions（caller 责任边界，不静默伪造 runId）', async () => {
  const snapshotDir = mkdtempSync(join(tmpdir(), 'kswarm-cse-v2-no-run-'));
  try {
    const fetchFn = fakeFetchFn({
      'https://example.com/report': async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        arrayBuffer: async () => Buffer.from('real content', 'utf-8'),
      }),
    });

    const evidence = await collectSearchEvidenceV2({
      task: { id: 'task-1', title: '核实报告' },
      contract: { minFetchedPages: 1 },
      candidateUrls: ['https://example.com/report'],
      fetchFn,
      snapshotDir,
    });

    assert.equal(evidence.evidenceExtensions.length, 0);
  } finally {
    rmSync(snapshotDir, { recursive: true, force: true });
  }
});

let passed = 0;
let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
    if (process.env.DEBUG) console.log(err.stack);
  }
}
console.log(`\n${passed}/${tests.length} collectSearchEvidenceV2 tests passed\n`);
if (failed > 0) process.exit(1);
