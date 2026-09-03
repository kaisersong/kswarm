/**
 * KSwarm — task-board.js:getDispatchable 依赖判定唯一化回归（design §8.2）
 *
 * 设计依据：mydocs/xiaok-cli/design/2026-08-31-collaboration-room-evidence-first-execution-and-gate-design.md v8
 *   §8.2 唯一 gate evaluator 与全部兄弟路径 —— "task-board.js:getDispatchable：
 *   删除私有 dependency 判定，委托 evaluateDependencySatisfaction"
 *
 * 现状核实（2026-09-02）：
 *   - task-board.js:getDispatchable 目前是
 *     `.filter(t => (t.dependencies || []).every(depRef => { ... dep.status === 'done' }))`
 *     的私有判断，从未委托 gate-evaluator.js:evaluateDependencySatisfaction。
 *   - dispatch-policy.js:getPendingDependencies 已确认真实委托同一函数（唯一入口），
 *     schemaV2 由 hub.js 里 `project?.executionGateSchemaVersion === 2` 决定，
 *     dependencyPolicies/gateEvaluationsByTaskId 是项目级上下文，TaskBoard 实例本身
 *     不持有 project 对象，因此 getDispatchable 的委托方式应类比 planDispatch：
 *     接受可选的 { dependencyPolicies, gateEvaluationsByTaskId, consumedArtifactIdsByDependencyTaskId,
 *     currentGateFactsByTaskId, schemaV2 } 上下文参数，由调用者传入，缺省时保持向后兼容
 *     （不传参数 = 旧 legacy 行为，不破坏现有 55 处 getDispatchable 隐式假设）。
 *
 * 本文件先证明"即使传入 schemaV2=true 的判定上下文，getDispatchable 也不会应用它"
 * （RED），随后实现改动应使其变绿。
 *
 * Run: node test/task-board-dispatchable-gate-evaluator-delegation.test.js
 */

import assert from 'node:assert/strict';
import { createTaskBoard } from '../src/core/task-board.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function finishTask(board, taskId) {
  assert.equal(board.transition(taskId, 'dispatched', { assignedAgent: 'worker', runId: `run-${taskId}` }).ok, true);
  assert.equal(board.transition(taskId, 'accepted', { assignedAgent: 'worker' }).ok, true);
  assert.equal(board.transition(taskId, 'in_progress').ok, true);
  assert.equal(board.transition(taskId, 'submitted', { result: { summary: 'done' } }).ok, true);
  assert.equal(board.transition(taskId, 'done').ok, true);
}

test('getDispatchable 缺省不传参数时保持向后兼容（legacy completed 语义，不回归现有行为）', () => {
  const board = createTaskBoard('proj-dispatchable-legacy');
  const added = board.addTasksChecked([
    { id: 'item-1', title: '上游任务', assignedAgent: 'worker' },
    { id: 'item-2', title: '下游任务', assignedAgent: 'worker', dependencies: ['item-1'] },
  ]);
  assert.equal(added.ok, true);
  finishTask(board, 'item-1');

  const dispatchable = board.getDispatchable();
  assert.ok(
    dispatchable.map(t => t.localTaskId).includes('item-2'),
    'legacy 调用（不传 schemaV2 上下文）时 item-2 应可派发，不能因为本次改动破坏现有兼容行为',
  );
});

test('getDispatchable 接受 schemaV2 判定上下文时，必须委托 evaluateDependencySatisfaction 的 fail-closed 规则', () => {
  const board = createTaskBoard('proj-dispatchable-v2');
  const added = board.addTasksChecked([
    { id: 'item-1', title: '上游任务', assignedAgent: 'worker' },
    { id: 'item-2', title: '下游任务', assignedAgent: 'worker', dependencies: ['item-1'] },
  ]);
  assert.equal(added.ok, true);
  finishTask(board, 'item-1');

  // design §3.3：schema v2 项目缺 dependencyPolicies 时必须 fail closed。
  const dispatchable = board.getDispatchable({ schemaV2: true, dependencyPolicies: {} });
  assert.ok(
    !dispatchable.map(t => t.localTaskId).includes('item-2'),
    'schemaV2=true 且缺 dependencyPolicies 时，getDispatchable 必须 fail closed，不能仍判定 item-2 可派发',
  );
});

test('getDispatchable 接受 schemaV2 上下文且 dependencyPolicies=completed 时，行为与 evaluateDependencySatisfaction 一致（done 即可派发）', () => {
  const board = createTaskBoard('proj-dispatchable-v2-completed');
  const added = board.addTasksChecked([
    { id: 'item-1', title: '上游任务', assignedAgent: 'worker' },
    { id: 'item-2', title: '下游任务', assignedAgent: 'worker', dependencies: ['item-1'] },
  ]);
  assert.equal(added.ok, true);
  finishTask(board, 'item-1');

  const dispatchable = board.getDispatchable({
    schemaV2: true,
    dependencyPolicies: { 'proj-dispatchable-v2-completed__item-1': 'completed' },
  });
  assert.ok(
    dispatchable.map(t => t.localTaskId).includes('item-2'),
    'dependencyPolicies 显式声明 completed 且依赖已 done 时，item-2 应可派发',
  );
});

test('getDispatchableInPhase 同样透传 schemaV2 判定上下文（不能只修 getDispatchable 而漏掉这条兄弟路径）', () => {
  const board = createTaskBoard('proj-dispatchable-phase-v2');
  const added = board.addTasksChecked([
    { id: 'item-1', title: '上游任务', assignedAgent: 'worker', phaseId: 'p1' },
    { id: 'item-2', title: '下游任务', assignedAgent: 'worker', dependencies: ['item-1'], phaseId: 'p1' },
  ]);
  assert.equal(added.ok, true);
  finishTask(board, 'item-1');

  const dispatchable = board.getDispatchableInPhase('p1', { schemaV2: true, dependencyPolicies: {} });
  assert.ok(
    !dispatchable.map(t => t.localTaskId).includes('item-2'),
    'getDispatchableInPhase 必须透传同一套 schemaV2 判定上下文，fail closed 规则不能被这条兄弟路径绕过',
  );
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
  }
}
console.log(`\n${passed}/${tests.length} task-board dispatchable gate evaluator delegation tests passed\n`);
if (failed > 0) process.exit(1);
