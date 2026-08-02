/**
 * KSwarm — durable persistence performance gate (P0 acceptance).
 *
 * Builds a ~9MB realistic state, migrates it into SQLite, then measures the
 * end-to-end regular single-project mutation path (scoped materialization + JSON
 * + checksum + SQL commit with synchronous=FULL) and the full-scope path.
 *
 * Thresholds (from the design's real 9MB benchmark):
 *   - regular single-project mutation p95 < 5ms
 *   - full-scope mutation p95 < 30ms (suspend/resume/recovery only)
 *
 * Run: node test/persistence-performance.test.js
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createSqlitePersistence } from '../src/core/sqlite-persistence.js';
import { decomposeState } from '../src/core/state-scope.js';

function pctl(sorted, p) {
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function buildLargeState({ projects, tasksPerProject, blobBytes }) {
  const blob = 'x'.repeat(blobBytes);
  const state = { projects: [], boards: [], workflowRuns: [], workflowProposals: [], finalDeliverables: [], reviewGateDecisions: [], humanActions: [] };
  for (let i = 0; i < projects; i++) {
    const id = `p-${i}`;
    state.projects.push({ id, name: `Project ${i}`, status: 'active', goal: 'g', poAgent: 'po-1', members: ['w1', 'w2'] });
    const tasks = [];
    for (let t = 0; t < tasksPerProject; t++) {
      tasks.push({ id: `${id}-t${t}`, status: 'done', title: `task ${t}`, result: { summary: `result ${t}`, notes: blob } });
    }
    state.boards.push({ projectId: id, tasks });
    state.workflowRuns.push({ id: `wf-${id}`, projectId: id, status: 'completed', nodes: [] });
  }
  return state;
}

function scopedPayload(state, decomposed, projectId) {
  const entities = decomposed.filter(e => e.collection !== 'humanAction' && e.projectId === projectId);
  return { entities, humanActions: [], scope: { type: 'project', projectId } };
}
function fullPayload(decomposed) {
  const entities = decomposed.filter(e => e.collection !== 'humanAction');
  return { entities, humanActions: [], scope: { type: 'full' } };
}

const dir = mkdtempSync(join(tmpdir(), 'kswarm-perf-'));
let failed = 0;
try {
  const legacy = join(dir, 'state.json');
  const filePath = join(dir, 'state.sqlite');

  // ~9MB: 60 projects x 75 tasks x ~2KB blob.
  const state = buildLargeState({ projects: 60, tasksPerProject: 75, blobBytes: 1900 });
  writeFileSync(legacy, JSON.stringify(state));
  const sizeMB = (statSync(legacy).size / (1024 * 1024)).toFixed(2);

  const p = createSqlitePersistence({ filePath, legacyJsonPath: legacy });
  p.load(); // migrates all entities in one transaction
  console.log(`  legacy state size: ${sizeMB} MB; migrated revision=${p.getHealth().revision}`);

  const decomposed = decomposeState(state);

  // Warm up.
  for (let i = 0; i < 20; i++) {
    p.save(() => scopedPayload(state, decomposed, `p-${i % 60}`), { type: 'project', projectId: `p-${i % 60}` });
  }

  // ── Regular single-project mutation path ──
  const scopedTimings = [];
  for (let i = 0; i < 500; i++) {
    const pid = `p-${i % 60}`;
    // mutate one field so the project entity actually changes each iteration
    state.projects[i % 60].updatedAt = Date.now() + i;
    const fresh = decomposeState({ ...state, boards: state.boards, projects: state.projects });
    const t0 = performance.now();
    p.save(() => scopedPayload(state, fresh, pid), { type: 'project', projectId: pid });
    scopedTimings.push(performance.now() - t0);
  }
  scopedTimings.sort((a, b) => a - b);
  const scopedP50 = pctl(scopedTimings, 50);
  const scopedP95 = pctl(scopedTimings, 95);
  console.log(`  scoped single-project mutation: p50=${scopedP50.toFixed(3)}ms p95=${scopedP95.toFixed(3)}ms`);

  // ── Full-scope mutation path ──
  const fullTimings = [];
  for (let i = 0; i < 60; i++) {
    state.projects[i % 60].updatedAt = Date.now() + 100000 + i;
    const fresh = decomposeState(state);
    const t0 = performance.now();
    p.save(() => fullPayload(fresh), { type: 'full' });
    fullTimings.push(performance.now() - t0);
  }
  fullTimings.sort((a, b) => a - b);
  const fullP50 = pctl(fullTimings, 50);
  const fullP95 = pctl(fullTimings, 95);
  console.log(`  full-scope mutation:            p50=${fullP50.toFixed(3)}ms p95=${fullP95.toFixed(3)}ms`);

  p.close();

  try {
    assert.ok(scopedP95 < 5, `scoped p95 ${scopedP95.toFixed(3)}ms must be < 5ms`);
    console.log('  \u2713 scoped p95 < 5ms');
  } catch (e) { failed++; console.error(`  \u2717 ${e.message}`); }
  try {
    assert.ok(fullP95 < 30, `full-scope p95 ${fullP95.toFixed(3)}ms must be < 30ms`);
    console.log('  \u2713 full-scope p95 < 30ms');
  } catch (e) { failed++; console.error(`  \u2717 ${e.message}`); }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\n[persistence-performance] ${failed === 0 ? 'PASS' : 'FAIL'}`);
if (failed > 0) process.exit(1);
