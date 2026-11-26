import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,realpathSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHub} from '../src/core/hub.js';
import {createProjectInputAuthority} from '../src/core/project-input-authority.js';
import {createSqlitePersistence} from '../src/core/sqlite-persistence.js';
import {DatabaseSync} from 'node:sqlite';
import {workspaceDigest} from '../src/core/room-workspace.js';
import {ACCEPTANCE_WRITER_DIGEST} from '../src/core/initial-plan-acceptance-contract.js';
const contract='ordinary_initial_plan_additive_v1';
function fixture(t,{sqliteFactory,broker={}}={}){
 const root=mkdtempSync(join(tmpdir(),'initial-plan-acceptance-')),filePath=join(root,'state.sqlite');
 const scope={profileId:'a'.repeat(64),workspaceId:'b'.repeat(64)},authority=createProjectInputAuthority(scope),captured=[];
 const backend=createSqlitePersistence({filePath,...(sqliteFactory?{sqliteFactory}:{})}),save=backend.save;backend.save=(factory,scope)=>save(actual=>{const payload=typeof factory==='function'?factory(actual):factory;captured.push(payload);return payload;},scope);
 const hubs=[];let roomCalls=0;const hub=createHub({silent:true,dataDir:{backend:'sqlite',filePath},persistence:backend,brokerClient:{
  async getRoomSnapshot(){roomCalls++;return {ok:true,room:{status:'active'},messages:[{messageId:'msg'}],members:[{status:'active',subject:{kind:'agent',logicalAgentId:'po'}}]};},
  async acquireRoomMembershipLease(){roomCalls++;return {ok:true};},async publishRoomProjectEvent(){roomCalls++;return {ok:true};},...broker}});
 hubs.push(hub);t.after(()=>{for(const item of hubs)item.closePersistence();rmSync(root,{recursive:true,force:true});});
 const control={requestSource:'user',projectInputAuthority:authority.reader()};
 const create=()=>hub.createProject({id:'p',name:'P',goal:'private-original-goal',poAgent:'po',members:[],primaryRoomId:'room',sourceMessageIds:['msg'],requestedStartPolicy:'plan_only',autoAssignPo:false},{requestSource:'user',projectInputAuthority:authority.creator('main-create',contract)});
 return {root,filePath,scope,authority,backend,hub,captured,control,create,track(item){hubs.push(item);return item;},get roomCalls(){return roomCalls;}};
}
async function prepared(t){const f=fixture(t);assert.equal(f.hub.prepareInitialPlanAcceptanceWriter(f.control).ok,true);await f.create();return f;}
function claim(f){const state=f.hub.readInitialPlanInputs('p',f.authority.reader());assert.equal(state.ok,true);assert.equal(state.ownerBinding.protocol,contract);
 const result=f.hub.claimInitialPlanInputs('p',{protocol:contract,fromAgent:'po',enqueueKey:state.enqueueKey,planRunId:'run',planGeneration:1,expectedPlanInputRevision:state.planInputRevision,expectedProjectControlDigest:state.projectControlDigest,startPolicy:'plan_only'},f.authority.planner());assert.equal(result.ok,true);return result.reservation;}
function command(reservation){return {reservationId:reservation.id,enqueueKey:reservation.enqueueKey,planRunId:reservation.planRunId,commandId:reservation.commitCommandId,expectedProjectRevision:reservation.ownerRevision,fromAgent:'po',plan:{analysis:'fixed candidate',phases:[]},tasks:[{id:'initial',title:'Initial task'}]};}

test('new B contract cannot silently downgrade or create before its actual writer profile is ready',async t=>{
 const f=fixture(t);await assert.rejects(async()=>f.create(),/INITIAL_PLAN_PROFILE_UNQUALIFIED/);assert.equal(f.roomCalls,0);assert.equal(f.hub.getProject('p'),undefined);
 assert.throws(()=>f.authority.creator('bad-create','future_contract'),/contract.*unsupported/i);
});
test('actual SQLite policy read failure cannot become a definitive invalidation audit',async t=>{
 let armed=false;const fault=Error('actual policy SELECT unavailable');const f=fixture(t,{sqliteFactory(path){const db=new DatabaseSync(path),prepare=db.prepare.bind(db);db.prepare=sql=>{if(armed&&sql==='SELECT collection,entity_key,project_id,state_json FROM state_entities'){armed=false;throw fault;}return prepare(sql);};return db;}});
 assert.equal(f.hub.prepareInitialPlanAcceptanceWriter(f.control).ok,true);await f.create();claim(f);const revision=f.backend.revision;armed=true;
 assert.throws(()=>f.hub.persistState({type:'project',projectId:'p'}),/actual policy SELECT unavailable/);assert.equal(f.backend.getHealth().status,'failed');assert.equal(f.backend.revision,revision);
 const db=new DatabaseSync(f.filePath,{readOnly:true});try{const rows=db.prepare("SELECT state_json FROM state_entities WHERE collection IN ('protocolHead','protocolReceipt')").all().map(row=>JSON.parse(row.state_json));assert.equal(rows.filter(row=>row.kind==='initial_plan_acceptance_invalidation').length,0);assert.equal(rows.find(row=>row.kind==='initial_plan_acceptance_head').state,'valid');}finally{db.close();}
});
test('floor SELECT failure during candidate validation stays unknown and writes no rejection receipt',async t=>{
 let remaining=0;const fault=Error('actual acceptance floor SELECT unavailable');const f=fixture(t,{sqliteFactory(path){const db=new DatabaseSync(path),prepare=db.prepare.bind(db);db.prepare=sql=>{if(remaining&&sql==='SELECT meta_value FROM state_meta WHERE meta_key=?'&&!--remaining)throw fault;return prepare(sql);};return db;}});
 assert.equal(f.hub.prepareInitialPlanAcceptanceWriter(f.control).ok,true);await f.create();const reservation=claim(f),revision=f.backend.revision;remaining=3;
 let caught;try{f.hub.commitInitialPlan('p',command(reservation),f.authority.planner());}catch(error){caught=error;}
 assert.match(caught?.message??'',/actual acceptance floor SELECT unavailable/);assert.equal(caught.cause,fault);assert.equal(f.backend.getHealth().status,'failed');assert.equal(f.backend.revision,revision);assert.equal(f.hub.getBoard('p').getAllTasks().length,0);
 const db=new DatabaseSync(f.filePath,{readOnly:true});try{assert.equal(db.prepare("SELECT count(*) AS n FROM state_entities WHERE collection='protocolReceipt' AND entity_key=?").get(reservation.commitCommandId).n,0);const row=db.prepare("SELECT state_json FROM state_entities WHERE collection='protocolHead' AND entity_key=?").get(reservation.id+':acceptance');assert.equal(JSON.parse(row.state_json).state,'valid');}finally{db.close();}
});
test('preparation requires original opaque user control and preserves existing complete ordinary write set',t=>{
 const f=fixture(t);f.hub.createProject({id:'legacy',name:'Legacy',goal:'kept',poAgent:'po',members:[],autoAssignPo:false});const revision=f.backend.revision;
 for(const context of [{},{requestSource:'agent',projectInputAuthority:f.authority.reader()},{requestSource:'scheduler',projectInputAuthority:f.authority.reader()},{requestSource:'user',projectInputAuthority:{kind:'desktop_control',...f.scope}}]){
  assert.equal(f.hub.prepareInitialPlanAcceptanceWriter(context).ok,false);assert.equal(f.backend.revision,revision);
 }
 const first=f.hub.prepareInitialPlanAcceptanceWriter(f.control);assert.equal(first.ok,true);assert.match(first.profile.storeId,/^[a-f0-9-]{36}$/);
 assert.equal(f.hub.getProject('legacy').goal,'kept');assert.deepEqual(f.hub.prepareInitialPlanAcceptanceWriter(f.control),first);
});
test('original new claim is born with head in same owner save and fixed candidate commits/replays once',async t=>{
 const f=await prepared(t),reservation=claim(f);assert.equal(reservation.schemaVersion,2);assert.equal(reservation.contract,contract);
 const before=f.hub.readInitialPlanAcceptanceHead('p',f.authority.reader());assert.equal(before.ok,true);assert.equal(before.head.state,'valid');assert.equal(before.head.baseProjectRevision,reservation.ownerRevision);assert.equal(before.head.deltaCount,0);
 const result=f.hub.commitInitialPlan('p',command(reservation),f.authority.planner());assert.equal(result.ok,true);assert.equal(f.hub.getBoard('p').getAllTasks().length,1);
 assert.equal(f.hub.readInitialPlanAcceptanceHead('p',f.authority.reader()).head.state,'committed');
 assert.equal(f.hub.commitInitialPlan('p',command(reservation),f.authority.planner()).reused,true);assert.equal(f.hub.getBoard('p').getAllTasks().length,1);
 assert.equal(JSON.stringify(before).includes('private-original-goal'),false);
});
test('actual claim COMMIT failure leaves neither reservation nor acceptance head and rolls back original heap',async t=>{
 let failCommit=false;const f=fixture(t,{sqliteFactory(path){const db=new DatabaseSync(path),exec=db.exec.bind(db);db.exec=sql=>{if(failCommit&&sql==='COMMIT'){failCommit=false;throw Error('actual born COMMIT failure');}return exec(sql);};return db;}});
 assert.equal(f.hub.prepareInitialPlanAcceptanceWriter(f.control).ok,true);await f.create();const projectRevision=f.hub.getProject('p').projectRevision,revision=f.backend.revision;failCommit=true;assert.throws(()=>claim(f),/actual born COMMIT failure/);
 assert.equal(f.hub.getProject('p').projectRevision,projectRevision);assert.equal(f.backend.revision,revision);assert.equal(f.backend.getHealth().status,'failed');
 const db=new DatabaseSync(f.filePath,{readOnly:true});try{const records=db.prepare("SELECT state_json FROM state_entities WHERE collection IN ('protocolHead','protocolReceipt')").all().map(row=>JSON.parse(row.state_json));assert.equal(records.filter(row=>['initial_plan_reservation','initial_plan_acceptance_head'].includes(row.kind)).length,0);}finally{db.close();}
});
test('actual new Hub reopen retains the exact floor, acceptance head and immutable fixed command outcome',async t=>{
 const f=await prepared(t),reservation=claim(f),profile=f.backend.getWriterProfile(),head=f.hub.readInitialPlanAcceptanceHead('p',f.authority.reader()).head;
 f.hub.closePersistence();const second=f.track(createHub({silent:true,dataDir:{backend:'sqlite',filePath:f.filePath}}));
 assert.deepEqual(second.readInitialPlanAcceptanceHead('p',f.authority.reader()).head,head);assert.deepEqual(second.prepareInitialPlanAcceptanceWriter(f.control).profile,profile.floor);
 const result=second.commitInitialPlan('p',command(reservation),f.authority.planner());assert.equal(result.ok,true);const committed=second.readInitialPlanAcceptanceHead('p',f.authority.reader()).head;second.closePersistence();
 const third=f.track(createHub({silent:true,dataDir:{backend:'sqlite',filePath:f.filePath}}));assert.deepEqual(third.readInitialPlanAcceptanceHead('p',f.authority.reader()).head,committed);assert.equal(third.commitInitialPlan('p',command(reservation),f.authority.planner()).reused,true);assert.equal(third.getBoard('p').getAllTasks().length,1);
});
test('profile2 cannot recover corrupt ordinary bytes before the original semantic owner is bound',async t=>{
 const f=await prepared(t);claim(f);const revision=f.backend.revision;f.hub.closePersistence();
 const raw=new DatabaseSync(f.filePath);try{
  // Fault injection using an explicitly spoofed native function is not a
  // writer-qualification claim: it creates physical corruption on purpose.
  raw.function('kswarm_initial_plan_acceptance_writer_v1',()=>ACCEPTANCE_WRITER_DIGEST);
  raw.prepare("UPDATE state_entities SET state_json='corrupt' WHERE collection='project' AND entity_key='p'").run();
 }finally{raw.close();}
 const store=createSqlitePersistence({filePath:f.filePath});f.track({closePersistence:()=>store.close()});assert.throws(()=>store.load(),/initial_plan_profile_recovery_unqualified/);
 const db=new DatabaseSync(f.filePath,{readOnly:true});try{assert.equal(db.prepare("SELECT meta_value FROM state_meta WHERE meta_key='revision'").get().meta_value,String(revision));assert.equal(db.prepare("SELECT state_json FROM state_entities WHERE collection='project' AND entity_key='p'").get().state_json,'corrupt');}finally{db.close();}
});
test('actual legacy import cannot give birth to an acceptance contract without its original controller',t=>{
 const f=fixture(t),legacyJsonPath=join(f.root,'legacy.json');f.hub.closePersistence();rmSync(f.filePath,{force:true});
 writeFileSync(legacyJsonPath,JSON.stringify({projects:[],protocolReceipts:[{id:'fake',kind:'initial_plan_reservation',contract,projectId:'p'}]}));
 const store=createSqlitePersistence({filePath:f.filePath,legacyJsonPath});f.track({closePersistence:()=>store.close()});assert.throws(()=>store.load(),/initial_plan_legacy_birth_forbidden/);assert.equal(existsSync(legacyJsonPath),true);
 const db=new DatabaseSync(f.filePath,{readOnly:true});try{assert.equal(db.prepare('SELECT count(*) AS n FROM state_entities').get().n,0);assert.equal(db.prepare("SELECT count(*) AS n FROM state_meta WHERE meta_key IN ('revision','migration','writer_floor_v1')").get().n,0);}finally{db.close();}
});
test('unknown raw semantic mutation without revision invalidates head in the original save before fixed commit',async t=>{
 const f=await prepared(t),reservation=claim(f);f.hub.getProject('p').unknownSecurity=undefined;f.hub.persistState({type:'project',projectId:'p'});
 const head=f.hub.readInitialPlanAcceptanceHead('p',f.authority.reader()).head;assert.equal(head.state,'invalidated');
 const result=f.hub.commitInitialPlan('p',command(reservation),f.authority.planner());assert.equal(result.ok,false);assert.equal(result.error,'INITIAL_PLAN_ACCEPTANCE_INVALIDATED');assert.equal(f.hub.getBoard('p').getAllTasks().length,0);
});
for(const terminal of ['close','delete'])test(`original ${terminal} settles a live acceptance in its same owner save`,async t=>{
 const f=await prepared(t);claim(f);const result=terminal==='close'?f.hub.handleCloseProject('p','',f.control):f.hub.deleteProject('p',f.control);assert.equal(result.ok,true);
 const observed=f.hub.readInitialPlanAcceptanceHead('p',f.authority.reader());assert.equal(observed.ok,true);assert.equal(observed.head.state,'invalidated');
 const db=new DatabaseSync(f.filePath,{readOnly:true});try{const rows=db.prepare("SELECT state_json FROM state_entities WHERE collection='protocolReceipt'").all().map(row=>JSON.parse(row.state_json));assert.equal(rows.filter(row=>row.kind==='initial_plan_acceptance_invalidation').length,1);}finally{db.close();}
});
test('actual original Room publication ACK preserves valid acceptance; forged metadata does not',async t=>{
 const f=await prepared(t);claim(f);await f.hub.flushRoomEventOutbox();assert.equal(f.hub.getProject('p').roomEventOutbox[0].status,'published');assert.equal(f.hub.readInitialPlanAcceptanceHead('p',f.authority.reader()).head.state,'valid');
 f.hub.getProject('p').roomEventOutbox[0].status='pending';f.hub.persistState({type:'project',projectId:'p'});assert.equal(f.hub.readInitialPlanAcceptanceHead('p',f.authority.reader()).head.state,'invalidated');
});
test('unchanged original save after actual Room ACK does not invalidate optional absent activity fields',async t=>{
 const f=await prepared(t);claim(f);await f.hub.flushRoomEventOutbox();f.hub.persistState({type:'project',projectId:'p'});assert.equal(f.hub.readInitialPlanAcceptanceHead('p',f.authority.reader()).head.state,'valid');
});
test('unknown undefined in raw activity projection is not erased by original staged projection replacement',async t=>{
 const f=await prepared(t);claim(f);await f.hub.flushRoomEventOutbox();f.hub.getProject('p').activitySnapshot.newPermission=undefined;f.hub.persistState({type:'project',projectId:'p'});assert.equal(f.hub.readInitialPlanAcceptanceHead('p',f.authority.reader()).head.state,'invalidated');
});
test('raw activity unknown accessor cannot run after semantic validation and mutate later SQL semantics',async t=>{
 const f=await prepared(t);claim(f);await f.hub.flushRoomEventOutbox();const project=f.hub.getProject('p');let calls=0;
 Object.defineProperty(project.activitySnapshot,'newPermission',{enumerable:true,get(){calls++;project.agentSelection.poAgent.source='explicit_user';return undefined;}});
 f.hub.persistState({type:'project',projectId:'p'});assert.equal(calls,0);assert.equal(f.hub.readInitialPlanAcceptanceHead('p',f.authority.reader()).head.state,'invalidated');
 const db=new DatabaseSync(f.filePath,{readOnly:true});try{const row=db.prepare("SELECT state_json FROM state_entities WHERE collection='project' AND entity_key='p'").get();assert.equal(JSON.parse(row.state_json).agentSelection.poAgent.source,'system_migration');}finally{db.close();}
});
test('a copy of a genuine original serialized owner write cannot authorize changed project SQL bytes',async t=>{
 const f=await prepared(t);claim(f);const payload=f.captured.at(-1);
 const forged={...payload,entities:payload.entities.map(row=>row.collection==='project'&&row.key==='p'?{...row,value:{...row.value,name:'RAW-WRITER'}}:row)};
 assert.throws(()=>f.backend.save(forged),/WRITE_FRAME|write.*fence|writer.*authority/i);
});
for(const attack of ['full-omission','scoped-omission','ownership-move','human-audit','head-birth','used-frame'])test(`original SQLite fence denies ${attack} outside its original owner frame`,async t=>{
 const f=await prepared(t);claim(f);const original=f.captured.at(-1),payload={...original,entities:structuredClone(original.entities),humanActions:structuredClone(original.humanActions)},revision=f.backend.revision;
 if(attack==='full-omission'){payload.scope={type:'full'};payload.entities=payload.entities.filter(row=>row.collection!=='project');}
 if(attack==='scoped-omission')payload.entities=payload.entities.filter(row=>row.collection!=='board');
 if(attack==='ownership-move')for(const row of payload.entities)if(row.collection==='project'){row.projectId='other';row.value.id='other';}
 if(attack==='human-audit')payload.humanActions.push({collection:'humanAction',key:'fake-human',projectId:'p',value:{id:'fake-human',projectId:'p',action:'fake'}});
 if(attack==='head-birth')payload.entities.push({collection:'protocolHead',key:'fake-head',projectId:'p',value:{id:'fake-head',projectId:'p',kind:'initial_plan_acceptance_head',contract,scope:f.scope,revision:1}});
 assert.throws(()=>f.backend.save(attack==='used-frame'?original:payload),/WRITE_FRAME_REQUIRED/);assert.equal(f.backend.revision,revision);assert.equal(f.backend.getHealth().status,'failed');
 const db=new DatabaseSync(f.filePath,{readOnly:true});try{assert.equal(db.prepare("SELECT count(*) AS n FROM state_entities WHERE collection='project' AND entity_key='p'").get().n,1);assert.equal(db.prepare("SELECT count(*) AS n FROM state_entities WHERE entity_key IN ('fake-human','fake-head')").get().n,0);}finally{db.close();}
});
test('plain legacy-only standalone writes remain possible without signing a new acceptance change',async t=>{
 const f=await prepared(t);claim(f);f.backend.save({scope:{type:'project',projectId:'legacy'},entities:[{collection:'project',key:'legacy',projectId:'legacy',value:{id:'legacy',name:'legacy'}}]});
 const db=new DatabaseSync(f.filePath,{readOnly:true});try{assert.equal(db.prepare("SELECT count(*) AS n FROM state_entities WHERE collection='project'").get().n,2);const row=db.prepare("SELECT state_json FROM state_entities WHERE collection='protocolHead'").get();assert.equal(JSON.parse(row.state_json).state,'valid');}finally{db.close();}
});
test('a real ACK for one Room item cannot launder a forged sibling transport state',async t=>{
 const f=await prepared(t),project=f.hub.getProject('p');
 // Corpus setup through the original owner persistence; this does not claim
 // that a real Broker produced the second local pending projection.
 project.roomEventOutbox.push({...structuredClone(project.roomEventOutbox[0]),projectionEventId:'proj:p#2'});project.roomEventSeq=2;f.hub.persistState({type:'project',projectId:'p'});claim(f);
 assert.equal(f.hub.readInitialPlanAcceptanceHead('p',f.authority.reader()).head.state,'valid');project.roomEventOutbox[0].status='published';await f.hub.flushRoomEventOutbox();
 assert.equal(project.roomEventOutbox[1].status,'published');assert.equal(f.hub.readInitialPlanAcceptanceHead('p',f.authority.reader()).head.state,'invalidated');
});
test('both original pending Room items may really publish without a false acceptance invalidation',async t=>{
 const f=await prepared(t),project=f.hub.getProject('p');project.roomEventOutbox.push({...structuredClone(project.roomEventOutbox[0]),projectionEventId:'proj:p#2'});project.roomEventSeq=2;f.hub.persistState({type:'project',projectId:'p'});claim(f);
 await f.hub.flushRoomEventOutbox();assert.deepEqual(project.roomEventOutbox.map(item=>item.status),['published','published']);assert.equal(f.hub.readInitialPlanAcceptanceHead('p',f.authority.reader()).head.state,'valid');
});
test('new writer profile rejects serialization hooks before they run or change accepted nested semantics',async t=>{
 const f=fixture(t);f.hub.createProject({id:'legacy',name:'Legacy',goal:'kept',poAgent:'po',members:[],autoAssignPo:false});
 assert.equal(f.hub.prepareInitialPlanAcceptanceWriter(f.control).ok,true);await f.create();claim(f);
 let calls=0;f.hub.getProject('legacy').toJSON=function(){calls++;f.hub.getProject('p').agentSelection.poAgent.source='explicit_user';return {...this,toJSON:undefined};};
 const revision=f.backend.revision;assert.throws(()=>f.hub.persistState(),/data.only|serialization.*hook|write.*set.*invalid/i);assert.equal(calls,0);assert.equal(f.backend.revision,revision);
 const db=new DatabaseSync(f.filePath,{readOnly:true});try{const row=db.prepare("SELECT state_json FROM state_entities WHERE collection='project' AND entity_key='p'").get();assert.equal(JSON.parse(row.state_json).agentSelection.poAgent.source,'system_migration');}finally{db.close();}
});
for(const forgeSibling of [false,true])test(`original Workspace ACK ${forgeSibling?'cannot launder a sibling receipt':'preserves acceptance for two real receipts'}`,async t=>{
 let acknowledge=false;const tickets=new Map(),f=fixture(t,{broker:{verifyWorkspaceMappingTicket:async input=>({ok:true,ticket:tickets.get(input.ticketId)}),workspaceMappingApplied:async()=>({ok:acknowledge})}});
 assert.equal(f.hub.prepareInitialPlanAcceptanceWriter(f.control).ok,true);await f.create();const requests=[];
 for(let index=1;index<=2;index++){
  const payload={projectId:'p',roomId:'room',workspaceId:'w',originHostId:'h',bindingId:'b',generation:1,expectedProjectRevision:f.hub.getProject('p').projectRevision,workFolder:realpathSync(f.root),artifactsDir:realpathSync(f.root)};
  const request={ticketId:'ticket'+index,operationId:'op'+index,payload,payloadDigest:workspaceDigest('mapping',payload)};tickets.set(request.ticketId,{...payload,ticketId:request.ticketId,operationId:request.operationId,payloadDigest:request.payloadDigest,userPrincipal:'owner',roomSequence:index});requests.push(request);
  assert.equal((await f.hub.applyWorkspaceMapping('p',request,{requestSource:'user'})).ok,true);
 }
 claim(f);acknowledge=true;
 if(forgeSibling)f.hub.getProject('p').workspaceMappingOperations.op1.status='applied';
 else assert.equal((await f.hub.applyWorkspaceMapping('p',requests[0],{requestSource:'user'})).ok,true);
 assert.equal((await f.hub.applyWorkspaceMapping('p',requests[1],{requestSource:'user'})).ok,true);
 assert.equal(f.hub.readInitialPlanAcceptanceHead('p',f.authority.reader()).head.state,forgeSibling?'invalidated':'valid');
});

test('failed original fixed-command COMMIT emits no successful plan/task diagnostics',async t=>{
 let armed=false;const fault=Error('fixed command real COMMIT failed');const f=fixture(t,{sqliteFactory(path){const db=new DatabaseSync(path),exec=db.exec.bind(db);db.exec=sql=>{if(armed&&sql==='COMMIT'){armed=false;throw fault;}return exec(sql);};return db;}});
 assert.equal(f.hub.prepareInitialPlanAcceptanceWriter(f.control).ok,true);await f.create();const reservation=claim(f),events=f.hub.getEventLog().getEvents();armed=true;
 assert.throws(()=>f.hub.commitInitialPlan('p',command(reservation),f.authority.planner()),/fixed command real COMMIT failed/);
 assert.equal(f.hub.getProject('p').plan,null);assert.equal(f.hub.getBoard('p').getAllTasks().length,0);
 assert.deepEqual(f.hub.getEventLog().getEvents(),events);
 const db=new DatabaseSync(f.filePath,{readOnly:true});try{assert.equal(db.prepare("SELECT count(*) n FROM state_entities WHERE collection='protocolReceipt' AND entity_key=?").get(reservation.commitCommandId).n,0);}finally{db.close();}
});
test('original fixed-command success diagnostics become visible only after durable COMMIT',async t=>{
 let armed=false,f;const beforeCommit=[];f=fixture(t,{sqliteFactory(path){const db=new DatabaseSync(path),exec=db.exec.bind(db);db.exec=sql=>{if(armed&&sql==='COMMIT')beforeCommit.push(f.hub.getEventLog().getEvents().filter(event=>['plan.submitted','tasks.created'].includes(event.type)).length);return exec(sql);};return db;}});
 assert.equal(f.hub.prepareInitialPlanAcceptanceWriter(f.control).ok,true);await f.create();const reservation=claim(f);armed=true;
 assert.equal(f.hub.commitInitialPlan('p',command(reservation),f.authority.planner()).ok,true);assert.deepEqual(beforeCommit,[0]);assert.equal(f.hub.getEventLog().getEvents('plan.submitted').length,1);assert.equal(f.hub.getEventLog().getEvents('tasks.created').length,1);
 assert.equal(f.hub.commitInitialPlan('p',command(reservation),f.authority.planner()).reused,true);assert.equal(f.hub.getEventLog().getEvents('tasks.created').length,1);
});
test('task factory rejection after original plan preparation leaves only its durable rejection, no successful diagnostics',async t=>{
 const f=await prepared(t),reservation=claim(f),input=command(reservation);input.tasks.push({...input.tasks[0]});const events=f.hub.getEventLog().getEvents();
 const result=f.hub.commitInitialPlan('p',input,f.authority.planner());assert.equal(result.ok,false);assert.equal(result.error,'duplicate_local_task_id');assert.equal(f.hub.getProject('p').plan,null);assert.equal(f.hub.getBoard('p').getAllTasks().length,0);assert.deepEqual(f.hub.getEventLog().getEvents(),events);
 const db=new DatabaseSync(f.filePath,{readOnly:true});try{assert.equal(JSON.parse(db.prepare("SELECT state_json FROM state_entities WHERE collection='protocolReceipt' AND entity_key=?").get(input.commandId).state_json).outcome,'rejected');}finally{db.close();}
});
test('known durable command survives post-COMMIT bookkeeping fault and delivers its successful diagnostics once',async t=>{
 let armed=false,f;const fault=Error('postcommit projection setter failed');f=fixture(t,{sqliteFactory(path){const db=new DatabaseSync(path),exec=db.exec.bind(db);db.exec=sql=>{const result=exec(sql);if(armed&&sql==='COMMIT'){armed=false;const project=f.hub.getProject('p'),value=project.committedActivitySeq;Object.defineProperty(project,'committedActivitySeq',{enumerable:true,configurable:true,get(){return value;},set(){throw fault;}});}return result;};return db;}});
 assert.equal(f.hub.prepareInitialPlanAcceptanceWriter(f.control).ok,true);await f.create();const reservation=claim(f);armed=true;let caught;
 try{f.hub.commitInitialPlan('p',command(reservation),f.authority.planner());}catch(error){caught=error;}
 assert.equal(caught?.durableCommitted,true);assert.equal(caught.cause,fault);assert.equal(f.hub.getPersistenceHealth().status,'failed');assert.equal(f.hub.getBoard('p').getAllTasks().length,1);assert.equal(f.hub.getEventLog().getEvents('plan.submitted').length,1);assert.equal(f.hub.getEventLog().getEvents('tasks.created').length,1);
 const db=new DatabaseSync(f.filePath,{readOnly:true});try{assert.equal(JSON.parse(db.prepare("SELECT state_json FROM state_entities WHERE collection='protocolReceipt' AND entity_key=?").get(reservation.commitCommandId).state_json).outcome,'applied');assert.equal(JSON.parse(db.prepare("SELECT state_json FROM state_entities WHERE collection='protocolHead' AND entity_key=?").get(reservation.id+':acceptance').state_json).state,'committed');}finally{db.close();}
});
test('same original command cannot replay its staged heap receipt before real COMMIT, even when the outer COMMIT fails',async t=>{
 let armed=false,f,input,early,durableCount;const fault=Error('outer command failed after attempted early replay');f=fixture(t,{sqliteFactory(path){const db=new DatabaseSync(path),exec=db.exec.bind(db);db.exec=sql=>{if(armed&&sql==='COMMIT'){armed=false;const other=new DatabaseSync(f.filePath,{readOnly:true});try{durableCount=other.prepare("SELECT count(*) n FROM state_entities WHERE collection='protocolReceipt' AND entity_key=?").get(input.commandId).n;}finally{other.close();}early=f.hub.commitInitialPlan('p',input,f.authority.planner());throw fault;}return exec(sql);};return db;}});
 assert.equal(f.hub.prepareInitialPlanAcceptanceWriter(f.control).ok,true);await f.create();input=command(claim(f));armed=true;
 assert.throws(()=>f.hub.commitInitialPlan('p',input,f.authority.planner()),/outer command failed after attempted early replay/);assert.equal(durableCount,0);assert.equal(early?.ok,false);assert.equal(early?.error,'ORDINARY_PROJECT_TRANSACTION_ACTIVE');assert.equal(f.hub.getBoard('p').getAllTasks().length,0);assert.equal(f.hub.getEventLog().getEvents('tasks.created').length,0);
});
test('original authenticated readers and mutation siblings cannot expose staged facts, then resume on the same durable receipt',async t=>{
 let armed=false,f,observed,callbackCalls=0;f=fixture(t,{sqliteFactory(path){const db=new DatabaseSync(path),exec=db.exec.bind(db);db.exec=sql=>{if(armed&&sql==='COMMIT'){armed=false;observed={inputs:f.hub.readInitialPlanInputs('p',f.authority.reader()),head:f.hub.readInitialPlanAcceptanceHead('p',f.authority.reader()),forged:f.hub.readInitialPlanInputs('p',{}),mutation:f.hub.handleApprove('p')};assert.throws(()=>f.hub.mutateProjectState('p',()=>{callbackCalls++;}),/ORDINARY_PROJECT_TRANSACTION_ACTIVE/);assert.throws(()=>f.hub.persistState(),/ORDINARY_PROJECT_TRANSACTION_ACTIVE/);}return exec(sql);};return db;}});
 assert.equal(f.hub.prepareInitialPlanAcceptanceWriter(f.control).ok,true);await f.create();const reservation=claim(f);armed=true;
 const result=f.hub.commitInitialPlan('p',command(reservation),f.authority.planner());assert.equal(result.ok,true);assert.equal(callbackCalls,0);
 for(const key of ['inputs','head','mutation'])assert.deepEqual(observed[key],{ok:false,error:'ORDINARY_PROJECT_TRANSACTION_ACTIVE'});assert.deepEqual(observed.forged,{ok:false,error:'PROJECT_INPUT_AUTHORITY_REQUIRED'});
 assert.equal(f.hub.readInitialPlanInputs('p',f.authority.reader()).commitReceipt.outcome,'applied');assert.equal(f.hub.readInitialPlanAcceptanceHead('p',f.authority.reader()).head.state,'committed');assert.equal(f.hub.commitInitialPlan('p',command(reservation),f.authority.planner()).reused,true);assert.equal(f.backend.getHealth().status,'ok');
});
test('a first claim cannot certify a forged Room transport ACK from the same original heap',async t=>{
 const f=await prepared(t),project=f.hub.getProject('p'),revision=f.backend.revision,projectRevision=project.projectRevision;
 assert.equal(project.roomEventOutbox[0].status,'pending');project.roomEventOutbox[0].status='published';
 const state=f.hub.readInitialPlanInputs('p',f.authority.reader());
 const result=f.hub.claimInitialPlanInputs('p',{protocol:contract,fromAgent:'po',enqueueKey:state.enqueueKey,planRunId:'unverified-projection-run',planGeneration:1,expectedPlanInputRevision:state.planInputRevision,expectedProjectControlDigest:state.projectControlDigest,startPolicy:'plan_only'},f.authority.planner());
 assert.equal(result.ok,false);assert.equal(result.error,'INITIAL_PLAN_PROJECTION_UNVERIFIED');assert.equal(f.backend.revision,revision);assert.equal(project.projectRevision,projectRevision);
 const db=new DatabaseSync(f.filePath,{readOnly:true});try{assert.equal(JSON.parse(db.prepare("SELECT state_json FROM state_entities WHERE collection='project' AND entity_key='p'").get().state_json).roomEventOutbox[0].status,'pending');assert.equal(db.prepare("SELECT count(*) n FROM state_entities WHERE collection='protocolHead'").get().n,0);}finally{db.close();}
});
test('a fixed command cannot certify a forged Room ACK through its original commit-marker branch',async t=>{
 const f=await prepared(t),reservation=claim(f),revision=f.backend.revision,project=f.hub.getProject('p');project.roomEventOutbox[0].status='published';
 const result=f.hub.commitInitialPlan('p',command(reservation),f.authority.planner());
 assert.equal(result.ok,false);assert.equal(result.error,'INITIAL_PLAN_PROJECTION_UNVERIFIED');assert.equal(f.backend.revision,revision);assert.equal(f.hub.getBoard('p').getAllTasks().length,0);
 const db=new DatabaseSync(f.filePath,{readOnly:true});try{assert.equal(JSON.parse(db.prepare("SELECT state_json FROM state_entities WHERE collection='project' AND entity_key='p'").get().state_json).roomEventOutbox[0].status,'pending');assert.equal(db.prepare("SELECT count(*) n FROM state_entities WHERE collection='protocolReceipt' AND entity_key=?").get(reservation.commitCommandId).n,0);}finally{db.close();}
});
for(const phase of ['born','commit'])test(`the actual original ${phase} save cannot certify a transport mutation after its admission check`,async t=>{
 const f=await prepared(t),reservation=phase==='commit'?claim(f):null,save=f.backend.save,revision=f.backend.revision;
 f.backend.save=(factory,scope)=>save(actual=>{f.hub.getProject('p').roomEventOutbox[0].status='published';return typeof factory==='function'?factory(actual):factory;},scope);
 assert.throws(()=>phase==='born'?claim(f):f.hub.commitInitialPlan('p',command(reservation),f.authority.planner()),/INITIAL_PLAN_PROJECTION_UNVERIFIED/);
 assert.equal(f.backend.revision,revision);assert.equal(f.hub.getBoard('p').getAllTasks().length,0);
 const db=new DatabaseSync(f.filePath,{readOnly:true});try{assert.equal(JSON.parse(db.prepare("SELECT state_json FROM state_entities WHERE collection='project' AND entity_key='p'").get().state_json).roomEventOutbox[0].status,'pending');}finally{db.close();}
});
for(const phase of ['born','commit'])test(`a forged Workspace receipt cannot enter the original ${phase} authority branch`,async t=>{
 let ticket;const f=fixture(t,{broker:{verifyWorkspaceMappingTicket:async()=>({ok:true,ticket}),workspaceMappingApplied:async()=>({ok:false})}});
 assert.equal(f.hub.prepareInitialPlanAcceptanceWriter(f.control).ok,true);await f.create();
 const payload={projectId:'p',roomId:'room',workspaceId:'w',originHostId:'h',bindingId:'b',generation:1,expectedProjectRevision:f.hub.getProject('p').projectRevision,workFolder:realpathSync(f.root),artifactsDir:realpathSync(f.root)};
 const request={ticketId:'ticket',operationId:'mapping-op',payload,payloadDigest:workspaceDigest('mapping',payload)};ticket={...payload,ticketId:request.ticketId,operationId:request.operationId,payloadDigest:request.payloadDigest,userPrincipal:'owner',roomSequence:1};
 assert.equal((await f.hub.applyWorkspaceMapping('p',request,{requestSource:'user'})).ok,true);
 const reservation=phase==='commit'?claim(f):null,state=phase==='born'?f.hub.readInitialPlanInputs('p',f.authority.reader()):null,revision=f.backend.revision;
 f.hub.getProject('p').workspaceMappingOperations['mapping-op'].status='applied';
 const result=reservation?f.hub.commitInitialPlan('p',command(reservation),f.authority.planner()):f.hub.claimInitialPlanInputs('p',{protocol:contract,fromAgent:'po',enqueueKey:state.enqueueKey,planRunId:'workspace-projection-run',planGeneration:1,expectedPlanInputRevision:state.planInputRevision,expectedProjectControlDigest:state.projectControlDigest,startPolicy:'plan_only'},f.authority.planner());
 assert.deepEqual(result,{ok:false,error:'INITIAL_PLAN_PROJECTION_UNVERIFIED'});assert.equal(f.backend.revision,revision);
 const db=new DatabaseSync(f.filePath,{readOnly:true});try{assert.equal(JSON.parse(db.prepare("SELECT state_json FROM state_entities WHERE collection='project' AND entity_key='p'").get().state_json).workspaceMappingOperations['mapping-op'].status,'pending');}finally{db.close();}
});
test('real already-persisted Room ACKs and new pending plan events retain the actual original claim and fixed command',async t=>{
 const f=await prepared(t);await f.hub.flushRoomEventOutbox();assert.equal(f.hub.getProject('p').roomEventOutbox[0].status,'published');
 const reservation=claim(f),result=f.hub.commitInitialPlan('p',command(reservation),f.authority.planner());assert.equal(result.ok,true);
 const revision=f.backend.revision;f.hub.getProject('p').roomEventOutbox[0].status='pending';
 const replay=f.hub.commitInitialPlan('p',command(reservation),f.authority.planner());assert.equal(replay.reused,true);assert.deepEqual(replay.receipt,result.receipt);assert.equal(f.backend.revision,revision);
});
test('the original final commit validates raw transport shape before unknown undefined can disappear during SQL serialization',async t=>{
 const f=await prepared(t),reservation=claim(f),save=f.backend.save,revision=f.backend.revision;
 f.backend.save=(factory,scope)=>save(actual=>{f.hub.getProject('p').roomEventOutbox[0].unknownFutureAck=undefined;return typeof factory==='function'?factory(actual):factory;},scope);
 assert.throws(()=>f.hub.commitInitialPlan('p',command(reservation),f.authority.planner()),/INITIAL_PLAN_SEMANTIC_SCHEMA/);
 assert.equal(f.backend.revision,revision);assert.equal(f.hub.getBoard('p').getAllTasks().length,0);
});
for(const phase of ['born','commit'])test(`malformed raw transport is a direct admission refusal before original ${phase} persistence`,async t=>{
 const f=await prepared(t),reservation=phase==='commit'?claim(f):null,state=phase==='born'?f.hub.readInitialPlanInputs('p',f.authority.reader()):null,revision=f.backend.revision;
 f.hub.getProject('p').roomEventOutbox[0].unknownFutureAck=undefined;
 const result=reservation?f.hub.commitInitialPlan('p',command(reservation),f.authority.planner()):f.hub.claimInitialPlanInputs('p',{protocol:contract,fromAgent:'po',enqueueKey:state.enqueueKey,planRunId:'malformed-projection-run',planGeneration:1,expectedPlanInputRevision:state.planInputRevision,expectedProjectControlDigest:state.projectControlDigest,startPolicy:'plan_only'},f.authority.planner());
 assert.deepEqual(result,{ok:false,error:'INITIAL_PLAN_PROJECTION_UNVERIFIED'});assert.equal(f.backend.revision,revision);assert.equal(f.backend.getHealth().status,'ok');
});
