/**
 * KSwarm — project scoped agent status derivation tests
 *
 * Run: node test/agent-status.test.js
 */

import assert from 'node:assert/strict';
import { deriveAgentStatuses } from '../web/src/utils/agent-status.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function byId(statuses, id) {
  const status = statuses.find(s => s.id === id);
  assert.ok(status, `missing status for ${id}`);
  return status;
}

const baseProject = {
  id: 'proj-a',
  name: 'A',
  status: 'active',
  poAgent: 'po',
  members: ['worker', 'blocked', 'idle'],
};

const baseAgents = [
  { id: 'po', name: 'PO' },
  { id: 'worker', name: 'Worker' },
  { id: 'blocked', name: 'Blocked' },
  { id: 'idle', name: 'Idle' },
];

const onlineParticipants = [
  { kind: 'agent', participantId: 'po' },
  { kind: 'agent', participantId: 'worker' },
  { kind: 'agent', participantId: 'blocked' },
  { kind: 'agent', participantId: 'idle' },
];

test('worker with an active task is marked working', () => {
  const statuses = deriveAgentStatuses({
    project: baseProject,
    agents: baseAgents,
    participants: onlineParticipants,
    tasks: [
      { id: 'proj-a__item-1', localTaskId: 'item-1', title: 'Build', status: 'in_progress', assignedAgent: 'worker' },
    ],
  });

  assert.equal(byId(statuses, 'worker').status, 'working');
  assert.equal(byId(statuses, 'worker').taskId, 'proj-a__item-1');
});

test('pending assigned task with unfinished dependencies is blocked', () => {
  const statuses = deriveAgentStatuses({
    project: baseProject,
    agents: baseAgents,
    participants: onlineParticipants,
    tasks: [
      { id: 'proj-a__item-1', localTaskId: 'item-1', title: 'First', status: 'in_progress', assignedAgent: 'worker' },
      { id: 'proj-a__item-2', localTaskId: 'item-2', title: 'Second', status: 'pending', assignedAgent: 'blocked', dependencies: ['proj-a__item-1'] },
    ],
  });

  assert.equal(byId(statuses, 'blocked').status, 'blocked');
  assert.match(byId(statuses, 'blocked').detail, /依赖/);
});

test('explicit blocked task shows the blocked reason on the agent card', () => {
  const statuses = deriveAgentStatuses({
    project: baseProject,
    agents: baseAgents,
    participants: onlineParticipants,
    tasks: [
      { id: 'proj-a__item-1', localTaskId: 'item-1', title: 'Review', status: 'blocked', assignedAgent: 'blocked', blockedReason: '缺少独立评审证据' },
    ],
  });

  assert.equal(byId(statuses, 'blocked').status, 'blocked');
  assert.match(byId(statuses, 'blocked').detail, /独立评审证据/);
});

test('submitted worker waits for review and PO is reviewing', () => {
  const statuses = deriveAgentStatuses({
    project: baseProject,
    agents: baseAgents,
    participants: onlineParticipants,
    tasks: [
      { id: 'proj-a__item-1', localTaskId: 'item-1', title: 'Draft', status: 'submitted', assignedAgent: 'worker' },
    ],
  });

  assert.equal(byId(statuses, 'worker').status, 'waiting_review');
  assert.equal(byId(statuses, 'po').status, 'reviewing');
});

test('task intent errors override normal worker state', () => {
  const statuses = deriveAgentStatuses({
    project: baseProject,
    agents: baseAgents,
    participants: onlineParticipants,
    tasks: [
      { id: 'proj-a__item-1', localTaskId: 'item-1', title: 'Build', status: 'in_progress', assignedAgent: 'worker' },
    ],
    logs: [
      { level: 'warn', msg: 'Task intent error: submit_result', data: { projectId: 'proj-a', worker: 'worker', error: 'stale_task_run', taskId: 'proj-a__item-1' } },
    ],
  });

  assert.equal(byId(statuses, 'worker').status, 'error');
  assert.match(byId(statuses, 'worker').detail, /stale_task_run/);
});

test('done, failed, cancelled, waiting, and offline states are distinguishable', () => {
  const statuses = deriveAgentStatuses({
    project: { ...baseProject, members: ['done', 'failed', 'cancelled', 'idle', 'offline'] },
    agents: [
      { id: 'po', name: 'PO' },
      { id: 'done', name: 'Done' },
      { id: 'failed', name: 'Failed' },
      { id: 'cancelled', name: 'Cancelled' },
      { id: 'idle', name: 'Idle' },
      { id: 'offline', name: 'Offline', status: 'offline' },
    ],
    participants: [
      { kind: 'agent', participantId: 'po' },
      { kind: 'agent', participantId: 'done' },
      { kind: 'agent', participantId: 'failed' },
      { kind: 'agent', participantId: 'cancelled' },
      { kind: 'agent', participantId: 'idle' },
    ],
    tasks: [
      { id: 'proj-a__item-1', title: 'Done task', status: 'done', assignedAgent: 'done' },
      { id: 'proj-a__item-2', title: 'Failed task', status: 'failed', assignedAgent: 'failed' },
      { id: 'proj-a__item-3', title: 'Cancelled task', status: 'cancelled', assignedAgent: 'cancelled' },
      { id: 'proj-a__item-4', title: 'Ready task', status: 'pending', assignedAgent: 'idle', dependencies: [] },
    ],
  });

  assert.equal(byId(statuses, 'done').status, 'done');
  assert.equal(byId(statuses, 'failed').status, 'failed');
  assert.equal(byId(statuses, 'cancelled').status, 'cancelled');
  assert.equal(byId(statuses, 'idle').status, 'waiting');
  assert.equal(byId(statuses, 'offline').status, 'offline');
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
  console.log(`\n${passed}/${tests.length} agent status tests passed`);
}
