const EXTERNAL_SOURCE_PATTERN = /搜索|检索|收集|调研|资料|来源|出处|URL|链接|官网|新闻稿|公告|发布会|财报|电话会|研报|行业分析|公开资料|公开信息|search|source|citation|url|official|news|filing|earnings|research/i;
const RECENT_PATTERN = /今年|本年|本月|本周|昨天|今日|今天|最新|最近|新发布|current|latest|recent|this year|this month|this week|yesterday|newly released/i;
const SPECULATIVE_SOURCE_PATTERN = /无法实时(?:搜索|爬取|访问)|无法直接访问|基于(?:公开知识|认知边界|战略惯性|合理推断)|逻辑推断|非编造URL|not able to browse|cannot browse|without live search/i;

export function inferEvidenceContract(task = {}, options = {}) {
  const explicit = task.evidenceContract;
  if (explicit && explicit.required === false) {
    return {
      version: explicit.version || 1,
      kind: explicit.kind || 'none',
      required: false,
      reason: explicit.reason || 'explicit_opt_out',
    };
  }
  if (explicit && explicit.required === true) {
    return normalizeExternalContract(explicit, task, options);
  }

  const text = collectTaskText(task);
  if (!EXTERNAL_SOURCE_PATTERN.test(text)) {
    return { version: 1, kind: 'none', required: false, reason: 'no_external_source_signal' };
  }

  return normalizeExternalContract({
    required: true,
    requiresRecentEvidence: isRecentTask(text, options.now),
  }, task, options);
}

export function hasSpeculativeSourceLanguage(content = '') {
  return SPECULATIVE_SOURCE_PATTERN.test(String(content || ''));
}

function normalizeExternalContract(contract = {}, task = {}, options = {}) {
  const text = collectTaskText(task);
  const requiresRecentEvidence = contract.requiresRecentEvidence ?? isRecentTask(text, options.now);
  return {
    version: 1,
    kind: 'external_source_v1',
    required: true,
    requiresRecentEvidence,
    freshnessWindowDays: Number(contract.freshnessWindowDays || (requiresRecentEvidence ? 7 : 30)),
    minQueries: Number(contract.minQueries || (requiresRecentEvidence ? 2 : 1)),
    minResults: Number(contract.minResults || 3),
    minFetchedPages: Number(contract.minFetchedPages || (requiresRecentEvidence ? 1 : 0)),
    requireSourceUrls: contract.requireSourceUrls !== false,
    disallowSpeculativeLanguage: contract.disallowSpeculativeLanguage !== false,
    requiredArtifact: contract.requiredArtifact || 'search-evidence.json',
  };
}

function isRecentTask(text, now = Date.now()) {
  if (RECENT_PATTERN.test(text)) return true;
  const currentYear = new Date(now).getUTCFullYear();
  return [...String(text || '').matchAll(/\b(20\d{2})\b/g)]
    .some(match => Number(match[1]) === currentYear);
}

function collectTaskText(task = {}) {
  const parts = [
    task.title,
    task.brief,
    task.description,
    task.requirements,
    task.acceptanceCriteria,
    task.projectName,
    task.projectGoal,
    task.projectRequirements,
  ];
  return parts.flatMap(value => Array.isArray(value) ? value : [value]).filter(Boolean).join('\n');
}
