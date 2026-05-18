import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs';
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
