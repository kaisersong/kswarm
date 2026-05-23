/**
 * KSwarm — file-first artifact reference registration tests
 *
 * Run: node test/artifact-reference-registration.test.js
 */

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveReferencedArtifactsFromOutput } from '../src/core/artifact-reference-registration.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function withWorkspace(fn) {
  const workspace = mkdtempSync(join(tmpdir(), 'kswarm-artifact-ref-'));
  mkdirSync(join(workspace, 'artifacts'), { recursive: true });
  try {
    return fn(workspace);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

test('registers an existing artifact path from stdout without creating wrapper content', () => withWorkspace((workspace) => {
  const artifactPath = join(workspace, 'artifacts', 'final-report.html');
  writeFileSync(artifactPath, '<!DOCTYPE html><html data-template="kai-report-creator"><body>' + '正文'.repeat(200) + '</body></html>');
  const startedAt = statSync(artifactPath).mtimeMs - 1;

  const result = resolveReferencedArtifactsFromOutput({
    workspacePath: workspace,
    output: '文件已生成：artifacts/final-report.html\n大小 2048 bytes',
    projectId: 'proj-1',
    taskId: 'task-1',
    runStartedAt: startedAt,
  });

  assert.equal(result.ok, true);
  assert.equal(result.artifactManifest.length, 1);
  assert.equal(result.artifactManifest[0].filename, 'final-report.html');
  assert.equal(result.shouldUseLegacyWrapper, false);
}));

test('bare artifacts directory mention is not treated as an invalid declared artifact', () => withWorkspace((workspace) => {
  const result = resolveReferencedArtifactsFromOutput({
    workspacePath: workspace,
    output: '请将完整交付物写入 artifacts/ 目录；本次先给出信息收集摘要。',
    projectId: 'proj-1',
    taskId: 'task-1',
    runStartedAt: Date.now(),
    contentHeavy: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.artifactManifest.length, 0);
  assert.equal(result.shouldUseLegacyWrapper, true);
}));

test('registers an existing unicode artifact filename from stdout', () => withWorkspace((workspace) => {
  const artifactPath = join(workspace, 'artifacts', '金蝶AI产品信息收集.md');
  writeFileSync(artifactPath, '# 金蝶AI产品信息收集\n\n' + '有效内容'.repeat(100));
  const startedAt = statSync(artifactPath).mtimeMs - 1;

  const result = resolveReferencedArtifactsFromOutput({
    workspacePath: workspace,
    output: '文件已生成：artifacts/金蝶AI产品信息收集.md',
    projectId: 'proj-1',
    taskId: 'task-1',
    runStartedAt: startedAt,
  });

  assert.equal(result.ok, true);
  assert.equal(result.artifactManifest.length, 1);
  assert.equal(result.artifactManifest[0].filename, '金蝶AI产品信息收集.md');
  assert.equal(result.shouldUseLegacyWrapper, false);
}));

test('missing referenced artifact fails with declared_artifact_missing', () => withWorkspace((workspace) => {
  const result = resolveReferencedArtifactsFromOutput({
    workspacePath: workspace,
    output: '已完成，文件：artifacts/missing-report.html',
    projectId: 'proj-1',
    taskId: 'task-1',
    runStartedAt: Date.now(),
  });

  assert.equal(result.ok, false);
  assert.equal(result.failureClass, 'declared_artifact_missing');
  assert.match(result.error, /missing-report\.html/);
}));

test('stale referenced artifact fails with declared_artifact_stale', () => withWorkspace((workspace) => {
  const artifactPath = join(workspace, 'artifacts', 'old-report.html');
  writeFileSync(artifactPath, '<!DOCTYPE html><html data-template="kai-report-creator"><body>old</body></html>');
  const oldTime = new Date(Date.now() - 60_000);
  utimesSync(artifactPath, oldTime, oldTime);

  const result = resolveReferencedArtifactsFromOutput({
    workspacePath: workspace,
    output: '文件已生成：artifacts/old-report.html',
    projectId: 'proj-1',
    taskId: 'task-1',
    runStartedAt: Date.now(),
  });

  assert.equal(result.ok, false);
  assert.equal(result.failureClass, 'declared_artifact_stale');
}));

test('unsafe artifact path is rejected by manifest path guard', () => withWorkspace((workspace) => {
  const result = resolveReferencedArtifactsFromOutput({
    workspacePath: workspace,
    output: '文件：artifacts/../outside.html',
    projectId: 'proj-1',
    taskId: 'task-1',
    runStartedAt: Date.now(),
  });

  assert.equal(result.ok, false);
  assert.match(result.failureClass, /declared_artifact_(invalid|missing)/);
}));

test('short content-heavy stdout pointer without a resolvable file is not usable as legacy wrapper', () => withWorkspace((workspace) => {
  const result = resolveReferencedArtifactsFromOutput({
    workspacePath: workspace,
    output: '文件已生成：artifacts/final.md',
    projectId: 'proj-1',
    taskId: 'task-1',
    runStartedAt: Date.now(),
    contentHeavy: true,
  });

  assert.equal(result.ok, false);
  assert.equal(result.failureClass, 'declared_artifact_missing');
  assert.equal(result.shouldUseLegacyWrapper, false);
}));

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
  console.log(`\n${passed}/${tests.length} artifact reference registration tests passed`);
}
