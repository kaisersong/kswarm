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
        qualityFailureCount: 1,
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

test('submitted task without review exposes notify PO review intervention', () => {
  const result = deriveProjectIntervention({
    project: { id: 'proj-review', name: 'OpenAI本月分析', status: 'active' },
    tasks: [
      {
        id: 'item-6',
        title: '撰写报告初稿',
        status: 'submitted',
        updatedAt: 1779218237502,
        assignedAgent: 'xiaok-po',
        result: {
          summary: 'OpenAI 本月分析报告',
          artifactManifest: [{ filename: 'openai_monthly_report_v38.md', path: 'artifacts/openai_monthly_report_v38.md' }],
        },
      },
      { id: 'item-7', title: '审校报告', status: 'pending', dependencies: ['item-6'] },
      { id: 'item-8', title: '生成最终稿', status: 'pending', dependencies: ['item-7'] },
    ],
    agents: [{ id: 'xiaok-po', status: 'idle', runtimeHealth: { state: 'healthy' } }],
  });

  assert.equal(result.required, true);
  assert.equal(result.primaryTaskId, 'item-6');
  assert.equal(result.primaryAction.id, 'continue_project');
  assert.equal(result.primaryAction.strategy, 'notify_po_review');
  assert.equal(result.secondaryAction.id, 'ask_xiaok');
  assert.match(result.message, /等待 PO 复审/);
  assert.match(result.message, /后续 2 个任务/);
});

test('artifact type mismatch exposes output contract repair strategy with missing output', () => {
  const result = deriveProjectIntervention({
    project: { id: 'proj-output-contract', name: 'OpenAI动态分析', status: 'active' },
    tasks: [
      {
        id: 'item-1',
        title: 'OpenAI 5月动态搜索',
        status: 'failed',
        updatedAt: 1779553938379,
        assignedAgent: 'xiaok-po',
        failureReason: 'artifact_type_mismatch',
        lastFailureClass: 'artifact_type_mismatch',
        rejectedSubmissions: [{
          failureClass: 'artifact_type_mismatch',
          missing: ['markdown'],
          errors: ['missing required output: markdown'],
        }],
      },
      { id: 'item-2', title: '综合分析', status: 'pending', dependencies: ['item-1'] },
    ],
    agents: [{ id: 'xiaok-po', status: 'idle', runtimeHealth: { state: 'healthy' } }],
  });

  assert.equal(result.required, true);
  assert.equal(result.primaryTaskId, 'item-1');
  assert.equal(result.primaryAction.strategy, 'repair_output_contract');
  assert.equal(result.primaryFailure.reason, 'artifact_type_mismatch');
  assert.deepEqual(result.primaryFailure.missing, ['markdown']);
  assert.match(result.message, /缺少必须产物/);
});

test('submitted task waiting for review outranks stale retry child failure', () => {
  const result = deriveProjectIntervention({
    project: { id: 'proj-review-mixed', name: 'OpenAI本月分析', status: 'active' },
    tasks: [
      {
        id: 'item-6',
        title: '撰写报告初稿',
        status: 'submitted',
        updatedAt: 1779218237502,
        assignedAgent: 'xiaok-po',
        failureReason: 'model_empty_output',
        qualityFailureCount: 38,
        result: {
          summary: 'OpenAI 本月分析报告',
          artifactManifest: [{ filename: 'openai_monthly_report_v38.md', path: 'artifacts/openai_monthly_report_v38.md' }],
        },
      },
      {
        id: 'item-6-retry-1',
        title: '撰写报告初稿',
        status: 'failed',
        parentTaskId: 'item-6',
        updatedAt: 1779219000000,
        assignedAgent: 'xiaok-po@proj-review-mixed',
        failureReason: 'runtime_stalled',
      },
      { id: 'item-7', title: '审校报告', status: 'pending', dependencies: ['item-6'] },
    ],
    agents: [{ id: 'xiaok-po', status: 'idle', runtimeHealth: { state: 'healthy' } }],
  });

  assert.equal(result.required, true);
  assert.equal(result.primaryTaskId, 'item-6');
  assert.equal(result.primaryAction.strategy, 'notify_po_review');
});

test('fresh submitted task with stale failed review outranks non-blocking historical failure', () => {
  const result = deriveProjectIntervention({
    project: { id: 'proj-current-review', name: 'Claude 本月动态分析', status: 'active' },
    tasks: [
      {
        id: 'historical-failed',
        title: '持续采集并归档原始数据',
        status: 'failed',
        updatedAt: 1779290057566,
        assignedAgent: 'cli-xiaok',
        failureReason: 'runtime_offline',
        lastFailureClass: 'runtime_offline',
        qualityFailureCount: 3,
        qualityReviewHistory: [{
          passed: false,
          feedback: '旧任务未按每日目录归档，但后续任务暂未依赖它',
          reviewedAt: 1779290000000,
        }],
      },
      {
        id: 'current-review',
        title: '识别重要更新与变化趋势',
        status: 'submitted',
        updatedAt: 1779290477783,
        assignedAgent: 'xiaok-worker',
        result: {
          summary: '新一轮返工后的分析笔记',
          artifactManifest: [{ filename: 'analysis.md', path: 'artifacts/analysis.md' }],
        },
        reviewResult: {
          passed: false,
          feedback: '上一轮失败反馈',
          reviewedAt: 1779290455173,
        },
        qualityReviewHistory: [{
          passed: false,
          feedback: '上一轮失败反馈',
          reviewedAt: 1779290455173,
        }],
      },
      { id: 'next', title: '撰写报告初稿', status: 'pending', dependencies: ['current-review'] },
    ],
    agents: [{ id: 'xiaok-worker', status: 'idle', runtimeHealth: { state: 'healthy' } }],
  });

  assert.equal(result.required, true);
  assert.equal(result.primaryTaskId, 'current-review');
  assert.equal(result.primaryAction.strategy, 'notify_po_review');
  assert.match(result.message, /等待 PO 复审/);
});

test('downstream final deliverable blocker outranks non-blocking historical quality failure', () => {
  const result = deriveProjectIntervention({
    project: { id: 'proj-final-blocker', name: 'Claude 本月动态分析', status: 'active' },
    tasks: [
      {
        id: 'p1-item3',
        title: '持续采集并归档原始数据',
        status: 'failed',
        updatedAt: 1779290057566,
        assignedAgent: 'cli-xiaok',
        failureReason: 'runtime_offline',
        lastFailureClass: 'runtime_offline',
        qualityFailureCount: 3,
        qualityReviewHistory: [{
          passed: false,
          feedback: '旧任务仍有质量反馈，但当前后续任务不再依赖它',
          reviewedAt: 1779290000000,
        }],
      },
      {
        id: 'p3-item2',
        title: '内部审核与修订',
        status: 'done',
        updatedAt: 1779292514624,
        result: {
          summary: '报告已经通过内部审核',
          artifactManifest: [{ filename: 'reviewed-report.md', path: 'artifacts/reviewed-report.md' }],
        },
      },
      {
        id: 'p4-item1',
        title: '生成最终 Markdown 文件',
        status: 'failed',
        updatedAt: 1779292530907,
        assignedAgent: 'cli-xiaok',
        failureReason: 'runtime_offline',
        lastFailureClass: 'runtime_offline',
        dependencies: ['p3-item2'],
      },
      {
        id: 'p4-item2',
        title: '项目总结与复盘',
        status: 'pending',
        assignedAgent: 'xiaok-po',
        dependencies: ['p4-item1'],
      },
    ],
    agents: [
      { id: 'cli-xiaok', status: 'idle', runtimeHealth: { state: 'healthy' } },
      { id: 'xiaok-worker', status: 'idle', runtimeHealth: { state: 'healthy' } },
    ],
  });

  assert.equal(result.required, true);
  assert.equal(result.primaryTaskId, 'p4-item1');
  assert.equal(result.primaryAction.strategy, 'retry_best_agent');
  assert.equal(result.downstreamBlockedCount, 1);
  assert.match(result.message, /后续 1 个任务/);
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
        blockKind: 'quality_gate_blocked',
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

test('plan revision required temporal block requires Xiaok conversation', () => {
  const result = deriveProjectIntervention({
    project: { id: 'proj-temporal', name: 'Claude 本月动态分析', status: 'active' },
    now: Date.UTC(2026, 4, 20, 4, 0, 0),
    tasks: [
      {
        id: 'p1-item3',
        title: '持续采集并归档原始数据',
        status: 'blocked',
        updatedAt: 1779289436398,
        assignedAgent: 'cli-xiaok',
        blockKind: 'plan_revision_required',
        blockedReason: '覆盖范围仅5月1日至20日，缺少5月21-31日数据',
        lastFailureClass: 'quality_temporal_impossible',
        qualityFailureCount: 1,
        reviewResult: {
          passed: false,
          feedback: '覆盖范围仅5月1日至20日，缺少5月21-31日数据',
          reviewedAt: 1779289436398,
        },
        qualityReviewHistory: [{
          passed: false,
          feedback: '覆盖范围仅5月1日至20日，缺少5月21-31日数据',
          reviewedAt: 1779289436398,
        }],
      },
      { id: 'p2-item1', title: '清洗去重与分类', status: 'pending', dependencies: ['p1-item3'] },
    ],
    agents: [{ id: 'cli-xiaok', status: 'idle', runtimeHealth: { state: 'healthy' } }],
  });

  assert.equal(result.required, true);
  assert.equal(result.primaryTaskId, 'p1-item3');
  assert.equal(result.primaryAction.strategy, 'needs_conversation');
  assert.equal(result.severity, 'warning');
  assert.match(result.message, /需要让小K帮忙/);
});

test('misclassified temporal quality block retries when feedback has no future date', () => {
  const feedback = '证据文件残缺：缺少完整抓取记录、URL、日期、命中标题。3条动态日期落在5月窗口之前，8条动态仅有月份缺具体日期，需补齐证据文件。';
  const result = deriveProjectIntervention({
    project: { id: 'proj-current-month', name: '2026年5月产品动态分析', status: 'active' },
    now: Date.UTC(2026, 4, 25, 4, 0, 0),
    tasks: [
      {
        id: 'item-1',
        title: '研究 Claude 2026年5月动态',
        status: 'blocked',
        updatedAt: Date.UTC(2026, 4, 25, 4, 0, 0),
        assignedAgent: 'xiaok-worker',
        blockKind: 'plan_revision_required',
        blockedReason: feedback,
        failureReason: feedback,
        lastFailureClass: 'quality_temporal_impossible',
        qualityFailureCount: 1,
        reviewResult: { passed: false, feedback, reviewedAt: Date.UTC(2026, 4, 25, 4, 0, 0) },
        qualityReviewHistory: [{ passed: false, feedback, reviewedAt: Date.UTC(2026, 4, 25, 4, 0, 0) }],
      },
    ],
    agents: [{ id: 'xiaok-worker', status: 'offline', brokerOnline: true, runtimeHealth: { source: 'desktop-agent-runtime' } }],
  });

  assert.equal(result.required, true);
  assert.equal(result.primaryTaskId, 'item-1');
  assert.equal(result.primaryAction.strategy, 'retry_with_repair_instruction');
});

test('repeated quality failures require Xiaok repair instead of another automatic retry', () => {
  const result = deriveProjectIntervention({
    project: { id: 'proj-quality-loop', name: 'OpenAI本月分析', status: 'active' },
    tasks: [
      {
        id: 'report',
        title: '撰写报告草稿',
        status: 'failed',
        updatedAt: 1779201306940,
        assignedAgent: 'xiaok-po',
        failureReason: 'model_empty_output',
        lastFailureClass: 'model_empty_output',
        qualityFailureCount: 3,
        reviewResult: {
          passed: false,
          feedback: '报告缺少后续章节和引用标注',
          reviewedAt: 1779201178515,
        },
        qualityReviewHistory: [{
          passed: false,
          feedback: '报告缺少后续章节和引用标注',
          reviewedAt: 1779201178515,
        }],
      },
      { id: 'review', title: '综合审核报告', status: 'pending', dependencies: ['report'] },
    ],
    agents: [{ id: 'xiaok-po', status: 'idle', runtimeHealth: { state: 'healthy' } }],
  });

  assert.equal(result.required, true);
  assert.equal(result.primaryTaskId, 'report');
  assert.equal(result.primaryAction.strategy, 'needs_conversation');
  assert.equal(result.severity, 'warning');
  assert.match(result.message, /需要让小K帮忙/);
});

test('started repair retry recovery requires Xiaok repair instead of repeating continue', () => {
  const result = deriveProjectIntervention({
    project: { id: 'proj-started-recovery', name: '外贸趋势分析', status: 'active' },
    tasks: [
      {
        id: 'translation',
        title: '翻译英文版报告',
        status: 'failed',
        updatedAt: 1779194651857,
        assignedAgent: 'xiaok-po',
        failureReason: 'agent_error',
        lastFailureClass: 'quality_content_failed',
        qualityFailureCount: 1,
        continueRecoveryHistory: [{
          strategy: 'retry_with_repair_instruction',
          result: 'started',
          at: 1779176978294,
        }],
        qualityReviewHistory: [{
          passed: false,
          feedback: '英文翻译版内容缺失',
          reviewedAt: 1779194504077,
        }],
      },
      { id: 'html', title: '生成HTML版报告', status: 'pending', dependencies: ['translation'] },
    ],
    agents: [{ id: 'xiaok-po', status: 'idle', runtimeHealth: { state: 'healthy' } }],
  });

  assert.equal(result.required, true);
  assert.equal(result.primaryTaskId, 'translation');
  assert.equal(result.primaryAction.strategy, 'needs_conversation');
  assert.match(result.message, /需要让小K帮忙/);
});

test('failed retry child does not mask parent quality deadloop', () => {
  const result = deriveProjectIntervention({
    project: { id: 'proj-retry-mask', name: '外贸趋势分析', status: 'active' },
    tasks: [
      {
        id: 'translation',
        title: '翻译英文版报告',
        status: 'failed',
        updatedAt: 1779194651857,
        assignedAgent: 'xiaok-po',
        failureReason: 'agent_error',
        lastFailureClass: 'quality_content_failed',
        qualityFailureCount: 25,
        continueRecoveryHistory: [{
          strategy: 'retry_with_repair_instruction',
          result: 'started',
          at: 1779176978294,
        }],
        qualityReviewHistory: [{
          passed: false,
          feedback: '英文报告内容缺失，需要完整修复产物',
          reviewedAt: 1779194504077,
        }],
      },
      {
        id: 'translation-retry-1',
        title: '翻译英文版报告',
        status: 'failed',
        parentTaskId: 'translation',
        updatedAt: 1779197954736,
        assignedAgent: 'xiaok-po@proj-retry-mask',
        failureReason: 'runtime_stalled',
      },
      { id: 'html', title: '生成HTML版报告', status: 'pending', dependencies: ['translation'] },
    ],
    agents: [{ id: 'xiaok-po', status: 'idle', runtimeHealth: { state: 'healthy' } }],
  });

  assert.equal(result.required, true);
  assert.equal(result.primaryTaskId, 'translation');
  assert.equal(result.primaryAction.strategy, 'needs_conversation');
  assert.match(result.primaryFailure.feedback, /完整修复产物/);
});

test('quality deadloop outranks retryable runtime failure blockers', () => {
  const result = deriveProjectIntervention({
    project: { id: 'proj-mixed-blockers', name: '外贸趋势分析', status: 'active' },
    tasks: [
      {
        id: 'translation',
        title: '翻译英文版报告',
        status: 'failed',
        updatedAt: 1779194651857,
        assignedAgent: 'xiaok-po',
        lastFailureClass: 'quality_content_failed',
        qualityFailureCount: 25,
        qualityReviewHistory: [{
          passed: false,
          feedback: '英文翻译缺少正文，需要小K生成完整修复产物',
          reviewedAt: 1779194504077,
        }],
      },
      {
        id: 'chart',
        title: '设计并生成可视化图表',
        status: 'failed',
        updatedAt: 1779194700000,
        assignedAgent: 'xiaok-worker',
        failureReason: 'runtime_stalled',
      },
      {
        id: 'chart-retry-1',
        title: '设计并生成可视化图表',
        status: 'failed',
        parentTaskId: 'chart',
        updatedAt: 1779197954736,
        assignedAgent: 'xiaok-worker@proj-mixed-blockers',
        failureReason: 'runtime_stalled',
      },
      { id: 'html', title: '生成HTML版报告', status: 'pending', dependencies: ['translation', 'chart'] },
    ],
    agents: [{ id: 'xiaok-po', status: 'idle', runtimeHealth: { state: 'healthy' } }],
  });

  assert.equal(result.required, true);
  assert.equal(result.primaryTaskId, 'translation');
  assert.equal(result.primaryAction.strategy, 'needs_conversation');
  assert.match(result.message, /需要让小K帮忙/);
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
        blockKind: 'quality_gate_blocked',
        blockedReason: '缺失主要贸易伙伴进出口额、人民币汇率、政策变动清单、热点事件列表',
        qualityFailureCount: 2,
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

test('failed retry child does not mask submitted parent waiting for review', () => {
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

  assert.equal(result.required, true);
  assert.equal(result.primaryTaskId, 'task-a');
  assert.equal(result.primaryAction.strategy, 'notify_po_review');
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
