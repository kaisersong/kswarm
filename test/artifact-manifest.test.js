/**
 * KSwarm — file-first artifact manifest tests
 *
 * Run: node test/artifact-manifest.test.js
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import {
  buildArtifactManifest,
  selectReviewArtifacts,
} from '../src/core/artifact-manifest.js';

function makeWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'kswarm-artifact-manifest-'));
  mkdirSync(join(dir, 'artifacts'), { recursive: true });
  return dir;
}

test('buildArtifactManifest records file hash, relative path, size, and generated time', () => {
  const ws = makeWorkspace();
  const content = '# OpenAI 本月分析\n\n完整报告正文。';
  writeFileSync(join(ws, 'artifacts', 'openai_report.md'), content, 'utf-8');

  const manifest = buildArtifactManifest(ws, ['openai_report.md'], {
    projectId: 'proj-openai',
    taskId: 'item-6',
    role: 'primary',
    producedBy: { agentId: 'xiaok-worker', source: 'worker' },
  });

  assert.equal(manifest.length, 1);
  assert.equal(manifest[0].projectId, 'proj-openai');
  assert.equal(manifest[0].taskId, 'item-6');
  assert.equal(manifest[0].role, 'primary');
  assert.equal(manifest[0].filename, 'openai_report.md');
  assert.equal(manifest[0].relativePath, 'artifacts/openai_report.md');
  assert.equal(manifest[0].path, 'artifacts/openai_report.md');
  assert.equal(manifest[0].size, Buffer.byteLength(content));
  assert.equal(manifest[0].sha256, createHash('sha256').update(content).digest('hex'));
  assert.equal(manifest[0].mimeType, 'text/markdown');
  assert.equal(typeof manifest[0].generatedAt, 'number');
  assert.deepEqual(manifest[0].producedBy, { agentId: 'xiaok-worker', source: 'worker' });
});

test('buildArtifactManifest rejects path traversal and symlink escapes', () => {
  const ws = makeWorkspace();
  const outside = mkdtempSync(join(tmpdir(), 'kswarm-outside-'));
  writeFileSync(join(outside, 'secret.md'), 'secret', 'utf-8');
  symlinkSync(join(outside, 'secret.md'), join(ws, 'artifacts', 'secret-link.md'));

  assert.throws(
    () => buildArtifactManifest(ws, ['../secret.md']),
    /artifact_path_escape/,
  );
  assert.throws(
    () => buildArtifactManifest(ws, ['secret-link.md']),
    /artifact_path_escape/,
  );
});

test('selectReviewArtifacts uses exact submitted manifest files and ignores stale fuzzy matches', () => {
  const selected = selectReviewArtifacts({
    submittedArtifacts: [
      { filename: 'openai_may2026_analysis_v2.md', relativePath: 'artifacts/openai_may2026_analysis_v2.md' },
    ],
    availableArtifacts: [
      { filename: 'proj-1779090338840__item-6-report.md', url: '/projects/proj/artifacts/proj-1779090338840__item-6-report.md' },
      { filename: 'openai_may2026_analysis_v2.md', url: '/projects/proj/artifacts/openai_may2026_analysis_v2.md' },
      { filename: '撰写报告草稿.md', url: '/projects/proj/artifacts/%E6%92%B0%E5%86%99.md' },
    ],
    taskId: 'proj-1779090338840__item-6',
    taskLocalId: 'item-6',
    taskTitle: '撰写报告草稿',
  });

  assert.deepEqual(selected.map(artifact => artifact.filename), ['openai_may2026_analysis_v2.md']);
  assert.equal(selected[0].selectionReason, 'submitted_manifest');
});

test('selectReviewArtifacts only falls back to legacy fuzzy matches without submitted manifests', () => {
  const selected = selectReviewArtifacts({
    submittedArtifacts: [],
    availableArtifacts: [
      { filename: 'proj-1779090338840__item-6-report.md', url: '/projects/proj/artifacts/proj-1779090338840__item-6-report.md' },
      { filename: 'unrelated.md', url: '/projects/proj/artifacts/unrelated.md' },
    ],
    taskId: 'proj-1779090338840__item-6',
    taskLocalId: 'item-6',
    taskTitle: '撰写报告草稿',
  });

  assert.equal(existsSync(join(tmpdir(), 'not-used')), false);
  assert.deepEqual(selected.map(artifact => artifact.filename), ['proj-1779090338840__item-6-report.md']);
  assert.equal(selected[0].selectionReason, 'legacy_filename_match');
  assert.equal(selected[0].source, 'imported_legacy');
});
