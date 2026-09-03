/**
 * KSwarm — handleSubmitResult 必须把 result.evidenceExtensions 持久化到
 * project.artifactEvidenceExtensions（design §3.5/§10.1）
 *
 * 设计依据：mydocs/xiaok-cli/design/2026-08-31-collaboration-room-evidence-first-execution-and-gate-design.md v8
 *   §3.5 —— "ArtifactEvidenceExtensionV1...artifactId 外键，身份/路径/hash/
 *   producer 仍取 canonical manifest"
 *   §10.1 —— "canonical artifact manifest 的 evidence extension...进入
 *   KSwarm project-scoped durable state...新增集合名冻结为
 *   artifactEvidenceExtensions"
 *
 * 现状核实（2026-09-02）：buildArtifactEvidenceExtension 早已实现且被
 * collectSearchEvidenceV2 真实调用产出记录，但这些记录只塞进磁盘落盘的
 * search-evidence-v2.json 文件内容里，从未作为结构化字段提交给 hub，
 * project.artifactEvidenceExtensions 这个持久化集合完全不存在。
 *
 * Run: node test/hub-submit-result-artifact-evidence-extension-persistence.test.js
 */

import assert from 'node:assert/strict';
import { createHub } from '../src/core/hub.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('handleSubmitResult 真实持久化 result.evidenceExtensions 到 project.artifactEvidenceExtensions', () => {
  const hub = createHub({ silent: true });
  const projectId = 'proj-evidence-ext-persist';
  hub.createProject({
    id: projectId, name: projectId, goal: 'goal', poAgent: 'po', members: ['worker'],
    executionGateSchemaVersion: 2,
  });
  const created = hub.handleCreateTasks(projectId, [
    { id: 'item-1', title: 'Research task', assignedAgent: 'worker', dependencies: [] },
  ], 'po');
  hub.handleApprove(projectId);
  const board = hub.getBoard(projectId);
  const taskId = created.taskIds[0];
  board.transition(taskId, 'dispatched', { assignedAgent: 'worker', runId: 'run-1' });
  board.transition(taskId, 'accepted', { assignedAgent: 'worker' });
  board.transition(taskId, 'in_progress');

  const submit = hub.handleSubmitResult(projectId, taskId, {
    summary: 'Research task completed with external source evidence collected via real fetches during execution.',
    evidenceExtensions: [
      {
        schemaVersion: 'artifact-evidence-extension-v1',
        artifactId: 'page-abc123',
        runId: 'run-1',
        claimIds: ['claim-1', 'claim-2'],
        fetch: {
          fetchedAt: '2026-09-02T00:00:00.000Z',
          contentLength: 5000,
          bytesStored: 5000,
          truncated: false,
          fetchCompleted: true,
        },
      },
    ],
  }, 'worker', 'run-1');
  assert.equal(submit.ok, true, JSON.stringify(submit));

  const project = hub.getProject(projectId);
  const extension = project.artifactEvidenceExtensions?.['page-abc123'];
  assert.ok(extension, 'artifactEvidenceExtensions 必须真实持久化该记录');
  assert.equal(extension.runId, 'run-1');
  assert.deepEqual(extension.claimIds, ['claim-1', 'claim-2']);
  assert.equal(extension.fetch.fetchCompleted, true);
  assert.equal(extension.fetch.bytesStored, 5000);
});

test('缺失 artifactId 或 runId 的 evidenceExtension 记录被跳过（不产生半成品持久化）', () => {
  const hub = createHub({ silent: true });
  const projectId = 'proj-evidence-ext-invalid';
  hub.createProject({
    id: projectId, name: projectId, goal: 'goal', poAgent: 'po', members: ['worker'],
    executionGateSchemaVersion: 2,
  });
  const created = hub.handleCreateTasks(projectId, [
    { id: 'item-1', title: 'Research task', assignedAgent: 'worker', dependencies: [] },
  ], 'po');
  hub.handleApprove(projectId);
  const board = hub.getBoard(projectId);
  const taskId = created.taskIds[0];
  board.transition(taskId, 'dispatched', { assignedAgent: 'worker', runId: 'run-1' });
  board.transition(taskId, 'accepted', { assignedAgent: 'worker' });
  board.transition(taskId, 'in_progress');

  const submit = hub.handleSubmitResult(projectId, taskId, {
    summary: 'Research task completed but evidence extension record is malformed for this test case scenario.',
    evidenceExtensions: [{ schemaVersion: 'artifact-evidence-extension-v1', runId: 'run-1' }], // 缺 artifactId
  }, 'worker', 'run-1');
  assert.equal(submit.ok, true, JSON.stringify(submit));

  const project = hub.getProject(projectId);
  assert.equal(Object.keys(project.artifactEvidenceExtensions || {}).length, 0, '缺 artifactId 的记录不应被持久化');
});

test('schema v1（legacy）项目提交 evidenceExtensions 时也不受影响（该字段与 canonical registry 一样只在 schema v2 生效——设计范围只覆盖 v2 external_source_v2）', () => {
  const hub = createHub({ silent: true });
  const projectId = 'proj-evidence-ext-v1';
  hub.createProject({ id: projectId, name: projectId, goal: 'goal', poAgent: 'po', members: ['worker'] });
  const created = hub.handleCreateTasks(projectId, [
    { id: 'item-1', title: 'Research task', assignedAgent: 'worker', dependencies: [] },
  ], 'po');
  hub.handleApprove(projectId);
  const board = hub.getBoard(projectId);
  const taskId = created.taskIds[0];
  board.transition(taskId, 'dispatched', { assignedAgent: 'worker', runId: 'run-1' });
  board.transition(taskId, 'accepted', { assignedAgent: 'worker' });
  board.transition(taskId, 'in_progress');

  const submit = hub.handleSubmitResult(projectId, taskId, {
    summary: 'Legacy v1 project research task completed with an evidence extension payload attached for this test.',
    evidenceExtensions: [{ schemaVersion: 'artifact-evidence-extension-v1', artifactId: 'page-legacy', runId: 'run-1' }],
  }, 'worker', 'run-1');
  assert.equal(submit.ok, true, JSON.stringify(submit));

  const project = hub.getProject(projectId);
  assert.equal(project.artifactEvidenceExtensions, undefined, 'v1 项目不应触发 artifactEvidenceExtensions 持久化');
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
console.log(`\n${passed}/${tests.length} artifactEvidenceExtensions persistence tests passed\n`);
if (failed > 0) process.exit(1);
