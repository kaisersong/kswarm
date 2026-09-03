/**
 * KSwarm — handleHumanAddTasks 必须接入 normalizeTaskGraphPolicies
 * （design §3.3：所有真实图写入口共用同一 policy seam）
 *
 * 现状核实（2026-09-02）：handleHumanAddTasks（Room → 已有 Project 的另一条
 * 图写入口）此前完全没有接入 dependencyPolicy 归一化——只有 handleCreateTasks
 * 支持。这意味着用户通过 Room "启动执行"添加的任务永远无法声明 verified_pass
 * 依赖策略，是与 handleCreateTasks 不对称的真实缺口。
 *
 * Run: node test/hub-human-add-tasks-dependency-policy.test.js
 */

import assert from 'node:assert/strict';
import { createHub } from '../src/core/hub.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('handleHumanAddTasks 支持声明 dependencyPolicy，写入 project.dependencyPolicies（此前完全不支持）', () => {
  const hub = createHub({ silent: true });
  const projectId = 'proj-human-add-policy';
  hub.createProject({ id: projectId, name: projectId, goal: 'goal', poAgent: 'po', members: ['worker-a', 'worker-b'] });

  const created = hub.handleCreateTasks(projectId, [
    { id: 'item-1', title: 'Upstream task', assignedAgent: 'worker-a', dependencies: [] },
  ], 'po');
  assert.equal(created.ok, true, JSON.stringify(created));

  const humanAdded = hub.handleHumanAddTasks(projectId, [
    {
      id: 'item-2', title: 'Human-added downstream task', assignedAgent: 'worker-b',
      dependencies: ['item-1'],
      dependencyPolicy: { 'item-1': 'verified_pass' },
    },
  ], { requestSource: 'user' });
  assert.equal(humanAdded.ok, true, JSON.stringify(humanAdded));

  const project = hub.getProject(projectId);
  const upstreamId = created.taskIds[0];
  assert.equal(project.dependencyPolicies?.[upstreamId], 'verified_pass');
});

test('handleHumanAddTasks 对无效 dependencyPolicy 取值 fail closed', () => {
  const hub = createHub({ silent: true });
  const projectId = 'proj-human-add-policy-invalid';
  hub.createProject({ id: projectId, name: projectId, goal: 'goal', poAgent: 'po', members: ['worker-a', 'worker-b'] });
  hub.handleCreateTasks(projectId, [
    { id: 'item-1', title: 'Upstream task', assignedAgent: 'worker-a', dependencies: [] },
  ], 'po');

  const humanAdded = hub.handleHumanAddTasks(projectId, [
    {
      id: 'item-2', title: 'Human-added downstream task', assignedAgent: 'worker-b',
      dependencies: ['item-1'],
      dependencyPolicy: { 'item-1': 'not_a_real_policy' },
    },
  ], { requestSource: 'user' });
  assert.equal(humanAdded.ok, false);
  assert.equal(humanAdded.error, 'invalid_dependency_policy');
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
console.log(`\n${passed}/${tests.length} handleHumanAddTasks dependency policy tests passed\n`);
if (failed > 0) process.exit(1);
