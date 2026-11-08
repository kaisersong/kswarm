import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {createHub} from '../src/core/hub.js';
import {createSqlitePersistence} from '../src/core/sqlite-persistence.js';
import {createProjectInputAuthority} from '../src/core/project-input-authority.js';
const scope={profileId:'a'.repeat(64),workspaceId:'b'.repeat(64)};
function fixture(t,{onExec,onAfterExec}={}){
 const root=mkdtempSync(join(tmpdir(),'fresh-plan-writer-')),filePath=join(root,'state.sqlite');
 const authority=createProjectInputAuthority(scope),context={requestSource:'user',projectInputAuthority:authority.reader()};
 let db,backend,hub;const hubs=[],sql=[];
 const open=()=>{
  backend=createSqlitePersistence({filePath,sqliteFactory(path){db=new DatabaseSync(path);const exec=db.exec.bind(db);db.exec=statement=>{sql.push(statement);const current={db,exec,backend,hub,filePath};if(onExec)onExec(statement,current);const result=exec(statement);if(onAfterExec)onAfterExec(statement,current);return result;};return db;}});
  hub=createHub({silent:true,dataDir:{backend:'sqlite',filePath},persistence:backend});hubs.push(hub);
 };open();t.after(()=>{for(const h of hubs)h.closePersistence();rmSync(root,{recursive:true,force:true});});
 return {get hub(){return hub;},get backend(){return backend;},get db(){return db;},context,sql,
  fresh:(ctx=context)=>hub.prepareFreshInitialPlanAcceptanceWriter(ctx),
  reopen(){hub.closePersistence();open();},
  snapshot:()=>JSON.stringify(db.prepare('SELECT meta_key,meta_value FROM state_meta ORDER BY meta_key').all()),
 };
}
test('fixed fresh preparation uses actual native commit once and only the same empty owner may read it again',t=>{
 const f=fixture(t);assert.equal(f.fresh().ok,true);assert.equal(f.backend.getWriterProfile().floor.schemaVersion,2);
 const before=f.snapshot(),revision=f.backend.revision;assert.equal(f.fresh().ok,true);assert.equal(f.snapshot(),before);assert.equal(f.backend.revision,revision);
});
test('an original legacy project is rejected without native writes while old generic preparation stays compatible',t=>{
 const f=fixture(t);f.hub.createProject({id:'legacy',name:'Legacy',goal:'kept',poAgent:'po',members:[],autoAssignPo:false});
 const before=f.snapshot(),count=f.sql.length;assert.deepEqual(f.fresh(),{ok:false,error:'INITIAL_PLAN_FRESH_STORE_REQUIRED'});assert.equal(f.snapshot(),before);assert.equal(f.sql.length,count);assert.equal(f.backend.getHealth().status,'ok');
 assert.equal(f.hub.prepareInitialPlanAcceptanceWriter(f.context).ok,true);
});
test('history-only physical state cannot be mistaken for a fresh database',t=>{
 const f=fixture(t);f.db.prepare('INSERT INTO state_entity_history(collection,entity_key,project_id,state_json,checksum,revision,updated_at) VALUES(?,?,?,?,?,?,?)').run('project','historic','historic','{}','old',1,'old');
 const before=f.snapshot(),count=f.sql.length;assert.deepEqual(f.fresh(),{ok:false,error:'INITIAL_PLAN_FRESH_STORE_REQUIRED'});assert.equal(f.snapshot(),before);assert.equal(f.sql.length,count);assert.equal(f.backend.getHealth().status,'ok');
});
test('a reopened floor2 does not reconstitute the original empty preparation epoch',t=>{
 const f=fixture(t);assert.equal(f.fresh().ok,true);f.reopen();const before=f.snapshot();assert.deepEqual(f.fresh(),{ok:false,error:'INITIAL_PLAN_FRESH_RECONCILIATION_REQUIRED'});assert.equal(f.snapshot(),before);assert.equal(f.backend.getHealth().status,'ok');
});
test('fixed fresh preparation refuses agent, scheduler and copied authority without any write',t=>{
 const f=fixture(t),before=f.snapshot();
 for(const ctx of [{},{requestSource:'agent',projectInputAuthority:f.context.projectInputAuthority},{requestSource:'scheduler',projectInputAuthority:f.context.projectInputAuthority},{requestSource:'user',projectInputAuthority:{...scope,kind:'desktop_control'}}])assert.deepEqual(f.fresh(ctx),{ok:false,error:'INITIAL_PLAN_WRITER_AUTHORITY_REQUIRED'});
 assert.equal(f.snapshot(),before);
});
test('actual in-BEGIN physical race is refused before floor installation and preserves the original native failure',t=>{
 let armed=false;const faultMessage='INITIAL_PLAN_FRESH_STORE_REQUIRED';
 const f=fixture(t,{onExec(statement,{db}){if(armed&&statement==='BEGIN IMMEDIATE'){armed=false;db.prepare('INSERT INTO state_entity_history(collection,entity_key,project_id,state_json,checksum,revision,updated_at) VALUES(?,?,?,?,?,?,?)').run('project','raced','raced','{}','raced',1,'old');}}});
 armed=true;assert.throws(()=>f.fresh(),error=>error.name==='PersistenceCommitError'&&error.cause?.message===faultMessage);
 assert.equal(f.db.prepare("SELECT count(*) n FROM state_meta WHERE meta_key='writer_floor_v1'").get().n,0);assert.equal(f.backend.getHealth().status,'failed');
});
for(const kind of ['board','humanAction','project'])test(`full original heap refuses ${kind} even after physical rows were externally removed`,t=>{
 const f=fixture(t),value=kind==='board'?{projectId:'orphan',tasks:[]}:kind==='humanAction'?{id:'audit',action:'old',projectId:null}:{id:'orphan',name:'Old',members:[]};
 const row={collection:kind,key:kind==='humanAction'?'audit':'orphan',projectId:kind==='humanAction'?null:'orphan',value};
 f.backend.save({scope:{type:'full'},entities:kind==='humanAction'?[]:[row],humanActions:kind==='humanAction'?[row]:[]});f.reopen();
 f.db.exec('DELETE FROM state_entities');f.db.exec('DELETE FROM state_entity_history');
 const before=f.snapshot(),count=f.sql.length;assert.deepEqual(f.fresh(),{ok:false,error:'INITIAL_PLAN_FRESH_STORE_REQUIRED'});assert.equal(f.snapshot(),before);assert.equal(f.sql.length,count);assert.equal(f.backend.getHealth().status,'ok');
});
test('physical-only state which was not loaded into the Hub also refuses fresh preparation',t=>{
 const f=fixture(t);f.backend.save({scope:{type:'full'},entities:[{collection:'board',key:'physical',projectId:'physical',value:{projectId:'physical',tasks:[]}}]});
 const before=f.snapshot(),count=f.sql.length;assert.deepEqual(f.fresh(),{ok:false,error:'INITIAL_PLAN_FRESH_STORE_REQUIRED'});assert.equal(f.snapshot(),before);assert.equal(f.sql.length,count);
});
test('a real second SQLite connection wins before BEGIN and its committed history survives refusal',t=>{
 let armed=false;const f=fixture(t,{onExec(statement,{filePath}){if(armed&&statement==='BEGIN IMMEDIATE'){armed=false;const other=new DatabaseSync(filePath);try{other.prepare('INSERT INTO state_entity_history(collection,entity_key,project_id,state_json,checksum,revision,updated_at) VALUES(?,?,?,?,?,?,?)').run('project','foreign','foreign','{}','foreign',1,'old');}finally{other.close();}}}});
 armed=true;assert.throws(()=>f.fresh(),error=>error.name==='PersistenceCommitError'&&error.cause?.message==='INITIAL_PLAN_FRESH_STORE_REQUIRED');
 assert.equal(f.db.prepare("SELECT count(*) n FROM state_entity_history WHERE entity_key='foreign'").get().n,1);assert.equal(f.db.prepare("SELECT count(*) n FROM state_meta WHERE meta_key='writer_floor_v1'").get().n,0);
});
test('a changed native revision with still-empty entity bytes is not admitted as fresh',t=>{
 let armed=false;const f=fixture(t,{onExec(statement,{filePath}){if(armed&&statement==='BEGIN IMMEDIATE'){armed=false;const other=new DatabaseSync(filePath);try{other.prepare("UPDATE state_meta SET meta_value='2' WHERE meta_key='revision'").run();}finally{other.close();}}}});
 armed=true;assert.throws(()=>f.fresh(),error=>error.name==='PersistenceCommitError'&&error.cause?.message==='stale_sqlite_writer_revision');
 assert.equal(f.db.prepare("SELECT meta_value FROM state_meta WHERE meta_key='revision'").get().meta_value,'2');assert.equal(f.db.prepare("SELECT count(*) n FROM state_meta WHERE meta_key='writer_floor_v1'").get().n,0);
});
test('swallowed native reentry after known fresh COMMIT keeps the original cause and durable flag',t=>{
 let armed=false,inner;const f=fixture(t,{onAfterExec(statement,{backend}){if(armed&&statement==='COMMIT'){armed=false;try{backend.close();}catch(error){inner=error;}}}});
 armed=true;assert.throws(()=>f.fresh(),error=>error.name==='PersistenceCommitError'&&error.durableCommitted===true&&error.cause===inner);
 assert.equal(f.db.prepare("SELECT count(*) n FROM state_meta WHERE meta_key='writer_floor_v1'").get().n,1);assert.equal(f.backend.getHealth().status,'failed');
});
test('fresh COMMIT and rollback failures keep both actual errors and never claim healthy',t=>{
 const first=Error('actual fresh COMMIT fault'),second=Error('actual fresh ROLLBACK fault');let armed=false;
 const f=fixture(t,{onExec(statement){if(armed&&statement==='COMMIT')throw first;if(armed&&statement==='ROLLBACK')throw second;}});
 armed=true;try{assert.throws(()=>f.fresh(),error=>error.name==='PersistenceCommitError'&&error.cause instanceof AggregateError&&error.cause.errors[0]===first&&error.cause.errors[1]===second&&!error.durableCommitted);assert.equal(f.backend.getHealth().status,'failed');}
 finally{armed=false;f.db.exec('ROLLBACK');}
});
test('accessor authority is rejected without invoking it or touching native state',t=>{
 const f=fixture(t);let invoked=0;const input={requestSource:'user',get projectInputAuthority(){invoked++;return f.context.projectInputAuthority;}};
 const before=f.snapshot(),count=f.sql.length;assert.deepEqual(f.fresh(input),{ok:false,error:'INITIAL_PLAN_WRITER_AUTHORITY_REQUIRED'});assert.equal(invoked,0);assert.equal(f.snapshot(),before);assert.equal(f.sql.length,count);
});
test('an otherwise empty owner with historical unqualified access cannot mint a new preparation epoch',t=>{
 const f=fixture(t);f.hub.getProject('missing');const before=f.snapshot(),count=f.sql.length;
 assert.deepEqual(f.fresh(),{ok:false,error:'INITIAL_PLAN_FRESH_RECONCILIATION_REQUIRED'});assert.equal(f.snapshot(),before);assert.equal(f.sql.length,count);
});
