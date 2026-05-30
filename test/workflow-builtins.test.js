/**
 * KSwarm — built-in workflow tests
 *
 * Run: node test/workflow-builtins.test.js
 */

import assert from 'node:assert/strict';
import { createProjectDiagnoseWorkflowRun } from '../src/core/workflow-builtins.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('project-diagnose completes as a read-only control-plane workflow', () => {
  const run = createProjectDiagnoseWorkflowRun({
    project: { id: 'proj-1', name: '分析项目', status: 'active' },
    tasks: [
      { id: 'item-1', title: '写报告', status: 'blocked', blockedReason: '缺少证据' },
      { id: 'item-2', title: '补证据', status: 'pending', assignedAgent: 'xiaok-worker' },
    ],
    projectHealth: {
      state: 'blocked',
      gate: 'blocked_tasks',
      reasons: [{ taskId: 'item-1', message: '缺少证据' }],
    },
    dispatchPlan: {
      dispatchedTasks: [{ id: 'item-2', assignedAgent: 'xiaok-worker' }],
      waiting: [],
      blocked: [{ taskId: 'item-1', reason: 'blocked_tasks' }],
    },
    requestedBy: 'human',
    now: 1770000000000,
  });

  assert.equal(run.workflowId, 'project-diagnose');
  assert.equal(run.status, 'completed');
  assert.equal(run.nodes.every(node => node.status === 'completed'), true);
  assert.equal(run.diagnosis.healthState, 'blocked');
  assert.equal(run.diagnosis.blockedTasks[0].taskId, 'item-1');
  assert.equal(run.diagnosis.dispatchableCount, 1);
  assert.equal(run.diagnosis.recommendedActions[0].id, 'continue_project');
  assert.equal(run.nodes.some(node => node.kind === 'agent_task'), false);
});

test('project-diagnose recommends dispatch when work is available and not blocked', () => {
  const run = createProjectDiagnoseWorkflowRun({
    project: { id: 'proj-2', name: '待执行项目', status: 'active' },
    tasks: [{ id: 'item-1', title: '写报告', status: 'pending', assignedAgent: 'xiaok-worker' }],
    projectHealth: { state: 'dispatchable', gate: null, reasons: [] },
    dispatchPlan: { dispatchedTasks: [{ id: 'item-1', assignedAgent: 'xiaok-worker' }], waiting: [], blocked: [] },
    now: 1770000000000,
  });

  assert.equal(run.diagnosis.recommendedActions[0].id, 'dispatch_tasks');
  assert.equal(run.summary.primaryMessage, '派发可执行任务');
});

let passed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    passed++;
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(err);
    process.exitCode = 1;
    break;
  }
}
if (process.exitCode !== 1) console.log(`\n${passed}/${tests.length} workflow built-in tests passed`);
