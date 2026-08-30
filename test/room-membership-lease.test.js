/**
 * Membership-use lease gate (design §8.5, §9.2, §16.2).
 *
 * RED until Phase 2 implementation lands.
 *
 * Contract under test — new module src/core/room-membership-lease.js:
 *   - acquireRoomLeaseForOperation({ brokerClient, primaryRoomId,
 *     logicalAgentId, operationId }): default-deny gate that every
 *     room-linked dispatch / PO change / member add / review / rework /
 *     cancel must call before assigning work to a room agent.
 *   - assertRoomLeaseMatchesOperation({ lease, primaryRoomId,
 *     logicalAgentId, operationId }): a lease is bound to one operation;
 *     cross-room or cross-agent reuse is rejected.
 *   - hub.listRoomMemberBlockers({ projectId, logicalAgentId }): the
 *     KSwarm-owned blocker set consulted by the broker before finalizing
 *     a member removal (PO / member / assignee / review owner).
 *
 * The fake brokerClient is a test double for the external intent-broker.
 */
import assert from 'node:assert/strict';
import { createHub } from '../src/core/hub.js';
import {
  acquireRoomLeaseForOperation,
  assertRoomLeaseMatchesOperation,
} from '../src/core/room-membership-lease.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function fakeLease({ roomId = 'room-1', logicalAgentId = 'agent-po', operationId = 'op-1', ttlMs = 30_000 } = {}) {
  return {
    token: `lease-${roomId}-${logicalAgentId}-${operationId}`,
    roomId,
    logicalAgentId,
    operationId,
    roomRevision: 3,
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
  };
}

function createBrokerClient(leaseOutcome) {
  const calls = [];
  return {
    calls,
    async acquireRoomMembershipLease(input) {
      calls.push(input);
      return typeof leaseOutcome === 'function' ? leaseOutcome(input) : leaseOutcome;
    },
  };
}

test('acquireRoomLeaseForOperation requests a lease bound to room+agent+operation', async () => {
  const brokerClient = createBrokerClient(async ({ roomId, logicalAgentId, operationId }) => ({
    ok: true,
    lease: fakeLease({ roomId, logicalAgentId, operationId }),
  }));

  const lease = await acquireRoomLeaseForOperation({
    brokerClient,
    primaryRoomId: 'room-1',
    logicalAgentId: 'agent-po',
    operationId: 'request_task:task-9',
  });

  assert.equal(lease.roomId, 'room-1');
  assert.equal(lease.logicalAgentId, 'agent-po');
  assert.equal(lease.operationId, 'request_task:task-9');
  assert.equal(brokerClient.calls.length, 1);
  assert.deepEqual(brokerClient.calls[0], {
    roomId: 'room-1',
    logicalAgentId: 'agent-po',
    operationId: 'request_task:task-9',
  });
});

test('a lease denial from the broker fails closed with room_membership_lease_required', async () => {
  const brokerClient = createBrokerClient({ ok: false, code: 'room_member_removal_pending' });

  await assert.rejects(
    acquireRoomLeaseForOperation({
      brokerClient,
      primaryRoomId: 'room-1',
      logicalAgentId: 'agent-po',
      operationId: 'assign_po:1',
    }),
    (err) => err.code === 'room_membership_lease_required' && err.cause === 'room_member_removal_pending'
  );
});

test('an expired lease is rejected and re-acquired at most once', async () => {
  let acquisitions = 0;
  const brokerClient = createBrokerClient(async ({ roomId, logicalAgentId, operationId }) => {
    acquisitions += 1;
    return {
      ok: true,
      // every lease the broker hands out is already expired
      lease: fakeLease({ roomId, logicalAgentId, operationId, ttlMs: -1_000 }),
    };
  });

  await assert.rejects(
    acquireRoomLeaseForOperation({
      brokerClient,
      primaryRoomId: 'room-1',
      logicalAgentId: 'agent-po',
      operationId: 'rework:task-2',
    }),
    (err) => err.code === 'room_membership_lease_expired'
  );
  assert.equal(acquisitions, 2, 'one retry for an expired lease, then fail closed');
});

test('a lease cannot be replayed against another room, agent or operation', async () => {
  const lease = fakeLease({ roomId: 'room-a', logicalAgentId: 'agent-po', operationId: 'op-1' });

  assert.throws(
    () => assertRoomLeaseMatchesOperation({
      lease, primaryRoomId: 'room-b', logicalAgentId: 'agent-po', operationId: 'op-1',
    }),
    (err) => err.code === 'room_actor_identity_mismatch'
  );

  assert.throws(
    () => assertRoomLeaseMatchesOperation({
      lease, primaryRoomId: 'room-a', logicalAgentId: 'agent-worker', operationId: 'op-1',
    }),
    (err) => err.code === 'room_actor_identity_mismatch'
  );

  assert.throws(
    () => assertRoomLeaseMatchesOperation({
      lease, primaryRoomId: 'room-a', logicalAgentId: 'agent-po', operationId: 'op-2',
    }),
    (err) => err.code === 'room_actor_identity_mismatch'
  );

  // the matching operation still passes
  assertRoomLeaseMatchesOperation({
    lease, primaryRoomId: 'room-a', logicalAgentId: 'agent-po', operationId: 'op-1',
  });
});

test('hub exposes the KSwarm-owned blocker set for member removal arbitration', () => {
  const hub = createHub({ silent: true });
  const project = hub.createProject({
    id: 'proj-blockers',
    name: 'blockers',
    goal: 'g',
    poAgent: 'agent-po',
    members: ['agent-worker'],
    primaryRoomId: null, // blockers are a project fact, independent of the room link
  });

  const poBlockers = hub.listRoomMemberBlockers({ projectId: project.id, logicalAgentId: 'agent-po' });
  assert.ok(poBlockers.blockers.some((b) => b.startsWith('project_po')), JSON.stringify(poBlockers));

  const memberBlockers = hub.listRoomMemberBlockers({ projectId: project.id, logicalAgentId: 'agent-worker' });
  assert.ok(memberBlockers.blockers.some((b) => b.startsWith('project_member')), JSON.stringify(memberBlockers));

  const none = hub.listRoomMemberBlockers({ projectId: project.id, logicalAgentId: 'agent-ghost' });
  assert.deepEqual(none.blockers, []);
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
  console.log(`\n${passed}/${tests.length} room membership lease tests passed`);
}
