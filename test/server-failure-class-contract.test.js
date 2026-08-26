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

test('every server task-failure entry point schedules retry and replacement deliveries', () => {
  assert.match(source, /import \{ failureRecoveryTaskIds \} from ['"]\.\.\/core\/failure-recovery-dispatch\.js['"]/);

  const brokerFailure = source.slice(
    source.indexOf("case 'task_failed':"),
    source.indexOf("case 'submit_result':"),
  );
  assert.match(brokerFailure, /failureRecoveryTaskIds\(result\)/);
  assert.match(brokerFailure, /sendBrokerRequestTasks\(resolved\.projectId, recoveryTaskIds\)/);

  const restFailure = source.slice(
    source.indexOf('const failMatch = path.match'),
    source.indexOf('const finalDeliverablesMatch'),
  );
  assert.match(restFailure, /failureRecoveryTaskIds\(result\)/);
  assert.match(restFailure, /sendBrokerRequestTasks\(projectId, recoveryTaskIds\)/);

  const watchdogFailure = source.slice(
    source.indexOf("if (action.type === 'mark_runtime_stalled')"),
    source.indexOf("if (action.type === 'request_cancel_run')"),
  );
  assert.match(watchdogFailure, /failureRecoveryTaskIds\(result\)/);
  assert.match(watchdogFailure, /sendBrokerRequestTasks\(action\.projectId, recoveryTaskIds\)/);

  const deliveryFailureHandler = source.slice(
    source.indexOf('async function sendBrokerRequestTasks'),
    source.indexOf('async function sendWorkflowNodeHandoffs'),
  );
  assert.equal((deliveryFailureHandler.match(/failureRecoveryTaskIds\(failed\)/g) || []).length, 3);
  assert.doesNotMatch(deliveryFailureHandler, /failed\?\.retryDispatched/);
});

test('agent list refreshes broker presence and shares the routing profile overlay', () => {
  const listRoute = source.slice(
    source.indexOf("if (path === '/agents' && req.method === 'GET')"),
    source.indexOf('// ── Create agent ──'),
  );

  assert.match(listRoute, /await refreshBrokerOnlineAgentIds\(\)/);
  assert.match(listRoute, /listAgentProfilesForRouting\(\{ includeArchived \}\)/);
  assert.doesNotMatch(listRoute, /agentStore\.list\(/);
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
