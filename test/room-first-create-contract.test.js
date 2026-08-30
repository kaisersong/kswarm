/**
 * Room-first project creation contract (design §8.2, §9.2, §11.2, §16.2).
 *
 * RED until Phase 2 implementation lands.
 *
 * Contract under test — hub.createProject(input, mutationCtx?):
 *   - input gains primaryRoomId / sourceMessageIds / linkedBy.
 *   - mutationCtx = { requestSource: 'user' | 'agent' | 'system', actor }.
 *   - Room-first create (trusted user) MUST:
 *       1. verify the room is active via the broker snapshot,
 *       2. acquire a membership-use lease for the PO and every member,
 *       3. write Project + primary RoomProjectLink + projection outbox in
 *          one transaction,
 *       4. fail closed with stable codes otherwise.
 *   - agent-source create is rejected from every entry (design §9.2).
 *   - legacy null-room create only stays available inside the migration
 *     compatibility window via the old no-room input, never via the
 *     Room-first path.
 *   - the same clientRequestKey returns the same project after a crash
 *     retry (no duplicate projects).
 *
 * The fake brokerClient below is a test double for an EXTERNAL service
 * (intent-broker). It records calls; it does not re-implement KSwarm logic.
 */
import assert from 'node:assert/strict';
import { createHub } from '../src/core/hub.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function createFakeBrokerClient(overrides = {}) {
  const publishHandlers = [];
  const calls = {
    getRoomSnapshot: [],
    acquireRoomMembershipLease: [],
    publishRoomProjectEvent: [],
  };
  const rooms = new Map();
  const defineRoom = ({ roomId, status = 'active', members = [] }) => {
    rooms.set(roomId, {
      room: { roomId, status, revision: 1 },
      members: members.map((logicalAgentId) => ({
        subject: { kind: 'agent', logicalAgentId },
        role: 'member',
        status: 'active',
      })),
      messages: [{ messageId: 'msg-1' }, { messageId: 'msg-2' }],
    });
  };
  return {
    calls,
    defineRoom,
    setPublishHandler(handler) { publishHandlers.push(handler); },
    async getRoomSnapshot(roomId) {
      calls.getRoomSnapshot.push(roomId);
      const snapshot = rooms.get(roomId);
      if (!snapshot) return { ok: false, code: 'room_not_found' };
      return { ok: true, ...snapshot };
    },
    async acquireRoomMembershipLease({ roomId, logicalAgentId, operationId }) {
      calls.acquireRoomMembershipLease.push({ roomId, logicalAgentId, operationId });
      const snapshot = rooms.get(roomId);
      if (!snapshot) return { ok: false, code: 'room_not_found' };
      if (snapshot.room.status !== 'active') return { ok: false, code: 'room_archived' };
      const member = snapshot.members.find(
        (m) => m.subject.logicalAgentId === logicalAgentId && m.status === 'active'
      );
      if (!member) return { ok: false, code: 'room_membership_required' };
      return {
        ok: true,
        lease: {
          token: `lease-${roomId}-${logicalAgentId}-${operationId}`,
          roomId,
          logicalAgentId,
          roomRevision: snapshot.room.revision,
          operationId,
          expiresAt: new Date(Date.now() + 30_000).toISOString(),
        },
      };
    },
    async publishRoomProjectEvent(event) {
      calls.publishRoomProjectEvent.push(event);
      const handler = publishHandlers.at(-1);
      return handler ? handler(event) : { ok: true };
    },
    ...overrides,
  };
}

function userCtx() {
  return { requestSource: 'user', actor: { kind: 'user', userId: 'user.local' } };
}

function agentCtx(logicalAgentId) {
  return {
    requestSource: 'agent',
    actor: { kind: 'agent', logicalAgentId },
  };
}

function roomFirstInput(overrides = {}) {
  return {
    id: 'proj-room-first',
    name: 'Room 衍生项目',
    goal: '从讨论创建',
    poAgent: 'agent-po',
    members: ['agent-worker'],
    primaryRoomId: 'room-1',
    sourceMessageIds: ['msg-1', 'msg-2'],
    linkedBy: { kind: 'user', userId: 'user.local' },
    clientRequestKey: 'room-create:op-1',
    ...overrides,
  };
}

test('room-first create persists primaryRoomId, link provenance and an outbox item in one transaction', async () => {
  const brokerClient = createFakeBrokerClient();
  brokerClient.defineRoom({ roomId: 'room-1', members: ['agent-po', 'agent-worker'] });

  const hub = createHub({ silent: true, brokerClient });
  const project = await hub.createProject(roomFirstInput(), userCtx());

  assert.equal(project.primaryRoomId, 'room-1');
  assert.equal(project.roomLink.kind, 'primary');
  assert.deepEqual(project.roomLink.sourceMessageIds, ['msg-1', 'msg-2']);
  assert.deepEqual(project.roomLink.linkedBy, { kind: 'user', userId: 'user.local' });

  // lease acquired for the PO and every member
  const leasedAgents = brokerClient.calls.acquireRoomMembershipLease
    .map((call) => call.logicalAgentId)
    .sort();
  assert.deepEqual(leasedAgents, ['agent-po', 'agent-worker']);
  // every lease call binds roomId + operationId (no caller-declared bypass)
  for (const call of brokerClient.calls.acquireRoomMembershipLease) {
    assert.equal(call.roomId, 'room-1');
    assert.ok(call.operationId, 'lease must be bound to an operationId');
  }

  // the projection outbox holds a pending project.created item
  const outbox = hub.getRoomEventOutbox({ projectId: project.id });
  const created = outbox.items.filter((item) => item.eventType === 'project.created');
  assert.equal(created.length, 1);
  assert.ok(created[0].projectionEventId);
  assert.ok(['pending', 'published'].includes(created[0].status));
});

test('PO outside the room membership is rejected with room_membership_required', async () => {
  const brokerClient = createFakeBrokerClient();
  brokerClient.defineRoom({ roomId: 'room-1', members: ['agent-worker'] });

  const hub = createHub({ silent: true, brokerClient });
  await assert.rejects(
    () => hub.createProject(roomFirstInput(), userCtx()),
    (err) => err.code === 'room_membership_required'
  );
  assert.equal(hub.listProjects().filter((p) => p.id === 'proj-room-first').length, 0);
});

test('a member outside the room membership is rejected even when the PO is a member', async () => {
  const brokerClient = createFakeBrokerClient();
  brokerClient.defineRoom({ roomId: 'room-1', members: ['agent-po'] });

  const hub = createHub({ silent: true, brokerClient });
  await assert.rejects(
    () => hub.createProject(roomFirstInput(), userCtx()),
    (err) => err.code === 'room_membership_required'
  );
});

test('creating against an archiving room is rejected with room_archived', async () => {
  const brokerClient = createFakeBrokerClient();
  brokerClient.defineRoom({ roomId: 'room-1', status: 'archiving', members: ['agent-po', 'agent-worker'] });

  const hub = createHub({ silent: true, brokerClient });
  await assert.rejects(
    () => hub.createProject(roomFirstInput(), userCtx()),
    (err) => err.code === 'room_archived'
  );
});

test('a denied membership lease fails create closed with no project left behind', async () => {
  const brokerClient = createFakeBrokerClient();
  brokerClient.defineRoom({ roomId: 'room-1', members: ['agent-po', 'agent-worker'] });
  brokerClient.acquireRoomMembershipLease = async ({ logicalAgentId }) =>
    logicalAgentId === 'agent-worker'
      ? { ok: false, code: 'room_member_removal_pending' }
      : {
          ok: true,
          lease: {
            token: `lease-${logicalAgentId}`,
            roomId: 'room-1',
            logicalAgentId,
            expiresAt: new Date(Date.now() + 30_000).toISOString(),
          },
        };

  const hub = createHub({ silent: true, brokerClient });
  await assert.rejects(
    () => hub.createProject(roomFirstInput(), userCtx()),
    (err) => err.code === 'room_membership_lease_required'
  );
  assert.equal(hub.listProjects().filter((p) => p.id === 'proj-room-first').length, 0);
});

test('agent-source create is rejected regardless of entry surface', async () => {
  const brokerClient = createFakeBrokerClient();
  brokerClient.defineRoom({ roomId: 'room-1', members: ['agent-po', 'agent-worker'] });

  const hub = createHub({ silent: true, brokerClient });
  assert.throws(
    () => hub.createProject(roomFirstInput(), agentCtx('agent-po')),
    (err) => err.code === 'room_actor_forbidden'
  );
  // the legacy null-room input cannot be abused by an agent either
  assert.throws(
    () => hub.createProject(
      { id: 'proj-agent-legacy', name: 'agent legacy', goal: 'x', poAgent: 'agent-po' },
      agentCtx('agent-po')
    ),
    (err) => err.code === 'room_actor_forbidden'
  );
});

test('trusted user create without primaryRoomId is rejected by the Room-first path', async () => {
  const hub = createHub({ silent: true, brokerClient: createFakeBrokerClient() });
  await assert.rejects(
    () => hub.createProject(
      { id: 'proj-no-room', name: 'no room', goal: 'x', poAgent: 'agent-po' },
      userCtx()
    ),
    (err) => err.code === 'room_primary_room_required'
  );
});

test('the legacy no-room input still works inside the migration compatibility window', () => {
  const hub = createHub({ silent: true, brokerClient: createFakeBrokerClient() });
  const project = hub.createProject({ id: 'proj-legacy', name: 'legacy', goal: 'x', poAgent: 'agent-po' });

  assert.equal(project.primaryRoomId, null);
  assert.equal(project.roomLink, undefined);
});

test('the same clientRequestKey returns the same project on retry after a crash', async () => {
  const brokerClient = createFakeBrokerClient();
  brokerClient.defineRoom({ roomId: 'room-1', members: ['agent-po', 'agent-worker'] });

  const hub = createHub({ silent: true, brokerClient });
  const first = await hub.createProject(roomFirstInput(), userCtx());

  // simulate the desktop saga retrying the exact same clientRequestKey
  const retry = await hub.createProject(roomFirstInput({ id: 'proj-other-id' }), userCtx());
  assert.equal(retry.id, first.id);
  assert.equal(hub.listProjects().filter((p) => p.primaryRoomId === 'room-1').length, 1);
});

test('project.created outbox publication is retried by projectionEventId, not duplicated', async () => {
  const brokerClient = createFakeBrokerClient();
  brokerClient.defineRoom({ roomId: 'room-1', members: ['agent-po', 'agent-worker'] });
  let publishAttempts = 0;
  brokerClient.setPublishHandler(async () => {
    publishAttempts += 1;
    if (publishAttempts === 1) return { ok: false, code: 'broker_unavailable' };
    return { ok: true };
  });

  const hub = createHub({ silent: true, brokerClient });
  const project = await hub.createProject(roomFirstInput(), userCtx());

  // first flush fails, second flush succeeds with the SAME projectionEventId
  await hub.flushRoomEventOutbox();
  await hub.flushRoomEventOutbox();

  assert.equal(brokerClient.calls.publishRoomProjectEvent.length, 2);
  const [firstEvent, secondEvent] = brokerClient.calls.publishRoomProjectEvent;
  assert.equal(firstEvent.projectionEventId, secondEvent.projectionEventId);
  assert.equal(firstEvent.projectionEventId.split('#')[0], `proj:${project.id}`);

  const outbox = hub.getRoomEventOutbox({ projectId: project.id });
  assert.equal(outbox.items.filter((i) => i.eventType === 'project.created')[0].status, 'published');
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
  console.log(`\n${passed}/${tests.length} room-first create contract tests passed`);
}
