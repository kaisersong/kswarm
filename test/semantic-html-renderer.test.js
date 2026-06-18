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

// ─── v2.1 JSON-LD embed tests (#9-#12) ───────────────────────────

test('#9 HTML 注入点：<head> 内含 <script type="application/ld+json">', () => {
  const html = buildReportHtmlFromMarkdown({
    title: 'JSON-LD Test',
    markdown: '## hi',
    generatedAt: '2026-06-17T10:00:00.000Z',
    taskId: 'task-001',
    projectId: 'proj-abc',
    projectName: 'Test Project',
  });
  // script tag must exist
  assert.ok(html.includes('<script type="application/ld+json">'), 'must contain ld+json script tag');
  // must be inside <head>
  const headStart = html.indexOf('<head>');
  const headEnd = html.indexOf('</head>');
  const scriptIdx = html.indexOf('<script type="application/ld+json">');
  assert.ok(headStart >= 0 && headEnd > headStart, 'must have <head>...</head>');
  assert.ok(scriptIdx > headStart && scriptIdx < headEnd, 'JSON-LD script must be inside <head>');
});

test('#10 HTML round-trip: 提取 script 内容 → 反转 <\\/ → JSON.parse 字段正确', () => {
  const html = buildReportHtmlFromMarkdown({
    title: 'Round Trip',
    markdown: '## hi',
    generatedAt: '2026-06-17T10:00:00.000Z',
    taskId: 'task-001',
    projectId: 'proj-abc',
    projectName: 'P',
  });
  const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  assert.ok(m, 'must match script tag content');
  // reverse the </ -> <\/ escape
  const unescaped = m[1].replace(/<\\\//g, '</');
  const obj = JSON.parse(unescaped);
  assert.equal(obj['@context'], 'http://schema.org/');
  assert.equal(obj['@type'], 'Report');
  assert.equal(obj.name, 'Round Trip');
  assert.equal(obj.dateCreated, '2026-06-17T10:00:00.000Z');
  assert.equal(obj['@id'], 'https://xiaok.app/id/project/proj-abc/task/task-001/report');
  assert.equal(obj.isPartOf.name, 'P');
});

test('#11 向后兼容：不传新参数（taskId/projectId/projectName）时仍生成合法 HTML', () => {
  const html = buildReportHtmlFromMarkdown({
    title: 'Legacy Caller',
    markdown: '## hi',
    generatedAt: '2026-06-17T10:00:00.000Z',
  });
  // body still rendered
  assert.ok(html.includes('<h1>Legacy Caller</h1>') || html.includes('<h2>hi</h2>'));
  // JSON-LD should still be injected (with minimal fields)
  assert.ok(html.includes('<script type="application/ld+json">'));
  const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  const unescaped = m[1].replace(/<\\\//g, '</');
  const obj = JSON.parse(unescaped);
  assert.equal(obj.name, 'Legacy Caller');
  assert.equal(obj['@id'], undefined, '缺 projectId+taskId 时 @id 应省略');
  assert.equal(obj.isPartOf, undefined, '缺 projectId 时 isPartOf 应省略');
  assert.equal(obj.creator['@type'], 'Organization');
});

test('#12 buildSemanticOutputArtifacts 集成：传 projectId/projectName 后 HTML 含 isPartOf', () => {
  const artifacts = buildSemanticOutputArtifacts({
    taskId: 'proj-1__item-1',
    title: '集成测试报告',
    artifactContent: '# 集成测试报告\n\n## 说明\n这是 v2.1 集成测试。',
    requiredOutputs: [{ type: 'report_html', enforcement: 'hard' }],
    generatedAt: '2026-06-17T12:00:00.000Z',
    projectId: 'proj-1',
    projectName: 'Integration Test Project',
  });
  assert.equal(artifacts.length, 1);
  const html = artifacts[0].content;
  const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  assert.ok(m, 'JSON-LD script tag must exist');
  const obj = JSON.parse(m[1].replace(/<\\\//g, '</'));
  assert.equal(obj.isPartOf['@id'], 'https://xiaok.app/id/project/proj-1');
  assert.equal(obj.isPartOf.name, 'Integration Test Project');
  assert.equal(obj['@id'], 'https://xiaok.app/id/project/proj-1/task/proj-1__item-1/report');
});

test('#12b buildSemanticOutputArtifacts 不传 projectId/projectName：JSON-LD 退化为 minimal', () => {
  const artifacts = buildSemanticOutputArtifacts({
    taskId: 'proj-2__item-1',
    title: '无 project 信息报告',
    artifactContent: '# 无 project 信息报告',
    requiredOutputs: [{ type: 'report_html', enforcement: 'hard' }],
    generatedAt: '2026-06-17T12:00:00.000Z',
  });
  assert.equal(artifacts.length, 1);
  const html = artifacts[0].content;
  const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  const obj = JSON.parse(m[1].replace(/<\\\//g, '</'));
  assert.equal(obj.isPartOf, undefined);
  assert.equal(obj['@id'], undefined);
  assert.equal(obj.name, '无 project 信息报告');
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
