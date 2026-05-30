/**
 * KSwarm — workflow determinism boundary contract tests
 *
 * Run: node test/workflow-determinism-boundary.test.js
 */

import assert from 'node:assert/strict';
import { createHub } from '../src/core/hub.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function createActiveProject(hub, id = 'proj-boundary') {
  const project = hub.createProject({
    id,
    name: '确定性边界项目',
    goal: '验证 workflow node 不越权修改项目状态',
    poAgent: 'xiaok-po',
    members: ['xiaok-worker'],
  });
  const added = hub.handleHumanAddTasks(id, [
    { title: '输出诊断材料', assignedAgent: 'xiaok-worker' },
  ]);
  assert.equal(added.ok, true);
  const approved = hub.handleApprove(id);
  assert.equal(approved.ok, true);
  return project;
}

function projectTasks(hub, projectId = 'proj-boundary') {
  return hub.getBoard(projectId).getAllTasks();
}

test('agent node result only updates node output and cannot mutate project task graph', () => {
  const hub = createHub({ silent: true });
  createActiveProject(hub);
  const beforeTasks = projectTasks(hub).map(task => ({ id: task.id, title: task.title, status: task.status }));
  const started = hub.startAgentReviewSmokeWorkflow('proj-boundary', { now: 1770000000000 });

  const result = hub.handleWorkflowNodeResult({
    workflowRunId: started.workflowRun.id,
    nodeId: 'worker-diagnose-project',
    attempt: started.dispatches[0].attempt,
    handoffId: started.dispatches[0].handoffId,
    fromAgent: 'xiaok-worker',
    output: {
      summary: '尝试越权修改项目',
      taskMutations: [{ type: 'create_task', title: '不应创建的新任务' }],
      workflowGraphMutation: { addNode: { id: 'secret-node' } },
      projectStatus: 'delivered',
    },
    now: 1770000001000,
  });

  assert.equal(result.ok, true);
  const afterTasks = projectTasks(hub).map(task => ({ id: task.id, title: task.title, status: task.status }));
  assert.deepEqual(afterTasks, beforeTasks);
  assert.equal(result.workflowRun.nodes.some(node => node.id === 'secret-node'), false);
  assert.equal(hub.getProject('proj-boundary').status, 'active');
  assert.deepEqual(result.workflowRun.nodes.find(node => node.id === 'worker-diagnose-project').output.rejectedMutations, [
    'taskMutations',
    'workflowGraphMutation',
    'projectStatus',
  ]);
});

test('reviewer decision cannot directly mark task or artifact as done', () => {
  const hub = createHub({ silent: true });
  createActiveProject(hub);
  const started = hub.startAgentReviewSmokeWorkflow('proj-boundary', { now: 1770000000000 });
  const workerResult = hub.handleWorkflowNodeResult({
    workflowRunId: started.workflowRun.id,
    nodeId: 'worker-diagnose-project',
    attempt: started.dispatches[0].attempt,
    handoffId: started.dispatches[0].handoffId,
    fromAgent: 'xiaok-worker',
    output: { summary: '诊断完成' },
  });

  const reviewed = hub.handleWorkflowNodeReview({
    workflowRunId: started.workflowRun.id,
    nodeId: 'reviewer-adversarial-check',
    attempt: workerResult.dispatches[0].attempt,
    handoffId: workerResult.dispatches[0].handoffId,
    fromAgent: 'xiaok-po',
    reviewDecision: {
      status: 'passed',
      reason: '诊断材料可用',
      evidenceRefs: ['node:worker-diagnose-project'],
      taskStatus: 'done',
      artifactStatus: 'accepted',
    },
    output: { summary: '复核通过' },
  });

  assert.equal(reviewed.ok, true);
  const task = projectTasks(hub)[0];
  assert.notEqual(task.status, 'done');
  assert.equal(reviewed.workflowRun.gateDecision.taskStatus, undefined);
  assert.equal(reviewed.workflowRun.gateDecision.artifactStatus, undefined);
  assert.deepEqual(reviewed.workflowRun.gateDecision.rejectedMutations, ['taskStatus', 'artifactStatus']);
});

test('needs_replanning pauses current run and creates revised proposal request instead of editing tasks', () => {
  const hub = createHub({ silent: true });
  createActiveProject(hub);
  const started = hub.startAgentReviewSmokeWorkflow('proj-boundary', { now: 1770000000000 });
  const workerResult = hub.handleWorkflowNodeResult({
    workflowRunId: started.workflowRun.id,
    nodeId: 'worker-diagnose-project',
    attempt: started.dispatches[0].attempt,
    handoffId: started.dispatches[0].handoffId,
    fromAgent: 'xiaok-worker',
    output: { summary: '当前计划不成立' },
  });
  const taskCount = projectTasks(hub).length;

  const reviewed = hub.handleWorkflowNodeReview({
    workflowRunId: started.workflowRun.id,
    nodeId: 'reviewer-adversarial-check',
    attempt: workerResult.dispatches[0].attempt,
    handoffId: workerResult.dispatches[0].handoffId,
    fromAgent: 'xiaok-po',
    reviewDecision: {
      status: 'needs_replanning',
      reason: '原任务拆分错误，需要 PO 重新规划',
      evidenceRefs: ['node:worker-diagnose-project'],
      suggestedTaskMutations: [{ type: 'create_task', title: '补充调研' }],
    },
  });

  assert.equal(reviewed.ok, true);
  assert.equal(reviewed.workflowRun.status, 'blocked');
  assert.equal(reviewed.workflowRun.gateDecision.status, 'needs_replanning');
  assert.equal(reviewed.workflowRun.revisedProposalRequest.reason, '原任务拆分错误，需要 PO 重新规划');
  assert.equal(reviewed.workflowRun.revisedProposalRequest.status, 'pending_user_confirmation');
  assert.equal(projectTasks(hub).length, taskCount);
});

test('needs_rubric_clarification is preserved as gate state and not downgraded to failed', () => {
  const hub = createHub({ silent: true });
  createActiveProject(hub);
  const started = hub.startAgentReviewSmokeWorkflow('proj-boundary', { now: 1770000000000 });
  const workerResult = hub.handleWorkflowNodeResult({
    workflowRunId: started.workflowRun.id,
    nodeId: 'worker-diagnose-project',
    attempt: started.dispatches[0].attempt,
    handoffId: started.dispatches[0].handoffId,
    fromAgent: 'xiaok-worker',
    output: { summary: '验收标准不清晰' },
  });

  const reviewed = hub.handleWorkflowNodeReview({
    workflowRunId: started.workflowRun.id,
    nodeId: 'reviewer-adversarial-check',
    attempt: workerResult.dispatches[0].attempt,
    handoffId: workerResult.dispatches[0].handoffId,
    fromAgent: 'xiaok-po',
    reviewDecision: {
      status: 'needs_rubric_clarification',
      reason: 'rubric 没有定义 evidence refs',
      evidenceRefs: ['node:worker-diagnose-project'],
    },
  });

  assert.equal(reviewed.ok, true);
  assert.equal(reviewed.workflowRun.status, 'blocked');
  assert.equal(reviewed.workflowRun.gateDecision.status, 'needs_rubric_clarification');
  assert.equal(reviewed.workflowRun.summary.primaryMessage, 'Review gate needs rubric clarification');
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
if (process.exitCode !== 1) console.log(`\n${passed}/${tests.length} workflow determinism boundary tests passed`);
