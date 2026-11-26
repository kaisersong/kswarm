import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSqlitePersistence} from '../src/core/sqlite-persistence.js';
import {bindInitialPlanWriteBackend} from '../src/core/initial-plan-write-fence.js';
import {TASK_WRITER_PROFILE,TASK_WRITER_DIGEST,TASK_ADDITIVE_DESCRIPTOR,ADDITIVE_INITIAL_PLAN_DESCRIPTOR,ACCEPTANCE_WRITER_DIGEST,semanticWriterForFloor,isAcceptanceRecord} from '../src/core/initial-plan-acceptance-contract.js';
import {createSqlitePersistence as createOriginalProfile2Persistence} from './fixtures/profile2-original-writer/sqlite-persistence.js';
import {bindInitialPlanWriteBackend as bindOriginalProfile2Backend} from './fixtures/profile2-original-writer/initial-plan-write-fence.js';
import {semanticWriterForFloor as originalProfile2WriterForFloor} from './fixtures/profile2-original-writer/initial-plan-acceptance-contract.js';
const scope={profileId:'a'.repeat(64),workspaceId:'b'.repeat(64)};
function fixture(t,{originalProfile2=false}={}){
 const root=mkdtempSync(join(tmpdir(),'task-writer-registry-')),filePath=join(root,'state.sqlite'),execs=[];let actualDb;
 const store=(originalProfile2?createOriginalProfile2Persistence:createSqlitePersistence)({filePath,sqliteFactory(path){const db=new DatabaseSync(path),exec=db.exec.bind(db);actualDb=db;db.exec=sql=>{execs.push(sql);return exec(sql);};return db;}});store.load();const owner=(originalProfile2?bindOriginalProfile2Backend:bindInitialPlanWriteBackend)(store);t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 const row=()=>({collection:'project',key:'p',projectId:'p',value:{id:'p',name:'original'}});
 const prepare=()=>{const profile=owner.prepare(scope);store.save(()=>owner.freeze({requiredWriterProfile:profile,entities:[row()],scope:{type:'full'}},{profilePreparation:profile}));return store.getWriterProfile().floor;};
 const raw=fn=>{const db=new DatabaseSync(filePath);try{return fn(db);}finally{db.close();}};
 return{root,filePath,store,owner,row,prepare,raw,execs,get actualDb(){return actualDb;}};
}
test('closed semantic registry distinguishes current metadata implementation from the actual original incomplete profile2 writer',()=>{
 const floor={schemaVersion:3,profile:TASK_WRITER_PROFILE,writerProfileDigest:TASK_WRITER_DIGEST};assert.equal(semanticWriterForFloor(floor).schemaVersion,3);assert.equal(semanticWriterForFloor(floor).writable,true);assert.equal(originalProfile2WriterForFloor(floor).writable,false);
 for(const value of [{...floor,schemaVersion:2},{...floor,schemaVersion:4},{...floor,writerProfileDigest:ACCEPTANCE_WRITER_DIGEST},{...floor,profile:'future'},null])assert.equal(semanticWriterForFloor(value),undefined);
});
test('the actual original incomplete profile2 module cannot prepare floor3 through its handle or a plain requested DTO',t=>{
 const f=fixture(t,{originalProfile2:true}),revision=f.store.revision;
 assert.throws(()=>f.owner.prepare(scope,TASK_WRITER_PROFILE),/writer_profile_unsupported/);
 assert.throws(()=>f.store.save({requiredWriterProfile:{profile:TASK_WRITER_PROFILE,scope,storeId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'},entities:[f.row()]}),/INITIAL_PLAN_WRITE_FRAME_REQUIRED|writer_profile_unsupported/);
 assert.equal(f.store.revision,revision);f.raw(db=>{assert.equal(db.prepare("SELECT count(*) n FROM state_meta WHERE meta_key='writer_floor_v1'").get().n,0);assert.equal(db.prepare('SELECT count(*) n FROM state_entities').get().n,0);});
});
test('the actual original profile2 module rejects floor3 before PRAGMA/schema/recovery writes and never registers its function',t=>{
 const f=fixture(t,{originalProfile2:true}),old=f.prepare();f.store.close();const floor={...old,schemaVersion:3,profile:TASK_WRITER_PROFILE,writerProfileDigest:TASK_WRITER_DIGEST};
 // Deliberate privileged corruption injection: this is not a qualification or
 // a supported upgrade. Build the exact stored future SQL from original guards.
 f.raw(db=>{const triggers=db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name GLOB 'kswarm_writer_floor_*'").all();for(const row of triggers)db.exec('DROP TRIGGER '+row.name);
  db.prepare("UPDATE state_meta SET meta_value=? WHERE meta_key='writer_floor_v1'").run(JSON.stringify(floor));for(const row of triggers)db.exec(row.sql.replaceAll('kswarm_initial_plan_acceptance_writer_v1','kswarm_task_addition_writer_v2').replaceAll(ACCEPTANCE_WRITER_DIGEST,TASK_WRITER_DIGEST));
 });f.execs.length=0;
 assert.throws(()=>f.store.load(),/writer_profile_unsupported/);assert.deepEqual(f.execs,[]);assert.throws(()=>f.actualDb.prepare('SELECT kswarm_task_addition_writer_v2()').get(),/no such function/);
 f.raw(db=>{assert.deepEqual(JSON.parse(db.prepare("SELECT meta_value FROM state_meta WHERE meta_key='writer_floor_v1'").get().meta_value),floor);assert.equal(JSON.parse(db.prepare("SELECT state_json FROM state_entities WHERE collection='project'").get().state_json).name,'original');});
});
for(const [name,value] of [
 ['v2 binding',{kind:'project_protocol_binding',schemaVersion:1,initialPlanning:{contract:TASK_ADDITIVE_DESCRIPTOR}}],
 ['unknown descriptor',{kind:'project_protocol_binding',schemaVersion:1,initialPlanning:{contract:{...ADDITIVE_INITIAL_PLAN_DESCRIPTOR,protocol:'ordinary_initial_plan_additive_future'}}}],
 ['unknown reserved kind',{kind:'initial_plan_acceptance_future',schemaVersion:1,contract:ADDITIVE_INITIAL_PLAN_DESCRIPTOR.protocol}],
 ['crossed schema',{kind:'initial_plan_acceptance_head',schemaVersion:2,contract:ADDITIVE_INITIAL_PLAN_DESCRIPTOR.protocol}],
 ['missing descriptor',{kind:'initial_plan_reservation',schemaVersion:2}],
 ['wrong schema type',{kind:'initial_plan_reservation',schemaVersion:'2'}],
 ['missing schema',{kind:'initial_plan_commit_receipt'}],
 ['invalid schema',{kind:'initial_plan_reservation',schemaVersion:-1}],
 ['empty contract slot',{kind:'project_protocol_binding',schemaVersion:1,initialPlanning:{contract:{}}}],
 ['null contract protocol',{kind:'project_create_receipt',schemaVersion:1,initialPlanning:{contract:{protocol:null}}}],
 ['future delta without contract',{kind:'initial_plan_additive_delta_v3',schemaVersion:3}],
 ['damaged headless create descriptor',{kind:'project_create_receipt',schemaVersion:1,snapshot:{initialPlanWriterStoreId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}}],
])test('floor2 original private frame cannot sign '+name,t=>{
 const f=fixture(t);f.prepare();const revision=f.store.revision,record={id:'reserved',projectId:'p',scope,...value};
 assert.throws(()=>f.store.save(()=>f.owner.freeze({scope:{type:'full'},entities:[f.row(),{collection:'protocolReceipt',key:record.id,projectId:'p',value:record}]},{birthIds:[JSON.stringify(['protocolReceipt',record.id])]})),/INITIAL_PLAN_WRITE_FRAME_REQUIRED/);
 assert.equal(isAcceptanceRecord(record),true);assert.equal(f.store.revision,revision);f.raw(db=>{assert.equal(db.prepare("SELECT count(*) n FROM state_entities WHERE collection='protocolReceipt'").get().n,0);assert.equal(JSON.parse(db.prepare("SELECT state_json FROM state_entities WHERE collection='project'").get().state_json).name,'original');});
});
