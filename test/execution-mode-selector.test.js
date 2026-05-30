/**
 * KSwarm — project execution mode and task run strategy tests
 *
 * Run: node test/execution-mode-selector.test.js
 */

import assert from 'node:assert/strict';
import { createHub } from '../src/core/hub.js';
import {
  normalizeProjectExecutionMode,
  selectTaskExecutionStrategy,
} from '../src/core/execution-mode.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function createActiveProject(hub, { id = 'proj-execution-mode', executionMode = undefined, tasks = null } = {}) {
  const project = hub.createProject({
    id,
    name: '执行方式项目',
    goal: '验证 direct / workflow 执行策略',
    poAgent: 'xiaok-po',
    members: ['xiaok-worker'],
    executionMode,
  });
  const added = hub.handleHumanAddTasks(id, tasks || [
    { title: '最终报告复核', description: '交付前做质量复核', assignedAgent: 'xiaok-worker' },
  ]);
  assert.equal(added.ok, true);
  const approved = hub.handleApprove(id);
  assert.equal(approved.ok, true);
  return project;
}

test('projects default to direct execution mode and reject invalid modes', () => {
  const hub = createHub({ silent: true });
  const project = hub.createProject({
    id: 'proj-default-mode',
    name: '默认执行方式',
    goal: '默认快速执行',
    poAgent: 'xiaok-po',
    members: ['xiaok-worker'],
  });

  assert.equal(project.executionMode, 'direct');
  assert.equal(normalizeProjectExecutionMode('bad-mode'), 'direct');

  const updated = hub.updateProjectExecutionMode('proj-default-mode', 'auto', { updatedBy: 'human', now: 1770000000000 });
  assert.equal(updated.ok, true);
  assert.equal(updated.project.executionMode, 'auto');
  assert.equal(updated.project.executionModeUpdatedBy, 'human');
  assert.equal(updated.project.executionModeUpdatedAt, 1770000000000);

  const invalid = hub.updateProjectExecutionMode('proj-default-mode', 'always-workflow');
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error, 'invalid_execution_mode');
  assert.equal(hub.getProject('proj-default-mode').executionMode, 'auto');
});

test('direct project mode keeps high-quality tasks on direct dispatch by default', () => {
  const hub = createHub({ silent: true });
  createActiveProject(hub, { executionMode: 'direct' });
  const task = hub.getBoard('proj-execution-mode').getAllTasks()[0];

  const selected = selectTaskExecutionStrategy({ project: hub.getProject('proj-execution-mode'), task });
  assert.equal(selected.strategy, 'direct');
  assert.equal(selected.modeSource, 'project_default');
  assert.equal(selected.reasonCode, 'project_direct_default');

  const dispatched = hub.handleRequestDispatch('proj-execution-mode', 'xiaok-po');
  assert.equal(dispatched.ok, true);
  assert.deepEqual(dispatched.dispatched, [task.id]);
  assert.deepEqual(dispatched.workflowDispatched, []);
  const stored = hub.getBoard('proj-execution-mode').getTask(task.id);
  assert.equal(stored.status, 'dispatched');
  assert.equal(stored.execution.strategy, 'direct');
  assert.equal(stored.execution.reasonCode, 'project_direct_default');
  assert.equal(stored.execution.workflowRunId, null);
  assert.equal(hub.listProjectWorkflowRuns('proj-execution-mode').length, 0);
});

test('auto mode routes delivery review tasks through a task-scoped workflow run', () => {
  const hub = createHub({ silent: true });
  createActiveProject(hub, { executionMode: 'auto' });
  const task = hub.getBoard('proj-execution-mode').getAllTasks()[0];

  const selected = selectTaskExecutionStrategy({ project: hub.getProject('proj-execution-mode'), task });
  assert.equal(selected.strategy, 'workflow');
  assert.equal(selected.modeSource, 'auto_selector');
  assert.equal(selected.reasonCode, 'delivery_review');

  const dispatched = hub.handleRequestDispatch('proj-execution-mode', 'xiaok-po');
  assert.equal(dispatched.ok, true);
  assert.deepEqual(dispatched.dispatched, []);
  assert.deepEqual(dispatched.workflowDispatched, [task.id]);
  assert.equal(dispatched.workflowRuns.length, 1);

  const stored = hub.getBoard('proj-execution-mode').getTask(task.id);
  assert.equal(stored.status, 'dispatched');
  assert.equal(stored.execution.strategy, 'workflow');
  assert.equal(stored.execution.modeSource, 'auto_selector');
  assert.equal(stored.execution.reasonCode, 'delivery_review');
  assert.equal(stored.execution.workflowRunId, dispatched.workflowRuns[0].id);
  assert.equal(stored.activeRunId, `workflow-${dispatched.workflowRuns[0].id}`);

  const workflowRun = hub.getWorkflowRun(stored.execution.workflowRunId);
  assert.equal(workflowRun.workflowId, 'po-generated-task-workflow');
  assert.equal(workflowRun.scope.taskId, task.id);
  assert.equal(workflowRun.sourceTask.id, task.id);

  const secondDispatch = hub.handleRequestDispatch('proj-execution-mode', 'xiaok-po');
  assert.equal(secondDispatch.ok, true);
  assert.deepEqual(secondDispatch.workflowDispatched, []);
  assert.equal(hub.listProjectWorkflowRuns('proj-execution-mode').length, 1);
});

test('workflow preferred still keeps simple tasks on direct strategy', () => {
  const project = { id: 'proj-preferred', executionMode: 'workflow_preferred' };
  const simpleTask = {
    id: 'simple',
    title: '整理会议纪要',
    status: 'pending',
    assignedAgent: 'xiaok-worker',
  };
  const reviewTask = {
    id: 'review',
    title: '最终交付物验收复核',
    status: 'pending',
    assignedAgent: 'xiaok-worker',
  };

  const simple = selectTaskExecutionStrategy({ project, task: simpleTask });
  assert.equal(simple.strategy, 'direct');
  assert.equal(simple.reasonCode, 'simple_direct');

  const review = selectTaskExecutionStrategy({ project, task: reviewTask });
  assert.equal(review.strategy, 'workflow');
  assert.equal(review.reasonCode, 'delivery_review');
});

test('selector uses concrete reason codes instead of vague complexity', () => {
  const project = { id: 'proj-auto', executionMode: 'auto' };

  assert.equal(selectTaskExecutionStrategy({
    project,
    task: { id: 'quality', title: '调研报告', qualityGateRequired: true, assignedAgent: 'xiaok-worker' },
  }).reasonCode, 'quality_requested');

  assert.equal(selectTaskExecutionStrategy({
    project,
    task: { id: 'multi-source', title: '整合三份材料', inputRefs: ['artifact:a', 'artifact:b'], assignedAgent: 'xiaok-worker' },
  }).reasonCode, 'multi_source_evidence');

  assert.equal(selectTaskExecutionStrategy({
    project,
    task: { id: 'retry', title: '修复运行失败', runtimeFailureCount: 1, assignedAgent: 'xiaok-worker' },
  }).reasonCode, 'retry_after_failure');

  assert.equal(selectTaskExecutionStrategy({
    project,
    task: { id: 'rework', title: '按复核意见返工', reviewResult: { passed: false }, assignedAgent: 'xiaok-worker' },
  }).reasonCode, 'rework_after_review');

  assert.equal(selectTaskExecutionStrategy({
    project,
    task: { id: 'blocked', title: '诊断阻塞状态', status: 'blocked', blockedReason: 'runtime unavailable', assignedAgent: 'xiaok-worker' },
  }).reasonCode, 'blocked_or_unclear');
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
if (process.exitCode !== 1) console.log(`\n${passed}/${tests.length} execution mode selector tests passed`);
