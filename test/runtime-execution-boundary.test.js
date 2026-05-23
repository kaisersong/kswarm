import assert from 'node:assert/strict';
import {
  classifyExecutionBoundary,
  canSpawnAutoWorkerForTask,
} from '../src/core/runtime-execution-boundary.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('desktop xiaok seed is external agent runtime and cannot use auto-worker for user tasks', () => {
  const agent = {
    id: 'xiaok-worker',
    runtimeType: 'xiaok',
    runtimeSource: 'desktop-agent-runtime',
  };
  assert.deepEqual(classifyExecutionBoundary(agent), {
    kind: 'desktop_agent_runtime',
    localAutoWorkerAllowed: false,
  });
  assert.equal(canSpawnAutoWorkerForTask({ agent, taskKind: 'user_task' }).ok, false);
  assert.equal(canSpawnAutoWorkerForTask({ agent, taskKind: 'user_task' }).error, 'desktop_runtime_required');
});

test('desktop xiaok seed can run internal maintenance jobs only when explicitly allowed', () => {
  const agent = {
    id: 'xiaok-worker',
    runtimeType: 'xiaok',
    runtimeSource: 'desktop-agent-runtime',
  };
  const allowed = canSpawnAutoWorkerForTask({
    agent,
    taskKind: 'maintenance_job',
    allowMaintenanceWorker: true,
  });
  assert.equal(allowed.ok, true);
});

test('explicit third-party cli agent remains locally spawnable', () => {
  const agent = {
    id: 'worker-qoder',
    runtimeType: 'qoder',
    runtimePath: '/opt/homebrew/bin/qodercli',
  };
  assert.equal(canSpawnAutoWorkerForTask({ agent, taskKind: 'user_task' }).ok, true);
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
if (process.exitCode !== 1) console.log(`\n${passed}/${tests.length} runtime boundary tests passed`);
