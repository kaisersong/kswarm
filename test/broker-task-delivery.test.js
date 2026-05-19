/**
 * KSwarm — broker task delivery tests
 *
 * Run: node test/broker-task-delivery.test.js
 */

import assert from 'node:assert/strict';
import {
  isBrokerDeliverySuccessful,
  sendTaskToBrokerParticipant,
  waitForParticipantOnline,
} from '../src/server/broker-task-delivery.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('delivery result is successful only when target is delivered online', () => {
  assert.equal(isBrokerDeliverySuccessful({
    deliveredCount: 1,
    onlineRecipients: ['xiaok-worker@inst-1'],
    offlineRecipients: [],
  }, 'xiaok-worker@inst-1'), true);

  assert.equal(isBrokerDeliverySuccessful({
    deliveredCount: 0,
    onlineRecipients: [],
    offlineRecipients: ['xiaok-worker@inst-1'],
  }, 'xiaok-worker@inst-1'), false);
});

test('waitForParticipantOnline polls until target appears', async () => {
  let checks = 0;
  const result = await waitForParticipantOnline({
    targetId: 'xiaok-worker@inst-2',
    timeoutMs: 100,
    intervalMs: 1,
    isOnline: async () => {
      checks += 1;
      return checks >= 3;
    },
    sleep: async () => {},
  });

  assert.equal(result.ok, true);
  assert.equal(checks, 3);
});

test('sendTaskToBrokerParticipant does not send when target never comes online', async () => {
  let sendCalls = 0;
  const result = await sendTaskToBrokerParticipant({
    brokerClient: {
      sendTo: async () => {
        sendCalls += 1;
        return { deliveredCount: 1, onlineRecipients: ['xiaok-worker@inst-3'], offlineRecipients: [] };
      },
    },
    targetId: 'xiaok-worker@inst-3',
    kind: 'request_task',
    request: { taskId: 'task-1', threadId: 'thread-task-1', payload: {} },
    waitTimeoutMs: 5,
    waitIntervalMs: 1,
    isOnline: async () => false,
    sleep: async () => {},
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'participant_offline');
  assert.equal(sendCalls, 0);
});

test('sendTaskToBrokerParticipant fails visibly when broker reports offline recipient', async () => {
  const result = await sendTaskToBrokerParticipant({
    brokerClient: {
      sendTo: async () => ({ deliveredCount: 0, onlineRecipients: [], offlineRecipients: ['xiaok-worker@inst-4'] }),
    },
    targetId: 'xiaok-worker@inst-4',
    kind: 'request_task',
    request: { taskId: 'task-1', threadId: 'thread-task-1', payload: {} },
    waitTimeoutMs: 5,
    waitIntervalMs: 1,
    isOnline: async () => true,
    sleep: async () => {},
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'delivery_failed');
  assert.equal(result.delivery.deliveredCount, 0);
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
  console.log(`\n${passed}/${tests.length} broker task delivery tests passed`);
}
