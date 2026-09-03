/**
 * KSwarm — approveFinalDeliverable 接入 freezeFinalCandidateArtifact（design §8.1.1/§10.5 frozen candidate）
 *
 * 设计依据：mydocs/xiaok-cli/design/2026-08-31-collaboration-room-evidence-first-execution-and-gate-design.md v8
 *   §8.1.1 —— "把同一 bytes 原子写入 project 内 write-once、content-addressed
 *   的 frozen candidate...FinalDeliverable、checks、snapshot 和 approval 全部
 *   绑定 frozen artifact ID/hash，不再绑定可变工作文件路径。工作文件之后变化
 *   只能产生新 candidate/version，不能改变已批准 bytes。"
 *
 * 现状核实（2026-09-02）：freezeFinalCandidateArtifact 此前完全不存在。本文件
 * 驱动它真实接入 approveFinalDeliverable（仅 schema v2 + kind='file' 项目），
 * 证明批准完成后即使原始工作文件被覆写，finalDeliverable.artifactRef 指向的
 * 内容依然是批准时刻冻结的 bytes。
 *
 * Run: node test/approve-final-deliverable-frozen-candidate.test.js
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHub } from '../src/core/hub.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('schema v2 项目批准真实文件 deliverable 后，artifactRef 指向 frozen 副本，且不受工作文件后续修改影响', () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'kswarm-approve-frozen-'));
  try {
    mkdirSync(join(workspaceRoot, 'artifacts'), { recursive: true });
    const workingFilePath = join(workspaceRoot, 'artifacts', 'final-report.md');
    const originalContent = '# Final Report\n\nApproved content.';
    writeFileSync(workingFilePath, originalContent);

    const hub = createHub({ silent: true });
    const projectId = 'proj-frozen-1';
    hub.createProject({
      id: projectId, name: projectId, goal: 'goal', poAgent: 'po', members: ['worker'],
      executionGateSchemaVersion: 2,
    });
    const created = hub.handleCreateTasks(projectId, [
      { id: 'item-1', title: 'Prepare document', brief: 'Do it', assignedAgent: 'worker', dependencies: [] },
    ], 'po');
    hub.handleApprove(projectId);
    const board = hub.getBoard(projectId);
    const task = board.getTask(created.taskIds[0]);
    board.transition(task.id, 'dispatched', { assignedAgent: 'worker', runId: 'r1' });
    board.transition(task.id, 'accepted', { assignedAgent: 'worker' });
    board.transition(task.id, 'in_progress');
    const submit = hub.handleSubmitResult(projectId, task.id, {
      summary: 'x',
      workFolder: workspaceRoot,
      artifacts: [{ artifactId: 'final-report', path: workingFilePath }],
    }, 'worker', 'r1');
    assert.equal(submit.ok, true, JSON.stringify(submit));
    hub.handleQualityReview(projectId, task.id, { passed: true, feedback: 'ok' }, 'po');

    const delivered = hub.handleDeliver(projectId, {
      summary: 'x',
      artifactRef: { path: workingFilePath, artifactId: 'final-report' },
    }, 'po', {
      taskId: task.id,
      workFolder: workspaceRoot,
      expectedFormat: 'markdown',
    });
    assert.equal(delivered.ok, true, JSON.stringify(delivered));

    const approved = hub.approveFinalDeliverable(projectId, delivered.finalDeliverable.deliverableId, {
      approvalIdempotencyKey: 'k-frozen-1',
    }, { requestSource: 'user', actorId: 'user-1' });
    assert.equal(approved.ok, true, JSON.stringify(approved));
    assert.equal(approved.finalDeliverable.artifactRef.frozen, true, 'approved artifactRef 必须标记为 frozen');
    assert.notEqual(approved.finalDeliverable.artifactRef.path, workingFilePath, 'frozen 后 path 必须指向冻结副本而不是原始工作文件');

    const frozenContentAtApproval = readFileSync(approved.finalDeliverable.artifactRef.path, 'utf-8');
    assert.equal(frozenContentAtApproval, originalContent);

    // 批准之后，原始工作文件被后续操作覆写（真实场景：同一任务被 retry，或者
    // 用户/agent 后续又修改了同一路径）。
    writeFileSync(workingFilePath, '# Tampered\n\nThis should not affect the approved deliverable.');

    const frozenContentAfterTamper = readFileSync(approved.finalDeliverable.artifactRef.path, 'utf-8');
    assert.equal(frozenContentAfterTamper, originalContent, 'frozen 副本必须不受工作文件后续修改影响');
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('schema v1（legacy）项目批准真实文件 deliverable 时不冻结，artifactRef 保持指向原始工作文件路径（不引入回归）', () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'kswarm-approve-frozen-v1-'));
  try {
    mkdirSync(join(workspaceRoot, 'artifacts'), { recursive: true });
    const workingFilePath = join(workspaceRoot, 'artifacts', 'final-report.md');
    writeFileSync(workingFilePath, '# Legacy Report');

    const hub = createHub({ silent: true });
    const projectId = 'proj-frozen-v1';
    hub.createProject({ id: projectId, name: projectId, goal: 'goal', poAgent: 'po', members: ['worker'] });
    const created = hub.handleCreateTasks(projectId, [
      { id: 'item-1', title: 'Prepare document', brief: 'Do it', assignedAgent: 'worker', dependencies: [] },
    ], 'po');
    hub.handleApprove(projectId);
    const board = hub.getBoard(projectId);
    const task = board.getTask(created.taskIds[0]);
    board.transition(task.id, 'dispatched', { assignedAgent: 'worker', runId: 'r1' });
    board.transition(task.id, 'accepted', { assignedAgent: 'worker' });
    board.transition(task.id, 'in_progress');
    board.transition(task.id, 'submitted', { result: { summary: 'x', artifacts: [] }, runId: 'r1' });
    hub.handleQualityReview(projectId, task.id, { passed: true, feedback: 'ok' }, 'po');

    const delivered = hub.handleDeliver(projectId, {
      summary: 'x',
      artifactRef: { path: workingFilePath, artifactId: 'final-report' },
    }, 'po', {
      taskId: task.id,
      workFolder: workspaceRoot,
      expectedFormat: 'markdown',
    });
    assert.equal(delivered.ok, true, JSON.stringify(delivered));

    const approved = hub.approveFinalDeliverable(projectId, delivered.finalDeliverable.deliverableId, {
      approvalIdempotencyKey: 'k-frozen-v1-1',
    }, { requestSource: 'user', actorId: 'user-1' });
    assert.equal(approved.ok, true, JSON.stringify(approved));
    assert.notEqual(approved.finalDeliverable.artifactRef.frozen, true, 'v1 项目不应触发 frozen candidate 机制');
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
console.log(`\n${passed}/${tests.length} approveFinalDeliverable frozen candidate tests passed\n`);
if (failed > 0) process.exit(1);
