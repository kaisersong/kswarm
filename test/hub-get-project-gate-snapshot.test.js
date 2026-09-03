/**
 * KSwarm — hub.js:getProjectGateSnapshot（design §9.1 / §9.3）
 *
 * 设计依据：mydocs/xiaok-cli/design/2026-08-31-collaboration-room-evidence-first-execution-and-gate-design.md v8
 *   §9.1 —— "getProjectGateSnapshot(projectId)"
 *   §9.3 —— "getProjectGateSnapshot 返回专用 read DTO：phase、counts、condition
 *   summaries、artifact ID/hash、user actions；不返回 HydratedGateFactsV1、
 *   绝对/内部路径、raw evidence body、service I/O error detail 或 actor secret。
 *   preload contract 对字段做 allowlist，不透传 KSwarm 原对象。"
 *
 * 现状核实（2026-09-02）：getProjectGateSnapshot 此前完全不存在（既没有 hub 级
 * 函数，也没有 HTTP 路由）。这是 Desktop preload §9.3 接入的前置依赖。
 *
 * Run: node test/hub-get-project-gate-snapshot.test.js
 */

import assert from 'node:assert/strict';
import { createHub } from '../src/core/hub.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('getProjectGateSnapshot 对不存在的项目返回 project_not_found', () => {
  const hub = createHub({ silent: true });
  const result = hub.getProjectGateSnapshot('nonexistent');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'project_not_found');
});

test('getProjectGateSnapshot 返回的 DTO 只含 allowlist 字段，不泄露绝对路径/raw evidence body/actor secret', () => {
  const hub = createHub({ silent: true });
  const projectId = 'proj-snapshot-dto';
  hub.createProject({ id: projectId, name: projectId, goal: 'goal', poAgent: 'po', members: ['worker'] });
  const created = hub.handleCreateTasks(projectId, [
    { id: 'item-1', title: 'Plain task', brief: 'Do it', assignedAgent: 'worker', dependencies: [] },
  ], 'po');
  hub.handleApprove(projectId);
  const board = hub.getBoard(projectId);
  const task = board.getTask(created.taskIds[0]);
  board.transition(task.id, 'dispatched', { assignedAgent: 'worker', runId: 'run-1' });
  board.transition(task.id, 'accepted', { assignedAgent: 'worker' });
  board.transition(task.id, 'in_progress');
  board.transition(task.id, 'submitted', {
    result: {
      summary: 'x',
      workspacePath: '/Users/secret-user/private-project/workspace',
      artifacts: [{ artifactId: 'a1', path: '/Users/secret-user/private-project/workspace/artifacts/report.md' }],
    },
    runId: 'run-1',
  });
  hub.handleQualityReview(projectId, task.id, { passed: true, feedback: 'ok' }, 'po');

  const result = hub.getProjectGateSnapshot(projectId);
  assert.equal(result.ok, true, JSON.stringify(result));
  const dto = result.snapshot;

  assert.ok('phase' in dto, 'DTO 必须含 phase');
  assert.ok('counts' in dto, 'DTO 必须含 counts');
  assert.ok('conditionSummaries' in dto, 'DTO 必须含 conditionSummaries');
  assert.ok('artifacts' in dto, 'DTO 必须含 artifacts（只含 artifactId/hash，不含绝对路径）');
  assert.ok('userActions' in dto, 'DTO 必须含 userActions');

  const serialized = JSON.stringify(dto);
  assert.ok(!serialized.includes('/Users/secret-user'), 'DTO 不应包含任何绝对文件系统路径');
  assert.ok(!serialized.includes('workspacePath'), 'DTO 不应包含 workspacePath 这类内部路径字段名');
  assert.ok(!serialized.includes('HydratedGateFactsV1') && !dto.hydratedGateFacts, 'DTO 不应透传 HydratedGateFactsV1 原始对象');
});

test('getProjectGateSnapshot 的 artifacts 字段只含 artifactId 与 hash，不含 relativePath/canonicalRelativePath 等内部路径字段', () => {
  const hub = createHub({ silent: true });
  const projectId = 'proj-snapshot-artifacts';
  hub.createProject({ id: projectId, name: projectId, goal: 'goal', poAgent: 'po', members: ['worker'] });
  const created = hub.handleCreateTasks(projectId, [
    { id: 'item-1', title: 'Plain task', brief: 'Do it', assignedAgent: 'worker', dependencies: [] },
  ], 'po');
  hub.handleApprove(projectId);
  const project = hub.getProject(projectId);
  project.canonicalArtifacts = {
    a1: { artifactId: 'a1', relativePath: 'tasks/item-1/run-1/report.md', sha256: 'h1', taskId: 'x', runId: 'y' },
  };

  const result = hub.getProjectGateSnapshot(projectId);
  assert.equal(result.ok, true);
  for (const artifact of result.snapshot.artifacts) {
    assert.ok('artifactId' in artifact);
    assert.ok('sha256' in artifact);
    assert.ok(!('relativePath' in artifact), 'artifacts 字段不应包含 relativePath（内部路径信息）');
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
console.log(`\n${passed}/${tests.length} hub getProjectGateSnapshot tests passed\n`);
if (failed > 0) process.exit(1);
