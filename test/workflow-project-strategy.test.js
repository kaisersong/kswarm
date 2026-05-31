/**
 * KSwarm — project-level dynamic workflow strategy tests
 *
 * Run: node test/workflow-project-strategy.test.js
 */

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHub } from '../src/core/hub.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function createHighQualityProject(hub, id = 'proj-project-workflow') {
  const project = hub.createProject({
    id,
    name: '项目级工作流项目',
    goal: '生成一份项目级最终交付物',
    requirements: '最终交付物必须是 markdown，并覆盖所有任务目标。',
    poAgent: 'xiaok-po',
    members: ['xiaok-worker'],
    executionMode: 'workflow_preferred',
  });
  const added = hub.handleHumanAddTasks(id, [
    { title: '收集公开资料', description: '整理关键事实', assignedAgent: 'xiaok-worker' },
    { title: '分析趋势', description: '结合公开资料做综合分析', assignedAgent: 'xiaok-worker' },
    { title: '生成最终报告', description: '输出项目最终报告', assignedAgent: 'xiaok-worker', requiredOutputs: ['markdown'] },
  ]);
  assert.equal(added.ok, true);
  const approved = hub.handleApprove(id);
  assert.equal(approved.ok, true);
  return project;
}

function startProjectWorkflow(hub, projectId = 'proj-project-workflow') {
  const dispatched = hub.handleRequestDispatch(projectId, 'xiaok-po');
  assert.equal(dispatched.ok, true);
  assert.deepEqual(dispatched.dispatched, []);
  assert.deepEqual(dispatched.workflowDispatched, []);
  assert.equal(dispatched.workflowRuns.length, 1);
  assert.equal(dispatched.workflowNodeDispatches.length, 1);
  return dispatched;
}

test('workflow preferred dispatch starts one project-scoped workflow instead of task workflows', () => {
  const hub = createHub({ silent: true });
  createHighQualityProject(hub);

  const dispatched = startProjectWorkflow(hub);
  const workflowRun = dispatched.workflowRuns[0];

  assert.equal(workflowRun.workflowId, 'po-generated-project-workflow');
  assert.deepEqual(workflowRun.scope, { projectId: 'proj-project-workflow' });
  assert.equal(workflowRun.sourceTask, null);
  assert.equal(dispatched.workflowNodeDispatches[0].nodeId, 'worker-produce-project-deliverable');
  assert.equal(dispatched.workflowNodeDispatches[0].input.workflowRun.workflowId, 'po-generated-project-workflow');
  assert.equal(dispatched.workflowNodeDispatches[0].input.sourceTask, null);

  const tasks = hub.getBoard('proj-project-workflow').getAllTasks();
  assert.deepEqual(tasks.map(task => task.status), ['pending', 'pending', 'pending']);
  assert.equal(hub.listProjectWorkflowRuns('proj-project-workflow').length, 1);

  const duplicate = hub.handleRequestDispatch('proj-project-workflow', 'xiaok-po');
  assert.equal(duplicate.ok, true);
  assert.deepEqual(duplicate.dispatched, []);
  assert.deepEqual(duplicate.workflowDispatched, []);
  assert.equal(duplicate.workflowRuns.length, 0);
  assert.equal(hub.listProjectWorkflowRuns('proj-project-workflow').length, 1);
});

test('passed project workflow delivers the whole project with artifact provenance', () => {
  const hub = createHub({ silent: true });
  createHighQualityProject(hub, 'proj-project-workflow-deliver');
  const dispatched = startProjectWorkflow(hub, 'proj-project-workflow-deliver');
  const workflowRun = dispatched.workflowRuns[0];
  const workerDispatch = dispatched.workflowNodeDispatches[0];
  const workFolder = mkdtempSync(join(tmpdir(), 'kswarm-project-workflow-'));
  const deliverablePath = join(workFolder, 'final-project-report.md');
  writeFileSync(deliverablePath, '# 项目最终报告\n\n这是 project workflow 产出的最终交付物。\n');

  const workerDone = hub.handleWorkflowNodeResult({
    workflowRunId: workflowRun.id,
    nodeId: workerDispatch.nodeId,
    attempt: workerDispatch.attempt,
    handoffId: workerDispatch.handoffId,
    fromAgent: workerDispatch.targetParticipantId,
    output: {
      summary: '已生成项目最终报告。',
      artifacts: [{ path: deliverablePath, kind: 'markdown', label: 'final-project-report.md' }],
      workFolder,
      evidenceRefs: [`artifact:${deliverablePath}`],
    },
    now: 1770000002000,
  });
  assert.equal(workerDone.ok, true);
  assert.equal(workerDone.dispatches[0].nodeId, 'reviewer-adversarial-check');

  const reviewerDispatch = workerDone.dispatches[0];
  const reviewed = hub.handleWorkflowNodeReview({
    workflowRunId: workflowRun.id,
    nodeId: reviewerDispatch.nodeId,
    attempt: reviewerDispatch.attempt,
    handoffId: reviewerDispatch.handoffId,
    fromAgent: reviewerDispatch.targetParticipantId,
    reviewDecision: {
      status: 'passed',
      reason: '最终项目交付物存在，且覆盖项目目标。',
      evidenceRefs: [`artifact:${deliverablePath}`],
    },
    output: { summary: '复核通过。' },
    now: 1770000003000,
  });

  assert.equal(reviewed.ok, true);
  assert.equal(reviewed.workflowRun.status, 'completed');
  assert.equal(reviewed.workflowRun.projectDelivery.status, 'delivered');

  const project = hub.getProject('proj-project-workflow-deliver');
  assert.equal(project.status, 'delivered');
  assert.equal(project.deliverable.summary, '已生成项目最终报告。');
  assert.equal(project.deliverable.artifacts[0].path, deliverablePath);
  assert.equal(project.deliverable.provenance.workflowId, 'po-generated-project-workflow');
  assert.equal(project.deliverable.provenance.workflowRunId, workflowRun.id);

  const tasks = hub.getBoard('proj-project-workflow-deliver').getAllTasks();
  assert.deepEqual(tasks.map(task => task.status), ['done', 'done', 'done']);
  for (const task of tasks) {
    assert.equal(task.result.provenance.workflowId, 'po-generated-project-workflow');
    assert.equal(task.result.provenance.workflowRunId, workflowRun.id);
  }
});

test('project workflow blocks delivery when the worker returns no artifact evidence', () => {
  const hub = createHub({ silent: true });
  createHighQualityProject(hub, 'proj-project-workflow-missing-artifact');
  const dispatched = startProjectWorkflow(hub, 'proj-project-workflow-missing-artifact');
  const workflowRun = dispatched.workflowRuns[0];
  const workerDispatch = dispatched.workflowNodeDispatches[0];

  const workerDone = hub.handleWorkflowNodeResult({
    workflowRunId: workflowRun.id,
    nodeId: workerDispatch.nodeId,
    attempt: workerDispatch.attempt,
    handoffId: workerDispatch.handoffId,
    fromAgent: workerDispatch.targetParticipantId,
    output: { summary: '只有摘要，没有交付物文件。' },
    now: 1770000002000,
  });
  assert.equal(workerDone.ok, true);

  const reviewerDispatch = workerDone.dispatches[0];
  const reviewed = hub.handleWorkflowNodeReview({
    workflowRunId: workflowRun.id,
    nodeId: reviewerDispatch.nodeId,
    attempt: reviewerDispatch.attempt,
    handoffId: reviewerDispatch.handoffId,
    fromAgent: reviewerDispatch.targetParticipantId,
    reviewDecision: {
      status: 'passed',
      reason: 'reviewer 误判通过，但 worker 没有 artifact。',
      evidenceRefs: [],
    },
    output: { summary: '复核通过。' },
    now: 1770000003000,
  });

  assert.equal(reviewed.ok, true);
  assert.equal(reviewed.workflowRun.status, 'blocked');
  assert.equal(reviewed.workflowRun.projectDelivery.status, 'failed');
  assert.equal(reviewed.workflowRun.projectDelivery.reason, 'worker_deliverable_missing');
  assert.equal(hub.getProject('proj-project-workflow-missing-artifact').status, 'active');
  assert.deepEqual(
    hub.getBoard('proj-project-workflow-missing-artifact').getAllTasks().map(task => task.status),
    ['pending', 'pending', 'pending'],
  );
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
if (process.exitCode !== 1) console.log(`\n${passed}/${tests.length} project workflow strategy tests passed`);
