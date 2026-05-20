/**
 * KSwarm — Worker journal tests
 *
 * Run: node test/worker-journal.test.js
 */

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildArtifactManifest,
  getRunJournalPath,
  readRunJournals,
  writeRunJournal,
} from '../src/core/recovery-store.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function makeWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'kswarm-journal-'));
  mkdirSync(join(dir, 'artifacts'), { recursive: true });
  return dir;
}

test('writeRunJournal writes a readable schema-versioned journal atomically', () => {
  const ws = makeWorkspace();
  const journal = {
    schemaVersion: 1,
    projectId: 'proj-journal',
    taskId: 'proj-journal__item-1',
    localTaskId: 'item-1',
    runId: 'run-journal-1',
    agentId: 'worker',
    status: 'artifact_written',
    artifactManifest: [{ filename: 'result.md', path: 'artifacts/result.md', mimeType: 'text/markdown', size: 12 }],
  };

  const path = writeRunJournal(ws, journal);
  assert.equal(path, getRunJournalPath(ws, 'run-journal-1'));

  const journals = readRunJournals(ws);
  assert.equal(journals.length, 1);
  assert.equal(journals[0].runId, 'run-journal-1');
  assert.equal(journals[0].status, 'artifact_written');
  assert.equal(typeof journals[0].updatedAt, 'number');
});

test('readRunJournals skips malformed json instead of throwing', () => {
  const ws = makeWorkspace();
  const path = getRunJournalPath(ws, 'bad-run');
  mkdirSync(join(ws, '.kswarm', 'runs'), { recursive: true });
  writeFileSync(path, '{not json', 'utf-8');

  assert.deepEqual(readRunJournals(ws), []);
});

test('buildArtifactManifest returns relative artifact paths with file sizes', () => {
  const ws = makeWorkspace();
  writeFileSync(join(ws, 'artifacts', 'result.md'), 'hello recovery', 'utf-8');

  const manifest = buildArtifactManifest(ws, ['result.md']);
  assert.equal(manifest.length, 1);
  assert.equal(manifest[0].filename, 'result.md');
  assert.equal(manifest[0].path, 'artifacts/result.md');
  assert.equal(manifest[0].relativePath, 'artifacts/result.md');
  assert.equal(manifest[0].mimeType, 'text/markdown');
  assert.equal(manifest[0].size, 14);
  assert.equal(typeof manifest[0].sha256, 'string');
  assert.equal(typeof manifest[0].generatedAt, 'number');
});

test('buildArtifactManifest rejects unsafe artifact filenames', () => {
  const ws = makeWorkspace();
  assert.throws(() => buildArtifactManifest(ws, ['../secret.md']), /artifact_path_escape/);
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
  console.log(`\n${passed}/${tests.length} worker journal tests passed`);
}
