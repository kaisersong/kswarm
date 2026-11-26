import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createHub,bindHubServerScheduler} from '../src/core/hub.js';
import {createSqlitePersistence} from '../src/core/sqlite-persistence.js';
import {createProjectInputAuthority} from '../src/core/project-input-authority.js';
import {acceptanceRecordMatchesFloor,DURABLE_DISPATCH_WRITER_DIGEST,DURABLE_DISPATCH_WRITER_PROFILE} from '../src/core/initial-plan-acceptance-contract.js';
import {defaultDispatchActionRecord} from '../src/core/default-dispatch-action-data.js';
import {createServerTaskDeliveryOwner} from '../src/server/task-delivery-owner.js';
import {createBrokerClient} from '../src/net/broker-client.js';
import {loadOriginalControlledAckModules} from './fixtures/d19x-original-controlled-ack/load-original-modules.js';
const scope={profileId:'a'.repeat(64),workspaceId:'b'.repeat(64)},schedulerContext=Object.freeze({requestSource:'scheduler'});
function transport(f,{fetchImpl,brokerUrl}={}){
 const owner=createServerTaskDeliveryOwner({hub:f.hub,scheduler:f.port,context:schedulerContext,originalConstructionBinding:f.port.takeTaskDeliveryOwnerConstructionBinding(schedulerContext),getBrokerClient:()=>null});
 f.port.bindTaskDeliveryOwner(owner,schedulerContext);const source=f.port.takeDefaultDispatchPreparationTransportSource(owner,schedulerContext),posts=[];
 const client=createBrokerClient({participantId:'kswarm-hub',preparationSource:source,brokerUrl,fetchImpl:fetchImpl??(async(url,input)=>{posts.push({url,input});return new Response('{"ok":true,"deliveredCount":1}');})});
 f.port.bindDefaultDispatchPreparationClient(owner,client,schedulerContext);return{owner,source,client,posts};
}
// Controlled Node constructor provenance only: these tests qualify original B
// transactions, not Native/Host preparation, transport or execution resources.
async function fixture(t,{source=true,profile=6,onAfterExec,onResolve,onCurrent,preparationSourceOverride,brief='Original business payload',unconfirmedSourceFixtureCleanup=false,modules}={}){
 const root=mkdtempSync(join(tmpdir(),'dsh-child-preparation-')),filePath=join(root,'b.sqlite'),actionFrames=new WeakMap(),preparationFrames=new WeakMap(),hubs=[];let hub,port,backend,db,live=true,apis=modules??{createHub,bindHubServerScheduler,createSqlitePersistence,createProjectInputAuthority},authority,control;
 function open(){
  authority=apis.createProjectInputAuthority(scope);control={requestSource:'user',projectInputAuthority:authority.reader()};
  backend=apis.createSqlitePersistence({filePath,sqliteFactory(path){db=new DatabaseSync(path);const exec=db.exec.bind(db);db.exec=statement=>{const result=exec(statement);onAfterExec?.(statement,{backend,db,hub});return result;};return db;}});
  hub=apis.createHub({silent:true,persistence:backend,dataDir:{backend:'sqlite',filePath},projectStorageRoot:join(root,'projects'),
   defaultDispatchActionSource:{resolve(frame){const data=actionFrames.get(frame);if(!data)throw Error('original_action_required');return{data,assertCurrent(){if(!live)throw Error('source_withdrawn');}};}},
   ...(source?{defaultDispatchPreparationSource:preparationSourceOverride??{resolve(frame,purpose){onResolve?.({hub,port,backend,db});const entry=preparationFrames.get(frame);if(!entry||entry.purpose!==purpose)throw Error('original_preparation_purpose_required');return{data:entry.data,assertCurrent(){onCurrent?.({hub,port,backend,db});if(!live)throw Error('source_withdrawn');}};}}}:{}),
   brokerClient:{async getRoomSnapshot(){return{ok:true,room:{status:'active'},messages:[{messageId:'msg'}],members:['po','worker'].map(logicalAgentId=>({status:'active',subject:{kind:'agent',logicalAgentId}}))};},async acquireRoomMembershipLease(){return{ok:true};}}});hubs.push(hub);port=apis.bindHubServerScheduler(hub);
 }
 open();t.after(()=>{for(const h of hubs)try{h.closePersistence();}catch(error){if(!unconfirmedSourceFixtureCleanup||error.message!=='DEFAULT_DISPATCH_MIGRATION_BUSY')throw error;backend.close();console.log(JSON.stringify({test:'original-preparation-unknown-source-cleanup',originalHubDrainConfirmed:false,fixtureBackendClosed:true}));}rmSync(root,{recursive:true,force:true});});
 assert.equal((profile===6?hub.prepareDurableDispatchRuntimeWriter(control):hub.prepareDurableDispatchWriter(control)).ok,true);
 assert.equal((await hub.createProject({id:'p',name:'P',goal:'G',poAgent:'po',members:['worker'],primaryRoomId:'room',sourceMessageIds:['msg'],requestedStartPolicy:'plan_only',autoAssignPo:false},control)).id,'p');
 assert.equal(hub.handleHumanAddTasks('p',[{id:'a',title:'A',brief,assignedAgent:'worker'}],{requestSource:'user'}).ok,true);
 async function capture(){const r=hub.readDefaultDispatchPlan('p',authority.reader());assert.equal(r.ok,true);const p=r.plan,frame=Object.freeze({});actionFrames.set(frame,defaultDispatchActionRecord({scope,projectId:'p',planRevision:p.revision,dispatchGeneration:p.dispatchGeneration,bindingDigest:p.bindingDigest,taskSetDigest:p.taskSetDigest}));const result=hub.captureDefaultDispatchOperation('p',frame,{requestSource:'user',actorId:'desktop-user:'+scope.profileId});assert.equal(result.ok,true,JSON.stringify(result));return result;}
 const operation=await capture(),child=operation.operation.children[0],plan=hub.readDefaultDispatchPlan('p',authority.reader()).plan;
 const data={scope,writerStoreId:backend.getWriterProfile().floor.storeId,projectId:'p',bindingDigest:plan.bindingDigest,childKey:child.childKey,payloadHash:child.payloadHash,hostId:'original-host',targetParticipantId:'desktop-runtime',targetIncarnation:'controlled-node-fixture-1',inputMapperVersion:'kswarm_task_handoff_prompt_v1',inputDigest:'e'.repeat(64)};
 const proof=(purpose,next=data)=>{const frame=Object.freeze(Object.create(null));preparationFrames.set(frame,{purpose,data:next});return frame;};
 return{get hub(){return hub;},get port(){return port;},get backend(){return backend;},get db(){return db;},data,child,proof,capture,withdraw(){live=false;},reopen(nextModules){hub.closePersistence();if(nextModules)apis=nextModules;open();},snapshot(){return JSON.stringify(db.prepare('SELECT * FROM state_entities ORDER BY collection,entity_key').all());}};
}
function preparationIntent(f){const result=f.port.prepareDefaultDispatchChild('p',f.proof('prepare'),schedulerContext);assert.equal(result.ok,true,JSON.stringify(result));return result.preparation;}
function admissionFrame(f,p){return f.proof('admit',{preparationIntentDigest:p.intentDigest,sourceIncarnation:'f'.repeat(64)});}
function admittedPreparation(f){const p=preparationIntent(f),result=f.port.admitDefaultDispatchChildPreparation('p',admissionFrame(f,p),schedulerContext);assert.equal(result.ok,true,JSON.stringify(result));return result.preparation;}
function admissionTransport(f,x,p=preparationIntent(f)){return f.port.admitDefaultDispatchChildPreparationTransport('p',admissionFrame(f,p),x.owner,schedulerContext);}
test('original B commits a stable prepare intent and same outbox, then observes that identity across duplicate/reopen',async t=>{
 const f=await fixture(t);assert.equal(typeof f.port.prepareDefaultDispatchChild,'function');
 const first=f.port.prepareDefaultDispatchChild('p',f.proof('prepare'),schedulerContext);assert.equal(first.ok,true,JSON.stringify(first));
 assert.equal(first.preparation.operation,'prepare');assert.equal(first.preparation.state,'requested');assert.equal(first.preparation.launchState,'blocked');assert.deepEqual(first.preparation.launchBlockedReasons,['budget_admission_unavailable','resource_admission_unavailable']);
 assert.equal(f.hub.checkProjectExecutionStart('p').error,'DEFAULT_DISPATCH_EXECUTION_UNAVAILABLE');
 const before=f.snapshot(),repeat=f.port.prepareDefaultDispatchChild('p',f.proof('prepare'),schedulerContext);assert.equal(repeat.preparation.operation,'observe');assert.equal(repeat.preparation.runId,first.preparation.runId);assert.equal(f.snapshot(),before);
 f.reopen();const after=f.port.prepareDefaultDispatchChild('p',f.proof('prepare'),schedulerContext);assert.equal(after.preparation.operation,'observe');assert.equal(after.preparation.runId,first.preparation.runId);assert.equal(after.preparation.preparationClaimId,first.preparation.preparationClaimId);assert.equal(f.snapshot(),before);
 assert.deepEqual((await f.capture()).operation.children,[f.child]);
});
for(const mode of ['absent','storage5','fake','wrong-scope','wrong-store','wrong-hash','wrong-child'])test('default-denies preparation '+mode+' without changing original B rows',async t=>{
 const f=await fixture(t,{source:mode!=='absent',profile:mode==='storage5'?5:6});assert.equal(typeof f.port.prepareDefaultDispatchChild,'function');const before=f.snapshot();let data=f.data,frame;
 if(mode==='wrong-scope')data={...data,scope:{...scope,workspaceId:'c'.repeat(64)}};
 if(mode==='wrong-store')data={...data,writerStoreId:'other-store'};
 if(mode==='wrong-hash')data={...data,payloadHash:'f'.repeat(64)};
 if(mode==='wrong-child')data={...data,childKey:'default-dispatch-child:'+'f'.repeat(64)};
 frame=mode==='fake'?Object.defineProperty({},'childKey',{get(){throw Error('must not read unknown proof');}}):f.proof('prepare',data);
 const result=f.port.prepareDefaultDispatchChild('p',frame,schedulerContext);assert.equal(result.ok,false);assert.equal(f.snapshot(),before);
});
test('same child refuses another target/incarnation rather than creating a fallback run',async t=>{
 const f=await fixture(t);assert.equal(typeof f.port.prepareDefaultDispatchChild,'function');const first=f.port.prepareDefaultDispatchChild('p',f.proof('prepare'),schedulerContext);assert.equal(first.ok,true);const before=f.snapshot();
 for(const field of ['hostId','targetParticipantId','targetIncarnation']){const result=f.port.prepareDefaultDispatchChild('p',f.proof('prepare',{...f.data,[field]:'other'}),schedulerContext);assert.equal(result.ok,false);assert.equal(f.snapshot(),before);}
});
test('preparation source purpose and scheduler admission default-deny before original transaction',async t=>{
 const f=await fixture(t);assert.equal(typeof f.port.prepareDefaultDispatchChild,'function');const before=f.snapshot();assert.equal(f.port.prepareDefaultDispatchChild('p',f.proof('acknowledge'),schedulerContext).ok,false);
 for(const requestSource of ['agent','user'])assert.throws(()=>f.port.prepareDefaultDispatchChild('p',f.proof('prepare'),{requestSource}),/SERVER_SCHEDULER_AUTHORITY_REQUIRED/);assert.equal(f.snapshot(),before);
});
test('new preparation refuses a currently closed project rather than treating its historical child as fresh admission',async t=>{
 const f=await fixture(t);f.hub.getProject('p').status='closed';const before=f.snapshot();
 const result=f.port.prepareDefaultDispatchChild('p',f.proof('prepare'),schedulerContext);assert.equal(result.ok,false);assert.equal(f.snapshot(),before);
});
// Closed controlled-source marker data exercises B graph admission only. It
// is deliberately not evidence of an actual Host fsync/Native receipt.
function metadataFact(p){return{version:1,contract:'ordinary_default_dispatch_task_preparation_v1',scope:p.scope,projectId:p.projectId,kswarmTaskId:p.kswarmTaskId,runId:p.runId,businessExecutionGeneration:p.businessExecutionGeneration,childKey:p.childKey,payloadHash:p.payloadHash,bindingDigest:p.bindingDigest,hostId:p.hostId,inputDigest:p.inputDigest,taskId:p.taskId,sessionId:p.sessionId,preparationId:p.preparationId,preparedContentDigest:'f'.repeat(64)};}
const acknowledgement=(f,p,fact=metadataFact(p),digest=p.intentDigest)=>f.proof('acknowledge',{preparationIntentDigest:digest,fact});
const physicalSnapshot=f=>JSON.stringify(['state_entities','state_entity_history','state_meta'].map(table=>f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
test('new runtime ACK without an actual effect permission is denied with no rows even after repeat or reopen',async t=>{
 const f=await fixture(t),p=admittedPreparation(f);
 const before=physicalSnapshot(f),revision=f.backend.revision;
 for(let i=0;i<2;i++){const ack=f.port.acknowledgeDefaultDispatchChild('p',acknowledgement(f,p),schedulerContext);assert.equal(ack.ok,false);assert.equal(ack.error,'DURABLE_DISPATCH_HOST_EFFECT_PERMISSION_UNAVAILABLE');assert.equal(physicalSnapshot(f),before);assert.equal(f.backend.revision,revision);}
 f.reopen();assert.equal(f.port.acknowledgeDefaultDispatchChild('p',acknowledgement(f,p),schedulerContext).ok,false);assert.equal(physicalSnapshot(f),before);assert.equal(f.hub.checkProjectExecutionStart('p').error,'DEFAULT_DISPATCH_EXECUTION_UNAVAILABLE');
});
test('frozen controlled ACK ABI generates real prepared history, then current rules cold-read and replay it without a grant',async t=>{
 const modules=await loadOriginalControlledAckModules(t),f=await fixture(t,{modules:modules.original}),p=admittedPreparation(f);
 const ack=f.port.acknowledgeDefaultDispatchChild('p',acknowledgement(f,p),schedulerContext);assert.equal(ack.ok,true,JSON.stringify(ack));assert.equal(ack.preparation.state,'prepared');assert.equal(ack.preparation.launchState,'blocked');assert.deepEqual(ack.preparation.observedFact,metadataFact(p));
 const before=f.snapshot();assert.deepEqual(f.port.acknowledgeDefaultDispatchChild('p',acknowledgement(f,p),schedulerContext),ack);assert.equal(f.snapshot(),before);
 f.reopen(modules.currentRules);const physical=physicalSnapshot(f),revision=f.backend.revision;
 const read=f.port.readDefaultDispatchChildPreparation('p',f.proof('observe'),schedulerContext);assert.equal(read.ok,true,JSON.stringify(read));assert.equal(read.preparation.state,'prepared');assert.equal(read.preparation.runId,p.runId);assert.deepEqual(read.preparation.observedFact,metadataFact(p));
 const basis=f.port.readDefaultDispatchPreparationBasis('p',f.proof('read_basis',{scope,projectId:'p',childKey:p.childKey,payloadHash:p.payloadHash}),schedulerContext);assert.equal(basis.ok,true,JSON.stringify(basis));assert.equal(basis.protocol,'ordinary_default_dispatch_preparation_basis_v2');assert.deepEqual(basis.hostEffect,{registration:null,noEffectFinish:null});assert.deepEqual(basis.observation.fact,metadataFact(p));
 assert.deepEqual(f.port.acknowledgeDefaultDispatchChild('p',acknowledgement(f,p),schedulerContext),ack);assert.equal(f.snapshot(),before);assert.equal(physicalSnapshot(f),physical);assert.equal(f.backend.revision,revision);assert.equal(f.hub.checkProjectExecutionStart('p').error,'DEFAULT_DISPATCH_EXECUTION_UNAVAILABLE');
});
test('a later plan parent does not turn an unqualified new ACK into an effect permission',async t=>{
 const f=await fixture(t),p=admittedPreparation(f);
 assert.equal(f.hub.handleHumanAddTasks('p',[{id:'b',title:'B',brief:'Second business task',assignedAgent:'worker'}],{requestSource:'user'}).ok,true);const next=await f.capture();assert.equal(next.operation.children.length,2);
 const before=physicalSnapshot(f),ack=f.port.acknowledgeDefaultDispatchChild('p',acknowledgement(f,p),schedulerContext);assert.equal(ack.ok,false);assert.equal(ack.error,'DURABLE_DISPATCH_HOST_EFFECT_PERMISSION_UNAVAILABLE');assert.equal(physicalSnapshot(f),before);
});
test('frozen real prepared history stays bound to the old child after a later plan parent under current rules',async t=>{
 const modules=await loadOriginalControlledAckModules(t),f=await fixture(t,{modules:modules.original}),p=admittedPreparation(f);
 const ack=f.port.acknowledgeDefaultDispatchChild('p',acknowledgement(f,p),schedulerContext);assert.equal(ack.ok,true);
 assert.equal(f.hub.handleHumanAddTasks('p',[{id:'b',title:'B',brief:'Second business task',assignedAgent:'worker'}],{requestSource:'user'}).ok,true);const next=await f.capture();assert.equal(next.operation.children.length,2);
 f.reopen(modules.currentRules);const before=physicalSnapshot(f),read=f.port.readDefaultDispatchChildPreparation('p',f.proof('observe'),schedulerContext);assert.equal(read.ok,true,JSON.stringify(read));assert.equal(read.preparation.runId,p.runId);assert.equal(read.preparation.state,'prepared');assert.deepEqual(f.port.acknowledgeDefaultDispatchChild('p',acknowledgement(f,p),schedulerContext),ack);assert.equal(physicalSnapshot(f),before);
});
for(const field of ['runId','payloadHash','bindingDigest','hostId','inputDigest','taskId','sessionId','preparationId','businessExecutionGeneration','scope','extra'])test('rejects a preparation acknowledgement with different '+field,async t=>{
 const f=await fixture(t),p=admittedPreparation(f),before=f.snapshot(),fact=metadataFact(p);fact[field]=field==='businessExecutionGeneration'?2:field==='scope'?{...scope,workspaceId:'c'.repeat(64)}:'other';
 assert.equal(f.port.acknowledgeDefaultDispatchChild('p',acknowledgement(f,p,fact),schedulerContext).ok,false);assert.equal(f.snapshot(),before);
});
test('rejects another intent digest and changed prepared content on a repeated acknowledgement',async t=>{
 const modules=await loadOriginalControlledAckModules(t),f=await fixture(t,{modules:modules.original}),p=admittedPreparation(f),before=f.snapshot();assert.equal(f.port.acknowledgeDefaultDispatchChild('p',acknowledgement(f,p,metadataFact(p),'f'.repeat(64)),schedulerContext).ok,false);assert.equal(f.snapshot(),before);
 assert.equal(f.port.acknowledgeDefaultDispatchChild('p',acknowledgement(f,p),schedulerContext).ok,true);const committed=f.snapshot();f.reopen(modules.currentRules);
 for(const field of ['runId','payloadHash','bindingDigest','hostId','inputDigest','taskId','sessionId','preparationId','businessExecutionGeneration','scope','extra','preparedContentDigest']){const fact=metadataFact(p);fact[field]=field==='businessExecutionGeneration'?2:field==='scope'?{...scope,workspaceId:'c'.repeat(64)}:'different';assert.equal(f.port.acknowledgeDefaultDispatchChild('p',acknowledgement(f,p,fact),schedulerContext).ok,false,field);assert.equal(f.snapshot(),committed);}
 assert.equal(f.port.acknowledgeDefaultDispatchChild('p',acknowledgement(f,p,metadataFact(p),'f'.repeat(64)),schedulerContext).ok,false);assert.equal(f.snapshot(),committed);
});
test('preparation cannot use a valid source to smuggle unrelated original project mutations into its transaction',async t=>{
 const f=await fixture(t),p=admittedPreparation(f),before=f.snapshot();f.hub.getProject('p').unexpectedPreparationField='unrelated';
 const ack=f.port.acknowledgeDefaultDispatchChild('p',acknowledgement(f,p),schedulerContext);assert.equal(ack.ok,false);assert.equal(f.snapshot(),before);
});
test('preparation retains the original Native COMMIT failure and already committed graph truth',async t=>{
 let armed=false,original;const f=await fixture(t,{onAfterExec(statement,{backend}){if(armed&&statement==='COMMIT'){armed=false;try{backend.close();}catch(error){original=error;}}}});armed=true;
 assert.throws(()=>f.port.prepareDefaultDispatchChild('p',f.proof('prepare'),schedulerContext),error=>error.name==='PersistenceCommitError'&&error.durableCommitted===true&&error.cause===original);assert.ok(original);
 const row=f.db.prepare("SELECT state_json FROM state_entities WHERE collection='protocolReceipt' AND entity_key=?").get(f.child.childKey+':preparation');assert.ok(row);assert.equal(JSON.parse(row.state_json).childKey,f.child.childKey);assert.equal(f.backend.getHealth().status,'failed');
});
test('runtime records do not extend the original storage5 classifier or unknown runtime schemas',async t=>{
 const f=await fixture(t);f.port.prepareDefaultDispatchChild('p',f.proof('prepare'),schedulerContext);const floor=f.backend.getWriterProfile().floor,old={...floor,schemaVersion:5,profile:DURABLE_DISPATCH_WRITER_PROFILE,writerProfileDigest:DURABLE_DISPATCH_WRITER_DIGEST};
 for(const suffix of [':preparation',':status',':outbox']){const row=f.db.prepare('SELECT state_json FROM state_entities WHERE entity_key=?').get(f.child.childKey+suffix),value=JSON.parse(row.state_json);assert.equal(acceptanceRecordMatchesFloor(value,floor),true);assert.equal(acceptanceRecordMatchesFloor(value,old),false);assert.equal(acceptanceRecordMatchesFloor({...value,schemaVersion:99},floor),false);}
});
test('reserves the original Hub transaction before the preparation source can reenter',async t=>{
 let f,nested,calls=0;f=await fixture(t,{onResolve(){calls++;nested=f.port.prepareDefaultDispatchChild('p',f.proof('prepare'),schedulerContext);}});
 assert.equal(f.port.prepareDefaultDispatchChild('p',f.proof('prepare'),schedulerContext).ok,true);assert.equal(calls,1);assert.equal(nested.ok,false);assert.equal(nested.error,'DURABLE_DISPATCH_OPERATION_BUSY');
});
test('refuses a bound async preparation resolver before its body runs',async t=>{
 let body=0;const f=await fixture(t,{preparationSourceOverride:{resolve:(async()=>{body++;}).bind(null)}}),before=f.snapshot();assert.equal(f.port.prepareDefaultDispatchChild('p',f.proof('prepare'),schedulerContext).ok,false);assert.equal(body,0);assert.equal(f.snapshot(),before);
});
test('does not invoke a constructor source resolve getter or a proxy trap',async t=>{
 let reads=0;for(const source of [Object.defineProperty({},'resolve',{get(){reads++;throw Error('forbidden');}}),new Proxy({},{get(){reads++;throw Error('forbidden');},getOwnPropertyDescriptor(){reads++;throw Error('forbidden');}})]){
  const f=await fixture(t,{preparationSourceOverride:source}),before=f.snapshot();assert.equal(f.port.prepareDefaultDispatchChild('p',f.proof('prepare'),schedulerContext).ok,false);assert.equal(reads,0);assert.equal(f.snapshot(),before);
 }
});
test('a failure at actual Native BEGIN preserves its original cause and zero preparation facts',async t=>{
 let armed=false,original;const f=await fixture(t,{onAfterExec(statement,{backend}){if(armed&&statement==='BEGIN IMMEDIATE'){armed=false;try{backend.close();}catch(error){original=error;}}}});const before=f.snapshot();armed=true;
 assert.throws(()=>f.port.prepareDefaultDispatchChild('p',f.proof('prepare'),schedulerContext),error=>error.name==='PersistenceCommitError'&&error.durableCommitted!==true&&error.cause===original);assert.ok(original);assert.equal(f.snapshot(),before);
});
for(const purpose of ['prepare','acknowledge'])test('exact runtime '+purpose+' data cannot borrow an inherited required field after a late Array.some hook',async t=>{
 let armed=false,getters=0,field,expected;const originalSome=Array.prototype.some;
 const f=await fixture(t,{onResolve(){if(!armed)return;Object.defineProperty(Object.prototype,field,{configurable:true,get(){getters++;return expected;}});Array.prototype.some=()=>false;}});
 let data=f.data,p;
 if(purpose==='acknowledge'){p=admittedPreparation(f);data={preparationIntentDigest:p.intentDigest,fact:metadataFact(p)};}
 field=purpose==='prepare'?'hostId':'preparationIntentDigest';expected=data[field];const damaged={...data,unexpectedField:true};delete damaged[field];const frame=f.proof(purpose,damaged),before=f.snapshot();let result;
 try{armed=true;result=(purpose==='prepare'?f.port.prepareDefaultDispatchChild:f.port.acknowledgeDefaultDispatchChild)('p',frame,schedulerContext);}finally{Array.prototype.some=originalSome;delete Object.prototype[field];}
 console.log(JSON.stringify({test:'original-runtime-required-fields',purpose,getters,ok:result.ok,changedOriginalRows:f.snapshot()!==before}));
 assert.equal(getters,0);assert.equal(result.ok,false);assert.equal(f.snapshot(),before);
});
for(const field of ['inputDigest','preparedContentDigest','targetParticipantId'])test('runtime '+field+' validation ignores a late RegExp.exec hook',async t=>{
 let armed=false;const originalExec=RegExp.prototype.exec;
 const f=await fixture(t,{onResolve(){if(!armed)return;RegExp.prototype.exec=function(text){if(this.source==='^[a-f0-9]{64}$')return ['forged'];if(this.source==='[\\x00-\\x1f\\x7f]')return null;return Reflect.apply(originalExec,this,[text]);};}});
 const purpose=field==='preparedContentDigest'?'acknowledge':'prepare';let data;
 if(purpose==='acknowledge'){const p=admittedPreparation(f);data={preparationIntentDigest:p.intentDigest,fact:{...metadataFact(p),preparedContentDigest:'not-hex'}};}
 else data={...f.data,[field]:field==='targetParticipantId'?'bad\nparticipant':'not-hex'};
 const frame=f.proof(purpose,data),before=f.snapshot();let result;
 try{armed=true;result=(purpose==='prepare'?f.port.prepareDefaultDispatchChild:f.port.acknowledgeDefaultDispatchChild)('p',frame,schedulerContext);}finally{RegExp.prototype.exec=originalExec;}
 console.log(JSON.stringify({test:'original-runtime-format-fields',field,ok:result.ok,changedOriginalRows:f.snapshot()!==before}));assert.equal(result.ok,false);assert.equal(f.snapshot(),before);
});
test('an authenticated preparation observation before birth is read-only and grants no new prepare',async t=>{
 const f=await fixture(t);assert.equal(typeof f.port.readDefaultDispatchChildPreparation,'function');const before=f.snapshot(),revision=f.backend.revision;
 const result=f.port.readDefaultDispatchChildPreparation('p',f.proof('observe'),schedulerContext);assert.equal(result.ok,false);assert.equal(f.snapshot(),before);assert.equal(f.backend.revision,revision);
});
test('the original B observer stays read-only and a new unqualified ACK cannot manufacture prepared state',async t=>{
 const f=await fixture(t);assert.equal(typeof f.port.readDefaultDispatchChildPreparation,'function');const p=admittedPreparation(f);
 const before=f.snapshot(),revision=f.backend.revision,r=f.port.readDefaultDispatchChildPreparation('p',f.proof('observe'),schedulerContext);assert.equal(r.ok,true,JSON.stringify(r));assert.equal(r.preparation.operation,'observe');assert.equal(r.preparation.runId,p.runId);assert.equal(f.snapshot(),before);assert.equal(f.backend.revision,revision);
 assert.equal(f.port.acknowledgeDefaultDispatchChild('p',acknowledgement(f,p),schedulerContext).ok,false);assert.equal(f.port.readDefaultDispatchChildPreparation('p',f.proof('observe'),schedulerContext).preparation.state,'requested');assert.equal(f.snapshot(),before);
});
test('the original B observer rejects another purpose, target and copied source before writes',async t=>{
 const f=await fixture(t);assert.equal(typeof f.port.readDefaultDispatchChildPreparation,'function');f.port.prepareDefaultDispatchChild('p',f.proof('prepare'),schedulerContext);const before=f.snapshot();
 for(const frame of [f.proof('prepare'),{},f.proof('observe',{...f.data,targetParticipantId:'other'})])assert.equal(f.port.readDefaultDispatchChildPreparation('p',frame,schedulerContext).ok,false);assert.equal(f.snapshot(),before);
});
for(const purpose of ['prepare','observe','acknowledge'])test('runtime '+purpose+' lookup refuses a missing own child key before any inherited getter',async t=>{
 let armed=false,getters=0;const f=await fixture(t,{onResolve(){if(armed)Object.defineProperty(Object.prototype,'childKey',{configurable:true,get(){getters++;return f.child.childKey;}});}});let data;
 if(purpose==='acknowledge'){const p=admittedPreparation(f);const fact={...metadataFact(p)};delete fact.childKey;data={preparationIntentDigest:p.intentDigest,fact};}
 else{data={...f.data};delete data.childKey;}
 const before=f.snapshot(),frame=f.proof(purpose,data);let result;
 try{armed=true;const action=purpose==='prepare'?f.port.prepareDefaultDispatchChild:purpose==='observe'?f.port.readDefaultDispatchChildPreparation:f.port.acknowledgeDefaultDispatchChild;result=action('p',frame,schedulerContext);}finally{delete Object.prototype.childKey;}
 console.log(JSON.stringify({test:'original-runtime-child-lookup',purpose,getters,ok:result.ok,changedOriginalRows:f.snapshot()!==before}));assert.equal(getters,0);assert.equal(result.ok,false);assert.equal(f.snapshot(),before);
});
test('only the original normal B admission COMMIT produces a one-use preparation transport proof',async t=>{
 const f=await fixture(t),x=transport(f);const first=admissionTransport(f,x);
 assert.equal(first.result.ok,true,JSON.stringify(first));assert.ok(first.proof);assert.ok(f.db.prepare("SELECT state_json FROM state_entities WHERE entity_key=?").get(f.child.childKey+':preparation'));
 assert.equal((await x.client.sendDefaultDispatchPreparation(first.proof,'scheduler')).deliveredCount,1);assert.equal(x.posts.length,1);assert.equal(JSON.parse(x.posts[0].input.body).taskId,first.result.preparation.kswarmTaskId);
 await assert.rejects(x.client.sendDefaultDispatchPreparation(first.proof,'scheduler'),/TRANSPORT_PROOF_REQUIRED/);
 const repeat=admissionTransport(f,x);assert.equal(repeat.result.preparation.operation,'observe');assert.ok(repeat.proof);
 await x.client.sendDefaultDispatchPreparation(repeat.proof,'scheduler');assert.equal(JSON.parse(x.posts[1].input.body).kind,'default_dispatch_read_preparation_v1');assert.equal(x.posts.length,2);await x.client.drainDefaultDispatchPreparations();
});
test('a transport client is prebound to the exact original source, owner and actor',async t=>{
 const f=await fixture(t),x=transport(f);let getters=0;
 const fake=Object.defineProperty({},'sendDefaultDispatchPreparation',{get(){getters++;throw Error('forbidden');}});
 assert.throws(()=>f.port.bindDefaultDispatchPreparationClient(x.owner,fake,schedulerContext),/ORIGINAL_PREPARATION_CLIENT_REQUIRED/);assert.equal(getters,0);
 const copy=createBrokerClient({participantId:'copied-source',preparationSource:{...x.source}});
 assert.throws(()=>f.port.bindDefaultDispatchPreparationClient(x.owner,copy,schedulerContext),/ORIGINAL_PREPARATION_CLIENT_REQUIRED/);
 const other=createBrokerClient({participantId:'other-client',preparationSource:x.source,fetchImpl:async()=>{throw Error('must not send');}});
 assert.throws(()=>f.port.bindDefaultDispatchPreparationClient(x.owner,other,schedulerContext),/CLIENT_BOUND/);
 assert.throws(()=>f.port.prepareDefaultDispatchChildTransport('p',f.proof('prepare'),{...x.owner},schedulerContext),/OWNER_UNAVAILABLE/);
 assert.throws(()=>f.port.prepareDefaultDispatchChildTransport('p',f.proof('prepare'),x.owner,{...schedulerContext}),/OWNER_UNAVAILABLE/);
 const r=admissionTransport(f,x);assert.ok(r.proof);
 await assert.rejects(other.sendDefaultDispatchPreparation(r.proof,'scheduler'),/OWNER_UNAVAILABLE/);assert.equal(x.posts.length,0);
 await assert.rejects(x.client.sendDefaultDispatchPreparation({...r.proof},'scheduler'),/PROOF_REQUIRED/);
 await x.client.sendDefaultDispatchPreparation(r.proof,'scheduler');assert.equal(x.posts.length,1);await x.client.drainDefaultDispatchPreparations();await other.drainDefaultDispatchPreparations();await copy.drainDefaultDispatchPreparations();
});
for(const statement of ['BEGIN IMMEDIATE','COMMIT'])test('a real Native '+statement+' failure cannot return a transport proof',async t=>{
 let armed=false,original;const f=await fixture(t,{onAfterExec(value,{backend}){if(armed&&value===statement){armed=false;try{backend.close();}catch(error){original=error;}}}}),x=transport(f);armed=true;
 assert.throws(()=>f.port.prepareDefaultDispatchChildTransport('p',f.proof('prepare'),x.owner,schedulerContext),error=>error.name==='PersistenceCommitError'&&error.cause===original&&(statement==='COMMIT'?error.durableCommitted===true:error.durableCommitted!==true));assert.ok(original);assert.equal(x.posts.length,0);
 const row=f.db.prepare("SELECT state_json FROM state_entities WHERE entity_key=?").get(f.child.childKey+':preparation');assert.equal(!!row,statement==='COMMIT');await x.client.drainDefaultDispatchPreparations();
});
test('post-COMMIT source withdrawal preserves sending graph but returns no proof',async t=>{
 let armed=false,f;f=await fixture(t,{onAfterExec(value){if(armed&&value==='COMMIT'){armed=false;f.withdraw();}}});const x=transport(f),p=preparationIntent(f);armed=true;
 const r=admissionTransport(f,x,p);assert.equal(r.result.ok,true);assert.equal(r.proof,null);assert.ok(r.transportError);assert.equal(x.posts.length,0);
 assert.equal(JSON.parse(f.db.prepare("SELECT state_json FROM state_entities WHERE entity_key=?").get(f.child.childKey+':outbox').state_json).state,'sending');await x.client.drainDefaultDispatchPreparations();
});
test('the final original source callback can seal the owner before the actual fetch',async t=>{
 let armed=false,f,x;f=await fixture(t,{onCurrent(){if(armed)f.port.sealDefaultDispatchPreparationTransport(x.owner,schedulerContext);}});x=transport(f);
 const r=admissionTransport(f,x);assert.ok(r.proof);const before=f.snapshot();armed=true;
 await assert.rejects(x.client.sendDefaultDispatchPreparation(r.proof,'scheduler'),/OWNER_UNAVAILABLE/);assert.equal(x.posts.length,0);assert.equal(f.snapshot(),before);await x.client.drainDefaultDispatchPreparations();
});
test('after reopen the same original preparation can only mint an observe hint',async t=>{
 const f=await fixture(t),x=transport(f),first=admissionTransport(f,x);assert.ok(first.proof);f.reopen();
 await assert.rejects(x.client.sendDefaultDispatchPreparation(first.proof,'scheduler'),/OWNER_UNAVAILABLE/);await x.client.drainDefaultDispatchPreparations();
 const y=transport(f),before=f.snapshot(),r=f.port.readDefaultDispatchChildPreparationTransport('p',f.proof('observe'),y.owner,schedulerContext);assert.ok(r.proof);assert.equal(r.result.preparation.operation,'observe');await y.client.sendDefaultDispatchPreparation(r.proof,'scheduler');assert.equal(JSON.parse(y.posts[0].input.body).kind,'default_dispatch_read_preparation_v1');assert.equal(f.snapshot(),before);await y.client.drainDefaultDispatchPreparations();
});
test('the real original Broker receives only bounded identity hints from committed B, including a large business payload',async t=>{
 // Cross-repo original HTTP/SQLite fixture; no production watcher or Host grant.
 const {createBrokerService}=await import('../../intent-broker/src/broker/service.js');const {createServer}=await import('../../intent-broker/src/http/server.js');
 const root=mkdtempSync(join(tmpdir(),'dsh-preparation-broker-')),broker=createBrokerService({dbPath:join(root,'broker.sqlite')}),server=createServer({broker});
 await server.listen(0,'127.0.0.1');let x;t.after(async()=>{try{await x?.client.drainDefaultDispatchPreparations();}finally{try{await server.close();}finally{broker.close();rmSync(root,{recursive:true,force:true});}}});
 const base='http://127.0.0.1:'+server.address().port,f=await fixture(t,{brief:'Large original task business payload. '.repeat(2048)});x=transport(f,{brokerUrl:base,fetchImpl:fetch});
 await x.client.register();const host=createBrokerClient({participantId:f.data.targetParticipantId,brokerUrl:base});await host.register();
 const r=admissionTransport(f,x);assert.ok(r.proof);
 const sent=await x.client.sendDefaultDispatchPreparation(r.proof,'scheduler');assert.equal(Number.isSafeInteger(sent.eventId),true,JSON.stringify(sent));assert.deepEqual(Array.from(sent.recipients),[f.data.targetParticipantId]);
 const inbox=await host.readInbox(),event=inbox.items.find(row=>row.kind==='default_dispatch_prepare_v1');assert.ok(event,JSON.stringify(inbox));
 assert.equal(event.payload.childKey,f.child.childKey);assert.equal(event.payload.payloadHash,r.result.preparation.payloadHash);assert.equal(event.payload.intentDigest,r.result.preparation.intentDigest);assert.equal(event.payload.targetIncarnation,f.data.targetIncarnation);assert.equal(Object.hasOwn(event.payload,'payload'),false);assert.equal(Object.hasOwn(event.payload,'preparation'),false);assert.ok(Buffer.byteLength(JSON.stringify(event))<16*1024);
 const before=f.snapshot(),observe=f.port.readDefaultDispatchChildPreparationTransport('p',f.proof('observe'),x.owner,schedulerContext);assert.ok(observe.proof);await x.client.sendDefaultDispatchPreparation(observe.proof,'scheduler');assert.equal(f.snapshot(),before);
 const again=await host.readInbox();assert.equal(again.items.filter(row=>row.kind==='default_dispatch_prepare_v1').length,1);assert.equal(again.items.filter(row=>row.kind==='default_dispatch_read_preparation_v1').length,1);await x.client.drainDefaultDispatchPreparations();
});
for(const kind of ['foreign','promise'])test('the original B source retains a known SDK sibling before rejecting a '+kind+' envelope',async t=>{
 let f,release;const raw=new Promise(yes=>{release=yes;});f=await fixture(t,{unconfirmedSourceFixtureCleanup:true,preparationSourceOverride:{resolve(){return Object.assign(kind==='promise'?Promise.resolve():Object.create({foreign:true}),{data:f.data,assertCurrent(){},extra:raw});}}});
 const before=f.snapshot();assert.equal(f.port.prepareDefaultDispatchChild('p',f.proof('prepare'),schedulerContext).ok,false);
 await Promise.resolve();
 try{assert.equal(f.port.inspectDeliveryGuardTails(schedulerContext).pending,1);assert.equal(f.snapshot(),before);assert.throws(()=>f.hub.closePersistence(),/DEFAULT_DISPATCH_MIGRATION_BUSY/);}finally{release();await raw;await Promise.resolve();}
 const remaining=f.port.inspectDeliveryGuardTails(schedulerContext);assert.equal(remaining.pending,0);
 console.log(JSON.stringify({test:'original-source-envelope-tail-cut',kind,pending:remaining.pending,unknown:remaining.unknown,knownRawSettled:true}));
 if(remaining.unknown)assert.throws(()=>f.hub.closePersistence(),/DEFAULT_DISPATCH_MIGRATION_BUSY/);else f.hub.closePersistence();
});
async function originalAdmissionData(t){
 const f=await fixture(t),p=admittedPreparation(f);
 const row=id=>JSON.parse(f.db.prepare("SELECT state_json FROM state_entities WHERE collection='protocolReceipt' AND entity_key=?").get(id).state_json);
 return{f,p,child:row(f.child.childKey),intent:row(f.child.childKey+':preparation'),raw:{preparationIntentDigest:p.intentDigest,sourceIncarnation:'f'.repeat(64)}};
}
test('the admission data constructor binds actual original B intent without minting any write or send authority',async t=>{
 const {runtimePreparationAdmission}=await import('../src/core/default-dispatch-preparation-admission-data.js'),{f,p,child,intent,raw}=await originalAdmissionData(t),before=f.snapshot(),revision=f.backend.revision;
 const a=runtimePreparationAdmission(child,intent,raw),b=runtimePreparationAdmission(child,intent,{...raw});assert.deepEqual(a,b);assert.equal(a.id,child.id+':preparation-admission');assert.equal(a.preparationIntentDigest,p.intentDigest);assert.equal(a.runId,p.runId);assert.equal(a.preparationClaimId,p.preparationClaimId);assert.equal(a.targetIncarnation,p.targetIncarnation);assert.equal(a.inputDigest,p.inputDigest);assert.equal(a.purpose,'prepare');assert.equal(Object.isFrozen(a.scope),true);assert.throws(()=>{a.hostId='caller mutation';},TypeError);
 assert.equal(acceptanceRecordMatchesFloor(a,f.backend.getWriterProfile().floor),true,'the new runtime6 recognizes data, not write authority');assert.equal(f.snapshot(),before);assert.equal(f.backend.revision,revision);assert.equal(f.hub.checkProjectExecutionStart('p').ok,false);
 const other=runtimePreparationAdmission(child,intent,{...raw,sourceIncarnation:'a'.repeat(64)});assert.equal(other.id,a.id);assert.notEqual(other.admissionId,a.admissionId);
});
test('admission data rejects mismatched digest and raw shape before executing any getter',async t=>{
 const {runtimePreparationAdmission}=await import('../src/core/default-dispatch-preparation-admission-data.js'),{f,child,intent,raw}=await originalAdmissionData(t);let getters=0;
 const getter=Object.defineProperty({sourceIncarnation:raw.sourceIncarnation},'preparationIntentDigest',{enumerable:true,get(){getters++;throw Error('forbidden');}}),before=f.snapshot();
 for(const value of [getter,{...raw,extra:undefined},{...raw,extra:true},{...raw,preparationIntentDigest:'a'.repeat(64)},{...raw,sourceIncarnation:'not-hex'},{...raw,sourceIncarnation:undefined},new Proxy(raw,{ownKeys(){getters++;throw Error('forbidden');}})])assert.throws(()=>runtimePreparationAdmission(child,intent,value));
 assert.equal(getters,0);assert.equal(f.snapshot(),before);
});
test('admission data captures original child and intent before reading candidate fields',async t=>{
 const {runtimePreparationAdmission}=await import('../src/core/default-dispatch-preparation-admission-data.js'),{f,child,intent,raw}=await originalAdmissionData(t);let getters=0;const before=f.snapshot();
 for(const field of ['child','intent']){const original=field==='child'?child:intent,bad={...original};Object.defineProperty(bad,'scope',{enumerable:true,get(){getters++;throw Error('forbidden');}});assert.throws(()=>runtimePreparationAdmission(field==='child'?bad:child,field==='intent'?bad:intent,raw));}
 assert.throws(()=>runtimePreparationAdmission(child,{...intent,runId:'different-run'},raw));assert.equal(getters,0);assert.equal(f.snapshot(),before);
});
