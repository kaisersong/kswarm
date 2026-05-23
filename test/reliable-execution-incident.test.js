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

test('closed project active tasks do not reserve workers for new active projects', () => {
  const hub = createHub({ silent: true });
  hub.createProject({ id: 'proj-old', name: 'Old', goal: 'goal', poAgent: 'po-old', members: ['worker'] });
  hub.handleCreateTasks('proj-old', [{ id: 'old-task', title: 'Old task', assignedAgent: 'worker' }], 'po-old');
  hub.handleApprove('proj-old');
  assert.deepEqual(hub.handleRequestDispatch('proj-old', 'po-old').dispatched, ['proj-old__old-task']);
  const oldRunId = hub.getBoard('proj-old').getTask('old-task').activeRunId;
  assert.equal(hub.handleAcceptTask('proj-old', 'old-task', 'worker', oldRunId).ok, true);
  assert.equal(hub.handleProgress('proj-old', 'old-task', 'started', 'worker', oldRunId).ok, true);
  assert.equal(hub.handleCloseProject('proj-old').ok, true);

  hub.createProject({ id: 'proj-new', name: 'New', goal: 'goal', poAgent: 'po-new', members: ['worker'] });
  hub.handleCreateTasks('proj-new', [{ id: 'new-task', title: 'New task', assignedAgent: 'worker' }], 'po-new');
  hub.handleApprove('proj-new');

  const dispatch = hub.handleRequestDispatch('proj-new', 'po-new');
  assert.deepEqual(dispatch.dispatched, ['proj-new__new-task']);
  assert.deepEqual(dispatch.skipped, []);
  assert.equal(hub.getBoard('proj-new').getTask('new-task').status, 'dispatched');
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
  assert.deepEqual(firstReview.dispatched, ['proj-a__review-report']);
  assert.equal(board.getTask('review-report').status, 'dispatched');
  const secondRunId = board.getTask('review-report').activeRunId;
  assert.ok(secondRunId);
  assert.notEqual(secondRunId, firstRunId);

  assert.equal(hub.handleAcceptTask('proj-a', 'review-report', 'worker', secondRunId).ok, true);
  assert.equal(hub.handleProgress('proj-a', 'review-report', 'started', 'worker', secondRunId).ok, true);
  assert.equal(hub.handleSubmitResult('proj-a', 'review-report', {
    summary: '仍然没有证据',
    artifacts: [],
  }, 'worker', secondRunId).ok, true);
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

test('quality review failure requeues agent output instead of leaving it in progress', () => {
  const bridge = createMockBridge();
  const hub = createHub({ bridge, silent: true });
  hub.createProject({ id: 'proj-agent-output', name: 'Agent Output', goal: 'goal', poAgent: 'po', members: ['worker'] });
  hub.handleCreateTasks('proj-agent-output', [
    { id: 'story-source', title: '定义真实性基准并收集素材', assignedAgent: 'worker' },
  ], 'po');
  hub.handleApprove('proj-agent-output');

  const board = hub.getBoard('proj-agent-output');
  board.transition('story-source', 'dispatched', { assignedAgent: 'worker' });
  assert.equal(board.getTask('story-source').assignedAgent, 'worker');
  assert.equal(board.getTask('story-source').assignedExecutor, null);
  const runId = board.getTask('story-source').activeRunId;
  assert.equal(hub.handleAcceptTask('proj-agent-output', 'story-source', 'worker', runId).ok, true);
  assert.equal(hub.handleProgress('proj-agent-output', 'story-source', 'started', 'worker', runId).ok, true);
  assert.equal(hub.handleSubmitResult('proj-agent-output', 'story-source', {
    summary: 'Worker generated 16 slides for 定义真实性基准并收集素材.',
    artifacts: [{ filename: 'story-source-deck.pptx', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }],
  }, 'worker', runId).ok, true);

  const review = hub.handleQualityReview('proj-agent-output', 'story-source', {
    passed: false,
    feedback: '产出物仅包含 PPTX 文件头部结构，缺少实际内容。',
    failureClass: 'quality_content_failed',
  }, 'po');

  assert.equal(review.ok, true);
  assert.equal(review.rework, true);
  assert.equal(board.getTask('story-source').status, 'dispatched');
  assert.equal(board.getTask('story-source').lastFailureClass, 'quality_content_failed');
  assert.equal(bridge.getSentOf('request_task').length, 1);
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
