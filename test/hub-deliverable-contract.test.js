/**
 * KSwarm — hub deliverable contract integration tests
 *
 * Run: node test/hub-deliverable-contract.test.js
 */

import assert from 'node:assert/strict';
import { createHub } from '../src/core/hub.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('hub rejects markdown-only submission for an explicit pptx task before PO review', () => {
  const hub = createHub({ silent: true });
  hub.createProject({ id: 'proj-pptx', name: 'PPTX Project', goal: 'goal', poAgent: 'po', members: ['worker'] });
  hub.handleCreateTasks('proj-pptx', [
    {
      id: 'deck',
      title: '技术大会演讲报告',
      brief: '最终交付物必须是 PPTX 文件（.pptx），不是 Markdown 文档。',
      assignedAgent: 'worker',
    },
  ], 'po');
  hub.handleApprove('proj-pptx');
  hub.handleRequestDispatch('proj-pptx', 'po');

  const board = hub.getBoard('proj-pptx');
  const task = board.getTask('deck');
  const runId = task.activeRunId;
  assert.equal(hub.handleAcceptTask('proj-pptx', 'deck', 'worker', runId).ok, true);
  assert.equal(hub.handleProgress('proj-pptx', 'deck', 'started', 'worker', runId).ok, true);

  const rejected = hub.handleSubmitResult('proj-pptx', 'deck', {
    summary: '已经完成技术大会演讲报告内容，包含主题、结构、章节摘要、讲稿要点、受众分析、时间安排、演示节奏和后续建议，可以用于准备演讲材料。',
    artifacts: [{ filename: 'deck-report.md', path: 'artifacts/deck-report.md', mimeType: 'text/markdown' }],
  }, 'worker', runId);

  assert.equal(rejected.ok, false);
  assert.equal(rejected.error, 'deliverable_contract_failed');
  assert.equal(rejected.failureClass, 'artifact_type_mismatch');
  assert.equal(board.getTask('deck').status, 'failed');
  assert.equal(board.getTask('deck').lastFailureClass, 'artifact_type_mismatch');
  assert.equal(board.getTask('deck').rejectedSubmissions.length, 1);
});

function setupDeliverableProject() {
  const hub = createHub({ silent: true });
  hub.createProject({ id: 'proj-d', name: 'Deliver', goal: 'goal', poAgent: 'po', members: ['worker'] });
  hub.handleCreateTasks('proj-d', [{ id: 'item-1', title: 'Work', assignedAgent: 'worker' }], 'po');
  hub.handleApprove('proj-d');
  const board = hub.getBoard('proj-d');
  return { hub, board };
}

function driveTaskToDone(hub, board) {
  hub.handleRequestDispatch('proj-d', 'po');
  const task = board.getTask('item-1');
  const runId = task.activeRunId;
  hub.handleAcceptTask('proj-d', 'item-1', 'worker', runId);
  hub.handleProgress('proj-d', 'item-1', 'started', 'worker', runId);
  board.transition('item-1', 'submitted', { result: { summary: 'done' }, runId });
  board.transition('item-1', 'done');
}

test('handleDeliver refuses when validateDelivery fails and keeps project active', () => {
  const { hub, board } = setupDeliverableProject();
  driveTaskToDone(hub, board);

  const result = hub.handleDeliver('proj-d', { summary: 's' }, 'po', {
    validateDelivery: () => ({ ok: false, error: 'delivery_empty' }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'delivery_empty');
  assert.equal(hub.getProject('proj-d').status, 'active');
});

test('handleDeliver is idempotent and does not re-stamp deliveredAt', () => {
  const { hub, board } = setupDeliverableProject();
  driveTaskToDone(hub, board);

  const first = hub.handleDeliver('proj-d', { summary: 's' }, 'po', { validateDelivery: () => ({ ok: true }) });
  assert.equal(first.ok, true);
  const deliveredAt = hub.getProject('proj-d').deliveredAt;
  assert.equal(typeof deliveredAt, 'number');

  const second = hub.handleDeliver('proj-d', { summary: 's2' }, 'po');
  assert.equal(second.ok, true);
  assert.equal(second.alreadyDelivered, true);
  assert.equal(hub.getProject('proj-d').deliveredAt, deliveredAt);
});

test('handleDeliver is gated by tasks_not_all_done', () => {
  const { hub } = setupDeliverableProject();
  const result = hub.handleDeliver('proj-d', { summary: 's' }, 'po');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'tasks_not_all_done');
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
  console.log(`\n${passed}/${tests.length} hub deliverable contract tests passed`);
}
