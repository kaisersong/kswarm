import {IntrinsicMap as Map,IntrinsicSet as Set} from './intrinsic-collections.js';
import {readWriterTransitionSnapshot,assertTransitionSerialization} from './sqlite-writer-transition.js';
import {WRITER_TRANSITION_KEY,createWriterTransition,writerTransitionTriggers} from './writer-transition-contract.js';
import {semanticWriterForFloor} from './initial-plan-acceptance-contract.js';
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
import {createSqliteWriterFloor} from './sqlite-writer-floor.js';
import {types} from 'node:util';
import {isAcceptanceRecord} from './initial-plan-acceptance-contract.js';
import {registerInitialPlanWriteBackend,frozenInitialPlanWriteSet} from './initial-plan-write-fence.js';

import {
  sha256Hex,
  serializeValue,
  decomposeState,
  composeEntities,
  DELETABLE_COLLECTIONS,
  ALL_COLLECTIONS,
  PROTECTED_COLLECTIONS,
} from './state-scope.js';

const readRowDefine=Object.defineProperty;
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
  return !!err && (err.name === 'PersistenceCommitError' || err instanceof PersistenceCommitError
    || err.code === 'persistence_post_commit_failure' && err.durableCommitted === true);
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
  let writerFloor = null;
  let status = 'ok'; // ok | failed
  let globalRevision = 0;
  let lockHeld = false;
  let activeOperation=null,operationReentryFailure=null;
  let emptyPlanningEpoch=null,emptyPlanningEpochData=null,planningEpochUnknown=null;
  let saveExpectedRevision=null,api=null,writeFence=null;
  // in-memory index: collection -> Map(key -> { checksum, projectId, revision })
  const index = new Map();
  for (const c of ALL_COLLECTIONS) {
    index.set(c, new Map());
  }

  function warn(...args) { if (!silent) console.warn('[sqlite-persistence]', ...args); }
  function rejectReentrantOperation() {
    if(activeOperation){
      // Poison the outer operation even if a callback catches this exception.
      // Never touch SQL/ROLLBACK/locks from the rejected inner operation.
      status='failed';
      const error=new PersistenceCommitError('[sqlite-persistence] reentrant store operation rejected');operationReentryFailure??=error;throw error;
    }
  }
  function withOperation(kind,action) {
    rejectReentrantOperation();assertHealthy();activeOperation=kind;operationReentryFailure=null;
    try{return action();}finally{activeOperation=null;if(kind==='save')saveExpectedRevision=null;}
  }

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
  function readGlobalRevision() {
    const raw=readMeta('revision');
    if(typeof raw!=='string'||!/^(0|[1-9][0-9]*)$/.test(raw)||!Number.isSafeInteger(Number(raw)))throw Error('global_revision_invalid');
    return Number(raw);
  }
  function nextGlobalRevision(revision) {
    if(!Number.isSafeInteger(revision)||revision<0||!Number.isSafeInteger(revision+1))throw Error('global_revision_exhausted');
    return revision+1;
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
    let migratedLegacy=false;
    try {
      db.exec('BEGIN IMMEDIATE');
      writerFloor.read();
      // The earlier empty observation is not authority to initialize. Another
      // initializer may have committed while this connection waited for SQL.
      if(readMeta('migration')){
        readGlobalRevision();assertHealthy();db.exec('COMMIT');return;
      }
      const entityCount=countEntities();
      const metaCount=Number(db.prepare('SELECT COUNT(*) AS n FROM state_meta').get().n);
      const historyCount=Number(db.prepare('SELECT COUNT(*) AS n FROM state_entity_history').get().n);
      if(entityCount||metaCount||historyCount)throw new PersistenceLoadError(`[sqlite-persistence] found existing state but no migration marker (entities=${entityCount}); refusing to initialize`);
      const at=new Date(now()).toISOString();
      if(!legacyJsonPath||!fs.existsSync(legacyJsonPath)){
        writeMeta('migration',JSON.stringify({migrated:false,source:'none',at}));writeMeta('revision','0');
      }else{
        let legacyState;
        try{legacyState=JSON.parse(fs.readFileSync(legacyJsonPath,'utf-8'));}
        catch(err){throw new PersistenceLoadError(`[sqlite-persistence] legacy state.json is corrupt; refusing to start empty: ${err.message}`,{cause:err});}
        const entities=decomposeState(legacyState);
        if(entities.some(row=>PROTECTED_COLLECTIONS.includes(row.collection)&&isAcceptanceRecord(row.value)))throw new PersistenceLoadError('initial_plan_legacy_birth_forbidden');
        for(const e of entities){
          const stateJson=serializeValue(e.value);
          upsertRow(e.collection,e.key,e.projectId,stateJson,sha256Hex(stateJson),1,at);
        }
        writeMeta('revision','1');
        writeMeta('migration',JSON.stringify({migrated:true,source:legacyJsonPath,entities:entities.length,at}));
        migratedLegacy=true;
      }
      assertHealthy();db.exec('COMMIT');
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* ignore */ }
      // Rebuild index cleanly (partial upserts touched it).
      for (const m of index.values()) m.clear();
      throw new PersistenceLoadError(`[sqlite-persistence] legacy migration failed; original JSON preserved: ${err.message}`, { cause: err });
    }
    if(!migratedLegacy)return;
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
    const floor=writerFloor.read();
    if(semanticWriterForFloor(floor)&&rows.some(row=>sha256Hex(row.state_json)!==row.checksum))throw new PersistenceLoadError('initial_plan_profile_recovery_unqualified');
    const recovered = [];
    let recoveryRevision=null;
    for (const row of rows) {
      const actual = sha256Hex(row.state_json);
      if (actual === row.checksum) {
        index.get(row.collection)?.set(row.entity_key, { checksum: row.checksum, projectId: row.project_id ?? null, revision: row.revision });
        continue;
      }
      // A historical epoch/head cannot replace a corrupt current security fact.
      if (PROTECTED_COLLECTIONS.includes(row.collection)) {
        throw new PersistenceLoadError('[sqlite-persistence] protected record integrity failure');
      }
      // Checksum mismatch -> try recover from history (latest valid version).
      const history = db.prepare('SELECT project_id, state_json, checksum, revision, updated_at FROM state_entity_history WHERE collection = ? AND entity_key = ? ORDER BY revision DESC, rowid DESC')
        .all(row.collection, row.entity_key);
      const valid = history.find(h => sha256Hex(h.state_json) === h.checksum);
      if (!valid) {
        const sidecar = writeSidecar('entity_checksum_unrecoverable', { collection: row.collection, entity_key: row.entity_key });
        throw new PersistenceLoadError(`[sqlite-persistence] unrecoverable checksum mismatch for ${row.collection}/${row.entity_key}; diagnostic: ${sidecar}`);
      }
      recoveryRevision??=nextGlobalRevision(globalRevision);
      upsertRow(row.collection,row.entity_key,valid.project_id,valid.state_json,valid.checksum,recoveryRevision,new Date(now()).toISOString());
      recovered.push({collection:row.collection,entity_key:row.entity_key,restoredRevision:valid.revision,recoveryRevision});
    }
    if(recoveryRevision!==null)writeMeta('revision',String(recoveryRevision));
    return {recovered,recoveryRevision};
  }

  function readAllEntities() {
    const rows = db.prepare('SELECT collection, entity_key, project_id, state_json FROM state_entities').all();
    return rows.map(r => ({ collection: r.collection, key: r.entity_key, projectId: r.project_id ?? null, value: JSON.parse(r.state_json) }));
  }

  function load() {
    return withOperation('load',loadOwned);
  }
  function loadOwned() {
    acquireLock();
    try {
      db = sqliteFactory(filePath);
    } catch (err) {
      const sidecar = writeSidecar('db_open_failed', { message: err.message });
      status = 'failed';
      throw new PersistenceLoadError(`[sqlite-persistence] cannot open database: ${err.message}; diagnostic: ${sidecar}`, { cause: err });
    }
    try {
      assertHealthy();
      writerFloor=createSqliteWriterFloor(db);
      // Inspect before journal/schema/recovery writes. An incomplete or future
      // floor is never interpreted as a legacy store or automatically repaired.
      writerFloor.assertWritable();
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

      if(!readMeta('migration'))runLegacyMigration();
      // One coherent read/recovery snapshot. A later protected failure cannot
      // leave an earlier ordinary recovery committed, or a stale revision.
      try{
        assertHealthy();
        db.exec('BEGIN IMMEDIATE');
        writerFloor.assertWritable();
        if(!readMeta('migration'))throw new PersistenceLoadError('[sqlite-persistence] migration marker missing during load');
        globalRevision=readGlobalRevision();
        for(const coll of index.values())coll.clear();
        const {recovered,recoveryRevision}=verifyAndIndex();
        const state=countEntities()===0?null:composeEntities(readAllEntities());
        assertHealthy();
        db.exec('COMMIT');
        if(recoveryRevision!==null)globalRevision=recoveryRevision;
        if(recovered.length){
          const sidecar=writeSidecar('entity_checksum_recovered',{recovered});
          warn(`recovered ${recovered.length} entity(ies) from history; diagnostic: ${sidecar}`);
        }
        assertHealthy();
        return state;
      }catch(err){try{db.exec('ROLLBACK');}catch{/* already committed or unavailable */}throw err;}
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
  function policyRead(action){
    assertHealthy();
    try{
      if(!db||!writerFloor)throw Error('database not loaded');
      return action();
    }catch(error){
      status='failed';
      throw new PersistenceCommitError(`[sqlite-persistence] policy read failed: ${error.message}`,{cause:error});
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
    return withOperation('save',()=>saveOwned(stateFactory,scope));
  }
  function assertRuntimeWriteCurrent(payload,phase){
    assertTransitionHealthy();
    try{writeFence.assertRuntimeCurrent(payload,phase);}
    catch(error){if(operationReentryFailure)throw operationReentryFailure;throw error;}
    assertTransitionHealthy();
  }
  function saveOwned(stateFactory,scope) {
    const expectedRevision=globalRevision;saveExpectedRevision=expectedRevision;let begun=false,committed=false;
    try {
      assertHealthy();
      if(!db)throw new PersistenceCommitError('[sqlite-persistence] database not loaded');
      if(typeof stateFactory==='function'&&(types.isAsyncFunction(stateFactory)||types.isProxy(stateFactory)))throw Error('persistence_write_set_async');
      const payload=typeof stateFactory==='function'?stateFactory(scope):stateFactory;
      const actual=frozenInitialPlanWriteSet(api,payload)??writeFence.materialize(payload,scope);
      const effectiveScope=actual.scope,at=new Date(now()).toISOString();
      const existing=scopedExistingKeys(effectiveScope),seenByCollection=new Map(DELETABLE_COLLECTIONS.map(c=>[c,new Set()]));
      assertTransitionHealthy();db.exec('BEGIN IMMEDIATE');begun=true;
      if(readGlobalRevision()!==expectedRevision)throw Error('stale_sqlite_writer_revision');
      assertRuntimeWriteCurrent(payload,'before');
      const nextRevision=nextGlobalRevision(expectedRevision);
      const priorFloor=writerFloor.read(),saveConnection=db;
      if(writeFence.isFreshPreparation(payload,actual)&&(priorFloor||actual.entities.length||actual.humanActions.length||db.prepare('SELECT 1 FROM state_entities LIMIT 1').get()||db.prepare('SELECT 1 FROM state_entity_history LIMIT 1').get()))throw Error('INITIAL_PLAN_FRESH_STORE_REQUIRED');
      assertTransitionHealthy();
      const epochBirth=!priorFloor&&actual.requiredWriterProfile?.profile==='ordinary_initial_plan_acceptance_writer_v1'&&!actual.entities.length&&!actual.humanActions.length&&!db.prepare('SELECT 1 FROM state_entities LIMIT 1').get()&&!db.prepare('SELECT 1 FROM state_entity_history LIMIT 1').get();
      writeFence.consume(payload,actual);
      const installedFloor=writerFloor.require(actual.requiredWriterProfile);
      for(const e of actual.entities){
        const stateJson=e.stateJson,checksum=sha256Hex(stateJson);
        seenByCollection.get(e.collection)?.add(e.key);
        const protectedRecord=PROTECTED_COLLECTIONS.includes(e.collection),next=protectedRecord?JSON.parse(stateJson):null;
        if(protectedRecord&&(!next||next.id!==e.key||typeof next.kind!=='string'||!next.kind||(next.projectId??null)!==e.projectId))throw Error('protected_record_identity_invalid');
        const prev=index.get(e.collection)?.get(e.key);if(prev&&prev.checksum===checksum)continue;
        const cur=currentRow(e.collection,e.key);
        if(protectedRecord){
          if(cur&&e.collection==='protocolReceipt')throw Error('protected_immutable_receipt_conflict');
          if(e.collection==='protocolHead'){
            const prior=cur?JSON.parse(cur.state_json):null;
            if(!Number.isSafeInteger(next.revision)||next.revision!==(prior?.revision??0)+1)throw Error('protected_head_CAS_revision_conflict');
            if(prior&&(prior.kind!==next.kind||prior.id!==next.id||(prior.projectId??null)!==(next.projectId??null)))throw Error('protected_head_identity_conflict');
          }
        }
        if(cur)pushHistory(cur);upsertRow(e.collection,e.key,e.projectId,stateJson,checksum,nextRevision,at);
      }
      for(const collection of DELETABLE_COLLECTIONS)for(const id of existing.get(collection))if(!seenByCollection.get(collection).has(id)){
        const cur=currentRow(collection,id);if(cur)pushHistory(cur);deleteRow(collection,id);
      }
      for(const e of actual.humanActions){if(index.get('humanAction').has(e.key))continue;upsertRow('humanAction',e.key,e.projectId,e.stateJson,sha256Hex(e.stateJson),nextRevision,at);}
      writeFence.verifyRequiredRows(payload);
      writeMeta('revision',String(nextRevision));assertRuntimeWriteCurrent(payload,'after');assertTransitionHealthy();db.exec('COMMIT');begun=false;committed=true;globalRevision=nextRevision;assertTransitionHealthy();if(db!==saveConnection)throw Error('persistence_connection_superseded');
      if(epochBirth&&status==='ok'&&!operationReentryFailure&&db===saveConnection){emptyPlanningEpoch=Object.freeze(Object.create(null));emptyPlanningEpochData={connection:db,scope:Object.freeze({...installedFloor.scope}),storeId:installedFloor.storeId,revision:nextRevision};planningEpochUnknown=null;}
    } catch(err) {
      let cause=err;if(begun)try{db?.exec('ROLLBACK');}catch(rollbackError){cause=new AggregateError([err,rollbackError],'persistence rollback unknown',{cause:err});}
      status='failed';const failure=new PersistenceCommitError(`[sqlite-persistence] durable commit failed: ${err.message}`,{cause});if(committed)failure.durableCommitted=true;throw failure;
    }
  }

  function assertTransitionHealthy(){if(operationReentryFailure)throw operationReentryFailure;assertHealthy();}
  function transitionFailure(error,begun,committed){
    let cause=error;
    if(begun)try{db.exec('ROLLBACK');}catch(rollbackError){cause=new AggregateError([error,rollbackError],'writer transition rollback unknown',{cause:error});}
    status='failed';const failure=new PersistenceCommitError('[sqlite-persistence] writer transition failed: '+error.message,{cause});
    if(committed)failure.durableCommitted=true;throw failure;
  }
  function captureDefaultDispatchTransitionObservation(){
    return withOperation('transitionObservation',()=>{let begun=false;
      try{assertHealthy();if(!db)throw Error('database not loaded');db.exec('BEGIN');begun=true;const connection=db,snapshot=readWriterTransitionSnapshot(db,writerFloor);assertTransitionHealthy();db.exec('COMMIT');begun=false;assertTransitionHealthy();if(db!==connection)throw Error('TRANSITION_OBSERVATION_UNVERIFIED');return snapshot;}
      catch(error){return transitionFailure(error,begun,false);}
    });
  }
  function transitionDefaultDispatch(prepare){
    return withOperation('transition',()=>{let begun=false,committed=false,nativeStarted=false;
      let snapshot,domain,actorId,current;
      const check=()=>{assertTransitionHealthy();current();assertTransitionHealthy();assertTransitionSerialization();};
      try{
        assertTransitionHealthy();if(!db)throw Error('database not loaded');({snapshot,domain,actorId,current}=prepare());check();nativeStarted=true;db.exec('BEGIN IMMEDIATE');begun=true;check();
        const actual=readWriterTransitionSnapshot(db,writerFloor);
        if(actual.digest!==snapshot.digest||actual.revision!==snapshot.revision||actual.revision!==globalRevision)throw Error('WRITER_TRANSITION_SNAPSHOT_CONFLICT');
        const record=createWriterTransition({baseFloor:actual.baseFloor,baseRaw:actual.baseRaw,scope:domain,snapshotDigest:actual.digest,baseRevision:actual.revision,actorId});
        if(!Number.isSafeInteger(record.committedRevision))throw Error('writer_revision_exhausted');
        check();const inserted=db.prepare('INSERT INTO state_meta(meta_key,meta_value) VALUES (?,?)').run(WRITER_TRANSITION_KEY,JSON.stringify(record));if(Number(inserted.changes)!==1)throw Error('writer_transition_insert_unconfirmed');
        for(const sql of writerTransitionTriggers().values()){check();db.exec(sql);}
        check();writeMeta('revision',String(record.committedRevision));const found=writerFloor.details();if(JSON.stringify(found.transition)!==JSON.stringify(record))throw Error('writer_transition_readback_unconfirmed');
        check();db.exec('COMMIT');begun=false;committed=true;globalRevision=record.committedRevision;check();return Object.freeze(record);
      }catch(error){if(!nativeStarted&&status!=='failed')throw error;return transitionFailure(error,begun,committed);}
    });
  }

  function close() {
    rejectReentrantOperation();
    if (db) {
      try { db.close(); } catch { /* ignore */ }
      db = null;
      writerFloor = null;
    }
    releaseLock();
  }

  api={
    load,
    save,
    saveSync: (stateFactory, scope) => save(stateFactory, scope),
    close,
    getWriterProfile:()=>policyRead(()=>writerFloor.describe()),
    getHealth: () => ({ status, backend: 'sqlite', revision: globalRevision, filePath }),
    get revision() { return globalRevision; },
  };
  writeFence=registerInitialPlanWriteBackend(api,{
    captureDefaultDispatchTransitionObservation,transitionDefaultDispatch,connectionIdentity:()=>db,
    inspectFreshPreparation:()=>withOperation('freshPreparationObservation',()=>{
      try{
        assertTransitionHealthy();if(!db)throw Error('database not loaded');
        const connection=db,revision=readGlobalRevision(),floor=writerFloor.read(),empty=!db.prepare('SELECT 1 FROM state_entities LIMIT 1').get()&&!db.prepare('SELECT 1 FROM state_entity_history LIMIT 1').get();
        assertTransitionHealthy();if(db!==connection||revision!==globalRevision)throw Error('stale_sqlite_writer_revision');
        return {connection,revision,floor,empty};
      }catch(error){return transitionFailure(error,false,false);}
    }),
    emptyPlanningEpoch:()=>status==='ok'&&!planningEpochUnknown&&emptyPlanningEpochData?.connection===db?emptyPlanningEpoch:undefined,
    assertEmptyPlanningEpoch(epoch,scope){if(!epoch||epoch!==emptyPlanningEpoch||status!=='ok'||planningEpochUnknown||emptyPlanningEpochData?.connection!==db||scope.profileId!==emptyPlanningEpochData.scope.profileId||scope.workspaceId!==emptyPlanningEpochData.scope.workspaceId)throw Error('DEFAULT_DISPATCH_MIGRATION_RECONCILIATION_REQUIRED');return{...emptyPlanningEpochData.scope,storeId:emptyPlanningEpochData.storeId,revision:emptyPlanningEpochData.revision};},
    invalidateEmptyPlanningEpoch(error){if(emptyPlanningEpoch)planningEpochUnknown??=error;},poisonTransitionAdmission:error=>{status='failed';operationReentryFailure??=error;},
    expectedRevision:()=>activeOperation==='save'?saveExpectedRevision:null,
    profile:()=>policyRead(()=>writerFloor.describe()),
    readStoredEntity:(collection,key)=>currentRow(collection,key),
    readCurrentRevision:()=>policyRead(()=>({actual:readGlobalRevision(),cached:globalRevision})),
    readRowCount:()=>policyRead(()=>db.prepare('SELECT count(*) AS n FROM state_entities').get().n),
    readRows:()=>policyRead(()=>{
      const rows=db.prepare('SELECT collection,entity_key,project_id,state_json FROM state_entities').all(),out=[];
      for(let i=0;i<rows.length;i++){const row=rows[i];readRowDefine(out,String(i),{__proto__:null,value:{collection:row.collection,key:row.entity_key,projectId:row.project_id??null,stateJson:row.state_json},enumerable:true,writable:true,configurable:true});}return out;
    }),
  });
  return api;
}
