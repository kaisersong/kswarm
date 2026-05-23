/**
 * KSwarm — auto-worker protocol contract tests
 *
 * Run: node test/auto-worker-contract.test.js
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildEvidencePromptSection,
  shouldCollectSearchEvidence,
} from '../src/core/auto-worker-evidence.js';

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

test('LLM fallback returns full content for auto-worker materialization instead of fake artifact paths', () => {
  assert.match(source, /let artifactSource\s*=\s*['"]none['"]/);
  assert.match(source, /artifactSource\s*=\s*['"]cli['"]/);
  assert.match(source, /artifactSource\s*=\s*['"]llm['"]/);
  assert.match(source, /artifactSource\s*=\s*['"]llm_repair['"]/);
  assert.match(source, /const shouldResolveReferencedArtifacts\s*=\s*artifactSource\s*===\s*['"]cli['"]/);
  assert.match(source, /内置 LLM 运行时会把你的完整输出保存到 artifacts\/ 目录/);
  assert.match(source, /Do not claim that you wrote a file yourself/);
});

test('worker submission includes artifact manifests and avoids project artifact content upload when workFolder exists', () => {
  assert.match(source, /extractDeclaredArtifacts/);
  assert.match(source, /resolveReferencedArtifactsFromOutput/);
  assert.match(source, /inline_artifact_forbidden/);
  assert.match(source, /declared_artifact_missing/);
  assert.match(source, /declared_artifact_stale/);
  assert.match(source, /artifactManifest/);
  assert.match(source, /submittedArtifacts\s*=\s*artifactManifest/);
  assert.match(source, /if\s*\(!workFolder\)/);
});

test('worker materializes report_html semantic artifacts before contract validation', () => {
  assert.match(source, /buildSemanticOutputArtifacts/);
  assert.match(source, /hasRequiredOutputType/);
  assert.match(source, /semanticOutputArtifacts/);

  const semanticIndex = source.indexOf('buildSemanticOutputArtifacts');
  const artifactFilesIndex = source.indexOf('const artifactFiles =');
  const validationIndex = source.indexOf('const contractValidation = validateTaskResultAgainstContract');
  assert.ok(semanticIndex > 0);
  assert.ok(artifactFilesIndex > semanticIndex);
  assert.ok(validationIndex > artifactFilesIndex);
});

test('worker carries forward dependency HTML when final delivery task requires html output', () => {
  assert.match(source, /function buildCarryForwardDependencyArtifactManifest/);
  assert.match(source, /requiresHtmlOutput/);
  assert.match(source, /dependency_carry_forward/);
  assert.match(source, /hasHtmlArtifact\(existingManifest\)/);

  const carryForwardIndex = source.indexOf('buildCarryForwardDependencyArtifactManifest({');
  const manifestAssignIndex = source.indexOf('artifactManifest = [', carryForwardIndex);
  const validationIndex = source.indexOf('const contractValidation = validateTaskResultAgainstContract');
  assert.ok(carryForwardIndex > 0);
  assert.ok(manifestAssignIndex > carryForwardIndex);
  assert.ok(validationIndex > manifestAssignIndex);
});

test('worker validates generated artifact contracts with project workFolder context', () => {
  assert.match(source, /workspacePath:\s*workFolder/);
  assert.match(source, /validateTaskResultAgainstContract\(taskContract,\s*resultPayload,\s*\{\s*workspacePath:\s*workFolder\s*\}\)/s);
});

test('worker dependency context lookup accepts task ids and local ids, not only titles', () => {
  assert.match(source, /function findDependencyTask/);
  assert.match(source, /findDependencyTask\(allTasks,\s*depTitle\)/);
  assert.match(source, /task\.id/);
  assert.match(source, /task\.localTaskId/);
  assert.match(source, /task\.title/);
});

test('worker retry dependency context falls back to parent task dependencies', () => {
  assert.match(source, /parentTask\s*=\s*thisTask\?\.parentTaskId/);
  assert.match(source, /parentTask\?\.dependencies/);
  assert.match(source, /const dependencyRefs\s*=\s*thisTask\?\.dependencies\?\.length > 0/s);
});

test('worker supports separate logical agent and runtime instance identity', () => {
  assert.match(source, /KSWARM_LOGICAL_AGENT_ID/);
  assert.match(source, /LOGICAL_AGENT_ID\s*=\s*process\.env\.KSWARM_LOGICAL_AGENT_ID\s*\|\|\s*AGENT_ID/);
  assert.match(source, /fetch\(`\$\{KSWARM_API\}\/agents\/\$\{LOGICAL_AGENT_ID\}`\)/);
});

test('auto-worker refuses desktop-managed seed user tasks unless explicitly running maintenance mode', () => {
  assert.match(source, /function isDesktopManagedSeedConfig/);
  assert.match(source, /KSWARM_AUTO_WORKER_MODE/);
  assert.match(source, /desktop_runtime_required/);
  assert.match(source, /process\.exitCode\s*=\s*12/);
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

test('PO planning and review prompts include current date and future-data guardrails', () => {
  assert.match(source, /function getCurrentDateForPrompt/);
  assert.match(source, /当前日期/);
  assert.match(source, /不得要求当前日期之后/);
  assert.match(source, /planRevisionNeeded/);
});

test('worker task prompt includes current date and anti-fabrication source rules', () => {
  const promptBlock = source.slice(
    source.indexOf('function buildTaskPrompt'),
    source.indexOf('async function llmGenerateReport')
  );

  assert.match(promptBlock, /getCurrentDateForPrompt/);
  assert.match(promptBlock, /当前日期/);
  assert.match(promptBlock, /不要编造来源URL、发布日期、会议名称、财报数据或指标/);
  assert.match(promptBlock, /无法验证来源/);
});

test('source-critical outputs run source evidence validation and fail with quality evidence class', () => {
  assert.match(source, /requiresExternalSourceEvidence/);
  assert.match(source, /validateSourceEvidenceArtifact/);
  assert.match(source, /failureReason:\s*sourceEvidence\.failureClass\s*\|\|\s*['"]quality_evidence_missing['"]/);
});

test('auto-worker evidence helpers require search evidence and build a grounding prompt section', () => {
  assert.equal(shouldCollectSearchEvidence({
    kind: 'external_source_v1',
    required: true,
  }), true);
  assert.equal(shouldCollectSearchEvidence({
    kind: 'none',
    required: false,
  }), false);

  const section = buildEvidencePromptSection({
    queries: [{
      query: '金蝶 AI 峰会 2026',
      results: [{
        title: '金蝶AI峰会2026',
        url: 'https://www.kingdee.com/kais2026',
        snippet: '2026年5月20日 灵基 Lingee',
      }],
    }],
    fetchedPages: [{
      url: 'https://www.kingdee.com/kais2026',
      ok: true,
      status: 200,
      excerpt: '2026年5月20日 灵基 Lingee',
    }],
  });

  assert.ok(section.includes('search-evidence.json'));
  assert.ok(section.includes('灵基 Lingee'));
  assert.ok(section.includes('禁止新增未出现在搜索证据中的事实'));
});

test('auto-worker collects search evidence before generating source-heavy artifacts', () => {
  assert.match(source, /collectSearchEvidence/);
  assert.match(source, /search-evidence\.json/);
  assert.match(source, /buildEvidencePromptSection/);
  assert.match(source, /quality_evidence_missing/);
});

test('auto-worker forwards search evidence failure class instead of hard-coding quality evidence', () => {
  const searchBlock = source.slice(
    source.indexOf('if (shouldCollectSearchEvidence'),
    source.indexOf('const evidenceContext =', source.indexOf('if (shouldCollectSearchEvidence'))
  );

  assert.match(searchBlock, /source_provider_unavailable/);
  assert.match(searchBlock, /failureReason:\s*searchEvidence\?\.validation\?\.failureClass\s*\|\|\s*['"]quality_evidence_missing['"]/);
});

test('workFolder context filters internal review evidence before prompting agents', () => {
  assert.match(source, /function shouldIncludeWorkFolderContextFile/);
  assert.match(source, /review-evidence\.json/);

  const contextBlock = source.slice(
    source.indexOf('function readWorkFolderContext'),
    source.indexOf('function listFilesRecursive')
  );

  assert.match(contextBlock, /\.filter\(file => shouldIncludeWorkFolderContextFile\(file\.relative\)\)/);
  assert.match(contextBlock, /files\.map\(f => `  \$\{f\.relative\}`\)/);
});

test('worker prompt keeps final user-facing deliverables free of review process markers', () => {
  const promptBlock = source.slice(
    source.indexOf('function buildTaskPrompt'),
    source.indexOf('async function llmGenerateReport')
  );

  assert.match(promptBlock, /最终用户可见交付物/);
  assert.match(promptBlock, /修订总览/);
  assert.match(promptBlock, /评审回应与修订说明/);
  assert.match(promptBlock, /评审意见逐条回应/);
  assert.match(promptBlock, /【新增】/);
  assert.match(promptBlock, /第二轮修订定稿/);
  assert.match(promptBlock, /Finding/);
  assert.match(promptBlock, /Verdict/);
  assert.match(promptBlock, /评审记录或内部修订说明文件/);
  assert.match(promptBlock, /unless the user explicitly asked for/);
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
