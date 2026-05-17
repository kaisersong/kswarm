/**
 * KSwarm — dispatch policy tests
 *
 * Run: node test/dispatch-policy.test.js
 */

import assert from 'node:assert/strict';
import { planDispatch } from '../src/core/dispatch-policy.js';

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
