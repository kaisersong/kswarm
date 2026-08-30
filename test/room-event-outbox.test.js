/**
 * Room project event outbox (design §8.4, §11.1, §11.2, §16.2).
 *
 * RED until Phase 2 implementation lands.
 *
 * Invariants under test:
 *   - every room-visible project event gets a durable projectionEventId of
 *     the form `proj:<projectId>#<monotonicProjectEventSeq>`; projectRevision
 *     or in-process event-log seq must not be the unique key.
 *   - multiple same-type events inside one projectRevision keep distinct ids.
 *   - the monotonic sequence survives a hub restart (same dataDir).
 *   - a room that is archiving/archived suppresses the outbox item to the
 *     terminal `suppressed_room_archived` state: no retry loop, no project
 *     rollback, no new room message.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHub } from '../src/core/hub.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function sqliteDataDir(dir) {
  return { backend: 'sqlite', filePath: join(dir, 'state.sqlite'), legacyJsonPath: join(dir, 'state.json') };
}

function createDataDir() {
  return sqliteDataDir(mkdtempSync(join(tmpdir(), 'kswarm-room-outbox-')));
}

function createFakeBrokerClient(overrides = {}) {
  const calls = { publishRoomProjectEvent: [] };
  return {
    calls,
    async getRoomSnapshot(roomId) {
      return {
        ok: true,
        room: { roomId, status: 'active', revision: 1 },
        members: [
          { subject: { kind: 'agent', logicalAgentId: 'agent-po' }, status: 'active' },
        ],
      };
    },
    async acquireRoomMembershipLease() {
      return {
        ok: true,
        lease: {
          token: 'lease-x',
          roomId: 'room-1',
          logicalAgentId: 'agent-po',
          expiresAt: new Date(Date.now() + 30_000).toISOString(),
        },
      };
    },
    async publishRoomProjectEvent(event) {
      calls.publishRoomProjectEvent.push(event);
      return { ok: true };
    },
    ...overrides,
  };
}

function userCtx() {
  return { requestSource: 'user', actor: { kind: 'user', userId: 'user.local' } };
}

async function createRoomLinkedProject(hub) {
  return hub.createProject(
    {
      id: 'proj-outbox',
      name: 'outbox project',
      goal: 'g',
      poAgent: 'agent-po',
      members: [],
      primaryRoomId: 'room-1',
      clientRequestKey: 'room-create:outbox-1',
    },
    userCtx()
  );
}

test('same-type task events inside one projectRevision get distinct projectionEventIds', async () => {
  const brokerClient = createFakeBrokerClient();
  const hub = createHub({ silent: true, brokerClient });
  const project = await createRoomLinkedProject(hub);

  // two tasks complete without any project-level revision change in between
  hub.submitTaskResult({ projectId: project.id, taskId: 'task-1', agentId: 'agent-po', summary: 'done 1' });
  hub.submitTaskResult({ projectId: project.id, taskId: 'task-2', agentId: 'agent-po', summary: 'done 2' });

  await hub.flushRoomEventOutbox();

  const published = brokerClient.calls.publishRoomProjectEvent
    .map((event) => event.projectionEventId);
  const unique = new Set(published);
  assert.equal(unique.size, published.length, 'projectionEventIds must be unique');

  for (const id of published) {
    assert.match(id, /^proj:proj-outbox#\d+$/, 'id must embed the project and a monotonic seq');
  }

  const seqs = published.map((id) => Number(id.split('#')[1]));
  for (let i = 1; i < seqs.length; i += 1) {
    assert.ok(seqs[i] > seqs[i - 1], `sequence must be monotonic: ${seqs}`);
  }
});

test('the monotonic sequence does not reset after a hub restart on the same dataDir', async () => {
  const dataDir = createDataDir();
  const brokerClientOne = createFakeBrokerClient();
  const hubOne = createHub({ silent: true, brokerClient: brokerClientOne, dataDir });
  const project = await createRoomLinkedProject(hubOne);
  hubOne.submitTaskResult({ projectId: project.id, taskId: 'task-1', agentId: 'agent-po', summary: 'done 1' });
  await hubOne.flushRoomEventOutbox();
  const maxSeqBefore = Math.max(
    ...brokerClientOne.calls.publishRoomProjectEvent.map((e) => Number(e.projectionEventId.split('#')[1]))
  );
  hubOne.closePersistence();

  const brokerClientTwo = createFakeBrokerClient();
  const hubTwo = createHub({ silent: true, brokerClient: brokerClientTwo, dataDir });
  hubTwo.submitTaskResult({ projectId: project.id, taskId: 'task-2', agentId: 'agent-po', summary: 'done 2' });
  await hubTwo.flushRoomEventOutbox();

  const seqsAfter = brokerClientTwo.calls.publishRoomProjectEvent.map((e) => Number(e.projectionEventId.split('#')[1]));
  for (const seq of seqsAfter) {
    assert.ok(seq > maxSeqBefore, `sequence must not regress after restart: ${seq} <= ${maxSeqBefore}`);
  }
  hubTwo.closePersistence();
});

test('an archiving room suppresses the outbox item to a terminal state without retry loops', async () => {
  const brokerClient = createFakeBrokerClient();
  const hub = createHub({ silent: true, brokerClient });
  const project = await createRoomLinkedProject(hub);

  // the room slides into archiving before the next event is published
  brokerClient.getRoomSnapshot = async () => ({
    ok: true,
    room: { roomId: 'room-1', status: 'archiving', revision: 2 },
    members: [],
  });

  hub.submitTaskResult({ projectId: project.id, taskId: 'task-9', agentId: 'agent-po', summary: 'late' });
  await hub.flushRoomEventOutbox();
  const publishCallsAfterSuppress = brokerClient.calls.publishRoomProjectEvent.length;

  // repeated flushes must not retry a suppressed item
  await hub.flushRoomEventOutbox();
  await hub.flushRoomEventOutbox();
  assert.equal(brokerClient.calls.publishRoomProjectEvent.length, publishCallsAfterSuppress);

  const outbox = hub.getRoomEventOutbox({ projectId: project.id });
  const suppressed = outbox.items.filter((item) => item.status === 'suppressed_room_archived');
  assert.ok(suppressed.length >= 1, 'expected at least one suppressed terminal item');

  // the project fact itself is untouched
  assert.ok(hub.getProject(project.id));
});

test('a publish failure keeps the outbox item pending for the next flush', async () => {
  const brokerClient = createFakeBrokerClient();
  let failFirst = true;
  brokerClient.publishRoomProjectEvent = async (event) => {
    if (failFirst && event.eventType !== 'project.created') {
      failFirst = false;
      return { ok: false, code: 'broker_unavailable' };
    }
    return { ok: true };
  };

  const hub = createHub({ silent: true, brokerClient });
  const project = await createRoomLinkedProject(hub);
  hub.submitTaskResult({ projectId: project.id, taskId: 'task-1', agentId: 'agent-po', summary: 'done 1' });

  await hub.flushRoomEventOutbox();
  const outboxAfterFailure = hub.getRoomEventOutbox({ projectId: project.id });
  assert.ok(outboxAfterFailure.items.some((item) => item.status === 'pending'));

  await hub.flushRoomEventOutbox();
  const outboxAfterRetry = hub.getRoomEventOutbox({ projectId: project.id });
  assert.ok(outboxAfterRetry.items.every((item) => item.status !== 'pending'));
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
  console.log(`\n${passed}/${tests.length} room event outbox tests passed`);
}
