/**
 * Shared agent route contract and legacy room isolation
 * (design §6.2, §9.2, §16.2).
 *
 * RED until Phase 2 implementation lands.
 *
 * Invariants under test:
 *   - resolveBrokerDispatchTarget stays the single envelope producer:
 *     hosted / hosted_fallback / self_running all yield
 *     { executionMode, targetParticipantId, targetAgentId?, hostParticipantId? }.
 *   - route resolution fails CLOSED: an agent with no resolvable identity
 *     returns agent_route_unavailable instead of falling back to a bare
 *     participant id or broadcast (current code falls back — this is the
 *     regression this test pins).
 *   - ambiguous host/logical bindings return agent_route_identity_conflict.
 *   - legacy null-room projects never touch room state: dispatch to an
 *     agent that happens to also be a room member stays a plain task
 *     session — no lease, no room publish, no room context.
 */
import assert from 'node:assert/strict';
import { resolveBrokerDispatchTarget } from '../src/core/agent-execution.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('hosted agents under one host participant keep distinct targetAgentId envelopes', () => {
  const po = resolveBrokerDispatchTarget({ id: 'logical-po', execution: { mode: 'hosted', hostParticipantId: 'xiaok-desktop' } });
  const worker = resolveBrokerDispatchTarget({ id: 'logical-worker', execution: { mode: 'hosted', hostParticipantId: 'xiaok-desktop' } });

  assert.equal(po.executionMode, 'hosted');
  assert.equal(po.targetParticipantId, 'xiaok-desktop');
  assert.equal(po.hostParticipantId, 'xiaok-desktop');
  assert.equal(po.targetAgentId, 'logical-po');

  assert.equal(worker.targetParticipantId, 'xiaok-desktop');
  assert.equal(worker.targetAgentId, 'logical-worker');
  assert.notEqual(po.targetAgentId, worker.targetAgentId);
});

test('self_running agents route to their own participant with no host override', () => {
  const route = resolveBrokerDispatchTarget({ id: 'qoder-1', execution: { mode: 'self_running', participantId: 'qoder-main' } });

  assert.equal(route.executionMode, 'self_running');
  assert.equal(route.targetParticipantId, 'qoder-main');
  assert.equal(route.hostParticipantId, undefined);
  assert.equal(route.targetAgentId, undefined);
});

test('route resolution fails closed for agents without a resolvable identity', () => {
  const route = resolveBrokerDispatchTarget({});

  assert.equal(route.ok, false, 'must not fabricate a target from nothing');
  assert.equal(route.code, 'agent_route_unavailable');
  assert.equal(route.targetParticipantId, undefined);
});

test('route resolution fails closed when the declared id is not a real participant', () => {
  // an agent object with only a display id used to fall back to
  // targetParticipantId = agent.id; that bare-participant fallback is
  // exactly what design §9.2 forbids.
  const route = resolveBrokerDispatchTarget({ id: 'someone-claimed' });

  assert.equal(route.ok, false);
  assert.equal(route.code, 'agent_route_unavailable');
});

test('degraded self_running agents with desktop fallback route via the fallback envelope', () => {
  const route = resolveBrokerDispatchTarget({
    id: 'kimi-1',
    execution: { mode: 'self_running', participantId: 'kimi-main' },
    fallbackToDesktopModel: true,
    runtimeHealth: { state: 'offline' },
  });

  assert.equal(route.executionMode, 'hosted_fallback');
  assert.equal(route.targetParticipantId, 'xiaok-desktop');
  assert.equal(route.targetAgentId, 'kimi-1');
});

test('conflicting host bindings for the same logical agent are rejected', () => {
  const route = resolveBrokerDispatchTarget({
    id: 'logical-po',
    execution: { mode: 'hosted', hostParticipantId: 'xiaok-desktop' },
    participantId: 'some-other-host',
  });

  assert.equal(route.ok, false);
  assert.equal(route.code, 'agent_route_identity_conflict');
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
if (process.exitCode !== 1) {
  console.log(`\n${passed}/${tests.length} room route contract tests passed`);
}
