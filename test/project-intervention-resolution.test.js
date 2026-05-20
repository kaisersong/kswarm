/**
 * KSwarm — executable intervention resolution tests
 *
 * Run: node --test test/project-intervention-resolution.test.js
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { createHub } from '../src/core/hub.js';

const STORY = [
  '# 初稿',
  '',
  '这是一份由人工干预补全后的任务产物，包含可审核的正文、背景、结论和后续处理说明。',
  '它的长度超过最小门槛，避免把空文件、占位符或错误日志当成完成产物提交。',
  '审核流程应该收到明确的 recovered 标记和 artifact 清单。',
].join('\n');

function setupFailedProject({ bridge = null } = {}) {
  const hub = createHub({
    bridge,
    silent: true,
    getAgentProfiles: () => [
      { id: 'worker', status: 'offline', runtimeHealth: { state: 'unhealthy' } },
    ],
  });
  const project = hub.createProject({
    id: 'proj-resolve',
    name: '外贸趋势分析',
    goal: '完成趋势分析报告',
    poAgent: 'po',
    members: ['worker'],
  });
  assert.equal(hub.handleCreateTasks(project.id, [
    { id: 'item-1', title: '确定数据源与假设基线', assignedAgent: 'worker', maxAttempts: 1 },
    { id: 'item-2', title: '撰写趋势分析', assignedAgent: 'worker', dependencies: ['item-1'] },
  ], 'po').ok, true);
  assert.equal(hub.handleApprove(project.id).ok, true);
  assert.equal(hub.handleTaskFail(project.id, 'item-1', 'quality_content_failed', '产物为空').ok, true);
  const task = hub.getBoard(project.id).getTask('item-1');
  task.qualityFailureCount = 2;
  task.qualityReviewHistory.push({
    passed: false,
    feedback: '补充数据源、假设和可交付正文',
    reviewedAt: Date.now(),
  });
  task.continueRecoveryHistory = [
    { strategy: 'retry_with_repair_instruction', result: 'started', at: Date.now() - 1_000 },
  ];
  return { hub, project, task };
}

function tempArtifactWriter() {
  const dir = mkdtempSync(join(tmpdir(), 'kswarm-resolve-'));
  const artifactsDir = join(dir, 'artifacts');
  mkdirSync(artifactsDir, { recursive: true });
  return {
    dir,
    artifactsDir,
    writeArtifact: ({ path, relativePath, artifactPath }) => {
      const requested = String(path || relativePath || artifactPath || '');
      const filename = basename(requested);
      const fullPath = join(artifactsDir, filename);
      if (!existsSync(fullPath)) return { ok: false, error: 'artifact_missing', status: 404 };
      return { ok: true, filename, path: fullPath, relativePath: `artifacts/${filename}`, size: readFileSync(fullPath).length };
    },
  };
}

test('repair_and_submit writes artifact, recovers failed task, and notifies review', () => {
  const sent = [];
  const bridge = { send: message => sent.push(message) };
  const { hub, project, task } = setupFailedProject({ bridge });
  const writer = tempArtifactWriter();
  writeFileSync(join(writer.artifactsDir, 'foreign_trade_trend.md'), STORY, 'utf8');

  const result = hub.handleResolveProjectIntervention(project.id, {
    idempotencyKey: 'repair-submit-1',
    resolution: 'repair_and_submit',
    fromAgent: 'human',
    expectedPrimaryTaskId: task.id,
    expectedTaskUpdatedAt: task.updatedAt,
    summary: '已补齐外贸趋势分析初稿',
    artifacts: [
      { path: 'artifacts/foreign_trade_trend.md', mimeType: 'text/markdown' },
    ],
  }, writer);

  const updated = hub.getBoard(project.id).getTask(task.id);
  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'submitted_for_review');
  assert.equal(result.projectChanged, true);
  assert.equal(result.reviewNotification, 'sent');
  assert.equal(updated.status, 'submitted');
  assert.equal(updated.recoveryReason, 'intervention_repair_and_submit');
  assert.equal(updated.result.artifacts[0].filename, 'foreign_trade_trend.md');
  assert.equal(updated.result.artifacts[0].relativePath, 'artifacts/foreign_trade_trend.md');
  assert.equal(existsSync(join(writer.artifactsDir, 'foreign_trade_trend.md')), true);
  assert.match(readFileSync(join(writer.artifactsDir, 'foreign_trade_trend.md'), 'utf8'), /人工干预补全/);
  const reviewMessages = sent.filter(message => message.kind === 'review_submission');
  assert.equal(reviewMessages.length, 1);
  assert.equal(reviewMessages[0].toParticipantId, 'po');
});

test('repair_and_submit rejects stale task state without writing artifacts', () => {
  const { hub, project, task } = setupFailedProject();
  const writer = tempArtifactWriter();

  const result = hub.handleResolveProjectIntervention(project.id, {
    idempotencyKey: 'repair-stale',
    resolution: 'repair_and_submit',
    fromAgent: 'human',
    expectedPrimaryTaskId: task.id,
    expectedTaskUpdatedAt: task.updatedAt - 1,
    artifacts: [
      { path: 'artifacts/foreign_trade_trend.md' },
    ],
  }, writer);

  assert.equal(result.ok, false);
  assert.equal(result.error, 'task_state_changed');
  assert.equal(result.status, 409);
  assert.equal(result.projectChanged, false);
  assert.equal(hub.getBoard(project.id).getTask(task.id).status, 'failed');
});

test('repair_and_submit rejects unsafe, missing, and inline artifacts', () => {
  const { hub, project, task } = setupFailedProject();
  const writer = tempArtifactWriter();

  const cases = [
    { path: '../escape.md', error: 'artifact_path_escape' },
    { path: 'artifacts/missing.md', error: 'artifact_missing' },
    { filename: 'inline.md', content: STORY, error: 'inline_content_forbidden' },
  ];

  for (const [index, artifact] of cases.entries()) {
    const result = hub.handleResolveProjectIntervention(project.id, {
      idempotencyKey: `repair-invalid-${index}`,
      resolution: 'repair_and_submit',
      fromAgent: 'human',
      expectedPrimaryTaskId: task.id,
      expectedTaskUpdatedAt: task.updatedAt,
      artifacts: [artifact],
    }, writer);

    assert.equal(result.ok, false);
    assert.equal(result.error, artifact.error);
    assert.equal(result.projectChanged, false);
  }
  assert.equal(hub.getBoard(project.id).getTask(task.id).status, 'failed');
});

test('repair_and_submit is idempotent for same request and rejects same key with different payload', () => {
  const { hub, project, task } = setupFailedProject();
  const writer = tempArtifactWriter();
  writeFileSync(join(writer.artifactsDir, 'foreign_trade_trend.md'), STORY, 'utf8');
  writeFileSync(join(writer.artifactsDir, 'foreign_trade_trend_v2.md'), `${STORY}\n\n新内容`, 'utf8');
  const request = {
    idempotencyKey: 'repair-idempotent',
    resolution: 'repair_and_submit',
    fromAgent: 'human',
    expectedPrimaryTaskId: task.id,
    expectedTaskUpdatedAt: task.updatedAt,
    artifacts: [
      { path: 'artifacts/foreign_trade_trend.md' },
    ],
  };

  const first = hub.handleResolveProjectIntervention(project.id, request, writer);
  const second = hub.handleResolveProjectIntervention(project.id, request, writer);
  const conflict = hub.handleResolveProjectIntervention(project.id, {
    ...request,
    artifacts: [
      { path: 'artifacts/foreign_trade_trend_v2.md' },
    ],
  }, writer);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.idempotent, true);
  assert.equal(conflict.ok, false);
  assert.equal(conflict.error, 'idempotency_conflict');
  assert.equal(conflict.status, 409);
});

test('repair_and_submit succeeds when review notification fails but reports the failure', () => {
  const bridge = {
    send: message => {
      if (message.kind === 'review_submission') throw new Error('broker offline');
    },
  };
  const { hub, project, task } = setupFailedProject({ bridge });
  const writer = tempArtifactWriter();
  writeFileSync(join(writer.artifactsDir, 'foreign_trade_trend.md'), STORY, 'utf8');

  const result = hub.handleResolveProjectIntervention(project.id, {
    idempotencyKey: 'repair-notify-failed',
    resolution: 'repair_and_submit',
    fromAgent: 'human',
    expectedPrimaryTaskId: task.id,
    expectedTaskUpdatedAt: task.updatedAt,
    artifacts: [
      { path: 'artifacts/foreign_trade_trend.md' },
    ],
  }, writer);

  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'submitted_for_review');
  assert.equal(result.reviewNotification, 'failed');
  assert.match(result.reviewNotificationError, /broker offline/);
  assert.equal(hub.getBoard(project.id).getTask(task.id).status, 'submitted');
});
