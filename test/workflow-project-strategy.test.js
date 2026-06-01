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

function completeAllTasks(hub, projectId) {
  const board = hub.getBoard(projectId);
  for (const task of board.getAllTasks()) {
    let result = board.transition(task.id, 'dispatched', { assignedAgent: task.assignedAgent });
    assert.equal(result.ok, true);
    result = board.transition(task.id, 'accepted');
    assert.equal(result.ok, true);
    result = board.transition(task.id, 'in_progress');
    assert.equal(result.ok, true);
    result = board.transition(task.id, 'submitted', {
      result: {
        summary: `完成 ${task.title}`,
        artifacts: [],
      },
    });
    assert.equal(result.ok, true);
    result = board.transition(task.id, 'done');
    assert.equal(result.ok, true);
  }
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

test('workflow preferred dispatch continues task graph when ready tasks exist', () => {
  const hub = createHub({ silent: true });
  createHighQualityProject(hub);

  const dispatched = hub.handleRequestDispatch('proj-project-workflow', 'xiaok-po');

  assert.equal(dispatched.ok, true);
  assert.deepEqual(dispatched.dispatched, ['proj-project-workflow__item-1']);
  assert.deepEqual(dispatched.workflowDispatched, []);
  assert.equal(dispatched.workflowRuns.length, 0);
  assert.equal(dispatched.workflowNodeDispatches.length, 0);

  const tasks = hub.getBoard('proj-project-workflow').getAllTasks();
  assert.deepEqual(tasks.map(task => task.status), ['dispatched', 'pending', 'pending']);
  assert.equal(hub.listProjectWorkflowRuns('proj-project-workflow').length, 0);
});

test('active project workflow does not block dispatchable task graph work', () => {
  const hub = createHub({ silent: true });
  createHighQualityProject(hub, 'proj-project-workflow-stale-active');

  const proposal = hub.createWorkflowProposal('proj-project-workflow-stale-active', 'po-generated-project-workflow', {
    requestedBy: 'xiaok-po',
    now: 1770000000000,
  });
  assert.equal(proposal.ok, true);
  const started = hub.startWorkflowRunFromProposal(proposal.workflowProposal.id, {
    projectId: 'proj-project-workflow-stale-active',
    workflowId: 'po-generated-project-workflow',
    approvedBy: 'xiaok-po',
    now: 1770000001000,
  });
  assert.equal(started.ok, true);
  assert.equal(started.workflowRun.status, 'running');

  const dispatched = hub.handleRequestDispatch('proj-project-workflow-stale-active', 'xiaok-po');

  assert.equal(dispatched.ok, true);
  assert.deepEqual(dispatched.dispatched, ['proj-project-workflow-stale-active__item-1']);
  assert.deepEqual(dispatched.workflowDispatched, []);
  assert.equal(dispatched.workflowRuns.length, 0);
  assert.equal(dispatched.activeProjectWorkflowRun, undefined);

  const tasks = hub.getBoard('proj-project-workflow-stale-active').getAllTasks();
  assert.deepEqual(tasks.map(task => task.status), ['dispatched', 'pending', 'pending']);
  assert.equal(hub.listProjectWorkflowRuns('proj-project-workflow-stale-active').length, 1);
});

test('project workflow cannot deliver over incomplete task graph', () => {
  const hub = createHub({ silent: true });
  createHighQualityProject(hub, 'proj-project-workflow-incomplete-graph');

  const proposal = hub.createWorkflowProposal('proj-project-workflow-incomplete-graph', 'po-generated-project-workflow', {
    requestedBy: 'xiaok-po',
    now: 1770000000000,
  });
  assert.equal(proposal.ok, true);
  const started = hub.startWorkflowRunFromProposal(proposal.workflowProposal.id, {
    projectId: 'proj-project-workflow-incomplete-graph',
    workflowId: 'po-generated-project-workflow',
    approvedBy: 'xiaok-po',
    now: 1770000001000,
  });
  assert.equal(started.ok, true);
  const workflowRun = started.workflowRun;
  const workerDispatch = started.dispatches[0];
  const workFolder = mkdtempSync(join(tmpdir(), 'kswarm-project-workflow-incomplete-'));
  const deliverablePath = join(workFolder, 'premature-final-report.md');
  writeFileSync(deliverablePath, '# 提前返回的项目报告\n\n任务图尚未完成，不能交付。\n');

  const workerDone = hub.handleWorkflowNodeResult({
    workflowRunId: workflowRun.id,
    nodeId: workerDispatch.nodeId,
    attempt: workerDispatch.attempt,
    handoffId: workerDispatch.handoffId,
    fromAgent: workerDispatch.targetParticipantId,
    output: {
      summary: '提前生成项目最终报告。',
      artifacts: [{ path: deliverablePath, kind: 'markdown', label: 'premature-final-report.md' }],
      workFolder,
    },
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
      reason: 'reviewer 误判通过，但任务图仍未完成。',
      evidenceRefs: [`artifact:${deliverablePath}`],
    },
    output: { summary: '复核通过。' },
    now: 1770000003000,
  });

  assert.equal(reviewed.ok, true);
  assert.equal(reviewed.workflowRun.status, 'blocked');
  assert.equal(reviewed.workflowRun.projectDelivery.status, 'failed');
  assert.equal(reviewed.workflowRun.projectDelivery.reason, 'tasks_not_all_done');
  assert.equal(hub.getProject('proj-project-workflow-incomplete-graph').status, 'active');
  assert.deepEqual(
    hub.getBoard('proj-project-workflow-incomplete-graph').getAllTasks().map(task => task.status),
    ['pending', 'pending', 'pending'],
  );
});

test('workflow preferred dispatch starts project workflow after task graph is complete', () => {
  const hub = createHub({ silent: true });
  createHighQualityProject(hub, 'proj-project-workflow-complete-graph');
  completeAllTasks(hub, 'proj-project-workflow-complete-graph');

  const dispatched = startProjectWorkflow(hub, 'proj-project-workflow-complete-graph');
  const workflowRun = dispatched.workflowRuns[0];

  assert.equal(workflowRun.workflowId, 'po-generated-project-workflow');
  assert.deepEqual(workflowRun.scope, { projectId: 'proj-project-workflow-complete-graph' });
  assert.equal(workflowRun.sourceTask, null);
  assert.equal(dispatched.workflowNodeDispatches[0].nodeId, 'worker-produce-project-deliverable');
  assert.equal(dispatched.workflowNodeDispatches[0].input.workflowRun.workflowId, 'po-generated-project-workflow');
  assert.equal(dispatched.workflowNodeDispatches[0].input.sourceTask, null);
});

test('passed project workflow delivers the whole project with artifact provenance', () => {
  const hub = createHub({ silent: true });
  createHighQualityProject(hub, 'proj-project-workflow-deliver');
  completeAllTasks(hub, 'proj-project-workflow-deliver');
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
  assert.deepEqual(project.deliverable.evidenceRefs, [`artifact:${deliverablePath}`]);
  assert.equal(project.deliverable.provenance.workflowId, 'po-generated-project-workflow');
  assert.equal(project.deliverable.provenance.workflowRunId, workflowRun.id);

  const tasks = hub.getBoard('proj-project-workflow-deliver').getAllTasks();
  assert.deepEqual(tasks.map(task => task.status), ['done', 'done', 'done']);
  for (const task of tasks) {
    assert.equal(task.result.provenance.workflowId, 'po-generated-project-workflow');
    assert.equal(task.result.provenance.workflowRunId, workflowRun.id);
  }
});

test('workflow preferred single-task override still dispatches task workflow through onlyTaskIds', () => {
  const hub = createHub({ silent: true });
  createHighQualityProject(hub, 'proj-project-workflow-task-override');
  const task = hub.getBoard('proj-project-workflow-task-override').getAllTasks()[0];
  task.executionStrategyOverride = 'workflow';

  const dispatched = hub.handleRequestDispatch('proj-project-workflow-task-override', 'xiaok-po', {
    onlyTaskIds: [task.id],
  });

  assert.equal(dispatched.ok, true);
  assert.deepEqual(dispatched.dispatched, []);
  assert.deepEqual(dispatched.workflowDispatched, [task.id]);
  assert.equal(dispatched.workflowRuns.length, 1);
  assert.equal(dispatched.workflowRuns[0].workflowId, 'po-generated-task-workflow');
  assert.deepEqual(dispatched.workflowRuns[0].scope, {
    projectId: 'proj-project-workflow-task-override',
    taskId: task.id,
  });
  assert.equal(dispatched.workflowNodeDispatches[0].nodeId, 'worker-produce-deliverable');
  assert.equal(
    hub.listProjectWorkflowRuns('proj-project-workflow-task-override')
      .filter(run => run.workflowId === 'po-generated-project-workflow').length,
    0,
  );
});

test('project workflow blocks delivery when the worker returns no artifact evidence', () => {
  const hub = createHub({ silent: true });
  createHighQualityProject(hub, 'proj-project-workflow-missing-artifact');
  completeAllTasks(hub, 'proj-project-workflow-missing-artifact');
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
    ['done', 'done', 'done'],
  );
});

test('project workflow blocks delivery when artifact paths are not readable project files', () => {
  const hub = createHub({ silent: true });
  createHighQualityProject(hub, 'proj-project-workflow-fake-artifact');
  completeAllTasks(hub, 'proj-project-workflow-fake-artifact');
  const dispatched = startProjectWorkflow(hub, 'proj-project-workflow-fake-artifact');
  const workflowRun = dispatched.workflowRuns[0];
  const workerDispatch = dispatched.workflowNodeDispatches[0];
  const workFolder = mkdtempSync(join(tmpdir(), 'kswarm-project-workflow-fake-'));
  const missingPath = join(workFolder, 'missing-final-report.md');

  const workerDone = hub.handleWorkflowNodeResult({
    workflowRunId: workflowRun.id,
    nodeId: workerDispatch.nodeId,
    attempt: workerDispatch.attempt,
    handoffId: workerDispatch.handoffId,
    fromAgent: workerDispatch.targetParticipantId,
    output: {
      summary: '声称已经生成项目最终报告，但路径不存在。',
      artifacts: [{ path: missingPath, kind: 'markdown', label: 'missing-final-report.md' }],
      workFolder,
      evidenceRefs: [`artifact:${missingPath}`],
    },
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
      reason: 'reviewer 误判通过，但 artifact path 不存在。',
      evidenceRefs: [`artifact:${missingPath}`],
    },
    output: { summary: '复核通过。' },
    now: 1770000003000,
  });

  assert.equal(reviewed.ok, true);
  assert.equal(reviewed.workflowRun.status, 'blocked');
  assert.equal(reviewed.workflowRun.projectDelivery.status, 'failed');
  assert.equal(reviewed.workflowRun.projectDelivery.reason, 'worker_artifact_invalid');
  assert.equal(hub.getProject('proj-project-workflow-fake-artifact').status, 'active');
  assert.deepEqual(
    hub.getBoard('proj-project-workflow-fake-artifact').getAllTasks().map(task => task.status),
    ['done', 'done', 'done'],
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
