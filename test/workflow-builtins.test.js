/**
 * KSwarm — built-in workflow tests
 *
 * Run: node test/workflow-builtins.test.js
 */

import assert from 'node:assert/strict';
import {
  createPoGeneratedTaskWorkflowRun,
  createProjectDiagnoseWorkflowRun,
  TASK_WORKFLOW_DELIVERABLE_NODE_ID,
} from '../src/core/workflow-builtins.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('project-diagnose completes as a read-only control-plane workflow', () => {
  const run = createProjectDiagnoseWorkflowRun({
    project: { id: 'proj-1', name: '分析项目', status: 'active' },
    tasks: [
      { id: 'item-1', title: '写报告', status: 'blocked', blockedReason: '缺少证据' },
      { id: 'item-2', title: '补证据', status: 'pending', assignedAgent: 'xiaok-worker' },
    ],
    projectHealth: {
      state: 'blocked',
      gate: 'blocked_tasks',
      reasons: [{ taskId: 'item-1', message: '缺少证据' }],
    },
    dispatchPlan: {
      dispatchedTasks: [{ id: 'item-2', assignedAgent: 'xiaok-worker' }],
      waiting: [],
      blocked: [{ taskId: 'item-1', reason: 'blocked_tasks' }],
    },
    requestedBy: 'human',
    now: 1770000000000,
  });

  assert.equal(run.workflowId, 'project-diagnose');
  assert.equal(run.status, 'completed');
  assert.equal(run.nodes.every(node => node.status === 'completed'), true);
  assert.equal(run.diagnosis.healthState, 'blocked');
  assert.equal(run.diagnosis.blockedTasks[0].taskId, 'item-1');
  assert.equal(run.diagnosis.dispatchableCount, 1);
  assert.equal(run.diagnosis.recommendedActions[0].id, 'continue_project');
  assert.equal(run.nodes.some(node => node.kind === 'agent_task'), false);
});

test('project-diagnose recommends dispatch when work is available and not blocked', () => {
  const run = createProjectDiagnoseWorkflowRun({
    project: { id: 'proj-2', name: '待执行项目', status: 'active' },
    tasks: [{ id: 'item-1', title: '写报告', status: 'pending', assignedAgent: 'xiaok-worker' }],
    projectHealth: { state: 'dispatchable', gate: null, reasons: [] },
    dispatchPlan: { dispatchedTasks: [{ id: 'item-1', assignedAgent: 'xiaok-worker' }], waiting: [], blocked: [] },
    now: 1770000000000,
  });

  assert.equal(run.diagnosis.recommendedActions[0].id, 'dispatch_tasks');
  assert.equal(run.summary.primaryMessage, '派发可执行任务');
});

test('po-generated task workflow carries PO rework feedback into worker input', () => {
  const failedTask = {
    id: 'proj-1__item-1',
    title: '汇总并交叉验证信息',
    brief: '统一多个子报告的时间线和信息矩阵。',
    status: 'pending',
    assignedAgent: 'xiaok-worker',
    acceptanceCriteria: '统一时间线与交叉验证矩阵的验证标记。',
    requiredOutputs: [{ type: 'markdown', enforcement: 'hard', source: 'task' }],
    failureReason: '验收不通过：时间线中多处标记为 ✅，但矩阵来源数为 1，应统一为 ⚡。',
    lastFailureClass: 'quality_content_failed',
    qualityFailureCount: 1,
    reviewResult: {
      passed: false,
      feedback: '请统一 timeline 与 matrix 的 ✅/⚡ 标记后再提交复审。',
      failureClass: 'quality_content_failed',
      reviewedAt: 1770000000000,
    },
  };
  const run = createPoGeneratedTaskWorkflowRun({
    project: { id: 'proj-1', name: 'AI 动态分析', goal: '生成月度分析报告', status: 'active' },
    task: failedTask,
    tasks: [
      { id: 'proj-1__item-0', title: '收集资料', status: 'done', assignedAgent: 'xiaok-worker' },
      failedTask,
    ],
    now: 1770000000000,
  });

  const workerNode = run.nodes.find(node => node.id === TASK_WORKFLOW_DELIVERABLE_NODE_ID);
  assert.ok(workerNode);
  assert.equal(run.sourceTask.failureReason, failedTask.failureReason);
  assert.equal(run.sourceTask.lastFailureClass, 'quality_content_failed');
  assert.equal(run.sourceTask.qualityFailureCount, 1);
  assert.equal(run.sourceTask.reviewResult.feedback, failedTask.reviewResult.feedback);
  assert.match(workerNode.input.instruction, /返工/);
  assert.match(workerNode.input.instruction, /PO/);
  assert.match(workerNode.input.sourceTask.repairInstruction, /时间线中多处标记/);
  assert.equal(
    Object.prototype.hasOwnProperty.call(workerNode.input.taskSnapshot[1], 'failureReason'),
    false,
  );
});

let passed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    passed++;
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(err);
    process.exitCode = 1;
    break;
  }
}
if (process.exitCode !== 1) console.log(`\n${passed}/${tests.length} workflow built-in tests passed`);
