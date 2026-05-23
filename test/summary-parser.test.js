/**
 * KSwarm — Project summary parser tests
 *
 * Run: node test/summary-parser.test.js
 */

import assert from 'node:assert/strict';
import {
  ensureProjectSummarySection,
  extractSummarySection,
  extractSummaryScore,
  extractTaskScores,
} from '../src/core/summary-parser.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('keeps existing project summary unchanged', () => {
  const synthesis = `# 交付总结

正文

## 项目小结

### 评分
评分: 8/10

### 任务评分
- 收集数据 @Worker: 8/10 — 完成
`;

  const ensured = ensureProjectSummarySection(synthesis, { lang: 'zh' });

  assert.equal(ensured, synthesis);
  assert.ok(extractSummarySection(ensured).includes('评分: 8/10'));
  assert.equal(extractSummaryScore(ensured), 8);
  assert.equal(extractTaskScores(ensured)[0].title, '收集数据');
});

test('appends deterministic project summary when PO synthesis omitted it', () => {
  const ensured = ensureProjectSummarySection(`# 交付总结

全部任务已完成，最终报告已生成。`, {
    lang: 'zh',
    tasks: [
      { title: '收集金蝶本月产品数据', assignedAgent: 'Qoder', status: 'done' },
      { title: '使用report renderer生成HTML报告', assignedAgent: 'xiaok-po', status: 'done' },
    ],
    finalFiles: [
      { filename: '金蝶本月产品分析报告.html', mimeType: 'text/html', size: 11201 },
    ],
  });

  assert.ok(ensured.includes('## 项目小结'));
  assert.ok(ensured.includes('评分: 8/10'));
  assert.ok(ensured.includes('- 收集金蝶本月产品数据 @Qoder: 8/10'));
  assert.ok(ensured.includes('- 使用report renderer生成HTML报告 @xiaok-po: 8/10'));
  assert.ok(ensured.includes('金蝶本月产品分析报告.html'));
  assert.equal(extractSummaryScore(ensured), 8);
  assert.equal(extractTaskScores(ensured).length, 2);
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
  console.log(`\n${passed}/${tests.length} summary parser tests passed`);
}
