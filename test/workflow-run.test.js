/**
 * KSwarm — workflow run state model tests
 *
 * Run: node test/workflow-run.test.js
 */

import assert from 'node:assert/strict';
import {
  applyWorkflowEvent,
  createWorkflowRun,
  refreshWorkflowRunState,
  summarizeWorkflowRun,
  validateWorkflowRunInput,
} from '../src/core/workflow-run.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('creates an approval-gated workflow run with ready root nodes only', () => {
  const run = createWorkflowRun({
    id: 'wf-1',
    projectId: 'proj-1',
    workflowId: 'project-diagnose',
    title: '项目诊断',
    requestedBy: 'human',
    approval: { required: true, budget: { maxAgents: 4, maxUsd: 2, maxMinutes: 10 } },
    phases: [{ id: 'diagnose', title: '诊断' }],
    nodes: [
      { id: 'collect', phaseId: 'diagnose', title: '收集状态', kind: 'control' },
      { id: 'recommend', phaseId: 'diagnose', title: '生成建议', kind: 'review', dependsOn: ['collect'] },
    ],
    now: 1770000000000,
  });

  assert.equal(run.status, 'awaiting_approval');
  assert.equal(run.approval.status, 'pending');
  assert.equal(run.nodes[0].status, 'ready');
  assert.equal(run.nodes[1].status, 'pending');
  assert.equal(run.summary.total, 2);
  assert.equal(run.summary.progress, 0);
});

test('rejects invalid dependency references and cycles', () => {
  const missing = validateWorkflowRunInput({
    projectId: 'proj-1',
    workflowId: 'bad',
    title: '坏工作流',
    phases: [{ id: 'p1', title: 'P1' }],
    nodes: [{ id: 'n1', phaseId: 'p1', title: 'N1', dependsOn: ['missing'] }],
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'unknown_dependency');

  const cycle = validateWorkflowRunInput({
    projectId: 'proj-1',
    workflowId: 'bad',
    title: '坏工作流',
    phases: [{ id: 'p1', title: 'P1' }],
    nodes: [
      { id: 'a', phaseId: 'p1', title: 'A', dependsOn: ['b'] },
      { id: 'b', phaseId: 'p1', title: 'B', dependsOn: ['a'] },
    ],
  });
  assert.equal(cycle.ok, false);
  assert.equal(cycle.error, 'dependency_cycle');
});

test('applies node lifecycle events and completes the run when all nodes complete', () => {
  let run = createWorkflowRun({
    id: 'wf-2',
    projectId: 'proj-1',
    workflowId: 'project-diagnose',
    title: '项目诊断',
    phases: [{ id: 'diagnose', title: '诊断' }],
    nodes: [
      { id: 'collect', phaseId: 'diagnose', title: '收集状态', kind: 'control' },
      { id: 'recommend', phaseId: 'diagnose', title: '生成建议', kind: 'review', dependsOn: ['collect'] },
    ],
    now: 1770000000000,
  });

  run = applyWorkflowEvent(run, { type: 'node_started', nodeId: 'collect' }, { now: 1770000001000 });
  assert.equal(run.status, 'running');
  assert.equal(run.nodes.find(n => n.id === 'collect').status, 'running');

  run = applyWorkflowEvent(run, { type: 'node_completed', nodeId: 'collect', output: { count: 2 } }, { now: 1770000002000 });
  assert.equal(run.nodes.find(n => n.id === 'collect').status, 'completed');
  assert.equal(run.nodes.find(n => n.id === 'recommend').status, 'ready');

  run = applyWorkflowEvent(run, { type: 'node_started', nodeId: 'recommend' }, { now: 1770000003000 });
  run = applyWorkflowEvent(run, { type: 'node_completed', nodeId: 'recommend', output: { action: 'continue' } }, { now: 1770000004000 });

  assert.equal(run.status, 'completed');
  assert.equal(run.summary.completed, 2);
  assert.equal(run.summary.progress, 1);
});

test('cancelled workflow cancels unfinished nodes and preserves completed output', () => {
  let run = createWorkflowRun({
    id: 'wf-3',
    projectId: 'proj-1',
    workflowId: 'project-diagnose',
    title: '项目诊断',
    phases: [{ id: 'diagnose', title: '诊断' }],
    nodes: [
      { id: 'collect', phaseId: 'diagnose', title: '收集状态', kind: 'control' },
      { id: 'recommend', phaseId: 'diagnose', title: '生成建议', kind: 'review', dependsOn: ['collect'] },
    ],
    now: 1770000000000,
  });
  run = applyWorkflowEvent(run, { type: 'node_started', nodeId: 'collect' }, { now: 1770000001000 });
  run = applyWorkflowEvent(run, { type: 'node_completed', nodeId: 'collect', output: { preserved: true } }, { now: 1770000002000 });
  run = applyWorkflowEvent(run, { type: 'cancelled', reason: 'human_cancelled' }, { now: 1770000003000 });

  assert.equal(run.status, 'cancelled');
  assert.equal(run.nodes.find(n => n.id === 'collect').status, 'completed');
  assert.equal(run.nodes.find(n => n.id === 'recommend').status, 'cancelled');
  assert.equal(summarizeWorkflowRun(run).completed, 1);
});

test('gate_completed with conditional-pass completes the run', () => {
  let run = createWorkflowRun({
    id: 'wf-4',
    projectId: 'proj-1',
    workflowId: 'kualityforge-review',
    title: 'KF review',
    phases: [{ id: 'review', title: '评审' }],
    nodes: [
      { id: 'agent-1', phaseId: 'review', title: '评审', kind: 'agent_task' },
      { id: 'gate', phaseId: 'review', title: 'Gate', kind: 'gate', dependsOn: ['agent-1'] },
    ],
    now: 1770000000000,
  });

  run = applyWorkflowEvent(run, { type: 'node_started', nodeId: 'agent-1' }, { now: 1770000001000 });
  run = applyWorkflowEvent(run, { type: 'node_completed', nodeId: 'agent-1', output: { findings: 5 } }, { now: 1770000002000 });
  run = applyWorkflowEvent(run, {
    type: 'gate_completed',
    nodeId: 'gate',
    decision: { status: 'conditional-pass', reasons: ['no blockers'] },
  }, { now: 1770000003000 });

  assert.equal(run.status, 'completed');
  assert.equal(run.gateDecision.status, 'conditional-pass');
  assert.equal(run.summary.completed, 2);
  assert.equal(run.summary.primaryMessage, 'Review gate conditional pass');
});

test('gate_completed with blocked gate blocks the run', () => {
  let run = createWorkflowRun({
    id: 'wf-5',
    projectId: 'proj-1',
    workflowId: 'kualityforge-review',
    title: 'KF review',
    phases: [{ id: 'review', title: '评审' }],
    nodes: [
      { id: 'agent-1', phaseId: 'review', title: '评审', kind: 'agent_task' },
      { id: 'gate', phaseId: 'review', title: 'Gate', kind: 'gate', dependsOn: ['agent-1'] },
    ],
    now: 1770000000000,
  });

  run = applyWorkflowEvent(run, { type: 'node_started', nodeId: 'agent-1' }, { now: 1770000001000 });
  run = applyWorkflowEvent(run, { type: 'node_completed', nodeId: 'agent-1', output: { findings: 5 } }, { now: 1770000002000 });
  run = applyWorkflowEvent(run, {
    type: 'gate_completed',
    nodeId: 'gate',
    decision: { status: 'blocked', reason: 'blocker_found' },
  }, { now: 1770000003000 });

  assert.equal(run.status, 'blocked');
  assert.equal(run.gateDecision.status, 'blocked');
});

test('refreshWorkflowRunState recognizes conditional-pass in gateDecision after all nodes complete', () => {
  let run = createWorkflowRun({
    id: 'wf-6',
    projectId: 'proj-1',
    workflowId: 'kf-review',
    title: 'KF review',
    phases: [{ id: 'review', title: '评审' }],
    nodes: [
      { id: 'agent-1', phaseId: 'review', title: '评审', kind: 'agent_task' },
    ],
    now: 1770000000000,
  });

  run = applyWorkflowEvent(run, { type: 'node_started', nodeId: 'agent-1' }, { now: 1770000001000 });
  run = applyWorkflowEvent(run, { type: 'node_completed', nodeId: 'agent-1' }, { now: 1770000002000 });

  const refreshed = refreshWorkflowRunState({
    ...run,
    gateDecision: { status: 'conditional-pass', reasons: ['no blockers'] },
  });
  assert.equal(refreshed.status, 'completed');
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
if (process.exitCode !== 1) console.log(`\n${passed}/${tests.length} workflow run tests passed`);
