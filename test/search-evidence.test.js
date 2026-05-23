/**
 * KSwarm — search evidence collection tests
 *
 * Run: node test/search-evidence.test.js
 */

import assert from 'node:assert/strict';
import {
  collectSearchEvidence,
  normalizeSearchUrl,
  validateSearchEvidence,
} from '../src/core/search-evidence.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const now = Date.UTC(2026, 4, 21, 5, 0, 0);

test('collects DuckDuckGo search results and fetched page evidence', async () => {
  const ddgHtml = `
  <html><body>
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.kingdee.com%2Fkais2026&rut=abc">金蝶AI峰会2026</a>
    <div class="result__snippet">2026年5月20日，金蝶发布企业AI原生操作系统灵基 Lingee。</div>
    <a class="result__a" href="https://finance.sina.com.cn/tech/roll/2026-05-20/doc-inhyptaf9314629.shtml">金蝶正式发布灵基</a>
    <div class="result__snippet">金蝶正式发布企业 AI 操作系统“灵基 Lingee”。</div>
  </body></html>`;

  const fetchFn = async url => {
    const text = String(url);
    if (text.includes('duckduckgo.com/html')) {
      return new Response(ddgHtml, { status: 200, headers: { 'content-type': 'text/html' } });
    }
    if (text.includes('kingdee.com/kais2026')) {
      return new Response('金蝶AI峰会2026 AI原生产品发布会 2026年5月20日 灵基 Lingee', { status: 200 });
    }
    return new Response('新浪科技 2026年5月20日 金蝶发布灵基 Lingee', { status: 200 });
  };

  const evidence = await collectSearchEvidence({
    task: {
      id: 'proj-x__item-1-1',
      title: '收集金蝶2026年AI产品公开信息',
      brief: '搜索金蝶官网、新闻稿、发布会记录。',
      projectGoal: '金蝶今年AI产品分析',
    },
    contract: {
      kind: 'external_source_v1',
      required: true,
      requiresRecentEvidence: true,
      minQueries: 2,
      minResults: 2,
      minFetchedPages: 1,
      requireSourceUrls: true,
    },
    fetchFn,
    now,
  });

  assert.equal(evidence.kind, 'external_source_v1');
  assert.ok(evidence.queries.length >= 2);
  assert.ok(evidence.queries.flatMap(q => q.results).some(r => r.url === 'https://www.kingdee.com/kais2026'));
  assert.ok(evidence.fetchedPages.some(page => page.url === 'https://www.kingdee.com/kais2026' && page.ok));
  assert.equal(validateSearchEvidence(evidence, evidence.contract).ok, true);
});

test('records search provider failures as retryable source provider unavailability', async () => {
  const fetchFn = async url => {
    const text = String(url);
    if (text.includes('duckduckgo.com/html')) {
      throw new Error('connect timeout duckduckgo.com:443');
    }
    if (text.includes('bing.com/search')) {
      throw new Error('connect timeout bing.com:443');
    }
    return new Response('not reached', { status: 200 });
  };

  const evidence = await collectSearchEvidence({
    task: {
      id: 'proj-x__item-1-1',
      title: '收集金蝶本月产品数据',
      brief: '收集截至2026年5月21日的金蝶产品相关数据，注明数据来源和时间。',
      projectGoal: '输出金蝶本月产品分析报告',
    },
    contract: {
      kind: 'external_source_v1',
      required: true,
      requiresRecentEvidence: true,
      minQueries: 2,
      minResults: 2,
      minFetchedPages: 1,
      requireSourceUrls: true,
    },
    fetchFn,
    now,
  });

  assert.equal(evidence.validation.ok, false);
  assert.equal(evidence.validation.failureClass, 'source_provider_unavailable');
  assert.ok(evidence.validation.reasons.includes('search_provider_failed'));
  assert.ok(evidence.queries.length >= 2);
  assert.ok(evidence.queries.every(query => query.error.includes('connect timeout')));
});

test('falls back to Bing when DuckDuckGo is unavailable', async () => {
  const bingHtml = `
  <html><body>
    <li class="b_algo">
      <h2><a href="https://www.kingdee.com/cn/news/product-ai-lingee">金蝶发布灵基 Lingee</a></h2>
      <div class="b_caption"><p>2026年5月，金蝶发布企业 AI 原生操作系统灵基 Lingee。</p></div>
    </li>
    <li class="b_algo">
      <h2><a href="https://www.kingdee.com/cn/events/kais2026">金蝶 AI 峰会 2026</a></h2>
      <div class="b_caption"><p>金蝶 AI 峰会介绍最新 AI 产品动态。</p></div>
    </li>
  </body></html>`;

  const fetchFn = async url => {
    const text = String(url);
    if (text.includes('duckduckgo.com/html')) {
      throw new Error('connect timeout duckduckgo.com:443');
    }
    if (text.includes('bing.com/search')) {
      return new Response(bingHtml, { status: 200, headers: { 'content-type': 'text/html' } });
    }
    if (text.includes('kingdee.com/cn/news/product-ai-lingee')) {
      return new Response('金蝶发布企业 AI 原生操作系统灵基 Lingee，发布时间 2026年5月。', { status: 200 });
    }
    return new Response('金蝶 AI 峰会 2026 产品动态。', { status: 200 });
  };

  const evidence = await collectSearchEvidence({
    task: {
      id: 'proj-x__item-1-1',
      title: '收集金蝶本月产品数据',
      brief: '收集截至2026年5月21日的金蝶产品相关数据，注明数据来源和时间。',
      projectGoal: '输出金蝶本月产品分析报告',
    },
    contract: {
      kind: 'external_source_v1',
      required: true,
      requiresRecentEvidence: true,
      minQueries: 2,
      minResults: 2,
      minFetchedPages: 1,
      requireSourceUrls: true,
    },
    fetchFn,
    now,
  });

  assert.equal(evidence.validation.ok, true);
  assert.equal(evidence.provider, 'multi-search-html');
  assert.ok(evidence.queries.some(query => query.provider === 'bing-html'));
  assert.ok(evidence.queries.some(query => query.fallbacks?.some(fallback => fallback.provider === 'duckduckgo-html')));
  assert.ok(evidence.queries.flatMap(q => q.results).some(r => r.url.includes('kingdee.com/cn/news/product-ai-lingee')));
  assert.ok(evidence.fetchedPages.some(page => page.url.includes('kingdee.com/cn/news/product-ai-lingee') && page.ok));
});

test('decodes DuckDuckGo redirect URLs', () => {
  assert.equal(
    normalizeSearchUrl('//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.kingdee.com%2Fkais2026&rut=abc'),
    'https://www.kingdee.com/kais2026',
  );
});

test('rejects evidence with no results or fetched pages', () => {
  const invalid = validateSearchEvidence({
    queries: [],
    fetchedPages: [],
  }, {
    kind: 'external_source_v1',
    required: true,
    minResults: 1,
    minFetchedPages: 1,
  });

  assert.equal(invalid.ok, false);
  assert.equal(invalid.failureClass, 'quality_evidence_missing');
  assert.ok(invalid.reasons.includes('source_results_missing'));
  assert.ok(invalid.reasons.includes('source_fetch_missing'));
});

let passed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
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
  console.log(`\n${passed}/${tests.length} search evidence tests passed`);
}
