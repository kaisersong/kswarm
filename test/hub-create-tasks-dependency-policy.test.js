/**
 * KSwarm — handleCreateTasks 必须真实归一化并写入 project.dependencyPolicies
 * （design §3.3 —— 动态依赖的唯一 policy owner）
 *
 * 设计依据：mydocs/xiaok-cli/design/2026-08-31-collaboration-room-evidence-first-execution-and-gate-design.md v8
 *   §3.3 —— "动态依赖的唯一 policy owner 冻结为新增纯函数
 *   normalizeTaskGraphPolicies(projectId, tasks, schemaVersion)...planner 输出
 *   dependencyPolicyRefs，key 与原始 dependency ref 同域；所有真实图写入口——
 *   新计划/PO prepareTasksForBoard、task-board.addTasks/addTasksChecked...
 *   在入 board/恢复后统一调用该 normalizer"
 *
 * 现状核实（2026-09-02）：全代码库 grep "dependencyPolicyRefs"/
 * "normalizeTaskGraphPolicies" 零匹配；project.dependencyPolicies 从未被任何
 * 生产代码写入内容（只在 createProjectValidated 初始化为空对象）。这意味着
 * evaluateDependencySatisfaction 虽然实现正确（fail-closed 行为已被测试
 * 验证），但因为 dependencyPolicies 永远是空对象，真实生产流程中所有依赖边
 * 永远退化为 legacy 'completed' 语义——verified_pass 这个核心安全机制在真实
 * PO 提交计划的流程里从未真正生效过，此前所有验证它 fail-closed 的测试都是
 * 通过手动构造 project.dependencyPolicies fixture 完成的。
 *
 * 本文件驱动 handleCreateTasks 支持 PO 在任务输入里声明
 * `dependencyPolicy: Record<depRef, DependencyPolicy>`，写入后按稳定 task ID
 * 归一化进 project.dependencyPolicies。
 *
 * Run: node test/hub-create-tasks-dependency-policy.test.js
 */

import assert from 'node:assert/strict';
import { createHub } from '../src/core/hub.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('PO 在创建任务时声明 dependencyPolicy，写入后按稳定 task ID 归一化进 project.dependencyPolicies（此前完全不会发生）', () => {
  const hub = createHub({ silent: true });
  const projectId = 'proj-dep-policy-1';
  hub.createProject({ id: projectId, name: projectId, goal: 'goal', poAgent: 'po', members: ['worker-a', 'worker-b'] });

  const created = hub.handleCreateTasks(projectId, [
    { id: 'item-1', title: 'Upstream evidence task', assignedAgent: 'worker-a', dependencies: [] },
    {
      id: 'item-2',
      title: 'Downstream consumer task',
      assignedAgent: 'worker-b',
      dependencies: ['item-1'],
      dependencyPolicy: { 'item-1': 'verified_pass' },
    },
  ], 'po');
  assert.equal(created.ok, true, JSON.stringify(created));

  const project = hub.getProject(projectId);
  const downstreamTaskId = created.taskIds[1];
  const upstreamTaskId = created.taskIds[0];
  assert.equal(project.dependencyPolicies?.[upstreamTaskId], 'verified_pass', JSON.stringify(project.dependencyPolicies));
});

test('未声明 dependencyPolicy 的依赖边不写入 project.dependencyPolicies（缺省语义交由 evaluator 的 legacy completed 兼容路径处理，不强行伪造一个默认值）', () => {
  const hub = createHub({ silent: true });
  const projectId = 'proj-dep-policy-2';
  hub.createProject({ id: projectId, name: projectId, goal: 'goal', poAgent: 'po', members: ['worker-a', 'worker-b'] });

  const created = hub.handleCreateTasks(projectId, [
    { id: 'item-1', title: 'Upstream task', assignedAgent: 'worker-a', dependencies: [] },
    { id: 'item-2', title: 'Downstream task', assignedAgent: 'worker-b', dependencies: ['item-1'] },
  ], 'po');
  assert.equal(created.ok, true, JSON.stringify(created));

  const project = hub.getProject(projectId);
  const upstreamTaskId = created.taskIds[0];
  assert.equal(project.dependencyPolicies?.[upstreamTaskId], undefined);
});

test('无效的 dependencyPolicy 取值（不在 completed/completed_for_remediation/verified_pass 三者之一）被拒绝，不静默忽略', () => {
  const hub = createHub({ silent: true });
  const projectId = 'proj-dep-policy-3';
  hub.createProject({ id: projectId, name: projectId, goal: 'goal', poAgent: 'po', members: ['worker-a', 'worker-b'] });

  const created = hub.handleCreateTasks(projectId, [
    { id: 'item-1', title: 'Upstream task', assignedAgent: 'worker-a', dependencies: [] },
    {
      id: 'item-2',
      title: 'Downstream task',
      assignedAgent: 'worker-b',
      dependencies: ['item-1'],
      dependencyPolicy: { 'item-1': 'not_a_real_policy' },
    },
  ], 'po');
  assert.equal(created.ok, false, JSON.stringify(created));
  assert.equal(created.error, 'invalid_dependency_policy');
});

test('dependencyPolicy 引用了不存在的依赖 ref（不在该任务 dependencies 列表里）时被拒绝', () => {
  const hub = createHub({ silent: true });
  const projectId = 'proj-dep-policy-4';
  hub.createProject({ id: projectId, name: projectId, goal: 'goal', poAgent: 'po', members: ['worker-a', 'worker-b'] });

  const created = hub.handleCreateTasks(projectId, [
    { id: 'item-1', title: 'Upstream task', assignedAgent: 'worker-a', dependencies: [] },
    {
      id: 'item-2',
      title: 'Downstream task',
      assignedAgent: 'worker-b',
      dependencies: ['item-1'],
      dependencyPolicy: { 'item-nonexistent': 'verified_pass' },
    },
  ], 'po');
  assert.equal(created.ok, false, JSON.stringify(created));
  assert.equal(created.error, 'dangling_dependency_policy_ref');
});

test('端到端：PO 通过 dependencyPolicy 声明 verified_pass 后，真实 dispatch 判定必须 fail closed（此前因为 project.dependencyPolicies 永远为空，这条边从未真正被强制）', () => {
  const hub = createHub({ silent: true });
  const projectId = 'proj-dep-policy-e2e';
  hub.createProject({ id: projectId, name: projectId, goal: 'goal', poAgent: 'po', members: ['worker-a', 'worker-b'], executionGateSchemaVersion: 2 });

  const created = hub.handleCreateTasks(projectId, [
    { id: 'item-1', title: 'Upstream evidence task', assignedAgent: 'worker-a', dependencies: [] },
    {
      id: 'item-2',
      title: 'Downstream consumer task',
      assignedAgent: 'worker-b',
      dependencies: ['item-1'],
      dependencyPolicy: { 'item-1': 'verified_pass' },
    },
  ], 'po');
  assert.equal(created.ok, true, JSON.stringify(created));
  hub.handleApprove(projectId);

  const board = hub.getBoard(projectId);
  const upstreamId = created.taskIds[0];
  const downstreamId = created.taskIds[1];
  // 上游任务执行完成（status=done），但从未产生任何 GateEvaluation
  // （没有独立 reviewer 验证通过）。
  board.transition(upstreamId, 'dispatched', { assignedAgent: 'worker-a', runId: 'run-1' });
  board.transition(upstreamId, 'accepted', { assignedAgent: 'worker-a' });
  board.transition(upstreamId, 'in_progress');
  board.transition(upstreamId, 'submitted', { result: { summary: 'x' }, runId: 'run-1' });
  board.transition(upstreamId, 'done');

  const dispatchPlan = hub.getDispatchPlan(projectId);
  const dispatchableIds = dispatchPlan.dispatchedTasks.map(t => t.id);
  assert.ok(!dispatchableIds.includes(downstreamId), 'downstream 任务在上游缺 fresh GateEvaluation(passed) 时不应被 dispatch（verified_pass 必须真正 fail closed）');
});

let passed = 0;
let failed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
    if (process.env.DEBUG) console.log(err.stack);
  }
}
console.log(`\n${passed}/${tests.length} hub create-tasks dependency policy tests passed\n`);
if (failed > 0) process.exit(1);
