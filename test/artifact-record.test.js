import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  createArtifactRecord,
  enrichArtifactRecordFromFile,
  listArtifactRecords,
} from '../src/server/artifact-record.js';

test('createArtifactRecord includes generated time for uploaded artifacts', () => {
  const now = 1779089297000;
  const record = createArtifactRecord({
    filename: 'report.md',
    url: '/projects/proj-a/artifacts/report.md',
    path: '/tmp/report.md',
    previewable: true,
    mimeType: 'text/markdown',
    generatedAt: now,
  });

  assert.equal(record.filename, 'report.md');
  assert.equal(record.generatedAt, now);
  assert.equal(record.createdAt, now);
  assert.equal(record.updatedAt, now);
});

test('listArtifactRecords includes generated time from file mtime', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kswarm-artifacts-'));
  try {
    const filePath = join(dir, 'report.md');
    writeFileSync(filePath, '# report');
    const expected = statSync(filePath).mtimeMs;

    const records = listArtifactRecords({
      artifactsDir: dir,
      projectId: 'proj-a',
      getPreviewable: () => true,
      mimeTypes: { '.md': 'text/markdown' },
    });

    assert.equal(records.length, 1);
    assert.equal(records[0].filename, 'report.md');
    assert.equal(records[0].generatedAt, expected);
    assert.equal(records[0].updatedAt, expected);
    assert.equal(records[0].mimeType, 'text/markdown');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('enrichArtifactRecordFromFile backfills generated time for legacy task artifacts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kswarm-artifacts-'));
  try {
    const filePath = join(dir, 'legacy.md');
    writeFileSync(filePath, '# legacy');
    const expected = statSync(filePath).mtimeMs;

    const artifact = enrichArtifactRecordFromFile({
      artifact: { filename: 'legacy.md', url: '/projects/proj-a/artifacts/legacy.md' },
      artifactsDir: dir,
      getPreviewable: () => true,
      mimeTypes: { '.md': 'text/markdown' },
    });

    assert.equal(artifact.filename, 'legacy.md');
    assert.equal(artifact.generatedAt, expected);
    assert.equal(artifact.updatedAt, expected);
    assert.equal(artifact.mimeType, 'text/markdown');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// design §3.5：Canonical Artifact Manifest —— "server/artifact-record.js ...
// listArtifactRecords 的非递归读取 ... 都必须改为识别 canonical manifest 的相对
// 嵌套路径；禁止用 basename 再次把 namespaced artifacts 扁平化"。
//
// 现状核实（2026-09-02）：listArtifactRecords 用 readdirSync(artifactsDir) 非递归
// 读取，写入 artifacts/tasks/<task-id>/<run-id>/ 的嵌套证据文件完全不出现在结果里。
test('listArtifactRecords 必须递归识别 artifacts/tasks/<task-id>/<run-id>/ 嵌套路径下的证据文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kswarm-artifacts-nested-'));
  try {
    // 顶层文件（既有扁平场景，必须继续可见）
    writeFileSync(join(dir, 'top-level.md'), '# top level');

    // design §3.5 canonical 嵌套路径
    const nestedDir = join(dir, 'tasks', 'item-1', 'run-1');
    mkdirSync(nestedDir, { recursive: true });
    writeFileSync(join(nestedDir, 'review-evidence.json'), '{"schemaVersion":"review-evidence-v2"}');

    const records = listArtifactRecords({
      artifactsDir: dir,
      projectId: 'proj-a',
      getPreviewable: () => true,
      mimeTypes: { '.md': 'text/markdown', '.json': 'application/json' },
    });

    const filenames = records.map(r => r.filename);
    assert.ok(filenames.includes('top-level.md'), '顶层扁平文件必须继续可见，不能因为本次改动破坏现有行为');
    assert.ok(
      filenames.some(f => f.includes('review-evidence.json')),
      'nested task/run 路径下的证据文件必须出现在 listArtifactRecords 结果中，不能因为非递归读取而不可见',
    );

    const nestedRecord = records.find(r => r.filename.includes('review-evidence.json'));
    assert.ok(
      nestedRecord.path.includes(join('tasks', 'item-1', 'run-1')),
      'nested 证据文件的 record.path 必须保留完整相对嵌套路径，不能被 basename 扁平化（design §3.5 明确禁止）',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
