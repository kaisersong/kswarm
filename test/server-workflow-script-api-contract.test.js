/**
 * KSwarm — server dynamic workflow script API wiring tests.
 *
 * Run: node test/server-workflow-script-api-contract.test.js
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(process.cwd(), 'src/server/index.js'), 'utf-8');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('server wires script-generated workflow proposal, run, node, and completion endpoints', () => {
  assert.match(source, /createScriptWorkflowProposal/);
  assert.match(source, /startScriptWorkflowRunFromProposal/);
  assert.match(source, /dispatchWorkflowScriptAgentNode/);
  assert.match(source, /completeScriptWorkflowRun/);
  assert.ok(source.includes('script-generated\\/proposal'));
  assert.ok(source.includes('script\\/nodes'));
  assert.ok(source.includes('script\\/complete'));
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
  console.log(`\n${passed}/${tests.length} server workflow script API contract tests passed`);
}
