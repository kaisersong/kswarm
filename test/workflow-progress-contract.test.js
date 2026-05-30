/**
 * KSwarm — workflow progress batch contract tests
 *
 * Run: node test/workflow-progress-contract.test.js
 */

import assert from 'node:assert/strict';
import {
  applyWorkflowProgressBatch,
  validateWorkflowProgressBatch,
} from '../src/core/workflow-progress.js';
import { createHub } from '../src/core/hub.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function batch(overrides = {}) {
  return {
    kind: 'workflow.progress_batch',
    workflowRunId: 'wf-1',
    projectId: 'proj-1',
    taskId: 'task-1',
    fromParticipantId: 'xiaok-worker',
    sequence: 1,
    emittedAt: 1770000000000,
    events: [
      { type: 'workflow.agent.heartbeat', nodeId: 'node-1', at: 1770000000000 },
      { type: 'workflow.node.progress', nodeId: 'node-1', message: '收集项目状态', at: 1770000000000 },
    ],
    ...overrides,
  };
}

function createStartedWorkflowRun(hub) {
  const project = hub.createProject({
    id: 'proj-1',
    name: '进度协议项目',
    goal: '验证 workflow progress batch',
    poAgent: 'xiaok-po',
    members: ['xiaok-worker'],
  });
  const added = hub.handleHumanAddTasks(project.id, [
    { title: '输出诊断材料', assignedAgent: 'xiaok-worker' },
  ]);
  assert.equal(added.ok, true);
  const approved = hub.handleApprove(project.id);
  assert.equal(approved.ok, true);
  const proposal = hub.createWorkflowProposal(project.id, 'agent-review-smoke', { now: 1770000000000 });
  assert.equal(proposal.ok, true);
  const started = hub.startWorkflowRunFromProposal(proposal.workflowProposal.id, {
    projectId: project.id,
    workflowId: 'agent-review-smoke',
    approvedBy: 'human',
    now: 1770000001000,
  });
  assert.equal(started.ok, true);
  return started.workflowRun;
}

test('validates required identity fields for workflow progress batches', () => {
  const valid = validateWorkflowProgressBatch(batch());
  assert.equal(valid.ok, true);

  for (const field of ['workflowRunId', 'projectId', 'fromParticipantId', 'sequence', 'events']) {
    const invalidBatch = batch();
    delete invalidBatch[field];
    const result = validateWorkflowProgressBatch(invalidBatch);
    assert.equal(result.ok, false, field);
    assert.equal(result.error, `workflow_progress_${field}_required`);
  }
});

test('rejects malformed events and missing node identity for material progress', () => {
  const missingNode = validateWorkflowProgressBatch(batch({
    events: [{ type: 'workflow.node.progress', message: 'missing node' }],
  }));
  assert.equal(missingNode.ok, false);
  assert.equal(missingNode.error, 'workflow_progress_event_node_id_required');

  const badType = validateWorkflowProgressBatch(batch({
    events: [{ type: 'unknown.event', nodeId: 'node-1' }],
  }));
  assert.equal(badType.ok, false);
  assert.equal(badType.error, 'workflow_progress_event_type_invalid');
});

test('applies progress batches idempotently and rejects older sequence numbers', () => {
  let snapshot = {
    workflowRunId: 'wf-1',
    nodes: [{ id: 'node-1', output: { summary: 'preserved' }, runtime: {} }],
    progressState: null,
  };

  const first = applyWorkflowProgressBatch(snapshot, batch({ sequence: 2 }));
  assert.equal(first.ok, true);
  assert.equal(first.snapshot.progressState.lastSequenceByParticipant['xiaok-worker'], 2);
  assert.equal(first.snapshot.nodes[0].runtime.lastProgressAt, 1770000000000);
  assert.equal(first.snapshot.nodes[0].output.summary, 'preserved');

  const duplicate = applyWorkflowProgressBatch(first.snapshot, batch({ sequence: 2 }));
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.duplicate, true);
  assert.deepEqual(duplicate.snapshot, first.snapshot);

  const older = applyWorkflowProgressBatch(first.snapshot, batch({ sequence: 1 }));
  assert.equal(older.ok, false);
  assert.equal(older.error, 'workflow_progress_sequence_stale');
});

test('heartbeat events update stale tracking but never change node result', () => {
  const snapshot = {
    workflowRunId: 'wf-1',
    nodes: [{ id: 'node-1', status: 'running', output: { summary: 'already written' }, runtime: { lastProgressAt: 1 } }],
    progressState: null,
  };

  const result = applyWorkflowProgressBatch(snapshot, batch({
    sequence: 3,
    events: [{ type: 'workflow.agent.heartbeat', nodeId: 'node-1', at: 1770000003333, output: { summary: 'must be ignored' } }],
  }));

  assert.equal(result.ok, true);
  assert.equal(result.snapshot.nodes[0].runtime.lastProgressAt, 1770000003333);
  assert.deepEqual(result.snapshot.nodes[0].output, { summary: 'already written' });
  assert.equal(result.snapshot.progressState.lastMaterialProgress.message, undefined);
});

test('hub persists progress batches with run and project identity checks', () => {
  const hub = createHub({ silent: true });
  const workflowRun = createStartedWorkflowRun(hub);

  const wrongProject = hub.handleWorkflowProgressBatch(workflowRun.id, batch({
    workflowRunId: workflowRun.id,
    projectId: 'proj-other',
  }));
  assert.equal(wrongProject.ok, false);
  assert.equal(wrongProject.error, 'workflow_progress_project_mismatch');

  const applied = hub.handleWorkflowProgressBatch(workflowRun.id, batch({
    workflowRunId: workflowRun.id,
    projectId: workflowRun.projectId,
    sequence: 7,
    events: [
      { type: 'workflow.agent.heartbeat', nodeId: 'worker-diagnose-project', at: 1770000007777 },
      { type: 'workflow.node.progress', nodeId: 'worker-diagnose-project', message: '正在诊断项目状态', at: 1770000007777 },
    ],
  }));

  assert.equal(applied.ok, true);
  assert.equal(applied.workflowRun.progressState.lastSequenceByParticipant['xiaok-worker'], 7);
  assert.equal(applied.workflowRun.progressState.lastMaterialProgress.message, '正在诊断项目状态');
  const node = applied.workflowRun.nodes.find(item => item.id === 'worker-diagnose-project');
  assert.equal(node.runtime.lastProgressAt, 1770000007777);

  const duplicate = hub.handleWorkflowProgressBatch(workflowRun.id, batch({
    workflowRunId: workflowRun.id,
    projectId: workflowRun.projectId,
    sequence: 7,
  }));
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.duplicate, true);
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
if (process.exitCode !== 1) console.log(`\n${passed}/${tests.length} workflow progress contract tests passed`);
