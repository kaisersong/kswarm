/**
 * KSwarm — runtime instance pool tests
 *
 * Run: node test/runtime-instance-pool.test.js
 */

import assert from 'node:assert/strict';
import {
  DEFAULT_MAX_PO_PROJECT_INSTANCES,
  DEFAULT_MAX_WORKER_INSTANCES,
  XIAOK_PO_AGENT_ID,
  XIAOK_WORKER_AGENT_ID,
  createRuntimeInstancePool,
} from '../src/core/runtime-instance-pool.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('default runtime instance limits are conservative and PO defaults to five project instances', () => {
  assert.equal(DEFAULT_MAX_WORKER_INSTANCES, 3);
  assert.equal(DEFAULT_MAX_PO_PROJECT_INSTANCES, 5);
});

test('worker pool creates instances up to capacity and reports capacity full', () => {
  const pool = createRuntimeInstancePool({
    maxWorkerInstances: 2,
    maxPoProjectInstances: 5,
    now: () => 1000,
  });

  const first = pool.ensureWorkerInstance(XIAOK_WORKER_AGENT_ID);
  const second = pool.ensureWorkerInstance(XIAOK_WORKER_AGENT_ID);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.notEqual(first.instanceId, second.instanceId);

  pool.markInstanceWorking(first.instanceId, { taskId: 'task-a' });
  pool.markInstanceWorking(second.instanceId, { taskId: 'task-b' });

  const third = pool.ensureWorkerInstance(XIAOK_WORKER_AGENT_ID);
  assert.equal(third.ok, false);
  assert.equal(third.error, 'capacity_full');
  assert.equal(third.limit, 2);
});

test('worker pool reuses idle instances before creating new ones', () => {
  const pool = createRuntimeInstancePool({ maxWorkerInstances: 2, now: () => 1000 });
  const first = pool.ensureWorkerInstance(XIAOK_WORKER_AGENT_ID);
  pool.markInstanceWorking(first.instanceId, { taskId: 'task-a' });
  pool.markInstanceIdle(first.instanceId);

  const reused = pool.ensureWorkerInstance(XIAOK_WORKER_AGENT_ID);
  assert.equal(reused.ok, true);
  assert.equal(reused.instanceId, first.instanceId);
  assert.equal(reused.created, false);
});

test('same project PO ensure is idempotent and cross-project PO uses separate instances', () => {
  const pool = createRuntimeInstancePool({ maxPoProjectInstances: 5, now: () => 1000 });

  const first = pool.ensureProjectPoInstance(XIAOK_PO_AGENT_ID, 'proj-a');
  const same = pool.ensureProjectPoInstance(XIAOK_PO_AGENT_ID, 'proj-a');
  const other = pool.ensureProjectPoInstance(XIAOK_PO_AGENT_ID, 'proj-b');

  assert.equal(first.ok, true);
  assert.equal(same.ok, true);
  assert.equal(other.ok, true);
  assert.equal(first.instanceId, same.instanceId);
  assert.notEqual(first.instanceId, other.instanceId);
});

test('PO project instance pool enforces its capacity limit', () => {
  const pool = createRuntimeInstancePool({ maxPoProjectInstances: 2, now: () => 1000 });

  assert.equal(pool.ensureProjectPoInstance(XIAOK_PO_AGENT_ID, 'proj-a').ok, true);
  assert.equal(pool.ensureProjectPoInstance(XIAOK_PO_AGENT_ID, 'proj-b').ok, true);
  const blocked = pool.ensureProjectPoInstance(XIAOK_PO_AGENT_ID, 'proj-c');

  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, 'capacity_full');
  assert.equal(blocked.limit, 2);
});

test('non-default agents are not eligible for automatic runtime instances', () => {
  const pool = createRuntimeInstancePool();

  assert.equal(pool.ensureWorkerInstance('custom-worker').error, 'not_pooled_agent');
  assert.equal(pool.ensureProjectPoInstance('custom-po', 'proj-a').error, 'not_pooled_agent');
});

test('pool exposes concurrency and summary for status surfaces', () => {
  const pool = createRuntimeInstancePool({ maxWorkerInstances: 3, now: () => 1000 });
  const first = pool.ensureWorkerInstance(XIAOK_WORKER_AGENT_ID);
  const second = pool.ensureWorkerInstance(XIAOK_WORKER_AGENT_ID);
  pool.markInstanceWorking(first.instanceId, { taskId: 'task-a' });
  pool.markInstanceFailed(second.instanceId, 'spawn_failed');

  assert.deepEqual(pool.getAgentConcurrency(), { [XIAOK_WORKER_AGENT_ID]: 3 });
  const summary = pool.summarizeByAgent();
  assert.equal(summary[XIAOK_WORKER_AGENT_ID].total, 2);
  assert.equal(summary[XIAOK_WORKER_AGENT_ID].working, 1);
  assert.equal(summary[XIAOK_WORKER_AGENT_ID].failed, 1);
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
  console.log(`\n${passed}/${tests.length} runtime instance pool tests passed`);
}
