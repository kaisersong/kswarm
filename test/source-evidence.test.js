/**
 * KSwarm — source evidence quality tests
 *
 * Run: node test/source-evidence.test.js
 */

import assert from 'node:assert/strict';
import {
  requiresExternalSourceEvidence,
  validateSourceEvidenceArtifact,
} from '../src/core/source-evidence.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const now = Date.UTC(2026, 4, 21, 5, 0, 0);

test('detects current external research tasks from title, brief, and acceptance criteria', () => {
  assert.equal(requiresExternalSourceEvidence({
    title: '收集金蝶2026年产品与AI相关信息',
    brief: '搜索金蝶官网、新闻稿、发布会记录、行业分析报告。',
    acceptanceCriteria: '每条记录包含来源URL或文档名称',
  }), true);
  assert.equal(requiresExternalSourceEvidence({
    title: '根据评审意见修订报告',
    brief: '基于前序产物修订内容。',
  }), false);
});

test('rejects stale generated date and missing current-year source evidence', () => {
  const result = validateSourceEvidenceArtifact({
    title: '收集金蝶2026年产品与AI相关信息',
    brief: '搜索金蝶官网、新闻稿、发布会记录、行业分析报告。',
    acceptanceCriteria: '每条记录包含来源URL或文档名称',
    content: `# 金蝶2026年产品与AI信息收集笔记

**生成时间**：2025年8月27日

- 来源：金蝶官网新闻稿（2025-05-20）https://www.kingdee.com/news/20250520
- 来源：金蝶2025年中期业绩公告（2025-08-15）
`,
    now,
  });

  assert.equal(result.ok, false);
  assert.equal(result.failureClass, 'quality_evidence_missing');
  assert.equal(result.reason, 'stale_generated_date');
});

test('rejects current-year research with no current-year dated source', () => {
  const result = validateSourceEvidenceArtifact({
    title: '收集金蝶2026年产品与AI相关信息',
    brief: '搜索金蝶官网、新闻稿、发布会记录、行业分析报告。',
    acceptanceCriteria: '每条记录包含来源URL或文档名称',
    content: `# 金蝶2026年产品与AI信息收集笔记

**生成时间**：2026年5月21日

- 来源：金蝶官网新闻稿（2025-05-20）https://www.kingdee.com/news/20250520
- 来源：金蝶2025年中期业绩公告（2025-08-15）
`,
    now,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'current_year_source_missing');
});

test('accepts current-year source evidence with current generated date', () => {
  const result = validateSourceEvidenceArtifact({
    title: '收集金蝶2026年产品与AI相关信息',
    brief: '搜索金蝶官网、新闻稿、发布会记录、行业分析报告。',
    acceptanceCriteria: '每条记录包含来源URL或文档名称',
    content: `# 金蝶2026年产品与AI信息收集笔记

**生成时间**：2026年5月21日

- 来源：金蝶官网产品公告（2026-03-18）https://www.kingdee.com/news/20260318
- 来源：金蝶2026年一季度业绩交流材料（2026-04-30）
`,
    now,
  });

  assert.equal(result.ok, true);
});

test('rejects speculative source claims even when search evidence exists', () => {
  const result = validateSourceEvidenceArtifact({
    title: '收集金蝶2026年AI产品公开信息',
    brief: '搜索金蝶官网、新闻稿、发布会记录。',
    projectGoal: '金蝶今年AI产品分析',
    content: '由于无法实时爬取最新官网链接，以下内容基于合理推断。',
    evidenceContract: {
      kind: 'external_source_v1',
      required: true,
      disallowSpeculativeLanguage: true,
      minResults: 1,
      minFetchedPages: 1,
    },
    searchEvidence: {
      queries: [{
        query: '金蝶 AI 峰会 2026',
        results: [{
          title: '金蝶AI峰会2026',
          url: 'https://www.kingdee.com/kais2026',
          snippet: '2026年5月20日 灵基 Lingee',
        }],
      }],
      fetchedPages: [{
        url: 'https://www.kingdee.com/kais2026',
        ok: true,
        excerpt: '2026年5月20日 灵基 Lingee',
      }],
    },
    now,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'speculative_source_claim');
});

test('accepts evidence-required current research when search evidence backs the content', () => {
  const result = validateSourceEvidenceArtifact({
    title: '收集金蝶2026年AI产品公开信息',
    brief: '搜索金蝶官网、新闻稿、发布会记录。',
    projectGoal: '金蝶今年AI产品分析',
    content: '来源：金蝶AI峰会2026 https://www.kingdee.com/kais2026',
    evidenceContract: {
      kind: 'external_source_v1',
      required: true,
      minResults: 1,
      minFetchedPages: 1,
    },
    searchEvidence: {
      queries: [{
        query: '金蝶 AI 峰会 2026',
        results: [{
          title: '金蝶AI峰会2026',
          url: 'https://www.kingdee.com/kais2026',
          snippet: '2026年5月20日 灵基 Lingee',
        }],
      }],
      fetchedPages: [{
        url: 'https://www.kingdee.com/kais2026',
        ok: true,
        excerpt: '2026年5月20日 灵基 Lingee',
      }],
    },
    now,
  });

  assert.equal(result.ok, true);
});

test('does not apply generic source gate to review iteration tasks with current project wording', () => {
  const result = validateSourceEvidenceArtifact({
    title: '对抗性评审第一轮报告',
    brief: '以挑战者角度审阅第一轮报告，输出评审意见。',
    projectGoal: '输出金蝶本月产品分析报告',
    projectRequirements: '要进行2轮分析，是提供给研发高层看的内容，要有高度',
    content: `# 对抗性评审意见

## Verdict
needs_changes

## Findings
- 数据摘要对无法确认的信息处理过于保守，导致后续战略洞察不足。
- 需要把已确认与未确认的信息拆开，避免把所有维度都归为未知。
`,
    evidenceContract: {
      kind: 'review_iteration_v1',
      requiredArtifacts: ['review-evidence.json'],
      requiredFields: ['verdict', 'findings'],
    },
    now,
  });

  assert.equal(result.ok, true);
});

let passed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
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
  console.log(`\n${passed}/${tests.length} source evidence tests passed`);
}
