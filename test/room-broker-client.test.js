import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrokerClient } from '../src/net/broker-client.js';

test('KSwarm broker client authenticates Room snapshot, lease and project event calls', async () => {
  const calls = [];
  const client = createBrokerClient({
    brokerUrl: 'http://127.0.0.1:4318',
    participantId: 'kswarm-hub',
    roomSystemToken: 'system-token',
    fetchImpl: async (url, init = {}) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
    silent: true,
  });

  await client.getRoomSnapshot('room/one');
  await client.acquireRoomMembershipLease({ roomId: 'room/one', logicalAgentId: 'agent-alpha', operationId: 'op-1' });
  await client.publishRoomProjectEvent({ roomId: 'room/one', projectId: 'project-1', idempotencyKey: 'event-1' });

  assert.equal(calls.length, 3);
  assert.match(calls[0].url, /\/rooms\/room%2Fone$/);
  assert.match(calls[1].url, /\/membership-leases$/);
  assert.match(calls[2].url, /\/project-events$/);
  for (const call of calls) {
    assert.equal(call.init.headers['x-intent-broker-room-token'], 'system-token');
  }
});
