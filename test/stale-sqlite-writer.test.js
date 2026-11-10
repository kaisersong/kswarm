import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSqlitePersistence} from '../src/core/sqlite-persistence.js';
const payload=name=>({entities:[{collection:'project',key:'p',projectId:'p',value:{id:'p',name}}]});
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'kswarm-stale-writer-')),filePath=join(root,'state.sqlite'),stores=[],loaded=new Map();
 const create=(options={})=>{const store=createSqlitePersistence({filePath,...options});stores.push(store);return store;};
 t.after(()=>{for(const store of stores)store.close();rmSync(root,{recursive:true,force:true});});
 return {root,filePath,create,state:store=>loaded.get(store),open(options={}){const store=create(options);loaded.set(store,store.load());return store;},raw(action){const db=new DatabaseSync(filePath);try{return action(db);}finally{db.close();}}};
}
test('real second writer cannot make a stale original writer silently overwrite committed business state',t=>{
 const f=fixture(t),first=f.open();first.save(payload('before'));
 // Fault injection simulates the existing lock-reclamation race: both writers
 // think they own the lock. Actual SQLite connections/transactions remain real.
 const second=f.open({isProcessAlive:()=>false});second.save(payload('second-committed'));
 assert.throws(()=>first.save(payload('STALE-OVERWRITE')),/stale.*writer|writer.*revision/i);
 assert.equal(first.getHealth().status,'failed');
 first.close();assert.equal(f.raw(db=>JSON.parse(db.prepare("SELECT state_json FROM state_entities WHERE collection='project' AND entity_key='p'").get().state_json).name),'second-committed');
 second.close();assert.equal(f.open().getHealth().revision,2);
});
test('original write set callback crossing another real commit is rejected before any floor activation',t=>{
 const f=fixture(t),first=f.open();first.save(payload('before'));const second=f.open({isProcessAlive:()=>false});
 assert.throws(()=>first.save(()=>{second.save(payload('second'));return {...payload('stale'),requiredWriterProfile:'sqlite_writer_gate_v1'};}),/stale.*writer|writer.*revision/i);
 f.raw(db=>{assert.equal(db.prepare("SELECT meta_value FROM state_meta WHERE meta_key='writer_floor_v1'").get(),undefined);assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='trigger' AND name GLOB 'kswarm_writer_floor_*'").get().n,0);});
});
test('missing, malformed and unsafe global revision never become known zero on reopen',t=>{
 for(const bad of [null,'not-a-number','-1','1.5','01',' 1','9007199254740992']){
  const f=fixture(t),store=f.open();store.save(payload('before'));store.close();
  f.raw(db=>{if(bad===null)db.prepare("DELETE FROM state_meta WHERE meta_key='revision'").run();else db.prepare("UPDATE state_meta SET meta_value=? WHERE meta_key='revision'").run(bad);});
  assert.throws(()=>f.open(),/global.*revision|writer.*revision/i);
 }
});
test('global revision exhaustion refuses a write without producing an unsafe commit version',t=>{
 const f=fixture(t),store=f.open();store.save(payload('before'));store.close();f.raw(db=>db.prepare("UPDATE state_meta SET meta_value=? WHERE meta_key='revision'").run(String(Number.MAX_SAFE_INTEGER)));
 const exhausted=f.open();assert.throws(()=>exhausted.save(payload('after')),/global.*revision|writer.*revision/i);
 assert.equal(f.raw(db=>JSON.parse(db.prepare("SELECT state_json FROM state_entities WHERE collection='project'").get().state_json).name),'before');
});
test('original checksum recovery is one new commit and invalidates an earlier live writer snapshot',t=>{
 const f=fixture(t),first=f.open();first.save(payload('v1'));first.save(payload('v2'));
 f.raw(db=>db.exec("UPDATE state_entities SET state_json='corrupt' WHERE collection='project'"));
 const restored=f.open({isProcessAlive:()=>false});assert.equal(restored.getHealth().revision,3);
 assert.equal(f.raw(db=>JSON.parse(db.prepare("SELECT state_json FROM state_entities WHERE collection='project'").get().state_json).name),'v1');
 assert.throws(()=>first.save(payload('cached-v2')),/stale.*writer|writer.*revision/i);
 first.close();restored.close();assert.equal(f.open().getHealth().revision,3);
});
test('brand-new empty migration marker and revision are atomic on a real injected COMMIT failure',t=>{
 const f=fixture(t);
 assert.throws(()=>f.open({sqliteFactory(path){const db=new DatabaseSync(path),exec=db.exec.bind(db);db.exec=sql=>{if(sql==='COMMIT')throw Error('empty init COMMIT fault');return exec(sql);};return db;}}),/empty init COMMIT fault/);
 f.raw(db=>{assert.equal(db.prepare("SELECT meta_value FROM state_meta WHERE meta_key='migration'").get(),undefined);assert.equal(db.prepare("SELECT meta_value FROM state_meta WHERE meta_key='revision'").get(),undefined);});
});

test('legacy migration rechecks the actual locked store instead of resetting a newer initializer revision',t=>{
 const f=fixture(t),legacyJsonPath=join(f.root,'legacy.json');writeFileSync(legacyJsonPath,JSON.stringify({projects:[{id:'p',name:'legacy-old'}]}));let crossed=false;
 const first=f.open({legacyJsonPath,sqliteFactory(path){const db=new DatabaseSync(path),exec=db.exec.bind(db);db.exec=sql=>{
  if(sql==='BEGIN IMMEDIATE'&&!crossed){crossed=true;const second=f.open({isProcessAlive:()=>false});second.save(payload('new-initializer-v1'));second.save(payload('new-initializer-v2'));second.close();}
  return exec(sql);
 };return db;}});
 assert.equal(crossed,true);assert.equal(f.state(first).projects[0].name,'new-initializer-v2');assert.equal(first.getHealth().revision,2);assert.equal(existsSync(legacyJsonPath),true);
});
test('later protected integrity failure rolls back all staged ordinary recovery and its revision',t=>{
 const f=fixture(t),store=f.open(),head={collection:'protocolHead',key:'h',projectId:'p',value:{id:'h',kind:'scope_control',projectId:'p',revision:1}};
 store.save({...payload('v1'),entities:[...payload('v1').entities,head]});store.save({entities:[...payload('v2').entities,head]});store.close();
 f.raw(db=>db.exec("UPDATE state_entities SET state_json='CORRUPT' WHERE collection IN ('project','protocolHead')"));
 assert.throws(()=>f.open(),/protected record integrity/);
 f.raw(db=>{assert.equal(db.prepare("SELECT state_json FROM state_entities WHERE collection='project'").get().state_json,'CORRUPT');assert.equal(db.prepare("SELECT meta_value FROM state_meta WHERE meta_key='revision'").get().meta_value,'2');});
});
test('original BEGIN failure latches writer failed and cannot leave a reusable healthy writer',t=>{
 const f=fixture(t);let fail=false;const store=f.open({sqliteFactory(path){const db=new DatabaseSync(path),exec=db.exec.bind(db);db.exec=sql=>{if(fail&&sql==='BEGIN IMMEDIATE'){fail=false;throw Error('actual BEGIN unavailable');}return exec(sql);};return db;}});
 store.save(payload('before'));fail=true;assert.throws(()=>store.save(payload('after')),/BEGIN unavailable/);assert.equal(store.getHealth().status,'failed');assert.throws(()=>store.save(payload('later')),/failed state/);
 store.close();assert.equal(f.state(f.open()).projects[0].name,'before');
});

test('original save and saveSync cannot be reentered from their write-set callback or adopt inner revision',t=>{
 for(const method of ['save','saveSync']){
  const f=fixture(t),store=f.open();store.save(payload('before'));let failure;
  try{store.save(()=>{try{store[method](payload('inner-new'));}catch{}return payload('outer-old');});}catch(error){failure=error;}
  const name=f.raw(db=>JSON.parse(db.prepare("SELECT state_json FROM state_entities WHERE collection='project'").get().state_json).name);
  console.log(JSON.stringify({test:'same-original-writer-callback-reentry',method,name,rejected:!!failure}));assert.ok(failure);assert.equal(name,'before');assert.equal(store.getHealth().status,'failed');
 }
});
test('serializer reentry cannot roll back outer transaction and leak later writes through autocommit',t=>{
 const f=fixture(t),store=f.open();store.save(payload('before'));
 const value={toJSON(){try{store.save(payload('inner'));}catch{}return {id:'p',name:'OUTER-AUTOCOMMIT'};}};
 assert.throws(()=>store.save({entities:[{collection:'project',key:'p',projectId:'p',value}]}));
 const name=f.raw(db=>JSON.parse(db.prepare("SELECT state_json FROM state_entities WHERE collection='project'").get().state_json).name);
 console.log(JSON.stringify({test:'same-original-writer-serializer-reentry',name}));assert.equal(name,'before');
});
test('recovery now callback cannot reenter the same writer and leak a failed load recovery',t=>{
 const f=fixture(t),first=f.open();first.save(payload('v1'));first.save(payload('v2'));first.close();f.raw(db=>db.exec("UPDATE state_entities SET state_json='CORRUPT' WHERE collection='project'"));
 let target,trigger=true,opened=false;target=f.create({sqliteFactory(path){opened=true;return new DatabaseSync(path);},now(){if(trigger&&opened){trigger=false;try{target.save(payload('inner'));}catch{}}return Date.now();}});
 assert.throws(()=>target.load());
 f.raw(db=>{assert.equal(db.prepare("SELECT state_json FROM state_entities WHERE collection='project'").get().state_json,'CORRUPT');assert.equal(db.prepare("SELECT meta_value FROM state_meta WHERE meta_key='revision'").get().meta_value,'2');});
});
test('load or close attempted during write cannot release the owned connection or commit outer payload',t=>{
 for(const method of ['load','close']){
  const f=fixture(t),store=f.open();store.save(payload('before'));let failure,heldAfterAttempt=false;
  try{store.save(()=>{try{store[method]();}catch{}heldAfterAttempt=existsSync(f.filePath+'.lock');return payload('after');});}catch(error){failure=error;}
  assert.ok(failure);assert.equal(heldAfterAttempt,true);assert.equal(store.getHealth().status,'failed');
  assert.equal(f.raw(db=>JSON.parse(db.prepare("SELECT state_json FROM state_entities WHERE collection='project'").get().state_json).name),'before');
 }
});
