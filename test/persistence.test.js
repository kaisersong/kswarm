/**
 * KSwarm — durable persistence tests (P0)
 *
 * Task 1: JSON durable backend
 *   - synchronous save/saveSync (no debounce), immediately readable
 *   - unique temp file (no fixed <path>.tmp collision)
 *   - rename failure preserves old file, cleans temp, propagates error
 *   - write error propagation
 *   - load: ENOENT -> null, corrupt -> throws
 *
 * Task 2: SQLite entity backend (appended below)
 * Task 3: Legacy JSON migration (appended below)
 *
 * Run: node test/persistence.test.js
 */

import assert from 'node:assert/strict';
import * as realFs from 'node:fs';
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createPersistence } from '../src/core/persistence.js';
import {
  createSqlitePersistence,
  PersistenceLoadError,
  PersistenceCommitError,
} from '../src/core/sqlite-persistence.js';
import { DatabaseSync } from 'node:sqlite';
import {
  sha256Hex,
  serializeValue,
  decomposeState,
  composeEntities,
} from '../src/core/state-scope.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function tempDir(label = 'persist') {
  return mkdtempSync(join(tmpdir(), `kswarm-${label}-`));
}

function passthroughFs(overrides = {}) {
  return {
    openSync: realFs.openSync,
    writeSync: realFs.writeSync,
    fsyncSync: realFs.fsyncSync,
    closeSync: realFs.closeSync,
    renameSync: realFs.renameSync,
    rmSync: realFs.rmSync,
    readFileSync: realFs.readFileSync,
    writeFileSync: realFs.writeFileSync,
    mkdirSync: realFs.mkdirSync,
    readdirSync: realFs.readdirSync,
    existsSync: realFs.existsSync,
    ...overrides,
  };
}

// ── Task 1: JSON backend ─────────────────────────────────────────────────

test('json: save is synchronous and immediately readable (no debounce)', () => {
  const dir = tempDir('json-sync');
  try {
    const filePath = join(dir, 'state.json');
    const p = createPersistence(filePath); // string -> json backend
    p.save(() => ({ projects: [{ id: 'p1' }] }));
    const raw = readFileSync(filePath, 'utf-8');
    assert.deepEqual(JSON.parse(raw), { projects: [{ id: 'p1' }] });
    p.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('json: explicit backend selection via options object', () => {
  const dir = tempDir('json-opt');
  try {
    const filePath = join(dir, 'state.json');
    const p = createPersistence({ backend: 'json', filePath });
    p.saveSync(() => ({ a: 1 }));
    assert.deepEqual(JSON.parse(readFileSync(filePath, 'utf-8')), { a: 1 });
    p.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('json: object options without backend throws (backend must be explicit)', () => {
  assert.throws(() => createPersistence({ filePath: '/tmp/x.json' }), /backend/i);
});

test('json: no leftover fixed .tmp file after save (unique temp)', () => {
  const dir = tempDir('json-tmp');
  try {
    const filePath = join(dir, 'state.json');
    const p = createPersistence(filePath);
    p.save(() => ({ v: 1 }));
    p.save(() => ({ v: 2 }));
    const leftovers = readdirSync(dir).filter(f => f.endsWith('.tmp'));
    assert.equal(leftovers.length, 0, `expected no leftover tmp files, got ${leftovers.join(',')}`);
    // fixed <path>.tmp must never be the temp name
    assert.equal(existsSync(`${filePath}.tmp`), false);
    p.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('json: two instances do not share a fixed temp file name', () => {
  const dir = tempDir('json-2inst');
  try {
    const seen = new Set();
    const fs = passthroughFs({
      renameSync: (from, to) => {
        assert.ok(!seen.has(from), `temp name reused across writes: ${from}`);
        seen.add(from);
        return realFs.renameSync(from, to);
      },
    });
    const a = createPersistence({ backend: 'json', filePath: join(dir, 'a.json'), fs });
    const b = createPersistence({ backend: 'json', filePath: join(dir, 'b.json'), fs });
    a.save(() => ({ n: 'a' }));
    b.save(() => ({ n: 'b' }));
    a.save(() => ({ n: 'a2' }));
    a.close(); b.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('json: rename failure preserves old file, cleans temp, propagates error', () => {
  const dir = tempDir('json-rename-fail');
  try {
    const filePath = join(dir, 'state.json');
    writeFileSync(filePath, JSON.stringify({ old: true }));
    const fs = passthroughFs({
      renameSync: () => { const e = new Error('EXDEV rename failed'); throw e; },
    });
    const p = createPersistence({ backend: 'json', filePath, fs });
    assert.throws(() => p.save(() => ({ new: true })), /rename failed/);
    // old file intact
    assert.deepEqual(JSON.parse(readFileSync(filePath, 'utf-8')), { old: true });
    // temp cleaned up
    const leftovers = readdirSync(dir).filter(f => f.endsWith('.tmp'));
    assert.equal(leftovers.length, 0, `temp not cleaned: ${leftovers.join(',')}`);
    p.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('json: write error propagates (not swallowed)', () => {
  const dir = tempDir('json-write-fail');
  try {
    const filePath = join(dir, 'state.json');
    const fs = passthroughFs({
      writeSync: () => { throw new Error('ENOSPC no space'); },
    });
    const p = createPersistence({ backend: 'json', filePath, fs });
    assert.throws(() => p.save(() => ({ x: 1 })), /ENOSPC/);
    p.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('json: load returns null on ENOENT and throws on corrupt', () => {
  const dir = tempDir('json-load');
  try {
    const filePath = join(dir, 'state.json');
    const p = createPersistence(filePath);
    assert.equal(p.load(), null);
    writeFileSync(filePath, '{ not valid json');
    assert.throws(() => p.load(), /JSON|Unexpected|token/i);
    p.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── Task 2/3 helpers ─────────────────────────────────────────────────────

function scopedPayload(fullState, scope, newHumanActions = []) {
  const all = decomposeState(fullState);
  let entities;
  if (scope.type === 'full') {
    entities = all.filter(e => e.collection !== 'humanAction');
  } else {
    entities = all.filter(e => e.collection !== 'humanAction' && e.projectId === scope.projectId);
  }
  const humanActions = newHumanActions.map((a, i) => ({
    collection: 'humanAction',
    key: a.id || `ha-${i}`,
    projectId: a.projectId ?? null,
    value: { ...a, id: a.id || `ha-${i}`, seq: typeof a.seq === 'number' ? a.seq : i },
  }));
  return { entities, humanActions, scope };
}

function fullScope() { return { type: 'full' }; }
function projScope(id) { return { type: 'project', projectId: id }; }

// ── Task 2: SQLite entity backend ────────────────────────────────────────

test('sqlite: scoped save persists across immediate reopen; revision strictly +1', () => {
  const dir = tempDir('sql-basic');
  try {
    const filePath = join(dir, 'state.sqlite');
    const p = createSqlitePersistence({ filePath });
    assert.equal(p.load(), null); // fresh
    assert.equal(p.getHealth().revision, 0);

    const state = {
      projects: [{ id: 'p1', name: 'Alpha' }, { id: 'p2', name: 'Beta' }],
      boards: [{ projectId: 'p1', tasks: [{ id: 't1', status: 'pending' }] }],
      workflowRuns: [{ id: 'wf1', projectId: 'p1', status: 'running' }],
    };
    p.save(() => scopedPayload(state, projScope('p1')), projScope('p1'));
    assert.equal(p.getHealth().revision, 1);
    p.save(() => scopedPayload(state, projScope('p2')), projScope('p2'));
    assert.equal(p.getHealth().revision, 2);
    p.close();

    const p2 = createSqlitePersistence({ filePath });
    const restored = p2.load();
    assert.equal(p2.getHealth().revision, 2);
    assert.equal(restored.projects.length, 2);
    assert.deepEqual(restored.workflowRuns.find(r => r.id === 'wf1').status, 'running');
    p2.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('sqlite: scoped delete removes entities absent from the new scoped set', () => {
  const dir = tempDir('sql-del');
  try {
    const filePath = join(dir, 'state.sqlite');
    const p = createSqlitePersistence({ filePath });
    p.load();
    const s1 = { projects: [{ id: 'p1' }], workflowRuns: [{ id: 'r1', projectId: 'p1' }, { id: 'r2', projectId: 'p1' }] };
    p.save(() => scopedPayload(s1, projScope('p1')), projScope('p1'));
    // now r2 removed from p1
    const s2 = { projects: [{ id: 'p1' }], workflowRuns: [{ id: 'r1', projectId: 'p1' }] };
    p.save(() => scopedPayload(s2, projScope('p1')), projScope('p1'));
    p.close();
    const p2 = createSqlitePersistence({ filePath });
    const restored = p2.load();
    assert.deepEqual(restored.workflowRuns.map(r => r.id).sort(), ['r1']);
    p2.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('sqlite: unchanged entity is not rewritten (checksum skip)', () => {
  const dir = tempDir('sql-skip');
  try {
    const filePath = join(dir, 'state.sqlite');
    const p = createSqlitePersistence({ filePath });
    p.load();
    const state = { projects: [{ id: 'p1', name: 'X' }] };
    p.save(() => scopedPayload(state, projScope('p1')), projScope('p1'));
    p.save(() => scopedPayload(state, projScope('p1')), projScope('p1')); // identical
    p.close();
    // history should be empty (no overwrite happened)
    const raw = new DatabaseSync(filePath);
    const hist = raw.prepare('SELECT COUNT(*) AS n FROM state_entity_history').get();
    assert.equal(Number(hist.n), 0);
    raw.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('sqlite: single-entity checksum tamper recovers from history', () => {
  const dir = tempDir('sql-recover');
  try {
    const filePath = join(dir, 'state.sqlite');
    const p = createSqlitePersistence({ filePath });
    p.load();
    p.save(() => scopedPayload({ projects: [{ id: 'p1', name: 'v1' }] }, projScope('p1')), projScope('p1'));
    p.save(() => scopedPayload({ projects: [{ id: 'p1', name: 'v2' }] }, projScope('p1')), projScope('p1'));
    p.close();

    // Tamper current (v2) row: corrupt state_json but keep old checksum -> mismatch.
    const raw = new DatabaseSync(filePath);
    raw.prepare("UPDATE state_entities SET state_json = ? WHERE collection='project' AND entity_key='p1'")
      .run(JSON.stringify({ id: 'p1', name: 'CORRUPTED' }));
    raw.close();

    const p2 = createSqlitePersistence({ filePath });
    const restored = p2.load();
    // recovered from history -> latest valid version is v1
    assert.equal(restored.projects[0].name, 'v1');
    p2.close();
    // sidecar diagnostic written
    const sidecars = readdirSync(dir).filter(f => f.includes('.corrupt-'));
    assert.ok(sidecars.length >= 1, 'expected a recovery diagnostic sidecar');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('sqlite: unrecoverable corruption throws PersistenceLoadError (exit 78) + sidecar, no empty start', () => {
  const dir = tempDir('sql-unrecover');
  try {
    const filePath = join(dir, 'state.sqlite');
    const p = createSqlitePersistence({ filePath });
    p.load();
    p.save(() => scopedPayload({ projects: [{ id: 'p1', name: 'v1' }] }, projScope('p1')), projScope('p1'));
    p.close();

    const raw = new DatabaseSync(filePath);
    raw.prepare("UPDATE state_entities SET state_json = ? WHERE collection='project' AND entity_key='p1'")
      .run(JSON.stringify({ id: 'p1', name: 'CORRUPTED' }));
    raw.exec('DELETE FROM state_entity_history'); // no recovery source
    raw.close();

    const p2 = createSqlitePersistence({ filePath });
    let thrown;
    try { p2.load(); } catch (err) { thrown = err; }
    p2.close();
    assert.ok(thrown instanceof PersistenceLoadError, 'expected PersistenceLoadError');
    assert.equal(thrown.exitCode, 78);
    const sidecars = readdirSync(dir).filter(f => f.includes('.corrupt-'));
    assert.ok(sidecars.length >= 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('sqlite: save failure sets failed health, rejects subsequent mutations (exit 75)', () => {
  const dir = tempDir('sql-savefail');
  try {
    const filePath = join(dir, 'state.sqlite');
    let realDb;
    const factory = (path) => { realDb = new DatabaseSync(path); return realDb; };
    const p = createSqlitePersistence({ filePath, sqliteFactory: factory });
    p.load();
    // Force COMMIT to fail on the next save.
    const origExec = realDb.exec.bind(realDb);
    realDb.exec = (sql) => { if (sql === 'COMMIT') throw new Error('disk full'); return origExec(sql); };

    let firstErr;
    try { p.save(() => scopedPayload({ projects: [{ id: 'p1' }] }, projScope('p1')), projScope('p1')); }
    catch (err) { firstErr = err; }
    assert.ok(firstErr instanceof PersistenceCommitError, 'expected PersistenceCommitError');
    assert.equal(firstErr.exitCode, 75);
    assert.equal(p.getHealth().status, 'failed');

    // gate: subsequent save rejected before touching db
    realDb.exec = origExec; // even if commit would work now, gate must reject
    let secondErr;
    try { p.save(() => scopedPayload({ projects: [{ id: 'p2' }] }, projScope('p2')), projScope('p2')); }
    catch (err) { secondErr = err; }
    assert.ok(secondErr instanceof PersistenceCommitError, 'subsequent mutation must be gated');
    p.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('sqlite: single-writer lock rejects live writers and only reclaims dead owners', () => {
  const dir = tempDir('sql-lock');
  try {
    const filePath = join(dir, 'state.sqlite');
    const lockPath = `${filePath}.lock`;
    realFs.mkdirSync(dir, { recursive: true });
    // Foreign live writer holds the lock.
    realFs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, token: 'foreign', createdAt: Date.now() }));

    const live = createSqlitePersistence({ filePath, isProcessAlive: () => true });
    assert.throws(() => live.load(), (e) => e instanceof PersistenceLoadError);

    // Dead pid -> reclaim.
    const dead = createSqlitePersistence({ filePath, isProcessAlive: () => false });
    assert.doesNotThrow(() => dead.load());
    dead.close();

    // Age alone must never allow a live writer to be pre-empted.
    realFs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, token: 'foreign', createdAt: Date.now() - 120_000 }));
    const stale = createSqlitePersistence({ filePath, isProcessAlive: () => true });
    assert.throws(() => stale.load(), (e) => e instanceof PersistenceLoadError);
    stale.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('sqlite: single-writer claim uses exclusive atomic file creation', () => {
  const dir = tempDir('sql-lock-atomic');
  try {
    const filePath = join(dir, 'state.sqlite');
    const lockPath = `${filePath}.lock`;
    let sawExclusiveClaim = false;
    const fs = passthroughFs({
      openSync: (path, flags, mode) => {
        if (path === lockPath) {
          assert.equal(flags, 'wx');
          sawExclusiveClaim = true;
        }
        return realFs.openSync(path, flags, mode);
      },
    });

    const persistence = createSqlitePersistence({ filePath, fs });
    persistence.load();
    persistence.close();

    assert.equal(sawExclusiveClaim, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('sqlite: append-only humanActions, same-ms actions do not collide', () => {
  const dir = tempDir('sql-human');
  try {
    const filePath = join(dir, 'state.sqlite');
    const p = createSqlitePersistence({ filePath });
    p.load();
    const ts = new Date().toISOString();
    const a1 = { id: 'a1', action: 'create_project', projectId: 'p1', ts, seq: 0 };
    const a2 = { id: 'a2', action: 'approve_plan', projectId: 'p1', ts, seq: 1 };
    p.save(() => ({ entities: [{ collection: 'project', key: 'p1', projectId: 'p1', value: { id: 'p1' } }], humanActions: [
      { collection: 'humanAction', key: 'a1', projectId: 'p1', value: a1 },
      { collection: 'humanAction', key: 'a2', projectId: 'p1', value: a2 },
    ], scope: projScope('p1') }), projScope('p1'));
    // Append a third; existing two must not be rewritten.
    const a3 = { id: 'a3', action: 'close_project', projectId: 'p1', ts, seq: 2 };
    p.save(() => ({ entities: [{ collection: 'project', key: 'p1', projectId: 'p1', value: { id: 'p1' } }], humanActions: [
      { collection: 'humanAction', key: 'a3', projectId: 'p1', value: a3 },
    ], scope: projScope('p1') }), projScope('p1'));
    p.close();

    const p2 = createSqlitePersistence({ filePath });
    const restored = p2.load();
    assert.deepEqual(restored.humanActions.map(a => a.id), ['a1', 'a2', 'a3']);
    p2.close();
    // no history rows for humanAction (append-only, never overwritten)
    const raw = new DatabaseSync(filePath);
    const hist = raw.prepare("SELECT COUNT(*) AS n FROM state_entity_history WHERE collection='humanAction'").get();
    assert.equal(Number(hist.n), 0);
    raw.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── Task 3: Legacy JSON migration ────────────────────────────────────────

test('migration: legacy state.json migrated once, backed up, idempotent on restart', () => {
  const dir = tempDir('mig-ok');
  try {
    const legacy = join(dir, 'state.json');
    const filePath = join(dir, 'state.sqlite');
    const legacyState = {
      projects: [{ id: 'p1', name: 'Legacy' }],
      boards: [{ projectId: 'p1', tasks: [{ id: 't1' }] }],
      humanActions: [{ action: 'create_project', projectId: 'p1', ts: '2026-01-01T00:00:00.000Z' }],
    };
    writeFileSync(legacy, JSON.stringify(legacyState));

    const p = createSqlitePersistence({ filePath, legacyJsonPath: legacy });
    const restored = p.load();
    assert.equal(restored.projects[0].name, 'Legacy');
    assert.equal(restored.humanActions.length, 1);
    assert.ok(restored.humanActions[0].id, 'migrated humanAction must gain a stable id');
    p.close();

    // backup created; original renamed away
    assert.equal(existsSync(legacy), false, 'legacy file should be renamed to backup');
    const backups = readdirSync(dir).filter(f => f.startsWith('state.json.migrated-'));
    assert.equal(backups.length, 1);

    // Restart: marker present -> no re-migration, data intact.
    const p2 = createSqlitePersistence({ filePath, legacyJsonPath: legacy });
    const restored2 = p2.load();
    assert.equal(restored2.projects[0].name, 'Legacy');
    p2.close();
    // still exactly one backup (idempotent)
    assert.equal(readdirSync(dir).filter(f => f.startsWith('state.json.migrated-')).length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('migration: corrupt legacy JSON refuses to start, preserves JSON, no backup', () => {
  const dir = tempDir('mig-corrupt');
  try {
    const legacy = join(dir, 'state.json');
    const filePath = join(dir, 'state.sqlite');
    writeFileSync(legacy, '{ this is not json');
    const p = createSqlitePersistence({ filePath, legacyJsonPath: legacy });
    assert.throws(() => p.load(), (e) => e instanceof PersistenceLoadError && e.exitCode === 78);
    p.close();
    assert.ok(existsSync(legacy), 'corrupt legacy JSON must be preserved');
    assert.equal(readdirSync(dir).filter(f => f.startsWith('state.json.migrated-')).length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('migration: entities present without marker refuses to start', () => {
  const dir = tempDir('mig-nomarker');
  try {
    const filePath = join(dir, 'state.sqlite');
    // Manually create a db with an entity but no migration marker.
    const raw = new DatabaseSync(filePath);
    raw.exec(`CREATE TABLE state_entities (collection TEXT NOT NULL, entity_key TEXT NOT NULL, project_id TEXT, state_json TEXT NOT NULL, checksum TEXT NOT NULL, revision INTEGER NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (collection, entity_key));`);
    const sj = JSON.stringify({ id: 'p1' });
    raw.prepare('INSERT INTO state_entities VALUES (?,?,?,?,?,?,?)').run('project', 'p1', 'p1', sj, sha256Hex(sj), 1, '2026-01-01');
    raw.close();

    const p = createSqlitePersistence({ filePath });
    assert.throws(() => p.load(), (e) => e instanceof PersistenceLoadError);
    p.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('migration: transaction failure rolls back, preserves JSON, no marker, no empty start', () => {
  const dir = tempDir('mig-txfail');
  try {
    const legacy = join(dir, 'state.json');
    const filePath = join(dir, 'state.sqlite');
    writeFileSync(legacy, JSON.stringify({ projects: [{ id: 'p1', name: 'Legacy' }] }));

    let realDb;
    const factory = (path) => {
      realDb = new DatabaseSync(path);
      const origExec = realDb.exec.bind(realDb);
      realDb.exec = (sql) => { if (sql === 'COMMIT') throw new Error('migration commit blew up'); return origExec(sql); };
      return realDb;
    };
    const p = createSqlitePersistence({ filePath, legacyJsonPath: legacy, sqliteFactory: factory });
    assert.throws(() => p.load(), (e) => e instanceof PersistenceLoadError);
    p.close();
    assert.ok(existsSync(legacy), 'legacy JSON preserved on migration failure');
    assert.equal(readdirSync(dir).filter(f => f.startsWith('state.json.migrated-')).length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('migration: backup rename failure keeps data durable and does not throw', () => {
  const dir = tempDir('mig-renamefail');
  try {
    const legacy = join(dir, 'state.json');
    const filePath = join(dir, 'state.sqlite');
    writeFileSync(legacy, JSON.stringify({ projects: [{ id: 'p1', name: 'Legacy' }] }));
    const fs = passthroughFs({ renameSync: () => { throw new Error('rename blocked'); } });
    const p = createSqlitePersistence({ filePath, legacyJsonPath: legacy, fs });
    const restored = p.load();
    assert.equal(restored.projects[0].name, 'Legacy'); // migrated durably
    p.close();
    assert.ok(existsSync(legacy), 'original JSON preserved when backup rename fails');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── state-scope unit coverage ────────────────────────────────────────────

test('state-scope: decompose/compose round-trips full state', () => {
  const state = {
    projects: [{ id: 'p1' }, { id: 'p2' }],
    boards: [{ projectId: 'p1', tasks: [{ id: 't1' }] }],
    workflowRuns: [{ id: 'r1', projectId: 'p1' }],
    workflowProposals: [{ id: 'prop1', projectId: 'p2' }],
    finalDeliverables: [{ deliverableId: 'd1', projectId: 'p1' }],
    reviewGateDecisions: [{ gateId: 'g1', projectId: 'p2' }],
    humanActions: [{ id: 'a1', action: 'x', projectId: 'p1', seq: 0, ts: '2026' }],
  };
  const composed = composeEntities(decomposeState(state));
  assert.deepEqual(composed.projects.map(p => p.id).sort(), ['p1', 'p2']);
  assert.equal(composed.workflowProposals[0].id, 'prop1');
  assert.equal(composed.finalDeliverables[0].deliverableId, 'd1');
  assert.equal(composed.reviewGateDecisions[0].gateId, 'g1');
  assert.equal(composed.humanActions[0].id, 'a1');
});

// ── shared runner (Task 2/3 appended in separate files) ──
export async function run() {
  let pass = 0, fail = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      pass++;
      console.log(`  \u2713 ${name}`);
    } catch (err) {
      fail++;
      console.error(`  \u2717 ${name}`);
      console.error(`    ${err.stack || err.message}`);
    }
  }
  console.log(`\n[persistence] ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

run();
