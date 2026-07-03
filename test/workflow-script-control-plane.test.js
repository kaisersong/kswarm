/**
 * Dynamic workflow script control-plane tests.
 *
 * Script parsing/execution belongs to the desktop runtime. KSwarm only owns the
 * durable proposal/run/node state created from a trusted script preview.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHub } from '../src/core/hub.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function makeTempDir(label = 'workflow-script') {
  return mkdtempSync(join(tmpdir(), `kswarm-${label}-`));
}

function createActiveProject(hub, id = 'proj-script') {
  const project = hub.createProject({
    id,
    name: '动态脚本工作流项目',
    goal: '验证脚本生成的动态 workflow 控制面',
    poAgent: 'xiaok-po',
    members: ['xiaok-worker'],
  });
  const added = hub.handleHumanAddTasks(id, [
    { title: '整理项目现状', assignedAgent: 'xiaok-worker' },
  ]);
  assert.equal(added.ok, true);
  assert.equal(hub.handleApprove(id).ok, true);
  return project;
}

function approveFirstCandidate(hub, projectId, key) {
  const candidate = hub.listFinalDeliverables(projectId)[0];
  assert.ok(candidate, 'expected final deliverable candidate');
  return hub.approveFinalDeliverable(projectId, candidate.deliverableId, {
    approvalIdempotencyKey: key,
    expectedProjectVersion: hub.getProjectLifecycle(projectId).version,
  }, {
    requestSource: 'user',
    actorId: 'desktop-user',
    actorKind: 'desktop_user',
    transport: 'desktop_ipc',
  });
}

function makePreview(projectId = 'proj-script') {
  return {
    ok: true,
    workflowId: 'dynamic_project_diagnosis',
    source: 'script_generated',
    strategy: 'workflow',
    status: 'pending_confirmation',
    projectId,
    scope: { projectId },
    requestedBy: 'human',
    createdAt: 1780000000000,
    title: '动态项目诊断',
    description: '读取项目状态，动态派发诊断任务并汇总结论。',
    meta: {
      name: 'dynamic_project_diagnosis',
      description: '读取项目状态，动态派发诊断任务并汇总结论。',
      phases: [
        { title: '扫描项目状态' },
        { title: '汇总结论' },
      ],
    },
    phases: [
      { id: 'phase-1', title: '扫描项目状态', detail: null },
      { id: 'phase-2', title: '汇总结论', detail: null },
    ],
    scriptHash: 'cc0f4f8b68f0f7f8d0f9a9fd5b1f1c70898f9db0a64bc1413a0cb06a652de62d',
    analysis: {
      agentCallCount: 2,
      phaseCallCount: 2,
      parallelCallCount: 1,
      pipelineCallCount: 0,
      requestUserInputCallCount: 0,
      runtimePhaseTitles: ['扫描项目状态', '汇总结论'],
    },
  };
}

test('script-generated workflow keeps script execution outside KSwarm while persisting dynamic agent nodes', () => {
  const dir = makeTempDir('happy');
  try {
    const hub = createHub({ eventLogDir: join(dir, 'events'), silent: true });
    createActiveProject(hub);

    const proposalResult = hub.createScriptWorkflowProposal('proj-script', makePreview(), {
      requestedBy: 'human',
      now: 1780000000100,
    });
    assert.equal(proposalResult.ok, true);
    assert.equal(proposalResult.workflowProposal.source, 'script_generated');
    assert.equal(proposalResult.workflowProposal.scriptHash, makePreview().scriptHash);
    assert.equal(proposalResult.workflowProposal.approval.status, 'pending');

    const started = hub.startScriptWorkflowRunFromProposal(proposalResult.workflowProposal.id, {
      approvedBy: 'human',
      now: 1780000000200,
    });
    assert.equal(started.ok, true);
    assert.equal(started.workflowRun.source, 'script_generated');
    assert.equal(started.workflowRun.status, 'running');
    assert.equal(started.workflowRun.nodes.length, 1);
    assert.equal(started.workflowRun.nodes[0].id, 'script-runtime');
    assert.equal(started.workflowRun.nodes[0].status, 'running');

    const dispatched = hub.dispatchWorkflowScriptAgentNode(started.workflowRun.id, {
      phaseTitle: '扫描项目状态',
      label: '检查项目任务状态',
      prompt: '请检查项目当前任务、风险和阻塞。',
      assignedAgent: 'xiaok-worker',
      options: { model: 'default' },
      now: 1780000000300,
    });
    assert.equal(dispatched.ok, true);
    assert.equal(dispatched.dispatches.length, 1);
    assert.equal(dispatched.dispatches[0].nodeId, 'script-agent-1');
    assert.equal(dispatched.dispatches[0].targetParticipantId, 'xiaok-worker');
    assert.equal(dispatched.dispatches[0].input.prompt, '请检查项目当前任务、风险和阻塞。');
    assert.equal(dispatched.dispatches[0].input.script.phaseTitle, '扫描项目状态');
    assert.equal(dispatched.dispatches[0].input.workflowRunId, started.workflowRun.id);

    const completedNode = hub.handleWorkflowNodeResult({
      workflowRunId: started.workflowRun.id,
      nodeId: dispatched.dispatches[0].nodeId,
      attempt: dispatched.dispatches[0].attempt,
      handoffId: dispatched.dispatches[0].handoffId,
      fromAgent: 'xiaok-worker',
      output: { summary: '项目任务可继续推进。' },
      now: 1780000000400,
    });
    assert.equal(completedNode.ok, true);
    assert.equal(completedNode.workflowRun.status, 'running');
    assert.equal(completedNode.workflowRun.nodes.find(node => node.id === 'script-agent-1').status, 'completed');
    assert.equal(completedNode.workflowRun.nodes.find(node => node.id === 'script-runtime').status, 'running');

    const finished = hub.completeScriptWorkflowRun(started.workflowRun.id, {
      result: { summary: '动态项目诊断完成。' },
      now: 1780000000500,
    });
    assert.equal(finished.ok, true);
    assert.equal(finished.workflowRun.status, 'completed');
    assert.deepEqual(finished.workflowRun.scriptResult, { summary: '动态项目诊断完成。' });
    assert.equal(finished.workflowRun.summary.total, 2);
    assert.equal(finished.workflowRun.summary.completed, 2);

    const restored = hub.getWorkflowRun(started.workflowRun.id);
    assert.equal(restored.status, 'completed');
    assert.equal(restored.nodes.some(node => node.id === 'script-agent-1' && node.kind === 'agent_task'), true);

    const events = hub.getEventLog().getEvents();
    assert.equal(events.some(event => event.type === 'workflow.script.node.created'), true);
    assert.equal(events.some(event => event.type === 'workflow.run.completed'), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('script-generated project workflow delivers project state from artifact evidence', () => {
  const dir = makeTempDir('project-delivery');
  try {
    const hub = createHub({ eventLogDir: join(dir, 'events'), silent: true });
    const project = createActiveProject(hub, 'proj-script-delivery');
    project.workFolder = dir;
    const artifactPath = join(dir, 'artifacts', 'verification-report.md');
    mkdirSync(join(dir, 'artifacts'), { recursive: true });
    writeFileSync(artifactPath, '# 动态工作流验证报告\n\n5 点检查结论全部通过。\n');

    const proposal = hub.createScriptWorkflowProposal('proj-script-delivery', makePreview('proj-script-delivery'), {
      requestedBy: 'human',
      now: 1780000010000,
    });
    const started = hub.startScriptWorkflowRunFromProposal(proposal.workflowProposal.id, {
      approvedBy: 'human',
      now: 1780000010100,
    });
    const finished = hub.completeScriptWorkflowRun(started.workflowRun.id, {
      result: {
        summary: '动态 workflow 已生成验证报告。',
        evidenceRefs: ['artifacts/verification-report.md: 完整 markdown 交付物'],
      },
      now: 1780000010200,
    });

    assert.equal(finished.ok, true);
    assert.equal(finished.workflowRun.status, 'completed');
    assert.equal(finished.workflowRun.gateDecision.status, 'passed');
    assert.equal(finished.workflowRun.projectDelivery.status, 'candidate');

    const deliveredProject = hub.getProject('proj-script-delivery');
    assert.equal(deliveredProject.status, 'active');
    assert.equal(hub.getProjectLifecycle('proj-script-delivery').state, 'ready_to_deliver');
    const candidate = hub.listFinalDeliverables('proj-script-delivery')[0];
    assert.equal(candidate.status, 'candidate');
    assert.equal(candidate.source, 'script_workflow');
    assert.equal(candidate.workflowRunId, started.workflowRun.id);

    const tasks = hub.getBoard('proj-script-delivery').getAllTasks();
    assert.deepEqual(tasks.map(task => task.status), ['done']);
    assert.equal(tasks[0].result.artifacts[0].path, 'artifacts/verification-report.md');
    assert.equal(tasks[0].result.provenance.runtimeSource, 'kswarm-script-workflow');
    assert.equal(tasks[0].completedBy, 'script_workflow');

    const approved = approveFirstCandidate(hub, 'proj-script-delivery', 'approve-script-delivery');
    assert.equal(approved.ok, true);
    assert.equal(hub.getProject('proj-script-delivery').status, 'delivered');
    assert.equal(hub.getProject('proj-script-delivery').deliverable.provenance.finalDeliverableId, candidate.deliverableId);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('script-generated project workflow can deliver from the final agent node when runtime result has no artifacts', () => {
  const dir = makeTempDir('project-delivery-agent-node');
  try {
    const hub = createHub({ eventLogDir: join(dir, 'events'), silent: true });
    const project = createActiveProject(hub, 'proj-script-agent-delivery');
    project.workFolder = dir;
    const artifactPath = join(dir, 'artifacts', 'agent-final-report.html');
    mkdirSync(join(dir, 'artifacts'), { recursive: true });
    writeFileSync(artifactPath, '<!doctype html><title>Agent final report</title>');

    const proposal = hub.createScriptWorkflowProposal('proj-script-agent-delivery', makePreview('proj-script-agent-delivery'), {
      requestedBy: 'human',
      now: 1780000011000,
    });
    const started = hub.startScriptWorkflowRunFromProposal(proposal.workflowProposal.id, {
      approvedBy: 'human',
      now: 1780000011100,
    });
    const dispatched = hub.dispatchWorkflowScriptAgentNode(started.workflowRun.id, {
      phaseTitle: '生成报告',
      label: '生成 HTML 报告',
      prompt: '生成最终 HTML 报告。',
      assignedAgent: 'xiaok-worker',
      now: 1780000011200,
    });
    assert.equal(dispatched.ok, true);
    const completedNode = hub.handleWorkflowNodeResult({
      workflowRunId: started.workflowRun.id,
      nodeId: dispatched.nodeId,
      attempt: dispatched.dispatches[0].attempt,
      handoffId: dispatched.dispatches[0].handoffId,
      fromAgent: 'xiaok-worker',
      output: {
        summary: 'HTML 报告已生成。',
        artifacts: [{ path: 'artifacts/agent-final-report.html', kind: 'html', label: 'agent-final-report.html' }],
        evidenceRefs: ['artifact:artifacts/agent-final-report.html'],
      },
      now: 1780000011300,
    });
    assert.equal(completedNode.ok, true);

    const finished = hub.completeScriptWorkflowRun(started.workflowRun.id, {
      result: { summary: '脚本编排完成。' },
      now: 1780000011400,
    });

    assert.equal(finished.ok, true);
    assert.equal(finished.workflowRun.status, 'completed');
    assert.equal(finished.workflowRun.projectDelivery.status, 'candidate');

    const deliveredProject = hub.getProject('proj-script-agent-delivery');
    assert.equal(deliveredProject.status, 'active');
    const candidate = hub.listFinalDeliverables('proj-script-agent-delivery')[0];
    assert.equal(candidate.status, 'candidate');
    assert.equal(candidate.workflowNodeId, dispatched.nodeId);

    const tasks = hub.getBoard('proj-script-agent-delivery').getAllTasks();
    assert.deepEqual(tasks.map(task => task.status), ['done']);
    assert.equal(tasks[0].result.artifacts[0].path, 'artifacts/agent-final-report.html');

    const approved = approveFirstCandidate(hub, 'proj-script-agent-delivery', 'approve-script-agent-delivery');
    assert.equal(approved.ok, true);
    assert.equal(hub.getProject('proj-script-agent-delivery').status, 'delivered');
    assert.equal(hub.getProject('proj-script-agent-delivery').deliverable.provenance.producerNodeId, dispatched.nodeId);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('script-generated project workflow blocks delivery when final task requires html but agent only produced markdown', () => {
  const dir = makeTempDir('project-delivery-required-output');
  try {
    const hub = createHub({ eventLogDir: join(dir, 'events'), silent: true });
    const projectId = 'proj-script-required-output';
    const project = hub.createProject({
      id: projectId,
      name: 'HTML 报告工作流项目',
      goal: '验证动态 workflow 必须交付最终 HTML 报告',
      poAgent: 'xiaok-po',
      members: ['xiaok-worker'],
    });
    project.workFolder = dir;
    const added = hub.handleHumanAddTasks(projectId, [
      {
        id: 'final-report',
        title: '生成 HTML 报告',
        assignedAgent: 'xiaok-worker',
        requiredOutputs: [{ type: 'report_html', enforcement: 'hard' }],
      },
    ]);
    assert.equal(added.ok, true);
    assert.equal(hub.handleApprove(projectId).ok, true);

    const artifactPath = join(dir, 'artifacts', 'agent-final-report.md');
    mkdirSync(join(dir, 'artifacts'), { recursive: true });
    writeFileSync(artifactPath, '# Agent final report\n\nOnly markdown was produced.\n');

    const proposal = hub.createScriptWorkflowProposal(projectId, makePreview(projectId), {
      requestedBy: 'human',
      now: 1780000012000,
    });
    const started = hub.startScriptWorkflowRunFromProposal(proposal.workflowProposal.id, {
      approvedBy: 'human',
      now: 1780000012100,
    });
    const dispatched = hub.dispatchWorkflowScriptAgentNode(started.workflowRun.id, {
      phaseTitle: '生成报告',
      label: '生成 HTML 报告',
      prompt: '生成最终 HTML 报告。',
      assignedAgent: 'xiaok-worker',
      now: 1780000012200,
    });
    assert.equal(dispatched.ok, true);
    assert.equal(hub.handleWorkflowNodeResult({
      workflowRunId: started.workflowRun.id,
      nodeId: dispatched.nodeId,
      attempt: dispatched.dispatches[0].attempt,
      handoffId: dispatched.dispatches[0].handoffId,
      fromAgent: 'xiaok-worker',
      output: {
        summary: '只生成了 markdown 报告。',
        artifacts: [{ path: 'artifacts/agent-final-report.md', kind: 'markdown', label: 'agent-final-report.md' }],
        evidenceRefs: ['artifact:artifacts/agent-final-report.md'],
      },
      now: 1780000012300,
    }).ok, true);

    const finished = hub.completeScriptWorkflowRun(started.workflowRun.id, {
      result: { summary: '脚本编排完成。' },
      now: 1780000012400,
    });

    assert.equal(finished.ok, true);
    assert.equal(finished.workflowRun.status, 'blocked');
    assert.equal(finished.workflowRun.projectDelivery.status, 'failed');
    assert.equal(finished.workflowRun.projectDelivery.error, 'worker_required_output_missing');
    assert.deepEqual(finished.workflowRun.projectDelivery.missing, ['report_html']);

    const blockedProject = hub.getProject(projectId);
    assert.equal(blockedProject.status, 'active');
    assert.equal(blockedProject.deliverable, null);
    assert.deepEqual(hub.getBoard(projectId).getAllTasks().map(task => task.status), ['pending']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('blocked script-generated project workflow can redeliver after runtime supplies required html artifact', () => {
  const dir = makeTempDir('project-delivery-redeliver');
  try {
    const hub = createHub({ eventLogDir: join(dir, 'events'), silent: true });
    const projectId = 'proj-script-redeliver';
    const project = hub.createProject({
      id: projectId,
      name: 'HTML 报告工作流项目',
      goal: '验证动态 workflow 补齐 HTML 报告后可以重新交付',
      poAgent: 'xiaok-po',
      members: ['xiaok-worker'],
    });
    project.workFolder = dir;
    const added = hub.handleHumanAddTasks(projectId, [
      {
        id: 'final-report',
        title: '生成 HTML 报告',
        assignedAgent: 'xiaok-worker',
        requiredOutputs: [{ type: 'report_html', enforcement: 'hard' }],
      },
    ]);
    assert.equal(added.ok, true);
    assert.equal(hub.handleApprove(projectId).ok, true);

    mkdirSync(join(dir, 'artifacts'), { recursive: true });
    writeFileSync(join(dir, 'artifacts', 'agent-final-report.md'), '# Agent final report\n\nOnly markdown was produced.\n');
    writeFileSync(join(dir, 'artifacts', 'agent-final-report.html'), '<!DOCTYPE html><html><body>Final HTML report</body></html>\n');

    const proposal = hub.createScriptWorkflowProposal(projectId, makePreview(projectId), {
      requestedBy: 'human',
      now: 1780000013000,
    });
    const started = hub.startScriptWorkflowRunFromProposal(proposal.workflowProposal.id, {
      approvedBy: 'human',
      now: 1780000013100,
    });
    const dispatched = hub.dispatchWorkflowScriptAgentNode(started.workflowRun.id, {
      phaseTitle: '生成报告',
      label: '生成 HTML 报告',
      prompt: '生成最终 HTML 报告。',
      assignedAgent: 'xiaok-worker',
      now: 1780000013200,
    });
    assert.equal(dispatched.ok, true);
    assert.equal(hub.handleWorkflowNodeResult({
      workflowRunId: started.workflowRun.id,
      nodeId: dispatched.nodeId,
      attempt: dispatched.dispatches[0].attempt,
      handoffId: dispatched.dispatches[0].handoffId,
      fromAgent: 'xiaok-worker',
      output: {
        summary: '只生成了 markdown 报告。',
        artifacts: [{ path: 'artifacts/agent-final-report.md', kind: 'markdown', label: 'agent-final-report.md' }],
        evidenceRefs: ['artifact:artifacts/agent-final-report.md'],
      },
      now: 1780000013300,
    }).ok, true);

    const blocked = hub.completeScriptWorkflowRun(started.workflowRun.id, {
      result: { summary: '脚本编排完成。' },
      now: 1780000013400,
    });
    assert.equal(blocked.ok, true);
    assert.equal(blocked.workflowRun.status, 'blocked');
    assert.equal(blocked.workflowRun.projectDelivery.error, 'worker_required_output_missing');

    const delivered = hub.completeScriptWorkflowRun(started.workflowRun.id, {
      result: {
        summary: '已补齐最终 HTML 报告。',
        artifacts: [{ path: 'artifacts/agent-final-report.html', kind: 'report_html', label: 'agent-final-report.html' }],
        evidenceRefs: ['artifact:artifacts/agent-final-report.html'],
        workFolder: dir,
      },
      terminal: { status: 'passed', reason: 'required report_html artifact supplied' },
      now: 1780000013500,
    });

    assert.equal(delivered.ok, true);
    assert.equal(delivered.workflowRun.status, 'completed');
    assert.equal(delivered.workflowRun.projectDelivery.status, 'candidate');
    assert.equal(hub.getProject(projectId).status, 'active');
    assert.equal(hub.listFinalDeliverables(projectId)[0].status, 'candidate');
    assert.deepEqual(hub.getBoard(projectId).getAllTasks().map(task => task.status), ['done']);
    const approved = approveFirstCandidate(hub, projectId, 'approve-required-output');
    assert.equal(approved.ok, true);
    assert.equal(hub.getProject(projectId).status, 'delivered');
    assert.equal(hub.getProject(projectId).deliverable.artifacts[0].relativePath, 'artifacts/agent-final-report.html');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('restores historical completed script workflow deliveries on hub startup', async () => {
  const dir = makeTempDir('project-delivery-recovery');
  try {
    const sourceHub = createHub({ eventLogDir: join(dir, 'source-events'), silent: true });
    const project = createActiveProject(sourceHub, 'proj-script-recovered');
    project.workFolder = dir;
    const artifactPath = join(dir, 'artifacts', 'verification-report.md');
    mkdirSync(join(dir, 'artifacts'), { recursive: true });
    writeFileSync(artifactPath, '# 历史动态工作流验证报告\n\n恢复时应同步为项目交付物。\n');

    const proposal = sourceHub.createScriptWorkflowProposal('proj-script-recovered', makePreview('proj-script-recovered'), {
      requestedBy: 'human',
      now: 1780000020000,
    });
    const started = sourceHub.startScriptWorkflowRunFromProposal(proposal.workflowProposal.id, {
      approvedBy: 'human',
      now: 1780000020100,
    });
    const finished = sourceHub.completeScriptWorkflowRun(started.workflowRun.id, {
      result: {
        summary: '历史 dynamic workflow 已生成报告。',
        evidenceRefs: ['artifact:artifacts/verification-report.md'],
      },
      now: 1780000020200,
    });
    assert.equal(finished.ok, true);

    const staleProject = JSON.parse(JSON.stringify(sourceHub.getProject('proj-script-recovered')));
    staleProject.status = 'planning';
    staleProject.deliverable = null;
    delete staleProject.deliveredAt;

    const staleTasks = sourceHub.getBoard('proj-script-recovered').getAllTasks().map(task => ({
      ...JSON.parse(JSON.stringify(task)),
      status: 'pending',
      result: null,
      completedAt: null,
      completedBy: null,
      completedByWorkflowRunId: null,
    }));
    const staleRun = JSON.parse(JSON.stringify(sourceHub.getWorkflowRun(started.workflowRun.id)));
    delete staleRun.projectDelivery;

    const dataDir = join(dir, 'state.json');
    writeFileSync(dataDir, JSON.stringify({
      projects: [staleProject],
      boards: [{ projectId: 'proj-script-recovered', tasks: staleTasks }],
      workflowRuns: [staleRun],
      workflowProposals: [],
      humanActions: [],
    }, null, 2));

    const restoredHub = createHub({ eventLogDir: join(dir, 'restored-events'), dataDir, silent: true });
    const restoredProject = restoredHub.getProject('proj-script-recovered');
    assert.equal(restoredProject.status, 'planning');
    assert.equal(restoredProject.deliverable, null);
    assert.equal(restoredHub.getWorkflowRun(started.workflowRun.id).projectDelivery.status, 'candidate');
    assert.equal(restoredHub.getProjectLifecycle('proj-script-recovered').state, 'legacy_needs_reconciliation');
    assert.equal(restoredHub.listFinalDeliverables('proj-script-recovered')[0].status, 'candidate');
    assert.deepEqual(restoredHub.getBoard('proj-script-recovered').getAllTasks().map(task => task.status), ['done']);
    await new Promise(resolve => setTimeout(resolve, 650));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('script-generated workflow cannot be completed while dynamic agent nodes are still running', () => {
  const dir = makeTempDir('incomplete');
  try {
    const hub = createHub({ eventLogDir: join(dir, 'events'), silent: true });
    createActiveProject(hub);

    const proposal = hub.createScriptWorkflowProposal('proj-script', makePreview(), { now: 1780000001000 });
    const started = hub.startScriptWorkflowRunFromProposal(proposal.workflowProposal.id, { now: 1780000001100 });
    const dispatched = hub.dispatchWorkflowScriptAgentNode(started.workflowRun.id, {
      phaseTitle: '扫描项目状态',
      label: '检查项目任务状态',
      prompt: '请检查项目当前任务、风险和阻塞。',
      assignedAgent: 'xiaok-worker',
      now: 1780000001200,
    });
    assert.equal(dispatched.ok, true);

    const finished = hub.completeScriptWorkflowRun(started.workflowRun.id, {
      result: { summary: '不应该完成。' },
      now: 1780000001300,
    });
    assert.equal(finished.ok, false);
    assert.equal(finished.error, 'workflow_script_nodes_incomplete');
    assert.equal(hub.getWorkflowRun(started.workflowRun.id).status, 'running');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('script-generated workflow can retry a blocked dynamic agent node in the same durable run', () => {
  const dir = makeTempDir('retry-blocked-node');
  try {
    const hub = createHub({ eventLogDir: join(dir, 'events'), silent: true });
    createActiveProject(hub);

    const proposal = hub.createScriptWorkflowProposal('proj-script', makePreview(), { now: 1780000002000 });
    const started = hub.startScriptWorkflowRunFromProposal(proposal.workflowProposal.id, { now: 1780000002100 });
    const group = hub.beginWorkflowScriptParallelGroup(started.workflowRun.id, {
      phaseTitle: '扫描项目状态',
      label: '两路扫描',
      primitiveId: 'parallel-1',
      kind: 'parallel',
      totalCount: 1,
      limit: 1,
      failurePolicy: 'required_all',
      now: 1780000002200,
    });
    assert.equal(group.ok, true);
    const dispatched = hub.dispatchWorkflowScriptAgentNode(started.workflowRun.id, {
      phaseTitle: '扫描项目状态',
      label: '检查项目任务状态',
      prompt: '请检查项目当前任务、风险和阻塞。',
      assignedAgent: 'xiaok-worker',
      parallelGroupId: group.parallelGroup.id,
      fanoutItemKey: 'branch-1',
      fanoutItemLabel: '检查项目任务状态',
      now: 1780000002300,
    });
    assert.equal(dispatched.ok, true);
    const blocked = hub.handleWorkflowRuntimeUnavailable({
      workflowRunId: started.workflowRun.id,
      nodeId: dispatched.nodeId,
      attempt: dispatched.dispatches[0].attempt,
      handoffId: dispatched.dispatches[0].handoffId,
      reason: 'structured_json_missing',
      now: 1780000002400,
    });
    assert.equal(blocked.ok, true);
    assert.equal(blocked.workflowRun.status, 'blocked');
    assert.equal(blocked.workflowRun.parallelGroups[0].status, 'failed');

    const retried = hub.retryWorkflowScriptAgentNode(started.workflowRun.id, {
      nodeId: dispatched.nodeId,
      now: 1780000002500,
    });

    assert.equal(retried.ok, true);
    assert.equal(retried.dispatches.length, 1);
    assert.equal(retried.dispatches[0].nodeId, dispatched.nodeId);
    assert.equal(retried.dispatches[0].attempt, 2);
    assert.equal(retried.workflowRun.status, 'running');
    const retriedNode = retried.workflowRun.nodes.find(node => node.id === dispatched.nodeId);
    assert.equal(retriedNode.status, 'running');
    assert.equal(retriedNode.error, null);
    assert.equal(retried.workflowRun.parallelGroups[0].status, 'waiting_for_children');
    assert.equal(retried.workflowRun.scriptCheckpoints.find(item => item.primitiveId === dispatched.nodeId).status, 'waiting');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('script-generated workflow terminal block keeps run blocked instead of delivered', () => {
  const dir = makeTempDir('terminal-block');
  try {
    const hub = createHub({ eventLogDir: join(dir, 'events'), silent: true });
    createActiveProject(hub, 'proj-script-block');

    const proposal = hub.createScriptWorkflowProposal('proj-script-block', makePreview('proj-script-block'), {
      requestedBy: 'human',
      now: 1780000030000,
    });
    const started = hub.startScriptWorkflowRunFromProposal(proposal.workflowProposal.id, {
      approvedBy: 'human',
      now: 1780000030100,
    });
    const finished = hub.completeScriptWorkflowRun(started.workflowRun.id, {
      result: {
        status: 'blocked',
        reason: '缺少 HTML 交付物',
        evidenceRefs: ['artifacts/report.md'],
      },
      terminal: {
        status: 'blocked',
        reason: '缺少 HTML 交付物',
        evidenceRefs: ['artifacts/report.md'],
      },
      now: 1780000030200,
    });

    assert.equal(finished.ok, true);
    assert.equal(finished.workflowRun.status, 'blocked');
    assert.equal(finished.workflowRun.gateDecision.status, 'blocked');
    assert.equal(finished.workflowRun.gateDecision.reason, '缺少 HTML 交付物');
    assert.deepEqual(finished.workflowRun.gateDecision.evidenceRefs, ['artifacts/report.md']);
    assert.equal(hub.getProject('proj-script-block').status, 'active');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
if (process.exitCode !== 1) console.log(`\n${passed}/${tests.length} workflow script control-plane tests passed`);
