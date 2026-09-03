/**
 * KSwarm — collectSearchEvidenceV2WithSearch（design §5.1，auto-worker.js 接入前置）
 *
 * 设计依据：mydocs/xiaok-cli/design/2026-08-31-collaboration-room-evidence-first-execution-and-gate-design.md v8
 *   §5.1 外部来源任务的硬前置
 *
 * 现状核实（2026-09-02）：collectSearchEvidenceV2 只负责"候选 URL → 真实落盘
 * 抓取"，不做搜索本身——调用方需要自己先搜索找到候选 URL。这是
 * auto-worker.js 从未真正调用 collectSearchEvidenceV2 的第二个根因（第一个
 * 是 evidence-contract.js 从未产出过 external_source_v2 kind，本轮已在
 * test/evidence-contract.test.js / test/execution-contract.test.js 修复）：
 * auto-worker.js 现有的 v1 collectSearchEvidence 是"搜索+抓取"一体化的，如果
 * 直接换成只做抓取的 collectSearchEvidenceV2，需要调用方自己重新实现搜索
 * 逻辑，没有这样一个组合函数就意味着接入成本被低估。
 *
 * 本文件驱动新增 collectSearchEvidenceV2WithSearch：复用 v1 已有的
 * buildSearchQueries + 内部搜索 fallback 逻辑找到候选 URL，再调用
 * collectSearchEvidenceV2 做真实落盘抓取，产出与 v1 collectSearchEvidence
 * 对等的一体化调用体验，供 auto-worker.js 接入。
 *
 * Run: node test/collect-search-evidence-v2-with-search.test.js
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectSearchEvidenceV2WithSearch } from '../src/core/search-evidence.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function fakeFetchFn(handlers) {
  return async (url) => {
    for (const [pattern, handler] of Object.entries(handlers)) {
      if (url.includes(pattern)) return handler(url);
    }
    throw new Error(`unexpected_fetch: ${url}`);
  };
}

test('collectSearchEvidenceV2WithSearch 先搜索找到候选 URL，再真实落盘抓取，产出 external_source_v2 evidence', async () => {
  const snapshotDir = mkdtempSync(join(tmpdir(), 'kswarm-cse-v2-search-'));
  try {
    const fetchFn = fakeFetchFn({
      'duckduckgo.com/html': () => ({
        ok: true,
        status: 200,
        text: async () => `<html><body>
          <a class="result__a" href="https://example.com/announcement">Example Announcement</a>
          <a class="result__snippet">Official announcement snippet text.</a>
        </body></html>`,
      }),
      'example.com/announcement': () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        arrayBuffer: async () => Buffer.from('Real fetched page content about the announcement.', 'utf-8'),
      }),
    });

    const evidence = await collectSearchEvidenceV2WithSearch({
      task: { id: 'task-1', title: '收集2026年AI行业最新发布信息', brief: '搜索官方公告' },
      contract: { minQueries: 1, minFetchedPages: 1, requiresRecentEvidence: false },
      snapshotDir,
      fetchFn,
    });

    assert.equal(evidence.version, 2);
    assert.equal(evidence.kind, 'external_source_v2');
    assert.ok(Array.isArray(evidence.fetchedPages));
    assert.ok(evidence.fetchedPages.length >= 1, 'must have fetched at least one real page');
    const page = evidence.fetchedPages[0];
    assert.ok(page.artifactId);
    assert.ok(page.snapshotRef);
    assert.ok(existsSync(page.snapshotRef), 'snapshot 文件必须真实落盘');
  } finally {
    rmSync(snapshotDir, { recursive: true, force: true });
  }
});

test('搜索失败/没有候选 URL 时，仍返回结构化的 waiting_for_evidence 级别 evidence，不抛异常', async () => {
  const snapshotDir = mkdtempSync(join(tmpdir(), 'kswarm-cse-v2-search-empty-'));
  try {
    const fetchFn = fakeFetchFn({
      'duckduckgo.com/html': () => ({ ok: false, status: 500, text: async () => '' }),
    });

    const evidence = await collectSearchEvidenceV2WithSearch({
      task: { id: 'task-2', title: '收集2026年AI行业最新发布信息', brief: '搜索官方公告' },
      contract: { minQueries: 1, minFetchedPages: 1, requiresRecentEvidence: false },
      snapshotDir,
      fetchFn,
    });

    assert.equal(evidence.version, 2);
    assert.equal(evidence.kind, 'external_source_v2');
    assert.equal(evidence.fetchedPages.length, 0);
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
console.log(`\n${passed}/${tests.length} collectSearchEvidenceV2WithSearch tests passed\n`);
if (failed > 0) process.exit(1);
