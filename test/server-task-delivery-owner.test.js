import{test}from'node:test';
import assert from'node:assert/strict';
import{dirname,join}from'node:path';
import{existsSync,readdirSync}from'node:fs';
import{DatabaseSync}from'node:sqlite';
import{fixture}from'./fixtures/recovery-execution-admission/fixture.js';
import{bindHubServerScheduler}from'../src/core/hub.js';
import{createAgentStore}from'../src/core/agent-store.js';
import{recordRuntimeFailure}from'../src/core/runtime-health.js';
import{getProjectWorkspace}from'../src/server/project-workspace.js';
import{createServerTaskDeliveryOwner}from'../src/server/task-delivery-owner.js';
function setup(t,options={}){
 const f=fixture(t,options.persistence??{}),context=Object.freeze({requestSource:'scheduler'}),scheduler=bindHubServerScheduler(f.hub),projectsDir=join(dirname(f.filePath),'projects'),workspaces=new Map(),calls=[],events=[];let bookkeeping=0,workspaceCalls=0;
 const store=createAgentStore({filePath:join(dirname(f.filePath),'agents.json'),onTeamRelevantChange:({agentId})=>f.hub.invalidateTeamPlansForAgent(agentId)});assert.equal(store.create({id:'worker',name:'Original worker',fallbackToDesktopModel:true}).ok,true);
 const broker={isConnected:()=>true,async sendTo(target,kind,request){calls.push({target,kind,request});return options.delivery?options.delivery(target,kind,request):{deliveredCount:1,onlineRecipients:[target],offlineRecipients:[]};}};
 const owner=createServerTaskDeliveryOwner({hub:f.hub,scheduler,context,getBrokerClient:()=>broker,projectsDir,agentStore:store,getProjectWorkspace:projectId=>{workspaceCalls++;return getProjectWorkspace(workspaces,projectsDir,projectId);},resolveAgentIntentRoute:()=>({targetParticipantId:'worker-runtime'}),isAgentOnBroker:options.isOnline??(async()=>true),recordAgentRuntimeFailure:(id,failureClass,error)=>{bookkeeping++;const agent=store.get(id);store.updateRuntimeHealth(id,recordRuntimeFailure(agent.runtimeHealth,{failureClass,error}));},broadcast:event=>events.push(event),log:()=>{},desktopParticipantId:'xiaok-desktop'});
 return{...f,owner,context,store,calls,events,projectsDir,get bookkeeping(){return bookkeeping;},get workspaceCalls(){return workspaceCalls;}};
}
test('the original Server delivery composition rejects missing/copied/non-scheduler context before filesystem effects',async t=>{
 const f=setup(t);for(const context of [undefined,{...f.context},{requestSource:'user'},{requestSource:'agent'}])await assert.rejects(f.owner.send('p',[f.task.id],context),/DELIVERY_SCHEDULER_AUTHORITY/);assert.equal(f.workspaceCalls,0);assert.equal(f.calls.length,0);assert.equal(existsSync(f.projectsDir),false);
});
test('a refused original project creates no workspace or handoff and does not update native or agent health',async t=>{
 const f=setup(t);f.hub.getProject('p').status='planning';f.hub.persistState();const revision=f.persistence.revision,result=await f.owner.send('p',[f.task.id],f.context);assert.equal(result.ok,false);assert.equal(f.workspaceCalls,0);assert.equal(existsSync(f.projectsDir),false);assert.equal(f.calls.length,0);assert.equal(f.bookkeeping,0);assert.equal(f.persistence.revision,revision);
});
test('the actual agentStore to Hub native callback cannot invalidate a legitimate fallback before its send',async t=>{
 const f=setup(t,{delivery:target=>target==='worker-runtime'?{deliveredCount:0,onlineRecipients:[],offlineRecipients:[target]}:{deliveredCount:1,onlineRecipients:[target],offlineRecipients:[]}}),revision=f.persistence.revision,result=await f.owner.send('p',[f.task.id],f.context);assert.equal(result.ok,true);assert.deepEqual(f.calls.map(call=>call.target),['worker-runtime','xiaok-desktop']);assert.equal(f.bookkeeping,1);assert.ok(f.persistence.revision>revision,'the real original agent-store callback must eventually persist Hub invalidation');assert.equal(f.store.get('worker').runtimeHealth.lastFailureClass,'runtime_offline');assert.equal(f.events.length,1);assert.ok(readdirSync(join(f.projectsDir,'p'),{recursive:true}).some(name=>String(name).includes('handoff')));
});
test('a native revocation during the actual fallback online await never sends fallback or enters offline recovery',async t=>{
 let f,revisionAtRevoke;f=setup(t,{delivery:target=>({deliveredCount:0,onlineRecipients:[],offlineRecipients:[target]}),isOnline:async target=>{if(target==='xiaok-desktop'){f.hub.mutateProjectState('p',()=>{f.hub.getProject('p').status='closed';});revisionAtRevoke=f.persistence.revision;}return true;}});const result=await f.owner.send('p',[f.task.id],f.context);assert.equal(result.ok,false);assert.deepEqual(f.calls.map(call=>call.target),['worker-runtime']);assert.equal(f.bookkeeping,0);assert.equal(f.events.length,0);assert.equal(f.persistence.revision,revisionAtRevoke);
});

test('an actual original worker-failure COMMIT error is never washed into a delivery admission refusal',async t=>{
 let armed=false;const fault=Error('original delivery failure native COMMIT'),f=setup(t,{persistence:{sqliteFactory(path){const db=new DatabaseSync(path),exec=db.exec.bind(db);db.exec=sql=>{if(armed&&sql==='COMMIT'){armed=false;throw fault;}return exec(sql);};return db;}},delivery:target=>({deliveredCount:0,onlineRecipients:[],offlineRecipients:[target]})});armed=true;let caught;try{await f.owner.send('p',[f.task.id],f.context);}catch(error){caught=error;}assert.ok(caught);assert.equal(caught.name,'PersistenceCommitError');assert.equal(caught.cause,fault);assert.equal(f.bookkeeping,0);assert.deepEqual(f.calls.map(call=>call.target),['worker-runtime','xiaok-desktop']);
});
test('an original known-COMMIT copyback failure keeps its durable truth and exact cause',async t=>{
 const f=setup(t,{delivery:target=>({deliveredCount:0,onlineRecipients:[],offlineRecipients:[target]})}),project=f.hub.getProject('p');Object.defineProperty(project,'activitySnapshot',{...Object.getOwnPropertyDescriptor(project,'activitySnapshot'),writable:false});let caught;try{await f.owner.send('p',[f.task.id],f.context);}catch(error){caught=error;}assert.ok(caught);assert.equal(caught.durableCommitted,true);assert.equal(caught.code,'persistence_post_commit_failure');assert.ok(caught.cause instanceof TypeError);assert.equal(f.bookkeeping,0);const physical=f.physical(),task=JSON.parse(physical.rows.find(row=>row.collection==='board'&&row.entity_key==='p').state_json).tasks[0];assert.notEqual(task.status,'in_progress','the actual earlier failure transition has already committed');
});
test('a rejected original transport and a later source refusal retain both original causes without new recovery effects',async t=>{
 let f,revisionAtRevoke;const transport=Error('original transport outcome unknown');f=setup(t,{delivery(){f.hub.mutateProjectState('p',()=>{f.hub.getProject('p').status='closed';});revisionAtRevoke=f.persistence.revision;throw transport;}});const result=await f.owner.send('p',[f.task.id],f.context);assert.equal(result.ok,false);assert.equal(result.transportCause,transport);assert.ok(result.cause);assert.notEqual(result.cause,transport);assert.equal(f.calls.length,1);assert.equal(f.bookkeeping,0);assert.equal(f.persistence.revision,revisionAtRevoke);
});
