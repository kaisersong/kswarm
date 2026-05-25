/**
 * KSwarm — task output requirement inference tests
 *
 * Run: node test/task-requirements.test.js
 */

import assert from 'node:assert/strict';
import { inferTaskRequirements } from '../src/core/task-requirements.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function outputTypes(requirements) {
  return requirements.requiredOutputs.map(output => `${output.type}:${output.enforcement}`);
}

test('explicit PPTX request hard-enforces pptx output and presentation generation capability', () => {
  const requirements = inferTaskRequirements({
    title: '技术大会演讲报告',
    brief: '最终交付物必须是 PPTX 文件（.pptx），可直接用于演讲。',
  });

  assert.ok(outputTypes(requirements).includes('pptx:hard'));
  assert.ok(requirements.requiredCapabilities.includes('presentation_generation'));
});

test('natural-language slide request infers soft presentation content without forcing pptx', () => {
  const requirements = inferTaskRequirements({
    title: '制作技术大会演讲幻灯片',
    brief: '输出可直接播放的 HTML 幻灯片。',
  });

  assert.ok(outputTypes(requirements).includes('slide_html:hard'));
  assert.ok(requirements.requiredCapabilities.includes('slide_generation'));
  assert.equal(requirements.requiredOutputs.some(output => output.type === 'pptx'), false);
});

test('natural-language report finalization routes to report renderer html', () => {
  const requirements = inferTaskRequirements({
    title: '生成本月AI产品动态分析报告',
    brief: '整合前序研究，输出最终报告。',
  });

  assert.ok(outputTypes(requirements).includes('report_html:hard'));
  assert.ok(requirements.requiredCapabilities.includes('report_generation'));
});

test('legacy html_report required output is canonicalized to report_html', () => {
  const requirements = inferTaskRequirements({
    title: '生成最终 HTML 对比分析报告',
    requiredOutputs: [{ type: 'html_report', enforcement: 'hard', source: 'task' }],
  });

  assert.deepEqual(outputTypes(requirements), ['report_html:hard']);
});

test('report renderer finalization treats markdown as input and routes final output to report_html', () => {
  const requirements = inferTaskRequirements({
    title: '使用 report renderer 生成HTML报告',
    brief: '将修订后的Markdown报告转换为美观、可独立浏览的HTML页面。',
  });

  assert.ok(outputTypes(requirements).includes('report_html:hard'));
  assert.equal(outputTypes(requirements).includes('markdown:hard'), false);
  assert.equal(outputTypes(requirements).includes('html:hard'), false);
  assert.ok(requirements.requiredCapabilities.includes('report_generation'));
});

test('report renderer finalization treats referenced markdown material as input only', () => {
  const requirements = inferTaskRequirements({
    title: '使用 report renderer 生成最终HTML报告',
    brief: '基于 artifacts/proj-1__item-3-2-report.md 作为素材，使用 report renderer 生成可直接交付给研发高层审阅的最终 .html 报告。',
  });

  assert.deepEqual(outputTypes(requirements), ['report_html:hard']);
  assert.ok(requirements.requiredCapabilities.includes('report_generation'));
});

test('stale markdown plus html requirements are normalized for explicit report renderer finalization', () => {
  const requirements = inferTaskRequirements({
    title: '使用 report renderer 生成HTML报告',
    brief: '将修订后的Markdown报告转换为美观、可独立浏览的HTML页面。',
    requiredOutputs: [
      { type: 'markdown', enforcement: 'hard', source: 'explicit' },
      { type: 'html', enforcement: 'hard', source: 'explicit' },
    ],
  });

  assert.deepEqual(outputTypes(requirements), ['report_html:hard']);
  assert.ok(requirements.requiredCapabilities.includes('report_generation'));
});

test('hyphenated report-renderer smoke task treats .report.md as input and requires report_html', () => {
  const requirements = inferTaskRequirements({
    title: '渲染 .report.md IR 为 HTML 并校验',
    brief: '使用 report-renderer 将 phase-1 产出的 .report.md IR 渲染为 HTML 文件，校验产物：HTML 可正常打开、章节完整、无过程痕迹暴露。',
    acceptanceCriteria: 'HTML 文件渲染成功，内容与 IR 一致，包含执行摘要、已验证链路、风险与下一步三部分，排版正常，无草稿/审阅/修订痕迹。',
    requiredOutputs: ['html', 'markdown'],
  });

  assert.deepEqual(outputTypes(requirements), ['report_html:hard']);
  assert.ok(requirements.requiredCapabilities.includes('report_generation'));
});

test('intermediate report research does not hard-route to report renderer', () => {
  const requirements = inferTaskRequirements({
    title: '研究本月Claude动态报告背景',
    brief: '收集事实、来源和上下文，供最终报告任务使用。',
  });

  assert.equal(outputTypes(requirements).includes('report_html:hard'), false);
  assert.equal(requirements.requiredCapabilities.includes('report_generation'), false);
});

test('intermediate report framework design does not require final html output', () => {
  const requirements = inferTaskRequirements({
    title: '高层报告框架设计',
    brief: '设计最终HTML报告的结构：包括执行摘要、背景、产品动态概览、战略分析、竞争格局、对企业的启示与建议、结论。编写报告大纲（Markdown），供后续写作用。',
    acceptanceCriteria: '交付报告大纲（Markdown），包含章节标题、每个章节主要内容要点、所需图表说明。',
  });

  assert.ok(outputTypes(requirements).includes('markdown:hard'));
  assert.equal(outputTypes(requirements).includes('html:hard'), false);
  assert.equal(outputTypes(requirements).includes('report_html:hard'), false);
  assert.equal(requirements.requiredCapabilities.includes('report_generation'), false);
});

test('reviewing an HTML report requires review evidence and markdown report, not an HTML deliverable', () => {
  const requirements = inferTaskRequirements({
    title: '对抗性评审（Adversarial Review）',
    brief: '对item-3.1的HTML报告进行对抗性评审，质疑数据支持、逻辑链条、潜在偏见，并给出改进建议。',
    acceptanceCriteria: '交付一份评审报告（Markdown），列出至少5个质疑点，每个质疑点包含：问题描述、依据、建议修改方案。',
  });

  assert.ok(outputTypes(requirements).includes('markdown:hard'));
  assert.equal(outputTypes(requirements).includes('html:hard'), false);
  assert.equal(outputTypes(requirements).includes('report_html:hard'), false);
  assert.equal(requirements.requiredCapabilities.includes('report_generation'), false);
});

test('intermediate slide material collection does not hard-route to slide renderer', () => {
  const requirements = inferTaskRequirements({
    title: '收集技术大会幻灯片素材',
    brief: '整理案例和数据素材，供最终演示文稿任务使用。',
  });

  assert.equal(outputTypes(requirements).includes('slide_html:hard'), false);
  assert.equal(requirements.requiredCapabilities.includes('slide_generation'), false);
  assert.equal(requirements.requiredOutputs.some(output => output.type === 'pptx'), false);
});

test('speech script and speech report do not imply slide renderer by themselves', () => {
  const requirements = inferTaskRequirements({
    title: '撰写技术大会演讲报告',
    brief: '输出演讲稿和讲述逻辑，不制作幻灯片。',
  });

  assert.equal(outputTypes(requirements).includes('slide_html:hard'), false);
  assert.equal(requirements.requiredCapabilities.includes('slide_generation'), false);
});

test('existing explicit task requirements are preserved and deduplicated', () => {
  const requirements = inferTaskRequirements({
    title: '生成网页报告',
    requiredOutputs: [{ type: 'html', enforcement: 'hard', source: 'plan' }],
    requiredCapabilities: ['web_report', 'web_report'],
  });

  assert.deepEqual(requirements.requiredOutputs, [{ type: 'html', enforcement: 'hard', source: 'plan' }]);
  assert.deepEqual(requirements.requiredCapabilities, ['web_report']);
});

test('explicit markdown and html requests produce hard output requirements', () => {
  const requirements = inferTaskRequirements({
    title: '导出 Markdown 和 HTML 报告',
    brief: '请同时提交 .md 与 .html 文件。',
  });

  assert.ok(outputTypes(requirements).includes('markdown:hard'));
  assert.ok(outputTypes(requirements).includes('html:hard'));
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
  console.log(`\n${passed}/${tests.length} task requirement tests passed`);
}
