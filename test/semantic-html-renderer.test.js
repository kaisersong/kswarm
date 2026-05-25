/**
 * KSwarm — semantic HTML renderer tests
 *
 * Run: node test/semantic-html-renderer.test.js
 */

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateDeliverableContract } from '../src/core/deliverable-contract.js';
import {
  buildReportHtmlFromMarkdown,
  buildSemanticOutputArtifacts,
  hasRequiredOutputType,
} from '../src/core/semantic-html-renderer.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('detects required output types from execution requirements', () => {
  assert.equal(hasRequiredOutputType([{ type: 'report_html', enforcement: 'hard' }], 'report_html'), true);
  assert.equal(hasRequiredOutputType([{ type: 'html_report', enforcement: 'hard' }], 'report_html'), true);
  assert.equal(hasRequiredOutputType([{ type: 'markdown', enforcement: 'hard' }], 'report_html'), false);
});

test('materializes report_html as renderer-contract HTML', () => {
  const artifacts = buildSemanticOutputArtifacts({
    taskId: 'proj-1__item-3.1',
    title: '使用report renderer生成HTML报告',
    artifactContent: `# 金蝶本月产品分析报告

## 执行摘要
金蝶本月产品动态显示，企业管理软件正在围绕 AI 原生能力、数据治理和行业场景闭环推进。

## 战略洞察
- AI 产品能力需要与财务、供应链、人力等业务流程结合。
- 研发高层需要关注平台化能力、模型治理、数据可信和生态协同。

## 研发启示
短期看，报告需要把产品发布、客户场景、技术架构和生态动作放在同一张图上理解，避免只罗列功能。
中期看，研发团队要重点关注 AI 能力是否可以沉淀为可复用的平台服务，以及这些服务能否支撑多产品线一致演进。
长期看，金蝶的产品竞争力取决于业务数据、行业知识、模型能力和交付体系之间能否形成闭环。
`,
    requiredOutputs: [{ type: 'report_html', enforcement: 'hard' }],
  });

  assert.equal(artifacts.length, 1);
  const [artifact] = artifacts;
  assert.equal(artifact.filename, 'proj-1__item-3.1-report.html');
  assert.equal(artifact.mimeType, 'text/html');
  assert.equal(artifact.previewable, true);
  assert.ok(artifact.content.includes('data-template="kai-report-creator"'));
  assert.ok(artifact.content.includes('<h1>金蝶本月产品分析报告</h1>'));
  assert.ok(artifact.content.includes('<li>AI 产品能力需要与财务、供应链、人力等业务流程结合。</li>'));

  const dir = mkdtempSync(join(tmpdir(), 'kswarm-report-html-'));
  try {
    const artifactsDir = join(dir, 'artifacts');
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(join(artifactsDir, artifact.filename), artifact.content, 'utf-8');
    const validation = validateDeliverableContract({
      requiredOutputs: [{ type: 'report_html', enforcement: 'hard' }],
      workspacePath: dir,
      artifacts: [{
        filename: artifact.filename,
        relativePath: `artifacts/${artifact.filename}`,
        mimeType: artifact.mimeType,
      }],
    });
    assert.equal(validation.ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('does not materialize semantic html when report_html is not required', () => {
  const artifacts = buildSemanticOutputArtifacts({
    taskId: 'proj-1__item-1',
    title: '普通 Markdown 任务',
    artifactContent: '# 普通任务',
    requiredOutputs: [{ type: 'markdown', enforcement: 'hard' }],
  });

  assert.deepEqual(artifacts, []);
});

test('cleans internal review and revision markers from user-facing report HTML', () => {
  const html = buildReportHtmlFromMarkdown({
    title: '金蝶本月产品分析报告（第二轮修订定稿）',
    markdown: `# 金蝶本月产品分析报告（第二轮修订定稿）

## 报告摘要
【新增】这是最终要提交给用户的正式内容。

## 评审回应与修订说明
### Finding F1
- 采纳：已补充来源。
- 不采纳：原因如下。

## 业务影响（修订版）
金蝶本月产品分析应作为正式报告阅读。`,
  });

  assert.ok(html.includes('<h1>金蝶本月产品分析报告</h1>'));
  assert.ok(html.includes('这是最终要提交给用户的正式内容。'));
  assert.ok(html.includes('<h2>业务影响</h2>'));
  assert.ok(!html.includes('第二轮修订定稿'));
  assert.ok(!html.includes('评审回应与修订说明'));
  assert.ok(!html.includes('Finding F1'));
  assert.ok(!html.includes('【新增】'));
  assert.ok(!html.includes('修订版'));
  assert.ok(!html.includes('采纳：'));
  assert.ok(!html.includes('不采纳：'));
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
  console.log(`\n${passed}/${tests.length} semantic HTML renderer tests passed`);
}
