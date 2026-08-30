/**
 * Legacy null-room project isolation (design §8.5, §9.2, §16.2).
 *
 * RED until Phase 2 implementation lands.
 *
 * Invariants under test:
 *   - projects persisted with primaryRoomId === null (legacy migration
 *     window / blocked_member_limit) keep working through the plain
 *     KSwarm dispatch -> result -> review flow.
 *   - during that entire flow the broker sees ZERO room-surface calls:
 *     no room snapshot, no lease, no room event publish. Room tables,
 *     events, wake obligations and context are never touched.
 *   - the exemption is decided by the persisted primaryRoomId only —
 *     a caller flag cannot opt a room-linked project into the legacy path.
 */
import assert from 'node:assert/strict';
import { createHub } from '../src/core/hub.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function createRoomAwareBrokerClient() {
  const roomSurfaceCalls = {
    getRoomSnapshot: 0,
    acquireRoomMembershipLease: 0,
    publishRoomProjectEvent: 0,
  };
  return {
    roomSurfaceCalls,
    async getRoomSnapshot() {
      roomSurfaceCalls.getRoomSnapshot += 1;
      return { ok: true, room: { roomId: 'room-1', status: 'active', revision: 1 }, members: [] };
    },
    async acquireRoomMembershipLease() {
      roomSurfaceCalls.acquireRoomMembershipLease += 1;
      return { ok: true, lease: { token: 'lease-x', expiresAt: new Date(Date.now() + 30_000).toISOString() } };
    },
    async publishRoomProjectEvent() {
      roomSurfaceCalls.publishRoomProjectEvent += 1;
      return { ok: true };
    },
    async sendTo() {
      return { deliveredCount: 0, onlineRecipients: [], offlineRecipients: [] };
    },
  };
}

test('a legacy null-room project completes dispatch and results with zero room-surface calls', () => {
  const brokerClient = createRoomAwareBrokerClient();
  const hub = createHub({ silent: true, brokerClient });

  const project = hub.createProject({
    id: 'proj-legacy-flow',
    name: 'legacy flow',
    goal: 'g',
    poAgent: 'xiaok-po',
    members: ['xiaok-worker'],
    primaryRoomId: null,
  });
  assert.equal(project.primaryRoomId, null);

  // a real task lifecycle step that would attach room context if it existed
  const result = hub.submitTaskResult({
    projectId: project.id,
    taskId: 'task-legacy-1',
    agentId: 'xiaok-po',
    summary: 'legacy done',
  });
  assert.ok(result, 'legacy flow must keep working');

  assert.equal(brokerClient.roomSurfaceCalls.getRoomSnapshot, 0);
  assert.equal(brokerClient.roomSurfaceCalls.acquireRoomMembershipLease, 0);
  assert.equal(brokerClient.roomSurfaceCalls.publishRoomProjectEvent, 0);
});

test('a room-linked project cannot masquerade as legacy via a caller flag', async () => {
  const brokerClient = createRoomAwareBrokerClient();
  const hub = createHub({ silent: true, brokerClient });

  await assert.rejects(
    () => hub.createProject(
      {
        id: 'proj-masquerade',
        name: 'masquerade',
        goal: 'g',
        poAgent: 'xiaok-po',
        members: [],
        primaryRoomId: 'room-1',
        // spoof attempts must not downgrade the room-linked create
        legacyExemption: true,
        skipRoomLink: true,
      },
      { requestSource: 'user', actor: { kind: 'user', userId: 'user.local' } }
    ),
    (err) => err.code === 'room_membership_required'
  );
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
  console.log(`\n${passed}/${tests.length} legacy room isolation tests passed`);
}
