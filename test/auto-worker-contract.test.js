/**
 * KSwarm — auto-worker protocol contract tests
 *
 * Run: node test/auto-worker-contract.test.js
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(process.cwd(), 'scripts/auto-worker.js'), 'utf-8');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('worker failure path sends explicit task_failed intent', () => {
  assert.match(source, /kind:\s*['"]task_failed['"]/);
  assert.match(source, /failureReason:\s*['"]model_empty_output['"]/);
  assert.match(source, /errorMessage/);
});

test('worker failure payload keeps project, local task, and run identity', () => {
  const failureBlock = source.slice(
    source.indexOf("kind: 'task_failed'"),
    source.indexOf('return;', source.indexOf("kind: 'task_failed'"))
  );

  assert.match(failureBlock, /projectId/);
  assert.match(failureBlock, /taskId/);
  assert.match(failureBlock, /localTaskId/);
  assert.match(failureBlock, /runId/);
});

test('worker writes restart recovery journal around artifact and submission lifecycle', () => {
  assert.match(source, /writeRunJournal/);
  assert.match(source, /buildArtifactManifest/);
  for (const status of ['received', 'accepting', 'in_progress', 'artifact_written', 'submitting', 'submitted', 'failed']) {
    assert.match(source, new RegExp(`status:\\s*['"]${status}['"]`));
  }
});

test('worker validates execution contract before submit_result', () => {
  assert.match(source, /validateTaskResultAgainstContract/);
  assert.match(source, /review-evidence\.json/);
  assert.match(source, /contract_invalid/);

  const validationIndex = source.indexOf('validateTaskResultAgainstContract');
  const submitIndex = source.indexOf("kind: 'submit_result'");
  assert.ok(validationIndex > 0);
  assert.ok(submitIndex > validationIndex);
});

test('worker forwards concrete contract failure class when validation fails', () => {
  assert.match(source, /failureReason:\s*contractValidation\.failureClass\s*\|\|\s*['"]contract_invalid['"]/);
});

test('worker validates generated artifact quality before submit_result', () => {
  assert.match(source, /classifyGeneratedArtifact/);
  assert.match(source, /buildArtifactRepairPrompt/);
  assert.match(source, /model_empty_output/);

  const qualityIndex = source.indexOf('classifyGeneratedArtifact');
  const submitIndex = source.indexOf("kind: 'submit_result'");
  assert.ok(qualityIndex > 0);
  assert.ok(submitIndex > qualityIndex);
});

test('empty artifact failure is reported as model_empty_output instead of agent_error', () => {
  assert.match(source, /failureReason:\s*['"]model_empty_output['"]/);
  assert.match(source, /artifactQuality/);
});

test('worker emits runtime telemetry and supports owner-checked cancel_run', () => {
  assert.match(source, /childPid/);
  assert.match(source, /lastStdoutAt/);
  assert.match(source, /lastStderrAt/);
  assert.match(source, /lastArtifactAt/);
  assert.match(source, /setInterval\(sendRunHeartbeat/);
  assert.match(source, /kind === ['"]cancel_run['"]/);
  assert.match(source, /cancelActiveRun/);
  assert.match(source, /payload\.runId !== activeRun\.runId/);
  assert.match(source, /activeChild\.kill\(['"]SIGTERM['"]\)/);
});

test('worker prompt requires file-first artifact handoff instead of inline artifact blocks', () => {
  assert.match(source, /写入 artifacts/);
  assert.match(source, /不要在回复、stdout、tool 参数或聊天消息中粘贴完整交付物/);
  assert.doesNotMatch(source, /必须使用独立产物块输出核心文件/);
  assert.doesNotMatch(source, /artifact path=filename\.ext/);
});

test('worker submission includes artifact manifests and avoids project artifact content upload when workFolder exists', () => {
  assert.match(source, /extractDeclaredArtifacts/);
  assert.match(source, /inline_artifact_forbidden/);
  assert.match(source, /artifactManifest/);
  assert.match(source, /submittedArtifacts\s*=\s*artifactManifest/);
  assert.match(source, /if\s*\(!workFolder\)/);
});

test('worker supports separate logical agent and runtime instance identity', () => {
  assert.match(source, /KSWARM_LOGICAL_AGENT_ID/);
  assert.match(source, /LOGICAL_AGENT_ID\s*=\s*process\.env\.KSWARM_LOGICAL_AGENT_ID\s*\|\|\s*AGENT_ID/);
  assert.match(source, /fetch\(`\$\{KSWARM_API\}\/agents\/\$\{LOGICAL_AGENT_ID\}`\)/);
});

test('project PO polling is scoped to a single project instance when provided', () => {
  assert.match(source, /KSWARM_PROJECT_ID/);
  assert.match(source, /PROJECT_INSTANCE_ID/);
  assert.match(source, /function isProjectPo/);
  assert.match(source, /proj\.id === PROJECT_INSTANCE_ID/);
});

test('PO synthesis all-done check ignores historical retry children', () => {
  assert.match(source, /function isProjectAllDoneForDelivery/);
  assert.match(source, /parentTaskId/);
  assert.match(source, /isHistoricalRetryChildResolved/);
  assert.doesNotMatch(source, /tasks\.every\(t => t\.status === 'done' \|\| t\.status === 'cancelled'\)/);
});

test('PO health polling synthesizes active all-done idle projects', () => {
  const healthBlock = source.slice(
    source.indexOf('async function poHealthCheck'),
    source.indexOf('// Start health monitor after initial startup')
  );

  assert.match(healthBlock, /const allDone = isProjectAllDoneForDelivery\(tasks\)/);
  assert.match(healthBlock, /if\s*\(allDone\)\s*\{/);
  assert.match(healthBlock, /await synthesizeProject\(proj\.id\)/);
  assert.match(healthBlock, /else if\s*\(hasPending\)/);
});

test('PO health polling runs once shortly after startup before interval polling', () => {
  const startupBlock = source.slice(source.indexOf('// Start health monitor after initial startup'));
  const immediateHealthMatch = startupBlock.match(/(?:void\s+)?poHealthCheck\(\);/);
  const intervalIndex = startupBlock.indexOf('setInterval(poHealthCheck');

  assert.ok(immediateHealthMatch, 'expected startup block to call poHealthCheck once immediately');
  assert.ok(intervalIndex > 0, 'expected startup block to register interval polling');
  assert.ok(immediateHealthMatch.index < intervalIndex, 'expected immediate health check before interval registration');
});

test('worker polling accepts assigned runtime instances', () => {
  assert.match(source, /function isTaskAssignedToRuntime/);
  assert.match(source, /task\.assignedRuntimeInstance === AGENT_ID/);
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
  console.log(`\n${passed}/${tests.length} auto-worker contract tests passed`);
}
