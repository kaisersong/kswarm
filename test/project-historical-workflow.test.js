import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveExecutionGraph, deriveProjectLifecycle, evaluateFinalDeliverableApprovalFacts } from '../src/core/project-read-model.js';

function fixture() {
  const project = { id: 'fixture', status: 'active' };
  const task = { id: 'fixture__item-1', projectId: 'fixture', localTaskId: 'item-1', status: 'done', reviewResult: { passed: true, reviewedAt: 2000 } };
  const run = { id: 'attempt', projectId: 'fixture', workflowId: 'po-generated-task-workflow', source: 'po_generated',
    scope: { projectId: 'fixture', taskId: task.id }, status: 'blocked', createdAt: 900, updatedAt: 1200,
    recovery: { nextAction: 'resume_workflow' }, gateDecision: { status: 'needs_rework' },
    nodes: [{ id: 'worker', status: 'completed', startedAt: 900, completedAt: 1100 },
      { id: 'reviewer', status: 'blocked', error: 'deadline', startedAt: 1100, completedAt: 1200 },
      { id: 'reduce', status: 'pending' }] };
  return { project, tasks: [task], workflowRuns: [run], finalDeliverables: [{ deliverableId: 'candidate', status: 'candidate', taskId: task.id }], now: 3000 };
}

test('later accepted source task retires attempt progress, preserving failures and gates', () => {
  const input = fixture(), before = structuredClone(input);
  const graph = deriveExecutionGraph(input), lifecycle = deriveProjectLifecycle(input);
  assert.equal(graph.counts.total, 1);
  assert.equal(graph.counts.done, 1);
  assert.equal(graph.historyCounts.total, 3);
  assert.equal(graph.historyCounts.blocked, 1);
  assert.equal(graph.nodes.find(n => n.workflowNodeId === 'reviewer').status, 'blocked');
  assert.ok(graph.nodes.filter(n => n.workflowRunId).every(n => n.required === false && n.ownership === 'historical_task_attempt'));
  assert.equal(lifecycle.state, 'ready_to_deliver');
  assert.equal(lifecycle.canResume, false);
  assert.equal(lifecycle.canAutoClose, false);
  assert.deepEqual(input, before);
  assert.equal(evaluateFinalDeliverableApprovalFacts({ projectId: 'fixture', finalDeliverable: { workflowRunId: 'attempt' }, ...input }).error, 'final_deliverable_review_failed');
  assert.equal(evaluateFinalDeliverableApprovalFacts({ projectId: 'fixture', finalDeliverable: { taskId: input.tasks[0].id }, ...input,
    reviewConditions: [{ projectId: 'fixture', blocking: true, status: 'open' }] }).error, 'open_review_conditions');
});

test('same shape as five recovered tasks and ten old attempts counts five current nodes', () => {
  const base = fixture();
  base.tasks = Array.from({ length: 5 }, (_, i) => ({ ...base.tasks[0], id: `fixture__item-${i+1}`, localTaskId: `item-${i+1}` }));
  base.workflowRuns = Array.from({ length: 10 }, (_, i) => ({ ...structuredClone(base.workflowRuns[0]), id: `attempt-${i}`, scope: { projectId: 'fixture', taskId: base.tasks[i%5].id } }));
  const graph = deriveExecutionGraph(base);
  assert.equal(graph.nodes.length, 35);
  assert.equal(graph.counts.total, 5);
  assert.equal(graph.counts.done, 5);
  assert.equal(graph.counts.blocked, 0);
  assert.equal(graph.historyCounts.total, 30);
  assert.equal(deriveProjectLifecycle(base).state, 'ready_to_deliver');
});

for (const [name, mutate] of [
  ['unaccepted task', x => x.tasks[0].status = 'submitted'],
  ['failed review', x => x.tasks[0].reviewResult.passed = false],
  ['missing review', x => delete x.tasks[0].reviewResult],
  ['early review', x => x.tasks[0].reviewResult.reviewedAt = 1199],
  ['future review', x => x.tasks[0].reviewResult.reviewedAt = 4000],
  ['invalid review time', x => x.tasks[0].reviewResult.reviewedAt = '2000'],
  ['missing run time', x => delete x.workflowRuns[0].updatedAt],
  ['invalid node time', x => x.workflowRuns[0].nodes[0].completedAt = NaN],
  ['newer attempt activity', x => x.workflowRuns[0].updatedAt = 2500],
  ['running attempt', x => x.workflowRuns[0].status = 'running'],
  ['foreign task', x => x.tasks[0].projectId = 'other'],
  ['foreign run', x => x.workflowRuns[0].projectId = 'other'],
  ['foreign scope', x => x.workflowRuns[0].scope.projectId = 'other'],
  ['local alias', x => x.workflowRuns[0].scope.taskId = 'item-1'],
  ['duplicate canonical task', x => x.tasks.push(structuredClone(x.tasks[0]))],
  ['project wide', x => delete x.workflowRuns[0].scope.taskId],
  ['raw script', x => x.workflowRuns[0].source = 'script_generated'],
  ['different workflow', x => x.workflowRuns[0].workflowId = 'other'],
]) test(`${name} does not retire required failure`, () => {
  const input = fixture(); mutate(input);
  const graph = deriveExecutionGraph(input);
  assert.equal(graph.nodes.find(n => n.workflowNodeId === 'reviewer').required, true);
  assert.equal(deriveProjectLifecycle(input).state, 'blocked');
});

test('new active attempt remains visible alongside retired history', () => {
  const input = fixture(), active = structuredClone(input.workflowRuns[0]);
  active.id = 'new-attempt'; active.status = 'running'; active.createdAt = 2100; active.updatedAt = 2200;
  input.workflowRuns.push(active);
  const graph = deriveExecutionGraph(input);
  assert.equal(graph.historyCounts.total, 3);
  assert.equal(graph.nodes.find(n => n.workflowRunId === active.id && n.workflowNodeId === 'reviewer').required, true);
  assert.equal(deriveProjectLifecycle(input).state, 'blocked');
});
