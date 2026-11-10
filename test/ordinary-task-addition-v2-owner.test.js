import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {TASK_WRITER_DIGEST} from '../src/core/initial-plan-acceptance-contract.js';
import {readTaskAdditionOwnerRecord} from '../src/core/initial-plan-semantic-schema.js';
import {DatabaseSync} from 'node:sqlite';
import {protocolDigest} from '../src/core/project-protocol.js';
import {workspaceDigest} from '../src/core/room-workspace.js';
import {roomSourceFor} from './fixtures/room-user-source-data.js';
import {createHub} from '../src/core/hub.js';
import {createProjectInputAuthority} from '../src/core/project-input-authority.js';
import {createSqlitePersistence} from '../src/core/sqlite-persistence.js';
const contract='ordinary_initial_plan_additive_v2',profile='ordinary_task_addition_writer_v2';
const scope={profileId:'a'.repeat(64),workspaceId:'b'.repeat(64)};
function fixture(t,{sqliteFactory,broker={},bridge}={}){
 const root=mkdtempSync(join(tmpdir(),'ordinary-task-v2-')),filePath=join(root,'state.sqlite'),authority=createProjectInputAuthority(scope),backend=createSqlitePersistence({filePath,...(sqliteFactory?{sqliteFactory}:{})}),hubs=[];let roomCalls=0;
 const hub=createHub({bridge,silent:true,dataDir:{backend:'sqlite',filePath},persistence:backend,brokerClient:{async getRoomSnapshot(){roomCalls++;return{ok:true,room:{status:'active'},members:[{status:'active',subject:{kind:'agent',logicalAgentId:'po'}}]};},async acquireRoomMembershipLease(){roomCalls++;return{ok:true};},...broker}});hubs.push(hub);
 t.after(()=>{for(const item of hubs)item.closePersistence();rmSync(root,{recursive:true,force:true});});
 const control={requestSource:'user',projectInputAuthority:authority.reader()};
 const prepare=()=>{assert.equal(typeof hub.prepareOrdinaryTaskInputWriter,'function','original Hub must implement the versioned writer preparation');return hub.prepareOrdinaryTaskInputWriter(control);};
 const create=()=>hub.createProject({id:'p',name:'P',goal:'original goal',poAgent:'po',members:[],primaryRoomId:'room',requestedStartPolicy:'plan_only',autoAssignPo:false},{requestSource:'user',projectInputAuthority:authority.creator('main-v2-create',contract)});
 return{root,filePath,authority,backend,hub,control,prepare,create,track(item){hubs.push(item);return item;},get roomCalls(){return roomCalls;}};
}
test('v2 task metadata writer preparation uses real original opaque user scope and preserves the entire ordinary aggregate',t=>{
 const f=fixture(t);f.hub.createProject({id:'legacy',name:'Legacy',goal:'keep',poAgent:'po',members:[],autoAssignPo:false});
 assert.equal(typeof f.hub.prepareOrdinaryTaskInputWriter,'function');const revision=f.backend.revision;
 for(const control of [{},{requestSource:'agent',projectInputAuthority:f.authority.reader()},{requestSource:'scheduler',projectInputAuthority:f.authority.reader()},{requestSource:'user',projectInputAuthority:{kind:'desktop_control',...scope}}]){assert.equal(f.hub.prepareOrdinaryTaskInputWriter(control).ok,false);assert.equal(f.backend.revision,revision);}
 const result=f.prepare();assert.equal(result.ok,true);assert.equal(result.profile.schemaVersion,3);assert.equal(result.profile.profile,profile);assert.match(result.profile.storeId,/^[a-f0-9-]{36}$/);assert.equal(f.hub.getProject('legacy').goal,'keep');assert.deepEqual(f.prepare(),result);
});
test('existing zero-delta floor2 is never silently upgraded or relabelled as task metadata floor3',t=>{
 const f=fixture(t),old=f.hub.prepareInitialPlanAcceptanceWriter(f.control);assert.equal(old.ok,true);assert.equal(old.profile.schemaVersion,2);const revision=f.backend.revision;
 assert.equal(typeof f.hub.prepareOrdinaryTaskInputWriter,'function');assert.equal(f.prepare().ok,false);assert.deepEqual(f.backend.getWriterProfile().floor,old.profile);assert.equal(f.backend.revision,revision);
});
test('a new v2 contract cannot create a Room before its actual profile is prepared',async t=>{
 const f=fixture(t);await assert.rejects(async()=>f.create(),/INITIAL_PLAN_PROFILE_UNQUALIFIED/);assert.equal(f.roomCalls,0);assert.equal(f.hub.getProject('p'),undefined);
 assert.equal(f.prepare().ok,true);await f.create();const result=f.hub.getProjectProtocolBinding('p');assert.equal(result.classification,'ordinary');assert.equal(result.binding.initialPlanning.contract.protocol,contract);assert.equal(result.binding.initialPlanning.contract.acceptanceSchemaVersion,2);assert.equal(result.binding.initialPlanning.contract.semanticSchemaVersion,2);
});
test('headless v2 actual standalone writer cannot retain the binding while changing original project bytes',async t=>{
 const f=fixture(t);assert.equal(f.prepare().ok,true);await f.create();const original=f.hub.getProject('p').goal;f.hub.closePersistence();
 const store=createSqlitePersistence({filePath:f.filePath});f.track({closePersistence:()=>store.close()});store.load();const read=new DatabaseSync(f.filePath,{readOnly:true});let payload;try{payload={scope:{type:'full'},entities:read.prepare('SELECT collection,entity_key,project_id,state_json FROM state_entities').all().map(row=>({collection:row.collection,key:row.entity_key,projectId:row.project_id,value:JSON.parse(row.state_json)}))};}finally{read.close();}
 payload.entities.find(row=>row.collection==='project'&&row.key==='p').value.goal='unproved change';
 assert.throws(()=>store.save(payload),/INITIAL_PLAN_WRITE_FRAME_REQUIRED/);const db=new DatabaseSync(f.filePath,{readOnly:true});try{assert.equal(JSON.parse(db.prepare("SELECT state_json FROM state_entities WHERE collection='project' AND entity_key='p'").get().state_json).goal,original);}finally{db.close();}
});

const sha=value=>createHash('sha256').update(value,'utf8').digest('hex');
async function prepared(t,options){const f=fixture(t,options);assert.equal(f.prepare().ok,true);await f.create();return f;}
function addition(f,message='one',tasks=[{title:'Original user addition',brief:'Original retained input'}]){
 const body='Original user input '+message,sourceMessageId='main-user-message:'+sha(message);
 const authority=f.authority.user({schemaVersion:1,...scope,threadId:'thread',canonicalUserTaskId:'main-user-task:'+sha(message),canonicalMessageId:sourceMessageId,promptSha256:sha(body),permissionMode:'auto',sourceGoalId:'g',sourceGoalEpoch:1,sourceGoalTurnId:message});
 return{input:{action:'add_task',expectedProjectRevision:f.hub.getProject('p').projectRevision,sourceMessageId,body,tasks},context:{requestSource:'user',projectInputAuthority:authority}};
}
function apply(f,request){assert.equal(typeof f.hub.applyOrdinaryTaskMetadataInput,'function');return f.hub.applyOrdinaryTaskMetadataInput('p',request.input,request.context);}
function claim(f){const state=f.hub.readInitialPlanInputs('p',f.authority.reader());assert.equal(state.ok,true);assert.equal(state.ownerBinding.protocol,contract);
 const request={protocol:contract,fromAgent:'po',enqueueKey:state.enqueueKey,planRunId:'original-run',planGeneration:1,expectedPlanInputRevision:state.planInputRevision,expectedProjectControlDigest:state.projectControlDigest,startPolicy:'plan_only'};
 const result=f.hub.claimInitialPlanInputs('p',request,f.authority.planner());assert.equal(result.ok,true);return{request,reservation:result.reservation};}
function command(reservation){return{reservationId:reservation.id,enqueueKey:reservation.enqueueKey,planRunId:reservation.planRunId,commandId:reservation.commitCommandId,expectedProjectRevision:reservation.ownerRevision,fromAgent:'po',plan:{analysis:'Original fixed candidate',phases:[]},tasks:[{id:'initial',title:'Original initial task'}]};}
test('the original v2 owner durably applies a task with its immutable source receipt, exact replay and authenticated reopen',async t=>{
 const f=await prepared(t),request=addition(f),before=f.hub.getProject('p').projectRevision,result=apply(f,request);
 assert.equal(result.ok,true);assert.equal(result.operation.status,'applied');assert.equal(result.taskReceipt.kind,'ordinary_task_addition_receipt');assert.equal(result.taskReceipt.contract,contract);
 assert.equal(f.hub.getProject('p').projectRevision,before+1);assert.equal(f.hub.getBoard('p').getAllTasks().length,1);
 const revision=f.backend.revision;assert.deepEqual(apply(f,request),result);assert.equal(f.backend.revision,revision);
 assert.equal(apply(f,{...request,input:{...request.input,tasks:[{title:'Changed proposal'}]}}).error,'OPERATION_ENVELOPE_CONFLICT');
 f.hub.closePersistence();const reopened=f.track(createHub({silent:true,dataDir:{backend:'sqlite',filePath:f.filePath}}));
 assert.deepEqual(reopened.readOrdinaryProjectOperation('p',result.operation.operationId,f.authority.reader()),result);
});
test('manual v2 task-only is not a planning claim and never becomes an execution capability',async t=>{
 const f=await prepared(t),result=apply(f,addition(f));assert.equal(result.ok,true);
 assert.equal(f.hub.getProject('p').status,'planning');assert.equal(f.hub.readInitialPlanInputs('p',f.authority.reader()).reservation,null);
 assert.equal(f.hub.readInitialPlanAcceptanceHead('p',f.authority.reader()).ok,false);assert.equal(f.hub.checkProjectExecutionStart('p').error,'CANDIDATE_WORKSPACE_UNAVAILABLE');
 const db=new DatabaseSync(f.filePath,{readOnly:true});try{assert.equal(db.prepare("SELECT count(*) n FROM state_entities WHERE collection='protocolReceipt' AND json_extract(state_json,'$.kind')='initial_plan_reservation'").get().n,0);}finally{db.close();}
});
test('a real manual pristine board can become the same original born baseline before two additive tasks and a fixed-command union',async t=>{
 const f=await prepared(t),manual=apply(f,addition(f,'manual'));assert.equal(manual.ok,true);const baseline=f.hub.getBoard('p').getAllTasks().map(task=>task.id),{reservation}=claim(f),head=f.hub.readInitialPlanAcceptanceHead('p',f.authority.reader()).head;
 assert.equal(head.deltaCount,0);assert.equal(apply(f,addition(f,'delta-one')).ok,true);assert.equal(apply(f,addition(f,'delta-two')).ok,true);
 const current=f.hub.readInitialPlanAcceptanceHead('p',f.authority.reader()).head;assert.equal(current.deltaCount,2);assert.equal(current.tailProjectRevision,reservation.ownerRevision+2);
 const before=f.hub.getBoard('p').getAllTasks().map(task=>task.id),result=f.hub.commitInitialPlan('p',command(reservation),f.authority.planner());
 assert.equal(result.ok,true);const after=f.hub.getBoard('p').getAllTasks().map(task=>task.id);assert.deepEqual(after.slice(0,before.length),before);assert.equal(after.length,4);assert.ok(baseline.every(id=>after.includes(id)));
 const replay=f.hub.commitInitialPlan('p',command(reservation),f.authority.planner());assert.equal(replay.reused,true);assert.deepEqual(replay.receipt,result.receipt);
});
test('v2 owner rejects a global old-target policy overwrite while preserving same-policy additions',async t=>{
 const f=await prepared(t);assert.equal(apply(f,addition(f,'dependency')).ok,true);const dependency=f.hub.getBoard('p').getAllTasks()[0].id;
 const task=policy=>[{title:'Dependent task',dependencies:[dependency],dependencyPolicy:{[dependency]:policy}}];
 assert.equal(apply(f,addition(f,'first',task('verified_pass'))).ok,true);const before=f.hub.getBoard('p').getAllTasks().length;
 assert.equal(apply(f,addition(f,'conflict',task('completed'))).error,'ADDITIVE_DEPENDENCY_POLICY_CONFLICT');assert.equal(f.hub.getBoard('p').getAllTasks().length,before);assert.equal(f.hub.getProject('p').dependencyPolicies[dependency],'verified_pass');
 assert.equal(apply(f,addition(f,'same',task('verified_pass'))).ok,true);
});
test('a v2 task COMMIT failure rolls back the original board, receipts, audits and project revision together',async t=>{
 let armed=false;const sentinel=Error('original task addition COMMIT failed');
 const f=await prepared(t,{sqliteFactory(path){const db=new DatabaseSync(path),exec=db.exec.bind(db);db.exec=sql=>{if(armed&&sql==='COMMIT')throw sentinel;return exec(sql);};return db;}}),request=addition(f),before=f.hub.getProject('p').projectRevision;
 const db=new DatabaseSync(f.filePath,{readOnly:true}),snapshot=()=>db.prepare('SELECT collection,entity_key,project_id,state_json FROM state_entities ORDER BY collection,entity_key').all();
 try{const original=snapshot();armed=true;assert.throws(()=>apply(f,request),/original task addition COMMIT failed/);assert.equal(f.hub.getBoard('p').getAllTasks().length,0);assert.equal(f.hub.getProject('p').projectRevision,before);assert.deepEqual(snapshot(),original);}finally{db.close();}
});
test('ordinary public candidate rejection cannot be bypassed by selecting a v2 body field or forging a source context',async t=>{
 const f=await prepared(t),request=addition(f);
 assert.equal(f.hub.applyOrdinaryProjectInput('p',request.input,request.context.projectInputAuthority).error,'CANDIDATE_WORKSPACE_UNAVAILABLE');
 for(const context of [{},{requestSource:'agent',projectInputAuthority:request.context.projectInputAuthority},{requestSource:'user',projectInputAuthority:{...scope}}])assert.equal(apply(f,{...request,context}).ok,false);
 assert.equal(f.hub.getBoard('p').getAllTasks().length,0);
});
function claimRequest(f,run='composite-main-run'){
 const state=f.hub.readInitialPlanInputs('p',f.authority.reader());assert.equal(state.ok,true);
 return{protocol:contract,fromAgent:'po',enqueueKey:state.enqueueKey,planRunId:run,planGeneration:1,expectedPlanInputRevision:state.planInputRevision,expectedProjectControlDigest:state.projectControlDigest,startPolicy:'plan_only'};
}
test('a trusted original composite appends task and consumes pending input with one final owner revision and no delta',async t=>{
 const f=await prepared(t),pending=addition(f,'pending-plan');const {tasks,...planInput}=pending.input;planInput.action='add_plan_input';
 assert.equal(f.hub.applyOrdinaryProjectInput('p',planInput,pending.context.projectInputAuthority).ok,true);
 const request=addition(f,'composite-task'),claim=claimRequest(f),before=f.hub.getProject('p').projectRevision,revision=f.backend.revision;
 request.context={...request.context,initialPlanningAuthority:f.authority.planner(),initialPlanClaim:claim};
 const result=apply(f,request);assert.equal(result.ok,true);assert.equal(f.backend.revision,revision+1);assert.equal(f.hub.getProject('p').projectRevision,before+1);
 const state=f.hub.readInitialPlanInputs('p',f.authority.reader()),head=f.hub.readInitialPlanAcceptanceHead('p',f.authority.reader()).head;
 assert.equal(state.reservation.ownerRevision,before+1);assert.equal(head.baseProjectRevision,before+1);assert.equal(head.deltaCount,0);
 assert.deepEqual(state.reservation.compositeRequest,claim);assert.equal(state.reservation.compositeTaskOperationId,result.operation.operationId);assert.deepEqual(state.reservation.consumedMessageIds,[planInput.sourceMessageId]);
 const after=f.backend.revision;assert.deepEqual(apply(f,request),result);assert.equal(f.backend.revision,after);
});
test('a composite request cannot borrow a task user authority as its original Main planner authority',async t=>{
 const f=await prepared(t),request=addition(f),claim=claimRequest(f),revision=f.backend.revision;
 request.context={...request.context,initialPlanningAuthority:request.context.projectInputAuthority,initialPlanClaim:claim};
 assert.equal(apply(f,request).error,'PROJECT_INPUT_AUTHORITY_REQUIRED');assert.equal(f.backend.revision,revision);assert.equal(f.hub.getBoard('p').getAllTasks().length,0);
});

test('a composite historical replay still authenticates the current original planner authority',async t=>{
 const f=await prepared(t),request=addition(f,'replay-composite');request.context={...request.context,initialPlanningAuthority:f.authority.planner(),initialPlanClaim:claimRequest(f)};
 assert.equal(apply(f,request).ok,true);const revision=f.backend.revision;
 const replay=apply(f,{...request,context:{...request.context,initialPlanningAuthority:request.context.projectInputAuthority}});
 assert.deepEqual(replay,{ok:false,error:'PROJECT_INPUT_AUTHORITY_REQUIRED'});assert.equal(f.backend.revision,revision);
});
test('the immutable task operation envelope binds the original composite claim identity before replay',async t=>{
 const f=await prepared(t),request=addition(f,'changed-composite');request.context={...request.context,initialPlanningAuthority:f.authority.planner(),initialPlanClaim:claimRequest(f)};
 assert.equal(apply(f,request).ok,true);const revision=f.backend.revision;
 const replay=apply(f,{...request,context:{...request.context,initialPlanClaim:{...request.context.initialPlanClaim,planRunId:'different-main-run'}}});
 assert.deepEqual(replay,{ok:false,error:'OPERATION_ENVELOPE_CONFLICT'});assert.equal(f.backend.revision,revision);
});
test('an unrelated original save cannot retain a valid v2 head while forging a Room delivery ACK',async t=>{
 const f=await prepared(t);claim(f);f.hub.getProject('p').roomEventOutbox[0].status='published';f.hub.persistState({type:'project',projectId:'p'});
 assert.equal(f.hub.readInitialPlanAcceptanceHead('p',f.authority.reader()).head.state,'invalidated');
});
test('a real composite COMMIT failure retains neither task, claim, consumed input nor audit on disk',async t=>{
 let armed=false;const sentinel=Error('composite original COMMIT failed');const f=await prepared(t,{sqliteFactory(path){const db=new DatabaseSync(path),exec=db.exec.bind(db);db.exec=sql=>{if(armed&&sql==='COMMIT')throw sentinel;return exec(sql);};return db;}});
 const pending=addition(f,'pending-before-failure'),{tasks,...input}=pending.input;input.action='add_plan_input';assert.equal(f.hub.applyOrdinaryProjectInput('p',input,pending.context.projectInputAuthority).ok,true);
 const request=addition(f,'failing-composite');request.context={...request.context,initialPlanningAuthority:f.authority.planner(),initialPlanClaim:claimRequest(f)};
 const read=new DatabaseSync(f.filePath,{readOnly:true}),snapshot=()=>read.prepare('SELECT collection,entity_key,project_id,state_json FROM state_entities ORDER BY collection,entity_key').all();
 try{const original=snapshot(),revision=f.backend.revision,projectRevision=f.hub.getProject('p').projectRevision;armed=true;assert.throws(()=>apply(f,request),/composite original COMMIT failed/);assert.deepEqual(snapshot(),original);assert.equal(f.backend.revision,revision);assert.equal(f.hub.getBoard('p').getAllTasks().length,0);assert.equal(f.hub.getProject('p').projectRevision,projectRevision);}finally{read.close();}
});
for(const corruption of ['task','body','policy'])test(`a manual pristine claim refuses unproved original ${corruption} without laundering the current heap`,async t=>{
 const f=await prepared(t),result=apply(f,addition(f,'pristine-corruption'));assert.equal(result.ok,true);const request=claimRequest(f),revision=f.backend.revision;
 if(corruption==='task')f.hub.getBoard('p').getAllTasks()[0].title='Unproved replacement';
 if(corruption==='body')f.hub.getProject('p').ordinaryInputBodies[result.operation.operationId]='Unproved replacement';
 if(corruption==='policy')f.hub.getProject('p').dependencyPolicies={foreign:'completed'};
 const denied=f.hub.claimInitialPlanInputs('p',request,f.authority.planner());assert.equal(denied.ok,false);assert.equal(f.backend.revision,revision);
});
test('a Room task historical replay rechecks the current primary Room without rewriting its original receipt',async t=>{
 const f=await prepared(t),{source,input}=roomSourceFor(protocolDigest(f.hub.getProjectProtocolBinding('p').binding)),request={input,context:{requestSource:'user',projectInputAuthority:f.authority.user(source)}};
 const accepted=apply(f,request);assert.equal(accepted.ok,true);f.hub.getProject('p').primaryRoomId='different-room';const revision=f.backend.revision;
 assert.deepEqual(apply(f,request),{ok:false,error:'PROJECT_SCOPE_MISMATCH'});assert.equal(f.backend.revision,revision);assert.deepEqual(f.hub.readOrdinaryProjectOperation('p',accepted.operation.operationId,f.authority.reader()),accepted);
});
for(const transport of ['room','workspace'])test(`an original save callback cannot launder a forged ${transport} ACK into a valid v2 head`,async t=>{
 let ticket;const f=await prepared(t,{broker:{verifyWorkspaceMappingTicket:async()=>({ok:true,ticket}),workspaceMappingApplied:async()=>({ok:false})}});
 if(transport==='workspace'){
  const payload={projectId:'p',roomId:'room',workspaceId:'w',originHostId:'h',bindingId:'b',generation:1,expectedProjectRevision:f.hub.getProject('p').projectRevision,workFolder:realpathSync(f.root),artifactsDir:realpathSync(f.root)},request={ticketId:'ticket',operationId:'mapping-op',payload,payloadDigest:workspaceDigest('mapping',payload)};
  ticket={...payload,ticketId:request.ticketId,operationId:request.operationId,payloadDigest:request.payloadDigest,userPrincipal:'owner',roomSequence:1};assert.equal((await f.hub.applyWorkspaceMapping('p',request,{requestSource:'user'})).ok,true);
 }
 claim(f);const save=f.backend.save;f.backend.save=(factory,scope)=>save(actual=>{const project=f.hub.getProject('p');if(transport==='room')project.roomEventOutbox[0].status='published';else project.workspaceMappingOperations['mapping-op'].status='applied';return typeof factory==='function'?factory(actual):factory;},scope);
 f.hub.persistState({type:'project',projectId:'p'});assert.equal(f.hub.readInitialPlanAcceptanceHead('p',f.authority.reader()).head.state,'invalidated');
});
for(const state of ['headless','claimed'])test(`the actual original profile2 writer process refuses the real new ${state} floor before PRAGMA or writes`,async t=>{
 const f=await prepared(t);assert.equal(apply(f,addition(f,'old-writer-target')).ok,true);if(state==='claimed')claim(f);f.hub.closePersistence();
 const reader=new DatabaseSync(f.filePath,{readOnly:true}),snapshot=()=>({schema:reader.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all(),entities:reader.prepare('SELECT * FROM state_entities ORDER BY collection,entity_key').all(),history:reader.prepare('SELECT * FROM state_entity_history ORDER BY rowid').all(),meta:reader.prepare('SELECT * FROM state_meta ORDER BY meta_key').all()});
 try{
  const original=snapshot(),moduleUrl=new URL('./fixtures/profile2-original-writer/sqlite-persistence.js',import.meta.url).href;
  const program=`import {DatabaseSync} from 'node:sqlite';import {createSqlitePersistence} from ${JSON.stringify(moduleUrl)};const calls={functions:[],exec:[]};const store=createSqlitePersistence({filePath:process.argv[1],sqliteFactory(path){const db=new DatabaseSync(path),fn=db.function.bind(db),exec=db.exec.bind(db);db.function=(name,...args)=>{calls.functions.push(name);return fn(name,...args);};db.exec=sql=>{calls.exec.push(sql);return exec(sql);};return db;}});let failure;try{store.load();}catch(error){failure={name:error.name,message:error.message};}finally{store.close();}process.stdout.write(JSON.stringify({failure,calls})+'\\n');if(!failure||!failure.message.includes('writer_profile_unsupported'))process.exitCode=1;`;
  const result=spawnSync(process.execPath,['--experimental-sqlite','--input-type=module','-e',program,f.filePath],{encoding:'utf8',timeout:5000,maxBuffer:1048576});
  console.log(JSON.stringify({test:'actual-original-profile2-process',state,pid:result.pid,status:result.status,signal:result.signal,reaped:result.status!==null}));assert.equal(result.error,undefined);assert.equal(result.status,0,result.stderr);const output=JSON.parse(result.stdout);assert.equal(output.calls.functions.includes('kswarm_task_addition_writer_v2'),false);assert.deepEqual(output.calls.exec,[]);assert.deepEqual(snapshot(),original);
 }finally{reader.close();}
});
for(const phase of ['manual','committed'])test(`v2 ${phase} metadata cannot cross actual original execution entry points before candidate qualification`,async t=>{
 const sends=[],f=await prepared(t,{bridge:{send(message){sends.push(message);}}});assert.equal(apply(f,addition(f,'no-executor')).ok,true);if(phase==='committed'){const {reservation}=claim(f);assert.equal(f.hub.commitInitialPlan('p',command(reservation),f.authority.planner()).ok,true);}
 const revision=f.backend.revision,rows=structuredClone(f.hub.getBoard('p').getAllTasks());
 for(const result of [f.hub.checkProjectExecutionStart('p'),f.hub.readProjectExecutionStart('p',f.authority.reader()),f.hub.handleApprove('p'),f.hub.activateAndStartProject('p',{}),f.hub.handleRequestDispatch('p','po'),f.hub.handleRetryPlan('p'),await f.hub.dispatchWorkspaceTask('p',{})])assert.deepEqual(result,{ok:false,error:'CANDIDATE_WORKSPACE_UNAVAILABLE'});
 assert.equal(f.backend.revision,revision);assert.deepEqual(f.hub.getBoard('p').getAllTasks(),rows);assert.deepEqual(sends,[]);
});
test('an actual second original writer global commit rejects the stale prepared task transaction without erasing either aggregate',async t=>{
 // Inject only the existing lock-reclamation race; both SQL connections and commits stay real.
 const f=await prepared(t),other=createSqlitePersistence({filePath:f.filePath,isProcessAlive:()=>false});f.track({closePersistence:()=>other.close()});other.load();
 other.save({scope:{type:'project',projectId:'unrelated'},entities:[{collection:'project',key:'unrelated',projectId:'unrelated',value:{id:'unrelated',name:'Other actual writer'}}]});
 assert.throws(()=>apply(f,addition(f,'stale-global')),/revision|stale|conflict/i);assert.equal(f.hub.getBoard('p').getAllTasks().length,0);
 const read=new DatabaseSync(f.filePath,{readOnly:true});try{assert.equal(read.prepare("SELECT count(*) n FROM state_entities WHERE collection='protocolReceipt' AND json_extract(state_json,'$.kind')='ordinary_task_addition_receipt'").get().n,0);assert.equal(JSON.parse(read.prepare("SELECT state_json FROM state_entities WHERE collection='project' AND entity_key='unrelated'").get().state_json).name,'Other actual writer');}finally{read.close();}
});
test('the actual original v2 board union stops at 200 expanded tasks before any overflow task is retained',async t=>{
 const f=await prepared(t);assert.equal(apply(f,addition(f,'two-hundred',Array.from({length:200},(_,index)=>({title:'Task '+index})))).ok,true);assert.equal(f.hub.getBoard('p').getAllTasks().length,200);
 const before=structuredClone(f.hub.getBoard('p').getAllTasks()),result=apply(f,addition(f,'overflow'));assert.equal(result.error,'ADDITIVE_TASK_LIMIT_EXCEEDED');assert.deepEqual(f.hub.getBoard('p').getAllTasks(),before);
});
test('real original Room publication and unchanged saves preserve a valid v2 head without faking delivery receipts',async t=>{
 const f=await prepared(t,{broker:{publishRoomProjectEvent:async()=>({ok:true})}});claim(f);await f.hub.flushRoomEventOutbox();assert.equal(f.hub.getProject('p').roomEventOutbox[0].status,'published');f.hub.persistState({type:'project',projectId:'p'});assert.equal(f.hub.readInitialPlanAcceptanceHead('p',f.authority.reader()).head.state,'valid');
});
test('the actual immutable schema3 reservation is closed and preserves the exact original scope and claim request',async t=>{
 const f=await prepared(t),{reservation,request}=claim(f);assert.deepEqual(readTaskAdditionOwnerRecord(reservation),reservation);assert.deepEqual(reservation.claimRequest,request);
 for(const patch of [{qualified:true},{schemaVersion:2},{claimRequest:{...reservation.claimRequest,trigger:true}},{compositeTaskOperationId:'orphan'},{scope:{...scope,extra:'scope'}}])assert.throws(()=>readTaskAdditionOwnerRecord({...reservation,...patch}),/INITIAL_PLAN_SEMANTIC_SCHEMA/);
});
test('manual pristine task receipts permit independently persisted control changes before the actual explicit claim',async t=>{
 const f=await prepared(t);assert.equal(apply(f,addition(f,'manual-before-control')).ok,true);const before=f.hub.getBoard('p').getAllTasks().map(task=>task.id);
 f.hub.mutateProjectState('p',()=>{f.hub.getProject('p').goal='Current original user control';});const {reservation}=claim(f);assert.equal(reservation.claimRequest.expectedProjectControlDigest.length,64);assert.deepEqual(f.hub.getBoard('p').getAllTasks().map(task=>task.id),before);assert.equal(f.hub.readInitialPlanAcceptanceHead('p',f.authority.reader()).head.state,'valid');
});
test('an unknown original metadata SELECT error cannot become a durable task rejection or a fabricated invalidation',async t=>{
 let armed=false;const sentinel=Error('actual task metadata SELECT unavailable'),f=await prepared(t,{sqliteFactory(path){const db=new DatabaseSync(path),prepare=db.prepare.bind(db);db.prepare=sql=>{if(armed&&sql==='SELECT collection,entity_key,project_id,state_json FROM state_entities')throw sentinel;return prepare(sql);};return db;}});
 claim(f);const request=addition(f,'unknown-select'),revision=f.backend.revision;armed=true;assert.throws(()=>apply(f,request),error=>error===sentinel||error.cause===sentinel);assert.equal(f.backend.revision,revision);assert.equal(f.hub.getBoard('p').getAllTasks().length,0);
 const read=new DatabaseSync(f.filePath,{readOnly:true});try{assert.equal(read.prepare("SELECT count(*) n FROM state_entities WHERE collection='protocolReceipt' AND json_extract(state_json,'$.kind') IN ('ordinary_task_addition_receipt','initial_plan_acceptance_invalidation')").get().n,0);}finally{read.close();}
});
test('a task post-COMMIT projection failure preserves the real applied receipt and only replays it after reopen',async t=>{
 let armed=false,f;const sentinel=Error('task postcommit projection mirror failed');f=await prepared(t,{sqliteFactory(path){const db=new DatabaseSync(path),exec=db.exec.bind(db);db.exec=sql=>{const result=exec(sql);if(armed&&sql==='COMMIT'){armed=false;const project=f.hub.getProject('p'),value=project.committedActivitySeq;Object.defineProperty(project,'committedActivitySeq',{enumerable:true,configurable:true,get(){return value;},set(){throw sentinel;}});}return result;};return db;}});
 const request=addition(f,'postcommit-original');armed=true;let failure;try{apply(f,request);}catch(error){failure=error;}assert.ok(failure);assert.equal(failure.durableCommitted,true);assert.ok(failure===sentinel||failure.cause===sentinel);f.hub.closePersistence();
 const reopened=f.track(createHub({silent:true,dataDir:{backend:'sqlite',filePath:f.filePath}})),before=reopened.getPersistenceHealth().revision,result=reopened.applyOrdinaryTaskMetadataInput('p',request.input,request.context);assert.equal(result.ok,true);assert.equal(result.operation.status,'applied');assert.equal(reopened.getBoard('p').getAllTasks().length,1);assert.equal(reopened.getPersistenceHealth().revision,before);
});
for(const phase of ['manual','delta','composite','fixed'])test(`the actual original ${phase} authority save rejects a late forged transport before signing any new v2 record`,async t=>{
 const f=await prepared(t),reservation=phase==='delta'||phase==='fixed'?claim(f).reservation:null,request=addition(f,'late-'+phase);if(phase==='composite')request.context={...request.context,initialPlanningAuthority:f.authority.planner(),initialPlanClaim:claimRequest(f)};
 const revision=f.backend.revision,save=f.backend.save;f.backend.save=(factory,scope)=>save(actual=>{f.hub.getProject('p').roomEventOutbox[0].status='published';return typeof factory==='function'?factory(actual):factory;},scope);
 assert.throws(()=>phase==='fixed'?f.hub.commitInitialPlan('p',command(reservation),f.authority.planner()):apply(f,request),/INITIAL_PLAN_PROJECTION_UNVERIFIED/);assert.equal(f.backend.revision,revision);assert.equal(f.hub.getBoard('p').getAllTasks().length,0);
});
for(const corruption of ['missing-middle','previous-delta','wrong-scope','wrong-store','duplicate-operation','head-rollback'])test(`the actual original owner refuses a persisted additive ${corruption} corruption before fixed task union`,async t=>{
 const f=await prepared(t),{reservation}=claim(f);assert.equal(apply(f,addition(f,'chain-one')).ok,true);assert.equal(apply(f,addition(f,'chain-two')).ok,true);const original=structuredClone(f.hub.getBoard('p').getAllTasks());f.hub.closePersistence();
 // Privileged storage-fault injection only. An ordinary source cannot install
 // SQLite UDFs or modify these immutable records through production writers.
 const db=new DatabaseSync(f.filePath);try{
  db.function('kswarm_task_addition_writer_v2',{deterministic:true},()=>TASK_WRITER_DIGEST);
  const rows=db.prepare("SELECT entity_key,state_json FROM state_entities WHERE collection='protocolReceipt' AND json_extract(state_json,'$.kind')='initial_plan_additive_delta' ORDER BY json_extract(state_json,'$.ordinal')").all();assert.equal(rows.length,2);
  if(corruption==='missing-middle')db.prepare("DELETE FROM state_entities WHERE collection='protocolReceipt' AND entity_key=?").run(rows[0].entity_key);
  else if(corruption==='head-rollback'){
   const row=db.prepare("SELECT entity_key,state_json FROM state_entities WHERE collection='protocolHead' AND json_extract(state_json,'$.kind')='initial_plan_acceptance_head'").get(),record=JSON.parse(row.state_json);record.deltaCount=1;record.tailProjectRevision-=1;record.revision-=1;const text=JSON.stringify(record);db.prepare("UPDATE state_entities SET state_json=?,checksum=? WHERE collection='protocolHead' AND entity_key=?").run(text,sha(text),row.entity_key);
  }else{
   const row=rows[1],record=JSON.parse(row.state_json);if(corruption==='previous-delta')record.previousDeltaDigest='f'.repeat(64);if(corruption==='wrong-scope')record.scope.workspaceId='f'.repeat(64);if(corruption==='wrong-store')record.writerStoreId='ffffffff-ffff-4fff-8fff-ffffffffffff';if(corruption==='duplicate-operation'){const first=JSON.parse(rows[0].state_json);record.taskReceiptId=first.taskReceiptId;record.taskReceiptDigest=first.taskReceiptDigest;}
   const text=JSON.stringify(record);db.prepare("UPDATE state_entities SET state_json=?,checksum=? WHERE collection='protocolReceipt' AND entity_key=?").run(text,sha(text),row.entity_key);
  }
 }finally{db.close();}
 const reopened=f.track(createHub({silent:true,dataDir:{backend:'sqlite',filePath:f.filePath}}));let outcome,failure;try{outcome=reopened.commitInitialPlan('p',command(reservation),f.authority.planner());}catch(error){failure=error;}
 assert.ok(failure||outcome?.ok===false);if(failure)assert.match(failure.message,/INTEGRITY|UNVERIFIED|SEMANTIC_SCHEMA|WRITE_FRAME/);assert.deepEqual(reopened.getBoard('p').getAllTasks(),original);
 const read=new DatabaseSync(f.filePath,{readOnly:true});try{const row=read.prepare("SELECT state_json FROM state_entities WHERE collection='protocolReceipt' AND entity_key=?").get(reservation.commitCommandId);assert.notEqual(row?JSON.parse(row.state_json).outcome:undefined,'applied');}finally{read.close();}
});
test('the original v2 owner read exposes only its current closed metadata binding for the same future Main preparation',async t=>{
 const f=await prepared(t),state=f.hub.readInitialPlanInputs('p',f.authority.reader());assert.equal(state.ok,true);assert.equal(state.reservation,null);assert.deepEqual(Object.keys(state.taskOwner??{}).sort(),['projectId','scope','writerStoreId','bindingDigest','createReceiptDigest','contract'].sort());
 assert.equal(state.taskOwner.projectId,'p');assert.deepEqual(state.taskOwner.scope,scope);assert.equal(state.taskOwner.contract,contract);assert.equal(state.taskOwner.writerStoreId,f.backend.getWriterProfile().floor.storeId);assert.match(state.projectControlDigest,/^[a-f0-9]{64}$/);
 const result=apply(f,addition(f,'read-metadata-binding'));assert.equal(result.ok,true);for(const key of Object.keys(state.taskOwner))assert.deepEqual(result.taskReceipt[key],state.taskOwner[key]);
});
