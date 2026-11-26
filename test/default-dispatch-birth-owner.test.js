import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {sha256Hex} from '../src/core/state-scope.js';
import {createHub} from '../src/core/hub.js';
import {createSqlitePersistence} from '../src/core/sqlite-persistence.js';
import {createProjectInputAuthority} from '../src/core/project-input-authority.js';
import {createSqlitePersistence as createOldPersistence} from './fixtures/profile3-original-writer/sqlite-persistence.js';
const profile='ordinary_default_dispatch_writer_v1';
const scope={profileId:'a'.repeat(64),workspaceId:'b'.repeat(64)};
function fixture(t,{sqliteFactory}={}){
 const root=mkdtempSync(join(tmpdir(),'default-dispatch-birth-')),filePath=join(root,'state.sqlite'),authority=createProjectInputAuthority(scope);let backend,hub;const hubs=[],effects=[];
 const open=()=>{backend=createSqlitePersistence({filePath,...(sqliteFactory?{sqliteFactory}:{})});hub=createHub({silent:true,dataDir:{backend:'sqlite',filePath},persistence:backend,projectStorageRoot:join(root,'projects'),bridge:{requestTask(input){effects.push(input);return{ok:true};}},brokerClient:{async getRoomSnapshot(){return{ok:true,room:{status:'active'},messages:[{messageId:'msg'}],members:['po','worker'].map(logicalAgentId=>({status:'active',subject:{kind:'agent',logicalAgentId}}))};},async acquireRoomMembershipLease(){return{ok:true};}}});hubs.push(hub);};open();
 t.after(()=>{for(const item of hubs)item.closePersistence();rmSync(root,{recursive:true,force:true});});
 const control={requestSource:'user',projectInputAuthority:authority.reader()};
 const prepare=()=>{assert.equal(typeof hub.prepareDefaultDispatchWriter,'function');return hub.prepareDefaultDispatchWriter(control);};
 const create=async(id='p',contract=null)=>hub.createProject({id,name:'P',goal:'original business goal',poAgent:'po',members:['worker'],primaryRoomId:'room',sourceMessageIds:['msg'],requestedStartPolicy:'plan_only',autoAssignPo:false},{requestSource:'user',projectInputAuthority:contract?authority.creator('main-create-'+id,contract):authority.reader()});
 const read=()=>{assert.equal(typeof hub.readDefaultDispatchBirths,'function');return hub.readDefaultDispatchBirths('p',authority.reader());};
 const raw=fn=>{const db=new DatabaseSync(filePath,{readOnly:true});try{return fn(db);}finally{db.close();}};
 return{root,filePath,authority,control,prepare,create,read,effects,raw,get hub(){return hub;},get backend(){return backend;},reopen(){hub.closePersistence();open();}};
}
async function prepared(t,options){const f=fixture(t,options);assert.equal(f.prepare().ok,true);await f.create();return f;}
function add(f,tasks=[{id:'a',title:'Task A',brief:'Actual original brief',assignedAgent:'worker'}]){return f.hub.handleHumanAddTasks('p',tasks,{requestSource:'user'});}
function births(f){return f.raw(db=>db.prepare("SELECT state_json FROM state_entities WHERE collection='protocolReceipt'").all().map(r=>JSON.parse(r.state_json)).filter(r=>r.kind==='ordinary_default_dispatch_birth'));}
test('fresh original Main control installs one distinct floor4 and denies forged or non-user preparation without writes',t=>{
 const f=fixture(t),rev=f.backend.revision;assert.equal(typeof f.hub.prepareDefaultDispatchWriter,'function');
 for(const c of [{},{requestSource:'agent',projectInputAuthority:f.authority.reader()},{requestSource:'scheduler',projectInputAuthority:f.authority.reader()},{requestSource:'user',projectInputAuthority:{kind:'desktop_control',...scope}}]){assert.equal(f.hub.prepareDefaultDispatchWriter(c).ok,false);assert.equal(f.backend.revision,rev);}
 const first=f.prepare();assert.equal(first.ok,true);assert.equal(first.profile.profile,profile);assert.equal(first.profile.schemaVersion,4);assert.deepEqual(f.prepare(),first);
});
test('actual Human task birth and generation head commit together, ignore DTO generation, recover after reopen',async t=>{
 const f=await prepared(t);assert.equal(add(f,[{id:'a',title:'Task A',businessExecutionGeneration:999,executionContentHash:'forged'}]).ok,true);
 const result=f.read();assert.equal(result.ok,true);assert.equal(result.tasks.length,1);assert.equal(result.tasks[0].businessExecutionGeneration,1);assert.match(result.tasks[0].contentDigest,/^[a-f0-9]{64}$/);assert.equal(births(f).length,1);
 const heads=f.raw(db=>db.prepare("SELECT state_json FROM state_entities WHERE collection='protocolHead'").all().map(r=>JSON.parse(r.state_json)).filter(r=>r.kind==='ordinary_default_dispatch_generation'));assert.equal(heads.length,1);assert.equal(heads[0].birthReceiptId,births(f)[0].id);
 f.reopen();assert.deepEqual(f.read(),result);
});
test('same task duplicate, runtime attempt and another task do not create a new business generation for the old task',async t=>{
 const f=await prepared(t);assert.equal(add(f).ok,true);const first=f.read().tasks[0];const duplicate=add(f);assert.equal(duplicate.error,'duplicate_local_task_id');assert.equal(births(f).length,1);
 const task=f.hub.getBoard('p').getTask(first.taskId);task.attempt=23;task.activeRunId=null;task.status='pending';f.hub.persistState({type:'project',projectId:'p'});assert.deepEqual(f.read().tasks[0],first);
 assert.equal(add(f,[{id:'b',title:'Task B'}]).ok,true);const result=f.read();assert.equal(result.tasks.length,2);assert.deepEqual(result.tasks.find(x=>x.taskId===first.taskId),first);assert.equal(births(f).length,2);
});
test('same-generation actual content changes are typed conflicts and never mint a replacement birth',async t=>{
 const f=await prepared(t);assert.equal(add(f).ok,true);const before=births(f),id=f.read().tasks[0].taskId;f.hub.getBoard('p').getTask(id).brief='changed actual payload';f.hub.persistState({type:'project',projectId:'p'});
 assert.equal(f.read().error,'DEFAULT_DISPATCH_CONTENT_CONFLICT');assert.deepEqual(births(f),before);
});
test('old pending tasks are needs-reconciliation, never silently generation one on fresh floor install',async t=>{
 const f=fixture(t);await f.create();assert.equal(add(f).ok,true);assert.equal(f.prepare().error,'DEFAULT_DISPATCH_MIGRATION_REQUIRED');assert.equal(births(f).length,0);assert.equal(f.hub.checkProjectExecutionStart('p').ok,true);
});
test('direct public board insertion cannot be adopted as an authenticated task birth by original save',async t=>{
 const f=await prepared(t);f.hub.getBoard('p').addTasksChecked([{id:'unowned',title:'Unowned insertion'}]);const rev=f.backend.revision;assert.throws(()=>f.hub.persistState({type:'project',projectId:'p'}),/DEFAULT_DISPATCH_BIRTH_UNVERIFIED/);assert.equal(f.backend.revision,rev);assert.equal(births(f).length,0);
});
test('birth receipt and head roll back with the original SQLite COMMIT failure',async t=>{
 let armed=false;const fault=Error('original birth COMMIT fault');const f=await prepared(t,{sqliteFactory(path){const db=new DatabaseSync(path),exec=db.exec.bind(db);db.exec=sql=>{if(armed&&sql==='COMMIT')throw fault;return exec(sql);};return db;}});const rev=f.backend.revision;armed=true;assert.throws(()=>add(f),/original birth COMMIT fault/);armed=false;assert.equal(f.backend.revision,rev);assert.equal(births(f).length,0);f.reopen();assert.equal(f.hub.getBoard('p').getAllTasks().length,0);
});
test('read requires original reader and the exact current project scope',async t=>{
 const f=await prepared(t);assert.equal(add(f).ok,true);for(const token of [{kind:'desktop_control',...scope},f.authority.planner(),createProjectInputAuthority({...scope,workspaceId:'c'.repeat(64)}).reader()])assert.equal(f.hub.readDefaultDispatchBirths('p',token).ok,false);
});
test('old floor cannot be transparently upgraded or replaced by the opt-in preparation',t=>{
 const f=fixture(t);assert.equal(f.hub.prepareInitialPlanAcceptanceWriter(f.control).ok,true);const before=f.backend.getWriterProfile().floor;assert.equal(f.prepare().ok,false);assert.deepEqual(f.backend.getWriterProfile().floor,before);
});
test('the exact original profile3 module rejects floor4 before writes, and lacks the new SQL function',async t=>{
 const f=await prepared(t);assert.equal(add(f).ok,true);f.hub.closePersistence();let actual;const execs=[];const old=createOldPersistence({filePath:f.filePath,sqliteFactory(path){const db=new DatabaseSync(path),exec=db.exec.bind(db);actual=db;db.exec=sql=>{execs.push(sql);return exec(sql);};return db;}});t.after(()=>old.close());assert.throws(()=>old.load(),/writer.*profile|floor.*integrity/);assert.deepEqual(execs,[]);assert.throws(()=>actual.prepare('SELECT kswarm_default_dispatch_writer_v1()').get(),/no such function/);
});
test('new metadata floor is not runtime qualification: shared execution gate and both dispatch siblings send zero effects',async t=>{
 const f=await prepared(t);assert.equal(add(f).ok,true);assert.equal(f.hub.checkProjectExecutionStart('p').error,'DEFAULT_DISPATCH_EXECUTION_UNAVAILABLE');
 const result=f.hub.handleRequestDispatch('p','po');assert.equal(result.error,'DEFAULT_DISPATCH_EXECUTION_UNAVAILABLE');assert.equal((await f.hub.dispatchWorkspaceTask('p',{taskId:f.hub.getBoard('p').getAllTasks()[0].id},{requestSource:'user'})).error,'DEFAULT_DISPATCH_EXECUTION_UNAVAILABLE');assert.equal(f.effects.length,0);assert.equal(existsSync(join(f.root,'projects','p','handoffs')),false);assert.equal(f.hub.getBoard('p').getAllTasks()[0].activeRunId,null);
});
test('real COMMIT succeeds then reporting fails: committed birth bytes survive failstop and reopen',async t=>{
 let armed=false;const fault=Error('after actual committed birth');const f=await prepared(t,{sqliteFactory(path){const db=new DatabaseSync(path),exec=db.exec.bind(db);db.exec=sql=>{const result=exec(sql);if(armed&&sql==='COMMIT'){armed=false;throw fault;}return result;};return db;}});armed=true;assert.throws(()=>add(f),/after actual committed birth/);assert.equal(f.backend.getHealth().status,'failed');const committed=births(f);assert.equal(committed.length,1);f.reopen();assert.equal(f.read().ok,true);assert.equal(f.read().tasks[0].birthReceiptId,committed[0].id);
});
test('actual PO task creation uses the same original birth seam',async t=>{
 const f=await prepared(t);assert.equal(f.hub.handleCreateTasks('p',[{id:'po-task',title:'PO actual task'}],'po').ok,true);assert.equal(f.read().ok,true);assert.equal(births(f).length,1);
});
test('actual v1 planner claim/commit works in floor4 storage without granting runtime',async t=>{
 const f=fixture(t);assert.equal(f.prepare().ok,true);await f.create('p','ordinary_initial_plan_additive_v1');const input=f.hub.readInitialPlanInputs('p',f.authority.reader());assert.equal(input.ok,true);
 const claim=f.hub.claimInitialPlanInputs('p',{protocol:'ordinary_initial_plan_additive_v1',fromAgent:'po',enqueueKey:input.enqueueKey,planRunId:'actual-plan-run',planGeneration:1,expectedPlanInputRevision:input.planInputRevision,expectedProjectControlDigest:input.projectControlDigest,startPolicy:'plan_only'},f.authority.planner());assert.equal(claim.ok,true,JSON.stringify(claim));const r=claim.reservation;
 const result=f.hub.commitInitialPlan('p',{reservationId:r.id,enqueueKey:r.enqueueKey,planRunId:r.planRunId,commandId:r.commitCommandId,expectedProjectRevision:r.ownerRevision,fromAgent:'po',plan:{analysis:'actual v1 plan',phases:[]},tasks:[{id:'planned',title:'Actual planner task'}]},f.authority.planner());assert.equal(result.ok,true,JSON.stringify(result));assert.equal(f.read().ok,true);assert.equal(births(f).length,1);assert.equal(f.hub.checkProjectExecutionStart('p').error,'DEFAULT_DISPATCH_EXECUTION_UNAVAILABLE');
});
test('caller copy of a protected birth cannot change content through generic persistence save',async t=>{
 const f=await prepared(t);assert.equal(add(f).ok,true);const birth=births(f)[0],rev=f.backend.revision;assert.throws(()=>f.backend.save({scope:{type:'project',projectId:'p'},entities:[{collection:'protocolReceipt',key:birth.id,projectId:'p',value:{...birth,contentDigest:'0'.repeat(64)}}]}),/INITIAL_PLAN_WRITE_FRAME_REQUIRED/);assert.equal(f.backend.revision,rev);assert.deepEqual(births(f),[birth]);
});
test('actual old profile3 native functions on an already-open probe connection cannot write after floor4 installation',t=>{
 const f=fixture(t),oldDb=new DatabaseSync(f.filePath);t.after(()=>oldDb.close());
 // The probe retains the exact old native function registration, without
 // pretending two exclusive original backend owners are simultaneously valid.
 return import('./fixtures/profile3-original-writer/sqlite-writer-floor.js').then(({createSqliteWriterFloor})=>{createSqliteWriterFloor(oldDb);assert.equal(f.prepare().ok,true);for(const sql of ["INSERT INTO state_meta(meta_key,meta_value) VALUES('old-probe','x')","UPDATE state_meta SET meta_value='0' WHERE meta_key='revision'","DELETE FROM state_entities"]){assert.throws(()=>oldDb.exec(sql),/kswarm_default_dispatch_writer_v1|writer_floor/);}assert.equal(f.raw(db=>db.prepare("SELECT count(*) n FROM state_meta WHERE meta_key='old-probe'").get().n),0);});
});
test('actual plan revision adds a new original task but preserves the old child business identity',async t=>{
 const f=await prepared(t);assert.equal(f.hub.handleSubmitPlan('p',{phases:[{id:'phase',items:[]}]},'po').ok,true);assert.equal(add(f).ok,true);const first=f.read().tasks[0];
 const result=f.hub.handleRevisePlan('p',{reason:'Append only',changes:[{type:'add',phaseId:'phase',item:{id:'new-plan-task',title:'Appended task'}}]},'po');assert.equal(result.ok,true,JSON.stringify(result));const read=f.read();assert.equal(read.ok,true);assert.equal(read.tasks.length,2);assert.deepEqual(read.tasks.find(x=>x.taskId===first.taskId),first);assert.equal(births(f).length,2);
});
test('missing physical birth is reconciliation, not a new receipt minted by a normal save',async t=>{
 const f=await prepared(t);assert.equal(add(f).ok,true);const birth=births(f)[0],writer=f.backend.getWriterProfile().floor;f.hub.closePersistence();const db=new DatabaseSync(f.filePath);try{db.function('kswarm_default_dispatch_writer_v1',()=>writer.writerProfileDigest);db.prepare("DELETE FROM state_entities WHERE collection='protocolReceipt' AND entity_key=?").run(birth.id);}finally{db.close();}
 f.reopen();const read=f.read();assert.equal(read.ok,false);assert.equal(births(f).length,0);f.hub.persistState({type:'project',projectId:'p'});assert.equal(births(f).length,0);
});
test('existing duplicate task identities cannot be laundered by a later real original task addition',async t=>{
 const f=await prepared(t);assert.equal(add(f,[{id:'a',title:'A'},{id:'b',title:'B'}]).ok,true);const tasks=f.hub.getBoard('p').getAllTasks(),before=births(f),rev=f.backend.revision;tasks[1].id=tasks[0].id;assert.throws(()=>add(f,[{id:'c',title:'C'}]),/DEFAULT_DISPATCH_BIRTH_UNVERIFIED/);assert.equal(f.backend.revision,rev);assert.deepEqual(births(f),before);
});
test('missing actual physical empty board is not an original project creation proof',async t=>{
 const f=await prepared(t),floor=f.backend.getWriterProfile().floor,rev=f.backend.revision,db=new DatabaseSync(f.filePath);try{db.function('kswarm_default_dispatch_writer_v1',()=>floor.writerProfileDigest);db.prepare("DELETE FROM state_entities WHERE collection='board' AND entity_key='p'").run();}finally{db.close();}assert.throws(()=>f.hub.persistState({type:'project',projectId:'p'}),/DEFAULT_DISPATCH_BIRTH_UNVERIFIED/);assert.equal(f.backend.revision,rev);assert.equal(births(f).length,0);
});
for(const mode of ['erase','swap'])test('a normal unrelated original save cannot '+mode+' existing task identities',async t=>{
  const f=await prepared(t);assert.equal(add(f,[{id:'a',title:'A'},{id:'b',title:'B'}]).ok,true);const board=f.hub.getBoard('p'),tasks=board.getAllTasks(),rev=f.backend.revision;
  if(mode==='erase')board.loadTasks([tasks[0]]);else{const id=tasks[0].id;tasks[0].id=tasks[1].id;tasks[1].id=id;}
  assert.throws(()=>f.hub.persistState({type:'project',projectId:'p'}),/DEFAULT_DISPATCH_BIRTH_UNVERIFIED/);assert.equal(f.backend.revision,rev);assert.equal(births(f).length,2);
});
for(const table of ['state_entities','state_entity_history'])test('fresh floor4 checks actual '+table+' again inside its native transaction',t=>{
 let armed=false;const f=fixture(t,{sqliteFactory(path){const db=new DatabaseSync(path),exec=db.exec.bind(db);db.exec=sql=>{if(armed&&sql==='BEGIN IMMEDIATE'){armed=false;const json=JSON.stringify({id:'late-original',name:'Preserved original'});db.prepare('INSERT INTO '+table+'(collection,entity_key,project_id,state_json,checksum,revision,updated_at) VALUES(?,?,?,?,?,?,?)').run('project','late-original','late-original',json,sha256Hex(json),1,'original');}return exec(sql);};return db;}});armed=true;assert.throws(()=>f.prepare(),/DEFAULT_DISPATCH_MIGRATION_REQUIRED/);assert.equal(f.raw(db=>db.prepare('SELECT count(*) n FROM '+table).get().n),1);assert.equal(f.raw(db=>db.prepare("SELECT count(*) n FROM state_meta WHERE meta_key='writer_floor_v1'").get().n),0);
});
test('actual physical project content change cannot yield a current metadata read from the unchanged heap',async t=>{
 const f=await prepared(t);assert.equal(add(f).ok,true);const floor=f.backend.getWriterProfile().floor,db=new DatabaseSync(f.filePath);try{db.function('kswarm_default_dispatch_writer_v1',()=>floor.writerProfileDigest);const json=db.prepare("SELECT state_json FROM state_entities WHERE collection='project' AND entity_key='p'").get().state_json,value=JSON.parse(json);value.goal='Different physical business goal';const changed=JSON.stringify(value);db.prepare("UPDATE state_entities SET state_json=?,checksum=? WHERE collection='project' AND entity_key='p'").run(changed,sha256Hex(changed));}finally{db.close();}assert.equal(f.read().ok,false);assert.equal(births(f).length,1);
});
