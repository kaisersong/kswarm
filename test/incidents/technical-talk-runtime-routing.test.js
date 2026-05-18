/**
 * KSwarm incident regression — technical talk runtime routing
 *
 * Run: node test/incidents/technical-talk-runtime-routing.test.js
 */

import assert from 'node:assert/strict';
import { createHub } from '../../src/core/hub.js';
import { PRESENTATION_PPTX_EXECUTOR_ID } from '../../src/executors/presentation-pptx-executor.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('technical talk incident routes around degraded workers and blocks markdown-only pptx submissions', () => {
  const bridgeMessages = [];
  const hub = createHub({
    silent: true,
    bridge: {
      requestTask(p) { bridgeMessages.push({ kind: 'request_task', ...p }); },
      send(p) { bridgeMessages.push(p); },
    },
    getAgentProfiles: () => [
      { id: '2de19e7a-cfc', runtimeHealth: { state: 'cooldown', cooldownUntil: Date.now() + 120_000, taskCapabilities: ['analysis'], outputCapabilities: ['markdown'] } },
      { id: 'cli-qoder', runtimeHealth: { state: 'healthy', taskCapabilities: ['presentation_generation'], outputCapabilities: ['markdown'] } },
      { id: 'cli-claude', runtimeHealth: { state: 'healthy', taskCapabilities: ['analysis', 'presentation_content', 'review_iteration'], outputCapabilities: ['markdown'] } },
    ],
    getExecutors: () => [
      { id: PRESENTATION_PPTX_EXECUTOR_ID, taskCapabilities: ['presentation_generation'], outputCapabilities: ['pptx'] },
    ],
  });

  hub.createProject({ id: 'talk', name: '技术大会演讲报告', goal: 'goal', poAgent: 'po', members: ['2de19e7a-cfc', 'cli-qoder', 'cli-claude'] });
  hub.handleCreateTasks('talk', [
    { id: 'item-7', title: '修订演讲报告', assignedAgent: '2de19e7a-cfc', requiredCapabilities: ['analysis'], requiredOutputs: ['markdown'] },
    { id: 'item-8', title: '逐页幻灯片生成', brief: '最终交付物必须是 PPTX 文件（.pptx）。', assignedAgent: 'cli-qoder' },
  ], 'po');
  hub.handleApprove('talk');

  const dispatch = hub.handleRequestDispatch('talk', 'po');
  const item7 = hub.getBoard('talk').getTask('item-7');
  const item8 = hub.getBoard('talk').getTask('item-8');

  assert.equal(dispatch.ok, true);
  assert.equal(item7.assignedAgent !== '2de19e7a-cfc', true);
  assert.equal(item8.assignedAgent, 'cli-qoder');
  assert.equal(item8.assignedExecutor, PRESENTATION_PPTX_EXECUTOR_ID);
  assert.equal(item8.selectedRoute.selectedExecutorId, PRESENTATION_PPTX_EXECUTOR_ID);

  const rejected = hub.handleSubmitResult('talk', 'item-8', {
    summary: '已经完成逐页幻灯片内容，包含主题、结构、章节摘要、讲稿要点、受众分析、时间安排、演示节奏和后续建议。',
    artifacts: [{ filename: 'item-8-report.md', path: 'artifacts/item-8-report.md', mimeType: 'text/markdown' }],
  }, PRESENTATION_PPTX_EXECUTOR_ID, item8.activeRunId);

  assert.equal(rejected.ok, false);
  assert.equal(rejected.failureClass, 'artifact_type_mismatch');
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
  console.log(`\n${passed}/${tests.length} technical talk incident tests passed`);
}
