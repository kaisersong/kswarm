/**
 * KSwarm — dispatch policy tests
 *
 * Run: node test/dispatch-policy.test.js
 */

import assert from 'node:assert/strict';
import { planDispatch } from '../src/core/dispatch-policy.js';
import { createUnknownRuntimeHealth, recordProbeResult } from '../src/core/runtime-health.js';
import { PRESENTATION_PPTX_EXECUTOR_ID } from '../src/executors/presentation-pptx-executor.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('dispatch planning treats busy agents as global across projects', () => {
  const plan = planDispatch({
    projectId: 'proj-b',
    tasks: [
      { id: 'proj-b__task-1', title: 'B task', status: 'pending', assignedAgent: 'worker', dependencies: [] },
    ],
    allActiveTasks: [
      { id: 'proj-a__task-1', projectId: 'proj-a', status: 'in_progress', assignedAgent: 'worker' },
    ],
  });

  assert.deepEqual(plan.dispatchedTasks, []);
  assert.deepEqual(plan.skipped, [
    { taskId: 'proj-b__task-1', reason: 'agent_busy', agent: 'worker' },
  ]);
  assert.equal(plan.projectGate, 'waiting_for_busy_agents');
});

test('dispatch planning uses pooled Xiaok worker capacity before waiting', () => {
  const plan = planDispatch({
    projectId: 'proj-b',
    tasks: [
      { id: 'proj-b__task-1', title: 'B task', status: 'pending', assignedAgent: 'xiaok-worker', dependencies: [] },
    ],
    allActiveTasks: [
      { id: 'proj-a__task-1', projectId: 'proj-a', status: 'in_progress', assignedAgent: 'xiaok-worker' },
    ],
    agentConcurrency: { 'xiaok-worker': 2 },
  });

  assert.deepEqual(plan.dispatchedTasks.map(task => task.id), ['proj-b__task-1']);
  assert.deepEqual(plan.skipped, []);
  assert.equal(plan.projectGate, null);
});

test('dispatch planning treats unprobed xiaok runtime workers as spawnable when capabilities match', () => {
  const plan = planDispatch({
    projectId: 'proj-xiaok',
    tasks: [
      {
        id: 'proj-xiaok__report',
        title: '撰写报告',
        status: 'pending',
        assignedAgent: 'xiaok-worker',
        dependencies: [],
        requiredOutputs: [{ type: 'markdown', enforcement: 'hard' }],
      },
    ],
    agentProfiles: [
      {
        id: 'xiaok-worker',
        runtimeType: 'xiaok',
        roles: ['worker'],
        runtimeHealth: createUnknownRuntimeHealth({
          outputCapabilities: ['markdown', 'html'],
          taskCapabilities: ['coding', 'testing', 'design', 'planning'],
        }),
      },
    ],
    agentConcurrency: { 'xiaok-worker': 3 },
  });

  assert.deepEqual(plan.dispatchedTasks.map(task => task.id), ['proj-xiaok__report']);
  assert.deepEqual(plan.skipped, []);
  assert.equal(plan.projectGate, null);
});

test('dispatch planning reports Xiaok capacity wait after pooled capacity is full', () => {
  const plan = planDispatch({
    projectId: 'proj-c',
    tasks: [
      { id: 'proj-c__task-1', title: 'C task', status: 'pending', assignedAgent: 'xiaok-worker', dependencies: [] },
    ],
    allActiveTasks: [
      { id: 'proj-a__task-1', projectId: 'proj-a', status: 'in_progress', assignedAgent: 'xiaok-worker' },
      { id: 'proj-b__task-1', projectId: 'proj-b', status: 'accepted', assignedAgent: 'xiaok-worker' },
    ],
    agentConcurrency: { 'xiaok-worker': 2 },
  });

  assert.deepEqual(plan.dispatchedTasks, []);
  assert.deepEqual(plan.skipped, [
    { taskId: 'proj-c__task-1', reason: 'xiaok_capacity_full', agent: 'xiaok-worker' },
  ]);
  assert.equal(plan.projectGate, 'waiting_for_xiaok_capacity');
});

test('dispatch planning does not mark preferred agent busy for active local executor runs', () => {
  const plan = planDispatch({
    projectId: 'proj-b',
    tasks: [
      { id: 'proj-b__task-1', title: 'B task', status: 'pending', assignedAgent: 'worker', dependencies: [] },
    ],
    allActiveTasks: [
      {
        id: 'proj-a__deck',
        projectId: 'proj-a',
        status: 'in_progress',
        assignedAgent: 'worker',
        assignedExecutor: PRESENTATION_PPTX_EXECUTOR_ID,
      },
    ],
  });

  assert.deepEqual(plan.dispatchedTasks.map(task => task.id), ['proj-b__task-1']);
  assert.deepEqual(plan.skipped, []);
});

test('dispatch planning allows independent tasks from later phases when dependencies are satisfied', () => {
  const plan = planDispatch({
    projectId: 'proj-a',
    tasks: [
      { id: 'proj-a__phase1-a', title: 'Phase 1 A', status: 'done', assignedAgent: 'a', phaseId: 'p1' },
      { id: 'proj-a__phase1-b', title: 'Phase 1 B', status: 'pending', assignedAgent: 'busy', phaseId: 'p1' },
      { id: 'proj-a__phase2-a', title: 'Phase 2 independent', status: 'pending', assignedAgent: 'free', phaseId: 'p2', dependencies: [] },
    ],
    allActiveTasks: [
      { id: 'other', projectId: 'proj-z', status: 'accepted', assignedAgent: 'busy' },
    ],
  });

  assert.deepEqual(plan.dispatchedTasks.map(t => t.id), ['proj-a__phase2-a']);
  assert.deepEqual(plan.skipped, [
    { taskId: 'proj-a__phase1-b', reason: 'agent_busy', agent: 'busy' },
  ]);
});

test('composite parent tasks are never dispatchable', () => {
  const plan = planDispatch({
    projectId: 'proj-a',
    tasks: [
      { id: 'parent', title: 'Composite parent', status: 'pending', assignedAgent: null, isCompositeParent: true },
      { id: 'child', title: 'Child', status: 'pending', assignedAgent: 'worker', dependencies: [] },
    ],
    allActiveTasks: [],
  });

  assert.deepEqual(plan.dispatchedTasks.map(t => t.id), ['child']);
  assert.deepEqual(plan.skipped, []);
});

test('dispatch planning reports dependency blockers without dispatching dependent work', () => {
  const plan = planDispatch({
    projectId: 'proj-a',
    tasks: [
      { id: 'draft', title: 'Draft', status: 'pending', assignedAgent: 'writer', dependencies: ['research'] },
      { id: 'research', title: 'Research', status: 'pending', assignedAgent: 'researcher', dependencies: [] },
    ],
    allActiveTasks: [],
  });

  assert.deepEqual(plan.dispatchedTasks.map(t => t.id), ['research']);
  assert.deepEqual(plan.blocked, [
    { taskId: 'draft', reason: 'dependency_pending', dependencies: ['research'] },
  ]);
});

test('dispatch planning can skip assigned agents that are not capable of required outputs', () => {
  const now = 1779050000000;
  const plan = planDispatch({
    projectId: 'proj-a',
    tasks: [
      {
        id: 'deck',
        title: '技术大会演讲报告',
        brief: '最终交付物必须是 PPTX 文件（.pptx）。',
        status: 'pending',
        assignedAgent: 'worker-md',
        dependencies: [],
      },
    ],
    allActiveTasks: [],
    agentProfiles: [
      {
        id: 'worker-md',
        runtimeHealth: recordProbeResult(createUnknownRuntimeHealth(), {
          commandOk: true,
          generationOk: true,
          taskCapabilities: ['presentation_generation'],
          outputCapabilities: ['markdown'],
        }, now),
      },
    ],
    now,
  });

  assert.deepEqual(plan.dispatchedTasks, []);
  assert.deepEqual(plan.skipped, [
    { taskId: 'deck', reason: 'output_missing:pptx', agent: 'worker-md' },
  ]);
  assert.equal(plan.projectGate, 'waiting_for_capable_agent');
});

test('dispatch planning reroutes to a capable healthy agent when assigned agent is unavailable', () => {
  const now = 1779050000000;
  const healthy = recordProbeResult(createUnknownRuntimeHealth(), {
    commandOk: true,
    generationOk: true,
    taskCapabilities: ['analysis'],
    outputCapabilities: ['markdown'],
  }, now);
  const plan = planDispatch({
    projectId: 'proj-a',
    tasks: [
      { id: 'analysis', title: '分析报告', status: 'pending', assignedAgent: 'worker-a', requiredCapabilities: ['analysis'], requiredOutputs: ['markdown'], dependencies: [] },
    ],
    allActiveTasks: [],
    agentProfiles: [
      { id: 'worker-a', runtimeHealth: { state: 'cooldown', cooldownUntil: now + 60_000, taskCapabilities: ['analysis'], outputCapabilities: ['markdown'] } },
      { id: 'worker-b', runtimeHealth: healthy },
    ],
    now,
  });

  assert.deepEqual(plan.dispatchedTasks.map(t => t.assignedAgent), ['worker-b']);
  assert.equal(plan.dispatchedTasks[0].preferredAssignedAgent, 'worker-a');
  assert.equal(plan.dispatchedTasks[0].selectedRoute.selectedAgentId, 'worker-b');
});

test('dispatch planning does not reroute worker tasks to project-owner-only PO', () => {
  const now = 1779050000000;
  const healthy = recordProbeResult(createUnknownRuntimeHealth(), {
    commandOk: true,
    generationOk: true,
    taskCapabilities: ['analysis'],
    outputCapabilities: ['markdown'],
  }, now);
  const plan = planDispatch({
    projectId: 'proj-a',
    tasks: [
      { id: 'analysis', title: '分析报告', status: 'pending', assignedAgent: 'xiaok-worker', requiredCapabilities: ['analysis'], requiredOutputs: ['markdown'], dependencies: [] },
    ],
    allActiveTasks: [],
    agentProfiles: [
      { id: 'xiaok-worker', roles: ['worker'], runtimeHealth: { state: 'stalled', taskCapabilities: ['analysis'], outputCapabilities: ['markdown'] } },
      { id: 'xiaok-po', roles: ['project_owner'], runtimeHealth: healthy },
    ],
    now,
  });

  assert.deepEqual(plan.dispatchedTasks, []);
  assert.equal(plan.skipped[0].taskId, 'analysis');
  assert.notEqual(plan.skipped[0].agent, 'xiaok-po');
  assert.equal(plan.projectGate, 'waiting_for_capable_agent');
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
  console.log(`\n${passed}/${tests.length} dispatch policy tests passed`);
}
