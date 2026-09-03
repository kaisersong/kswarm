/**
 * KSwarm — hub.js:handleMarkDone 必须拒绝 gate-bearing task 缺 fresh
 * GateEvaluation(passed) 时的无条件完成（design §8.2）
 *
 * 设计依据：mydocs/xiaok-cli/design/2026-08-31-collaboration-room-evidence-first-execution-and-gate-design.md v8
 *   §8.2 表格 —— "hub.js:handleMarkDone + POST /projects/:id/tasks/:taskId/done：
 *   PO 只能确认 execution done；经 task-advance coordinator 后仍需
 *   service-derived evaluation，不能解锁 verified edge"
 *
 * 现状核实（2026-09-02）：handleMarkDone 对任意任务（不区分是否 gate-bearing）
 * 无条件 board.transition(task.id, 'done')，完全不检查 task.evidenceContract
 * 是否要求独立 review、是否已有 fresh GateEvaluation(passed)。这允许 PO
 * 单方面把一个本应经过独立 reviewer 产出 GateEvaluation 的 review_iteration_v2
 * 任务直接标记完成，绕过整条证据链路——等价于自审（PO 自己确认自己分派的
 * review 任务"完成"，不需要任何独立验证）。
 *
 * 本文件先证明这个漏洞真实存在（RED），随后实现应使其修复（GREEN）。
 *
 * Run: node test/hub-mark-done-gate-bearing-guard.test.js
 */

import assert from 'node:assert/strict';
import { createHub } from '../src/core/hub.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('handleMarkDone 对 review_iteration_v2 gate-bearing task 且无 fresh GateEvaluation(passed) 时必须拒绝，不能无条件转 done', () => {
  const hub = createHub({ silent: true });
  const projectId = 'proj-mark-done-guard';
  hub.createProject({ id: projectId, name: projectId, goal: 'goal', poAgent: 'po', members: ['worker'] });
  const created = hub.handleCreateTasks(projectId, [
    { id: 'item-1', title: 'Review upstream artifact', brief: 'Review', assignedAgent: 'worker', dependencies: [] },
  ], 'po');
  assert.equal(created.ok, true);
  assert.equal(hub.handleApprove(projectId).ok, true);

  const board = hub.getBoard(projectId);
  const task = board.getTask(created.taskIds[0]);
  task.evidenceContract = {
    version: 2,
    kind: 'review_iteration_v2',
    requiredArtifacts: ['review-evidence-v2.json'],
    requiredFields: ['verdict', 'findings', 'subjectArtifacts'],
  };

  assert.equal(board.transition(task.id, 'dispatched', { assignedAgent: 'worker', runId: 'run-1' }).ok, true);
  assert.equal(board.transition(task.id, 'accepted', { assignedAgent: 'worker' }).ok, true);
  assert.equal(board.transition(task.id, 'in_progress').ok, true);
  assert.equal(board.transition(task.id, 'submitted', { result: { summary: 'submitted without going through quality review' }, runId: 'run-1' }).ok, true);

  // PO 试图跳过 handleQualityReview（跳过整条证据链路），直接标记 done。
  const result = hub.handleMarkDone(projectId, task.id, 'po');

  assert.equal(result.ok, false, 'gate-bearing task 缺 fresh GateEvaluation(passed) 时，handleMarkDone 必须拒绝');
  assert.equal(result.error, 'gate_bearing_task_requires_evaluation');
  assert.equal(board.getTask(task.id).status, 'submitted', 'task 状态不应被无条件转为 done');
});

test('handleMarkDone 对非 gate-bearing task（无 evidenceContract）行为不变，正常完成', () => {
  const hub = createHub({ silent: true });
  const projectId = 'proj-mark-done-normal';
  hub.createProject({ id: projectId, name: projectId, goal: 'goal', poAgent: 'po', members: ['worker'] });
  const created = hub.handleCreateTasks(projectId, [
    { id: 'item-1', title: 'Plain task', brief: 'Do it', assignedAgent: 'worker', dependencies: [] },
  ], 'po');
  assert.equal(created.ok, true);
  assert.equal(hub.handleApprove(projectId).ok, true);

  const board = hub.getBoard(projectId);
  const task = board.getTask(created.taskIds[0]);
  assert.equal(board.transition(task.id, 'dispatched', { assignedAgent: 'worker', runId: 'run-1' }).ok, true);
  assert.equal(board.transition(task.id, 'accepted', { assignedAgent: 'worker' }).ok, true);
  assert.equal(board.transition(task.id, 'in_progress').ok, true);
  assert.equal(board.transition(task.id, 'submitted', { result: { summary: 'plain result' }, runId: 'run-1' }).ok, true);

  const result = hub.handleMarkDone(projectId, task.id, 'po');
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(board.getTask(task.id).status, 'done');
});

test('handleMarkDone 对已经通过 handleQualityReview 产出 fresh GateEvaluation(passed) 的 gate-bearing task（幂等场景）正常放行', () => {
  const hub = createHub({ silent: true });
  const projectId = 'proj-mark-done-already-passed';
  hub.createProject({ id: projectId, name: projectId, goal: 'goal', poAgent: 'po', members: ['worker'] });
  const created = hub.handleCreateTasks(projectId, [
    { id: 'item-1', title: 'Review upstream artifact', brief: 'Review', assignedAgent: 'worker', dependencies: [] },
  ], 'po');
  assert.equal(created.ok, true);
  assert.equal(hub.handleApprove(projectId).ok, true);

  const project = hub.getProject(projectId);
  const board = hub.getBoard(projectId);
  const task = board.getTask(created.taskIds[0]);
  task.evidenceContract = {
    version: 2,
    kind: 'review_iteration_v2',
    requiredArtifacts: ['review-evidence-v2.json'],
    requiredFields: ['verdict', 'findings', 'subjectArtifacts'],
  };

  // 模拟已经存在的、真实的 fresh GateEvaluation(passed)（不重新走一遍完整
  // handleQualityReview 流程，聚焦本测试要验证的"已有 evaluation 时放行"分支）。
  project.gateEvaluations = project.gateEvaluations || {};
  project.gateEvaluations[task.id] = [{
    schemaVersion: 'gate-evaluation-v1',
    sourceArtifactId: 'gate-ev-1',
    sourceArtifactSha256: 'a'.repeat(64),
    sourceRunId: 'run-1',
    subjectArtifacts: [],
    verdict: 'passed',
    reasonCode: 'evidence_passed',
    findingIds: [],
    conditionIds: [],
    evaluator: { participantId: 'reviewer-x', role: 'independent_reviewer', independence: 'independent' },
    createdAt: new Date().toISOString(),
  }];

  assert.equal(board.transition(task.id, 'dispatched', { assignedAgent: 'worker', runId: 'run-1' }).ok, true);
  assert.equal(board.transition(task.id, 'accepted', { assignedAgent: 'worker' }).ok, true);
  assert.equal(board.transition(task.id, 'in_progress').ok, true);
  assert.equal(board.transition(task.id, 'submitted', { result: { summary: 'already evaluated' }, runId: 'run-1' }).ok, true);

  const result = hub.handleMarkDone(projectId, task.id, 'po');
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(board.getTask(task.id).status, 'done');
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
console.log(`\n${passed}/${tests.length} hub markDone gate-bearing guard tests passed\n`);
if (failed > 0) process.exit(1);
