import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {createSqlitePersistence,PersistenceCommitError} from '../src/core/sqlite-persistence.js';
import {decomposeState} from '../src/core/state-scope.js';
import {ordinarySqliteFactory} from './fixtures/ordinary-sqlite-factory.js';

test('actual ordinary SQLite write contention retains original busy cause and latches failed state', () => {
 const root=mkdtempSync(join(tmpdir(),'kswarm-actual-busy-'));
 let persistence,blocker,raw;
 try {
  const filePath=join(root,'state.sqlite');
  persistence=createSqlitePersistence({filePath,sqliteFactory:path=>{raw=ordinarySqliteFactory(path);return raw;}});
  persistence.load();
  // Only this ordinary fixture's real connection changes; production keeps 5000ms.
  raw.exec('PRAGMA busy_timeout = 0');
  blocker=new DatabaseSync(filePath);blocker.exec('BEGIN IMMEDIATE');
  const scope={type:'project',projectId:'busy'};
  const payload=()=>({entities:decomposeState({projects:[{id:'busy'}]}),humanActions:[],scope});
  assert.throws(()=>persistence.save(payload,scope),error=>error instanceof PersistenceCommitError&&error.cause?.errcode===5&&/locked|busy/i.test(error.cause.message));
  assert.equal(persistence.getHealth().status,'failed');
  assert.throws(()=>persistence.save(payload,scope),PersistenceCommitError);
 } finally {
  if(blocker){try{blocker.exec('ROLLBACK');}finally{blocker.close();}}
  persistence?.close();rmSync(root,{recursive:true,force:true});
 }
});
