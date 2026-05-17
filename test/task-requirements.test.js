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
    title: '制作技术大会演讲幻灯片内容',
    brief: '整理演讲结构、页面要点和讲稿。',
  });

  assert.ok(outputTypes(requirements).includes('presentation_content:soft'));
  assert.equal(requirements.requiredOutputs.some(output => output.type === 'pptx'), false);
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
