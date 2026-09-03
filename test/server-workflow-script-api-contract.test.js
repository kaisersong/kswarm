/**
 * KSwarm — server dynamic workflow script API wiring tests.
 *
 * Run: node test/server-workflow-script-api-contract.test.js
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(process.cwd(), 'src/server/index.js'), 'utf-8');

function routeBlock(marker, nextMarker) {
  const start = source.indexOf(marker);
  assert.ok(start > -1, `route marker exists: ${marker}`);
  const end = source.indexOf(nextMarker, start + marker.length);
  assert.ok(end > start, `next route marker exists: ${nextMarker}`);
  return source.slice(start, end);
}

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

test('workflow mutation routes authenticate before hub reads or mutations', () => {
  const routes = [
    ['scriptWorkflowProposalMatch && req.method', 'const workflowProposalMatch'],
    ['workflowProposalMatch && req.method', 'const scriptWorkflowRunStartMatch'],
    ['scriptWorkflowRunStartMatch && req.method', 'const workflowRunStartMatch'],
    ['workflowRunStartMatch && req.method', 'const scriptWorkflowParallelGroupMatch'],
    ['scriptWorkflowParallelGroupMatch && req.method', 'const scriptWorkflowNodeMatch'],
    ['scriptWorkflowNodeMatch && req.method', 'const scriptWorkflowNodeResultMatch'],
    ['scriptWorkflowNodeResultMatch && req.method', 'const scriptWorkflowNodeRetryMatch'],
    ['scriptWorkflowNodeRetryMatch && req.method', 'const scriptWorkflowCompleteMatch'],
    ['scriptWorkflowCompleteMatch && req.method', 'const workflowRunProgressMatch'],
    ['workflowRunProgressMatch && req.method', 'const workflowRunCancelMatch'],
    ['workflowRunCancelMatch && req.method', 'const diagnoseWorkflowMatch'],
  ];

  for (const [marker, nextMarker] of routes) {
    const block = routeBlock(marker, nextMarker);
    const authIndex = block.indexOf('resolveDesktopMutationContext(req)');
    const hubIndex = block.indexOf('hub.');
    assert.ok(authIndex > -1, `${marker} authenticates mutation`);
    assert.ok(hubIndex === -1 || authIndex < hubIndex, `${marker} authenticates before hub access`);
  }
});

test('server wires script node-result write-back endpoint with attempt/handoff/fromAgent/output and workflow_run_updated broadcast', () => {
  assert.ok(source.includes('script\\/nodes\\/([^/]+)\\/result'));
  assert.match(source, /handleWorkflowNodeResult/);
  const block = routeBlock('scriptWorkflowNodeResultMatch && req.method', 'const scriptWorkflowNodeRetryMatch');
  assert.match(block, /attempt: body\?\.attempt/);
  assert.match(block, /handoffId: body\?\.handoffId/);
  assert.match(block, /fromAgent: body\?\.fromAgent/);
  assert.match(block, /output: body\?\.output/);
  assert.match(block, /type: 'workflow_run_updated'/);
  assert.match(block, /sendWorkflowNodeHandoffs/);
});

test('server wires script node retry endpoint with workflow update broadcast and handoff dispatch', () => {
  assert.ok(source.includes('script\\/nodes\\/([^/]+)\\/retry'));
  assert.match(source, /retryWorkflowScriptAgentNode/);
  const block = routeBlock('scriptWorkflowNodeRetryMatch && req.method', 'const scriptWorkflowCompleteMatch');
  assert.match(block, /assignedAgent: body\?\.assignedAgent/);
  assert.match(block, /type: 'workflow_run_updated'/);
  assert.match(block, /sendWorkflowNodeHandoffs/);
});

test('server forwards declared node permissions without collapsing falsy values', () => {
  const block = routeBlock('scriptWorkflowNodeMatch && req.method', 'const scriptWorkflowNodeResultMatch');
  assert.match(block, /Object\.hasOwn\(body, 'permissions'\) \? body\.permissions : null/);
});

test('server forwards scriptSource into script-generated proposal and exposes runs via GET', () => {
  const block = routeBlock('scriptWorkflowProposalMatch && req.method', 'const workflowProposalMatch');
  assert.match(block, /scriptSource: body\?\.scriptSource/);
  // GET single workflow run endpoint returns the run object verbatim so the
  // persisted scriptSource travels to the desktop runtime for recovery.
  assert.ok(source.includes('projectWorkflowRunMatch'));
  assert.match(source, /hub\.getWorkflowRun\(/);
  assert.match(source, /json\(res, \{ workflowRun \}\)/);
});

test('legacy deliver route forwards idempotency key and maps conflicts to 409', () => {
  const block = routeBlock('deliverMatch && req.method', 'const closeMatch');
  assert.match(block, /submissionIdempotencyKey: body\?\.submissionIdempotencyKey/);
  assert.match(block, /result\.error === 'idempotency_conflict' \? 409 : 400/);
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
