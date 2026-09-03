/**
 * sqlite-persistence — durable per-entity state store backed by node:sqlite.
 *
 * Design contract (KSwarm Durable State P0):
 *  - Every successful save() is a synchronous durable commit (WAL + synchronous=FULL).
 *  - State is stored per-entity (project/board/workflowRun/... /humanAction) so a
 *    single-project mutation only re-syncs that project's rows, not the whole ~9MB.
 *  - Each save runs in one BEGIN IMMEDIATE transaction: history the rows it will
 *    overwrite/delete, upsert the scoped set, append new humanActions, bump the
 *    monotonic global revision by exactly 1, then COMMIT.
 *  - load() runs integrity_check + per-entity checksum verification; a single
 *    corrupt entity is recovered from history, otherwise it is unrecoverable.
 *  - Failures throw (never warn-and-continue): load/migration -> exit 78 (terminal
 *    degraded), save -> exit 75 (fail-stop, limited restart).
 *  - Single-writer guarantee via an atomically-created exclusive lockfile
 *    (pid/token/createdAt) that is only reclaimed when the owning pid is gone.
 */

import { DatabaseSync } from 'node:sqlite';
import * as nodeFs from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  sha256Hex,
  serializeValue,
  decomposeState,
  composeEntities,
  DELETABLE_COLLECTIONS,
} from './state-scope.js';

export const EXIT_LOAD_UNRECOVERABLE = 78; // terminal degraded, do not auto-restart
export const EXIT_SAVE_FAILED = 75; // fail-stop, limited restart from last revision

export class PersistenceLoadError extends Error {
  constructor(message, { cause } = {}) {
    super(message);
    this.name = 'PersistenceLoadError';
    this.exitCode = EXIT_LOAD_UNRECOVERABLE;
    this.recoverable = false;
    if (cause) this.cause = cause;
  }
}

export class PersistenceCommitError extends Error {
  constructor(message, { cause } = {}) {
    super(message);
    this.name = 'PersistenceCommitError';
    this.exitCode = EXIT_SAVE_FAILED;
    if (cause) this.cause = cause;
  }
}

export function isPersistenceCommitError(err) {
  return !!err && (err.name === 'PersistenceCommitError' || err instanceof PersistenceCommitError);
}
export function isPersistenceLoadError(err) {
  return !!err && (err.name === 'PersistenceLoadError' || err instanceof PersistenceLoadError);
}

const HISTORY_VERSIONS_KEPT = 2;

function defaultFs() {
  return {
    openSync: nodeFs.openSync,
    writeSync: nodeFs.writeSync,
    fsyncSync: nodeFs.fsyncSync,
    closeSync: nodeFs.closeSync,
    existsSync: nodeFs.existsSync,
    readFileSync: nodeFs.readFileSync,
    writeFileSync: nodeFs.writeFileSync,
    renameSync: nodeFs.renameSync,
    rmSync: nodeFs.rmSync,
    mkdirSync: nodeFs.mkdirSync,
  };
}

function defaultIsProcessAlive(pid) {
  if (!pid || pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM'; // exists but not permitted -> alive
  }
}

export function createSqlitePersistence(options = {}) {
  const {
    filePath,
    legacyJsonPath = null,
    sqliteFactory = (path) => new DatabaseSync(path),
    fs: injectedFs,
    now = () => Date.now(),
    isProcessAlive = defaultIsProcessAlive,
    silent = true,
  } = options;

  if (!filePath) throw new Error('[sqlite-persistence] filePath is required');
  const fs = injectedFs || defaultFs();
  const lockPath = `${filePath}.lock`;
  const lockToken = randomUUID();

  fs.mkdirSync(dirname(filePath), { recursive: true });

  let db = null;
  let status = 'ok'; // ok | failed
  let globalRevision = 0;
  let lockHeld = false;
  // in-memory index: collection -> Map(key -> { checksum, projectId, revision })
  const index = new Map();
  for (const c of ['project', 'board', 'workflowRun', 'workflowProposal', 'finalDeliverable', 'reviewGateDecision', 'reviewCondition', 'humanAction']) {
    index.set(c, new Map());
  }

  function warn(...args) { if (!silent) console.warn('[sqlite-persistence]', ...args); }

  // ── single-writer lock ────────────────────────────────────────────────
  function claimLock() {
    let handle;
    try {
      handle = fs.openSync(lockPath, 'wx', 0o600);
    } catch (err) {
      if (err && err.code === 'EEXIST') return false;
      throw err;
    }
    try {
      fs.writeSync(handle, JSON.stringify({ pid: process.pid, token: lockToken, createdAt: now() }));
      fs.fsyncSync(handle);
    } catch (err) {
      try { fs.closeSync(handle); } catch { /* ignore */ }
      try { fs.rmSync(lockPath, { force: true }); } catch { /* ignore */ }
      throw err;
    }
    fs.closeSync(handle);
    lockHeld = true;
    return true;
  }

  function acquireLock() {
    if (claimLock()) return;

    let holder;
    try {
      holder = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
    } catch (err) {
      throw new PersistenceLoadError(
        `[sqlite-persistence] state lock is unreadable; refusing unsafe reclamation: ${err.message}`,
        { cause: err },
      );
    }
    if (!holder || typeof holder.pid !== 'number') {
      throw new PersistenceLoadError('[sqlite-persistence] state lock has no valid owner; remove it after verifying no writer is running');
    }

    const age = now() - (holder.createdAt || 0);
    if (isProcessAlive(holder.pid)) {
      throw new PersistenceLoadError(
        `[sqlite-persistence] state locked by live writer pid=${holder.pid} (age=${age}ms)`,
      );
    }

    try { fs.rmSync(lockPath, { force: true }); } catch (err) {
      throw new PersistenceLoadError(`[sqlite-persistence] failed to reclaim dead writer lock: ${err.message}`, { cause: err });
    }
    if (!claimLock()) {
      throw new PersistenceLoadError('[sqlite-persistence] another writer claimed the state lock during recovery');
    }
  }

  function releaseLock() {
    if (!lockHeld) return;
    try {
      if (fs.existsSync(lockPath)) {
        const holder = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
        if (holder && holder.token === lockToken) fs.rmSync(lockPath, { force: true });
      }
    } catch { /* best-effort */ }
    lockHeld = false;
  }

  // ── schema ────────────────────────────────────────────────────────────
  function initSchema() {
    db.exec(`
      CREATE TABLE IF NOT EXISTS state_entities (
        collection TEXT NOT NULL,
        entity_key TEXT NOT NULL,
        project_id TEXT,
        state_json TEXT NOT NULL,
        checksum TEXT NOT NULL,
        revision INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (collection, entity_key)
      );
      CREATE INDEX IF NOT EXISTS idx_state_entities_project ON state_entities (project_id);
      CREATE TABLE IF NOT EXISTS state_entity_history (
        collection TEXT NOT NULL,
        entity_key TEXT NOT NULL,
        project_id TEXT,
        state_json TEXT NOT NULL,
        checksum TEXT NOT NULL,
        revision INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_state_history_entity ON state_entity_history (collection, entity_key, revision DESC);
      CREATE TABLE IF NOT EXISTS state_meta (
        meta_key TEXT PRIMARY KEY,
        meta_value TEXT NOT NULL
      );
    `);
  }

  function readMeta(key) {
    const row = db.prepare('SELECT meta_value FROM state_meta WHERE meta_key = ?').get(key);
    return row ? row.meta_value : null;
  }
  function writeMeta(key, value) {
    db.prepare('INSERT INTO state_meta (meta_key, meta_value) VALUES (?, ?) ON CONFLICT(meta_key) DO UPDATE SET meta_value = excluded.meta_value').run(key, value);
  }

  function countEntities() {
    const row = db.prepare('SELECT COUNT(*) AS n FROM state_entities').get();
    return row ? Number(row.n) : 0;
  }

  // ── history helpers ─────────────────────────────────────────────────────
  function pushHistory(row) {
    db.prepare(`INSERT INTO state_entity_history (collection, entity_key, project_id, state_json, checksum, revision, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(row.collection, row.entity_key, row.project_id ?? null, row.state_json, row.checksum, row.revision, row.updated_at);
    // prune to last N versions
    const keep = db.prepare(`SELECT rowid FROM state_entity_history WHERE collection = ? AND entity_key = ? ORDER BY revision DESC, rowid DESC LIMIT ?`)
      .all(row.collection, row.entity_key, HISTORY_VERSIONS_KEPT)
      .map(r => r.rowid);
    if (keep.length > 0) {
      const placeholders = keep.map(() => '?').join(',');
      db.prepare(`DELETE FROM state_entity_history WHERE collection = ? AND entity_key = ? AND rowid NOT IN (${placeholders})`)
        .run(row.collection, row.entity_key, ...keep);
    }
  }

  function currentRow(collection, key) {
    return db.prepare('SELECT collection, entity_key, project_id, state_json, checksum, revision, updated_at FROM state_entities WHERE collection = ? AND entity_key = ?').get(collection, key);
  }

  function upsertRow(collection, key, projectId, stateJson, checksum, revision, updatedAt) {
    db.prepare(`INSERT INTO state_entities (collection, entity_key, project_id, state_json, checksum, revision, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(collection, entity_key) DO UPDATE SET
                  project_id = excluded.project_id,
                  state_json = excluded.state_json,
                  checksum = excluded.checksum,
                  revision = excluded.revision,
                  updated_at = excluded.updated_at`)
      .run(collection, key, projectId ?? null, stateJson, checksum, revision, updatedAt);
    index.get(collection).set(key, { checksum, projectId: projectId ?? null, revision });
  }

  function deleteRow(collection, key) {
    db.prepare('DELETE FROM state_entities WHERE collection = ? AND entity_key = ?').run(collection, key);
    index.get(collection).delete(key);
  }

  // ── migration ─────────────────────────────────────────────────────────
  function runLegacyMigration() {
    // Only called when no migration marker exists AND no entities present.
    if (!legacyJsonPath || !fs.existsSync(legacyJsonPath)) {
      writeMeta('migration', JSON.stringify({ migrated: false, source: 'none', at: new Date(now()).toISOString() }));
      writeMeta('revision', '0');
      globalRevision = 0;
      return;
    }
    let legacyState;
    try {
      legacyState = JSON.parse(fs.readFileSync(legacyJsonPath, 'utf-8'));
    } catch (err) {
      // Corrupt legacy JSON: keep it, do not create backup, do not start empty.
      throw new PersistenceLoadError(`[sqlite-persistence] legacy state.json is corrupt; refusing to start empty: ${err.message}`, { cause: err });
    }
    const entities = decomposeState(legacyState);
    const at = new Date(now()).toISOString();
    // Single transaction: all entities + revision + marker.
    db.exec('BEGIN IMMEDIATE');
    try {
      const migrationRevision = 1;
      for (const e of entities) {
        const stateJson = serializeValue(e.value);
        upsertRow(e.collection, e.key, e.projectId, stateJson, sha256Hex(stateJson), migrationRevision, at);
      }
      writeMeta('revision', String(migrationRevision));
      writeMeta('migration', JSON.stringify({ migrated: true, source: legacyJsonPath, entities: entities.length, at }));
      db.exec('COMMIT');
      globalRevision = migrationRevision;
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* ignore */ }
      // Rebuild index cleanly (partial upserts touched it).
      for (const m of index.values()) m.clear();
      throw new PersistenceLoadError(`[sqlite-persistence] legacy migration failed; original JSON preserved: ${err.message}`, { cause: err });
    }
    // Migration committed & durable. Back up the legacy file (best-effort: data
    // is already safe in SQLite and the marker makes re-migration idempotent).
    const backupPath = `${legacyJsonPath}.migrated-${new Date(now()).toISOString().replace(/[:.]/g, '-')}`;
    try {
      fs.renameSync(legacyJsonPath, backupPath);
    } catch (err) {
      warn(`legacy backup rename failed (migration already durable): ${err.message}`);
    }
  }

  // ── load ────────────────────────────────────────────────────────────────
  function writeSidecar(kind, detail) {
    const sidecarPath = `${filePath}.corrupt-${new Date(now()).toISOString().replace(/[:.]/g, '-')}.json`;
    try {
      fs.writeFileSync(sidecarPath, JSON.stringify({ kind, detail, at: new Date(now()).toISOString() }, null, 2));
    } catch { /* best-effort */ }
    return sidecarPath;
  }

  function verifyAndIndex() {
    const rows = db.prepare('SELECT collection, entity_key, project_id, state_json, checksum, revision FROM state_entities').all();
    const recovered = [];
    for (const row of rows) {
      const actual = sha256Hex(row.state_json);
      if (actual === row.checksum) {
        index.get(row.collection)?.set(row.entity_key, { checksum: row.checksum, projectId: row.project_id ?? null, revision: row.revision });
        continue;
      }
      // Checksum mismatch -> try recover from history (latest valid version).
      const history = db.prepare('SELECT project_id, state_json, checksum, revision, updated_at FROM state_entity_history WHERE collection = ? AND entity_key = ? ORDER BY revision DESC, rowid DESC')
        .all(row.collection, row.entity_key);
      const valid = history.find(h => sha256Hex(h.state_json) === h.checksum);
      if (!valid) {
        const sidecar = writeSidecar('entity_checksum_unrecoverable', { collection: row.collection, entity_key: row.entity_key });
        throw new PersistenceLoadError(`[sqlite-persistence] unrecoverable checksum mismatch for ${row.collection}/${row.entity_key}; diagnostic: ${sidecar}`);
      }
      db.exec('BEGIN IMMEDIATE');
      try {
        upsertRow(row.collection, row.entity_key, valid.project_id, valid.state_json, valid.checksum, valid.revision, valid.updated_at);
        db.exec('COMMIT');
      } catch (err) {
        try { db.exec('ROLLBACK'); } catch { /* ignore */ }
        throw new PersistenceLoadError(`[sqlite-persistence] failed to restore ${row.collection}/${row.entity_key} from history: ${err.message}`, { cause: err });
      }
      recovered.push({ collection: row.collection, entity_key: row.entity_key, restoredRevision: valid.revision });
    }
    if (recovered.length > 0) {
      const sidecar = writeSidecar('entity_checksum_recovered', { recovered });
      warn(`recovered ${recovered.length} entity(ies) from history; diagnostic: ${sidecar}`);
    }
  }

  function readAllEntities() {
    const rows = db.prepare('SELECT collection, entity_key, project_id, state_json FROM state_entities').all();
    return rows.map(r => ({ collection: r.collection, key: r.entity_key, projectId: r.project_id ?? null, value: JSON.parse(r.state_json) }));
  }

  function load() {
    acquireLock();
    try {
      db = sqliteFactory(filePath);
    } catch (err) {
      const sidecar = writeSidecar('db_open_failed', { message: err.message });
      status = 'failed';
      throw new PersistenceLoadError(`[sqlite-persistence] cannot open database: ${err.message}; diagnostic: ${sidecar}`, { cause: err });
    }
    try {
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA synchronous = FULL');
      db.exec('PRAGMA busy_timeout = 5000');
      db.exec('PRAGMA foreign_keys = ON');
      initSchema();

      const integrity = db.prepare('PRAGMA integrity_check').get();
      const integrityValue = integrity ? (integrity.integrity_check || Object.values(integrity)[0]) : 'unknown';
      if (integrityValue !== 'ok') {
        const sidecar = writeSidecar('integrity_check_failed', { integrity: integrityValue });
        throw new PersistenceLoadError(`[sqlite-persistence] integrity_check failed (${integrityValue}); diagnostic: ${sidecar}`);
      }

      const marker = readMeta('migration');
      const entityCount = countEntities();
      if (!marker) {
        if (entityCount > 0) {
          const sidecar = writeSidecar('entities_without_migration_marker', { entityCount });
          throw new PersistenceLoadError(`[sqlite-persistence] found ${entityCount} entities but no migration marker; refusing to start; diagnostic: ${sidecar}`);
        }
        runLegacyMigration();
      } else {
        const rev = readMeta('revision');
        globalRevision = rev ? Number(rev) : 0;
      }

      verifyAndIndex();

      if (countEntities() === 0) return null;
      return composeEntities(readAllEntities());
    } catch (err) {
      status = 'failed';
      if (err instanceof PersistenceLoadError) throw err;
      const sidecar = writeSidecar('load_failed', { message: err.message });
      throw new PersistenceLoadError(`[sqlite-persistence] load failed: ${err.message}; diagnostic: ${sidecar}`, { cause: err });
    }
  }

  // ── save ────────────────────────────────────────────────────────────────
  function assertHealthy() {
    if (status === 'failed') {
      throw new PersistenceCommitError('[sqlite-persistence] persistence is in failed state; mutations rejected');
    }
  }

  function scopedExistingKeys(scope) {
    // Returns Map(collection -> Set(key)) of currently-stored deletable entities in scope.
    const result = new Map();
    for (const c of DELETABLE_COLLECTIONS) {
      const set = new Set();
      const coll = index.get(c);
      for (const [key, meta] of coll) {
        if (scope.type === 'full' || meta.projectId === scope.projectId) set.add(key);
      }
      result.set(c, set);
    }
    return result;
  }

  function save(stateFactory, scope = { type: 'full' }) {
    assertHealthy();
    if (!db) throw new PersistenceCommitError('[sqlite-persistence] database not loaded');
    const payload = typeof stateFactory === 'function' ? stateFactory(scope) : stateFactory;
    const effectiveScope = payload?.scope || scope || { type: 'full' };
    const entities = payload?.entities || [];
    const humanActions = payload?.humanActions || [];
    const at = new Date(now()).toISOString();
    const nextRevision = globalRevision + 1;

    const existing = scopedExistingKeys(effectiveScope);
    const seenByCollection = new Map(DELETABLE_COLLECTIONS.map(c => [c, new Set()]));

    db.exec('BEGIN IMMEDIATE');
    try {
      // Upsert scoped deletable entities.
      for (const e of entities) {
        if (e.collection === 'humanAction') continue; // appended separately
        const stateJson = serializeValue(e.value);
        const checksum = sha256Hex(stateJson);
        seenByCollection.get(e.collection)?.add(e.key);
        const prev = index.get(e.collection)?.get(e.key);
        if (prev && prev.checksum === checksum) continue; // unchanged -> skip
        const cur = currentRow(e.collection, e.key);
        if (cur) pushHistory(cur);
        upsertRow(e.collection, e.key, e.projectId, stateJson, checksum, nextRevision, at);
      }
      // Delete scoped entities that disappeared.
      for (const c of DELETABLE_COLLECTIONS) {
        const seen = seenByCollection.get(c);
        for (const key of existing.get(c)) {
          if (!seen.has(key)) {
            const cur = currentRow(c, key);
            if (cur) pushHistory(cur);
            deleteRow(c, key);
          }
        }
      }
      // Append-only humanActions (never rewrite existing rows).
      for (const e of humanActions) {
        if (index.get('humanAction').has(e.key)) continue;
        const stateJson = serializeValue(e.value);
        upsertRow('humanAction', e.key, e.projectId, stateJson, sha256Hex(stateJson), nextRevision, at);
      }

      writeMeta('revision', String(nextRevision));
      db.exec('COMMIT');
      globalRevision = nextRevision;
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* ignore */ }
      status = 'failed';
      throw new PersistenceCommitError(`[sqlite-persistence] durable commit failed: ${err.message}`, { cause: err });
    }
  }

  function close() {
    if (db) {
      try { db.close(); } catch { /* ignore */ }
      db = null;
    }
    releaseLock();
  }

  return {
    load,
    save,
    saveSync: (stateFactory, scope) => save(stateFactory, scope),
    close,
    getHealth: () => ({ status, backend: 'sqlite', revision: globalRevision, filePath }),
    get revision() { return globalRevision; },
  };
}
