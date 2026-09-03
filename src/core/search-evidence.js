import { createHash } from 'node:crypto';
import { buildArtifactEvidenceExtension } from './artifact-evidence-extension.js';

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

/**
 * design §5.1：external_source_v2 真实证据采集——用 fetchPageEvidenceV2 做落盘
 * 抓取（区别于 v1 collectSearchEvidence 的内存摘要级 fetchPageEvidence）。
 *
 * 范围边界：只负责"候选 URL → 真实落盘抓取 → fetchedPages"这一段。
 * claims（claim→source 映射）由调用方显式提供，本函数原样保留、不自动填充
 * sourceArtifactIds——那是任务语义层面的信息，不是采集阶段能推导的。
 *
 * @param {Object} params
 * @param {Object} params.task
 * @param {Object} params.contract
 * @param {string[]} params.candidateUrls 待抓取的候选 URL 列表（由调用方提供，
 *   本函数不做搜索——搜索仍可复用 buildSearchQueries + searchWithProviderFallback
 *   拿到候选 URL 后传入本函数）
 * @param {Array} [params.claims]
 * @param {string} params.snapshotDir fetchPageEvidenceV2 的落盘目录
 * @param {Function} [params.fetchFn]
 * @param {number} [params.now]
 */
export async function collectSearchEvidenceV2({
  task = {},
  contract = {},
  candidateUrls = [],
  claims = [],
  snapshotDir,
  runId = null,
  fetchFn = fetch,
  now = Date.now(),
} = {}) {
  const fetchedPages = [];
  const evidenceExtensions = [];
  for (const url of candidateUrls) {
    const artifactId = `page-${createHash('sha256').update(url).digest('hex').slice(0, 16)}`;
    const snapshotFilename = `${artifactId}.snapshot`;
    const result = await fetchPageEvidenceV2(url, {
      fetchFn,
      now,
      snapshotDir,
      snapshotFilename,
    });
    // fetchPageEvidenceV2 返回 snapshotPath；validateSearchEvidenceV2/§5.1 契约
    // 用 snapshotRef 命名这个字段（"snapshot ref"）。做一次显式映射，不改动
    // fetchPageEvidenceV2 本身的既有返回字段名（避免影响其它潜在调用方）。
    const { snapshotPath, ...rest } = result;
    fetchedPages.push({ ...rest, snapshotRef: snapshotPath, artifactId });

    // design §3.5：每个真实落盘的来源都应产出对应的 ArtifactEvidenceExtensionV1
    // 记录（fetch 元数据 + claim 关联），供未来 canonical artifact 注册时一并
    // 持久化。runId 缺失时（例如测试或尚未真正接入 task run 上下文的场景）
    // 跳过 extension 构造而不是抛错——buildArtifactEvidenceExtension 本身要求
    // runId 必填，这是 caller 的责任边界，不在本函数内静默伪造一个 runId。
    if (runId && result.fetchCompleted) {
      const relatedClaimIds = (Array.isArray(claims) ? claims : [])
        .filter(claim => Array.isArray(claim?.sourceArtifactIds) && claim.sourceArtifactIds.includes(artifactId))
        .map(claim => claim.claimId)
        .filter(Boolean);
      evidenceExtensions.push(buildArtifactEvidenceExtension({
        artifactId,
        runId,
        claimIds: relatedClaimIds,
        fetch: {
          fetchedAt: result.fetchedAt,
          contentLength: result.contentLength,
          bytesStored: result.bytesStored,
          truncated: result.truncated,
          fetchCompleted: result.fetchCompleted,
        },
      }));
    }
  }

  const evidence = {
    version: 2,
    kind: 'external_source_v2',
    taskId: task.id || task.taskId || null,
    generatedAt: new Date(now).toISOString(),
    fetchedPages,
    claims: Array.isArray(claims) ? claims : [],
    evidenceExtensions,
  };
  evidence.validation = validateSearchEvidenceV2(evidence, contract);
  return evidence;
}

/**
 * design §5.1：collectSearchEvidenceV2 只负责"候选 URL → 真实落盘抓取"，不做
 * 搜索。本函数复用与 v1 collectSearchEvidence 相同的搜索/candidate 发现逻辑
 * （buildSearchQueries + searchWithProviderFallback），找到候选 URL 后交给
 * collectSearchEvidenceV2 做真实落盘抓取，产出与 v1 对等的一体化调用体验，
 * 供 auto-worker.js 直接替换 v1 调用（schema v2 项目场景）。
 *
 * @param {Object} params
 * @param {Object} params.task
 * @param {Object} params.contract
 * @param {Array} [params.claims]
 * @param {string} params.snapshotDir
 * @param {string} [params.runId]
 * @param {Function} [params.fetchFn]
 * @param {number} [params.now]
 */
export async function collectSearchEvidenceV2WithSearch({
  task = {},
  contract = {},
  claims = [],
  snapshotDir,
  runId = null,
  fetchFn = fetch,
  now = Date.now(),
} = {}) {
  const queries = buildSearchQueries(task, contract, now);
  const candidateUrls = [];
  const seenUrls = new Set();
  let searchProviders = buildSearchProviders();

  for (const query of queries) {
    const search = await searchWithProviderFallback(query, { fetchFn, providers: searchProviders });
    if (!search.provider) continue;
    if (search.provider !== searchProviders[0]?.name) {
      searchProviders = preferProvider(searchProviders, search.provider);
    }
    for (const result of search.results.slice(0, 2)) {
      if (!result.url || seenUrls.has(result.url)) continue;
      seenUrls.add(result.url);
      candidateUrls.push(result.url);
    }
  }

  return collectSearchEvidenceV2({
    task,
    contract,
    candidateUrls,
    claims,
    snapshotDir,
    runId,
    fetchFn,
    now,
  });
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

const DEFAULT_MAX_SNAPSHOT_BYTES = 10 * 1024 * 1024; // 10 MiB 默认硬上限（design §3.5）

/**
 * v2 fetch 规则（design §3.5）：响应流写入 task/run snapshots/ 临时文件，同时
 * 计算 exact stored bytes 的 sha256，成功后原子 rename；记录
 * contentLength/bytesStored/truncated/fetchCompleted。
 *
 * 与 v1 fetchPageEvidence 的关键区别：v1 对整段文本先 slice(0, MAX_FETCH_BYTES)
 * 再算 hash，hash 只覆盖截断后的内容；v2 落盘的是精确写入的字节数，hash 覆盖
 * 实际存储的全部字节（不多不少），并显式标记 truncated，供 gate evaluator
 * 判断该来源是否可作为高风险 claim 的唯一证据。
 *
 * 这是纯粹的字节级抓取与落盘，不做 HTML 解析/摘要（v1 的 excerpt 逻辑保留在
 * fetchPageEvidence，v2 的调用方如需摘要应对落盘后的文件自行处理）。
 */
export async function fetchPageEvidenceV2(url, {
  fetchFn = fetch,
  now = Date.now(),
  snapshotDir,
  snapshotFilename,
  maxBytes = DEFAULT_MAX_SNAPSHOT_BYTES,
  writeFileFn,
  renameFileFn,
  mkdirFn,
} = {}) {
  const fetchedAt = new Date(now).toISOString();
  if (!snapshotDir || !snapshotFilename) {
    return {
      url,
      fetchedAt,
      ok: false,
      status: 0,
      error: 'snapshot_destination_required',
      bytesStored: 0,
      truncated: false,
      fetchCompleted: false,
    };
  }

  let response;
  try {
    response = await fetchFn(url);
  } catch (error) {
    return {
      url,
      fetchedAt,
      ok: false,
      status: 0,
      error: error instanceof Error ? error.message : String(error),
      bytesStored: 0,
      truncated: false,
      fetchCompleted: false,
    };
  }

  const contentLengthHeader = response.headers?.get?.('content-length');
  const contentLength = contentLengthHeader ? Number(contentLengthHeader) : undefined;

  let bodyBuffer;
  try {
    const arrayBuffer = await response.arrayBuffer();
    bodyBuffer = Buffer.from(arrayBuffer);
  } catch (error) {
    return {
      url,
      fetchedAt,
      ok: false,
      status: response.status || 0,
      error: error instanceof Error ? error.message : String(error),
      bytesStored: 0,
      truncated: false,
      fetchCompleted: false,
    };
  }

  const truncated = bodyBuffer.length > maxBytes;
  const storedBuffer = truncated ? bodyBuffer.subarray(0, maxBytes) : bodyBuffer;
  const contentHash = `sha256:${createHash('sha256').update(storedBuffer).digest('hex')}`;

  const doMkdir = mkdirFn || (async (dir) => {
    const { mkdir } = await import('node:fs/promises');
    return mkdir(dir, { recursive: true });
  });
  const doWriteFile = writeFileFn || (async (path, data) => {
    const { writeFile } = await import('node:fs/promises');
    return writeFile(path, data);
  });
  const doRename = renameFileFn || (async (from, to) => {
    const { rename } = await import('node:fs/promises');
    return rename(from, to);
  });

  const { join: joinPath } = await import('node:path');
  const finalPath = joinPath(snapshotDir, snapshotFilename);
  const tempPath = `${finalPath}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    await doMkdir(snapshotDir);
    await doWriteFile(tempPath, storedBuffer);
    await doRename(tempPath, finalPath);
  } catch (error) {
    return {
      url,
      fetchedAt,
      ok: false,
      status: response.status || 0,
      error: `snapshot_write_failed: ${error instanceof Error ? error.message : String(error)}`,
      bytesStored: 0,
      truncated: false,
      fetchCompleted: false,
    };
  }

  return {
    url,
    fetchedAt,
    ok: response.ok,
    status: response.status,
    contentHash,
    snapshotPath: finalPath,
    ...(Number.isFinite(contentLength) ? { contentLength } : {}),
    bytesStored: storedBuffer.length,
    truncated,
    fetchCompleted: true,
  };
}

/**
 * design §5.1：external_source_v2 的真实校验实现（fetchPageEvidenceV2 产出的
 * fetchedPages + claim/source 引用映射）。与 validateSearchEvidence（v1）并存，
 * 不修改 v1 行为——v1 只是摘要级校验，v2 要求真实落盘 snapshot、hash、显式
 * claim→source 映射。
 *
 * @param {Object} evidence
 * @param {Array} evidence.fetchedPages fetchPageEvidenceV2 的返回值数组，每项
 *   需要额外携带 caller 分配的 artifactId（用于 claim.sourceArtifactIds 引用）
 * @param {Array} evidence.claims [{claimId, text, sourceArtifactIds[], riskLevel}]
 * @param {string} [evidence.userOptOutReason] minFetchedPages=0 时的用户显式
 *   opt-out 原因记录
 * @param {Object} contract
 * @param {number} [contract.minFetchedPages=1]
 */
export function validateSearchEvidenceV2(evidence = {}, contract = {}) {
  const minFetchedPages = Number.isFinite(contract.minFetchedPages) ? contract.minFetchedPages : 1;
  const fetchedPages = Array.isArray(evidence.fetchedPages) ? evidence.fetchedPages : [];
  const claims = Array.isArray(evidence.claims) ? evidence.claims : [];
  const reasons = [];

  // §5.1 步骤 1 的 0 值例外："0 只能由确定性规则确认任务不需要实际外部取回，
  // 或由用户显式 opt-out 并记录原因；planner 不能自行降为 0"。本函数不做
  // "确定性规则确认不需要"的语义判断（那属于 planner/contract 生成阶段），
  // 只强制"缺失 userOptOutReason 时不允许静默通过"这一条 fail-closed 规则。
  if (minFetchedPages === 0) {
    if (!evidence.userOptOutReason || typeof evidence.userOptOutReason !== 'string' || !evidence.userOptOutReason.trim()) {
      reasons.push('min_fetched_pages_zero_requires_opt_out_reason');
      return { ok: false, verdict: 'blocked', reasons };
    }
    return { ok: true, verdict: 'passed', reasons: [] };
  }

  const okPages = fetchedPages.filter(page => page?.ok === true);

  // §5.1 步骤 1：至少一个实际 fetched page。
  if (okPages.length < minFetchedPages) {
    reasons.push('source_fetch_missing');
  }

  // §5.1 步骤 2：每个计入结论的来源必须有 fetchedAt/contentHash/snapshotRef。
  const incompletePages = okPages.filter(page => !page.fetchedAt || !page.contentHash || !page.snapshotRef);
  if (incompletePages.length > 0) {
    reasons.push('source_evidence_incomplete');
  }

  // §5.1 步骤 3：每个关键 claim 必须显式关联至少一个 source evidence ref，
  // 且该 ref 必须指向一个真实存在的 fetched page（不能引用不存在的证据）。
  const pageArtifactIds = new Set(okPages.map(page => page.artifactId).filter(Boolean));
  for (const claim of claims) {
    const sourceIds = Array.isArray(claim?.sourceArtifactIds) ? claim.sourceArtifactIds.filter(Boolean) : [];
    if (sourceIds.length === 0) {
      reasons.push('claim_missing_source_ref');
      continue;
    }
    const hasMissingRef = sourceIds.some(id => !pageArtifactIds.has(id));
    if (hasMissingRef) {
      reasons.push('claim_source_ref_not_found');
      continue;
    }
    // §5.1 附加规则：truncated=true 的来源不能作为 high 风险 claim 的唯一证据。
    if (claim.riskLevel === 'high') {
      const referencedPages = okPages.filter(page => sourceIds.includes(page.artifactId));
      const allTruncated = referencedPages.length > 0 && referencedPages.every(page => page.truncated === true);
      if (allTruncated) {
        reasons.push('truncated_source_insufficient_for_high_risk_claim');
      }
    }
  }

  const uniqueReasons = [...new Set(reasons)];
  if (uniqueReasons.length === 0) {
    return { ok: true, verdict: 'passed', reasons: [] };
  }

  // §5.1 步骤 4：所有来源均取回失败时 verdict 只能是 waiting_for_evidence
  // （不是 blocked——取回失败是"证据尚未产生"，不是"证据证明了失败结论"）。
  const allSourcesFailed = fetchedPages.length > 0 && okPages.length === 0;
  const onlyMissingFetch = uniqueReasons.length === 1 && uniqueReasons[0] === 'source_fetch_missing';
  const verdict = (allSourcesFailed || onlyMissingFetch) ? 'waiting_for_evidence' : 'blocked';

  return { ok: false, verdict, reasons: uniqueReasons };
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
