/**
 * KSwarm — generated artifact quality gate tests
 *
 * Run: node test/artifact-quality.test.js
 */

import assert from 'node:assert/strict';
import { classifyGeneratedArtifact, isContentHeavyTask } from '../src/core/artifact-quality.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('content-heavy report with only title and date is rejected as empty output', () => {
  const result = classifyGeneratedArtifact({
    title: '撰写报告草稿',
    brief: '生成一份完整分析报告，包含摘要、方法、对比、对抗性评论、结论和引用。',
    content: '# OpenAI 本月新特性分析报告\n\n**报告日期：**',
  });

  assert.equal(result.ok, false);
  assert.equal(result.failureClass, 'model_empty_output');
  assert.equal(result.reason, 'content_too_short');
});

test('complete analysis report with structure signals passes quality gate', () => {
  const sections = [
    '# OpenAI 本月新特性分析报告',
    '## 摘要\n本报告系统梳理本月 OpenAI 产品与 API 更新，并与 Claude 的公开能力进行对比。',
    '## 方法\n数据来源包括官方博客、API 文档、发布说明以及公开价格页，并对不可验证内容进行标注。',
    '## 分项对比\n模型能力、上下文、工具调用、多模态和成本维度均给出逐项分析。',
    '## 对抗性评论\n对每个维度分别审视证据可信度、样本偏差、供应商口径和迁移风险。',
    '## 结论\nOpenAI 在实时和多模态上更激进，Claude 在长文档推理和稳定指令遵循上仍有优势。',
    '## 来源\nOpenAI 官方博客、Anthropic 文档、API 价格页。',
    '补充说明：'.repeat(140),
  ].join('\n\n');

  const result = classifyGeneratedArtifact({
    title: '撰写报告草稿',
    brief: '生成完整报告',
    content: sections,
  });

  assert.equal(result.ok, true);
  assert.equal(result.failureClass, null);
});

test('short non-content task is not rejected by strict report structure rules', () => {
  assert.equal(isContentHeavyTask({ title: '生成文件名', brief: '返回一个 slug' }), false);
  const result = classifyGeneratedArtifact({
    title: '生成文件名',
    brief: '返回一个 slug',
    content: 'openai-monthly-analysis',
  });

  assert.equal(result.ok, true);
});

test('unclosed artifact fence is rejected before submission', () => {
  const result = classifyGeneratedArtifact({
    title: '撰写报告草稿',
    brief: '生成完整报告',
    content: '~~~artifact path=report.md\n# Report\n正文内容',
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'artifact_fence_unclosed');
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
  console.log(`\n${passed}/${tests.length} artifact quality tests passed`);
}
