/**
 * KSwarm — capability router tests
 *
 * Run: node test/capability-router.test.js
 */

import assert from 'node:assert/strict';
import { createUnknownRuntimeHealth, recordProbeResult } from '../src/core/runtime-health.js';
import { evaluateTaskRoute, planTaskRoute } from '../src/core/capability-router.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const now = 1779050000000;

test('explicit pptx task rejects an agent that lacks pptx output capability', () => {
  const agent = {
    id: 'worker-md',
    runtimeHealth: recordProbeResult(createUnknownRuntimeHealth(), {
      commandOk: true,
      generationOk: true,
      taskCapabilities: ['presentation_generation'],
      outputCapabilities: ['markdown'],
    }, now),
  };

  const route = evaluateTaskRoute({
    title: '技术大会演讲报告',
    brief: '最终交付物必须是 PPTX 文件（.pptx）。',
  }, agent, now);

  assert.equal(route.ok, false);
  assert.equal(route.reason, 'output_missing:pptx');
});

test('command-only runtime is limited even when labels match', () => {
  const agent = {
    id: 'worker-limited',
    runtimeHealth: recordProbeResult(createUnknownRuntimeHealth(), {
      commandOk: true,
      generationSkipped: true,
      taskCapabilities: ['analysis'],
      outputCapabilities: ['markdown'],
    }, now),
  };

  const route = evaluateTaskRoute({
    title: '分析报告',
    brief: '输出 Markdown 文件。',
    requiredCapabilities: ['analysis'],
  }, agent, now);

  assert.equal(route.ok, false);
  assert.equal(route.reason, 'runtime_limited');
});

test('healthy matching runtime can route markdown work', () => {
  const agent = {
    id: 'worker-md',
    runtimeHealth: recordProbeResult(createUnknownRuntimeHealth(), {
      commandOk: true,
      generationOk: true,
      taskCapabilities: ['analysis'],
      outputCapabilities: ['markdown'],
    }, now),
  };

  const route = evaluateTaskRoute({
    title: '分析报告',
    brief: '输出 Markdown 文件。',
    requiredCapabilities: ['analysis'],
  }, agent, now);

  assert.equal(route.ok, true);
});

test('route planner skips cooldown assigned agent and selects another healthy agent', () => {
  const unhealthy = {
    id: 'worker-a',
    runtimeHealth: {
      state: 'cooldown',
      cooldownUntil: now + 60_000,
      taskCapabilities: ['analysis'],
      outputCapabilities: ['markdown'],
    },
  };
  const healthy = {
    id: 'worker-b',
    runtimeHealth: recordProbeResult(createUnknownRuntimeHealth(), {
      commandOk: true,
      generationOk: true,
      taskCapabilities: ['analysis'],
      outputCapabilities: ['markdown'],
    }, now),
  };

  const route = planTaskRoute({
    task: { id: 'task', title: '分析报告', assignedAgent: 'worker-a', requiredCapabilities: ['analysis'], requiredOutputs: ['markdown'] },
    agents: [unhealthy, healthy],
    now,
  });

  assert.equal(route.ok, true);
  assert.equal(route.selectedAgentId, 'worker-b');
  assert.equal(route.skipped[0].reason, 'runtime_cooldown');
});

test('route planner selects local pptx executor when no agent has pptx output capability', () => {
  const markdownOnly = {
    id: 'worker-md',
    runtimeHealth: recordProbeResult(createUnknownRuntimeHealth(), {
      commandOk: true,
      generationOk: true,
      taskCapabilities: ['presentation_generation'],
      outputCapabilities: ['markdown'],
    }, now),
  };

  const route = planTaskRoute({
    task: { id: 'deck', title: '技术大会演讲报告', brief: '最终交付物必须是 PPTX 文件（.pptx）。', assignedAgent: 'worker-md' },
    agents: [markdownOnly],
    executors: [{ id: 'local_pptx_executor_v1', outputCapabilities: ['pptx'], taskCapabilities: ['presentation_generation'] }],
    now,
  });

  assert.equal(route.ok, true);
  assert.equal(route.selectedExecutorId, 'local_pptx_executor_v1');
  assert.equal(route.selectedAgentId, null);
});

test('executor routing ignores soft output requirements when hard pptx is satisfied', () => {
  const route = planTaskRoute({
    task: {
      id: 'deck',
      title: '技术大会演讲报告',
      assignedAgent: 'worker-md',
      requiredCapabilities: ['presentation_generation'],
      requiredOutputs: [
        { type: 'pptx', enforcement: 'hard' },
        { type: 'presentation_content', enforcement: 'soft' },
      ],
    },
    agents: [],
    executors: [{ id: 'local_pptx_executor_v1', outputCapabilities: ['pptx'], taskCapabilities: ['presentation_generation'] }],
    now,
  });

  assert.equal(route.ok, true);
  assert.equal(route.selectedExecutorId, 'local_pptx_executor_v1');
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
  console.log(`\n${passed}/${tests.length} capability router tests passed`);
}
