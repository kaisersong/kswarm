/**
 * KSwarm — simplified project intervention read model tests
 *
 * Run: node test/project-intervention.test.js
 */

import assert from 'node:assert/strict';
import { deriveProjectIntervention } from '../src/core/project-intervention.js';
import { createHub } from '../src/core/hub.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('failed dependency root exposes one continue action', () => {
  const result = deriveProjectIntervention({
    project: { id: 'proj-1', name: '外贸趋势分析', status: 'active' },
    tasks: [
      {
        id: 'item-1',
        title: '确定数据源与假设基线',
        status: 'failed',
        assignedAgent: 'cli-codex',
        updatedAt: 1779093510355,
        failureReason: 'agent_error',
        qualityFailureCount: 17,
        qualityReviewHistory: [{
          passed: false,
          feedback: '缺少主要贸易伙伴、人民币汇率、政策变动清单、热点事件列表',
          reviewedAt: 1779092934484,
        }],
      },
      { id: 'item-2', title: '生成模拟数据集', status: 'pending', dependencies: ['item-1'] },
      { id: 'item-3', title: '编写报告', status: 'pending', dependencies: ['item-2'] },
    ],
    agents: [{ id: 'cli-xiaok', status: 'idle', runtimeHealth: { state: 'healthy' }, capabilities: ['planning', 'coding'] }],
    dispatchPlan: { blocked: [{ taskId: 'item-2', reason: 'dependency_pending', dependencies: ['item-1'] }] },
    now: 1779094300000,
  });

  assert.equal(result.required, true);
  assert.equal(result.primaryTaskId, 'item-1');
  assert.equal(result.primaryAction.id, 'continue_project');
  assert.equal(result.primaryAction.label, '继续推进');
  assert.equal(result.primaryAction.strategy, 'retry_with_repair_instruction');
  assert.equal(result.secondaryAction.id, 'ask_xiaok');
  assert.equal(result.secondaryAction.label, '让小K帮忙');
  assert.equal(result.downstreamBlockedCount, 2);
  assert.match(result.message, /后续 2 个任务/);
  assert.equal(result.actions, undefined);
});

test('durable artifact interruption returns recover submission strategy', () => {
  const result = deriveProjectIntervention({
    project: { id: 'proj-2', name: '文稿项目', status: 'active' },
    tasks: [
      {
        id: 'draft',
        title: '写初稿',
        status: 'failed',
        updatedAt: 1779093510000,
        assignedAgent: 'cli-claude',
        failureReason: 'run_interrupted',
        lastRunLease: {
          runId: 'run-1',
          assignedAgent: 'cli-claude',
          artifactManifest: [{ filename: 'draft.md', path: '/tmp/draft.md' }],
        },
      },
      { id: 'review', title: '修订', status: 'pending', dependencies: ['draft'] },
    ],
    agents: [{ id: 'cli-claude', status: 'idle', runtimeHealth: { state: 'healthy' } }],
  });

  assert.equal(result.required, true);
  assert.equal(result.primaryTaskId, 'draft');
  assert.equal(result.primaryAction.strategy, 'recover_submission');
});

test('quality feedback returns repair retry strategy', () => {
  const result = deriveProjectIntervention({
    project: { id: 'proj-3', name: '报告项目', status: 'active' },
    tasks: [
      {
        id: 'analysis',
        title: '趋势分析',
        status: 'blocked',
        updatedAt: 1779093510000,
        assignedAgent: 'cli-qoder',
        blockKind: 'executor_quality_blocked',
        blockedReason: '质量验收未通过',
        qualityFailureCount: 2,
        qualityReviewHistory: [{ passed: false, feedback: '缺少数据来源' }],
      },
    ],
    agents: [{ id: 'cli-xiaok', status: 'idle', runtimeHealth: { state: 'healthy' } }],
  });

  assert.equal(result.required, true);
  assert.equal(result.primaryTaskId, 'analysis');
  assert.equal(result.primaryAction.strategy, 'retry_with_repair_instruction');
  assert.match(result.primaryFailure.feedback, /缺少数据来源/);
});

test('rejected recovered artifact uses repair retry instead of recover submission', () => {
  const result = deriveProjectIntervention({
    project: { id: 'proj-3b', name: '外贸趋势分析', status: 'active' },
    tasks: [
      {
        id: 'data-baseline',
        title: '确定数据源与假设基线',
        status: 'blocked',
        updatedAt: 1779116630994,
        assignedAgent: 'xiaok-po',
        result: { artifacts: [{ filename: 'data-baseline.json', path: '/tmp/data-baseline.json' }] },
        recoveryStatus: 'recovered',
        recoveredAt: 1779115404459,
        blockKind: 'executor_quality_blocked',
        blockedReason: '缺失主要贸易伙伴进出口额、人民币汇率、政策变动清单、热点事件列表',
        qualityFailureCount: 18,
        reviewResult: {
          passed: false,
          feedback: '缺失主要贸易伙伴进出口额、人民币汇率、政策变动清单、热点事件列表',
          reviewedAt: 1779116630994,
        },
        qualityReviewHistory: [{
          passed: false,
          feedback: '缺失主要贸易伙伴进出口额、人民币汇率、政策变动清单、热点事件列表',
          reviewedAt: 1779116630994,
        }],
      },
    ],
    agents: [{ id: 'cli-xiaok', status: 'idle', runtimeHealth: { state: 'healthy' } }],
  });

  assert.equal(result.required, true);
  assert.equal(result.primaryTaskId, 'data-baseline');
  assert.equal(result.primaryAction.strategy, 'retry_with_repair_instruction');
  assert.match(result.message, /质量反馈重新执行/);
});

test('retry child success with failed parent returns complete retry parent strategy', () => {
  const result = deriveProjectIntervention({
    project: { id: 'proj-4', name: '修复项目', status: 'active' },
    tasks: [
      { id: 'task-a', title: '生成报告', status: 'failed', updatedAt: 1779093510000 },
      {
        id: 'task-a-retry-2',
        title: '重试生成报告',
        status: 'done',
        parentTaskId: 'task-a',
        updatedAt: 1779093520000,
        result: { summary: '已完成' },
      },
    ],
    agents: [{ id: 'cli-xiaok', status: 'idle', runtimeHealth: { state: 'healthy' } }],
  });

  assert.equal(result.required, true);
  assert.equal(result.primaryTaskId, 'task-a');
  assert.equal(result.primaryAction.strategy, 'complete_retry_parent');
});

test('failed retry child does not require intervention after parent is submitted', () => {
  const result = deriveProjectIntervention({
    project: { id: 'proj-4b', name: '恢复项目', status: 'active' },
    tasks: [
      {
        id: 'task-a',
        title: '确定数据源与假设基线',
        status: 'submitted',
        updatedAt: 1779093600000,
        result: { artifacts: [{ filename: 'data.json', path: '/tmp/data.json' }] },
      },
      {
        id: 'task-a-retry-1',
        title: '确定数据源与假设基线',
        status: 'failed',
        parentTaskId: 'task-a',
        updatedAt: 1779093510000,
        failureReason: 'agent_error',
      },
    ],
    agents: [{ id: 'cli-xiaok', status: 'idle', runtimeHealth: { state: 'healthy' } }],
  });

  assert.equal(result.required, false);
  assert.equal(result.reason, 'no_blocking_task');
});

test('failed retry child does not require intervention while parent is in progress', () => {
  const result = deriveProjectIntervention({
    project: { id: 'proj-4c', name: '恢复项目', status: 'active' },
    tasks: [
      {
        id: 'task-a',
        title: '确定数据源与假设基线',
        status: 'in_progress',
        updatedAt: 1779116925692,
        activeRunId: 'run-task-a',
        assignedAgent: 'cli-xiaok',
      },
      {
        id: 'task-a-retry-1',
        title: '确定数据源与假设基线',
        status: 'failed',
        parentTaskId: 'task-a',
        updatedAt: 1779093510000,
        failureReason: 'agent_error',
      },
    ],
    agents: [{ id: 'cli-xiaok', status: 'busy', runtimeHealth: { state: 'healthy' } }],
    now: 1779117000000,
  });

  assert.equal(result.required, false);
  assert.equal(result.reason, 'no_blocking_task');
});

test('unsafe state returns needs conversation without mutation action', () => {
  const result = deriveProjectIntervention({
    project: { id: 'proj-5', name: '无人可用项目', status: 'active' },
    tasks: [
      {
        id: 'task-a',
        title: '生成报告',
        status: 'failed',
        updatedAt: 1779093510000,
        assignedAgent: 'cli-qoder',
        failureReason: 'agent_error',
      },
    ],
    agents: [{ id: 'cli-qoder', status: 'offline', runtimeHealth: { state: 'unhealthy' } }],
  });

  assert.equal(result.required, true);
  assert.equal(result.primaryTaskId, 'task-a');
  assert.equal(result.primaryAction.id, 'continue_project');
  assert.equal(result.primaryAction.strategy, 'needs_conversation');
  assert.equal(result.secondaryAction.id, 'ask_xiaok');
  assert.match(result.message, /需要让小K帮忙/);
});

test('unexpired active lease does not require intervention', () => {
  const result = deriveProjectIntervention({
    project: { id: 'proj-6', name: '运行中项目', status: 'active' },
    tasks: [
      {
        id: 'task-a',
        title: '生成报告',
        status: 'in_progress',
        updatedAt: 1779093510000,
        assignedAgent: 'cli-qoder',
        activeRunId: 'run-active',
        runLease: {
          runId: 'run-active',
          assignedAgent: 'cli-qoder',
          leaseExpiresAt: 1779094500000,
        },
      },
      { id: 'task-b', title: '审校', status: 'pending', dependencies: ['task-a'] },
    ],
    agents: [{ id: 'cli-qoder', status: 'busy', runtimeHealth: { state: 'healthy' } }],
    now: 1779094300000,
  });

  assert.equal(result.required, false);
  assert.equal(result.primaryAction, null);
  assert.equal(result.secondaryAction.id, 'ask_xiaok');
});

test('hub exposes intervention from current project state', () => {
  const hub = createHub({ silent: true });
  hub.createProject({ id: 'proj-hub', name: 'Hub Project', goal: 'goal', poAgent: 'po', members: ['worker'] });
  hub.handleCreateTasks('proj-hub', [
    { id: 'root', title: 'Root', assignedAgent: 'worker' },
    { id: 'next', title: 'Next', assignedAgent: 'worker', dependencies: ['root'] },
  ], 'po');
  hub.handleApprove('proj-hub');
  hub.handleTaskFail('proj-hub', 'root', 'agent_error', 'CLI failed');
  const root = hub.getBoard('proj-hub').getTask('root');

  const result = hub.getProjectIntervention('proj-hub');

  assert.equal(result.required, true);
  assert.equal(result.primaryTaskId, root.id);
  assert.equal(result.primaryAction.id, 'continue_project');
  assert.equal(result.secondaryAction.id, 'ask_xiaok');
});

let passed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    passed++;
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(err);
    process.exitCode = 1;
    break;
  }
}
if (process.exitCode !== 1) {
  console.log(`\n${passed}/${tests.length} project intervention tests passed`);
}
