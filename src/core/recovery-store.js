/**
 * Filesystem helpers for restart recovery.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
export { buildArtifactManifest } from './artifact-manifest.js';

function assertSafeSegment(value, label) {
  if (!value || value !== basename(value) || value.includes('..') || value.includes('/')) {
    throw new Error(`invalid_${label}: ${value}`);
  }
}

function runsDir(projectWorkspace) {
  return join(projectWorkspace, '.kswarm', 'runs');
}

export function getRunJournalPath(projectWorkspace, runId) {
  assertSafeSegment(runId, 'run_id');
  return join(runsDir(projectWorkspace), `${runId}.json`);
}

export function writeRunJournal(projectWorkspace, journal) {
  const runId = journal?.runId;
  assertSafeSegment(runId, 'run_id');
  const dir = runsDir(projectWorkspace);
  mkdirSync(dir, { recursive: true });
  const path = getRunJournalPath(projectWorkspace, runId);
  const now = Date.now();
  const payload = {
    schemaVersion: 1,
    ...journal,
    updatedAt: now,
  };
  const tmp = `${path}.${process.pid}.${now}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf-8');
  renameSync(tmp, path);
  return path;
}

export function readRunJournals(projectWorkspace) {
  const dir = runsDir(projectWorkspace);
  if (!existsSync(dir)) return [];
  const journals = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(dir, file), 'utf-8'));
      if (parsed && parsed.schemaVersion === 1) journals.push(parsed);
    } catch {
      // Malformed journals should not block startup recovery.
    }
  }
  return journals;
}

