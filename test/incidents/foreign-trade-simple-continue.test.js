/**
 * Incident regression — foreign trade project simple continue
 *
 * Run: node test/incidents/foreign-trade-simple-continue.test.js
 */

import assert from 'node:assert/strict';
import { createHub } from '../../src/core/hub.js';

const agents = [
  { id: 'cli-codex', status: 'idle', runtimeHealth: { state: 'cooldown', cooldownUntil: Date.now() + 120_000 } },
  { id: 'cli-xiaok', status: 'idle', runtimeHealth: { state: 'healthy', taskCapabilities: ['analysis'], outputCapabilities: ['markdown'] } },
];

const hub = createHub({ silent: true, getAgentProfiles: () => agents });
hub.createProject({
  id: 'proj-foreign-trade',
  name: '本月外贸趋势分析',
  goal: '分析本月外贸趋势并形成报告',
  poAgent: 'po',
  members: ['cli-codex', 'cli-xiaok'],
});
hub.handleCreateTasks('proj-foreign-trade', [
  {
    id: 'item-1',
    title: '确定数据源与假设基线',
    assignedAgent: 'cli-codex',
    maxAttempts: 1,
  },
  {
    id: 'item-1-retry-2',
    title: '重试确定数据源与假设基线',
    assignedAgent: 'cli-codex',
    parentTaskId: 'item-1',
    maxAttempts: 1,
  },
  {
    id: 'item-2',
    title: '生成模拟数据集',
    assignedAgent: 'cli-xiaok',
    dependencies: ['item-1'],
  },
  {
    id: 'item-3',
    title: '撰写外贸趋势报告',
    assignedAgent: 'cli-xiaok',
    dependencies: ['item-2'],
  },
], 'po');
hub.handleApprove('proj-foreign-trade');

const board = hub.getBoard('proj-foreign-trade');
hub.handleTaskFail('proj-foreign-trade', 'item-1', 'quality_content_failed', '缺少主要贸易伙伴、人民币汇率、政策变动清单、热点事件列表');
const root = board.getTask('item-1');
root.qualityFailureCount = 17;
root.qualityReviewHistory.push({
  passed: false,
  feedback: '缺少主要贸易伙伴、人民币汇率、政策变动清单、热点事件列表',
  reviewedAt: Date.now(),
});
const retry = board.getTask('item-1-retry-2');
const retryFailed = board.transition(retry.id, 'failed', { failureReason: 'agent_error' });
assert.equal(retryFailed.ok, true);

const intervention = hub.getProjectIntervention('proj-foreign-trade');

assert.equal(intervention.required, true);
assert.equal(intervention.primaryAction.id, 'continue_project');
assert.equal(intervention.secondaryAction.id, 'ask_xiaok');
assert.notEqual(intervention.primaryAction.strategy, 'accept_continue');
assert.notEqual(intervention.primaryAction.strategy, 'skip_task');
assert.match(intervention.message, /后续 2 个任务/);

const before = board.getTask(intervention.primaryTaskId);
const result = hub.handleContinueProject('proj-foreign-trade', {
  expectedPrimaryTaskId: before.id,
  expectedTaskUpdatedAt: before.updatedAt,
  idempotencyKey: 'foreign-trade-continue-1',
});

if (result.ok) {
  const after = board.getTask(before.id);
  assert.equal(result.action, 'continue_project');
  assert.equal(result.strategy, 'retry_with_repair_instruction');
  assert.deepEqual(result.dispatched, [before.id]);
  assert.equal(after.status, 'dispatched');
  assert.equal(after.assignedAgent, 'cli-xiaok');
  assert.notEqual(after.status, 'done');
} else {
  assert.equal(result.strategy, 'needs_conversation');
  assert.equal(board.getTask(before.id).status, before.status);
  assert.equal(result.xiaokContext.projectId, 'proj-foreign-trade');
}

console.log('✓ foreign trade simple continue regression passed');
