/**
 * KSwarm — canonicalArtifacts / dependencyPolicies / artifactEvidenceExtensions
 * 作为 project 内嵌字段，随 project 整体持久化到 SQLite 并在重启后正确恢复
 * （design §10.1：durable state 接线）
 *
 * 设计依据：mydocs/xiaok-cli/design/2026-08-31-collaboration-room-evidence-first-execution-and-gate-design.md v8
 *   §10.1 —— "canonical artifact manifest 的 evidence extension、
 *   ReviewConditionV1、service-derived GateEvaluationV1 和 project gate
 *   snapshot 进入 KSwarm project-scoped durable state"
 *
 * 现状核实（2026-09-02）：state-scope.js 的 case 'project' 把整个 project
 * 对象原样 push（不是逐字段挑选），这意味着 canonicalArtifacts/
 * dependencyPolicies/gateEvaluations/artifactEvidenceExtensions 这些作为
 * project 内嵌字段的新集合，天然会随 project 整体持久化，不需要像
 * reviewConditions/reviewGateDecisions 那样在 state-scope.js/
 * sqlite-persistence.js 里新增独立 case 分支。本文件用真实 SQLite
 * reopen 验证这个结论，而不是只看代码结构推断。
 *
 * Run: node test/persistence-project-embedded-collections.test.js
 */

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHub } from '../src/core/hub.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function tempDir(label) { return mkdtempSync(join(tmpdir(), `kswarm-${label}-`)); }
function sqliteDataDir(dir) { return { backend: 'sqlite', filePath: join(dir, 'state.sqlite'), legacyJsonPath: join(dir, 'state.json') }; }

test('project.canonicalArtifacts / dependencyPolicies / artifactEvidenceExtensions 在 SQLite 重启后完整恢复', () => {
  const dir = tempDir('embedded-collections');
  try {
    const dataDir = sqliteDataDir(dir);
    const hub1 = createHub({ silent: true, dataDir });
    const projectId = 'proj-embedded-persist';
    hub1.createProject({
      id: projectId, name: projectId, goal: 'goal', poAgent: 'po', members: ['worker'],
      executionGateSchemaVersion: 2,
    });
    const created = hub1.handleCreateTasks(projectId, [
      { id: 'item-1', title: 'Upstream task', assignedAgent: 'worker', dependencies: [] },
      { id: 'item-2', title: 'Downstream task', assignedAgent: 'worker', dependencies: ['item-1'], dependencyPolicy: { 'item-1': 'verified_pass' } },
    ], 'po');
    assert.equal(created.ok, true, JSON.stringify(created));
    hub1.handleApprove(projectId);

    const board1 = hub1.getBoard(projectId);
    const taskId = created.taskIds[0];
    board1.transition(taskId, 'dispatched', { assignedAgent: 'worker', runId: 'run-1' });
    board1.transition(taskId, 'accepted', { assignedAgent: 'worker' });
    board1.transition(taskId, 'in_progress');
    const submit = hub1.handleSubmitResult(projectId, taskId, {
      summary: 'Task completed with a real artifact and an evidence extension record attached for persistence testing.',
      workFolder: dir,
      artifacts: [{ artifactId: 'artifact-1', path: (() => {
        mkdirSync(join(dir, 'artifacts'), { recursive: true });
        const p = join(dir, 'artifacts', 'output.md');
        writeFileSync(p, 'persisted content');
        return p;
      })() }],
      evidenceExtensions: [{ schemaVersion: 'artifact-evidence-extension-v1', artifactId: 'page-1', runId: 'run-1', claimIds: ['c1'] }],
    }, 'worker', 'run-1');
    assert.equal(submit.ok, true, JSON.stringify(submit));

    const upstreamId = created.taskIds[0];
    const beforeProject = hub1.getProject(projectId);
    assert.ok(beforeProject.canonicalArtifacts?.['artifact-1'], 'sanity check：写入前 canonicalArtifacts 必须真实存在');
    assert.equal(beforeProject.dependencyPolicies?.[upstreamId], 'verified_pass');
    assert.ok(beforeProject.artifactEvidenceExtensions?.['page-1'], 'sanity check：写入前 artifactEvidenceExtensions 必须真实存在');

    hub1.closePersistence();

    const hub2 = createHub({ silent: true, dataDir });
    const afterProject = hub2.getProject(projectId);
    assert.ok(afterProject, 'project 必须在重启后仍然存在');

    assert.equal(afterProject.canonicalArtifacts?.['artifact-1']?.sha256, beforeProject.canonicalArtifacts['artifact-1'].sha256, 'canonicalArtifacts 必须在重启后完整恢复');
    assert.equal(afterProject.dependencyPolicies?.[upstreamId], 'verified_pass', 'dependencyPolicies 必须在重启后完整恢复');
    assert.deepEqual(afterProject.artifactEvidenceExtensions?.['page-1']?.claimIds, ['c1'], 'artifactEvidenceExtensions 必须在重启后完整恢复');

    hub2.closePersistence();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

let passed = 0;
let failed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
    if (process.env.DEBUG) console.log(err.stack);
  }
}
console.log(`\n${passed}/${tests.length} project embedded collections persistence tests passed\n`);
if (failed > 0) process.exit(1);
