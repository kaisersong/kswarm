/**
 * KSwarm — normalizeTaskGraphPolicies（design §3.3 唯一 policy owner 纯函数）
 *
 * Run: node test/task-graph-policies.test.js
 */

import assert from 'node:assert/strict';
import { normalizeTaskGraphPolicies, applyTaskGraphPolicyWrites } from '../src/core/task-graph-policies.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('声明合法 dependencyPolicy 时按位置对应把 ref 映射到 resolved ID', () => {
  const result = normalizeTaskGraphPolicies({
    originalTaskList: [
      { id: 'item-1', dependencies: [] },
      { id: 'item-2', dependencies: ['item-1'], dependencyPolicy: { 'item-1': 'verified_pass' } },
    ],
    identityPreviewTasks: [
      { id: 'proj__item-1', localTaskId: 'item-1', dependencyRefs: [], dependencies: [], unresolvedDependencies: [] },
      { id: 'proj__item-2', localTaskId: 'item-2', dependencyRefs: ['item-1'], dependencies: ['proj__item-1'], unresolvedDependencies: [] },
    ],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.policyWrites, [['proj__item-1', 'verified_pass']]);
});

test('未声明 dependencyPolicy 时不产生任何 policyWrites', () => {
  const result = normalizeTaskGraphPolicies({
    originalTaskList: [{ id: 'item-1', dependencies: [] }],
    identityPreviewTasks: [{ id: 'proj__item-1', localTaskId: 'item-1', dependencyRefs: [], dependencies: [], unresolvedDependencies: [] }],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.policyWrites, []);
});

test('非法 policy 取值被拒绝', () => {
  const result = normalizeTaskGraphPolicies({
    originalTaskList: [
      { id: 'item-1', dependencies: [] },
      { id: 'item-2', dependencies: ['item-1'], dependencyPolicy: { 'item-1': 'not_a_policy' } },
    ],
    identityPreviewTasks: [
      { id: 'proj__item-1', localTaskId: 'item-1', dependencyRefs: [], dependencies: [], unresolvedDependencies: [] },
      { id: 'proj__item-2', localTaskId: 'item-2', dependencyRefs: ['item-1'], dependencies: ['proj__item-1'], unresolvedDependencies: [] },
    ],
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'invalid_dependency_policy');
});

test('悬空 policy ref（不在该任务 dependencies 里）被拒绝', () => {
  const result = normalizeTaskGraphPolicies({
    originalTaskList: [
      { id: 'item-1', dependencies: [] },
      { id: 'item-2', dependencies: ['item-1'], dependencyPolicy: { 'item-nonexistent': 'verified_pass' } },
    ],
    identityPreviewTasks: [
      { id: 'proj__item-1', localTaskId: 'item-1', dependencyRefs: [], dependencies: [], unresolvedDependencies: [] },
      { id: 'proj__item-2', localTaskId: 'item-2', dependencyRefs: ['item-1'], dependencies: ['proj__item-1'], unresolvedDependencies: [] },
    ],
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'dangling_dependency_policy_ref');
});

test('unresolved ref 声明 policy 时被拒绝（不能对无法解析的依赖声明策略）', () => {
  const result = normalizeTaskGraphPolicies({
    originalTaskList: [
      { id: 'item-2', dependencies: ['missing-upstream'], dependencyPolicy: { 'missing-upstream': 'verified_pass' } },
    ],
    identityPreviewTasks: [
      { id: 'proj__item-2', localTaskId: 'item-2', dependencyRefs: ['missing-upstream'], dependencies: [], unresolvedDependencies: ['missing-upstream'] },
    ],
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'dangling_dependency_policy_ref');
});

test('applyTaskGraphPolicyWrites 原子写入 project.dependencyPolicies', () => {
  const project = {};
  applyTaskGraphPolicyWrites(project, [['proj__item-1', 'verified_pass'], ['proj__item-2', 'completed_for_remediation']]);
  assert.deepEqual(project.dependencyPolicies, {
    'proj__item-1': 'verified_pass',
    'proj__item-2': 'completed_for_remediation',
  });
});

test('applyTaskGraphPolicyWrites 在 project 缺失时不抛异常（防御性 no-op）', () => {
  assert.doesNotThrow(() => applyTaskGraphPolicyWrites(null, [['a', 'verified_pass']]));
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
console.log(`\n${passed}/${tests.length} normalizeTaskGraphPolicies tests passed\n`);
if (failed > 0) process.exit(1);
