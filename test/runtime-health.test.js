/**
 * KSwarm — runtime health pure module tests
 *
 * Run: node test/runtime-health.test.js
 */

import assert from 'node:assert/strict';
import {
  createUnknownRuntimeHealth,
  recordProbeResult,
  recordRuntimeFailure,
  recordRuntimeSuccess,
  isRoutable,
} from '../src/core/runtime-health.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const now = 1779050000000;

test('unknown runtime is not automatically routable', () => {
  const health = createUnknownRuntimeHealth();

  assert.equal(health.state, 'unknown');
  const route = isRoutable({ runtimeHealth: health }, ['analysis'], [{ type: 'markdown' }], now);
  assert.equal(route.ok, false);
  assert.equal(route.reason, 'runtime_unknown');
});

test('successful command and generation probe makes matching runtime healthy', () => {
  const health = recordProbeResult(createUnknownRuntimeHealth(), {
    commandOk: true,
    generationOk: true,
    outputCapabilities: ['markdown'],
    taskCapabilities: ['analysis'],
    durationMs: 1000,
  }, now);

  assert.equal(health.state, 'healthy');
  assert.equal(isRoutable({ runtimeHealth: health }, ['analysis'], [{ type: 'markdown' }], now).ok, true);
});

test('command-only probe is limited and not automatically routable', () => {
  const health = recordProbeResult(createUnknownRuntimeHealth(), {
    commandOk: true,
    generationSkipped: true,
    outputCapabilities: ['markdown'],
    taskCapabilities: ['analysis'],
    durationMs: 120,
  }, now);

  assert.equal(health.state, 'limited');
  const route = isRoutable({ runtimeHealth: health }, ['analysis'], [{ type: 'markdown' }], now);
  assert.equal(route.ok, false);
  assert.equal(route.reason, 'runtime_limited');
});

test('generation probe failure degrades runtime and repeated failures enter cooldown', () => {
  let health = recordProbeResult(createUnknownRuntimeHealth(), {
    commandOk: true,
    generationOk: false,
    error: 'auth required',
  }, now);

  assert.equal(health.state, 'degraded');
  assert.equal(isRoutable({ runtimeHealth: health }, ['analysis'], [{ type: 'markdown' }], now).reason, 'runtime_degraded');

  health = recordRuntimeFailure(health, { failureClass: 'runtime_generation_unavailable', error: 'no model' }, now + 1000);
  health = recordRuntimeFailure(health, { failureClass: 'runtime_generation_unavailable', error: 'no model' }, now + 2000);

  assert.equal(health.state, 'cooldown');
  assert.ok(health.cooldownUntil > now + 2000);
  assert.equal(isRoutable({ runtimeHealth: health }, ['analysis'], [{ type: 'markdown' }], now + 3000).reason, 'runtime_cooldown');
});

test('successful task records capabilities and routability checks task and output capabilities', () => {
  const health = recordRuntimeSuccess(createUnknownRuntimeHealth(), {
    taskId: 'proj__item-1',
    runId: 'run-1',
    outputCapabilities: ['markdown', 'html'],
    taskCapabilities: ['analysis', 'design_template'],
  }, now);

  assert.equal(health.consecutiveRuntimeFailures, 0);
  assert.equal(health.state, 'healthy');
  assert.equal(isRoutable({ runtimeHealth: health }, ['design_template'], [{ type: 'html' }], now).ok, true);
  assert.equal(
    isRoutable({ runtimeHealth: health }, ['presentation_generation'], [{ type: 'pptx' }], now).reason,
    'capability_missing:presentation_generation',
  );
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
  console.log(`\n${passed}/${tests.length} runtime health tests passed`);
}
