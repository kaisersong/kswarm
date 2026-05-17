/**
 * KSwarm — reliable execution incident regression tests
 *
 * Run: node test/reliable-execution-incident.test.js
 */

import assert from 'node:assert/strict';
import { createHub } from '../src/core/hub.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function createMockBridge() {
  const sent = [];
  return {
    send(msg) { sent.push(msg); },
    requestTask(p) { sent.push({ type: 'intent', kind: 'request_task', ...p }); },
    getSentOf(kind) { return sent.filter(m => m.kind === kind); },
  };
}

test('one worker cannot receive concurrent active runs across projects', () => {
  const hub = createHub({ silent: true });
  hub.createProject({ id: 'proj-a', name: 'A', goal: 'goal', poAgent: 'po-a', members: ['worker'] });
  hub.createProject({ id: 'proj-b', name: 'B', goal: 'goal', poAgent: 'po-b', members: ['worker'] });
  assert.equal(hub.handleCreateTasks('proj-a', [{ id: 'a1', title: 'A1', assignedAgent: 'worker' }], 'po-a').ok, true);
  assert.equal(hub.handleCreateTasks('proj-b', [{ id: 'b1', title: 'B1', assignedAgent: 'worker' }], 'po-b').ok, true);
  assert.equal(hub.handleApprove('proj-a').ok, true);
  assert.equal(hub.handleApprove('proj-b').ok, true);

  const aDispatch = hub.handleRequestDispatch('proj-a', 'po-a');
  assert.deepEqual(aDispatch.dispatched, ['proj-a__a1']);
  const runId = hub.getBoard('proj-a').getTask('a1').activeRunId;
  assert.equal(hub.handleAcceptTask('proj-a', 'a1', 'worker', runId).ok, true);

  const bDispatch = hub.handleRequestDispatch('proj-b', 'po-b');
  assert.deepEqual(bDispatch.dispatched, []);
  assert.deepEqual(bDispatch.skipped, [{ taskId: 'proj-b__b1', reason: 'agent_busy', agent: 'worker' }]);
  assert.equal(bDispatch.projectGate, 'waiting_for_busy_agents');
  assert.equal(hub.getBoard('proj-b').getTask('b1').status, 'pending');
});

test('quality review failure can block a task directly after rework budget is exhausted', () => {
  const bridge = createMockBridge();
  const hub = createHub({ bridge, silent: true });
  hub.createProject({ id: 'proj-a', name: 'A', goal: 'goal', poAgent: 'po', members: ['worker'] });
  hub.handleCreateTasks('proj-a', [
    { id: 'review-report', title: '质量评审：技术大会演讲报告', assignedAgent: 'worker', maxQualityReworks: 1 },
  ], 'po');
  hub.handleApprove('proj-a');
  hub.handleRequestDispatch('proj-a', 'po');
  const board = hub.getBoard('proj-a');
  const task = board.getTask('review-report');
  const firstRunId = task.activeRunId;
  assert.equal(hub.handleAcceptTask('proj-a', 'review-report', 'worker', firstRunId).ok, true);
  assert.equal(hub.handleProgress('proj-a', 'review-report', 'started', 'worker', firstRunId).ok, true);
  assert.equal(hub.handleSubmitResult('proj-a', 'review-report', {
    summary: '空评审',
    artifacts: [],
  }, 'worker', firstRunId).ok, true);

  const firstReview = hub.handleQualityReview('proj-a', 'review-report', {
    passed: false,
    feedback: '没有 review-evidence.json',
    failureClass: 'quality_evidence_missing',
  }, 'po');
  assert.equal(firstReview.ok, true);
  assert.equal(firstReview.rework, true);
  assert.equal(board.getTask('review-report').status, 'in_progress');

  assert.equal(hub.handleSubmitResult('proj-a', 'review-report', {
    summary: '仍然没有证据',
    artifacts: [],
  }, 'worker', firstRunId).ok, true);
  const secondReview = hub.handleQualityReview('proj-a', 'review-report', {
    passed: false,
    feedback: '仍然没有 review-evidence.json',
    failureClass: 'quality_evidence_missing',
  }, 'po');

  assert.equal(secondReview.ok, true);
  assert.equal(secondReview.blocked, true);
  assert.equal(board.getTask('review-report').status, 'blocked');
  assert.equal(board.getTask('review-report').lastFailureClass, 'quality_evidence_missing');
  const blockedEvents = hub.getEventLog().getEvents().filter(e => e.type === 'task.blocked');
  assert.equal(blockedEvents.length, 1);
});

test('composite task creation is atomic and parent is not dispatched as ordinary work', () => {
  const hub = createHub({ silent: true });
  hub.createProject({ id: 'proj-a', name: 'A', goal: 'goal', poAgent: 'po', members: ['writer', 'reviewer'] });
  const created = hub.handleCreateTasks('proj-a', [
    { id: 'talk-report', title: '技术大会演讲报告', assignedAgent: 'writer', composite: true },
  ], 'po');

  assert.equal(created.ok, true);
  assert.equal(created.taskIds.length, 4);
  assert.equal(hub.handleApprove('proj-a').ok, true);

  const dispatch = hub.handleRequestDispatch('proj-a', 'po');
  assert.deepEqual(dispatch.dispatched, ['proj-a__talk-report-draft']);
  assert.equal(hub.getBoard('proj-a').getTask('talk-report').status, 'pending');
  assert.equal(hub.getBoard('proj-a').getTask('talk-report').isCompositeParent, true);
});

test('composite task creation fails atomically when reviewer is missing', () => {
  const hub = createHub({ silent: true });
  hub.createProject({ id: 'proj-a', name: 'A', goal: 'goal', poAgent: 'po', members: ['writer'] });
  const created = hub.handleCreateTasks('proj-a', [
    { id: 'talk-report', title: '技术大会演讲报告', assignedAgent: 'writer', composite: true },
  ], 'po');

  assert.equal(created.ok, false);
  assert.equal(created.error, 'no_independent_reviewer');
  assert.deepEqual(hub.getBoard('proj-a').getAllTasks(), []);
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
  console.log(`\n${passed}/${tests.length} reliable execution incident tests passed`);
}
