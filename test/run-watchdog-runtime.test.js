/**
 * KSwarm — stalled run watchdog planner tests
 *
 * Run: node test/run-watchdog-runtime.test.js
 */

import assert from 'node:assert/strict';
import { planStalledRunActions } from '../src/core/run-watchdog.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const now = 1779050000000;

test('missing heartbeat past threshold marks runtime stalled and requests cancel', () => {
  const actions = planStalledRunActions({
    projectId: 'proj',
    tasks: [{
      id: 'item-1',
      status: 'in_progress',
      assignedAgent: 'agent-a',
      activeRunId: 'run-1',
      runLease: {
        runId: 'run-1',
        lastHeartbeatAt: now - 120_000,
        createdAt: now - 180_000,
      },
    }],
    now,
    heartbeatTimeoutMs: 60_000,
  });

  assert.deepEqual(actions.map(a => a.type), ['mark_runtime_stalled', 'request_cancel_run']);
  assert.equal(actions[1].runId, 'run-1');
  assert.equal(actions[1].agentId, 'agent-a');
});

test('stalled runtime instance targets concrete runtime participant', () => {
  const actions = planStalledRunActions({
    projectId: 'proj',
    tasks: [{
      id: 'item-1',
      status: 'in_progress',
      assignedAgent: 'xiaok-worker',
      assignedRuntimeInstance: 'xiaok-worker@inst-1',
      activeRunId: 'run-1',
      runLease: {
        runId: 'run-1',
        assignedAgent: 'xiaok-worker',
        assignedRuntimeInstance: 'xiaok-worker@inst-1',
        lastHeartbeatAt: now - 120_000,
        createdAt: now - 180_000,
      },
    }],
    now,
    heartbeatTimeoutMs: 60_000,
  });

  assert.equal(actions[0].agentId, 'xiaok-worker@inst-1');
  assert.equal(actions[0].logicalAgentId, 'xiaok-worker');
  assert.equal(actions[1].agentId, 'xiaok-worker@inst-1');
  assert.equal(actions[1].logicalAgentId, 'xiaok-worker');
});

test('recent heartbeat but no stdout emits stalled warning first', () => {
  const actions = planStalledRunActions({
    projectId: 'proj',
    tasks: [{
      id: 'item-1',
      status: 'in_progress',
      assignedAgent: 'agent-a',
      activeRunId: 'run-1',
      runLease: {
        runId: 'run-1',
        lastHeartbeatAt: now - 5_000,
        createdAt: now - 120_000,
      },
      runTelemetry: {
        childPid: 123,
        lastStdoutAt: null,
        lastStderrAt: null,
        lastArtifactAt: null,
      },
    }],
    now,
    noOutputWarningMs: 60_000,
    heartbeatTimeoutMs: 600_000,
  });

  assert.deepEqual(actions.map(a => a.type), ['stalled_warning']);
  assert.equal(actions[0].reason, 'no_output');
});

test('max run time requests cancel even with recent heartbeat', () => {
  const actions = planStalledRunActions({
    projectId: 'proj',
    tasks: [{
      id: 'item-1',
      status: 'in_progress',
      assignedAgent: 'agent-a',
      activeRunId: 'run-1',
      runLease: {
        runId: 'run-1',
        lastHeartbeatAt: now - 1_000,
        createdAt: now - 900_000,
      },
      runTelemetry: {
        childPid: 123,
        lastStdoutAt: now - 1_000,
      },
    }],
    now,
    maxRunMs: 600_000,
  });

  assert.deepEqual(actions.map(a => a.type), ['mark_runtime_stalled', 'request_cancel_run']);
  assert.equal(actions[0].reason, 'max_run_time');
});

test('recent artifact activity suppresses no-output warning', () => {
  const actions = planStalledRunActions({
    projectId: 'proj',
    tasks: [{
      id: 'item-1',
      status: 'in_progress',
      assignedAgent: 'agent-a',
      activeRunId: 'run-1',
      runLease: {
        runId: 'run-1',
        lastHeartbeatAt: now - 5_000,
        createdAt: now - 120_000,
      },
      runTelemetry: {
        childPid: 123,
        lastArtifactAt: now - 1_000,
      },
    }],
    now,
    noOutputWarningMs: 60_000,
  });

  assert.deepEqual(actions, []);
});

test('workflow-owned task is not marked stalled by runtime watchdog', () => {
  const actions = planStalledRunActions({
    projectId: 'proj',
    tasks: [{
      id: 'item-1',
      status: 'dispatched',
      assignedAgent: 'xiaok-worker',
      assignedExecutor: 'workflow',
      activeRunId: 'workflow-wf-proj-po-generated-task-workflow-1',
      runLease: null,
      updatedAt: now - 180_000,
      createdAt: now - 240_000,
    }],
    now,
    heartbeatTimeoutMs: 60_000,
  });

  assert.deepEqual(actions, []);
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
  console.log(`\n${passed}/${tests.length} stalled run watchdog tests passed`);
}
