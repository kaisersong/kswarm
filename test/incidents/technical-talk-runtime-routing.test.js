/**
 * KSwarm incident regression — technical talk runtime routing
 *
 * Run: node test/incidents/technical-talk-runtime-routing.test.js
 */

import assert from 'node:assert/strict';
import { createHub } from '../../src/core/hub.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('technical talk incident routes around degraded workers and waits for a pptx-capable agent', () => {
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
  assert.equal(item8.status, 'pending');
  assert.equal(item8.assignedExecutor, null);
  assert.equal(item8.selectedRoute, null);
  assert.equal(dispatch.skipped.some(item => item.taskId.endsWith('item-8') && item.reason === 'output_missing:pptx'), true);
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
