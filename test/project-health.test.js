/**
 * KSwarm — project health tests
 *
 * Run: node test/project-health.test.js
 */

import assert from 'node:assert/strict';
import { deriveProjectHealth } from '../src/core/project-health.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('blocked tasks make the project health blocked with actionable reasons', () => {
  const health = deriveProjectHealth({
    project: { id: 'proj-a', status: 'active' },
    tasks: [
      { id: 'task-1', status: 'blocked', blockedReason: '没有独立评审 agent', nextActions: ['添加 reviewer'] },
    ],
  });

  assert.equal(health.state, 'blocked');
  assert.equal(health.counts.blocked, 1);
  assert.equal(health.reasons[0].taskId, 'task-1');
  assert.ok(health.reasons[0].message.includes('没有独立评审'));
});

test('preparation blocker is surfaced before task state', () => {
  const health = deriveProjectHealth({
    project: {
      id: 'proj-prep',
      status: 'created',
      preparation: {
        state: 'blocked',
        blockers: [{ agentId: 'xiaok-po', reason: 'broker_participant_missing', selectedBy: 'default_seed' }],
      },
    },
    tasks: [],
  });

  assert.equal(health.state, 'preparation_blocked');
  assert.equal(health.gate, 'project_preparation');
  assert.equal(health.reasons[0].agentId, 'xiaok-po');
  assert.equal(health.reasons[0].message, 'broker_participant_missing');
});

test('output contract repair requirement has a dedicated health state', () => {
  const health = deriveProjectHealth({
    project: { id: 'proj-output', status: 'active' },
    tasks: [
      { id: 'item-1', status: 'failed', lastFailureClass: 'artifact_type_mismatch', rejectedSubmissions: [{ missing: ['markdown'] }] },
    ],
  });

  assert.equal(health.state, 'repair_output_contract');
  assert.equal(health.gate, 'output_contract');
  assert.deepEqual(health.reasons[0].missing, ['markdown']);
});

test('submitted tasks are surfaced as needs_review before idle', () => {
  const health = deriveProjectHealth({
    project: { id: 'proj-a', status: 'active' },
    tasks: [
      { id: 'task-1', status: 'submitted' },
      { id: 'task-2', status: 'pending', assignedAgent: 'worker' },
    ],
    dispatchPlan: { dispatchedTasks: [], skipped: [], blocked: [] },
  });

  assert.equal(health.state, 'needs_review');
});

test('historical failed retry child does not prevent complete health when parent is done', () => {
  const health = deriveProjectHealth({
    project: { id: 'proj-history', status: 'active' },
    tasks: [
      { id: 'item-1', title: '撰写报告草稿', status: 'done' },
      {
        id: 'item-1-retry-1',
        title: '撰写报告草稿',
        status: 'failed',
        parentTaskId: 'item-1',
        failureReason: 'model_empty_output',
      },
      { id: 'item-2', title: '修订并定稿', status: 'done' },
    ],
  });

  assert.equal(health.state, 'complete');
  assert.equal(health.gate, null);
});

test('dispatch plan gates explain idle projects with only busy agents', () => {
  const health = deriveProjectHealth({
    project: { id: 'proj-a', status: 'active' },
    tasks: [
      { id: 'task-1', status: 'pending', assignedAgent: 'worker' },
    ],
    dispatchPlan: {
      dispatchedTasks: [],
      skipped: [{ taskId: 'task-1', reason: 'agent_busy', agent: 'worker' }],
      blocked: [],
      projectGate: 'waiting_for_busy_agents',
    },
  });

  assert.equal(health.state, 'waiting');
  assert.equal(health.gate, 'waiting_for_busy_agents');
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
  console.log(`\n${passed}/${tests.length} project health tests passed`);
}
