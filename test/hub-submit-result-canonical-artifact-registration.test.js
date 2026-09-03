/**
 * KSwarm — handleSubmitResult 必须为 schema v2 项目自动注册 canonical artifact
 * （design §3.5 / §8.1.1）
 *
 * 设计依据：mydocs/xiaok-cli/design/2026-08-31-collaboration-room-evidence-first-execution-and-gate-design.md v8
 *   §3.5 —— "KSwarm 已有 artifact-manifest.js，其 artifactId/sha256/path/
 *   projectId/taskId/producedBy 是唯一 artifact identity"
 *   §8.1.1 —— HydratedGateFactsV1.currentArtifacts 依赖 canonical artifact
 *   registry 里已经登记的记录做 containment/hash 校验
 *
 * 现状核实（2026-09-02）：全代码库 grep "registerCanonicalArtifacts" 只有
 * canonical-artifact-registry.js 自身的定义，hub.js 从未调用它——这意味着
 * 真实生产提交流程中 project.canonicalArtifacts 永远是空对象，
 * hydrateGateFacts/evaluatePreApprovalPrerequisites 对任何真实文件 deliverable
 * 都会判定 final_artifact_not_hydrated/final_artifact_hash_mismatch，
 * schema v2 项目的真实文件批准流程完全不可用（此前所有 gate 测试都只测过
 * kind='none' 的纯文字交付物，或手动调用 registerCanonicalArtifacts 构造
 * fixture，从未验证过这条真实生产链路）。
 *
 * Run: node test/hub-submit-result-canonical-artifact-registration.test.js
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createHub } from '../src/core/hub.js';
import { getCanonicalArtifact } from '../src/core/canonical-artifact-registry.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function sha256(text) {
  return createHash('sha256').update(Buffer.from(text, 'utf-8')).digest('hex');
}

test('schema v2 项目提交带真实文件 artifact 的任务结果后，project.canonicalArtifacts 必须真实登记该 artifact（此前完全不会发生）', () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'kswarm-canonical-submit-'));
  try {
    mkdirSync(join(workspaceRoot, 'artifacts'), { recursive: true });
    const artifactPath = join(workspaceRoot, 'artifacts', 'report.md');
    const content = '# Report\n\nReal content produced by the worker.';
    writeFileSync(artifactPath, content);

    const hub = createHub({ silent: true });
    const projectId = 'proj-canonical-submit';
    hub.createProject({
      id: projectId, name: projectId, goal: 'goal', poAgent: 'po', members: ['worker'],
      executionGateSchemaVersion: 2,
    });
    const created = hub.handleCreateTasks(projectId, [
      { id: 'item-1', title: 'General task', brief: 'Do it', assignedAgent: 'worker', dependencies: [] },
    ], 'po');
    hub.handleApprove(projectId);
    const board = hub.getBoard(projectId);
    const task = board.getTask(created.taskIds[0]);
    board.transition(task.id, 'dispatched', { assignedAgent: 'worker', runId: 'run-1' });
    board.transition(task.id, 'accepted', { assignedAgent: 'worker' });
    board.transition(task.id, 'in_progress');

    const submit = hub.handleSubmitResult(projectId, task.id, {
      summary: 'done',
      workFolder: workspaceRoot,
      artifacts: [{ artifactId: 'report-1', path: artifactPath }],
    }, 'worker', 'run-1');
    assert.equal(submit.ok, true, JSON.stringify(submit));

    const project = hub.getProject(projectId);
    const canonical = getCanonicalArtifact(project, 'report-1');
    assert.ok(canonical, 'canonical artifact 必须被真实注册，不能是 null');
    assert.equal(canonical.sha256, sha256(content), 'canonical 记录的 sha256 必须是 service 端重新计算的真实文件 hash');
    assert.equal(canonical.taskId, task.id);
    assert.equal(canonical.runId, 'run-1');
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('schema v1（legacy）项目提交带文件 artifact 的任务结果时不注册 canonical artifact（不引入回归/额外 I/O）', () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'kswarm-canonical-submit-v1-'));
  try {
    mkdirSync(join(workspaceRoot, 'artifacts'), { recursive: true });
    const artifactPath = join(workspaceRoot, 'artifacts', 'report.md');
    writeFileSync(artifactPath, 'legacy content');

    const hub = createHub({ silent: true });
    const projectId = 'proj-canonical-submit-v1';
    hub.createProject({ id: projectId, name: projectId, goal: 'goal', poAgent: 'po', members: ['worker'] });
    const created = hub.handleCreateTasks(projectId, [
      { id: 'item-1', title: 'General task', brief: 'Do it', assignedAgent: 'worker', dependencies: [] },
    ], 'po');
    hub.handleApprove(projectId);
    const board = hub.getBoard(projectId);
    const task = board.getTask(created.taskIds[0]);
    board.transition(task.id, 'dispatched', { assignedAgent: 'worker', runId: 'run-1' });
    board.transition(task.id, 'accepted', { assignedAgent: 'worker' });
    board.transition(task.id, 'in_progress');

    const submit = hub.handleSubmitResult(projectId, task.id, {
      summary: 'done',
      workFolder: workspaceRoot,
      artifacts: [{ artifactId: 'report-1', path: artifactPath }],
    }, 'worker', 'run-1');
    assert.equal(submit.ok, true, JSON.stringify(submit));

    const project = hub.getProject(projectId);
    assert.equal(project.canonicalArtifacts === undefined || Object.keys(project.canonicalArtifacts || {}).length === 0, true, 'v1 项目不应触发 canonical artifact 注册');
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('schema v2 项目提交时，artifact 指向的文件不存在，不阻断提交本身，也不注册该 artifact（fail closed，不是抛异常）', () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'kswarm-canonical-submit-missing-'));
  try {
    mkdirSync(join(workspaceRoot, 'artifacts'), { recursive: true });

    const hub = createHub({ silent: true });
    const projectId = 'proj-canonical-submit-missing';
    hub.createProject({
      id: projectId, name: projectId, goal: 'goal', poAgent: 'po', members: ['worker'],
      executionGateSchemaVersion: 2,
    });
    const created = hub.handleCreateTasks(projectId, [
      { id: 'item-1', title: 'General task', brief: 'Do it', assignedAgent: 'worker', dependencies: [] },
    ], 'po');
    hub.handleApprove(projectId);
    const board = hub.getBoard(projectId);
    const task = board.getTask(created.taskIds[0]);
    board.transition(task.id, 'dispatched', { assignedAgent: 'worker', runId: 'run-1' });
    board.transition(task.id, 'accepted', { assignedAgent: 'worker' });
    board.transition(task.id, 'in_progress');

    const submit = hub.handleSubmitResult(projectId, task.id, {
      summary: 'done',
      workFolder: workspaceRoot,
      artifacts: [{ artifactId: 'report-missing', path: join(workspaceRoot, 'artifacts', 'nonexistent.md') }],
    }, 'worker', 'run-1');
    assert.equal(submit.ok, true, JSON.stringify(submit));

    const project = hub.getProject(projectId);
    const canonical = getCanonicalArtifact(project, 'report-missing');
    assert.equal(canonical, null, '文件不存在时不应注册 canonical artifact 记录');
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
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
console.log(`\n${passed}/${tests.length} handleSubmitResult canonical artifact registration tests passed\n`);
if (failed > 0) process.exit(1);
