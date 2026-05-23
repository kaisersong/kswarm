import { hasSpeculativeSourceLanguage } from './evidence-contract.js';
import { validateSearchEvidence } from './search-evidence.js';

const SOURCE_TASK_PATTERN = /搜索|检索|收集|调研|资料|来源|出处|URL|链接|官网|新闻稿|公告|发布会|财报|电话会|研报|行业分析|公开资料|今年|本月|本周|最新|最近|search|source|citation|url|official|news|filing|earnings|latest|recent|current/i;
const SOURCE_LINE_PATTERN = /来源|出处|URL|链接|官网|新闻|公告|发布会|财报|电话会|研报|报告|source|citation|url|official|news|filing|earnings/i;
const CURRENT_TIME_PATTERN = /今年|本年|本月|本周|最新|最近|current|latest|recent|this year|this month|this week/i;

export function requiresExternalSourceEvidence(task = {}) {
  const text = taskText(task);
  return SOURCE_TASK_PATTERN.test(text);
}

export function validateSourceEvidenceArtifact({
  title = '',
  brief = '',
  acceptanceCriteria = '',
  projectGoal = '',
  projectRequirements = '',
  content = '',
  evidenceContract = null,
  searchEvidence = null,
  now = Date.now(),
} = {}) {
  const task = { title, brief, acceptanceCriteria, projectGoal, projectRequirements };
  const contract = evidenceContract;
  if (contract?.required && contract.kind === 'external_source_v1') {
    if (contract.disallowSpeculativeLanguage !== false && hasSpeculativeSourceLanguage(content)) {
      return failure('speculative_source_claim', { currentYear: new Date(now).getUTCFullYear() });
    }
    const bundle = validateSearchEvidence(searchEvidence || {}, contract);
    if (!bundle.ok) {
      return failure(bundle.reasons?.[0] || 'source_evidence_missing', {
        reasons: bundle.reasons || [],
      });
    }
  }
  if (contract?.kind && contract.kind !== 'external_source_v1') return success();

  if (!requiresExternalSourceEvidence(task)) return success();

  const currentYear = new Date(now).getUTCFullYear();
  const targetYear = inferTargetYear(task, currentYear);
  const generatedYear = extractGeneratedYear(content);
  if (targetYear === currentYear && generatedYear && generatedYear !== currentYear) {
    return failure('stale_generated_date', { generatedYear, currentYear, targetYear });
  }

  if (targetYear === currentYear) {
    const sourceYears = extractSourceYears(content);
    if (sourceYears.length === 0) {
      return failure('source_evidence_missing', { currentYear, targetYear });
    }
    if (!sourceYears.includes(currentYear)) {
      return failure('current_year_source_missing', { currentYear, targetYear, sourceYears });
    }
  }

  return success();
}

function taskText(task = {}) {
  const values = [
    task.title,
    task.brief,
    task.acceptanceCriteria,
    task.projectGoal,
    task.projectRequirements,
  ];
  return values.flatMap(value => Array.isArray(value) ? value : [value]).filter(Boolean).join('\n');
}

function inferTargetYear(task, currentYear) {
  const text = taskText(task);
  const explicitYears = [...text.matchAll(/\b(20\d{2})\b/g)].map(match => Number(match[1]));
  if (explicitYears.includes(currentYear)) return currentYear;
  if (CURRENT_TIME_PATTERN.test(text)) return currentYear;
  return explicitYears[0] || null;
}

function extractGeneratedYear(content = '') {
  const lines = String(content || '').split(/\r?\n/).slice(0, 30);
  for (const line of lines) {
    if (!/生成时间|生成日期|报告日期|完成时间|Generated|Report date|Date/i.test(line)) continue;
    const year = parseYear(line);
    if (year) return year;
  }
  return null;
}

function extractSourceYears(content = '') {
  const years = [];
  for (const line of String(content || '').split(/\r?\n/)) {
    if (!SOURCE_LINE_PATTERN.test(line)) continue;
    for (const match of line.matchAll(/\b(20\d{2})\b/g)) {
      years.push(Number(match[1]));
    }
  }
  return [...new Set(years)].sort();
}

function parseYear(value = '') {
  const match = String(value || '').match(/\b(20\d{2})\b/);
  return match ? Number(match[1]) : null;
}

function success() {
  return { ok: true, failureClass: null, reason: null, details: {} };
}

function failure(reason, details = {}) {
  return {
    ok: false,
    failureClass: 'quality_evidence_missing',
    reason,
    details,
  };
}
