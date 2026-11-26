import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createHub} from '../src/core/hub.js';
import {createProjectInputAuthority} from '../src/core/project-input-authority.js';
import {createSqlitePersistence} from '../src/core/sqlite-persistence.js';
import {sha256Hex,serializeValue} from '../src/core/state-scope.js';
const scope={profileId:'a'.repeat(64),workspaceId:'b'.repeat(64)};
const sha=value=>createHash('sha256').update(value).digest('hex');
const authority=createProjectInputAuthority(scope);
const userControl={requestSource:'user',projectInputAuthority:authority.reader()};
function user(messageId='one',body='more input'){
 return authority.user({schemaVersion:1,...scope,threadId:'thread',canonicalUserTaskId:'main-user-task:'+sha(messageId),canonicalMessageId:'main-user-message:'+sha(messageId),promptSha256:sha(body),permissionMode:'auto',sourceGoalId:'g',sourceGoalEpoch:1,sourceGoalTurnId:messageId});
}
async function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'ordinary-project-inputs-'));const dataDir={backend:'sqlite',filePath:join(root,'state.sqlite')};
 const options={silent:true,dataDir,brokerClient:{async getRoomSnapshot(){return {ok:true,room:{status:'active'},members:[{status:'active',subject:{kind:'agent',logicalAgentId:'po'}}]};},async acquireRoomMembershipLease(){return {ok:true};}}};
 let hub=createHub(options);await hub.createProject({id:'p',name:'P',goal:'G',poAgent:'po',primaryRoomId:'room',autoAssignPo:false},{requestSource:'user',projectInputAuthority:authority.creator('main-create-fixture')});
 t.after(()=>{hub.closePersistence();rmSync(root,{recursive:true,force:true});});
 return {get hub(){return hub;},filePath:dataDir.filePath,reopen(){hub.closePersistence();hub=createHub(options);return hub;}};
}
const add=(messageId='one',body='more input',revision=1)=>({action:'add_plan_input',expectedProjectRevision:revision,sourceMessageId:'main-user-message:'+sha(messageId),body});
const plan={enqueueKey:'enqueue-1',planRunId:'plan-run-1',planGeneration:1,expectedPlanInputRevision:1,startPolicy:'auto_activate_after_plan'};
function planFor(hub){
 const state=hub.readInitialPlanInputs('p',authority.reader());assert.equal(state.ok,true);
 return {enqueueKey:state.enqueueKey,planRunId:'plan-run-1',planGeneration:state.planGeneration,expectedPlanInputRevision:state.planInputRevision,startPolicy:state.startPolicy};
}
test('owner accepts plan input durably and acknowledges only its unique initial claim',async t=>{
 const f=await fixture(t);const pending=f.hub.applyOrdinaryProjectInput('p',add(),user());
 assert.equal(pending.ok,true);assert.equal(pending.operation.status,'accepted_pending');assert.equal(pending.acknowledged,false);
 const restored=f.reopen().readOrdinaryProjectOperation('p',pending.operation.operationId,authority.reader());
 assert.deepEqual(restored.operation,pending.operation);
 const request=planFor(f.hub),claim=f.hub.claimInitialPlanInputs('p',request,authority.planner());
 assert.equal(claim.ok,true);assert.deepEqual(claim.reservation.consumedMessageIds,[add().sourceMessageId]);
 assert.deepEqual(claim.inputs.map(input=>input.body),['more input']);
 const applied=f.hub.readOrdinaryProjectOperation('p',pending.operation.operationId,authority.reader());
 assert.equal(applied.operation.status,'applied');assert.equal(applied.acknowledged,true);
 assert.equal(applied.operation.initialPlanReservationId,claim.reservation.id);
 assert.deepEqual(f.reopen().claimInitialPlanInputs('p',request,authority.planner()).reservation,claim.reservation);
});
test('canonical message replay is idempotent but a changed envelope is rejected',async t=>{
 const f=await fixture(t);const first=f.hub.applyOrdinaryProjectInput('p',add(),user());
 assert.deepEqual(f.hub.applyOrdinaryProjectInput('p',add(),user()).operation,first.operation);
 assert.equal(f.hub.applyOrdinaryProjectInput('p',{...add(),body:'changed'},user()).ok,false);
 assert.equal(f.hub.applyOrdinaryProjectInput('p',{...add(),expectedProjectRevision:2},user()).error,'OPERATION_ENVELOPE_CONFLICT');
});
test('missing, forged, agent, and cross-workspace source authorities cannot mutate or observe owner input',async t=>{
 const f=await fixture(t);const wrong=createProjectInputAuthority({...scope,workspaceId:'c'.repeat(64)});
 for(const context of [null,{}, {requestSource:'user',...scope},{requestSource:'agent'},wrong.reader()]){
  assert.equal(f.hub.applyOrdinaryProjectInput('p',add(),context).ok,false);
  assert.equal(f.hub.claimInitialPlanInputs('p',plan,context).ok,false);
  assert.equal(f.hub.readOrdinaryProjectOperation('p','unknown',context).ok,false);
 }
 assert.equal(f.hub.getProject('p').projectRevision,1);
});
test('initial claim CAS freezes its exact input set and never creates another PO outbox',async t=>{
 const f=await fixture(t);f.hub.applyOrdinaryProjectInput('p',add(),user());
 const request=planFor(f.hub);
 assert.equal(f.hub.claimInitialPlanInputs('p',{...request,expectedPlanInputRevision:0},authority.planner()).error,'PLAN_INPUT_REVISION_CONFLICT');
 const one=f.hub.claimInitialPlanInputs('p',request,authority.planner());assert.equal(one.ok,true);
 assert.equal(f.hub.claimInitialPlanInputs('p',{...request,planRunId:'second-run'},authority.planner()).error,'INITIAL_PLAN_CLAIM_CONFLICT');
 assert.equal(f.hub.applyOrdinaryProjectInput('p',add('two','another',f.hub.getProject('p').projectRevision),user('two','another')).error,'PLAN_INPUT_WINDOW_CLOSED');
 assert.equal(f.hub.getProject('p').poStartOutbox,undefined);
});
test('voided pending input is never consumed and cannot be revived by its old add operation',async t=>{
 const f=await fixture(t);const pending=f.hub.applyOrdinaryProjectInput('p',add(),user());
 const released=f.hub.voidOrdinaryPlanInput('p',{operationId:pending.operation.operationId,expectedPlanInputRevision:1},authority.reader());
 assert.equal(released.ok,true);assert.equal(released.operation.status,'voided');
 const replay=f.hub.applyOrdinaryProjectInput('p',add(),user());assert.equal(replay.operation.status,'voided');
 const claim=f.hub.claimInitialPlanInputs('p',planFor(f.hub),authority.planner());
 assert.deepEqual(claim.reservation.consumedMessageIds,[]);
 assert.equal(f.hub.voidOrdinaryPlanInput('p',{operationId:pending.operation.operationId,expectedPlanInputRevision:2},authority.reader()).operation.status,'voided');
});
for(const status of ['delivered','closed'])test('terminal project refuses new follow-up before any consumption '+status,async t=>{
 const f=await fixture(t);f.hub.getProject('p').status=status;
 const result=f.hub.applyOrdinaryProjectInput('p',add(),user());assert.equal(result.error,'PROJECT_TERMINAL_REQUIRES_REOPEN');
 assert.equal(f.hub.getProject('p').projectRevision,1);
});
test('a pending body changed outside its immutable source receipt cannot enter an initial claim',async t=>{
 const f=await fixture(t);const pending=f.hub.applyOrdinaryProjectInput('p',add(),user());
 f.hub.getProject('p').ordinaryInputBodies[pending.operation.operationId]='replaced source';
 const request=planFor(f.hub);
 assert.equal(f.hub.claimInitialPlanInputs('p',request,authority.planner()).error,'PLAN_INPUT_BODY_INTEGRITY_FAILED');
 assert.equal(f.hub.readOrdinaryProjectOperation('p',pending.operation.operationId,authority.reader()).operation.status,'accepted_pending');
});
test('claim commit failure rolls back consumption and reservation together in the real owner store',async t=>{
 const root=mkdtempSync(join(tmpdir(),'ordinary-input-fault-'));const filePath=join(root,'state.sqlite');
 let fail=false;const disk=createSqlitePersistence({filePath});
 const persistence={...disk,save(...args){if(fail)throw Error('injected_claim_commit');return disk.save(...args);}};
 const options={silent:true,persistence,brokerClient:{async getRoomSnapshot(){return {ok:true,room:{status:'active'},members:[{status:'active',subject:{kind:'agent',logicalAgentId:'po'}}]};},async acquireRoomMembershipLease(){return {ok:true};}}};
 let hub=createHub(options);t.after(()=>{hub.closePersistence();rmSync(root,{recursive:true,force:true});});
 await hub.createProject({id:'p',name:'P',poAgent:'po',primaryRoomId:'room',autoAssignPo:false},{requestSource:'user',projectInputAuthority:authority.creator('main-create-fixture')});
 const pending=hub.applyOrdinaryProjectInput('p',add(),user());const request=planFor(hub),revision=hub.getProject('p').projectRevision;
 fail=true;assert.throws(()=>hub.claimInitialPlanInputs('p',request,authority.planner()),/injected_claim_commit/);
 assert.equal(hub.getProject('p').projectRevision,revision);hub.closePersistence();
 hub=createHub({silent:true,dataDir:{backend:'sqlite',filePath}});
 assert.equal(hub.readOrdinaryProjectOperation('p',pending.operation.operationId,authority.reader()).operation.status,'accepted_pending');
 assert.equal(hub.readInitialPlanInputs('p',authority.reader()).reservation,null);
 assert.equal(hub.claimInitialPlanInputs('p',request,authority.planner()).ok,true);
});
test('a terminal rejection is an immutable operation outcome even if the project later changes',async t=>{
 const f=await fixture(t);f.hub.getProject('p').status='closed';const rejected=f.hub.applyOrdinaryProjectInput('p',add(),user());
 f.hub.mutateProjectState('p',()=>{f.hub.getProject('p').status='created';});
 const replay=f.reopen().applyOrdinaryProjectInput('p',add(),user());
 assert.deepEqual(replay.operation,rejected.operation);assert.equal(replay.error,'PROJECT_TERMINAL_REQUIRES_REOPEN');
 assert.equal(f.hub.readInitialPlanInputs('p',authority.reader()).planInputRevision,0);
});
test('a closed owner cannot revive its protected protocol through an old authority token',async t=>{
 const f=await fixture(t);f.hub.closePersistence();
 assert.equal(f.hub.readInitialPlanInputs('p',authority.reader()).error,'PROTECTED_PROTOCOL_STORAGE_REQUIRED');
 assert.equal(f.hub.applyOrdinaryProjectInput('p',add(),user()).error,'PROTECTED_PROTOCOL_STORAGE_REQUIRED');
});
test('the claimed Main run atomically submits one initial plan and task set with a durable command receipt',async t=>{
 const f=await fixture(t);const request=planFor(f.hub);const claimed=f.hub.claimInitialPlanInputs('p',request,authority.planner());
 const input={reservationId:claimed.reservation.id,planRunId:request.planRunId,enqueueKey:request.enqueueKey,
  commandId:claimed.reservation.commitCommandId,expectedProjectRevision:claimed.reservation.ownerRevision,fromAgent:'po',
  plan:{analysis:'plan',phases:[]},tasks:[{id:'task-1',title:'Produce report',description:'Write report',assignedAgent:'po'}]};
 const result=f.hub.commitInitialPlan('p',input,authority.planner());assert.equal(result.ok,true);
 assert.equal(f.hub.getBoard('p').getAllTasks().length,1);assert.equal(f.hub.getProject('p').plan.analysis,'plan');
 const replay=f.reopen().commitInitialPlan('p',input,authority.planner());assert.equal(replay.reused,true);assert.deepEqual(replay.receipt,result.receipt);
 assert.equal(f.hub.getBoard('p').getAllTasks().length,1);
 assert.equal(f.hub.commitInitialPlan('p',{...input,tasks:[{title:'different task'}]},authority.planner()).error,'INITIAL_PLAN_COMMAND_CONFLICT');
 assert.equal(f.hub.handleCreateTasks('p',[{id:'later-task',title:'Authorized later task',assignedAgent:'po'}],'po').ok,true);
 assert.equal(f.hub.getBoard('p').getAllTasks().length,2);
 f.hub.handleCloseProject('p','',userControl);
 assert.equal(f.hub.handleCreateTasks('p',[{id:'terminal-bypass',title:'Must not run'}],'po').error,'PROJECT_TERMINAL_REQUIRES_REOPEN');
 assert.equal(f.hub.getBoard('p').getAllTasks().length,2);
});
test('first-plan sibling writers cannot bypass the protected Main claim or reopen a terminal project',async t=>{
 const f=await fixture(t);const before=structuredClone(f.hub.getProject('p'));
 assert.equal(f.hub.handleCreateTasks('p',[{title:'bypass'}],'po').error,'INITIAL_PLAN_CLAIM_REQUIRED');
 assert.equal(f.hub.handleSubmitPlan('p',{phases:[]},'po').error,'INITIAL_PLAN_CLAIM_REQUIRED');
 assert.deepEqual(f.hub.getProject('p'),before);assert.equal(f.hub.getBoard('p').getAllTasks().length,0);
 const request=planFor(f.hub),claimed=f.hub.claimInitialPlanInputs('p',request,authority.planner());f.hub.handleCloseProject('p','',userControl);
 assert.equal(f.hub.commitInitialPlan('p',{reservationId:claimed.reservation.id,planRunId:request.planRunId,enqueueKey:request.enqueueKey,commandId:claimed.reservation.commitCommandId,expectedProjectRevision:claimed.reservation.ownerRevision,fromAgent:'po',plan:{phases:[]},tasks:[]},authority.planner()).error,'PROJECT_TERMINAL_REQUIRES_REOPEN');
 assert.equal(f.hub.getProject('p').plan,null);
});
test('human/team/mode siblings cannot mutate the protected initial planning window',async t=>{
 const f=await fixture(t);const request=planFor(f.hub),claimed=f.hub.claimInitialPlanInputs('p',request,authority.planner());
 const before=structuredClone(f.hub.getProject('p'));
 for(const action of [()=>f.hub.handleHumanAddTasks('p',[{title:'bypass'}],{requestSource:'user'}),()=>f.hub.updateProjectExecutionMode('p','workflow_preferred'),()=>f.hub.attachTeamOperationMembers('p',{operationId:'other',agentIds:['new-agent']}),()=>f.hub.handleRevisePlan('p',{changes:[]},'po')]){
  assert.equal(action().error,'INITIAL_PLAN_CLAIM_REQUIRED');assert.deepEqual(f.hub.getProject('p'),before);assert.equal(f.hub.getBoard('p').getAllTasks().length,0);
 }
 assert.equal(f.hub.commitInitialPlan('p',{reservationId:claimed.reservation.id,planRunId:request.planRunId,enqueueKey:request.enqueueKey,commandId:claimed.reservation.commitCommandId,expectedProjectRevision:claimed.reservation.ownerRevision,fromAgent:'po',plan:{phases:[]},tasks:[]},authority.planner()).ok,true);
});
test('rejected command identity remains immutable and business rejection restores the entire board on disk',async t=>{
 const f=await fixture(t);const request=planFor(f.hub),claimed=f.hub.claimInitialPlanInputs('p',request,authority.planner());
 const before=structuredClone(f.hub.getBoard('p').getAllTasks());
 const input={reservationId:claimed.reservation.id,planRunId:request.planRunId,enqueueKey:request.enqueueKey,commandId:claimed.reservation.commitCommandId,expectedProjectRevision:claimed.reservation.ownerRevision,fromAgent:'po',plan:{phases:[]},tasks:[{id:'same-id',title:'first'},{id:'same-id',title:'conflicting second'}]};
 const rejected=f.hub.commitInitialPlan('p',input,authority.planner());assert.equal(rejected.ok,false);assert.equal(rejected.receipt.outcome,'rejected');
 assert.equal(f.hub.getProject('p').plan,null);assert.deepEqual(f.hub.getBoard('p').getAllTasks(),before);
 const reopened=f.reopen();assert.equal(reopened.getProject('p').plan,null);assert.deepEqual(reopened.getBoard('p').getAllTasks(),before);
 assert.deepEqual(reopened.commitInitialPlan('p',input,authority.planner()).receipt,rejected.receipt);
 assert.equal(reopened.commitInitialPlan('p',{...input,tasks:[]},authority.planner()).error,'INITIAL_PLAN_COMMAND_CONFLICT');
});
test('Main captured ordinary user input has its own strict source family and cannot borrow Goal fields',async t=>{
 const f=await fixture(t),messageId='main-capture',body='more input';
 const source={schemaVersion:2,sourceFamily:'main_user_submission',...scope,threadId:'thread',canonicalUserTaskId:'main-user-task:'+sha(messageId),canonicalMessageId:'main-user-message:'+sha(messageId),promptSha256:sha(body),permissionMode:'default',
  submissionId:'main-submission:123e4567-e89b-42d3-a456-426614174000:123e4567-e89b-42d3-a456-426614174001',sourceTaskId:'native_task',sourceSessionId:'native_session'};
 const token=authority.user(source),result=f.hub.applyOrdinaryProjectInput('p',add(messageId,body),token);assert.equal(result.ok,true);
 assert.equal(result.operation.authorizingUserTaskId,source.canonicalUserTaskId);
 for(const changed of [{...source,sourceGoalId:'fake'},{...source,sourceFamily:'goal_turn'},{...source,submissionId:'fake'},{...source,permissionMode:'plan'},{...source,schemaVersion:1}])assert.throws(()=>authority.user(changed),/project_input_source_invalid/);
});

for(const terminal of ['close','delete'])test('original '+terminal+' settles unclaimed input and preserves a readable, unconsumed terminal receipt after SQLite reopen',async t=>{
 const f=await fixture(t),body='private planning input never retained in permanent receipt';
 const pending=f.hub.applyOrdinaryProjectInput('p',add('terminal',body),user('terminal',body)),request=planFor(f.hub);
 const result=terminal==='close'?f.hub.handleCloseProject('p','',userControl):f.hub.deleteProject('p',userControl);assert.equal(result.ok,true);
 const settled=f.reopen().readOrdinaryProjectOperation('p',pending.operation.operationId,user('terminal',body));
 assert.equal(settled.ok,true);assert.equal(settled.operation.status,'voided');assert.equal(settled.acknowledged,false);assert.equal(settled.terminal,true);assert.deepEqual(settled.consumption,{state:'not_consumed'});
 assert.equal(settled.operation.projectDisposition,terminal==='close'?'closed':'deleted');
 assert.equal(f.hub.claimInitialPlanInputs('p',request,authority.planner()).ok,false);
 assert.equal(f.hub.applyOrdinaryProjectInput('p',add('late','late input'),user('late','late input')).ok,false);
 const wrong=createProjectInputAuthority({...scope,workspaceId:'c'.repeat(64)});
 assert.equal(f.hub.readOrdinaryProjectOperation('p',pending.operation.operationId,wrong.reader()).ok,false);
 assert.equal(f.hub.readOrdinaryProjectOperation('p',pending.operation.operationId,user('different',body)).error,'PROJECT_INPUT_AUTHORITY_REQUIRED');
 assert.equal(f.hub.readOrdinaryProjectOperation('p',pending.operation.operationId,{}).ok,false);
 f.hub.closePersistence();const disk=createSqlitePersistence({filePath:f.filePath});try{
  const saved=disk.load();assert.equal(JSON.stringify(saved.protocolReceipts).includes(body),false);assert.equal(JSON.stringify(saved.protocolHeads).includes(body),false);
  assert.equal(saved.protocolReceipts.filter(r=>r.kind==='ordinary_input_owner_terminal_receipt').length,1);
  if(terminal==='delete')assert.equal(saved.projects?.some(project=>project.id==='p')??false,false);
 }finally{disk.close();}
});
for(const terminal of ['close','delete'])test('claim before '+terminal+' retains its exact applied consumption and never becomes a releasable pending input',async t=>{
 const f=await fixture(t),pending=f.hub.applyOrdinaryProjectInput('p',add(),user()),request=planFor(f.hub),claimed=f.hub.claimInitialPlanInputs('p',request,authority.planner());assert.equal(claimed.ok,true);
 assert.equal((terminal==='close'?f.hub.handleCloseProject('p','',userControl):f.hub.deleteProject('p',userControl)).ok,true);
 const settled=f.reopen().readOrdinaryProjectOperation('p',pending.operation.operationId,authority.reader());
 assert.equal(settled.ok,true);assert.equal(settled.operation.status,'applied');assert.equal(settled.acknowledged,true);assert.equal(settled.terminal,true);
 assert.deepEqual(settled.consumption,{state:'consumed',initialPlanReservationId:claimed.reservation.id});
 assert.equal(f.hub.voidOrdinaryPlanInput('p',{operationId:pending.operation.operationId,expectedPlanInputRevision:1},authority.reader()).ok,false);
});
test('close then delete appends both owner audits without rewriting the original operation or reviving its head',async t=>{
 const f=await fixture(t),pending=f.hub.applyOrdinaryProjectInput('p',add(),user());
 assert.equal(f.hub.handleCloseProject('p','',userControl).ok,true);assert.equal(f.hub.deleteProject('p',userControl).ok,true);
 assert.equal(f.hub.deleteProject('p',userControl).ok,false);const settled=f.reopen().readOrdinaryProjectOperation('p',pending.operation.operationId,authority.reader());
 assert.equal(settled.operation.status,'voided');assert.equal(settled.operation.projectDisposition,'deleted');
 f.hub.closePersistence();const disk=createSqlitePersistence({filePath:f.filePath});try{
  const saved=disk.load(),original=saved.protocolReceipts.find(r=>r.id===pending.operation.operationId);
  assert.equal(original.outcome,'accepted');assert.equal(original.reasonCode,undefined);
  assert.deepEqual(saved.protocolReceipts.filter(r=>r.kind==='ordinary_input_owner_terminal_receipt').map(r=>r.projectDisposition).sort(),['closed','deleted']);
 }finally{disk.close();}
});
test('project omission without an authenticated terminal receipt never unlocks deleted-operation reads',async t=>{
 const f=await fixture(t),pending=f.hub.applyOrdinaryProjectInput('p',add(),user());f.hub.closePersistence();
 const disk=createSqlitePersistence({filePath:f.filePath});try{disk.load();disk.save({entities:[],scope:{type:'full'}});}finally{disk.close();}
 assert.equal(f.reopen().readOrdinaryProjectOperation('p',pending.operation.operationId,authority.reader()).error,'PROJECT_NOT_FOUND');
});
for(const terminal of ['close','delete'])for(const afterCommit of [false,true])test(terminal+' original save '+(afterCommit?'post-commit unknown preserves':'pre-commit error rolls back')+' the complete owner write set',async t=>{
 const root=mkdtempSync(join(tmpdir(),'ordinary-terminal-fault-')),filePath=join(root,'state.sqlite');let fail=false;
 const disk=createSqlitePersistence({filePath}),persistence={...disk,save(...args){if(fail&&!afterCommit)throw Error('actual_terminal_save_failure');const result=disk.save(...args);if(fail){const error=Error('actual_terminal_post_commit_unknown');error.durableCommitted=true;throw error;}return result;}};
 let hub=createHub({silent:true,persistence,brokerClient:{async getRoomSnapshot(){return {ok:true,room:{status:'active'},members:[{status:'active',subject:{kind:'agent',logicalAgentId:'po'}}]};},async acquireRoomMembershipLease(){return {ok:true};}}});
 t.after(()=>{hub.closePersistence();rmSync(root,{recursive:true,force:true});});
 await hub.createProject({id:'p',name:'P',goal:'G',poAgent:'po',primaryRoomId:'room',autoAssignPo:false},{requestSource:'user',projectInputAuthority:authority.creator('main-create-fixture')});
 const pending=hub.applyOrdinaryProjectInput('p',add(),user()),before=structuredClone(hub.getProject('p')),actions=structuredClone(hub.getHumanActions('p'));
 fail=true;assert.throws(()=>terminal==='close'?hub.handleCloseProject('p','',userControl):hub.deleteProject('p',userControl),afterCommit?/actual_terminal_post_commit_unknown/:/actual_terminal_save_failure/);
 if(!afterCommit){assert.deepEqual(hub.getProject('p'),before);assert.deepEqual(hub.getHumanActions('p'),actions);}
 else if(terminal==='delete')assert.equal(hub.getProject('p'),undefined);
 hub.closePersistence();hub=createHub({silent:true,dataDir:{backend:'sqlite',filePath}});
 const observed=hub.readOrdinaryProjectOperation('p',pending.operation.operationId,authority.reader());
 assert.equal(observed.ok,true);assert.equal(observed.operation.status,afterCommit?'voided':'accepted_pending');
 if(!afterCommit){assert.equal(hub.getProject('p').status,before.status);assert.deepEqual(hub.getHumanActions('p'),actions);}
 else assert.equal(observed.operation.projectDisposition,terminal==='close'?'closed':'deleted');
});

for(const terminal of ['close','delete'])test('terminal '+terminal+' private scope/user guard rejects sibling actor bypass before any business or audit write',async t=>{
 const f=await fixture(t);f.hub.applyOrdinaryProjectInput('p',add(),user());
 const before=structuredClone(f.hub.getProject('p')),actions=structuredClone(f.hub.getHumanActions('p'));
 const foreign=createProjectInputAuthority({...scope,workspaceId:'c'.repeat(64)});
 for(const context of [undefined,{}, {requestSource:'agent',projectInputAuthority:authority.reader()},{requestSource:'scheduler',projectInputAuthority:authority.reader()}, {requestSource:'user'}, {requestSource:'user',projectInputAuthority:{}}, {requestSource:'user',projectInputAuthority:foreign.reader()}, {requestSource:'user',projectInputAuthority:user()}]){
  const result=terminal==='close'?f.hub.handleCloseProject('p','',context):f.hub.deleteProject('p',context);
  assert.deepEqual(result,{ok:false,error:'PROJECT_INPUT_AUTHORITY_REQUIRED'});assert.deepEqual(f.hub.getProject('p'),before);assert.deepEqual(f.hub.getHumanActions('p'),actions);
 }
 assert.equal(Object.hasOwn(f.hub,'terminalReaction'),false);
});
for(const status of ['closed','delivered'])test('generic server project mutation cannot bypass pending-input terminal settlement via '+status,async t=>{
 const f=await fixture(t),pending=f.hub.applyOrdinaryProjectInput('p',add(),user()),before=structuredClone(f.hub.getProject('p'));
 assert.throws(()=>f.hub.mutateProjectState('p',()=>{f.hub.getProject('p').status=status;}),/INITIAL_PLAN_CLAIM_REQUIRED/);
 assert.deepEqual(f.hub.getProject('p'),before);
 assert.equal(f.reopen().readOrdinaryProjectOperation('p',pending.operation.operationId,authority.reader()).operation.status,'accepted_pending');
 assert.equal(f.hub.getProject('p').status,'created');
});
test('final-delivery approval cannot advance an uncommitted Main plan through its terminal sibling',async t=>{
 const f=await fixture(t);f.hub.applyOrdinaryProjectInput('p',add(),user());
 const candidate=f.hub.registerFinalDeliverable('p',{kind:'none',requiresReview:false,idempotencyKey:'original-user-final'},{requestSource:'user',actorId:'user'});assert.equal(candidate.ok,true);
 const before=structuredClone(f.hub.getProject('p'));
 assert.equal(f.hub.approveFinalDeliverable('p',candidate.finalDeliverable.deliverableId,{idempotencyKey:'original-user-approval'}, {requestSource:'user',actorId:'user'}).error,'INITIAL_PLAN_CLAIM_REQUIRED');
 assert.deepEqual(f.hub.getProject('p'),before);
});
test('pending input does not enter an asynchronous generic server writer or trust an unobserved Promise tail',async t=>{
 const f=await fixture(t);f.hub.applyOrdinaryProjectInput('p',add(),user());let entered=0;
 assert.throws(()=>f.hub.mutateProjectState('p',async()=>{entered++;f.hub.getProject('p').status='closed';}),/INITIAL_PLAN_CLAIM_REQUIRED/);assert.equal(entered,0);
 assert.throws(()=>f.hub.mutateProjectState('p',()=>{f.hub.getProject('p').status='closed';return Promise.resolve();}),/INITIAL_PLAN_CLAIM_REQUIRED/);
 assert.equal(f.hub.getProject('p').status,'created');assert.equal(f.hub.getPersistenceHealth().status,'failed');
 assert.equal(f.reopen().getProject('p').status,'created');
});
test('user deletion may terminate a corrupted retained body without claiming its content or making a permanent copy',async t=>{
 const f=await fixture(t),pending=f.hub.applyOrdinaryProjectInput('p',add(),user());
 f.hub.mutateProjectState('p',()=>{f.hub.getProject('p').ordinaryInputBodies[pending.operation.operationId]='changed or deleted by retention';});
 assert.equal(f.hub.claimInitialPlanInputs('p',planFor(f.hub),authority.planner()).error,'PLAN_INPUT_BODY_INTEGRITY_FAILED');
 assert.equal(f.hub.deleteProject('p',userControl).ok,true);
 const observed=f.reopen().readOrdinaryProjectOperation('p',pending.operation.operationId,authority.reader());assert.equal(observed.operation.status,'voided');assert.equal(observed.operation.contentHash,pending.operation.contentHash);assert.deepEqual(observed.consumption,{state:'not_consumed'});
});
for(const damage of ['binding','lifecycle','terminal'])test('logical protected '+damage+' damage blocks a terminal mutation without falling back to an older authority',async t=>{
 const f=await fixture(t);f.hub.applyOrdinaryProjectInput('p',add(),user());
 if(damage==='terminal')assert.equal(f.hub.handleCloseProject('p','',userControl).ok,true);
 f.hub.closePersistence();let bytesBefore;
 const raw=new DatabaseSync(f.filePath);try{
  const collection=damage==='lifecycle'?'protocolHead':'protocolReceipt',kind=damage==='binding'?'project_protocol_binding':damage==='lifecycle'?'ordinary_input_lifecycle':'ordinary_input_owner_terminal_receipt';
  const row=raw.prepare('SELECT entity_key,state_json FROM state_entities WHERE collection=?').all(collection).find(row=>JSON.parse(row.state_json).kind===kind);assert.ok(row);
  const value=JSON.parse(row.state_json);if(damage==='binding')value.createReceiptDigest='0'.repeat(64);else if(damage==='lifecycle')value.operationDigest='0'.repeat(64);else value.bindingDigest='0'.repeat(64);
  // Preserve the storage checksum to exercise business-proof validation rather
  // than the separately-tested physical SQLite checksum/load rejection.
  const json=serializeValue(value);raw.prepare('UPDATE state_entities SET state_json=?,checksum=? WHERE collection=? AND entity_key=?').run(json,sha256Hex(json),collection,row.entity_key);
  bytesBefore=raw.prepare('SELECT collection,entity_key,state_json,checksum,revision FROM state_entities ORDER BY collection,entity_key').all();
 }finally{raw.close();}
 const hub=f.reopen(),before=structuredClone(hub.getProject('p')),actions=structuredClone(hub.getHumanActions('p'));
 if(damage==='binding')assert.deepEqual(hub.deleteProject('p',userControl),{ok:false,error:'PROJECT_INPUT_AUTHORITY_REQUIRED'});
 else assert.throws(()=>hub.deleteProject('p',userControl),/ORDINARY_OPERATION_INTEGRITY_FAILED/);
 assert.deepEqual(hub.getProject('p'),before);assert.deepEqual(hub.getHumanActions('p'),actions);hub.closePersistence();
 const check=new DatabaseSync(f.filePath,{readOnly:true});try{assert.deepEqual(check.prepare('SELECT collection,entity_key,state_json,checksum,revision FROM state_entities ORDER BY collection,entity_key').all(),bytesBefore);}finally{check.close();}
});
for(const afterCommit of [false,true])test('delete after committed close '+(afterCommit?'unknown':'pre-commit failure')+' retains the correct exact terminal audit chain',async t=>{
 const root=mkdtempSync(join(tmpdir(),'ordinary-close-delete-fault-')),filePath=join(root,'state.sqlite');let fail=false;
 const disk=createSqlitePersistence({filePath}),persistence={...disk,save(...args){if(fail&&!afterCommit)throw Error('delete_after_close_precommit');const result=disk.save(...args);if(fail){const error=Error('delete_after_close_unknown');error.durableCommitted=true;throw error;}return result;}};
 let hub=createHub({silent:true,persistence,brokerClient:{async getRoomSnapshot(){return {ok:true,room:{status:'active'},members:[{status:'active',subject:{kind:'agent',logicalAgentId:'po'}}]};},async acquireRoomMembershipLease(){return {ok:true};}}});
 t.after(()=>{hub.closePersistence();rmSync(root,{recursive:true,force:true});});
 await hub.createProject({id:'p',name:'P',poAgent:'po',primaryRoomId:'room',autoAssignPo:false},{requestSource:'user',projectInputAuthority:authority.creator('main-create')});
 const pending=hub.applyOrdinaryProjectInput('p',add(),user());assert.equal(hub.handleCloseProject('p','',userControl).ok,true);fail=true;
 assert.throws(()=>hub.deleteProject('p',userControl),afterCommit?/delete_after_close_unknown/:/delete_after_close_precommit/);
 hub.closePersistence();hub=createHub({silent:true,dataDir:{backend:'sqlite',filePath}});
 const observed=hub.readOrdinaryProjectOperation('p',pending.operation.operationId,authority.reader());assert.equal(observed.operation.status,'voided');assert.equal(observed.operation.projectDisposition,afterCommit?'deleted':'closed');
 if(afterCommit)assert.equal(hub.deleteProject('p',userControl).ok,false);else assert.equal(hub.deleteProject('p',userControl).ok,true);
 hub.closePersistence();const reader=createSqlitePersistence({filePath});try{const state=reader.load();assert.equal(state.protocolReceipts.filter(r=>r.kind==='ordinary_input_owner_terminal_receipt').length,2);}finally{reader.close();}
});
test('authenticated followup context is a strict metadata snapshot and never authorizes or mutates new execution',async t=>{
 const f=await fixture(t),before=structuredClone(f.hub.getProject('p')),revision=f.hub.getPersistenceHealth().revision,actions=structuredClone(f.hub.getHumanActions('p'));
 const context=f.hub.readOrdinaryProjectFollowupContext('p',authority.reader());
 assert.equal(context.ok,true);assert.equal(context.protocol,'ordinary_project_followup_context_v1');assert.equal(context.classification,'ordinary');assert.equal(context.projectId,'p');assert.equal(context.primaryRoomId,'room');assert.equal(context.projectRevision,1);assert.equal(context.projectStatus,'created');
 assert.deepEqual(Object.keys(context).sort(),['ok','protocol','classification','projectId','primaryRoomId','projectRevision','projectStatus','scope','bindingDigest','canonicalCreateDigest','conversionActions'].sort());
 assert.deepEqual(context.conversionActions,{add_task:{eligible:false,reasonCode:'CANDIDATE_WORKSPACE_UNAVAILABLE'},add_revision:{eligible:false,reasonCode:'REVISION_BASE_NOT_READY'}});
 assert.match(context.bindingDigest,/^[a-f0-9]{64}$/);context.scope.workspaceId='caller mutation';
 assert.deepEqual(f.hub.getProject('p'),before);assert.deepEqual(f.hub.getHumanActions('p'),actions);assert.equal(f.hub.getPersistenceHealth().revision,revision);
 assert.deepEqual(f.hub.readOrdinaryProjectFollowupContext('p',authority.reader()).scope,scope);
 const other=createProjectInputAuthority({...scope,workspaceId:'c'.repeat(64)});
 for(const token of [undefined,{},authority.planner(),user(),other.reader()])assert.equal(f.hub.readOrdinaryProjectFollowupContext('p',token).ok,false);
 assert.equal(f.hub.handleCloseProject('p','',userControl).ok,true);assert.equal(f.hub.readOrdinaryProjectFollowupContext('p',authority.reader()).projectStatus,'closed');
 assert.equal(f.hub.deleteProject('p',userControl).ok,true);assert.equal(f.hub.readOrdinaryProjectFollowupContext('p',authority.reader()).error,'PROJECT_NOT_FOUND');
 f.hub.closePersistence();assert.equal(f.hub.readOrdinaryProjectFollowupContext('p',authority.reader()).error,'PROTECTED_PROTOCOL_STORAGE_REQUIRED');
});
test('followup context refuses malformed current metadata and never invents a missing Room',async t=>{
 const f=await fixture(t),project=f.hub.getProject('p');
 for(const revision of [0,-1,'1',Number.MAX_SAFE_INTEGER+1]){project.projectRevision=revision;assert.equal(f.hub.readOrdinaryProjectFollowupContext('p',authority.reader()).error,'PROJECT_REVISION_INVALID');}
 project.projectRevision=1;project.primaryRoomId=null;assert.equal(f.hub.readOrdinaryProjectFollowupContext('p',authority.reader()).primaryRoomId,null);
 project.primaryRoomId=' room ';assert.equal(f.hub.readOrdinaryProjectFollowupContext('p',authority.reader()).error,'PROJECT_SCOPE_UNVERIFIED');
 project.primaryRoomId='room';project.status='future-unknown-state';assert.equal(f.hub.readOrdinaryProjectFollowupContext('p',authority.reader()).error,'PROJECT_INPUT_STATE_UNAVAILABLE');
 project.status='created';assert.equal(f.hub.readOrdinaryProjectFollowupContext('p',authority.reader()).ok,true);
});
