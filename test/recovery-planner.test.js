/**
 * KSwarm — Restart recovery planner tests
 *
 * Run: node test/recovery-planner.test.js
 */

import assert from 'node:assert/strict';
import { planProjectRecovery } from '../src/core/recovery-planner.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function makeTask(overrides = {}) {
  return {
    id: 'proj-recovery__item-1',
    projectId: 'proj-recovery',
    localTaskId: 'item-1',
    title: 'Recover me',
    status: 'in_progress',
    assignedAgent: 'worker',
    activeRunId: 'run-active',
    updatedAt: 1_000,
    runLease: {
      runId: 'run-active',
      projectId: 'proj-recovery',
      taskId: 'proj-recovery__item-1',
      assignedAgent: 'worker',
      status: 'in_progress',
      createdAt: 1_000,
      lastHeartbeatAt: 1_000,
      leaseExpiresAt: 11_000,
    },
    ...overrides,
  };
}

function plan({ project = { id: 'proj-recovery', status: 'active', poAgent: 'po' }, tasks, journals = [], onlineAgents = [], now = 30_000, leaseTimeoutMs = 10_000 }) {
  return planProjectRecovery({
    project,
    tasks,
    journals,
    onlineAgents: new Set(onlineAgents),
    now,
    leaseTimeoutMs,
  });
}

test('recovers an in-progress task only when the matching journal confirms artifact_written', () => {
  const task = makeTask();
  const result = plan({
    tasks: [task],
    journals: [{
      schemaVersion: 1,
      projectId: 'proj-recovery',
      taskId: task.id,
      runId: 'run-active',
      agentId: 'worker',
      status: 'artifact_written',
      artifactManifest: [{ filename: 'proj-recovery__item-1-report.md', mimeType: 'text/markdown' }],
    }],
  });

  assert.equal(result.actions.length, 1);
  assert.deepEqual(result.actions[0], {
    type: 'recover_submission',
    projectId: 'proj-recovery',
    taskId: task.id,
    runId: 'run-active',
    agentId: 'worker',
    artifacts: [{ filename: 'proj-recovery__item-1-report.md', mimeType: 'text/markdown' }],
    reason: 'journal_artifact_written',
  });
});

test('does not recover a task when an artifact manifest exists but journal status is not durable', () => {
  const task = makeTask();
  const result = plan({
    tasks: [task],
    journals: [{
      schemaVersion: 1,
      projectId: 'proj-recovery',
      taskId: task.id,
      runId: 'run-active',
      agentId: 'worker',
      status: 'in_progress',
      artifactManifest: [{ filename: 'partial.md', mimeType: 'text/markdown' }],
    }],
  });

  assert.equal(result.actions.length, 1);
  assert.equal(result.actions[0].type, 'reset_pending');
  assert.equal(result.actions[0].reason, 'lease_expired');
});

test('resumes an unexpired in-progress task when the assigned agent is online', () => {
  const task = makeTask({ updatedAt: 25_000, runLease: { ...makeTask().runLease, lastHeartbeatAt: 25_000, leaseExpiresAt: 35_000 } });
  const result = plan({ tasks: [task], onlineAgents: ['worker'], now: 30_000 });

  assert.deepEqual(result.actions.map(a => a.type), ['resume_task']);
  assert.equal(result.actions[0].taskId, task.id);
  assert.equal(result.actions[0].runId, 'run-active');
});

test('resets expired active runs with no durable artifact to pending', () => {
  const task = makeTask();
  const result = plan({ tasks: [task], journals: [], onlineAgents: [], now: 30_000 });

  assert.deepEqual(result.actions.map(a => a.type), ['reset_pending']);
  assert.equal(result.actions[0].reason, 'lease_expired');
});

test('notifies PO when a submitted task has not been reviewed', () => {
  const task = makeTask({
    status: 'submitted',
    activeRunId: null,
    result: { summary: 'done' },
    reviewResult: null,
  });
  const result = plan({ tasks: [task], now: 30_000 });

  assert.deepEqual(result.actions.map(a => a.type), ['notify_po_review']);
  assert.equal(result.actions[0].poAgent, 'po');
});

test('ignores terminal done tasks even if stale journals exist', () => {
  const task = makeTask({ status: 'done', activeRunId: null, result: { summary: 'done' } });
  const result = plan({
    tasks: [task],
    journals: [{
      schemaVersion: 1,
      projectId: 'proj-recovery',
      taskId: task.id,
      runId: 'run-active',
      status: 'artifact_written',
      artifactManifest: [{ filename: 'old.md' }],
    }],
  });

  assert.deepEqual(result.actions, []);
});

test('closed projects are not recovered', () => {
  const result = plan({
    project: { id: 'proj-recovery', status: 'closed', poAgent: 'po' },
    tasks: [makeTask()],
    journals: [],
  });

  assert.deepEqual(result.actions, []);
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
  console.log(`\n${passed}/${tests.length} recovery planner tests passed`);
}
