import { isContractFamily } from './contract-kind-registry.js';

export function shouldCollectSearchEvidence(evidenceContract) {
  // design §5.1.1：统一走 contract kind registry 分派，而不是硬编码
  // 'external_source_v1' 单值判断，防止未来新增的 external_source_v2 在这个
  // 判定点被静默漏检（既不报错，也不采集证据）。
  return evidenceContract?.required === true && isContractFamily(evidenceContract.kind, 'external_source');
}

export function buildEvidencePromptSection(evidence = {}) {
  const resultLines = [];
  for (const query of evidence.queries || []) {
    resultLines.push(`Query: ${query.query}`);
    for (const result of query.results || []) {
      resultLines.push(`- ${result.title}\n  URL: ${result.url}\n  Snippet: ${result.snippet}`);
    }
  }

  const fetchLines = [];
  for (const page of evidence.fetchedPages || []) {
    fetchLines.push(`- ${page.url}\n  Fetched: ${page.ok ? 'ok' : 'failed'} ${page.status || ''}\n  Excerpt: ${(page.excerpt || '').slice(0, 1000)}`);
  }

  return [
    '## Required Search Evidence',
    'The file artifacts/search-evidence.json records the external evidence for this task.',
    '禁止新增未出现在搜索证据中的事实；无法确认的事实必须写为“未在证据中确认”。',
    '### Search Results',
    resultLines.join('\n'),
    '### Fetched Pages',
    fetchLines.join('\n'),
  ].join('\n\n');
}
