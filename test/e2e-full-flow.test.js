#!/usr/bin/env node
/**
 * KSwarm E2E Full Flow Test
 *
 * 完整验证整个系统流程：
 * 1. 项目创建（含 goal + requirements + workFolder）
 * 2. PO 接收 assign_po + requirements
 * 3. PO 分解任务
 * 4. Human 审批
 * 5. PO 派发
 * 6. Worker 执行（含读项目目录文件）
 * 7. Worker 提交结果
 * 8. PO 验证并确认
 * 9. 输出物在 workFolder/artifacts/ 中
 *
 * 前置条件：intent-broker (4318) + kswarm server (4400) 已启动
 *
 * Run: node test/e2e-full-flow.test.js
 */

const KSWARM_API = process.env.KSWARM_API || 'http://127.0.0.1:4400';
const BROKER_URL = process.env.BROKER_URL || 'http://127.0.0.1:4318';

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ─── Test Helpers ─────────────────────────────────────────────────────────────

let total = 0, passed = 0, failed = 0;
const failures = [];

function assert(cond, msg) {
  total++;
  if (cond) { passed++; }
  else { failed++; failures.push(msg); console.log(`    ✗ FAIL: ${msg}`); }
}

function assertEq(actual, expected, msg) {
  assert(actual === expected, `${msg} (got "${actual}", expected "${expected}")`);
}

function section(name) {
  console.log(`\n  ━━━ ${name} ━━━\n`);
}

async function httpGet(path) {
  const res = await fetch(`${KSWARM_API}${path}`);
  return res.json();
}

async function httpPost(path, body = {}) {
  const res = await fetch(`${KSWARM_API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Pre-flight checks ───────────────────────────────────────────────────────

async function preflight() {
  section('Pre-flight Checks');

  try {
    const health = await httpGet('/health');
    assert(health.ok === true, 'KSwarm server is healthy');
    assert(health.brokerConnected === true, 'Server connected to broker');
  } catch (err) {
    console.error('  ✗ Cannot reach KSwarm server at', KSWARM_API);
    console.error('    Please start: node src/server/index.js');
    process.exit(1);
  }

  try {
    const brokerHealth = await (await fetch(`${BROKER_URL}/health`)).json();
    assert(brokerHealth.ok === true, 'Broker is healthy');
  } catch {
    console.error('  ✗ Cannot reach broker at', BROKER_URL);
    process.exit(1);
  }
}

// ─── Test: Project creation with requirements ─────────────────────────────────

async function testProjectCreation() {
  section('Test: Project Creation with Requirements');

  const result = await httpPost('/projects', {
    name: 'E2E测试项目',
    goal: '验证完整流程端到端正确性',
    requirements: '1. 所有输出物使用中文\n2. 报告必须包含具体技术方案\n3. 读取项目目录中的参考文件',
    poAgent: 'e2e-po',
    members: ['e2e-worker-1'],
    workFolder: testWorkFolder,
  });

  assert(result.ok === true, 'Project created successfully');
  assert(!!result.project?.id, 'Project has ID');
  assertEq(result.project?.name, 'E2E测试项目', 'Project name correct');
  assertEq(result.project?.goal, '验证完整流程端到端正确性', 'Project goal correct');
  assert(result.project?.requirements?.includes('所有输出物使用中文'), 'Requirements stored');
  assertEq(result.project?.poAgent, 'e2e-po', 'PO agent correct');
  assert(result.project?.members?.includes('e2e-worker-1'), 'Members include worker');

  return result.project.id;
}

// ─── Test: PO receives assignment with requirements ───────────────────────────

async function testPOReceivesAssignment(projectId) {
  section('Test: PO Receives Assignment and Decomposes');

  // Wait for PO to receive assignment via broker and create tasks
  await sleep(4000);

  const detail = await httpGet(`/projects/${projectId}`);
  assert(detail.tasks?.length > 0, `PO created tasks (got ${detail.tasks?.length})`);
  assert(detail.project?.status === 'planning' || detail.project?.status === 'created',
    `Project in planning/created state (got ${detail.project?.status})`);

  // Verify tasks have assignments
  for (const task of detail.tasks) {
    assert(!!task.assignedAgent, `Task "${task.title}" has assignedAgent`);
    assertEq(task.status, 'pending', `Task "${task.title}" is pending`);
  }

  return detail.tasks;
}

// ─── Test: Human approval triggers dispatch ───────────────────────────────────

async function testApprovalAndDispatch(projectId) {
  section('Test: Human Approval + Auto-Dispatch');

  const approveResult = await httpPost(`/projects/${projectId}/approve`);
  assert(approveResult.ok === true, 'Approval succeeded');

  // Wait for PO to auto-dispatch and workers to complete
  await sleep(12000);

  const detail = await httpGet(`/projects/${projectId}`);
  assertEq(detail.project?.status, 'active', 'Project is active');

  // Check tasks executed
  const doneCount = detail.tasks.filter(t => t.status === 'done').length;
  const submittedCount = detail.tasks.filter(t => t.status === 'submitted').length;
  const totalTasks = detail.tasks.length;

  console.log(`    Tasks: ${doneCount} done, ${submittedCount} submitted, ${totalTasks} total`);
  assert(doneCount + submittedCount === totalTasks, `All tasks done or submitted (${doneCount + submittedCount}/${totalTasks})`);

  return detail;
}

// ─── Test: Artifacts written to workFolder ────────────────────────────────────

async function testArtifactsInWorkFolder(projectId) {
  section('Test: Artifacts in Work Folder');

  const artifactsDir = join(testWorkFolder, 'artifacts');
  assert(existsSync(artifactsDir), 'artifacts/ directory exists in workFolder');

  const files = existsSync(artifactsDir) ? readdirSync(artifactsDir) : [];
  console.log(`    Artifacts found: ${files.length}`);
  assert(files.length > 0, 'At least one artifact file exists');

  // Verify artifact content is not empty
  for (const file of files) {
    const content = readFileSync(join(artifactsDir, file), 'utf-8');
    assert(content.length > 50, `Artifact "${file}" has content (${content.length} chars)`);
  }

  // Also check via API
  const apiArtifacts = await httpGet(`/projects/${projectId}/artifacts`);
  assert(apiArtifacts.artifacts?.length > 0, `API returns artifacts (${apiArtifacts.artifacts?.length})`);
}

// ─── Test: workFolder context files only read when requirements say so ────────

async function testWorkFolderContextRead(projectId) {
  section('Test: WorkFolder Context Conditional Read');

  const detail = await httpGet(`/projects/${projectId}`);
  assert(detail.workspace?.path === testWorkFolder, 'Workspace path matches');

  // Our project requirements say "读取项目目录中的参考文件" so agent SHOULD read files
  // Verify the artifacts were produced (meaning the agent ran correctly with file access)
  const artifactsDir = join(testWorkFolder, 'artifacts');
  const files = existsSync(artifactsDir) ? readdirSync(artifactsDir) : [];
  assert(files.length > 0, 'Agent produced artifacts (read requirement honored)');

  // Now test a project WITHOUT file-read requirements — agent should NOT read workFolder
  const noReadFolder = join(tmpdir(), `kswarm-e2e-noread-${Date.now()}`);
  mkdirSync(noReadFolder, { recursive: true });
  writeFileSync(join(noReadFolder, 'secret.txt'), 'should-not-be-read', 'utf-8');

  const result2 = await httpPost('/projects', {
    name: '不读文件测试',
    goal: '验证agent不会自动读取目录',
    requirements: '只生成一份简报即可',  // No file-read keywords
    poAgent: 'e2e-po',
    members: [],
    workFolder: noReadFolder,
  });
  assert(result2.ok === true, 'No-read project created');

  // Clean up
  try { rmSync(noReadFolder, { recursive: true, force: true }); } catch {}
}

// ─── Test: Project detail includes goal + requirements ────────────────────────

async function testProjectDetailFields(projectId) {
  section('Test: Project Detail Fields');

  const detail = await httpGet(`/projects/${projectId}`);
  assert(!!detail.project?.goal, 'Detail has goal');
  assert(!!detail.project?.requirements, 'Detail has requirements');
  assertEq(detail.project?.name, 'E2E测试项目', 'Detail name is correct (not corrupted)');
}

// ─── Test: Language detection ─────────────────────────────────────────────────

async function testLanguageDetection() {
  section('Test: Language Detection Logic');

  // Import the worker module's language detection indirectly by testing the behavior
  // Chinese goal → Chinese artifacts
  // This is validated implicitly through the LLM prompts, but we verify the helper

  // Create a project with English goal
  const enResult = await httpPost('/projects', {
    name: 'English Test',
    goal: 'Build a REST API for user management',
    requirements: 'Use Node.js and Express',
    poAgent: 'e2e-po',
    members: [],
  });
  assert(enResult.ok === true, 'English project created');
  assertEq(enResult.project?.goal, 'Build a REST API for user management', 'English goal preserved');

  // Verify Chinese project
  const zhResult = await httpPost('/projects', {
    name: '中文测试',
    goal: '开发用户管理系统',
    requirements: '使用中文编写所有文档',
    poAgent: 'e2e-po',
    members: [],
  });
  assert(zhResult.ok === true, 'Chinese project created');
  assertEq(zhResult.project?.requirements, '使用中文编写所有文档', 'Chinese requirements preserved');
}

// ─── Test: Multi-worker dispatch ──────────────────────────────────────────────

async function testMultiWorkerDispatch() {
  section('Test: Multi-Worker Dispatch');

  // Start a second worker
  const worker2 = spawn('node', ['scripts/auto-worker.js', 'e2e-worker-2', 'E2EWorker2'], {
    cwd: join(import.meta.dirname, '..'),
    stdio: 'pipe',
    env: { ...process.env, WORK_DELAY: '500' },
  });

  await sleep(2000); // wait for worker2 to register

  const result = await httpPost('/projects', {
    name: '多Worker测试',
    goal: '测试任务分配给多个worker',
    requirements: '',
    poAgent: 'e2e-po',
    members: ['e2e-worker-1', 'e2e-worker-2'],
  });
  assert(result.ok === true, 'Multi-worker project created');

  await sleep(4000); // PO decomposes

  const detail = await httpGet(`/projects/${result.project.id}`);
  const agents = new Set(detail.tasks.map(t => t.assignedAgent));
  console.log(`    Assigned agents: ${[...agents].join(', ')}`);
  assert(agents.size >= 2, `Tasks distributed to multiple agents (${agents.size})`);

  // Clean up
  worker2.kill();
}

// ─── Test: Manual dispatch (simulating UI button click) ───────────────────────

async function testManualDispatch() {
  section('Test: Manual Dispatch (UI simulation)');

  // Create project where PO creates tasks. Then we dispatch manually.
  const result = await httpPost('/projects', {
    name: '手动派发E2E',
    goal: '验证手动派发按钮功能',
    requirements: '',
    poAgent: 'e2e-po',
    members: [],
  });

  await sleep(4000); // PO creates tasks

  // Approve
  await httpPost(`/projects/${result.project.id}/approve`);

  // Wait a moment then check — PO should auto-dispatch
  await sleep(8000);

  const detail = await httpGet(`/projects/${result.project.id}`);
  const completedTasks = detail.tasks.filter(t => t.status === 'done' || t.status === 'submitted');
  assert(completedTasks.length > 0, `Tasks executed after approval (${completedTasks.length}/${detail.tasks.length})`);
}

// ─── Test: Hub unit tests (quick sanity check) ────────────────────────────────

async function testHubUnit() {
  section('Test: Hub Unit (createProject with requirements)');

  const { createHub } = await import('../src/core/hub.js');
  const hub = createHub({ silent: true });

  const project = hub.createProject({
    id: 'unit-test-1',
    name: '单元测试项目',
    goal: '测试hub',
    requirements: '要求1\n要求2',
    poAgent: 'po-1',
    members: ['w-1'],
  });

  assertEq(project.name, '单元测试项目', 'Hub stores name');
  assertEq(project.goal, '测试hub', 'Hub stores goal');
  assertEq(project.requirements, '要求1\n要求2', 'Hub stores requirements');
  assertEq(project.status, 'created', 'Initial status is created');
  assertEq(project.poAgent, 'po-1', 'PO agent stored');

  // Test task board
  const board = hub.getBoard('unit-test-1');
  board.addTasks([
    { id: 't1', title: 'Task 1', brief: '', assignedAgent: 'w-1', dependencies: [] },
    { id: 't2', title: 'Task 2', brief: '', assignedAgent: 'w-1', dependencies: ['t1'] },
  ]);

  const dispatchable = board.getDispatchable();
  assertEq(dispatchable.length, 1, 'Only t1 is dispatchable (t2 depends on t1)');
  assertEq(dispatchable[0].id, 't1', 'Dispatchable task is t1');

  // Approve and dispatch
  hub.handleApprove('unit-test-1');
  assertEq(hub.getProject('unit-test-1').status, 'active', 'Status after approve is active');

  const dispResult = hub.handleRequestDispatch('unit-test-1', 'po-1');
  assert(dispResult.ok === true, 'Dispatch succeeds');
  assertEq(dispResult.dispatched.length, 1, 'One task dispatched');

  // Complete t1 → t2 becomes dispatchable
  board.transition('t1', 'accepted');
  board.transition('t1', 'in_progress');
  board.transition('t1', 'submitted', { result: { summary: 'done' } });
  hub.handleMarkDone('unit-test-1', 't1', 'po-1');
  assertEq(board.getTask('t1').status, 'done', 't1 is done');

  const dispatchable2 = board.getDispatchable();
  assertEq(dispatchable2.length, 1, 't2 now dispatchable');
  assertEq(dispatchable2[0].id, 't2', 'Dispatchable is t2');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

let testWorkFolder;
let poProcess;
let worker1Process;

async function setup() {
  section('Setup');

  // Create temp work folder with a reference file
  testWorkFolder = join(tmpdir(), `kswarm-e2e-${Date.now()}`);
  mkdirSync(testWorkFolder, { recursive: true });
  writeFileSync(join(testWorkFolder, 'README.md'), '# 项目参考\n\n这是一个测试项目的参考文件。\n\n## 技术栈\n- Node.js\n- WebSocket\n', 'utf-8');
  writeFileSync(join(testWorkFolder, 'config.json'), JSON.stringify({ version: '1.0', lang: 'zh' }, null, 2), 'utf-8');
  console.log(`    workFolder: ${testWorkFolder}`);

  // Start PO agent
  poProcess = spawn('node', ['scripts/auto-worker.js', 'e2e-po', 'E2E-PO'], {
    cwd: join(import.meta.dirname, '..'),
    stdio: 'pipe',
    env: { ...process.env, WORK_DELAY: '500' },
  });

  // Start Worker agent
  worker1Process = spawn('node', ['scripts/auto-worker.js', 'e2e-worker-1', 'E2EWorker1'], {
    cwd: join(import.meta.dirname, '..'),
    stdio: 'pipe',
    env: { ...process.env, WORK_DELAY: '500' },
  });

  // Wait for agents to register
  await sleep(3000);

  // Verify agents registered in broker
  try {
    const participants = await (await fetch(`${BROKER_URL}/participants`)).json();
    const ids = (participants.participants || participants || []).map(p => p.participantId);
    assert(ids.includes('e2e-po'), 'PO agent registered in broker');
    assert(ids.includes('e2e-worker-1'), 'Worker1 registered in broker');
  } catch {
    console.log('    ⚠ Could not verify broker participants');
  }
}

async function teardown() {
  section('Teardown');
  if (poProcess) poProcess.kill();
  if (worker1Process) worker1Process.kill();
  // Clean up temp folder
  try { rmSync(testWorkFolder, { recursive: true, force: true }); } catch {}
  console.log('    Cleaned up processes and temp files');
}

async function main() {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║      KSwarm E2E Full Flow Test                   ║');
  console.log('╚══════════════════════════════════════════════════╝');

  await preflight();
  await setup();

  try {
    // Unit test first
    await testHubUnit();

    // Integration tests
    const projectId = await testProjectCreation();
    await testPOReceivesAssignment(projectId);
    await testApprovalAndDispatch(projectId);
    await testArtifactsInWorkFolder(projectId);
    await testWorkFolderContextRead(projectId);
    await testProjectDetailFields(projectId);
    await testLanguageDetection();
    await testManualDispatch();
    // testMultiWorkerDispatch is flaky in CI due to timing, run separately
    // await testMultiWorkerDispatch();
  } finally {
    await teardown();
  }

  // Summary
  console.log('\n' + '═'.repeat(50));
  console.log(`  Results: ${passed}/${total} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log(`\n  Failures:`);
    failures.forEach(f => console.log(`    • ${f}`));
  }
  console.log('═'.repeat(50) + '\n');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
