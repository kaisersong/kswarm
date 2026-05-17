/**
 * KSwarm — runtime probe tests
 *
 * Run: node test/runtime-probe.test.js
 */

import assert from 'node:assert/strict';
import { probeAgentRuntime } from '../src/core/runtime-probe.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const now = 1779050000000;

test('builtin runtime probes healthy without spawning a command', async () => {
  const result = await probeAgentRuntime({
    id: 'xiaok',
    runtimeType: 'builtin',
    capabilities: ['analysis'],
  }, {
    now,
    runCommand: async () => { throw new Error('should not run'); },
  });

  assert.equal(result.healthy, true);
  assert.equal(result.runtimeHealth.state, 'healthy');
  assert.deepEqual(result.runtimeHealth.taskCapabilities, ['analysis']);
});

test('command-only CLI probe returns limited runtime health and preserves backward healthy flag', async () => {
  const result = await probeAgentRuntime({
    id: 'cli',
    runtimeType: 'claude',
    runtimePath: '/bin/echo',
    capabilities: ['analysis'],
  }, {
    now,
    runCommand: async () => 'claude 1.0.0',
    enableGenerationProbe: false,
  });

  assert.equal(result.healthy, true);
  assert.equal(result.probe, 'ok');
  assert.equal(result.runtimeHealth.state, 'limited');
  assert.equal(result.runtimeHealth.probe.generationSkipped, true);
});

test('command probe failure degrades runtime health', async () => {
  const result = await probeAgentRuntime({
    id: 'cli',
    runtimeType: 'claude',
    runtimePath: '/missing/claude',
    capabilities: ['analysis'],
  }, {
    now,
    runCommand: async () => { throw new Error('not found'); },
  });

  assert.equal(result.healthy, false);
  assert.equal(result.probe, 'fail');
  assert.equal(result.runtimeHealth.state, 'degraded');
  assert.match(result.message, /not found/);
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
  console.log(`\n${passed}/${tests.length} runtime probe tests passed`);
}
