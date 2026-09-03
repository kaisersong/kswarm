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

// design §8.2 表格（workflow-run.js:PASSING_GATE_STATUSES / gate reducer 项）：
// "删除 conditional-pass 的 passing 语义；schema v2 读取时把旧值归一为
// waiting_for_evidence，不得把 node/run 标 completed 或满足 verified edge"。
// 此前这个测试断言了相反的行为（conditional-pass 完成 run）——这是一处真实
// 存在、此前从未被修正的旁路，本次核实发现并修正。
test('gate_completed with conditional-pass no longer completes the run (design §8.2: conditional-pass passing semantics removed)', () => {
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

  assert.equal(run.status, 'blocked', 'conditional-pass 不再满足 passing，run 应保持 blocked（不是 completed）');
  assert.equal(run.gateDecision.status, 'conditional-pass', '原始 decision.status 仍原样记录，供审计；只是不再被当作 passing 消费');
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

// design §8.2：conditional-pass 归一为非 passing，refreshWorkflowRunState 同样
// 不应把它当作满足 passing gate 的依据。构造一个尚未终态（status='running'，
// 不在 TERMINAL_RUN_STATUSES 里）、全部 node 已完成、携带 gateDecision 的 run，
// 这样才能真正触达 refreshSummary 里"gateDecision 决定 status"的判定分支
// （此前的测试场景 status 在 applyWorkflowEvent 阶段就已经因为"全部节点完成"
// 独立判定为 completed，从未真正触达 gateDecision 判定分支——是一处测试构造
// 疏漏，本次核实一并修正）。
test('refreshWorkflowRunState no longer treats conditional-pass as completing (design §8.2)', () => {
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
  assert.equal(run.status, 'completed', '全部节点完成后 run 独立判定为 completed（与本测试要验证的 gateDecision 判定分支无关，先确认前提成立）');

  // 强制回退到非终态，模拟"gate 尚未评审前"的中间状态，这样刷新时才会真正
  // 走到 refreshSummary 里比对 gateDecision 的分支。
  const refreshed = refreshWorkflowRunState({
    ...run,
    status: 'running',
    gateDecision: { status: 'conditional-pass', reasons: ['no blockers'] },
  });
  assert.equal(refreshed.status, 'blocked', 'conditional-pass 不再满足 passing，refreshWorkflowRunState 必须把 status 判定为 blocked（不是 completed）');
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
