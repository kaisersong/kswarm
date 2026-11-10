/**
 * KSwarm — server failure class contract tests
 *
 * Run: node test/server-failure-class-contract.test.js
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(process.cwd(), 'src/server/index.js'), 'utf-8');
const deliveryOwnerSource=readFileSync(join(process.cwd(),'src/server/task-delivery-owner.js'),'utf-8');

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

test('every server task-failure entry point schedules retry and replacement deliveries', () => {
  assert.match(source, /import \{ deliverDispatchResult, deliverFailureRecoveryResults, deliverWorkflowTaskReview \} from ['"]\.\/task-dispatch-delivery\.js['"]/);
  assert.match(source, /deliverDispatchResult\(\{projectId, dispatch, sendTasks:sendBrokerRequestTasks, sendWorkflowNodes:sendWorkflowNodeHandoffs\}\)/);
  assert.match(source, /deliverFailureRecoveryResults\(\{projectId, results, sendTasks:sendBrokerRequestTasks, sendWorkflowNodes:sendWorkflowNodeHandoffs\}\)/);

  const brokerFailure = source.slice(
    source.indexOf("case 'task_failed':"),
    source.indexOf("case 'submit_result':"),
  );
  assert.match(brokerFailure, /sendFailureRecovery\(resolved\.projectId, \[result\]\)/);

  const restFailure = source.slice(
    source.indexOf('const failMatch = path.match'),
    source.indexOf('const finalDeliverablesMatch'),
  );
  assert.match(restFailure, /sendFailureRecovery\(projectId, \[result\]\)/);

  const watchdogFailure = source.slice(
    source.indexOf("if (action.type === 'mark_runtime_stalled')"),
    source.indexOf("if (action.type === 'request_cancel_run')"),
  );
  assert.match(watchdogFailure, /sendFailureRecovery\(action\.projectId, \[result\]\)/);

  const deliveryFailureHandler = source.slice(
    source.indexOf('async function sendBrokerRequestTasksImplementation'),
    source.indexOf('async function sendWorkflowNodeHandoffs'),
  );
  assert.match(source,/createServerTaskDeliveryOwner/);
  assert.match(deliveryFailureHandler,/taskDeliveryOwner\.send\(projectId,taskIds,schedulerContext\)/);
  assert.equal((deliveryOwnerSource.match(/failureRecoveryTaskIds\(failed\)/g) || []).length, 3);
  assert.doesNotMatch(deliveryOwnerSource, /failed\?\.retryDispatched/);
});

test('startup, continue, reassign and backoff dispatch both adaptive result channels',()=>{
  const startup=source.slice(source.indexOf('if (needsDispatch)'),source.indexOf('function handleBrokerIntent'));
  assert.match(startup,/workflowNodeDispatches\?\.length/);
  assert.match(startup,/sendDispatchResult\(project\.id, dispatchResult\)/);
  const continueRoute=source.slice(source.indexOf('const continueMatch ='),source.indexOf('const resolveInterventionMatch'));
  assert.match(continueRoute,/sendDispatchResult\(projectId, result\)/);
  const reassign=source.slice(source.indexOf('const reassignMatch ='),source.indexOf('const humanTasksMatch ='));
  assert.match(reassign,/sendDispatchResult\(projectId, result\.dispatch\)/);
  const backoff=source.slice(source.indexOf('const dueRetry ='),source.indexOf('const AGENT_RUNTIME_FAILURE_CLASSES'));
  assert.match(backoff,/workflowNodeDispatches\?\.length/);
  assert.match(backoff,/sendDispatchResult\(project\.id, sweep\)/);
});

test('agent list refreshes broker presence and shares the routing profile overlay', () => {
  const listRoute = source.slice(
    source.indexOf("if (path === '/agents' && req.method === 'GET')"),
    source.indexOf('// ── Create agent ──'),
  );

  assert.match(listRoute, /await awaitServerOperation\(refreshBrokerOnlineAgentIds\(\)\)/);
  assert.match(listRoute, /listAgentProfilesForRouting\(\{ includeArchived \}\)/);
  assert.doesNotMatch(listRoute, /agentStore\.list\(/);
});

test('workflow completion schedules the existing durable PO review delivery',()=>{
  const brokerCase=source.slice(source.indexOf("case 'workflow_node_result':"),source.indexOf("case 'workflow_node_failed':"));
  assert.match(brokerCase,/sendWorkflowResultReview\(result\)/);
  assert.match(source,/sendReview:deliverReviewSubmission/);
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
