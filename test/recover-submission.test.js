/**
 * KSwarm — Recover submission tests
 *
 * Run: node test/recover-submission.test.js
 */

import assert from 'node:assert/strict';
import { createHub } from '../src/core/hub.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function setup() {
  const hub = createHub({ silent: true });
  hub.createProject({ id: 'proj-recover', name: 'Recover', goal: 'goal', poAgent: 'po', members: ['worker'] });
  hub.handleSubmitPlan('proj-recover', {
    analysis: 'test',
    phases: [{ id: 'phase-1', name: 'P1', items: [
      { id: 'item-1', title: 'Research', assignedAgent: 'worker', dependencies: [] },
      { id: 'item-2', title: 'Synthesis', assignedAgent: 'worker', dependencies: ['Research'] },
    ] }],
  }, 'po');
  hub.handleCreateTasks('proj-recover', [
    { id: 'item-1', title: 'Research', assignedAgent: 'worker', phaseId: 'phase-1', dependencies: [] },
    { id: 'item-2', title: 'Synthesis', assignedAgent: 'worker', phaseId: 'phase-1', dependencies: ['Research'] },
  ], 'po');
  hub.handleApprove('proj-recover');
  return hub;
}

test('cancelled task can recover to submitted with result and audit fields', () => {
  const hub = setup();
  const board = hub.getBoard('proj-recover');
  board.transition('item-1', 'dispatched');
  board.transition('item-1', 'cancelled');

  const result = hub.handleRecoverSubmission('proj-recover', 'item-1', {
    summary: 'Recovered artifact',
    artifacts: [{ filename: 'item-1-report.md' }],
  }, 'worker');

  assert.equal(result.ok, true);
  const task = board.getTask('item-1');
  assert.equal(task.status, 'submitted');
  assert.equal(task.result.summary, 'Recovered artifact');
  assert.equal(task.recoveredFromStatus, 'cancelled');
  assert.equal(task.recoveredBy, 'worker');
  assert.equal(task.activeRunId, null);
});

test('recover does not allow pending task shortcut', () => {
  const hub = setup();
  const result = hub.handleRecoverSubmission('proj-recover', 'item-1', { summary: 'bad' }, 'worker');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'cannot_recover_from_status: pending');
});

test('recovered submission must pass review before dependency dispatches', () => {
  const hub = setup();
  const board = hub.getBoard('proj-recover');
  board.transition('item-1', 'dispatched');
  board.transition('item-1', 'cancelled');
  hub.handleRecoverSubmission('proj-recover', 'item-1', { summary: 'Recovered artifact' }, 'worker');

  let dispatch = hub.handleRequestDispatch('proj-recover', 'po');
  assert.deepEqual(dispatch.dispatched, []);

  const review = hub.handleQualityReview('proj-recover', 'item-1', { passed: true, feedback: 'OK' }, 'po');
  assert.equal(review.ok, true);

  dispatch = hub.handleRequestDispatch('proj-recover', 'po');
  assert.deepEqual(dispatch.dispatched, ['proj-recover__item-2']);
});

test('recover records run identity and recovery reason for startup recovery', () => {
  const hub = setup();
  const board = hub.getBoard('proj-recover');
  board.transition('item-1', 'dispatched', { assignedAgent: 'worker', runId: 'run-recover-1' });
  board.transition('item-1', 'accepted', { assignedAgent: 'worker' });
  board.transition('item-1', 'in_progress');

  const result = hub.handleRecoverSubmission('proj-recover', 'item-1', {
    summary: 'Recovered from journal',
    runId: 'run-recover-1',
    artifacts: [{ filename: 'item-1-report.md' }],
  }, 'worker', { runId: 'run-recover-1', recoveryReason: 'journal_artifact_written' });

  assert.equal(result.ok, true);
  const task = board.getTask('item-1');
  assert.equal(task.status, 'submitted');
  assert.equal(task.recoveredRunId, 'run-recover-1');
  assert.equal(task.recoveryStatus, 'recovered');
  assert.equal(task.recoveryReason, 'journal_artifact_written');
});

test('hub can reset a stale active run to pending for redispatch', () => {
  const hub = setup();
  const board = hub.getBoard('proj-recover');
  board.transition('item-1', 'dispatched', { assignedAgent: 'worker', runId: 'run-stale-1' });
  board.transition('item-1', 'accepted', { assignedAgent: 'worker' });

  const result = hub.handleResetTaskForRecovery('proj-recover', 'item-1', 'lease_expired');

  assert.equal(result.ok, true);
  const task = board.getTask('item-1');
  assert.equal(task.status, 'pending');
  assert.equal(task.activeRunId, null);
  assert.equal(task.recoveryStatus, 'redispatch_ready');
  assert.equal(task.recoveryReason, 'lease_expired');
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
  console.log(`\n${passed}/${tests.length} recover submission tests passed`);
}
