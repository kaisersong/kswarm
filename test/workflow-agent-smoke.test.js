/**
 * KSwarm — agent-backed workflow smoke tests
 *
 * Run: node test/workflow-agent-smoke.test.js
 */

import assert from 'node:assert/strict';
import { createHub } from '../src/core/hub.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function createActiveProject(hub, id = 'proj-agent-workflow') {
  const project = hub.createProject({
    id,
    name: 'Agent 工作流项目',
    goal: '验证 agent-backed dynamic workflow',
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

test('agent-review-smoke starts durable run and dispatches worker node only', () => {
  const hub = createHub({ silent: true });
  createActiveProject(hub);

  const result = hub.startAgentReviewSmokeWorkflow('proj-agent-workflow', { requestedBy: 'human', now: 1770000000000 });

  assert.equal(result.ok, true);
  assert.equal(result.workflowRun.workflowId, 'agent-review-smoke');
  assert.equal(result.workflowRun.status, 'running');
  assert.equal(result.workflowRun.source, 'builtin-smoke');
  assert.equal(result.dispatches.length, 1);
  assert.equal(result.dispatches[0].nodeId, 'worker-diagnose-project');
  assert.equal(result.dispatches[0].targetParticipantId, 'xiaok-worker');
  assert.equal(result.dispatches[0].attempt, 1);
  assert.ok(result.dispatches[0].handoffId);

  const worker = result.workflowRun.nodes.find(node => node.id === 'worker-diagnose-project');
  const reviewer = result.workflowRun.nodes.find(node => node.id === 'reviewer-adversarial-check');
  assert.equal(worker.status, 'running');
  assert.equal(worker.assignedAgent, 'xiaok-worker');
  assert.equal(worker.runtime.handoffId, result.dispatches[0].handoffId);
  assert.equal(reviewer.status, 'pending');
});

test('worker output unlocks reviewer and reviewer decision completes gate', () => {
  const hub = createHub({ silent: true });
  createActiveProject(hub);
  const started = hub.startAgentReviewSmokeWorkflow('proj-agent-workflow', { now: 1770000000000 });
  const workerDispatch = started.dispatches[0];

  const workerResult = hub.handleWorkflowNodeResult({
    workflowRunId: started.workflowRun.id,
    nodeId: 'worker-diagnose-project',
    attempt: workerDispatch.attempt,
    handoffId: workerDispatch.handoffId,
    fromAgent: 'xiaok-worker',
    output: { summary: '项目有一个待执行任务', evidenceRefs: ['task:item-1'] },
    now: 1770000001000,
  });

  assert.equal(workerResult.ok, true);
  assert.equal(workerResult.dispatches.length, 1);
  assert.equal(workerResult.dispatches[0].nodeId, 'reviewer-adversarial-check');
  assert.equal(workerResult.dispatches[0].targetParticipantId, 'xiaok-po');

  const reviewDispatch = workerResult.dispatches[0];
  const reviewed = hub.handleWorkflowNodeReview({
    workflowRunId: started.workflowRun.id,
    nodeId: 'reviewer-adversarial-check',
    attempt: reviewDispatch.attempt,
    handoffId: reviewDispatch.handoffId,
    fromAgent: 'xiaok-po',
    reviewDecision: { status: 'passed', reason: '诊断材料可用', evidenceRefs: ['task:item-1'] },
    output: { summary: '通过对抗性检查' },
    now: 1770000002000,
  });

  assert.equal(reviewed.ok, true);
  assert.equal(reviewed.workflowRun.status, 'completed');
  assert.equal(reviewed.workflowRun.gateDecision.status, 'passed');
  assert.equal(reviewed.workflowRun.summary.primaryMessage, 'Review gate passed');
  const gate = reviewed.workflowRun.nodes.find(node => node.id === 'reduce-review-gate');
  assert.equal(gate.status, 'completed');
  assert.equal(gate.output.decision.status, 'passed');
});

test('reviewer needs_rework decision blocks the workflow gate', () => {
  const hub = createHub({ silent: true });
  createActiveProject(hub);
  const started = hub.startAgentReviewSmokeWorkflow('proj-agent-workflow', { now: 1770000000000 });
  const workerResult = hub.handleWorkflowNodeResult({
    workflowRunId: started.workflowRun.id,
    nodeId: 'worker-diagnose-project',
    attempt: started.dispatches[0].attempt,
    handoffId: started.dispatches[0].handoffId,
    fromAgent: 'xiaok-worker',
    output: { summary: '证据不足' },
    now: 1770000001000,
  });
  const reviewDispatch = workerResult.dispatches[0];

  const reviewed = hub.handleWorkflowNodeReview({
    workflowRunId: started.workflowRun.id,
    nodeId: 'reviewer-adversarial-check',
    attempt: reviewDispatch.attempt,
    handoffId: reviewDispatch.handoffId,
    fromAgent: 'xiaok-po',
    reviewDecision: { status: 'needs_rework', reason: '缺少关键证据', evidenceRefs: [] },
    output: { summary: '需要补充证据' },
    now: 1770000002000,
  });

  assert.equal(reviewed.ok, true);
  assert.equal(reviewed.workflowRun.status, 'blocked');
  assert.equal(reviewed.workflowRun.gateDecision.status, 'needs_rework');
  assert.equal(reviewed.workflowRun.summary.primaryMessage, 'Review gate needs rework');
  assert.equal(reviewed.workflowRun.nodes.find(node => node.id === 'reduce-review-gate').status, 'completed');
});

test('stale attempts and late results after cancellation are rejected', () => {
  const hub = createHub({ silent: true });
  createActiveProject(hub);
  const started = hub.startAgentReviewSmokeWorkflow('proj-agent-workflow', { now: 1770000000000 });
  const workerDispatch = started.dispatches[0];

  const stale = hub.handleWorkflowNodeResult({
    workflowRunId: started.workflowRun.id,
    nodeId: 'worker-diagnose-project',
    attempt: workerDispatch.attempt + 1,
    handoffId: workerDispatch.handoffId,
    fromAgent: 'xiaok-worker',
    output: { summary: 'stale' },
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.error, 'workflow_attempt_mismatch');

  const cancelled = hub.cancelWorkflowRun(started.workflowRun.id, { reason: 'human_cancelled', now: 1770000000500 });
  assert.equal(cancelled.ok, true);

  const late = hub.handleWorkflowNodeResult({
    workflowRunId: started.workflowRun.id,
    nodeId: 'worker-diagnose-project',
    attempt: workerDispatch.attempt,
    handoffId: workerDispatch.handoffId,
    fromAgent: 'xiaok-worker',
    output: { summary: 'late' },
  });
  assert.equal(late.ok, false);
  assert.equal(late.error, 'workflow_run_terminal');
});

test('malformed reviewer decision and runtime unavailable block workflow recoverably', () => {
  const hub = createHub({ silent: true });
  createActiveProject(hub);
  const started = hub.startAgentReviewSmokeWorkflow('proj-agent-workflow', { now: 1770000000000 });

  const missingRuntime = hub.handleWorkflowRuntimeUnavailable({
    workflowRunId: started.workflowRun.id,
    nodeId: 'worker-diagnose-project',
    attempt: started.dispatches[0].attempt,
    handoffId: started.dispatches[0].handoffId,
    reason: 'runtime_unavailable',
    now: 1770000000500,
  });

  assert.equal(missingRuntime.ok, true);
  assert.equal(missingRuntime.workflowRun.status, 'blocked');
  assert.equal(missingRuntime.workflowRun.nodes.find(node => node.id === 'worker-diagnose-project').error, 'runtime_unavailable');

  const second = createActiveProject(hub, 'proj-malformed-review');
  assert.equal(second.id, 'proj-malformed-review');
  const startedSecond = hub.startAgentReviewSmokeWorkflow('proj-malformed-review', { now: 1770000001000 });
  const workerDone = hub.handleWorkflowNodeResult({
    workflowRunId: startedSecond.workflowRun.id,
    nodeId: 'worker-diagnose-project',
    attempt: startedSecond.dispatches[0].attempt,
    handoffId: startedSecond.dispatches[0].handoffId,
    fromAgent: 'xiaok-worker',
    output: { summary: 'worker done' },
  });
  const malformed = hub.handleWorkflowNodeReview({
    workflowRunId: startedSecond.workflowRun.id,
    nodeId: 'reviewer-adversarial-check',
    attempt: workerDone.dispatches[0].attempt,
    handoffId: workerDone.dispatches[0].handoffId,
    fromAgent: 'xiaok-po',
    reviewDecision: { status: 'maybe', reason: '' },
  });

  assert.equal(malformed.ok, true);
  assert.equal(malformed.workflowRun.status, 'blocked');
  assert.equal(malformed.workflowRun.gateDecision.status, 'blocked');
  assert.equal(malformed.workflowRun.nodes.find(node => node.id === 'reviewer-adversarial-check').error, 'malformed_review_decision');
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
if (process.exitCode !== 1) console.log(`\n${passed}/${tests.length} agent workflow smoke tests passed`);
