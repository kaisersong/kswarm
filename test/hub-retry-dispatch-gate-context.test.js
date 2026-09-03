/**
 * KSwarm — hub.js:handleTaskFail 的 retry 重新派发必须携带 project 级
 * dependencyPolicies/gateEvaluationsByTaskId/schemaV2，不能绕过唯一 gate
 * evaluator（design §3.3 / §8.2）
 *
 * 设计依据：mydocs/xiaok-cli/design/2026-08-31-collaboration-room-evidence-first-execution-and-gate-design.md v8
 *   §8.2 表格 —— "retry / resume / startup recovery / human advance：只能重新
 *   进入统一 dispatch/project gate evaluator"
 *
 * 现状核实（2026-09-02）：handleTaskFail 内部构造 retry task 后调用 planDispatch
 * 时（第 1777 行附近），只传了 projectId/tasks/allActiveTasks/agentProfiles/
 * agentConcurrency，完全没有传 dependencyPolicies/gateEvaluationsByTaskId/
 * consumedArtifactIdsByTaskId/currentGateFactsByTaskId/schemaV2——这意味着
 * retry task 的重新派发永远走 schemaV2=false 的 legacy completed 语义，
 * 无论 retry task 本身继承了什么 verified_pass 依赖策略，都会被这条独立
 * 维护的 dispatch 调用绕过 fail-closed 检查。这是一处真实存在、此前从未被
 * 核实过的旁路。
 *
 * Run: node test/hub-retry-dispatch-gate-context.test.js
 */

import assert from 'node:assert/strict';
import { createHub } from '../src/core/hub.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('retry task 重新派发时必须尊重 verified_pass 依赖策略（retry task 自身依赖 verified_pass 但上游缺 fresh evaluation 时不能被 fail-closed 绕过）', () => {
  const hub = createHub({ silent: true });
  const projectId = 'proj-retry-gate';
  hub.createProject({
    id: projectId, name: projectId, goal: 'goal', poAgent: 'po', members: ['worker-a', 'worker-b'],
    executionGateSchemaVersion: 2,
  });
  const created = hub.handleCreateTasks(projectId, [
    { id: 'item-1', title: 'Upstream verified artifact', brief: 'produce', assignedAgent: 'worker-a', dependencies: [] },
    { id: 'item-2', title: 'Downstream consumer', brief: 'consume', assignedAgent: 'worker-b', dependencies: ['item-1'] },
  ], 'po');
  assert.equal(created.ok, true);
  hub.handleApprove(projectId);

  const project = hub.getProject(projectId);
  const board = hub.getBoard(projectId);
  const upstream = board.getTask(created.taskIds[0]);
  const downstream = board.getTask(created.taskIds[1]);

  // downstream（item-2）依赖 upstream（item-1）的 verified_pass 策略，
  // 但 upstream 从未产出 fresh GateEvaluation(passed)。
  project.dependencyPolicies = { [upstream.id]: 'verified_pass' };
  downstream.consumedArtifactIdsByDependencyTaskId = { [upstream.id]: ['subject-1'] };

  // 关键构造：upstream 必须已经是 done（否则 legacy completed 语义的
  // "dep.status !== 'done'" 判断会"意外正确地"拒绝 dispatch，掩盖了本测试
  // 真正要验证的问题——即使 upstream 已经 done，缺 fresh GateEvaluation 的
  // verified_pass 依赖边仍必须 fail closed，不能因为 planDispatch 调用忘记
  // 传 dependencyPolicies/schemaV2 而退化成"done 即可"的 legacy 语义。
  board.transition(upstream.id, 'dispatched', { assignedAgent: 'worker-a', runId: 'run-upstream' });
  board.transition(upstream.id, 'accepted', { assignedAgent: 'worker-a' });
  board.transition(upstream.id, 'in_progress');
  board.transition(upstream.id, 'submitted', { result: { summary: 'upstream produced output' }, runId: 'run-upstream' });
  board.transition(upstream.id, 'done');

  // downstream 自身执行失败一次，触发 handleTaskFail 的自动 retry 重新派发路径。
  // retry task 继承 downstream 的 dependencies（仍然依赖 upstream），所以
  // retry 后的任务同样应该因为 upstream 缺 fresh evaluation 而 fail closed，
  // 不应该被 dispatch。
  board.transition(downstream.id, 'dispatched', { assignedAgent: 'worker-b', runId: 'run-1' });
  board.transition(downstream.id, 'accepted', { assignedAgent: 'worker-b' });
  board.transition(downstream.id, 'in_progress');
  const failResult = hub.handleTaskFail(projectId, downstream.id, 'runtime_offline', 'connection lost');
  assert.equal(failResult.ok, true, JSON.stringify(failResult));

  // 无论 retry 是否真的被创建，都不能因为"upstream 缺 fresh evaluation"而
  // 绕过 fail-closed：如果 retried===true 且 retryDispatched===true，说明
  // verified_pass 检查被绕过了——upstream 从未产出任何 GateEvaluation，
  // 理应 fail closed，不应该被 dispatch。
  if (failResult.retried) {
    assert.equal(
      failResult.retryDispatched, false,
      'upstream 缺 fresh GateEvaluation(passed) 时，继承了 verified_pass 依赖的 retry task 不应该被 dispatch——如果 planDispatch 调用没有传 dependencyPolicies/schemaV2，这里会错误地是 true',
    );
  }
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
console.log(`\n${passed}/${tests.length} hub retry dispatch gate context tests passed\n`);
if (failed > 0) process.exit(1);
