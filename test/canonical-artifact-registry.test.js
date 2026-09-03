/**
 * KSwarm — project 级 canonical artifact registry + manifestRevision（design §8.1.1）
 *
 * 设计依据：mydocs/xiaok-cli/design/2026-08-31-collaboration-room-evidence-first-execution-and-gate-design.md v8
 *   §8.1.1 —— HydratedGateFactsV1.manifestRevision：canonical artifact 集合的版本号，
 *   hydrateGateFacts 读取时用来做"批准入口...再校验 lifecycleVersion 与 manifestRevision
 *   未变"的 CAS 校验。
 *
 * 现状核实（2026-09-02）：manifestRevision 概念在整个代码库中完全不存在；project 对象上
 * 也没有一个真正的、project 级持久化 canonical artifact registry——canonical artifact
 * 目前只临时存在于每次任务提交的 task.result.artifacts/artifactManifest 里，从未被聚合。
 *
 * 本模块是这个基础设施的第一步：project 级 canonical artifact registry + 每次真实
 * 新增/变化时递增的 manifestRevision 计数器。这是 hydrateGateFacts 未来能够做
 * "canonical artifact 解析 + containment + hash"之外，还需要的"这批 artifact 相对
 * 哪个版本号是新鲜的"这层信息的来源。
 *
 * Run: node test/canonical-artifact-registry.test.js
 */

import assert from 'node:assert/strict';
import { registerCanonicalArtifacts, getCanonicalArtifact, listCanonicalArtifacts } from '../src/core/canonical-artifact-registry.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function freshProject() {
  return { id: 'proj-1', canonicalArtifacts: {}, manifestRevision: 0 };
}

test('project 初始 manifestRevision 为 0，registerCanonicalArtifacts 首次注册后递增为 1', () => {
  const project = freshProject();
  const result = registerCanonicalArtifacts(project, [
    { artifactId: 'a1', relativePath: 'artifacts/a1.md', sha256: 'h1', taskId: 't1', runId: 'r1' },
  ]);
  assert.equal(result.ok, true);
  assert.equal(project.manifestRevision, 1);
  assert.equal(result.manifestRevision, 1);
});

test('重复注册完全相同的 artifact 记录（同 artifactId 同 sha256）不递增 manifestRevision（幂等）', () => {
  const project = freshProject();
  registerCanonicalArtifacts(project, [{ artifactId: 'a1', relativePath: 'artifacts/a1.md', sha256: 'h1', taskId: 't1', runId: 'r1' }]);
  assert.equal(project.manifestRevision, 1);
  const result = registerCanonicalArtifacts(project, [{ artifactId: 'a1', relativePath: 'artifacts/a1.md', sha256: 'h1', taskId: 't1', runId: 'r1' }]);
  assert.equal(result.ok, true);
  assert.equal(project.manifestRevision, 1, '完全相同的记录重复注册不应递增版本号');
});

test('同一 artifactId 但 sha256 变化（内容更新）必须递增 manifestRevision，且拒绝静默覆盖不一致的记录', () => {
  const project = freshProject();
  registerCanonicalArtifacts(project, [{ artifactId: 'a1', relativePath: 'artifacts/a1.md', sha256: 'h1', taskId: 't1', runId: 'r1' }]);
  assert.equal(project.manifestRevision, 1);

  // design §3.5："同一 canonical artifact ID 不允许不同 task/run 覆写"——
  // 但同一 task/run 的内容更新（hash 变化）应该被允许并产生新版本号，
  // 不同 task/run 尝试覆写同一 artifactId 则必须拒绝。
  const sameRunUpdate = registerCanonicalArtifacts(project, [{ artifactId: 'a1', relativePath: 'artifacts/a1.md', sha256: 'h2', taskId: 't1', runId: 'r1' }]);
  assert.equal(sameRunUpdate.ok, true);
  assert.equal(project.manifestRevision, 2);
  assert.equal(getCanonicalArtifact(project, 'a1').sha256, 'h2');

  const differentRunOverwrite = registerCanonicalArtifacts(project, [{ artifactId: 'a1', relativePath: 'artifacts/a1.md', sha256: 'h3', taskId: 't2', runId: 'r2' }]);
  assert.equal(differentRunOverwrite.ok, false, '不同 task/run 不允许覆写同一 canonical artifactId');
  assert.equal(differentRunOverwrite.error, 'canonical_artifact_ownership_conflict');
  assert.equal(project.manifestRevision, 2, '被拒绝的注册不应递增版本号');
});

test('批量注册多个 artifact 只递增一次 manifestRevision（原子性——一次 mutation 对应一次版本递增）', () => {
  const project = freshProject();
  const result = registerCanonicalArtifacts(project, [
    { artifactId: 'a1', relativePath: 'artifacts/a1.md', sha256: 'h1', taskId: 't1', runId: 'r1' },
    { artifactId: 'a2', relativePath: 'artifacts/a2.md', sha256: 'h2', taskId: 't1', runId: 'r1' },
  ]);
  assert.equal(result.ok, true);
  assert.equal(project.manifestRevision, 1);
  assert.equal(listCanonicalArtifacts(project).length, 2);
});

test('缺失 artifactId/relativePath/sha256 的记录整体拒绝注册（fail closed，不部分写入）', () => {
  const project = freshProject();
  const result = registerCanonicalArtifacts(project, [
    { artifactId: 'a1', relativePath: 'artifacts/a1.md', sha256: 'h1', taskId: 't1', runId: 'r1' },
    { artifactId: 'a2', relativePath: null, sha256: 'h2', taskId: 't1', runId: 'r1' },
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'invalid_canonical_artifact_record');
  assert.equal(project.manifestRevision, 0, '整体校验失败时不应部分写入或递增版本号');
  assert.equal(listCanonicalArtifacts(project).length, 0);
});

test('getCanonicalArtifact 对不存在的 artifactId 返回 null', () => {
  const project = freshProject();
  assert.equal(getCanonicalArtifact(project, 'nonexistent'), null);
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
console.log(`\n${passed}/${tests.length} canonical artifact registry tests passed\n`);
if (failed > 0) process.exit(1);
