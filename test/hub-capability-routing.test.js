/**
 * KSwarm — hub capability routing tests
 *
 * Run: node test/hub-capability-routing.test.js
 */

import assert from 'node:assert/strict';
import { createHub } from '../src/core/hub.js';

const PRESENTATION_PPTX_EXECUTOR_ID = 'kswarm.executor.presentation.pptx.v1';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function createBridge() {
  const sent = [];
  return {
    requestTask(p) { sent.push({ kind: 'request_task', ...p }); },
    send(p) { sent.push(p); },
    sent,
  };
}

test('hub dispatch reroutes away from degraded assigned agent when profiles are available', () => {
  const bridge = createBridge();
  const hub = createHub({
    bridge,
    silent: true,
    getAgentProfiles: () => [
      { id: 'worker-a', runtimeHealth: { state: 'cooldown', cooldownUntil: Date.now() + 60_000, taskCapabilities: ['analysis'], outputCapabilities: ['markdown'] } },
      { id: 'worker-b', runtimeHealth: { state: 'healthy', taskCapabilities: ['analysis'], outputCapabilities: ['markdown'] } },
    ],
  });

  hub.createProject({ id: 'proj-route', name: 'Route', goal: 'goal', poAgent: 'po', members: ['worker-a', 'worker-b'] });
  hub.handleCreateTasks('proj-route', [
    { id: 'analysis', title: '分析报告', assignedAgent: 'worker-a', requiredCapabilities: ['analysis'], requiredOutputs: ['markdown'] },
  ], 'po');
  hub.handleApprove('proj-route');

  const dispatch = hub.handleRequestDispatch('proj-route', 'po');

  assert.equal(dispatch.ok, true);
  assert.deepEqual(dispatch.dispatched, ['proj-route__analysis']);
  assert.equal(hub.getBoard('proj-route').getTask('analysis').assignedAgent, 'worker-b');
  assert.equal(bridge.sent.find(m => m.kind === 'request_task').targetParticipantId, 'worker-b');
});

test('hub dispatch does not reroute project work to a healthy non-member agent', () => {
  const bridge = createBridge();
  const hub = createHub({
    bridge,
    silent: true,
    getAgentProfiles: () => [
      { id: 'worker-a', runtimeHealth: { state: 'cooldown', cooldownUntil: Date.now() + 60_000, taskCapabilities: ['analysis'], outputCapabilities: ['markdown'] } },
      { id: 'cli-xiaok', runtimeHealth: { state: 'healthy', taskCapabilities: ['analysis'], outputCapabilities: ['markdown'] } },
      { id: 'worker-b', runtimeHealth: { state: 'healthy', taskCapabilities: ['analysis'], outputCapabilities: ['markdown'] } },
    ],
  });

  hub.createProject({ id: 'proj-member-route', name: 'Route', goal: 'goal', poAgent: 'po', members: ['worker-a', 'worker-b'] });
  hub.handleCreateTasks('proj-member-route', [
    { id: 'analysis', title: '分析报告', assignedAgent: 'worker-a', requiredCapabilities: ['analysis'], requiredOutputs: ['markdown'] },
  ], 'po');
  hub.handleApprove('proj-member-route');

  const dispatch = hub.handleRequestDispatch('proj-member-route', 'po');

  assert.equal(dispatch.ok, true);
  assert.deepEqual(dispatch.dispatched, ['proj-member-route__analysis']);
  assert.equal(hub.getBoard('proj-member-route').getTask('analysis').assignedAgent, 'worker-b');
  assert.equal(bridge.sent.find(m => m.kind === 'request_task').targetParticipantId, 'worker-b');
});

test('runtime failure retry is redispatched through capability routing instead of same degraded agent', () => {
  let profiles = [
    { id: 'worker-a', runtimeHealth: { state: 'healthy', taskCapabilities: ['analysis'], outputCapabilities: ['markdown'] } },
    { id: 'worker-b', runtimeHealth: { state: 'healthy', taskCapabilities: ['analysis'], outputCapabilities: ['markdown'] } },
  ];
  const hub = createHub({
    silent: true,
    getAgentProfiles: () => profiles,
  });

  hub.createProject({ id: 'proj-retry-route', name: 'Retry Route', goal: 'goal', poAgent: 'po', members: ['worker-a', 'worker-b'] });
  hub.handleCreateTasks('proj-retry-route', [
    { id: 'analysis', title: '分析报告', assignedAgent: 'worker-a', requiredCapabilities: ['analysis'], requiredOutputs: ['markdown'] },
  ], 'po');
  hub.handleApprove('proj-retry-route');
  const dispatch = hub.handleRequestDispatch('proj-retry-route', 'po');
  assert.equal(dispatch.ok, true);

  const board = hub.getBoard('proj-retry-route');
  const original = board.getTask('analysis');
  profiles = [
    { id: 'worker-a', runtimeHealth: { state: 'cooldown', cooldownUntil: Date.now() + 60_000, taskCapabilities: ['analysis'], outputCapabilities: ['markdown'] } },
    { id: 'cli-xiaok', runtimeHealth: { state: 'healthy', taskCapabilities: ['analysis'], outputCapabilities: ['markdown'] } },
    { id: 'worker-b', runtimeHealth: { state: 'healthy', taskCapabilities: ['analysis'], outputCapabilities: ['markdown'] } },
  ];

  const failed = hub.handleWorkerFailure(
    'proj-retry-route',
    original.id,
    'worker-a',
    original.activeRunId,
    'runtime_generation_unavailable',
    'CLI and LLM both failed'
  );

  assert.equal(failed.ok, true);
  assert.equal(failed.retried, true);
  assert.equal(failed.retryDispatched, true);
  const retry = board.getTask(failed.retryTaskId);
  assert.equal(retry.status, 'dispatched');
  assert.equal(retry.assignedAgent, 'worker-b');
  assert.equal(retry.preferredAssignedAgent, 'worker-a');
});

test('source provider failure creates a retry without requiring a different healthy agent', () => {
  const hub = createHub({
    silent: true,
    getAgentProfiles: () => [
      { id: 'worker-a', runtimeHealth: { state: 'healthy', taskCapabilities: ['source_research'], outputCapabilities: ['markdown'] } },
    ],
  });

  hub.createProject({ id: 'proj-source-provider-retry', name: 'Source Provider Retry', goal: 'goal', poAgent: 'po', members: ['worker-a'] });
  hub.handleCreateTasks('proj-source-provider-retry', [
    { id: 'sources', title: '收集公开来源', assignedAgent: 'worker-a', requiredCapabilities: ['source_research'], requiredOutputs: ['markdown'] },
  ], 'po');
  hub.handleApprove('proj-source-provider-retry');
  const dispatch = hub.handleRequestDispatch('proj-source-provider-retry', 'po');
  assert.equal(dispatch.ok, true);

  const board = hub.getBoard('proj-source-provider-retry');
  const original = board.getTask('sources');
  const failed = hub.handleWorkerFailure(
    'proj-source-provider-retry',
    original.id,
    'worker-a',
    original.activeRunId,
    'source_provider_unavailable',
    'duckduckgo connect timeout'
  );

  assert.equal(failed.ok, true);
  assert.equal(failed.retried, true);
  assert.equal(failed.retryDispatched, true);
  const retry = board.getTask(failed.retryTaskId);
  assert.equal(retry.status, 'dispatched');
  assert.equal(retry.assignedAgent, 'worker-a');
});

test('offline assigned CLI is skipped on dispatch and retry when an online project worker exists', () => {
  const bridge = createBridge();
  const profiles = [
    {
      id: 'cli-claude',
      status: 'offline',
      roles: ['worker'],
      runtimeHealth: { state: 'healthy', taskCapabilities: ['planning'], outputCapabilities: ['markdown'] },
    },
    {
      id: 'xiaok-worker',
      status: 'idle',
      roles: ['worker'],
      runtimeHealth: { state: 'healthy', taskCapabilities: ['planning'], outputCapabilities: ['markdown'] },
    },
  ];
  const hub = createHub({
    bridge,
    silent: true,
    getAgentProfiles: () => profiles,
  });

  hub.createProject({ id: 'proj-offline-cli', name: 'Offline CLI', goal: 'goal', poAgent: 'po', members: ['cli-claude', 'xiaok-worker'] });
  hub.handleCreateTasks('proj-offline-cli', [
    { id: 'draft', title: '撰写第一轮分析报告', assignedAgent: 'cli-claude', requiredCapabilities: ['planning'], requiredOutputs: ['markdown'] },
  ], 'po');
  hub.handleApprove('proj-offline-cli');

  const dispatch = hub.handleRequestDispatch('proj-offline-cli', 'po');

  assert.equal(dispatch.ok, true);
  assert.deepEqual(dispatch.dispatched, ['proj-offline-cli__draft']);
  assert.equal(hub.getBoard('proj-offline-cli').getTask('draft').assignedAgent, 'xiaok-worker');
  assert.equal(bridge.sent.find(m => m.kind === 'request_task').targetParticipantId, 'xiaok-worker');

  const board = hub.getBoard('proj-offline-cli');
  const retrySource = board.getTask('draft');
  board.transition(retrySource.id, 'failed', { failureReason: 'agent_error', failureClass: 'agent_error' });
  board.transition(retrySource.id, 'pending', { assignedAgent: 'cli-claude' });
  board.transition(retrySource.id, 'dispatched', { assignedAgent: 'cli-claude' });
  const original = board.getTask(retrySource.id);

  const failed = hub.handleWorkerFailure(
    'proj-offline-cli',
    original.id,
    'cli-claude',
    original.activeRunId,
    'runtime_offline',
    'participant_offline'
  );

  assert.equal(failed.ok, true);
  assert.equal(failed.retried, true);
  assert.equal(failed.retryDispatched, true);
  const retry = board.getTask(failed.retryTaskId);
  assert.equal(retry.status, 'dispatched');
  assert.equal(retry.assignedAgent, 'xiaok-worker');
  assert.equal(retry.preferredAssignedAgent, 'cli-claude');
});

test('runtime failure retry for generic task does not fall back to presentation executor', () => {
  const hub = createHub({
    silent: true,
    getAgentProfiles: () => [
      { id: 'worker-a', runtimeHealth: { state: 'limited', taskCapabilities: ['analysis'], outputCapabilities: ['markdown'] } },
    ],
  });

  hub.createProject({ id: 'proj-generic-retry', name: 'Generic Retry', goal: 'goal', poAgent: 'po', members: ['worker-a'] });
  hub.handleCreateTasks('proj-generic-retry', [
    { id: 'sources', title: '定义真实性基准并收集素材', assignedAgent: 'worker-a' },
  ], 'po');

  const board = hub.getBoard('proj-generic-retry');
  board.transition('sources', 'dispatched', { assignedAgent: 'worker-a' });
  const original = board.getTask('sources');

  const failed = hub.handleWorkerFailure(
    'proj-generic-retry',
    original.id,
    'worker-a',
    original.activeRunId,
    'agent_error',
    'CLI and LLM both failed'
  );

  assert.equal(failed.ok, true);
  assert.equal(failed.retried, true);
  assert.equal(failed.retryDispatched, false);
  const retry = board.getTask(failed.retryTaskId);
  assert.equal(retry.status, 'pending');
  assert.notEqual(retry.assignedAgent, PRESENTATION_PPTX_EXECUTOR_ID);
  assert.equal(retry.selectedRoute?.selectedExecutorId ?? null, null);
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
  console.log(`\n${passed}/${tests.length} hub capability routing tests passed`);
}
