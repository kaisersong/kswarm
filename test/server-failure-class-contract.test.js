/**
 * KSwarm — server failure class contract tests
 *
 * Run: node test/server-failure-class-contract.test.js
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(process.cwd(), 'src/server/index.js'), 'utf-8');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('server runtime failure list excludes task and output contract failures', () => {
  const block = source.slice(
    source.indexOf('const AGENT_RUNTIME_FAILURE_CLASSES'),
    source.indexOf('function recordAgentRuntimeFailure')
  );

  assert.match(block, /runtime_offline/);
  assert.match(block, /model_empty_output/);
  assert.doesNotMatch(block, /source_provider_unavailable/);
  assert.doesNotMatch(block, /artifact_type_mismatch/);
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
  console.log(`\n${passed}/${tests.length} server failure class contract tests passed`);
}
