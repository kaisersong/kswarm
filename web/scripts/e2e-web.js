#!/usr/bin/env node
/**
 * KSwarm Web UI E2E validation
 * Tests the full flow: proxy → broker → WebSocket → event data
 */

const PROXY = 'http://localhost:5188/api';

async function post(path, body) {
  const resp = await fetch(`${PROXY}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return resp.json();
}

async function get(path) {
  const resp = await fetch(`${PROXY}${path}`);
  return resp.json();
}

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    console.log(`  ✓ ${msg}`);
    passed++;
  } else {
    console.log(`  ✗ ${msg}`);
    failed++;
  }
}

async function run() {
  console.log('KSwarm Web E2E Validation\n');

  // 1. Proxy health check
  console.log('1. Proxy → Broker health');
  const health = await get('/health');
  assert(health.ok === true, 'Broker healthy via proxy');

  // 2. Participants
  console.log('2. Participants list');
  const parts = await get('/participants');
  assert(Array.isArray(parts.participants), 'Participants returned');
  assert(parts.participants.length > 0, `${parts.participants.length} participants registered`);

  // 3. Register web participant
  console.log('3. Register web participant');
  const reg = await post('/participants/register', {
    participantId: 'e2e-web-test',
    kind: 'human',
    alias: 'e2e-tester',
    roles: ['viewer', 'approver'],
    capabilities: [],
    context: { projectName: 'kswarm-e2e' },
  });
  assert(reg.participantId === 'e2e-web-test', 'Registered successfully');

  // 4. Create task
  console.log('4. Create task via web proxy');
  const taskId = `task-webtest-${Date.now()}`;
  const create = await post('/intents', {
    intentId: `int-webtest-${Date.now()}`,
    kind: 'request_task',
    fromParticipantId: 'e2e-web-test',
    taskId,
    threadId: `thread-${taskId}`,
    payload: { title: 'E2E Web Test Task', body: { summary: 'E2E Web Test Task' } },
  });
  assert(create.eventId > 0, `Task created (eventId=${create.eventId})`);
  assert(create.recipients?.length > 0, `Delivered to ${create.deliveredCount} recipients`);

  // 5. Accept task
  console.log('5. Accept task');
  const accept = await post('/intents', {
    intentId: `int-accept-${Date.now()}`,
    kind: 'accept_task',
    fromParticipantId: 'e2e-web-test',
    taskId,
    threadId: `thread-${taskId}`,
    payload: { participantId: 'e2e-web-test' },
  });
  assert(accept.eventId > 0, 'Task accepted');

  // 6. Report progress
  console.log('6. Report progress');
  const progress = await post('/intents', {
    intentId: `int-prog-${Date.now()}`,
    kind: 'report_progress',
    fromParticipantId: 'e2e-web-test',
    taskId,
    threadId: `thread-${taskId}`,
    payload: { stage: 'in_progress', body: { message: 'Working on it' } },
  });
  assert(progress.eventId > 0, 'Progress reported');

  // 7. Request approval
  console.log('7. Request approval');
  const approval = await post('/intents', {
    intentId: `int-approve-${Date.now()}`,
    kind: 'request_approval',
    fromParticipantId: 'e2e-web-test',
    taskId,
    threadId: `thread-${taskId}`,
    payload: { body: { summary: 'Ready for review' } },
  });
  assert(approval.eventId > 0, 'Approval requested');

  // 8. Respond approval
  console.log('8. Respond approval (approve)');
  const respond = await post('/intents', {
    intentId: `int-respond-${Date.now()}`,
    kind: 'respond_approval',
    fromParticipantId: 'e2e-web-test',
    taskId,
    threadId: `thread-${taskId}`,
    payload: { decision: 'approved', respondedBy: 'human' },
  });
  assert(respond.eventId > 0, 'Approval responded');

  // 9. Submit result
  console.log('9. Submit result');
  const result = await post('/intents', {
    intentId: `int-result-${Date.now()}`,
    kind: 'submit_result',
    fromParticipantId: 'e2e-web-test',
    taskId,
    threadId: `thread-${taskId}`,
    payload: { summary: 'Task completed successfully', artifacts: ['login.html'] },
  });
  assert(result.eventId > 0, 'Result submitted');

  // 10. Replay includes our events
  console.log('10. Verify replay');
  const replay = await get('/events/replay?limit=10000');
  const ourEvents = replay.items.filter(e => e.taskId === taskId);
  assert(ourEvents.length === 6, `Found ${ourEvents.length}/6 events for our task`);

  // Summary
  console.log(`\n${'='.repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
