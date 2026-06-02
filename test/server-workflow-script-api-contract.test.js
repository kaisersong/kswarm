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
  assert.match(source, /beginWorkflowScriptParallelGroup/);
  assert.match(source, /dispatchWorkflowScriptAgentNode/);
  assert.match(source, /completeScriptWorkflowRun/);
  assert.ok(source.includes('script-generated\\/proposal'));
  assert.ok(source.includes('script\\/parallel-groups'));
  assert.ok(source.includes('script\\/nodes'));
  assert.ok(source.includes('script\\/complete'));
  assert.ok(source.includes('terminal: body?.terminal'));
});

test('server wires script node-result write-back endpoint with attempt/handoff/fromAgent/output and workflow_run_updated broadcast', () => {
  assert.ok(source.includes('script\\/nodes\\/([^/]+)\\/result'));
  assert.match(source, /handleWorkflowNodeResult/);
  const routeStart = source.indexOf('scriptWorkflowNodeResultMatch');
  assert.ok(routeStart > -1);
  const routeBlock = source.slice(routeStart, routeStart + 1400);
  assert.match(routeBlock, /attempt: body\?\.attempt/);
  assert.match(routeBlock, /handoffId: body\?\.handoffId/);
  assert.match(routeBlock, /fromAgent: body\?\.fromAgent/);
  assert.match(routeBlock, /output: body\?\.output/);
  assert.match(routeBlock, /type: 'workflow_run_updated'/);
  assert.match(routeBlock, /sendWorkflowNodeHandoffs/);
});

test('server wires script node retry endpoint with workflow update broadcast and handoff dispatch', () => {
  assert.ok(source.includes('script\\/nodes\\/([^/]+)\\/retry'));
  assert.match(source, /retryWorkflowScriptAgentNode/);
  const routeStart = source.indexOf('scriptWorkflowNodeRetryMatch');
  assert.ok(routeStart > -1);
  const routeBlock = source.slice(routeStart, routeStart + 1400);
  assert.match(routeBlock, /assignedAgent: body\?\.assignedAgent/);
  assert.match(routeBlock, /type: 'workflow_run_updated'/);
  assert.match(routeBlock, /sendWorkflowNodeHandoffs/);
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
