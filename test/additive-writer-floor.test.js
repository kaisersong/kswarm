import {spawnSync} from 'node:child_process';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createSqlitePersistence} from '../src/core/sqlite-persistence.js';

const profile='sqlite_writer_gate_v1';
const row=name=>({collection:'project',key:'p',projectId:'p',value:{id:'p',name}});
function fixture(t,options={}){
 const root=mkdtempSync(join(tmpdir(),'kswarm-writer-floor-'));const filePath=join(root,'state.sqlite');let store;
 const open=()=>{store=createSqlitePersistence({filePath,...options});return store.load();};open();
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 return {filePath,get store(){return store;},reopen(){store.close();return open();},raw(action){const db=new DatabaseSync(filePath);try{return action(db);}finally{db.close();}}};
}
const activate=(store,name='active')=>store.save({requiredWriterProfile:profile,entities:[row(name)]});
test('floor is opt-in, same original commit, stable across reopen and cannot be downgraded',t=>{
 const f=fixture(t);f.store.save({entities:[row('legacy')]});
 assert.equal(f.store.getWriterProfile().floor,null);
 activate(f.store);const before=f.store.getWriterProfile();
 assert.equal(before.floor.profile,profile);assert.match(before.floor.storeId,/^[a-f0-9-]{36}$/);
 assert.equal(f.reopen().projects[0].name,'active');assert.deepEqual(f.store.getWriterProfile(),before);
 f.store.save({entities:[row('next')]});activate(f.store,'last');
 assert.deepEqual(f.store.getWriterProfile(),before);assert.equal(f.reopen().projects[0].name,'last');
});
test('unknown requested profile cannot write or activate',t=>{
 const f=fixture(t);f.store.save({entities:[row('before')]});
 assert.throws(()=>f.store.save({requiredWriterProfile:'future_v2',entities:[row('after')]}),/writer.*profile/i);
 assert.equal(f.reopen().projects[0].name,'before');assert.equal(f.store.getWriterProfile().floor,null);
});
test('floor activation and trigger installation roll back with original entity write error',t=>{
 const f=fixture(t);f.store.save({entities:[row('before')]});
 assert.throws(()=>f.store.save({requiredWriterProfile:profile,entities:[row('after'),{collection:'protocolHead',key:'bad',projectId:'p',value:{id:'bad',projectId:'p',kind:'head',revision:9}}]}),/CAS|revision/);
 assert.equal(f.reopen().projects[0].name,'before');assert.equal(f.store.getWriterProfile().floor,null);
 assert.equal(f.raw(db=>db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='trigger' AND name LIKE 'kswarm_writer_floor_%'").get().n),0);
});
test('floor activation COMMIT failure leaves neither metadata nor guards',t=>{
 let raw,fail=false;
 const f=fixture(t,{sqliteFactory(path){raw=new DatabaseSync(path);const exec=raw.exec.bind(raw);raw.exec=sql=>{if(fail&&sql==='COMMIT')throw Error('injected floor COMMIT failure');return exec(sql);};return raw;}});
 f.store.save({entities:[row('before')]});fail=true;
 assert.throws(()=>activate(f.store),/injected floor COMMIT failure/);fail=false;
 assert.equal(f.reopen().projects[0].name,'before');assert.equal(f.store.getWriterProfile().floor,null);
});
test('unaware real connection cannot write entities, history or metadata, or replace/remove floor',t=>{
 const f=fixture(t);activate(f.store,'older');f.store.save({entities:[row('active')]});const floor=f.store.getWriterProfile().floor;
 f.raw(db=>{
  for(const sql of ["UPDATE state_entities SET state_json='{}'",'DELETE FROM state_entity_history',"UPDATE state_meta SET meta_value='0' WHERE meta_key='revision'","DELETE FROM state_meta WHERE meta_key='writer_floor_v1'","INSERT OR REPLACE INTO state_meta VALUES ('writer_floor_v1','{}')"])
   assert.throws(()=>db.exec(sql),/kswarm_writer_profile_v1|writer.floor/i);
  for(const value of [null,'wrong-digest']){db.function('kswarm_writer_profile_v1',()=>value);assert.throws(()=>db.exec("UPDATE state_meta SET meta_value='0' WHERE meta_key='revision'"),/writer.floor/i);}
  db.function('kswarm_writer_profile_v1',()=>f.store.getWriterProfile().writerProfileDigest);
  for(const sql of ["UPDATE state_meta SET meta_key='renamed' WHERE meta_key='writer_floor_v1'","DELETE FROM state_meta WHERE meta_key='writer_floor_v1'","UPDATE state_meta SET meta_value='{}' WHERE meta_key='writer_floor_v1'","INSERT OR REPLACE INTO state_meta VALUES ('writer_floor_v1','{}')"])
   assert.throws(()=>db.exec(sql),/floor.*immutable/i);
 });
 assert.deepEqual(f.store.getWriterProfile().floor,floor);assert.equal(f.reopen().projects[0].name,'active');
});
test('missing and same-name altered trigger deny existing writer and future load without repairing',t=>{
 for(const alter of [false,true]){
  const f=fixture(t);activate(f.store);
  const name=f.raw(db=>db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'kswarm_writer_floor_%' ORDER BY name").get().name);
  f.raw(db=>{db.exec('DROP TRIGGER '+name);if(alter)db.exec('CREATE TRIGGER '+name+' BEFORE UPDATE ON state_entities BEGIN SELECT 1; END');});
  assert.throws(()=>f.store.save({entities:[row('after')]}),/writer.*floor|floor.*integrity/i);
  assert.throws(()=>f.reopen(),/writer.*floor|floor.*integrity/i);
  f.raw(db=>{const sql=db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(name)?.sql;assert.equal(alter?sql.includes('SELECT 1'):sql===undefined,true);});
 }
});
test('unknown, malformed and surplus floor fields reject before recovery/init writes',t=>{
 for(const mutate of [floor=>({...floor,schemaVersion:2}),floor=>({...floor,profile:'future'}),floor=>({...floor,extra:true}),floor=>({...floor,writerProfileDigest:'0'.repeat(64)}),()=>null]){
  const f=fixture(t);activate(f.store);
  f.raw(db=>{
   const triggers=db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name='state_meta'").all();for(const {name} of triggers)db.exec('DROP TRIGGER '+name);
   const floor=JSON.parse(db.prepare("SELECT meta_value FROM state_meta WHERE meta_key='writer_floor_v1'").get().meta_value);
   db.prepare("UPDATE state_meta SET meta_value=? WHERE meta_key='writer_floor_v1'").run(JSON.stringify(mutate(floor)));
   for(const {sql} of triggers)db.exec(sql);
  });
  assert.throws(()=>f.reopen(),/writer.*floor|floor.*integrity/i);
 }
});
test('orphan reserved trigger without floor is corruption, not legacy auto-repair',t=>{
 const f=fixture(t);f.raw(db=>db.exec('CREATE TRIGGER kswarm_writer_floor_orphan BEFORE UPDATE ON state_meta BEGIN SELECT 1; END'));
 assert.throws(()=>f.reopen(),/writer.*floor|floor.*integrity/i);
});

test('active floor permits original same-connection nonprotected checksum recovery',t=>{
 const f=fixture(t);activate(f.store,'older');f.store.save({entities:[row('newer')]});const floor=f.store.getWriterProfile().floor;
 f.raw(db=>{db.function('kswarm_writer_profile_v1',()=>f.store.getWriterProfile().writerProfileDigest);db.exec("UPDATE state_entities SET state_json='corrupt' WHERE collection='project'");});
 assert.equal(f.reopen().projects[0].name,'older');assert.deepEqual(f.store.getWriterProfile().floor,floor);
});
test('SIGKILL after original floor commit retains exact store identity and project',t=>{
 const f=fixture(t);f.store.close();const moduleUrl=new URL('../src/core/sqlite-persistence.js',import.meta.url).href;
 const script='import {writeSync} from "node:fs";import {createSqlitePersistence} from '+JSON.stringify(moduleUrl)+';const p=createSqlitePersistence({filePath:'+JSON.stringify(f.filePath)+'});p.load();p.save('+JSON.stringify({requiredWriterProfile:profile,entities:[row('committed-before-kill')]})+');writeSync(1,JSON.stringify(p.getWriterProfile().floor));process.kill(process.pid,"SIGKILL");';
 const child=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',timeout:10000});
 console.log(JSON.stringify({test:'writer-floor-committed-sigkill',pid:child.pid,status:child.status,signal:child.signal,reaped:true}));assert.equal(child.error,undefined);
 if(process.platform==='win32')assert.notEqual(child.status,0);else assert.equal(child.signal,'SIGKILL');
 const floor=JSON.parse(child.stdout.trim());assert.equal(f.reopen().projects[0].name,'committed-before-kill');assert.deepEqual(f.store.getWriterProfile().floor,floor);
});
test('duplicate JSON floor fields cannot shadow an unknown contract version',t=>{
 const f=fixture(t);activate(f.store);
 f.raw(db=>{
  const triggers=db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name='state_meta'").all();for(const {name} of triggers)db.exec('DROP TRIGGER '+name);
  const raw=db.prepare("SELECT meta_value FROM state_meta WHERE meta_key='writer_floor_v1'").get().meta_value;
  db.prepare("UPDATE state_meta SET meta_value=? WHERE meta_key='writer_floor_v1'").run('{"schemaVersion":2,'+raw.slice(1));
  for(const {sql} of triggers)db.exec(sql);
 });
 assert.throws(()=>f.reopen(),/writer.*floor|floor.*integrity/i);
});
