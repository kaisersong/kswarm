/**
 * KSwarm — hydrateGateFacts（design §8.1.1，唯一 gate 读盘与派生事实 I/O owner）
 *
 * 设计依据：mydocs/xiaok-cli/design/2026-08-31-collaboration-room-evidence-first-execution-and-gate-design.md v8
 *   §8.1.1 Hydration 与纯判定边界：
 *   "hydrateGateFacts(projectId, requiredArtifactIds, expectedLifecycleVersion): HydratedGateFactsV1
 *   是 gate 读盘与派生事实的唯一 I/O owner：由 KSwarm service 使用同步、大小有界的
 *   本地文件操作做 canonical ID 解析、realpath containment、真实文件读取、service
 *   SHA-256、schema 解析、manifest/lifecycle version 校验，并从磁盘证据派生
 *   GateEvaluation/check facts。它不做"是否解锁/是否批准"的业务决策。不存在、越界、
 *   hash/schema 不符以结构化 blocked/waiting fact 返回；不可解释 I/O 错误终止本次
 *   mutation，不能降级为 passed。"
 *
 *   HydratedGateFactsV1 字段：schemaVersion / projectId / projectLifecycleVersion /
 *   hydratedAt / manifestRevision / currentArtifacts[]（containmentPassed）/
 *   derivedGateEvaluations[] / deterministicCheckResults[]
 *
 * 现状核实（2026-09-02）：hydrateGateFacts 此前完全不存在（全代码库 grep 零匹配）。
 * 依赖的基础设施本轮已补齐：canonical-artifact-registry.js（project 级 canonical
 * artifact + manifestRevision）、gate-evidence-acceptor.js（GateEvaluationV1 磁盘
 * 证据解析，已导出 readContainedArtifact 供本模块复用，避免重复实现 containment
 * 读取逻辑）。
 *
 * Run: node test/hydrate-gate-facts.test.js
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { hydrateGateFacts } from '../src/core/hydrate-gate-facts.js';
import { registerCanonicalArtifacts } from '../src/core/canonical-artifact-registry.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function sha256(text) {
  return createHash('sha256').update(Buffer.from(text, 'utf-8')).digest('hex');
}

function freshProject(overrides = {}) {
  return {
    id: 'proj-1',
    lifecycleVersion: 1,
    canonicalArtifacts: {},
    manifestRevision: 0,
    gateEvaluations: {},
    ...overrides,
  };
}

test('expectedLifecycleVersion 与 project 当前 lifecycleVersion 不一致时 fail closed（CAS 校验）', () => {
  const project = freshProject({ lifecycleVersion: 5 });
  const result = hydrateGateFacts({
    project,
    requiredArtifactIds: [],
    expectedLifecycleVersion: 3,
    artifactsDir: '/tmp/nonexistent',
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'lifecycle_version_conflict');
});

test('requiredArtifactId 在 canonicalArtifacts 中找不到时，该 artifact 以结构化 blocked fact 返回（不是 fail closed 终止整个 hydration）', () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'kswarm-hydrate-'));
  try {
    const project = freshProject();
    const result = hydrateGateFacts({
      project,
      requiredArtifactIds: ['missing-artifact'],
      expectedLifecycleVersion: project.lifecycleVersion,
      artifactsDir: workspaceRoot,
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.facts.schemaVersion, 'hydrated-gate-facts-v1');
    const entry = result.facts.currentArtifacts.find(a => a.artifactId === 'missing-artifact');
    assert.ok(entry, '缺失的 artifact 仍应出现在 currentArtifacts 中，标记为未通过 containment');
    assert.equal(entry.containmentPassed, false);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('canonical artifact 记录的 sha256 与磁盘真实内容不一致时，containmentPassed=false（不可解释为 passed）', () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'kswarm-hydrate-'));
  try {
    const project = freshProject();
    const relativePath = 'artifacts/a1.md';
    mkdirSync(join(workspaceRoot, 'artifacts'), { recursive: true });
    writeFileSync(join(workspaceRoot, relativePath), 'real content');
    registerCanonicalArtifacts(project, [{ artifactId: 'a1', relativePath, sha256: 'stale-hash-does-not-match', taskId: 't1', runId: 'r1' }]);

    const result = hydrateGateFacts({
      project,
      requiredArtifactIds: ['a1'],
      expectedLifecycleVersion: project.lifecycleVersion,
      artifactsDir: workspaceRoot,
    });
    assert.equal(result.ok, true);
    const entry = result.facts.currentArtifacts.find(a => a.artifactId === 'a1');
    assert.equal(entry.containmentPassed, false);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('design §8.1.1/§10.5：hydrateGateFacts 消费 readContainedArtifact 返回的 stat 信息，为未来 TOCTOU 检测保留 wiring（本轮新增：readContainedArtifact 已返回 stat + statChangedDuringRead，hydrateSingleArtifact 已据此拒绝把读取期间被替换的内容当作 containmentPassed）', () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'kswarm-hydrate-'));
  try {
    const project = freshProject();
    const relativePath = 'artifacts/a1.md';
    const content = 'stable content for toctou wiring check';
    const hash = sha256(content);
    mkdirSync(join(workspaceRoot, 'artifacts'), { recursive: true });
    writeFileSync(join(workspaceRoot, relativePath), content);
    registerCanonicalArtifacts(project, [{ artifactId: 'a1', relativePath, sha256: hash, taskId: 't1', runId: 'r1' }]);

    // 正常（未被并发篡改）路径必须不受影响：这是防止 wiring 修复引入误报的
    // 基线保护。
    const result = hydrateGateFacts({
      project,
      requiredArtifactIds: ['a1'],
      expectedLifecycleVersion: project.lifecycleVersion,
      artifactsDir: workspaceRoot,
    });
    assert.equal(result.ok, true);
    const entry = result.facts.currentArtifacts.find(a => a.artifactId === 'a1');
    assert.equal(entry.containmentPassed, true, '正常读取（无并发篡改）不应被 TOCTOU 检测误判为失败');
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('canonical artifact 记录与磁盘真实内容一致时，containmentPassed=true 且 serviceSha256 由 service 端重新计算（不信任 manifest 声称的值）', () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'kswarm-hydrate-'));
  try {
    const project = freshProject();
    const relativePath = 'artifacts/a1.md';
    const content = 'real content';
    const hash = sha256(content);
    mkdirSync(join(workspaceRoot, 'artifacts'), { recursive: true });
    writeFileSync(join(workspaceRoot, relativePath), content);
    registerCanonicalArtifacts(project, [{ artifactId: 'a1', relativePath, sha256: hash, taskId: 't1', runId: 'r1' }]);

    const result = hydrateGateFacts({
      project,
      requiredArtifactIds: ['a1'],
      expectedLifecycleVersion: project.lifecycleVersion,
      artifactsDir: workspaceRoot,
    });
    assert.equal(result.ok, true);
    const entry = result.facts.currentArtifacts.find(a => a.artifactId === 'a1');
    assert.equal(entry.containmentPassed, true);
    assert.equal(entry.serviceSha256, hash);
    assert.equal(entry.manifestSha256, hash);
    assert.equal(entry.canonicalRelativePath, relativePath);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('facts.manifestRevision 与 project.manifestRevision 一致（同一次 hydration 快照）', () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'kswarm-hydrate-'));
  try {
    const project = freshProject();
    registerCanonicalArtifacts(project, [{ artifactId: 'a1', relativePath: 'artifacts/a1.md', sha256: sha256('x'), taskId: 't1', runId: 'r1' }]);
    mkdirSync(join(workspaceRoot, 'artifacts'), { recursive: true });
    writeFileSync(join(workspaceRoot, 'artifacts/a1.md'), 'x');

    const result = hydrateGateFacts({
      project,
      requiredArtifactIds: [],
      expectedLifecycleVersion: project.lifecycleVersion,
      artifactsDir: workspaceRoot,
    });
    assert.equal(result.ok, true);
    assert.equal(result.facts.manifestRevision, project.manifestRevision);
    assert.equal(result.facts.manifestRevision, 1);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('derivedGateEvaluations 只包含 requiredArtifactIds 对应任务的 fresh evaluation（sourceRunId 与 canonical artifact 记录的 runId 一致）', () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'kswarm-hydrate-'));
  try {
    const project = freshProject();
    registerCanonicalArtifacts(project, [{ artifactId: 'a1', relativePath: 'artifacts/a1.md', sha256: sha256('x'), taskId: 't1', runId: 'run-1' }]);
    mkdirSync(join(workspaceRoot, 'artifacts'), { recursive: true });
    writeFileSync(join(workspaceRoot, 'artifacts/a1.md'), 'x');

    project.gateEvaluations = {
      t1: [
        {
          schemaVersion: 'gate-evaluation-v1',
          sourceArtifactId: 'gate-ev-1',
          sourceArtifactSha256: 'h',
          sourceRunId: 'run-1', // 与 canonical artifact 记录的 runId 一致：fresh
          subjectArtifacts: [{ artifactId: 'a1', sha256: sha256('x') }],
          verdict: 'passed',
          reasonCode: 'evidence_passed',
          findingIds: [],
          conditionIds: [],
          evaluator: { participantId: 'reviewer-x', role: 'independent_reviewer', independence: 'independent' },
          createdAt: new Date().toISOString(),
        },
        {
          schemaVersion: 'gate-evaluation-v1',
          sourceArtifactId: 'gate-ev-0',
          sourceArtifactSha256: 'h0',
          sourceRunId: 'run-0', // 陈旧的 run，不应出现在 derivedGateEvaluations
          subjectArtifacts: [{ artifactId: 'a1', sha256: 'old-hash' }],
          verdict: 'passed',
          reasonCode: 'evidence_passed',
          findingIds: [],
          conditionIds: [],
          evaluator: { participantId: 'reviewer-x', role: 'independent_reviewer', independence: 'independent' },
          createdAt: new Date().toISOString(),
        },
      ],
    };

    const result = hydrateGateFacts({
      project,
      requiredArtifactIds: ['a1'],
      expectedLifecycleVersion: project.lifecycleVersion,
      artifactsDir: workspaceRoot,
    });
    assert.equal(result.ok, true);
    assert.equal(result.facts.derivedGateEvaluations.length, 1, 'stale run 的 evaluation 不应出现在 derivedGateEvaluations 中');
    assert.equal(result.facts.derivedGateEvaluations[0].sourceRunId, 'run-1');
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
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
console.log(`\n${passed}/${tests.length} hydrateGateFacts tests passed\n`);
if (failed > 0) process.exit(1);
