import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHub } from '../src/core/hub.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function makeTempDir(label = 'workflow-parallel-group') {
  return mkdtempSync(join(tmpdir(), `kswarm-${label}-`));
}

function createActiveProject(hub, id = 'proj-parallel') {
  const project = hub.createProject({
    id,
    name: '并行动动态工作流项目',
    goal: '验证 dynamic workflow parallel group durable state',
    poAgent: 'xiaok-po',
    members: ['xiaok-worker'],
  });
  const added = hub.handleHumanAddTasks(id, [
    { title: '复核交付物', assignedAgent: 'xiaok-worker' },
  ]);
  assert.equal(added.ok, true);
  assert.equal(hub.handleApprove(id).ok, true);
  return project;
}

function makePreview(projectId = 'proj-parallel') {
  return {
    ok: true,
    workflowId: 'parallel_report_review',
    source: 'script_generated',
    strategy: 'workflow',
    status: 'pending_confirmation',
    projectId,
    scope: { projectId },
    requestedBy: 'human',
    createdAt: 1781000000000,
    title: '并行报告复核',
    description: '并行复核报告事实、证据和格式。',
    meta: {
      name: 'parallel_report_review',
      description: '并行复核报告事实、证据和格式。',
      phases: [{ title: '并行复核' }, { title: '归约结论' }],
    },
    phases: [
      { id: 'phase-1', title: '并行复核', detail: null },
      { id: 'phase-2', title: '归约结论', detail: null },
    ],
    scriptHash: 'parallel-script-hash',
    analysis: {
      agentCallCount: 3,
      phaseCallCount: 2,
      parallelCallCount: 1,
      pipelineCallCount: 0,
      requestUserInputCallCount: 0,
      runtimePhaseTitles: ['并行复核', '归约结论'],
    },
  };
}

function startScriptWorkflow(hub, projectId = 'proj-parallel') {
  createActiveProject(hub, projectId);
  const proposal = hub.createScriptWorkflowProposal(projectId, makePreview(projectId), {
    requestedBy: 'human',
    now: 1781000000100,
  });
  assert.equal(proposal.ok, true);
  const started = hub.startScriptWorkflowRunFromProposal(proposal.workflowProposal.id, {
    approvedBy: 'human',
    now: 1781000000200,
  });
  assert.equal(started.ok, true);
  return started.workflowRun;
}

test('script parallel group is durable and tracks branch node counters', () => {
  const dir = makeTempDir('durable');
  try {
    const hub = createHub({ eventLogDir: join(dir, 'events'), silent: true });
    const workflowRun = startScriptWorkflow(hub);

    const groupResult = hub.beginWorkflowScriptParallelGroup(workflowRun.id, {
      phaseTitle: '并行复核',
      label: '三路交叉复核',
      primitiveId: 'parallel-1',
      kind: 'parallel',
      totalCount: 2,
      limit: 2,
      failurePolicy: 'required_all',
      now: 1781000000300,
    });
    assert.equal(groupResult.ok, true);
    assert.equal(groupResult.parallelGroup.id, 'script-parallel-1');
    assert.equal(groupResult.parallelGroup.status, 'running');
    assert.equal(groupResult.workflowRun.parallelGroups.length, 1);
    assert.equal(groupResult.workflowRun.parallelGroups[0].completedCount, 0);
    assert.equal(groupResult.workflowRun.scriptCheckpoints.length, 1);
    assert.deepEqual(groupResult.workflowRun.scriptCheckpoints[0], {
      id: 'script-checkpoint-1',
      workflowRunId: workflowRun.id,
      scriptHash: 'parallel-script-hash',
      primitiveType: 'parallel',
      primitiveId: 'parallel-1',
      phaseId: groupResult.parallelGroup.phaseId,
      parallelGroupId: groupResult.parallelGroup.id,
      status: 'waiting',
      inputHash: groupResult.workflowRun.scriptCheckpoints[0].inputHash,
      outputRefs: [],
      createdAt: 1781000000300,
      updatedAt: 1781000000300,
    });

    const factBranch = hub.dispatchWorkflowScriptAgentNode(workflowRun.id, {
      phaseTitle: '并行复核',
      label: '事实复核',
      prompt: '从事实准确性角度复核报告。',
      assignedAgent: 'xiaok-worker',
      parallelGroupId: groupResult.parallelGroup.id,
      fanoutItemKey: 'fact-check',
      fanoutItemLabel: '事实复核',
      required: true,
      options: { schema: { type: 'object', required: ['summary'] } },
      now: 1781000000400,
    });
    assert.equal(factBranch.ok, true);

    const evidenceBranch = hub.dispatchWorkflowScriptAgentNode(workflowRun.id, {
      phaseTitle: '并行复核',
      label: '证据复核',
      prompt: '从证据充分性角度复核报告。',
      assignedAgent: 'xiaok-worker',
      parallelGroupId: groupResult.parallelGroup.id,
      fanoutItemKey: 'evidence-check',
      fanoutItemLabel: '证据复核',
      required: true,
      now: 1781000000500,
    });
    assert.equal(evidenceBranch.ok, true);
    assert.equal(evidenceBranch.workflowRun.scriptCheckpoints.length, 3);
    assert.equal(evidenceBranch.workflowRun.scriptCheckpoints[2].primitiveType, 'agent');
    assert.equal(evidenceBranch.workflowRun.scriptCheckpoints[2].parallelGroupId, groupResult.parallelGroup.id);

    const branchNode = evidenceBranch.workflowRun.nodes.find(node => node.id === evidenceBranch.dispatches[0].nodeId);
    assert.equal(branchNode.parallelGroupId, groupResult.parallelGroup.id);
    assert.equal(branchNode.fanoutItemKey, 'evidence-check');
    assert.equal(branchNode.fanoutItemLabel, '证据复核');
    assert.deepEqual(branchNode.outputSchema, null);
    assert.equal(branchNode.required, true);

    const firstDone = hub.handleWorkflowNodeResult({
      workflowRunId: workflowRun.id,
      nodeId: factBranch.dispatches[0].nodeId,
      attempt: factBranch.dispatches[0].attempt,
      handoffId: factBranch.dispatches[0].handoffId,
      fromAgent: 'xiaok-worker',
      output: { summary: '事实复核通过。' },
      now: 1781000000600,
    });
    assert.equal(firstDone.ok, true);
    assert.equal(firstDone.workflowRun.parallelGroups[0].status, 'waiting_for_children');
    assert.equal(firstDone.workflowRun.parallelGroups[0].completedCount, 1);
    assert.equal(firstDone.workflowRun.parallelGroups[0].failedCount, 0);
    assert.equal(firstDone.workflowRun.summary.parallelGroups.completed, 0);
    assert.equal(firstDone.workflowRun.summary.parallelGroups.running, 1);

    const secondDone = hub.handleWorkflowNodeResult({
      workflowRunId: workflowRun.id,
      nodeId: evidenceBranch.dispatches[0].nodeId,
      attempt: evidenceBranch.dispatches[0].attempt,
      handoffId: evidenceBranch.dispatches[0].handoffId,
      fromAgent: 'xiaok-worker',
      output: { summary: '证据复核通过。' },
      now: 1781000000700,
    });
    assert.equal(secondDone.ok, true);
    assert.equal(secondDone.workflowRun.parallelGroups[0].status, 'completed');
    assert.equal(secondDone.workflowRun.parallelGroups[0].completedCount, 2);
    assert.equal(secondDone.workflowRun.scriptCheckpoints[0].status, 'completed');
    assert.equal(secondDone.workflowRun.summary.checkpoints.completed, 3);
    assert.equal(secondDone.workflowRun.summary.parallelGroups.completed, 1);

    const restored = hub.getWorkflowRun(workflowRun.id);
    assert.equal(restored.parallelGroups[0].status, 'completed');
    assert.equal(restored.nodes.filter(node => node.parallelGroupId === groupResult.parallelGroup.id).length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('script parallel group with quorum completes after enough required branches pass', () => {
  const dir = makeTempDir('quorum');
  try {
    const hub = createHub({ eventLogDir: join(dir, 'events'), silent: true });
    const workflowRun = startScriptWorkflow(hub, 'proj-quorum');

    const groupResult = hub.beginWorkflowScriptParallelGroup(workflowRun.id, {
      phaseTitle: '并行复核',
      label: '三路法定复核',
      primitiveId: 'parallel-1',
      kind: 'parallel',
      totalCount: 3,
      limit: 3,
      failurePolicy: 'quorum',
      quorum: 2,
      now: 1781000010300,
    });
    assert.equal(groupResult.ok, true);

    const branches = ['事实复核', '证据复核', '格式复核'].map((label, index) => {
      const result = hub.dispatchWorkflowScriptAgentNode(workflowRun.id, {
        phaseTitle: '并行复核',
        label,
        prompt: `${label}。`,
        assignedAgent: 'xiaok-worker',
        parallelGroupId: groupResult.parallelGroup.id,
        fanoutItemKey: `branch-${index + 1}`,
        fanoutItemLabel: label,
        required: true,
        now: 1781000010400 + index,
      });
      assert.equal(result.ok, true);
      return result.dispatches[0];
    });

    for (const dispatch of branches.slice(0, 2)) {
      const done = hub.handleWorkflowNodeResult({
        workflowRunId: workflowRun.id,
        nodeId: dispatch.nodeId,
        attempt: dispatch.attempt,
        handoffId: dispatch.handoffId,
        fromAgent: 'xiaok-worker',
        output: { summary: `${dispatch.nodeTitle}通过。` },
        now: 1781000010600,
      });
      assert.equal(done.ok, true);
    }

    const blocked = hub.handleWorkflowRuntimeUnavailable({
      workflowRunId: workflowRun.id,
      nodeId: branches[2].nodeId,
      attempt: branches[2].attempt,
      handoffId: branches[2].handoffId,
      reason: 'branch_failed',
      now: 1781000010700,
    });
    assert.equal(blocked.ok, true);
    assert.equal(blocked.workflowRun.parallelGroups[0].status, 'completed');
    assert.equal(blocked.workflowRun.parallelGroups[0].completedCount, 2);
    assert.equal(blocked.workflowRun.parallelGroups[0].requiredFailedCount, 1);
    assert.equal(blocked.workflowRun.summary.parallelGroups.completed, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    console.error(error);
    process.exitCode = 1;
  }
}

if (!process.exitCode) {
  console.log(`\n${tests.length}/${tests.length} workflow parallel group tests passed`);
}
