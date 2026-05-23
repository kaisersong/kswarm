/**
 * KSwarm — capability router tests
 *
 * Run: node test/capability-router.test.js
 */

import assert from 'node:assert/strict';
import { createUnknownRuntimeHealth, recordProbeResult } from '../src/core/runtime-health.js';
import { evaluateTaskRoute, planTaskRoute } from '../src/core/capability-router.js';
const PRESENTATION_PPTX_EXECUTOR_ID = 'kswarm.executor.presentation.pptx.v1';
const REPORT_HTML_EXECUTOR_ID = 'kswarm.executor.report.html.v1';
const SLIDE_HTML_EXECUTOR_ID = 'kswarm.executor.slide.html.v1';

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

test('route planner can dispatch an explicitly assigned limited runtime when requirements match', () => {
  const assigned = {
    id: 'cli-claude',
    runtimeHealth: recordProbeResult(createUnknownRuntimeHealth(), {
      commandOk: true,
      generationSkipped: true,
      taskCapabilities: ['analysis'],
      outputCapabilities: ['markdown'],
    }, now),
  };

  const route = planTaskRoute({
    task: {
      id: 'sources',
      title: '确定数据源与数据采集方案',
      assignedAgent: 'cli-claude',
      requiredCapabilities: ['analysis'],
      requiredOutputs: ['markdown'],
    },
    agents: [assigned],
    executors: [{ id: PRESENTATION_PPTX_EXECUTOR_ID, outputCapabilities: ['pptx'], taskCapabilities: ['presentation_generation'] }],
    now,
  });

  assert.equal(route.ok, true);
  assert.equal(route.selectedAgentId, 'cli-claude');
  assert.equal(route.selectedExecutorId, null);
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

test('route planner does not fallback worker work to a project-owner-only PO', () => {
  const workerDown = {
    id: 'xiaok-worker',
    roles: ['worker'],
    runtimeHealth: {
      state: 'stalled',
      taskCapabilities: ['analysis'],
      outputCapabilities: ['markdown'],
    },
  };
  const poOnly = {
    id: 'xiaok-po',
    roles: ['project_owner'],
    runtimeHealth: recordProbeResult(createUnknownRuntimeHealth(), {
      commandOk: true,
      generationOk: true,
      taskCapabilities: ['analysis'],
      outputCapabilities: ['markdown'],
    }, now),
  };

  const route = planTaskRoute({
    task: { id: 'task', title: '分析报告', assignedAgent: 'xiaok-worker', requiredCapabilities: ['analysis'], requiredOutputs: ['markdown'] },
    agents: [workerDown, poOnly],
    now,
  });

  assert.equal(route.ok, false);
  assert.equal(route.selectedAgentId, null);
  assert.equal(route.skipped.some(item => item.agentId === 'xiaok-po'), false);
});

test('route planner can fallback worker work to another worker agent', () => {
  const workerDown = {
    id: 'worker-a',
    roles: ['worker'],
    runtimeHealth: {
      state: 'stalled',
      taskCapabilities: ['analysis'],
      outputCapabilities: ['markdown'],
    },
  };
  const workerHealthy = {
    id: 'worker-b',
    roles: ['worker'],
    runtimeHealth: recordProbeResult(createUnknownRuntimeHealth(), {
      commandOk: true,
      generationOk: true,
      taskCapabilities: ['analysis'],
      outputCapabilities: ['markdown'],
    }, now),
  };

  const route = planTaskRoute({
    task: { id: 'task', title: '分析报告', assignedAgent: 'worker-a', requiredCapabilities: ['analysis'], requiredOutputs: ['markdown'] },
    agents: [workerDown, workerHealthy],
    now,
  });

  assert.equal(route.ok, true);
  assert.equal(route.selectedAgentId, 'worker-b');
});

test('route planner skips offline assigned CLI even when stale health is healthy', () => {
  const offlineAssigned = {
    id: 'cli-claude',
    status: 'offline',
    roles: ['worker'],
    runtimeHealth: recordProbeResult(createUnknownRuntimeHealth(), {
      commandOk: true,
      generationOk: true,
      taskCapabilities: ['planning'],
      outputCapabilities: ['markdown'],
    }, now),
  };
  const onlineWorker = {
    id: 'xiaok-worker',
    status: 'idle',
    roles: ['worker'],
    runtimeHealth: recordProbeResult(createUnknownRuntimeHealth(), {
      commandOk: true,
      generationOk: true,
      taskCapabilities: ['planning'],
      outputCapabilities: ['markdown'],
    }, now),
  };

  const route = planTaskRoute({
    task: {
      id: 'draft',
      title: '撰写第一轮分析报告',
      assignedAgent: 'cli-claude',
      requiredCapabilities: ['planning'],
      requiredOutputs: ['markdown'],
    },
    agents: [offlineAssigned, onlineWorker],
    now,
  });

  assert.equal(route.ok, true);
  assert.equal(route.selectedAgentId, 'xiaok-worker');
  assert.equal(route.skipped[0].agentId, 'cli-claude');
  assert.equal(route.skipped[0].reason, 'runtime_offline');
});

test('route planner still allows a task explicitly assigned to PO', () => {
  const poOnly = {
    id: 'xiaok-po',
    roles: ['project_owner'],
    runtimeHealth: recordProbeResult(createUnknownRuntimeHealth(), {
      commandOk: true,
      generationOk: true,
      taskCapabilities: ['planning'],
      outputCapabilities: ['markdown'],
    }, now),
  };

  const route = planTaskRoute({
    task: { id: 'review', title: '综合审核报告', assignedAgent: 'xiaok-po', requiredCapabilities: ['planning'], requiredOutputs: ['markdown'] },
    agents: [poOnly],
    now,
  });

  assert.equal(route.ok, true);
  assert.equal(route.selectedAgentId, 'xiaok-po');
});

test('route planner does not select presentation executor when no agent has pptx output capability', () => {
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
    executors: [{ id: PRESENTATION_PPTX_EXECUTOR_ID, outputCapabilities: ['pptx'], taskCapabilities: ['presentation_generation'] }],
    now,
  });

  assert.equal(route.ok, false);
  assert.equal(route.selectedExecutorId, null);
  assert.equal(route.selectedAgentId, null);
  assert.equal(route.reason, 'output_missing:pptx');
});

test('route planner does not select report html executor for final report task', () => {
  const markdownOnly = {
    id: 'worker-md',
    runtimeHealth: recordProbeResult(createUnknownRuntimeHealth(), {
      commandOk: true,
      generationOk: true,
      taskCapabilities: ['analysis', 'report_generation'],
      outputCapabilities: ['markdown'],
    }, now),
  };

  const route = planTaskRoute({
    task: { id: 'report', title: '生成本月AI产品动态分析报告', brief: '输出最终报告。', assignedAgent: 'worker-md' },
    agents: [markdownOnly],
    executors: [{ id: REPORT_HTML_EXECUTOR_ID, outputCapabilities: ['report_html'], taskCapabilities: ['report_generation'] }],
    now,
  });

  assert.equal(route.ok, false);
  assert.equal(route.selectedExecutorId, null);
  assert.equal(route.selectedAgentId, null);
  assert.equal(route.reason, 'output_missing:report_html');
});

test('route planner treats markdown references as report renderer inputs but still requires an agent output capability', () => {
  const markdownOnly = {
    id: 'worker-md',
    runtimeHealth: recordProbeResult(createUnknownRuntimeHealth(), {
      commandOk: true,
      generationOk: true,
      taskCapabilities: ['analysis', 'report_generation'],
      outputCapabilities: ['markdown'],
    }, now),
  };

  const route = planTaskRoute({
    task: {
      id: 'report',
      title: '使用 report renderer 生成最终HTML报告',
      brief: '基于 artifacts/proj-1__item-3-2-report.md 作为素材，使用 report renderer 生成最终 .html 报告。',
      assignedAgent: 'worker-md',
    },
    agents: [markdownOnly],
    executors: [{ id: REPORT_HTML_EXECUTOR_ID, outputCapabilities: ['report_html'], taskCapabilities: ['report_generation'] }],
    now,
  });

  assert.equal(route.ok, false);
  assert.equal(route.selectedExecutorId, null);
  assert.equal(route.selectedAgentId, null);
  assert.equal(route.reason, 'output_missing:report_html');
});

test('route planner does not select slide html executor for natural-language slide task', () => {
  const markdownOnly = {
    id: 'worker-md',
    runtimeHealth: recordProbeResult(createUnknownRuntimeHealth(), {
      commandOk: true,
      generationOk: true,
      taskCapabilities: ['analysis', 'slide_generation'],
      outputCapabilities: ['markdown'],
    }, now),
  };

  const route = planTaskRoute({
    task: { id: 'slides', title: '制作技术大会演示文稿', brief: '输出最终 HTML 幻灯片。', assignedAgent: 'worker-md' },
    agents: [markdownOnly],
    executors: [
      { id: PRESENTATION_PPTX_EXECUTOR_ID, outputCapabilities: ['pptx'], taskCapabilities: ['presentation_generation'] },
      { id: SLIDE_HTML_EXECUTOR_ID, outputCapabilities: ['slide_html'], taskCapabilities: ['slide_generation'] },
    ],
    now,
  });

  assert.equal(route.ok, false);
  assert.equal(route.selectedExecutorId, null);
  assert.equal(route.reason, 'output_missing:slide_html');
});

test('route planner does not use presentation executor for generic tasks', () => {
  const limited = {
    id: 'cli-claude',
    runtimeHealth: recordProbeResult(createUnknownRuntimeHealth(), {
      commandOk: true,
      generationSkipped: true,
      taskCapabilities: ['coding', 'testing', 'design', 'planning'],
      outputCapabilities: ['markdown'],
    }, now),
  };

  const route = planTaskRoute({
    task: { id: 'generic', title: '确定数据源与数据采集方案', assignedAgent: 'other-agent' },
    agents: [limited],
    executors: [{ id: PRESENTATION_PPTX_EXECUTOR_ID, outputCapabilities: ['pptx'], taskCapabilities: ['presentation_generation'] }],
    now,
  });

  assert.equal(route.ok, false);
  assert.equal(route.selectedExecutorId, null);
  assert.equal(route.reason, 'runtime_limited');
});

test('executor routing is ignored even when hard pptx would be satisfied', () => {
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
    executors: [{ id: PRESENTATION_PPTX_EXECUTOR_ID, outputCapabilities: ['pptx'], taskCapabilities: ['presentation_generation'] }],
    now,
  });

  assert.equal(route.ok, false);
  assert.equal(route.selectedExecutorId, null);
  assert.equal(route.reason, 'no_route');
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
