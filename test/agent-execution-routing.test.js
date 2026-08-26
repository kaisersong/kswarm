import assert from 'node:assert/strict';
import {
  resolveAgentExecution,
  resolveBrokerDispatchTarget,
  resolveIncomingLogicalAgent,
} from '../src/core/agent-execution.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('desktop xiaok seeds default to hosted execution through xiaok desktop', () => {
  assert.deepEqual(resolveAgentExecution({
    id: 'xiaok-worker',
    runtimeType: 'xiaok',
    runtimeSource: 'desktop-agent-runtime',
  }), {
    mode: 'hosted',
    hostParticipantId: 'xiaok-desktop',
  });
});

test('explicit CLI runtime defaults to self-running execution through its participant id', () => {
  assert.deepEqual(resolveAgentExecution({
    id: 'codex3',
    runtimeType: 'codex',
    participantId: 'codex-session-019e905e',
    runtimePath: '/opt/homebrew/bin/codex',
  }), {
    mode: 'self_running',
    participantId: 'codex-session-019e905e',
  });
});

test('hosted agent dispatch targets host and preserves logical targetAgentId', () => {
  const route = resolveBrokerDispatchTarget({
    id: 'xiaok-worker',
    execution: { mode: 'hosted', hostParticipantId: 'xiaok-desktop' },
  });

  assert.equal(route.targetParticipantId, 'xiaok-desktop');
  assert.equal(route.targetAgentId, 'xiaok-worker');
  assert.equal(route.executionMode, 'hosted');
});

test('self-running agent dispatch targets its own participant', () => {
  const route = resolveBrokerDispatchTarget({
    id: 'codex3',
    execution: { mode: 'self_running', participantId: 'codex-session-019e905e' },
  });

  assert.equal(route.targetParticipantId, 'codex-session-019e905e');
  assert.equal(route.targetAgentId, undefined);
  assert.equal(route.executionMode, 'self_running');
});

test('unhealthy external agent with desktop fallback routes to desktop and preserves logical id', () => {
  const route = resolveBrokerDispatchTarget({
    id: 'codex3',
    execution: { mode: 'self_running', participantId: 'codex-session-019e905e' },
    fallbackToDesktopModel: true,
    runtimeHealth: { state: 'degraded' },
  });

  assert.equal(route.targetParticipantId, 'xiaok-desktop');
  assert.equal(route.targetAgentId, 'codex3');
  assert.equal(route.executionMode, 'hosted_fallback');
  assert.equal(route.fallbackRuntime, 'desktop_current_model');
});

test('fallback remains opt-in and does not redirect a healthy external agent', () => {
  const optedOut = resolveBrokerDispatchTarget({
    id: 'codex3',
    execution: { mode: 'self_running', participantId: 'codex-session-019e905e' },
    runtimeHealth: { state: 'degraded' },
  });
  const healthy = resolveBrokerDispatchTarget({
    id: 'codex3',
    execution: { mode: 'self_running', participantId: 'codex-session-019e905e' },
    fallbackToDesktopModel: true,
    runtimeHealth: { state: 'healthy' },
  });

  assert.equal(optedOut.targetParticipantId, 'codex-session-019e905e');
  assert.equal(healthy.targetParticipantId, 'codex-session-019e905e');
});

test('an explicitly offline external agent falls back before dispatch even without a prior probe', () => {
  const route = resolveBrokerDispatchTarget({
    id: 'claude-worker',
    status: 'offline',
    execution: { mode: 'self_running', participantId: 'claude-worker' },
    fallbackToDesktopModel: true,
    runtimeHealth: { state: 'unknown' },
  });
  assert.equal(route.targetParticipantId, 'xiaok-desktop');
  assert.equal(route.targetAgentId, 'claude-worker');
});

test('hosted response resolves logical agent from payload instead of broker sender', () => {
  assert.equal(resolveIncomingLogicalAgent({
    fromParticipantId: 'xiaok-desktop',
    payload: { participantId: 'xiaok-worker' },
  }), 'xiaok-worker');
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
if (process.exitCode !== 1) console.log(`\n${passed}/${tests.length} agent execution routing tests passed`);
