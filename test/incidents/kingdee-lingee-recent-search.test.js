/**
 * Regression: source-heavy current research must not miss 金蝶“灵基 Lingee”.
 *
 * Run: node test/incidents/kingdee-lingee-recent-search.test.js
 */

import assert from 'node:assert/strict';
import { inferEvidenceContract } from '../../src/core/evidence-contract.js';
import { collectSearchEvidence } from '../../src/core/search-evidence.js';
import { validateSourceEvidenceArtifact } from '../../src/core/source-evidence.js';

const now = Date.UTC(2026, 4, 21, 5, 0, 0);
const task = {
  id: 'proj-1779361170486__item-1-1',
  title: '收集金蝶2026年AI产品公开信息',
  brief: '搜索金蝶官网、新闻稿、发布会记录、行业报告，收集2026年1月1日至2026年5月21日期间发布的AI产品、功能更新、战略合作等信息。',
  projectGoal: '金蝶今年AI产品分析',
  projectRequirements: '要进行2轮分析，是提供给研发高层看的内容，要有高度',
};

const html = `
<a class="result__a" href="https://www.kingdee.com/kais2026">金蝶AI峰会2026</a>
<div class="result__snippet">2026年5月20日，金蝶发布企业AI原生操作系统灵基 Lingee。</div>
<a class="result__a" href="https://finance.sina.com.cn/tech/roll/2026-05-20/doc-inhyptaf9314629.shtml">金蝶正式发布企业 AI 操作系统灵基</a>
<div class="result__snippet">金蝶正式发布企业 AI 操作系统“灵基 Lingee”。</div>
<a class="result__a" href="https://www.donews.com/news/detail/4/6563796.html">金蝶发布灵基</a>
<div class="result__snippet">金蝶AI峰会发布灵基。</div>`;

const fetchFn = async url => {
  const value = String(url);
  if (value.includes('duckduckgo.com/html')) return new Response(html, { status: 200 });
  return new Response('2026年5月20日 金蝶AI峰会 企业AI原生操作系统 灵基 Lingee', { status: 200 });
};

const contract = inferEvidenceContract(task, { now });
const evidence = await collectSearchEvidence({ task, contract, fetchFn, now });

assert.equal(evidence.validation.ok, true);
assert.ok(JSON.stringify(evidence).includes('灵基'));

const bad = validateSourceEvidenceArtifact({
  ...task,
  content: '由于无法实时爬取最新官网链接，以下内容基于公开知识和合理推断。',
  evidenceContract: contract,
  searchEvidence: evidence,
  now,
});
assert.equal(bad.ok, false);
assert.equal(bad.reason, 'speculative_source_claim');

const good = validateSourceEvidenceArtifact({
  ...task,
  content: '来源显示，金蝶在2026年5月20日AI峰会上发布企业AI原生操作系统“灵基 Lingee”。来源：https://www.kingdee.com/kais2026',
  evidenceContract: contract,
  searchEvidence: evidence,
  now,
});
assert.equal(good.ok, true);

console.log('kingdee lingee recent search regression passed');
