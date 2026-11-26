import assert from 'node:assert/strict';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createInterface} from 'node:readline';
import {createHub,bindHubServerScheduler} from '../../../src/core/hub.js';
import {createOwnedDefaultDispatchBusiness} from '../../../src/server/owned-default-dispatch-business.js';
import {createProjectInputAuthority} from '../../../src/core/project-input-authority.js';
import {createServerTaskDeliveryOwner} from '../../../src/server/task-delivery-owner.js';
import {createBrokerClient} from '../../../src/net/broker-client.js';
const scope={profileId:'a'.repeat(64),workspaceId:'b'.repeat(64)},root=process.env.PREPARATION_FAMILY_FIXTURE_ROOT;
assert.ok(root);const endpoint=createOwnedDefaultDispatchBusiness({scope});assert.equal(typeof endpoint.preparationSource,'object');
const hub=createHub({silent:true,dataDir:{backend:'sqlite',filePath:join(root,'state.sqlite')},projectStorageRoot:join(root,'projects'),defaultDispatchActionSource:endpoint.source,defaultDispatchPreparationSource:endpoint.preparationSource,
 brokerClient:{async getRoomSnapshot(){return{ok:true,room:{status:'active'},messages:[{messageId:'msg'}],members:['po','worker'].map(logicalAgentId=>({status:'active',subject:{kind:'agent',logicalAgentId}}))};},async acquireRoomMembershipLease(){return{ok:true};}}});
const authority=createProjectInputAuthority(scope),user={requestSource:'user',projectInputAuthority:authority.reader()};
assert.equal(hub.prepareDurableDispatchRuntimeWriter(user).ok,true);
if(!hub.getProject('p')){
await hub.createProject({id:'p',name:'P',goal:'Controlled original preparation family',poAgent:'po',members:['worker'],primaryRoomId:'room',sourceMessageIds:['msg'],requestedStartPolicy:'plan_only',autoAssignPo:false},user);
assert.equal(hub.handleSubmitPlan('p',{analysis:'Controlled empty plan',phases:[]},'po').ok,true);
assert.equal(hub.handleHumanAddTasks('p',[{id:'a',title:'A',brief:'Original immutable child',assignedAgent:'worker'}],{requestSource:'user'}).ok,true);
if(process.env.PREPARATION_FAMILY_EXTRA_TASKS==='1')assert.equal(hub.handleHumanAddTasks('p',[{id:'b',title:'B',brief:'Second original immutable child',assignedAgent:'worker'},{id:'c',title:'C',brief:'Third original immutable child',assignedAgent:'worker'}],{requestSource:'user'}).ok,true);
}
let releaseFault;
if(process.env.PREPARATION_FAMILY_HOLD_FAULT==='1'){
 const send=process.send.bind(process);
 process.send=function(message,callback){return send(message,error=>{if(message.type==='fault')releaseFault=override=>callback(override===undefined?error:override);else callback?.(error);});};
}
let releaseHostReply,releaseHostRaw;
if(process.env.PREPARATION_HOST_HOLD_RESPONSE==='1'||process.env.PREPARATION_HOST_HOLD_RAW==='1'){
 const send=process.send.bind(process);
 process.send=function(message,callback){const result=send(message,error=>{if(message.type==='response'&&message.op==='finish_host_no_effect')releaseHostReply=()=>callback?.(error);else callback?.(error);});if(message.type==='response'&&message.op==='finish_host_no_effect'&&process.env.PREPARATION_HOST_HOLD_RAW==='1')return new Promise(yes=>{releaseHostRaw=yes;});return result;};
}
const controller=endpoint.install(hub),scheduler=bindHubServerScheduler(hub),actor=Object.freeze({requestSource:'scheduler'});
const owner=createServerTaskDeliveryOwner({hub,scheduler,context:actor,originalConstructionBinding:scheduler.takeTaskDeliveryOwnerConstructionBinding(actor),getBrokerClient:()=>client});
scheduler.bindTaskDeliveryOwner(owner,actor);const source=scheduler.takeDefaultDispatchPreparationTransportSource(owner,actor),posts=[];let releaseBody;
const held=new Promise(yes=>{releaseBody=yes;});
const client=createBrokerClient({participantId:'original-b',preparationSource:source,fetchImpl(url,input){posts.push({url,input});return Promise.resolve(new Response(new ReadableStream({start(stream){held.then(()=>{if(process.env.PREPARATION_FAMILY_BODY_MODE==='reject')stream.error(Error('controlled late body failure'));else if(process.env.PREPARATION_FAMILY_BODY_MODE==='reject-undefined')stream.error(undefined);else{stream.enqueue(new TextEncoder().encode('{}'));stream.close();}});}})));}});
scheduler.bindDefaultDispatchPreparationClient(owner,client,actor);
if(process.env.PREPARATION_FAMILY_SKIP_INSTALL!=='1')controller.installPreparation(hub,owner,actor,client);
const lines=createInterface({input:process.stdin});let closing=false;
const originalExec=RegExp.prototype.exec;
lines.on('line',async line=>{
 if(line==='poison-hex'){RegExp.prototype.exec=()=>[];process.send({protocol:'fixture_hex_poisoned'});}
 if(line==='release')releaseBody();
 if(line==='revoke-preparation'){controller.sealPreparation();process.send({protocol:'fixture_preparation_revoked'});}
 if(line==='net-seal'){client.sealDefaultDispatchPreparations();process.send({protocol:'fixture_net_sealed'});}
 if(line==='release-fault')releaseFault?.();
 if(line==='release-host-reply')releaseHostReply?.();
 if(line==='release-host-raw')releaseHostRaw?.();
 if(line==='arm-host-commit-failure'){const sqlExec=DatabaseSync.prototype.exec;DatabaseSync.prototype.exec=function(sql,...args){const result=Reflect.apply(sqlExec,this,[sql,...args]);if(sql==='COMMIT'){DatabaseSync.prototype.exec=sqlExec;throw Error('controlled_host_commit_wrapper_failure');}return result;};process.send({protocol:'fixture_host_commit_armed'});}
 if(line==='release-fault-error')releaseFault?.(Error('secondary fault publisher failure'));
 if(line==='drain')controller.drain().then(()=>process.send({protocol:'fixture_drain_result',ok:true}),error=>process.send({protocol:'fixture_drain_result',ok:false,error:error?.message??String(error),reasonWasUndefined:error===undefined}));
 if(line==='facts')process.send({protocol:'fixture_facts',posts:posts.map(row=>JSON.parse(row.input.body)),notNativeQualification:true});
 if(line==='close'&&!closing){closing=true;let failure,failed=false;const keep=error=>{if(!failed){failed=true;failure=error;}};
  RegExp.prototype.exec=originalExec;
  try{await controller.drain();}catch(error){keep(error);}
  try{await client.drainDefaultDispatchPreparations();}catch(error){keep(error);}
  try{hub.closePersistence();}catch(error){keep(error);}
  lines.close();process.exit(failed?1:0);
 }
});
process.send({protocol:'fixture_ready',notNativeQualification:true,writerStoreId:hub.inspectDefaultDispatchWriter(user).profile.floor.storeId});
