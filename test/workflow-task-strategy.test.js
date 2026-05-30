/**
 * KSwarm — task-level dynamic workflow strategy tests
 *
 * Run: node test/workflow-task-strategy.test.js
 */

import assert from 'node:assert/strict';
import { createHub } from '../src/core/hub.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function createActiveProject(hub, id = 'proj-task-workflow') {
  const project = hub.createProject({
    id,
    name: '任务工作流项目',
    goal: '验证 task 级动态工作流',
    poAgent: 'xiaok-po',
    members: ['xiaok-worker'],
  });
  const added = hub.handleHumanAddTasks(id, [
    { title: '生成客户分析报告', description: '需要有事实依据和复核结论', assignedAgent: 'xiaok-worker' },
    { title: '整理引用材料', assignedAgent: 'xiaok-worker' },
  ]);
  assert.equal(added.ok, true);
  const approved = hub.handleApprove(id);
  assert.equal(approved.ok, true);
  return project;
}

function firstTaskId(hub, projectId = 'proj-task-workflow') {
  return hub.getBoard(projectId).getAllTasks()[0].id;
}

test('creates task-scoped workflow proposal without dispatching or creating a run', () => {
  const hub = createHub({ silent: true });
  createActiveProject(hub);
  const taskId = firstTaskId(hub);

  const proposal = hub.createWorkflowProposal('proj-task-workflow', 'agent-review-smoke', {
    requestedBy: 'human',
    taskId,
    now: 1770000000000,
  });

  assert.equal(proposal.ok, true);
  assert.equal(proposal.workflowProposal.strategy, 'workflow');
  assert.equal(proposal.workflowProposal.source, 'builtin-smoke');
  assert.equal(proposal.workflowProposal.scope.projectId, 'proj-task-workflow');
  assert.equal(proposal.workflowProposal.scope.taskId, taskId);
  assert.equal(proposal.workflowProposal.sourceTask.id, taskId);
  assert.equal(proposal.workflowProposal.sourceTask.title, '生成客户分析报告');
  assert.equal(proposal.workflowProposal.budgetGate.status, 'passed');
  assert.equal(proposal.workflowProposal.budgetGate.hardLimits.maxAgents, 2);
  assert.equal(proposal.workflowProposal.budgetGate.estimate.riskLevel, 'medium');
  assert.deepEqual(proposal.dispatches, []);
  assert.equal(hub.listProjectWorkflowRuns('proj-task-workflow').length, 0);
});

test('creates a controlled PO-generated task workflow proposal as validated IR', () => {
  const hub = createHub({ silent: true });
  createActiveProject(hub);
  const taskId = firstTaskId(hub);

  const proposal = hub.createWorkflowProposal('proj-task-workflow', 'po-generated-task-workflow', {
    requestedBy: 'xiaok-po',
    taskId,
    now: 1770000000000,
  });

  assert.equal(proposal.ok, true);
  assert.equal(proposal.workflowProposal.workflowId, 'po-generated-task-workflow');
  assert.equal(proposal.workflowProposal.source, 'po_generated');
  assert.equal(proposal.workflowProposal.scope.taskId, taskId);
  assert.equal(proposal.workflowProposal.title, 'PO 生成任务工作流');
  assert.equal(proposal.workflowProposal.permissions.allowWrite, false);
  assert.equal(proposal.workflowProposal.permissions.allowShell, false);
  assert.equal(proposal.workflowProposal.permissions.allowNetwork, false);
  assert.equal(proposal.workflowProposal.acceptanceRubric.judgmentChecks[0].evidenceRequired, true);
  assert.equal(proposal.workflowProposal.phases.length, 3);
});

test('approved task workflow must match task identity and re-check hard budget limits before dispatch', () => {
  const hub = createHub({ silent: true });
  createActiveProject(hub);
  const [firstTask, secondTask] = hub.getBoard('proj-task-workflow').getAllTasks();
  const proposal = hub.createWorkflowProposal('proj-task-workflow', 'po-generated-task-workflow', {
    taskId: firstTask.id,
    now: 1770000000000,
  });
  assert.equal(proposal.ok, true);

  const wrongTask = hub.startWorkflowRunFromProposal(proposal.workflowProposal.id, {
    projectId: 'proj-task-workflow',
    workflowId: 'po-generated-task-workflow',
    taskId: secondTask.id,
    approvedBy: 'human',
    now: 1770000001000,
  });
  assert.equal(wrongTask.ok, false);
  assert.equal(wrongTask.error, 'workflow_proposal_task_mismatch');

  const overBudget = hub.startWorkflowRunFromProposal(proposal.workflowProposal.id, {
    projectId: 'proj-task-workflow',
    workflowId: 'po-generated-task-workflow',
    taskId: firstTask.id,
    approvedBy: 'human',
    policy: { maxNodes: 3, maxParallelism: 1, maxAgents: 2, maxMinutes: 15, maxTokens: 100 },
    now: 1770000001000,
  });
  assert.equal(overBudget.ok, false);
  assert.equal(overBudget.error, 'budget_max_tokens_exceeded');
  assert.equal(hub.listProjectWorkflowRuns('proj-task-workflow').length, 0);

  const started = hub.startWorkflowRunFromProposal(proposal.workflowProposal.id, {
    projectId: 'proj-task-workflow',
    workflowId: 'po-generated-task-workflow',
    taskId: firstTask.id,
    approvedBy: 'human',
    now: 1770000002000,
  });
  assert.equal(started.ok, true);
  assert.equal(started.workflowRun.scope.taskId, firstTask.id);
  assert.equal(started.workflowRun.sourceTask.id, firstTask.id);
  assert.equal(started.workflowRun.budgetGate.status, 'passed');
  assert.equal(started.dispatches.length, 1);
  assert.equal(started.dispatches[0].nodeId, 'po-draft-task-plan');
});

test('completed workflow nodes store run-internal cache metadata and recovery summary', () => {
  const hub = createHub({ silent: true });
  createActiveProject(hub);
  const taskId = firstTaskId(hub);
  const proposal = hub.createWorkflowProposal('proj-task-workflow', 'po-generated-task-workflow', {
    taskId,
    now: 1770000000000,
  });
  const started = hub.startWorkflowRunFromProposal(proposal.workflowProposal.id, {
    projectId: 'proj-task-workflow',
    workflowId: 'po-generated-task-workflow',
    taskId,
    approvedBy: 'human',
    now: 1770000001000,
  });
  assert.equal(started.ok, true);

  const workerDone = hub.handleWorkflowNodeResult({
    workflowRunId: started.workflowRun.id,
    nodeId: 'po-draft-task-plan',
    attempt: started.dispatches[0].attempt,
    handoffId: started.dispatches[0].handoffId,
    fromAgent: 'xiaok-po',
    output: { summary: '已拆解任务工作流', evidenceRefs: [`task:${taskId}`] },
    now: 1770000002000,
  });

  assert.equal(workerDone.ok, true);
  const node = workerDone.workflowRun.nodes.find(item => item.id === 'po-draft-task-plan');
  assert.equal(node.cache.status, 'stored');
  assert.ok(node.cache.key.includes(started.workflowRun.id));
  assert.equal(workerDone.workflowRun.summary.cache.storedNodeCount, 1);
  assert.equal(workerDone.workflowRun.recovery.mode, 'resume_completed_nodes');
  assert.equal(workerDone.workflowRun.recovery.reusableNodeCount, 1);
  assert.equal(workerDone.workflowRun.recovery.nextAction, 'resume_workflow');
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
if (process.exitCode !== 1) console.log(`\n${passed}/${tests.length} task workflow strategy tests passed`);
