import { createHash } from 'node:crypto';

const DDG_URL = 'https://duckduckgo.com/html/';
const BING_URL = 'https://www.bing.com/search';
const MAX_RESULTS_PER_QUERY = 5;
const MAX_FETCH_BYTES = 120_000;

export async function collectSearchEvidence({
  task = {},
  contract = {},
  fetchFn = fetch,
  now = Date.now(),
} = {}) {
  const queries = buildSearchQueries(task, contract, now);
  const queryEvidence = [];
  const fetchedPages = [];
  const seenUrls = new Set();
  let searchProviders = buildSearchProviders();

  for (const query of queries) {
    const searchedAt = new Date(now).toISOString();
    const search = await searchWithProviderFallback(query, { fetchFn, providers: searchProviders });
    if (!search.provider) {
      queryEvidence.push({
        query,
        searchedAt,
        results: [],
        error: search.error,
        fallbacks: search.fallbacks,
      });
      continue;
    }

    if (search.provider !== searchProviders[0]?.name) {
      searchProviders = preferProvider(searchProviders, search.provider);
    }

    const results = search.results;
    queryEvidence.push({
      query,
      searchedAt,
      provider: search.provider,
      results,
      ...(search.fallbacks.length > 0 ? { fallbacks: search.fallbacks } : {}),
    });

    for (const result of results.slice(0, 2)) {
      if (!result.url || seenUrls.has(result.url)) continue;
      seenUrls.add(result.url);
      fetchedPages.push(await fetchPageEvidence(result.url, { fetchFn, now }));
    }
  }

  const evidence = {
    version: 1,
    kind: 'external_source_v1',
    taskId: task.id || task.taskId || null,
    generatedAt: new Date(now).toISOString(),
    provider: 'multi-search-html',
    contract,
    queries: queryEvidence,
    fetchedPages,
  };
  evidence.validation = validateSearchEvidence(evidence, contract);
  return evidence;
}

function buildSearchProviders() {
  return [
    { name: 'duckduckgo-html', search: searchDuckDuckGo },
    { name: 'bing-html', search: searchBing },
  ];
}

async function searchWithProviderFallback(query, { fetchFn = fetch, providers = buildSearchProviders() } = {}) {
  const fallbacks = [];
  let emptyProvider = null;
  let emptyFallbacks = [];

  for (const provider of providers) {
    try {
      const results = await provider.search(query, { fetchFn });
      if (results.length > 0) {
        return {
          provider: provider.name,
          results,
          fallbacks,
        };
      }
      emptyProvider = provider.name;
      emptyFallbacks = fallbacks.slice();
      fallbacks.push({ provider: provider.name, error: 'no_results' });
    } catch (error) {
      fallbacks.push({ provider: provider.name, error: formatSearchError(error) });
    }
  }

  if (emptyProvider) {
    return {
      provider: emptyProvider,
      results: [],
      fallbacks: emptyFallbacks,
    };
  }

  return {
    provider: null,
    results: [],
    fallbacks,
    error: fallbacks.map(fallback => `${fallback.provider}: ${fallback.error}`).join('; '),
  };
}

function preferProvider(providers, providerName) {
  const selected = providers.find(provider => provider.name === providerName);
  if (!selected) return providers;
  return [selected, ...providers.filter(provider => provider.name !== providerName)];
}

export function buildSearchQueries(task = {}, contract = {}, now = Date.now()) {
  const text = [
    task.title,
    task.brief,
    task.projectName,
    task.projectGoal,
    task.projectRequirements,
  ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  const currentYear = new Date(now).getUTCFullYear();
  const base = compactQuery(text, 36);
  const queries = [
    base,
    `${base} ${currentYear}`,
  ];

  if (contract.requiresRecentEvidence) {
    queries.push(`${base} 最新 发布`);
    queries.push(`${base} 官网 新闻稿`);
  }
  if (/金蝶/.test(text) && /AI/i.test(text)) {
    queries.push(`金蝶 AI 峰会 ${currentYear}`);
    queries.push(`site:kingdee.com 金蝶 AI ${currentYear}`);
  }

  const minQueries = Math.max(Number(contract.minQueries || 2), 1);
  return [...new Set(queries.filter(Boolean))].slice(0, minQueries + 4);
}

export async function searchDuckDuckGo(query, { fetchFn = fetch } = {}) {
  const response = await fetchFn(`${DDG_URL}?q=${encodeURIComponent(query)}`);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`.trim());
  const html = await response.text();
  return parseDuckDuckGoResults(html).slice(0, MAX_RESULTS_PER_QUERY);
}

export async function searchBing(query, { fetchFn = fetch } = {}) {
  const response = await fetchFn(`${BING_URL}?q=${encodeURIComponent(query)}`);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`.trim());
  const html = await response.text();
  return parseBingResults(html).slice(0, MAX_RESULTS_PER_QUERY);
}

export function parseDuckDuckGoResults(html = '') {
  const results = [];
  const regex = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>|<div[^>]*class="[^"]*result__snippet[^"]*"[^>]*>)([\s\S]*?)<\/(?:a|div)>/gi;
  for (const match of String(html || '').matchAll(regex)) {
    results.push({
      title: decodeHtml(stripHtml(match[2])),
      url: normalizeSearchUrl(decodeHtml(match[1])),
      snippet: decodeHtml(stripHtml(match[3])),
    });
  }
  return results.filter(result => result.title && result.url);
}

export function parseBingResults(html = '') {
  const results = [];
  const itemRegex = /<li[^>]*class="[^"]*\bb_algo\b[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
  for (const itemMatch of String(html || '').matchAll(itemRegex)) {
    const item = itemMatch[1];
    const link = item.match(/<h2[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h2>/i);
    if (!link) continue;
    const snippet = item.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const url = normalizeSearchUrl(decodeHtml(link[1]));
    if (!/^https?:\/\//i.test(url)) continue;
    results.push({
      title: decodeHtml(stripHtml(link[2])),
      url,
      snippet: snippet ? decodeHtml(stripHtml(snippet[1])) : '',
    });
  }
  return results.filter(result => result.title && result.url);
}

export function normalizeSearchUrl(raw = '') {
  const value = String(raw || '').trim();
  if (value.startsWith('//duckduckgo.com/l/')) {
    const parsed = new URL(`https:${value}`);
    return parsed.searchParams.get('uddg') || value;
  }
  if (value.startsWith('/l/')) {
    const parsed = new URL(`https://duckduckgo.com${value}`);
    return parsed.searchParams.get('uddg') || value;
  }
  return value.startsWith('//') ? `https:${value}` : value;
}

export async function fetchPageEvidence(url, { fetchFn = fetch, now = Date.now() } = {}) {
  try {
    const response = await fetchFn(url);
    const text = (await response.text()).slice(0, MAX_FETCH_BYTES);
    const excerpt = stripHtml(text).slice(0, 2000);
    return {
      url,
      fetchedAt: new Date(now).toISOString(),
      ok: response.ok,
      status: response.status,
      contentHash: `sha256:${createHash('sha256').update(text).digest('hex')}`,
      excerpt,
    };
  } catch (error) {
    return {
      url,
      fetchedAt: new Date(now).toISOString(),
      ok: false,
      status: 0,
      error: error instanceof Error ? error.message : String(error),
      excerpt: '',
    };
  }
}

export function validateSearchEvidence(evidence = {}, contract = {}) {
  const queries = Array.isArray(evidence.queries) ? evidence.queries : [];
  const results = queries.length > 0
    ? queries.flatMap(query => Array.isArray(query.results) ? query.results : [])
    : [];
  const fetched = Array.isArray(evidence.fetchedPages)
    ? evidence.fetchedPages.filter(page => page && page.ok)
    : [];
  const queryFailures = queries.filter(query => query?.error);
  const reasons = [];

  if (queries.length > 0 && queryFailures.length === queries.length) reasons.push('search_provider_failed');
  if (results.length < Number(contract.minResults || 1)) reasons.push('source_results_missing');
  if (fetched.length < Number(contract.minFetchedPages || 0)) reasons.push('source_fetch_missing');
  if (contract.requireSourceUrls !== false && results.some(result => !/^https?:\/\//i.test(result.url || ''))) {
    reasons.push('source_url_invalid');
  }
  const failureClass = reasons.length === 0
    ? null
    : reasons.includes('search_provider_failed')
      ? 'source_provider_unavailable'
      : 'quality_evidence_missing';

  return {
    ok: reasons.length === 0,
    failureClass,
    reasons,
    errors: queryFailures.map(query => query.error).filter(Boolean),
  };
}

function compactQuery(text, maxTerms) {
  return String(text || '')
    .replace(/[^\p{L}\p{N}\s.·-]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, maxTerms)
    .join(' ');
}

function stripHtml(text = '') {
  return String(text || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeHtml(text = '') {
  return String(text || '')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .trim();
}

function formatSearchError(error) {
  if (error instanceof Error) {
    const cause = error.cause instanceof Error
      ? error.cause.message
      : error.cause
        ? String(error.cause)
        : '';
    return cause ? `${error.message}: ${cause}` : error.message;
  }
  return String(error);
}
