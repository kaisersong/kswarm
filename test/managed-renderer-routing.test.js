import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selectTaskExecutionStrategy } from '../src/core/execution-mode.js';
import { createHub } from '../src/core/hub.js';

const project = { executionMode: 'auto' };
const renderTask = { title: 'Generate final deliverable HTML using report-renderer' };
const select = task => selectTaskExecutionStrategy({ project, task });

test('initial managed HTML delivery uses the capable direct worker', () => {
  for (const task of [
    renderTask,
    { title: '使用 report_renderer 渲染最终 HTML' },
    { title: '使用 kai-report-creator 输出最终 HTML' },
    { title: '使用 slide-renderer 生成最终 HTML' },
    { title: '交付报告', requiredOutputs: ['report_html'] },
    { title: '交付报告', requiredOutputs: [{ format: 'html_report' }] },
    { title: '交付幻灯片', requiredOutputs: [{ kind: 'slide_html' }] },
  ]) {
    const result = select(task);
    assert.equal(result.strategy, 'direct', JSON.stringify(task));
    assert.equal(result.reasonCode, 'managed_renderer_direct');
  }
});

test('preparation, ambiguous HTML and Markdown-only steps retain workflows', () => {
  for (const task of [
    { title: '最终 Markdown 准备', brief: '供后续 report-renderer 生成 HTML' },
    { title: '准备最终 HTML 供后续 report-renderer 生成' },
    { title: '最终交付', brief: 'report-renderer 渲染 HTML' },
    { title: '最终 HTML 验收' },
    { title: '最终报告复核', requiredOutputs: [{ type: 'report_html', source: 'inferred' }] },
    { title: '最终 report-renderer HTML 检查' },
    { ...renderTask, requiredOutputs: ['markdown'] },
    { ...renderTask, requiredOutputs: [{ type: 'ir' }] },
    { ...renderTask, requiredOutputs: [{ type: 'markdown', source: 'task' }, { type: 'report_html', source: 'inferred' }] },
  ]) assert.equal(select(task).strategy, 'workflow', JSON.stringify(task));
});

test('all explicit quality requests and recovery reasons take precedence', () => {
  for (const field of ['qualityGateRequired', 'requiresReview', 'reviewRequired', 'requiresEvidence', 'evidenceRequired', 'adversarialReviewRequired']) {
    assert.equal(select({ ...renderTask, [field]: true }).strategy, 'workflow', field);
  }
  for (const field of ['requiresReview', 'requireEvidence']) {
    assert.equal(select({ ...renderTask, executionContract: { [field]: true } }).strategy, 'workflow', field);
  }
  for (const text of ['证据链', '质量门禁', '对抗性审查', '多 reviewer', 'reviewer', 'evidence', 'quality gate', 'adversarial']) {
    for (const acceptanceCriteria of [text, [text]]) {
      assert.equal(select({ ...renderTask, acceptanceCriteria }).strategy, 'workflow', text);
    }
  }
  for (const [state, reason] of [
    [{ reviewResult: { passed: false } }, 'rework_after_review'],
    [{ runtimeFailureCount: 1 }, 'retry_after_failure'],
    [{ status: 'blocked', blockedReason: 'unavailable' }, 'blocked_or_unclear'],
  ]) assert.equal(select({ ...renderTask, ...state }).reasonCode, reason);
});

test('manual overrides and project defaults retain their original meaning', () => {
  assert.equal(select({ ...renderTask, executionStrategyOverride: 'workflow' }).reasonCode, 'manual_task_workflow');
  assert.equal(select({ ...renderTask, executionStrategyOverride: 'direct' }).reasonCode, 'simple_direct');
  for (const mode of ['direct', 'workflow_preferred']) {
    assert.equal(selectTaskExecutionStrategy({ project: { executionMode: mode }, task: renderTask }).modeSource, 'project_default');
  }
});

function dispatchedHub(id, requiredOutputs) {
  const hub = createHub({ silent: true });
  hub.createProject({ id, name: 'Renderer fixture', goal: 'Deliver report', poAgent: 'po', members: ['worker'], executionMode: 'auto' });
  assert.equal(hub.handleCreateTasks(id, [{ id: 'render', ...renderTask, assignedAgent: 'worker', requiredOutputs }], 'po').ok, true);
  assert.equal(hub.handleApprove(id).ok, true);
  const dispatch = hub.handleRequestDispatch(id, 'po');
  assert.deepEqual(dispatch.dispatched, [`${id}__render`]);
  assert.deepEqual(dispatch.workflowDispatched, []);
  const task = hub.getBoard(id).getTask(`${id}__render`);
  assert.equal(task.execution.reasonCode, 'managed_renderer_direct');
  assert.equal(hub.handleAcceptTask(id, task.id, 'worker', task.activeRunId).ok, true);
  assert.equal(hub.handleProgress(id, task.id, 'started', 'worker', task.activeRunId).ok, true);
  return { hub, task };
}

test('real Hub direct renderer dispatch still rejects missing HTML', () => {
  const { hub, task } = dispatchedHub('renderer-missing', ['report_html']);
  const result = hub.handleSubmitResult('renderer-missing', task.id, {
    summary: 'Report preparation complete. The Markdown contains findings, analysis, methodology, limitations and next steps for the final report.',
    artifacts: [{ filename: 'report.md', path: 'report.md', mimeType: 'text/markdown' }],
  }, 'worker', task.activeRunId);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'deliverable_contract_failed');
  assert.equal(result.failureClass, 'artifact_type_mismatch');
});

test('real Hub renderer submission remains submitted pending PO review', () => {
  const directory = mkdtempSync(join(tmpdir(), 'managed-renderer-'));
  try {
    const path = join(directory, 'report.html');
    writeFileSync(path, '<!DOCTYPE html><html><body><h1>Fixture report</h1><p>Reviewed content.</p></body></html>');
    const { hub, task } = dispatchedHub('renderer-review', ['report_html']);
    const result = hub.handleSubmitResult('renderer-review', task.id, {
      summary: 'The rendered HTML report includes the findings, architecture, evidence, limitations and recommendations. It is ready for independent PO review.',
      artifacts: [{ filename: 'report.html', path, mimeType: 'text/html' }],
    }, 'worker', task.activeRunId);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(task.status, 'submitted');
    assert.equal(task.reviewResult?.passed, undefined);
    assert.notEqual(hub.getProject('renderer-review').status, 'delivered');
    const review = hub.handleQualityReview('renderer-review', task.id, {
      passed: false, feedback: 'Fixture requires substantive correction.',
    }, 'po');
    assert.equal(review.effectivePassed, false);
    assert.notEqual(task.status, 'done');
    assert.equal(task.qualityReviewHistory.at(-1).passed, false);
    assert.ok(task.qualityFailureCount > 0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
