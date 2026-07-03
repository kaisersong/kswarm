/**
 * KSwarm — project/workflow state unification contract tests
 *
 * Run: node test/project-workflow-state-unification.test.js
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHub } from '../src/core/hub.js';
import {
  deriveExecutionGraph,
  deriveProjectLifecycle,
  parseStrictWorkflowLabel,
} from '../src/core/project-read-model.js';
import { decideProjectStartPolicy } from '../src/core/project-start-policy.js';
import { createMutationTokenRegistry, resolveMutationRequestContext } from '../src/core/mutation-transport.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function makeUserContext(actorId = 'desktop-user') {
  return {
    requestSource: 'user',
    actorId,
    actorKind: 'desktop_user',
    transport: 'desktop_ipc',
  };
}

function makeAgentContext(actorId = 'xiaok-worker') {
  return {
    requestSource: 'agent',
    actorId,
    actorKind: 'agent_runtime',
    transport: 'agent_tool',
    runtimeTaskId: 'task-runtime-1',
  };
}

function createReadyProject(hub, projectId = 'proj-state-unification') {
  const project = hub.createProject({
    id: projectId,
    name: '状态统一测试项目',
    goal: '生成最终报告',
    poAgent: 'xiaok-po',
    members: ['xiaok-worker'],
    executionMode: 'workflow_preferred',
  });
  const added = hub.handleHumanAddTasks(projectId, [
    { id: 'item-1', title: '收集资料', assignedAgent: 'xiaok-worker' },
    { id: 'item-2', title: '生成报告', assignedAgent: 'xiaok-worker', dependencies: ['item-1'], requiredOutputs: ['markdown'] },
  ]);
  assert.equal(added.ok, true);
  assert.equal(hub.handleApprove(projectId).ok, true);
  return project;
}

function markAllTasksDone(hub, projectId) {
  const board = hub.getBoard(projectId);
  for (const task of board.getAllTasks()) {
    if (task.status === 'done') continue;
    assert.equal(board.transition(task.id, 'dispatched', { assignedAgent: task.assignedAgent }).ok, true);
    assert.equal(board.transition(task.id, 'accepted').ok, true);
    assert.equal(board.transition(task.id, 'in_progress').ok, true);
    assert.equal(board.transition(task.id, 'submitted', { result: { summary: `${task.title} 完成`, artifacts: [] } }).ok, true);
    assert.equal(board.transition(task.id, 'done').ok, true);
  }
}

test('strict workflow label parser only returns a unique item id', () => {
  assert.equal(parseStrictWorkflowLabel('Agent7'), 'item-7');
  assert.equal(parseStrictWorkflowLabel('支柱七'), 'item-7');
  assert.equal(parseStrictWorkflowLabel('任务12'), 'item-12');
  assert.equal(parseStrictWorkflowLabel('Agent7 支柱七'), 'item-7');
  assert.equal(parseStrictWorkflowLabel('Agent7 支柱八'), null);
  assert.equal(parseStrictWorkflowLabel('分析第七个问题'), null);
});

test('execution graph never binds workflow nodes by creation order', () => {
  const graph = deriveExecutionGraph({
    project: { id: 'proj-bind', executionMode: 'workflow_preferred' },
    tasks: [
      { id: 'proj-bind__item-1', localTaskId: 'item-1', title: '任务一', status: 'pending', assignedAgent: 'worker-a' },
      { id: 'proj-bind__item-2', localTaskId: 'item-2', title: '任务二', status: 'pending', assignedAgent: 'worker-b' },
    ],
    workflowRuns: [{
      id: 'wf-bind',
      projectId: 'proj-bind',
      workflowId: 'script-generated',
      source: 'script_generated',
      status: 'running',
      nodes: [
        { id: 'node-b', title: '未标号节点', status: 'completed', kind: 'agent_task', output: { summary: 'done' } },
        { id: 'node-a', title: 'Agent2', status: 'running', kind: 'agent_task', assignedAgent: 'worker-b' },
      ],
    }],
  });

  const nodeB = graph.nodes.find(node => node.workflowNodeId === 'node-b');
  const nodeA = graph.nodes.find(node => node.workflowNodeId === 'node-a');

  assert.equal(nodeB.ownership, 'unbound');
  assert.match(nodeB.stableNodeId, /^wf-node-/);
  assert.equal(nodeB.taskId, undefined);
  assert.equal(nodeA.taskId, 'proj-bind__item-2');
  assert.equal(nodeA.bindingSource, 'strict_label');
});

test('legacy workflow completion with pending board becomes reconciliation, not inconsistent', () => {
  const lifecycle = deriveProjectLifecycle({
    project: { id: 'proj-73a91b8e-a050-48a6-b50d-6c213b627295', status: 'planning', executionMode: 'workflow_preferred' },
    tasks: [
      { id: 'item-1', title: '旧计划任务', status: 'pending', required: true },
    ],
    workflowRuns: [{
      id: 'wf-legacy',
      projectId: 'proj-73a91b8e-a050-48a6-b50d-6c213b627295',
      source: 'script_generated',
      status: 'completed',
      projectDelivery: { status: 'candidate', finalDeliverableId: 'fd-legacy' },
      nodes: [{ id: 'script-runtime', title: '动态工作流', status: 'completed', output: { summary: '完成' } }],
    }],
    finalDeliverables: [{
      deliverableId: 'fd-legacy',
      projectId: 'proj-73a91b8e-a050-48a6-b50d-6c213b627295',
      status: 'candidate',
      source: 'project_workflow',
      submitted: makeAgentContext(),
    }],
    reviewGateDecisions: [],
  });

  assert.equal(lifecycle.state, 'legacy_needs_reconciliation');
  assert.equal(lifecycle.canAutoClose, false);
  assert.equal(lifecycle.issues.some(issue => issue.kind === 'legacy_final_deliverable_needs_confirmation'), true);
  assert.equal(lifecycle.issues.some(issue => issue.kind === 'legacy_board_pending_conflict'), false);
});

test('agent workflow deliverable is a candidate until user approves it', () => {
  const hub = createHub({ silent: true });
  const projectId = 'proj-agent-candidate';
  createReadyProject(hub, projectId);
  markAllTasksDone(hub, projectId);

  const dir = mkdtempSync(join(tmpdir(), 'kswarm-final-deliverable-'));
  try {
    hub.getProject(projectId).workFolder = dir;
    mkdirSync(join(dir, 'artifacts'), { recursive: true });
    const artifactPath = join(dir, 'artifacts', 'final.md');
    writeFileSync(artifactPath, '# 最终报告\n\n已完成。\n');

    const forged = hub.registerFinalDeliverable(projectId, {
      executionNodeId: null,
      kind: 'file',
      expectedFormat: 'markdown',
      artifactRef: { path: artifactPath },
      source: 'project_workflow',
      submittedBy: 'xiaok-worker',
      submissionIdempotencyKey: 'submit-agent-forged',
      claimedRequestSource: 'user',
    }, makeAgentContext());
    assert.equal(forged.ok, false);
    assert.equal(forged.error, 'request_source_forgery_detected');

    const registered = hub.registerFinalDeliverable(projectId, {
      executionNodeId: null,
      kind: 'file',
      expectedFormat: 'markdown',
      artifactRef: { path: artifactPath },
      source: 'project_workflow',
      submittedBy: 'xiaok-worker',
      submissionIdempotencyKey: 'submit-agent-final',
    }, makeAgentContext());

    assert.equal(registered.ok, true);
    assert.equal(registered.finalDeliverable.status, 'candidate');
    assert.equal(registered.finalDeliverable.submitted.requestContext.requestSource, 'agent');
    assert.ok(registered.finalDeliverable.serviceComputedHash.startsWith('sha256:'));
    assert.equal(hub.getProject(projectId).status, 'active');
    assert.equal(hub.getProjectLifecycle(projectId).canAutoClose, false);

    const agentApprove = hub.approveFinalDeliverable(projectId, registered.finalDeliverable.deliverableId, {
      approvalIdempotencyKey: 'agent-approve',
      expectedProjectVersion: hub.getProjectLifecycle(projectId).version,
    }, makeAgentContext());
    assert.equal(agentApprove.ok, false);
    assert.equal(agentApprove.error, 'final_deliverable_approve_requires_user');

    const approved = hub.approveFinalDeliverable(projectId, registered.finalDeliverable.deliverableId, {
      approvalIdempotencyKey: 'user-approve',
      expectedProjectVersion: hub.getProjectLifecycle(projectId).version,
    }, makeUserContext());
    assert.equal(approved.ok, true);
    assert.equal(approved.finalDeliverable.status, 'approved');
    assert.equal(approved.reviewGateDecision.autoCloseAllowed, true);
    assert.equal(hub.getProjectLifecycle(projectId).state, 'delivered');
    assert.equal(hub.getProject(projectId).status, 'delivered');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('start policy is downgraded from agent auto-dispatch when service risk is unknown', () => {
  const decision = decideProjectStartPolicy({
    requestedStartPolicy: 'activate_and_dispatch_after_plan',
    requestContext: makeAgentContext(),
    project: { id: 'proj-start', executionMode: 'workflow_preferred' },
    tasks: [{ id: 'item-1', status: 'pending', assignedAgent: 'unknown-worker' }],
    workflowRuns: [],
    callerRiskHints: {
      estimatedCostClass: 'low',
      requiresExternalSideEffect: false,
      hasAmbiguousAgents: false,
    },
  });

  assert.equal(decision.effectiveStartPolicy, 'auto_activate_after_plan');
  assert.equal(decision.downgraded, true);
  assert.equal(decision.serviceComputedRisk.estimatedCostClass, 'unknown');
  assert.equal(decision.downgradeReasons.includes('estimated_cost_unknown'), true);
  assert.deepEqual(decision.callerRiskHints.estimatedCostClass, 'low');
});

test('activateAndStartProject activates and dispatches a low-risk user project after plan', () => {
  const hub = createHub({
    silent: true,
    getAgentProfiles: () => [
      { id: 'xiaok-po', roles: ['project_owner'] },
      { id: 'xiaok-worker', roles: ['worker'], runtimeType: 'xiaok' },
    ],
  });
  const projectId = 'proj-auto-start-user';
  hub.createProject({
    id: projectId,
    name: '自动启动测试',
    goal: '完成一个低风险任务',
    poAgent: 'xiaok-po',
    members: ['xiaok-worker'],
    autoAssignPo: false,
  });
  assert.equal(hub.handleSubmitPlan(projectId, { phases: [{ id: 'p1', title: '执行', items: [] }] }, 'xiaok-po').ok, true);
  assert.equal(hub.handleCreateTasks(projectId, [
    {
      id: 'item-1',
      title: '撰写摘要',
      brief: '生成摘要',
      assignedAgent: 'xiaok-worker',
      requiresExternalSideEffect: false,
      writesUserFactSource: false,
    },
  ], 'xiaok-po').ok, true);

  const started = hub.activateAndStartProject(projectId, {
    startPolicy: 'activate_and_dispatch_after_plan',
    requestContext: makeUserContext(),
    fromAgent: 'xiaok-po',
    idempotencyKey: 'start-user-low-risk',
  });

  assert.equal(started.ok, true);
  assert.equal(started.phase, 'dispatch_started');
  assert.equal(started.startPolicyDecision.effectiveStartPolicy, 'activate_and_dispatch_after_plan');
  assert.deepEqual(started.dispatch.dispatched, [`${projectId}__item-1`]);
  assert.equal(hub.getProject(projectId).status, 'active');
  assert.equal(hub.getBoard(projectId).getTask(`${projectId}__item-1`).status, 'dispatched');
  assert.equal(hub.getEventLog().getEvents().some(event => event.type === 'project.auto_start.dispatch_started'), true);

  const repeated = hub.activateAndStartProject(projectId, {
    startPolicy: 'activate_and_dispatch_after_plan',
    requestContext: makeUserContext(),
    fromAgent: 'xiaok-po',
    idempotencyKey: 'start-user-low-risk',
  });
  assert.equal(repeated.ok, true);
  assert.equal(repeated.idempotent, true);
  assert.equal(hub.getBoard(projectId).getTask(`${projectId}__item-1`).status, 'dispatched');
});

test('activateAndStartProject downgrades risky agent auto-dispatch to activation only', () => {
  const hub = createHub({ silent: true });
  const projectId = 'proj-auto-start-agent-risk';
  hub.createProject({
    id: projectId,
    name: '高风险自动启动测试',
    goal: '未知风险任务',
    poAgent: 'xiaok-po',
    members: ['unknown-worker'],
    autoAssignPo: false,
  });
  assert.equal(hub.handleSubmitPlan(projectId, { phases: [{ id: 'p1', title: '执行', items: [] }] }, 'xiaok-po').ok, true);
  assert.equal(hub.handleCreateTasks(projectId, [
    {
      id: 'item-1',
      title: '调用外部系统',
      brief: '需要进一步确认',
      assignedAgent: 'unknown-worker',
    },
  ], 'xiaok-po').ok, true);

  const started = hub.activateAndStartProject(projectId, {
    startPolicy: 'activate_and_dispatch_after_plan',
    requestContext: makeAgentContext('xiaok-po'),
    fromAgent: 'xiaok-po',
    idempotencyKey: 'start-agent-risk',
    callerRiskHints: {
      estimatedCostClass: 'low',
      requiresExternalSideEffect: false,
    },
  });

  assert.equal(started.ok, true);
  assert.equal(started.phase, 'activated');
  assert.equal(started.startPolicyDecision.effectiveStartPolicy, 'auto_activate_after_plan');
  assert.equal(started.startPolicyDecision.downgraded, true);
  assert.deepEqual(started.dispatch, null);
  assert.equal(hub.getProject(projectId).status, 'active');
  assert.equal(hub.getBoard(projectId).getTask(`${projectId}__item-1`).status, 'pending');
  assert.equal(hub.getEventLog().getEvents().some(event => event.type === 'project.auto_start.policy_downgraded'), true);
});

test('mutation transport maps token to request context and rejects naked HTTP mutation', () => {
  const registry = createMutationTokenRegistry({ now: 1800000000000 });
  const desktop = registry.issue({
    transport: 'desktop_ipc',
    issuedTo: 'desktop-main',
    tokenId: 'desktop-main-token',
  });
  const agent = registry.issue({
    transport: 'agent_tool',
    issuedTo: 'xiaok-worker',
    tokenId: 'agent-tool-token',
  });

  const naked = resolveMutationRequestContext({
    registry,
    token: '',
    claimedRequestSource: 'user',
  });
  assert.equal(naked.ok, false);
  assert.equal(naked.error, 'unauthorized_transport');

  const agentContext = resolveMutationRequestContext({
    registry,
    token: agent.token,
    claimedRequestSource: 'user',
  });
  assert.equal(agentContext.ok, true);
  assert.equal(agentContext.requestContext.requestSource, 'agent');
  assert.equal(agentContext.audit.claimMismatch, true);

  const userContext = resolveMutationRequestContext({
    registry,
    token: desktop.token,
  });
  assert.equal(userContext.ok, true);
  assert.equal(userContext.requestContext.requestSource, 'user');
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
if (process.exitCode !== 1) console.log(`\n${passed}/${tests.length} project workflow state unification tests passed`);
