import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createHub} from '../src/core/hub.js';
import {createSqlitePersistence} from '../src/core/sqlite-persistence.js';
import {createProjectInputAuthority} from '../src/core/project-input-authority.js';
import {protocolDigest} from '../src/core/project-protocol.js';
import {composeEntities} from '../src/core/state-scope.js';
const scope={profileId:'a'.repeat(64),workspaceId:'b'.repeat(64)};
async function fixture(t,wrapped=false){
 const root=mkdtempSync(join(tmpdir(),'project-source-reader-')),filePath=join(root,'state.sqlite'),backend=createSqlitePersistence({filePath}),authority=createProjectInputAuthority(scope);let factory;
 const persistence=wrapped?{...backend,save(materialize,options){return backend.save(actual=>{const state=materialize(actual);factory?.();return state;},options);}}:backend;
 const hub=createHub({silent:true,persistence,brokerClient:{async getRoomSnapshot(){return{ok:true,room:{status:'active'},members:[{status:'active',subject:{kind:'agent',logicalAgentId:'po'}}]};},async acquireRoomMembershipLease(){return{ok:true};}}});
 t.after(()=>{hub.closePersistence();rmSync(root,{recursive:true,force:true});});
 await hub.createProject({id:'p',name:'P',goal:'Source only',poAgent:'po',primaryRoomId:'room',autoAssignPo:false},{requestSource:'user',projectInputAuthority:authority.creator('p-create')});hub.createProject({id:'legacy',name:'Legacy',goal:'Keep original feed',poAgent:'po',autoAssignPo:false});
 return{root,filePath,hub,backend,authority,setFactory:callback=>{factory=callback;}};
}
const reader=hub=>{assert.equal(typeof hub.readProjectSourceActivity,'function','original Source activity reader missing');return hub.readProjectSourceActivity.bind(hub);};
test('one original Source read retains scoped qualification only for the exact immutable local binding',async t=>{
 const f=await fixture(t),read=reader(f.hub),revision=f.backend.getHealth().revision;
 const result=read('p',{after:0,limit:200},f.authority.reader());assert.equal(result.protocol,'scoped_project_activity_v1');assert.deepEqual(result.scope,scope);assert.deepEqual(result.page,f.hub.getProjectActivity('p'));
 assert.equal(read('p',{},createProjectInputAuthority({...scope,workspaceId:'c'.repeat(64)}).reader()).error,'PROJECT_SCOPE_MISMATCH');assert.equal(f.backend.getHealth().revision,revision);
});
test('a validated unscoped legacy record yields only the original ordinary page with delivery unknown',async t=>{
 const f=await fixture(t),read=reader(f.hub),before=f.hub.getProjectActivity('legacy'),revision=f.backend.getHealth().revision;f.hub.getProject('legacy').scope=scope;
 const result=read('legacy',{},f.authority.reader());assert.equal(result.ok,true);assert.equal(result.protocol,undefined);assert.deepEqual(result,{...before,delivery:{status:'unavailable',reasonCode:'SNAPSHOT_INCOMPLETE'}});assert.equal(f.hub.readScopedProjectActivity('legacy',{},f.authority.reader()).error,'PROJECT_SCOPE_UNVERIFIED');assert.equal(f.backend.getHealth().revision,revision);
});
test('a forged reader, staged persistence factory and invalid options cannot select a weak fallback',async t=>{
 const f=await fixture(t,true),read=reader(f.hub);assert.equal(read('legacy',{},{}).ok,false);let during;f.setFactory(()=>{during=read('legacy',{},f.authority.reader());});f.hub.persistState({type:'project',projectId:'legacy'});f.setFactory(undefined);assert.equal(during.error,'PROJECT_ACTIVITY_READ_BUSY');
 let getters=0;const options={};Object.defineProperty(options,'after',{enumerable:true,get(){getters++;return 0;}});assert.throws(()=>read('legacy',options,f.authority.reader()),/invalid_activity_options/);assert.equal(getters,0);
});
for(const partial of [false,true])test('original JSON migration '+(partial?'with partial binding refuses weak recovery':'without protocol receipts retains the old ordinary feed'),async t=>{
 const f=await fixture(t);reader(f.hub);const db=new DatabaseSync(f.filePath,{readOnly:true});let state;try{state=composeEntities(db.prepare('SELECT collection,state_json FROM state_entities').all().map(row=>({collection:row.collection,value:JSON.parse(row.state_json)})));}finally{db.close();}
 state.protocolReceipts=state.protocolReceipts.filter(row=>row.projectId!=='legacy'||partial&&row.kind==='project_create_receipt');const legacyJsonPath=join(f.root,'legacy-state.json');writeFileSync(legacyJsonPath,JSON.stringify(state));
 const backend=createSqlitePersistence({filePath:join(f.root,'migrated.sqlite'),legacyJsonPath}),restored=createHub({silent:true,persistence:backend});t.after(()=>restored.closePersistence());
 const result=reader(restored)('legacy',{},f.authority.reader());assert.equal(result.ok,!partial);if(partial)assert.equal(result.error,'PROTOCOL_BINDING_UNVERIFIED');else{assert.equal(result.protocol,undefined);assert.deepEqual(result.delivery,{status:'unavailable',reasonCode:'SNAPSHOT_INCOMPLETE'});}
});
for(const kind of ['future-contract','reserved-head'])test('actual SQLite restored '+kind+' ownership cannot become weak legacy',async t=>{
 const f=await fixture(t);reader(f.hub);f.hub.closePersistence();
 const raw=new DatabaseSync(f.filePath);try{
  // Damage only this fixture's own database; restore original per-row checksums
  // so checksum corruption cannot masquerade as the ownership rejection.
  for(const row of raw.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all())raw.exec('DROP TRIGGER "'+row.name.replaceAll('"','""')+'"');
  const rows=raw.prepare("SELECT entity_key,state_json FROM state_entities WHERE collection='protocolReceipt'").all(),values=rows.map(row=>JSON.parse(row.state_json));
  if(kind==='future-contract'){
   const binding=values.find(value=>value.kind==='project_protocol_binding'&&value.projectId==='legacy'),receipt=values.find(value=>value.kind==='project_create_receipt'&&value.projectId==='legacy');
   const initialPlanning={producer:'desktop_main_v1',contract:{protocol:'ordinary_initial_plan_additive_v999'}};binding.initialPlanning=initialPlanning;receipt.initialPlanning=initialPlanning;binding.createReceiptDigest=protocolDigest(receipt);
   for(const value of [binding,receipt]){const bytes=JSON.stringify(value);raw.prepare("UPDATE state_entities SET state_json=?,checksum=? WHERE collection='protocolReceipt' AND entity_key=?").run(bytes,createHash('sha256').update(bytes).digest('hex'),value.id);}
  }else{
   const value={id:'legacy-reserved-head',projectId:'legacy',kind:'initial_plan_acceptance_head',schemaVersion:999,contract:'ordinary_initial_plan_additive_v999'},bytes=JSON.stringify(value);
   raw.prepare("INSERT INTO state_entities(collection,entity_key,project_id,state_json,checksum,revision,updated_at) VALUES('protocolHead',?,?,?,?,1,?)").run(value.id,'legacy',bytes,createHash('sha256').update(bytes).digest('hex'),new Date().toISOString());
  }
 }finally{raw.close();}
 const restored=createHub({silent:true,dataDir:{backend:'sqlite',filePath:f.filePath}});
 try{const result=reader(restored)('legacy',{},f.authority.reader());assert.equal(result.ok,false);assert.notEqual(result.error,undefined);console.log(JSON.stringify({test:'source-reserved-restore',kind,phase:'source-denied',error:result.error}));}finally{restored.closePersistence();}
});
