import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {createHub} from '../src/core/hub.js';
import {sha256Hex} from '../src/core/state-scope.js';
import {createSqlitePersistence} from '../src/core/sqlite-persistence.js';
import {createProjectInputAuthority} from '../src/core/project-input-authority.js';
import {createSqlitePersistence as createOldPersistence} from './fixtures/b1-original-writer/sqlite-persistence.js';
const scope={profileId:'a'.repeat(64),workspaceId:'b'.repeat(64)};
function fixture(t,{sqliteFactory}={}){
 const root=mkdtempSync(join(tmpdir(),'durable-dispatch-profile-')),filePath=join(root,'state.sqlite'),authority=createProjectInputAuthority(scope),effects=[],hubs=[];let hub,backend;
 const open=()=>{backend=createSqlitePersistence({filePath,...(sqliteFactory?{sqliteFactory}:{})});hub=createHub({silent:true,dataDir:{backend:'sqlite',filePath},persistence:backend,projectStorageRoot:join(root,'projects'),bridge:{requestTask(input){effects.push(input);return{ok:true};}},brokerClient:{async getRoomSnapshot(){return{ok:true,room:{status:'active'},messages:[{messageId:'msg'}],members:['po','worker'].map(logicalAgentId=>({status:'active',subject:{kind:'agent',logicalAgentId}}))};},async acquireRoomMembershipLease(){return{ok:true};}}});hubs.push(hub);};open();
 t.after(()=>{for(const h of hubs)h.closePersistence();rmSync(root,{recursive:true,force:true});});
 const control={requestSource:'user',projectInputAuthority:authority.reader()};
 return{filePath,authority,control,effects,get hub(){return hub;},get backend(){return backend;},prepare(){assert.equal(typeof hub.prepareDurableDispatchWriter,'function');return hub.prepareDurableDispatchWriter(control);},async create(contract=null){return hub.createProject({id:'p',name:'P',goal:'G',poAgent:'po',members:['worker'],primaryRoomId:'room',sourceMessageIds:['msg'],requestedStartPolicy:'plan_only',autoAssignPo:false},contract?{requestSource:'user',projectInputAuthority:authority.creator('main-create-p',contract)}:control);},add(tasks=[{id:'a',title:'Task A',brief:'Original execution content',assignedAgent:'worker'}]){return hub.handleHumanAddTasks('p',tasks,{requestSource:'user'});},births(){return hub.readDefaultDispatchBirths('p',authority.reader());},reopen(){hub.closePersistence();open();},raw(fn){const db=new DatabaseSync(filePath,{readOnly:true});try{return fn(db);}finally{db.close();}}};
}
test('fresh durable dispatch profile has a distinct native floor and original preparation authority',t=>{
 const f=fixture(t),revision=f.backend.revision;assert.equal(typeof f.hub.prepareDurableDispatchWriter,'function');
 for(const context of [{},{requestSource:'agent',projectInputAuthority:f.authority.reader()},{requestSource:'scheduler',projectInputAuthority:f.authority.reader()},{requestSource:'user',projectInputAuthority:{kind:'desktop_control',...scope}}]){assert.equal(f.hub.prepareDurableDispatchWriter(context).ok,false);assert.equal(f.backend.revision,revision);}
 const result=f.prepare();assert.equal(result.ok,true);assert.equal(result.profile.schemaVersion,5);assert.equal(result.profile.profile,'ordinary_durable_dispatch_writer_v1');assert.deepEqual(f.prepare(),result);
 const sql=f.raw(db=>db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger'").all().map(row=>row.sql).join('\n'));assert.match(sql,/kswarm_durable_dispatch_writer_v1/);assert.doesNotMatch(sql,/kswarm_default_dispatch_writer_v1/);
});
test('original Human births remain durable without granting execution or adopting a DTO generation',async t=>{
 const f=fixture(t);assert.equal(f.prepare().ok,true);assert.equal((await f.create()).id,'p');assert.equal(f.add([{id:'a',title:'A',businessExecutionGeneration:77}]).ok,true);const first=f.births();assert.equal(first.ok,true);assert.equal(first.tasks[0].businessExecutionGeneration,1);assert.match(first.tasks[0].childKey,/^default-dispatch-child:/);
 assert.equal(f.hub.checkProjectExecutionStart('p').error,'DEFAULT_DISPATCH_EXECUTION_UNAVAILABLE');assert.deepEqual(f.effects,[]);f.reopen();assert.deepEqual(f.births(),first);
 assert.equal(f.add([{id:'b',title:'B'}]).ok,true);assert.deepEqual(f.births().tasks.find(row=>row.taskId===first.tasks[0].taskId),first.tasks[0]);
 const task=f.hub.getBoard('p').getTask(first.tasks[0].taskId);task.brief='changed same generation';f.hub.persistState({type:'project',projectId:'p'});assert.equal(f.births().error,'DEFAULT_DISPATCH_CONTENT_CONFLICT');assert.deepEqual(f.effects,[]);
});
test('durable profile never upgrades an existing floor or adopts existing project rows',async t=>{
 const f=fixture(t);assert.equal(f.hub.prepareDefaultDispatchWriter(f.control).ok,true);const before=f.raw(db=>db.prepare("SELECT meta_value FROM state_meta WHERE meta_key='writer_floor_v1'").get().meta_value);assert.equal(f.prepare().ok,false);assert.equal(f.raw(db=>db.prepare("SELECT meta_value FROM state_meta WHERE meta_key='writer_floor_v1'").get().meta_value),before);
 const legacy=fixture(t);assert.equal((await legacy.create()).id,'p');assert.equal(legacy.prepare().error,'DEFAULT_DISPATCH_MIGRATION_REQUIRED');
});
test('a real previous floor4 writer cannot reopen the new native floor',t=>{
 const f=fixture(t);assert.equal(f.prepare().ok,true);f.hub.closePersistence();const old=createOldPersistence({filePath:f.filePath});try{assert.throws(()=>old.load(),/writer.*profile|floor.*integrity/i);}finally{old.close();}
});

for(const table of ['state_entities','state_entity_history'])test('fresh durable floor rechecks original '+table+' inside native BEGIN',t=>{
 let armed=false;const f=fixture(t,{sqliteFactory(path){const db=new DatabaseSync(path),exec=db.exec.bind(db);db.exec=sql=>{if(armed&&sql==='BEGIN IMMEDIATE'){armed=false;const json=JSON.stringify({id:'late-original',name:'Preserve original'});db.prepare('INSERT INTO '+table+'(collection,entity_key,project_id,state_json,checksum,revision,updated_at) VALUES(?,?,?,?,?,?,?)').run('project','late-original','late-original',json,sha256Hex(json),1,'original');}return exec(sql);};return db;}});armed=true;assert.throws(()=>f.prepare(),/DEFAULT_DISPATCH_MIGRATION_REQUIRED/);assert.equal(f.raw(db=>db.prepare('SELECT count(*) n FROM '+table).get().n),1);assert.equal(f.raw(db=>db.prepare("SELECT count(*) n FROM state_meta WHERE meta_key='writer_floor_v1'").get().n),0);
});
for(const phase of ['before','after'])test('durable birth preserves actual '+phase+' COMMIT truth and original cause',async t=>{
 let armed=false;const fault=Error('durable profile '+phase+' actual COMMIT');const f=fixture(t,{sqliteFactory(path){const db=new DatabaseSync(path),exec=db.exec.bind(db);db.exec=sql=>{if(armed&&sql==='COMMIT'&&phase==='before'){armed=false;throw fault;}const result=exec(sql);if(armed&&sql==='COMMIT'&&phase==='after'){armed=false;throw fault;}return result;};return db;}});
 assert.equal(f.prepare().ok,true);assert.equal((await f.create()).id,'p');armed=true;assert.throws(()=>f.add(),error=>{assert.match(String(error),new RegExp(phase+' actual COMMIT'));return true;});assert.equal(f.backend.getHealth().status,'failed');
 const records=f.raw(db=>db.prepare("SELECT state_json FROM state_entities WHERE collection='protocolReceipt'").all().map(row=>JSON.parse(row.state_json)).filter(row=>row.kind==='ordinary_default_dispatch_birth'));assert.equal(records.length,phase==='after'?1:0);f.reopen();assert.equal(f.births().ok,true);assert.equal(f.births().tasks.length,phase==='after'?1:0);if(phase==='before'){assert.equal(f.add().ok,true);assert.equal(f.births().tasks.length,1);}else assert.equal(f.births().tasks[0].birthReceiptId,records[0].id);
});
test('both original dispatch siblings remain effect-free on the new storage profile',async t=>{
 const f=fixture(t);assert.equal(f.prepare().ok,true);await f.create();assert.equal(f.add().ok,true);assert.equal(f.hub.handleRequestDispatch('p','po').error,'DEFAULT_DISPATCH_EXECUTION_UNAVAILABLE');assert.equal((await f.hub.dispatchWorkspaceTask('p',{taskId:f.births().tasks[0].taskId},{requestSource:'user'})).error,'DEFAULT_DISPATCH_EXECUTION_UNAVAILABLE');assert.deepEqual(f.effects,[]);
});
test('original project and task transactions own a durable dispatch plan head',async t=>{
 const f=fixture(t);assert.equal(f.prepare().ok,true);await f.create();assert.equal(typeof f.hub.readDefaultDispatchPlan,'function');const read=()=>f.hub.readDefaultDispatchPlan('p',f.authority.reader());
 const empty=read();assert.equal(empty.ok,true);assert.equal(empty.plan.revision,1);assert.equal(empty.plan.dispatchGeneration,1);assert.deepEqual(empty.plan.tasks,[]);assert.equal(f.add().ok,true);const first=read();assert.equal(first.ok,true);assert.equal(first.plan.revision,2);assert.equal(first.plan.tasks.length,1);const birth=f.births().tasks[0];assert.equal(first.plan.tasks[0].childKey,birth.childKey);
 const beforeRevision=f.backend.revision;assert.deepEqual(read(),first);assert.equal(f.backend.revision,beforeRevision);f.hub.persistState({type:'project',projectId:'p'});assert.deepEqual(read(),first);f.reopen();assert.deepEqual(read(),first);
 assert.equal(f.add([{id:'b',title:'B'}]).ok,true);const next=read();assert.equal(next.plan.revision,3);assert.equal(next.plan.tasks.length,2);assert.deepEqual(next.plan.tasks.find(row=>row.taskId===birth.taskId),first.plan.tasks[0]);assert.equal(next.plan.dispatchGeneration,1);assert.deepEqual(f.effects,[]);
});
test('plan metadata cannot adopt another scope or mint a baseline on old floor4',async t=>{
 const f=fixture(t);assert.equal(f.prepare().ok,true);await f.create();assert.equal(typeof f.hub.readDefaultDispatchPlan,'function');const revision=f.backend.revision,foreign=createProjectInputAuthority({...scope,workspaceId:'c'.repeat(64)});
 assert.equal(f.hub.readDefaultDispatchPlan('p',foreign.reader()).ok,false);assert.equal(f.hub.readDefaultDispatchPlan('p',{kind:'desktop_control',...scope}).ok,false);assert.equal(f.backend.revision,revision);
 const old=fixture(t);assert.equal(old.hub.prepareDefaultDispatchWriter(old.control).ok,true);await old.create();const before=old.backend.revision;assert.equal(old.hub.readDefaultDispatchPlan('p',old.authority.reader()).error,'DURABLE_DISPATCH_PROFILE_UNQUALIFIED');assert.equal(old.backend.revision,before);
});
test('actual PO additions and initial planner commit advance only their original plan transaction',async t=>{
 const f=fixture(t);assert.equal(f.prepare().ok,true);await f.create();const read=()=>f.hub.readDefaultDispatchPlan('p',f.authority.reader());assert.equal(f.hub.handleCreateTasks('p',[{id:'a',title:'A'},{id:'b',title:'B'}],'po').ok,true);assert.equal(read().plan.revision,2);assert.equal(read().plan.tasks.length,2);const before=read();assert.equal(f.add([{id:'a',title:'duplicate'}]).ok,false);assert.deepEqual(read(),before);
 const planned=fixture(t);assert.equal(planned.prepare().ok,true);await planned.create('ordinary_initial_plan_additive_v1');const input=planned.hub.readInitialPlanInputs('p',planned.authority.reader());assert.equal(input.ok,true);const claim=planned.hub.claimInitialPlanInputs('p',{protocol:'ordinary_initial_plan_additive_v1',fromAgent:'po',enqueueKey:input.enqueueKey,planRunId:'durable-actual-plan-run',planGeneration:1,expectedPlanInputRevision:input.planInputRevision,expectedProjectControlDigest:input.projectControlDigest,startPolicy:'plan_only'},planned.authority.planner());assert.equal(claim.ok,true,JSON.stringify(claim));const r=claim.reservation;
 const result=planned.hub.commitInitialPlan('p',{reservationId:r.id,enqueueKey:r.enqueueKey,planRunId:r.planRunId,commandId:r.commitCommandId,expectedProjectRevision:r.ownerRevision,fromAgent:'po',plan:{analysis:'actual original plan',phases:[]},tasks:[{id:'planned',title:'Planned'}]},planned.authority.planner());assert.equal(result.ok,true,JSON.stringify(result));const plan=planned.hub.readDefaultDispatchPlan('p',planned.authority.reader());assert.equal(plan.ok,true,JSON.stringify(plan));assert.equal(plan.plan.revision,2);assert.equal(plan.plan.tasks.length,1);assert.deepEqual(planned.effects,[]);
});
test('unowned plan version and accessor cannot make an old dispatch snapshot current',async t=>{
 const f=fixture(t);f.prepare();await f.create();f.add();const project=f.hub.getProject('p'),read=()=>f.hub.readDefaultDispatchPlan('p',f.authority.reader());const initial=read();project.plan={version:2};f.hub.persistState({type:'project',projectId:'p'});assert.equal(read().error,'DURABLE_DISPATCH_PLAN_UNVERIFIED');f.reopen();assert.equal(read().error,'DURABLE_DISPATCH_PLAN_UNVERIFIED');
 const g=fixture(t);g.prepare();await g.create();let getters=0;Object.defineProperty(g.hub.getProject('p'),'plan',{configurable:true,get(){getters++;throw Error('forbidden plan getter');}});assert.equal(g.hub.readDefaultDispatchPlan('p',g.authority.reader()).error,'DURABLE_DISPATCH_PLAN_UNVERIFIED');assert.equal(getters,0);assert.equal(initial.plan.revision,2);
});
test('native head divergence is observed without repairing it or adopting it on the next task addition',async t=>{
 const f=fixture(t);f.prepare();await f.create();f.add();const before=f.hub.readDefaultDispatchPlan('p',f.authority.reader()),floor=f.backend.getWriterProfile().floor,db=new DatabaseSync(f.filePath);let altered;
 try{db.function('kswarm_durable_dispatch_writer_v1',()=>floor.writerProfileDigest);altered=JSON.stringify({...before.plan,revision:before.plan.revision+1});db.prepare("UPDATE state_entities SET state_json=?,checksum=? WHERE collection='protocolHead' AND entity_key=?").run(altered,sha256Hex(altered),before.plan.id);}finally{db.close();}
 const revision=f.backend.revision;assert.equal(f.hub.readDefaultDispatchPlan('p',f.authority.reader()).error,'DURABLE_DISPATCH_PLAN_UNVERIFIED');assert.throws(()=>f.add([{id:'b',title:'B'}]),/DURABLE_DISPATCH_PLAN_UNVERIFIED/);assert.equal(f.backend.revision,revision);assert.equal(f.raw(db=>db.prepare("SELECT state_json FROM state_entities WHERE collection='protocolHead' AND entity_key=?").get(before.plan.id).state_json),altered);assert.deepEqual(f.effects,[]);
});
test('an actual second Hub plan commit cannot leave the first Hub reporting its old dispatch head current',async t=>{
 const f=fixture(t);f.prepare();await f.create();f.add();const before=f.hub.readDefaultDispatchPlan('p',f.authority.reader());assert.equal(before.ok,true);
 // Same explicit lock-reclamation fault profile as stale-sqlite-writer.test.js.
 const otherBackend=createSqlitePersistence({filePath:f.filePath,isProcessAlive:()=>false}),other=createHub({silent:true,persistence:otherBackend,dataDir:{backend:'sqlite',filePath:f.filePath}});
 try{other.getProject('p').plan={version:7};other.persistState({type:'project',projectId:'p'});assert.equal(other.readDefaultDispatchPlan('p',f.authority.reader()).ok,false);const observed=f.hub.readDefaultDispatchPlan('p',f.authority.reader());assert.equal(observed.ok,false,JSON.stringify(observed));assert.equal(observed.error,'DURABLE_DISPATCH_PLAN_UNVERIFIED');assert.deepEqual(f.effects,[]);}finally{other.closePersistence();}
});
test('a real task addition cannot authenticate a preceding unowned heap plan version change',async t=>{
 const f=fixture(t);f.prepare();await f.create();f.add();const before=f.hub.readDefaultDispatchPlan('p',f.authority.reader()),revision=f.backend.revision;f.hub.getProject('p').plan={version:9};
 assert.throws(()=>f.add([{id:'b',title:'B'}]),/DURABLE_DISPATCH_PLAN_UNVERIFIED/);assert.equal(f.backend.revision,revision);assert.deepEqual(f.raw(db=>JSON.parse(db.prepare("SELECT state_json FROM state_entities WHERE collection='protocolHead' AND entity_key=?").get(before.plan.id).state_json)),before.plan);assert.deepEqual(f.effects,[]);
});
test('original plan submit and a zero-task revise carry their own authenticated head changes',async t=>{
 const f=fixture(t);f.prepare();await f.create();const read=()=>f.hub.readDefaultDispatchPlan('p',f.authority.reader());assert.equal(f.hub.handleSubmitPlan('p',{analysis:'Original empty plan',phases:[]},'po').ok,true);const first=read();assert.equal(first.ok,true);assert.equal(first.plan.revision,2);assert.equal(first.plan.planVersion,1);assert.deepEqual(first.plan.tasks,[]);
 assert.equal(f.hub.handleRevisePlan('p',{reason:'Actual original revision',changes:[]},'po').ok,true);const next=read();assert.equal(next.ok,true);assert.equal(next.plan.revision,3);assert.equal(next.plan.planVersion,2);assert.deepEqual(next.plan.tasks,first.plan.tasks);f.reopen();assert.deepEqual(read(),next);assert.deepEqual(f.effects,[]);
});
test('a physical project version change is refused even when no global revision was advanced',async t=>{
 const f=fixture(t);f.prepare();await f.create();f.add();const floor=f.backend.getWriterProfile().floor,db=new DatabaseSync(f.filePath);
 try{db.function('kswarm_durable_dispatch_writer_v1',()=>floor.writerProfileDigest);const row=db.prepare("SELECT state_json FROM state_entities WHERE collection='project' AND entity_key='p'").get(),value=JSON.parse(row.state_json);value.plan={version:12};const data=JSON.stringify(value);db.prepare("UPDATE state_entities SET state_json=?,checksum=? WHERE collection='project' AND entity_key='p'").run(data,sha256Hex(data));}finally{db.close();}
 assert.equal(f.hub.readDefaultDispatchPlan('p',f.authority.reader()).error,'DURABLE_DISPATCH_PLAN_UNVERIFIED');assert.deepEqual(f.effects,[]);
});
test('a real native revision change during the metadata read cannot leave a qualified snapshot',async t=>{
 let armed=false,changed=false;const f=fixture(t,{sqliteFactory(path){const db=new DatabaseSync(path),prepare=db.prepare.bind(db);db.prepare=sql=>{const statement=prepare(sql);if(sql==='SELECT collection,entity_key,project_id,state_json FROM state_entities'){const all=statement.all.bind(statement);statement.all=(...args)=>{const rows=all(...args);if(armed){armed=false;changed=true;prepare("UPDATE state_meta SET meta_value=CAST(CAST(meta_value AS INTEGER)+1 AS TEXT) WHERE meta_key='revision'").run();}return rows;};}return statement;};return db;}});
 f.prepare();await f.create();f.add();armed=true;assert.equal(f.hub.readDefaultDispatchPlan('p',f.authority.reader()).error,'DURABLE_DISPATCH_PLAN_UNVERIFIED');assert.equal(changed,true);assert.deepEqual(f.effects,[]);
});
test('all nine actual precompiled writes on a held original floor4 connection fail against the new native floor',async t=>{
 const f=fixture(t);let db;const old=createOldPersistence({filePath:f.filePath,isProcessAlive:()=>false,sqliteFactory(path){db=new DatabaseSync(path);return db;}});try{
  old.load();const statements=[];for(const table of ['state_entities','state_entity_history']){
   statements.push(db.prepare("INSERT INTO "+table+"(collection,entity_key,project_id,state_json,checksum,revision,updated_at) VALUES('project','old-probe','p','{}','old',1,'old')"));statements.push(db.prepare("UPDATE "+table+" SET updated_at='old' WHERE entity_key='p'"));statements.push(db.prepare("DELETE FROM "+table+" WHERE entity_key='p'"));
  }statements.push(db.prepare("INSERT INTO state_meta(meta_key,meta_value) VALUES('old-probe','old')"));statements.push(db.prepare("UPDATE state_meta SET meta_value='old' WHERE meta_key='revision'"));statements.push(db.prepare("DELETE FROM state_meta WHERE meta_key='revision'"));
  assert.equal(f.prepare().ok,true);await f.create();f.add();assert.throws(()=>db.prepare('SELECT kswarm_durable_dispatch_writer_v1()').get(),/no such function/);const before=f.raw(db=>({entities:db.prepare('SELECT count(*) n FROM state_entities').get().n,history:db.prepare('SELECT count(*) n FROM state_entity_history').get().n,revision:db.prepare("SELECT meta_value FROM state_meta WHERE meta_key='revision'").get().meta_value}));let rejected=0;for(const statement of statements){assert.throws(()=>statement.run(),/no such function|writer.*profile|floor/i);rejected++;}assert.equal(rejected,9);assert.deepEqual(f.raw(db=>({entities:db.prepare('SELECT count(*) n FROM state_entities').get().n,history:db.prepare('SELECT count(*) n FROM state_entity_history').get().n,revision:db.prepare("SELECT meta_value FROM state_meta WHERE meta_key='revision'").get().meta_value})),before);
 }finally{old.close();}
});
