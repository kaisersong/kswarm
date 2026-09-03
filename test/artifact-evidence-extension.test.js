/**
 * KSwarm — artifact-evidence-extension.js unit tests
 *
 * 设计依据：design §3.5 Canonical Artifact Manifest
 *
 * Run: node test/artifact-evidence-extension.test.js
 */

import assert from 'node:assert/strict';
import {
  encodePathSegment,
  buildTaskRunEvidenceDir,
  buildTaskRunEvidencePath,
  buildArtifactEvidenceExtension,
} from '../src/core/artifact-evidence-extension.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('encodePathSegment allows plain alphanumeric task/run ids unchanged', () => {
  assert.equal(encodePathSegment('task-abc_123.v2'), 'task-abc_123.v2');
});

test('encodePathSegment rejects a bare dot segment', () => {
  assert.throws(() => encodePathSegment('.'), /reserved dot segment/);
});

test('encodePathSegment rejects a bare double-dot segment', () => {
  assert.throws(() => encodePathSegment('..'), /reserved dot segment/);
});

test('encodePathSegment encodes path separators so they cannot be interpreted as directory traversal', () => {
  const encoded = encodePathSegment('../../etc/passwd');
  // '/' 必须被编码，否则会在拼接路径时被文件系统解释为目录分隔符。
  assert.equal(encoded.includes('/'), false);
  // 编码后的字符串本身可能仍包含字面 '.' 字符（它们在允许字符集内），
  // 但它们已经不再是可被文件系统解析为上级目录引用的 '..' 路径段——
  // 真正的安全判定是：整个值不含 '/'，因此不可能被当作多级路径。
  assert.equal(encoded.split('/').length, 1, 'encoded segment must not contain any path separator');
});

test('encodePathSegment encodes backslashes', () => {
  const encoded = encodePathSegment('..\\..\\windows\\system32');
  assert.equal(encoded.includes('\\'), false);
});

test('encodePathSegment rejects Windows reserved device names', () => {
  assert.throws(() => encodePathSegment('CON'), /windows reserved name/);
  assert.throws(() => encodePathSegment('con.txt'), /windows reserved name/);
  assert.throws(() => encodePathSegment('NUL'), /windows reserved name/);
  assert.throws(() => encodePathSegment('COM1'), /windows reserved name/);
});

test('encodePathSegment rejects a drive letter', () => {
  assert.throws(() => encodePathSegment('C:'), /drive letter/);
});

test('encodePathSegment rejects empty input', () => {
  assert.throws(() => encodePathSegment(''), /required/);
  assert.throws(() => encodePathSegment(null), /required/);
});

test('encodePathSegment encodes NUL bytes', () => {
  const encoded = encodePathSegment('task\0evil');
  assert.equal(encoded.includes('\0'), false);
});

test('buildTaskRunEvidenceDir produces a project-relative posix path under artifacts/tasks/<id>/<run>', () => {
  const dir = buildTaskRunEvidenceDir('task-1', 'run-1');
  assert.equal(dir, 'artifacts/tasks/task-1/run-1');
});

test('buildTaskRunEvidenceDir rejects traversal attempts in taskId or runId', () => {
  const dir = buildTaskRunEvidenceDir('../../etc', 'run-1');
  // 编码后的 taskId 段本身不含 '/'，所以最终路径的 segment 数量固定为 4
  // （artifacts/tasks/<safeTaskId>/<safeRunId>），不会因为恶意输入而多出层级。
  const segments = dir.split('/');
  assert.equal(segments.length, 4);
  assert.equal(segments[0], 'artifacts');
  assert.equal(segments[1], 'tasks');
  assert.ok(dir.startsWith('artifacts/tasks/'));
});

test('buildTaskRunEvidencePath rejects a filename containing a path separator', () => {
  assert.throws(() => buildTaskRunEvidencePath('task-1', 'run-1', '../escape.json'), /filename_invalid/);
  assert.throws(() => buildTaskRunEvidencePath('task-1', 'run-1', 'sub/dir.json'), /filename_invalid/);
  assert.throws(() => buildTaskRunEvidencePath('task-1', 'run-1', 'sub\\dir.json'), /filename_invalid/);
});

test('buildTaskRunEvidencePath produces the expected namespaced file path', () => {
  const path = buildTaskRunEvidencePath('task-1', 'run-1', 'review-evidence.json');
  assert.equal(path, 'artifacts/tasks/task-1/run-1/review-evidence.json');
});

test('buildArtifactEvidenceExtension requires artifactId and runId', () => {
  assert.throws(() => buildArtifactEvidenceExtension({ runId: 'run-1' }), /artifactId_required/);
  assert.throws(() => buildArtifactEvidenceExtension({ artifactId: 'a1' }), /runId_required/);
});

test('buildArtifactEvidenceExtension builds a minimal valid extension', () => {
  const ext = buildArtifactEvidenceExtension({ artifactId: 'a1', runId: 'run-1' });
  assert.deepEqual(ext, {
    schemaVersion: 'artifact-evidence-extension-v1',
    artifactId: 'a1',
    runId: 'run-1',
  });
});

test('buildArtifactEvidenceExtension includes optional fetch metadata with truncation flag', () => {
  const ext = buildArtifactEvidenceExtension({
    artifactId: 'a1',
    runId: 'run-1',
    claimIds: ['claim-1', 'claim-2'],
    fetch: {
      fetchedAt: '2026-09-01T00:00:00.000Z',
      contentLength: 500000,
      bytesStored: 10485760,
      truncated: true,
      fetchCompleted: false,
    },
  });
  assert.deepEqual(ext.claimIds, ['claim-1', 'claim-2']);
  assert.equal(ext.fetch.truncated, true);
  assert.equal(ext.fetch.fetchCompleted, false);
  assert.equal(ext.fetch.bytesStored, 10485760);
});

test('buildArtifactEvidenceExtension includes supersedesArtifactId when provided', () => {
  const ext = buildArtifactEvidenceExtension({ artifactId: 'a2', runId: 'run-2', supersedesArtifactId: 'a1' });
  assert.equal(ext.supersedesArtifactId, 'a1');
});

let passed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    passed++;
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(err.message || err);
  }
}
console.log(`\n${passed}/${tests.length} artifact-evidence-extension unit tests passed`);
if (passed !== tests.length) process.exitCode = 1;
