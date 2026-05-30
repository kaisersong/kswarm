/**
 * KSwarm — workflow proposal, approval, budget, and cancel contract tests
 *
 * Run: node test/workflow-proposal-approval.test.js
 */

import assert from 'node:assert/strict';
import { createHub } from '../src/core/hub.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function createActiveProject(hub, id = 'proj-proposal') {
  const project = hub.createProject({
    id,
    name: '工作流审批项目',
    goal: '验证 workflow proposal 先于 run',
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

test('creates agent workflow proposal without dispatching or creating a run', () => {
  const hub = createHub({ silent: true });
  createActiveProject(hub);

  const proposal = hub.createWorkflowProposal('proj-proposal', 'agent-review-smoke', {
    requestedBy: 'human',
    now: 1770000000000,
  });

  assert.equal(proposal.ok, true);
  assert.equal(proposal.workflowProposal.workflowId, 'agent-review-smoke');
  assert.equal(proposal.workflowProposal.approval.status, 'pending');
  assert.equal(proposal.workflowProposal.budgets.maxNodes, 3);
  assert.equal(proposal.workflowProposal.budgets.maxParallelism, 1);
  assert.equal(proposal.workflowProposal.acceptanceRubric.machineChecks.length > 0, true);
  assert.equal(proposal.workflowProposal.acceptanceRubric.judgmentChecks[0].evidenceRequired, true);
  assert.equal(proposal.workflowProposal.assumptions.length > 0, true);
  assert.deepEqual(proposal.dispatches, []);
  assert.equal(hub.listProjectWorkflowRuns('proj-proposal').length, 0);
});

test('approved workflow proposal creates durable run and dispatches first node', () => {
  const hub = createHub({ silent: true });
  createActiveProject(hub);
  const proposal = hub.createWorkflowProposal('proj-proposal', 'agent-review-smoke', { now: 1770000000000 });

  const started = hub.startWorkflowRunFromProposal(proposal.workflowProposal.id, {
    approvedBy: 'human',
    now: 1770000001000,
  });

  assert.equal(started.ok, true);
  assert.equal(started.workflowRun.workflowId, 'agent-review-smoke');
  assert.equal(started.workflowRun.approval.required, true);
  assert.equal(started.workflowRun.approval.status, 'approved');
  assert.equal(started.workflowRun.acceptanceRubric.id, proposal.workflowProposal.acceptanceRubric.id);
  assert.equal(started.workflowRun.budgets.maxNodes, 3);
  assert.equal(started.dispatches.length, 1);
  assert.equal(started.dispatches[0].nodeId, 'worker-diagnose-project');
  assert.equal(started.workflowRun.nodes.find(node => node.id === 'worker-diagnose-project').status, 'running');
});

test('proposal validation rejects over-budget workflow before any run exists', () => {
  const hub = createHub({ silent: true });
  createActiveProject(hub);

  const proposal = hub.createWorkflowProposal('proj-proposal', 'agent-review-smoke', {
    policy: { maxNodes: 2, maxParallelism: 1, maxAgents: 2, maxMinutes: 10, maxTokens: 12_000 },
    now: 1770000000000,
  });

  assert.equal(proposal.ok, false);
  assert.equal(proposal.error, 'budget_max_nodes_exceeded');
  assert.equal(hub.listProjectWorkflowRuns('proj-proposal').length, 0);
});

test('cancelled workflow proposal cannot start a run', () => {
  const hub = createHub({ silent: true });
  createActiveProject(hub);
  const proposal = hub.createWorkflowProposal('proj-proposal', 'agent-review-smoke', { now: 1770000000000 });

  const cancelled = hub.cancelWorkflowProposal(proposal.workflowProposal.id, {
    reason: 'human_cancelled',
    now: 1770000000500,
  });
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.workflowProposal.approval.status, 'rejected');

  const started = hub.startWorkflowRunFromProposal(proposal.workflowProposal.id, {
    approvedBy: 'human',
    now: 1770000001000,
  });
  assert.equal(started.ok, false);
  assert.equal(started.error, 'workflow_proposal_not_pending');
});

test('approved workflow proposal must match requested project and workflow identity', () => {
  const hub = createHub({ silent: true });
  createActiveProject(hub);
  createActiveProject(hub, 'proj-other');
  const proposal = hub.createWorkflowProposal('proj-proposal', 'agent-review-smoke', { now: 1770000000000 });

  const wrongProject = hub.startWorkflowRunFromProposal(proposal.workflowProposal.id, {
    projectId: 'proj-other',
    workflowId: 'agent-review-smoke',
    approvedBy: 'human',
    now: 1770000001000,
  });
  assert.equal(wrongProject.ok, false);
  assert.equal(wrongProject.error, 'workflow_proposal_project_mismatch');

  const wrongWorkflow = hub.startWorkflowRunFromProposal(proposal.workflowProposal.id, {
    projectId: 'proj-proposal',
    workflowId: 'project-diagnose',
    approvedBy: 'human',
    now: 1770000001000,
  });
  assert.equal(wrongWorkflow.ok, false);
  assert.equal(wrongWorkflow.error, 'workflow_proposal_workflow_mismatch');

  const started = hub.startWorkflowRunFromProposal(proposal.workflowProposal.id, {
    projectId: 'proj-proposal',
    workflowId: 'agent-review-smoke',
    approvedBy: 'human',
    now: 1770000001000,
  });
  assert.equal(started.ok, true);
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
if (process.exitCode !== 1) console.log(`\n${passed}/${tests.length} workflow proposal approval tests passed`);
