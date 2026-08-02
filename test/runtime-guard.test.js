/**
 * KSwarm — Node runtime floor gate tests (P0, Task 4)
 * Run: node test/runtime-guard.test.js
 */
import assert from 'node:assert/strict';
import { isNodeVersionAtLeast, assertNodeRuntime, NODE_VERSION_FLOOR } from '../src/core/runtime-guard.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('floor is 22.22.0', () => {
  assert.equal(NODE_VERSION_FLOOR, '22.22.0');
});

test('isNodeVersionAtLeast compares semver correctly', () => {
  assert.equal(isNodeVersionAtLeast('22.22.0', '22.22.0'), true);
  assert.equal(isNodeVersionAtLeast('22.22.1', '22.22.0'), true);
  assert.equal(isNodeVersionAtLeast('24.15.0', '22.22.0'), true);
  assert.equal(isNodeVersionAtLeast('22.21.9', '22.22.0'), false);
  assert.equal(isNodeVersionAtLeast('22.22.0', '22.22.1'), false);
  assert.equal(isNodeVersionAtLeast('18.20.0', '22.22.0'), false);
  assert.equal(isNodeVersionAtLeast('v22.22.5', '22.22.0'), true); // tolerate leading v
});

test('assertNodeRuntime throws below floor, passes at/above', () => {
  assert.throws(() => assertNodeRuntime('20.10.0'), /22\.22\.0/);
  assert.doesNotThrow(() => assertNodeRuntime('22.22.0'));
  assert.doesNotThrow(() => assertNodeRuntime('24.15.0'));
});

let passed = 0, failed = 0;
for (const { name, fn } of tests) {
  try { fn(); passed++; console.log(`  \u2713 ${name}`); }
  catch (err) { failed++; console.error(`  \u2717 ${name}\n    ${err.message}`); }
}
console.log(`\n[runtime-guard] ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
