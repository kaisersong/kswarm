/**
 * KSwarm — auto-worker spawn process tests
 *
 * Run: node test/auto-worker-spawn-process.test.js
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  createAutoWorkerSpawnConfig,
  spawnAutoWorkerProcess,
} from '../src/server/auto-worker-process.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('auto-worker spawn uses current Node executable when PATH has no node', () => {
  const config = createAutoWorkerSpawnConfig({
    scriptPath: '/app/services/kswarm/scripts/auto-worker.js',
    agentId: 'xiaok-worker',
    alias: 'Worker-Agent',
    cwd: '/app/services/kswarm',
    env: { PATH: '' },
    execPath: '/absolute/node',
  });

  assert.equal(config.command, '/absolute/node');
  assert.deepEqual(config.args.slice(0, 3), [
    '/app/services/kswarm/scripts/auto-worker.js',
    'xiaok-worker',
    'Worker-Agent',
  ]);
  assert.equal(config.options.cwd, '/app/services/kswarm');
  assert.equal(config.options.detached, true);
  assert.equal(config.options.stdio, 'ignore');
});

test('KSWARM_NODE_PATH overrides process.execPath for embedded launchers', () => {
  const config = createAutoWorkerSpawnConfig({
    scriptPath: '/app/auto-worker.js',
    agentId: 'xiaok-po',
    alias: 'PO-Agent',
    cwd: '/app',
    env: { KSWARM_NODE_PATH: '/custom/node' },
    execPath: '/electron/or/node',
  });

  assert.equal(config.command, '/custom/node');
});

test('spawn failure returns a visible error and does not unref a pidless child', async () => {
  let unrefCalled = false;
  let observedError = null;
  const child = new EventEmitter();
  child.pid = undefined;
  child.unref = () => { unrefCalled = true; };

  const result = spawnAutoWorkerProcess({
    command: '/missing/node',
    args: ['/app/auto-worker.js', 'worker', 'Worker'],
    options: { cwd: '/app', env: {}, stdio: 'ignore', detached: true },
  }, {
    spawnFn: () => child,
    onError: err => { observedError = err; },
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /no_pid/);
  assert.equal(unrefCalled, false);

  child.emit('error', new Error('spawn /missing/node ENOENT'));
  assert.equal(observedError?.message, 'spawn /missing/node ENOENT');
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
  console.log(`\n${passed}/${tests.length} auto-worker spawn process tests passed`);
}
