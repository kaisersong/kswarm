import {protocolDigest} from '../src/core/project-protocol.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {createHub,bindHubServerScheduler,bindHubDefaultDispatchPreparation} from '../src/core/hub.js';
import {createSqlitePersistence} from '../src/core/sqlite-persistence.js';
import {createProjectInputAuthority} from '../src/core/project-input-authority.js';
import {defaultDispatchActionRecord} from '../src/core/default-dispatch-action-data.js';
import {createServerTaskDeliveryOwner} from '../src/server/task-delivery-owner.js';
import {createBrokerClient} from '../src/net/broker-client.js';
import {createOriginalBrokerClient} from '../src/core/original-broker-client.js';
const scope={profileId:'a'.repeat(64),workspaceId:'b'.repeat(64)},actor=Object.freeze({requestSource:'scheduler'});

// Controlled constructor source: actual original B/SQLite transactions, never
// evidence of qualified Native service/Host authentication or execution.
async function fixture(t,{onResolve,onCurrent,onExec,onAfterExec,afterRevisionWrite,beforePrepare,tasks,executionGateSchemaVersion,source=true,storageOnly=false,unconfirmedSourceFixtureCleanup=false}={}){
 const root=mkdtempSync(join(tmpdir(),'dsh-preparation-admission-')),filePath=join(root,'b.sqlite'),authority=createProjectInputAuthority(scope),actions=new WeakMap(),frames=new WeakMap(),all=[];
 let hub,port,backend,db,live=true;
 const open=()=>{
  backend=createSqlitePersistence({filePath,sqliteFactory(path){db=new DatabaseSync(path);const exec=db.exec.bind(db),prepare=db.prepare.bind(db);db.exec=sql=>{onExec?.(sql,{db,hub,backend});const result=exec(sql);onAfterExec?.(sql,{db,hub,backend});return result;};db.prepare=sql=>{const statement=prepare(sql);if(sql.includes('INSERT INTO state_meta')){const run=statement.run.bind(statement);statement.run=(...args)=>{const result=run(...args);if(args[0]==='revision')afterRevisionWrite?.({db,hub,backend});return result;};}return statement;};return db;}});
  hub=createHub({silent:true,persistence:backend,dataDir:{backend:'sqlite',filePath},projectStorageRoot:join(root,'projects'),
   defaultDispatchActionSource:{resolve(frame){const data=actions.get(frame);if(!data)throw Error('action_required');return{data,assertCurrent(){if(!live)throw Error('withdrawn');}};}},
   ...(source?{defaultDispatchPreparationSource:{resolve(frame,purpose){onResolve?.({purpose});const row=frames.get(frame);if(!row||!row.active||row.purpose!==purpose)throw Error('purpose_required');return{data:row.data,assertCurrent(){onCurrent?.({hub,port,backend,db,purpose});if(!live||!row.active)throw Error('withdrawn');}};}}}:{}),
   brokerClient:{async getRoomSnapshot(){return{ok:true,room:{status:'active'},messages:[{messageId:'msg'}],members:['po','worker'].map(logicalAgentId=>({status:'active',subject:{kind:'agent',logicalAgentId}}))};},async acquireRoomMembershipLease(){return{ok:true};}}});
  all.push({hub,backend});port=bindHubServerScheduler(hub);
 };open();t.after(()=>{let forced=0;for(const item of all)try{item.hub.closePersistence();}catch(error){if(!unconfirmedSourceFixtureCleanup||error.message!=='DEFAULT_DISPATCH_MIGRATION_BUSY')throw error;item.backend.close();forced++;}if(forced)console.log(JSON.stringify({test:'admission-unknown-source-fixture-cleanup',forcedNativeCloses:forced,notProductionDrain:true}));rmSync(root,{recursive:true,force:true});});
 await beforePrepare?.({root,filePath,db});
 const user={requestSource:'user',projectInputAuthority:authority.reader()};assert.equal((storageOnly?hub.prepareDurableDispatchWriter(user):hub.prepareDurableDispatchRuntimeWriter(user)).ok,true);
 await hub.createProject({id:'p',name:'P',goal:'Original goal',poAgent:'po',members:['worker'],primaryRoomId:'room',sourceMessageIds:['msg'],executionGateSchemaVersion,requestedStartPolicy:'plan_only',autoAssignPo:false},user);
 assert.equal(hub.handleSubmitPlan('p',{analysis:'Original empty plan',phases:[]},'po').ok,true);
 assert.equal(hub.handleHumanAddTasks('p',tasks??[{id:'a',title:'A',brief:'Original immutable input',assignedAgent:'worker'}],{requestSource:'user'}).ok,true);
 const plan=()=>hub.readDefaultDispatchPlan('p',authority.reader()).plan;
 const capture=()=>{const p=plan(),frame=Object.freeze({});actions.set(frame,defaultDispatchActionRecord({scope,projectId:'p',planRevision:p.revision,dispatchGeneration:p.dispatchGeneration,bindingDigest:p.bindingDigest,taskSetDigest:p.taskSetDigest}));const r=hub.captureDefaultDispatchOperation('p',frame,{requestSource:'user',actorId:'desktop-user:'+scope.profileId});assert.equal(r.ok,true,JSON.stringify(r));return r;};
 const child=capture().operation.children.find(row=>row.taskId==='p__a');assert.ok(child);
 const target={scope,writerStoreId:backend.getWriterProfile().floor.storeId,projectId:'p',bindingDigest:plan().bindingDigest,childKey:child.childKey,payloadHash:child.payloadHash,hostId:'host',targetParticipantId:'desktop',targetIncarnation:'original-target',inputMapperVersion:'kswarm_task_handoff_prompt_v1',inputDigest:'e'.repeat(64)};
 const frame=(purpose,data=target)=>{const proof=Object.freeze(Object.create(null));frames.set(proof,{purpose,data,active:true});return proof;};
 const admissionData=p=>({preparationIntentDigest:p.intentDigest,sourceIncarnation:'f'.repeat(64)});
 return{get hub(){return hub;},get port(){return port;},get db(){return db;},get backend(){return backend;},child,target,frame,admissionData,plan,capture,
  prepare(){const r=port.prepareDefaultDispatchChild('p',frame('prepare'),actor);assert.equal(r.ok,true,JSON.stringify(r));return r.preparation;},
  admit(p,raw=admissionData(p)){assert.equal(typeof port.admitDefaultDispatchChildPreparation,'function');return port.admitDefaultDispatchChildPreparation('p',frame('admit',raw),actor);},
  snapshot(){return JSON.stringify({entities:db.prepare('SELECT * FROM state_entities ORDER BY collection,entity_key').all(),history:db.prepare('SELECT rowid,* FROM state_entity_history ORDER BY rowid').all(),meta:db.prepare('SELECT * FROM state_meta ORDER BY meta_key').all()});},
  row(id){const r=db.prepare('SELECT state_json FROM state_entities WHERE entity_key=?').get(id);return r?JSON.parse(r.state_json):undefined;},
  reopen(){hub.closePersistence();open();},reopenAfterUnconfirmedFixtureExit(){assert.equal(unconfirmedSourceFixtureCleanup,true);backend.close();open();console.log(JSON.stringify({test:'cold-unresolved-registration',forcedNativeCloses:1,notProductionDrain:true}));},withdraw(){live=false;},
  retire(proof){const row=frames.get(proof);assert.ok(row);row.active=false;},
  closeProject(){return hub.handleCloseProject('p','Original user close',{requestSource:'user',projectInputAuthority:authority.reader()});},
 };
}
function transport(f,{fetchSdk}={}){
 const owner=createServerTaskDeliveryOwner({hub:f.hub,scheduler:f.port,context:actor,originalConstructionBinding:f.port.takeTaskDeliveryOwnerConstructionBinding(actor),getBrokerClient:()=>null});
 f.port.bindTaskDeliveryOwner(owner,actor);const source=f.port.takeDefaultDispatchPreparationTransportSource(owner,actor),posts=[];
 const client=createBrokerClient({participantId:'original-b',preparationSource:source,fetchImpl:fetchSdk??(async(url,input)=>{posts.push({url,input});return new Response('{"ok":true,"deliveredCount":1}');})});
 f.port.bindDefaultDispatchPreparationClient(owner,client,actor);return{owner,client,posts};
}
function basisLookup(f){return{scope,projectId:'p',childKey:f.child.childKey,payloadHash:f.child.payloadHash};}
function basis(f,raw=basisLookup(f)){assert.equal(typeof f.port.readDefaultDispatchPreparationBasis,'function');return f.port.readDefaultDispatchPreparationBasis('p',f.frame('read_basis',raw),actor);}
test('the preparation composition binder rejects a missing constructor source even with the original SDK client',async t=>{
 const f=await fixture(t,{source:false}),x=transport(f);assert.throws(()=>bindHubDefaultDispatchPreparation(f.hub,null,x.owner,actor,x.client),/PREPARATION_HUB_OWNER_REQUIRED/);assert.equal(x.posts.length,0);await x.client.drainDefaultDispatchPreparations();
});
test('the original B read-call sibling independently binds the admission source incarnation',async t=>{
 let release;const held=new Promise(yes=>{release=yes;}),f=await fixture(t),p=f.prepare(),x=transport(f,{fetchSdk:()=>held}),admitted=f.port.admitDefaultDispatchChildPreparationTransport('p',f.frame('admit',f.admissionData(p)),x.owner,actor),raw=x.client.sendDefaultDispatchPreparation(admitted.proof,'scheduler');raw.catch(()=>{});
 const data={scope,projectId:'p',admissionId:admitted.result.preparation.admissionId,preparationIntentDigest:p.intentDigest,sourceIncarnation:'f'.repeat(64)};
 try{const read=value=>f.port.readDefaultDispatchPreparationCall('p',f.frame('read_call',value),actor);const current=read(data);assert.equal(current.ok,true,JSON.stringify(current));assert.equal(current.sourceIncarnation,data.sourceIncarnation);assert.throws(()=>read({...data,sourceIncarnation:'8'.repeat(64)}),/CALL_UNAVAILABLE/);assert.equal(read({...data,sourceIncarnation:undefined}).ok,false);assert.equal(x.posts.length,0);}finally{release(new Response('{}'));await raw;await x.client.drainDefaultDispatchPreparations();}
});
function startPreparation(f,x,p){assert.equal(typeof x.owner.startDefaultDispatchPreparation,'function');return x.owner.startDefaultDispatchPreparation('p',f.frame('admit',f.admissionData(p)),actor);}
function sendView(f,x,record){assert.equal(typeof f.port.readDefaultDispatchPreparationSend,'function');return f.port.readDefaultDispatchPreparationSend(record,x.owner,actor);}
function sendCompletion(f,x,record){assert.equal(typeof f.port.readDefaultDispatchPreparationSendCompletion,'function');return f.port.readDefaultDispatchPreparationSendCompletion(record,x.owner,actor);}
test('the sole original delivery owner returns before body EOF while original B retains its completion',async t=>{
 let release,insideClose=false;const held=new Promise(yes=>{release=yes;}),f=await fixture(t),p=f.prepare(),x=transport(f,{fetchSdk(){assert.throws(()=>f.hub.closePersistence(),/BUSY/);insideClose=true;return Promise.resolve(new Response(new ReadableStream({start(controller){held.then(()=>{controller.enqueue(new TextEncoder().encode('{}'));controller.close();});}})));}});
 let record,completion,raw;
 try{record=startPreparation(f,x,p);assert.equal(insideClose,true);const view=sendView(f,x,record);raw=view.raw;raw.catch(()=>{});assert.equal(view.result.preparation.operation,'admit');assert.equal(view.sendStatus,'send_started');completion=sendCompletion(f,x,record);let done=false;completion.then(()=>{done=true;},()=>{done=true;});await new Promise(yes=>setTimeout(yes,10));assert.equal(done,false);f.port.assertDefaultDispatchPreparationTransportCurrent(view.result.preparation.admissionId,x.owner,actor);assert.throws(()=>f.hub.closePersistence(),/BUSY/);}finally{release();if(completion)await completion;if(raw)await raw;await x.client.drainDefaultDispatchPreparations();}
});
test('original preparation send records refuse copies unknown getters and wrong actor without writes',async t=>{
 const f=await fixture(t),p=f.prepare(),x=transport(f),before=f.snapshot();assert.equal(typeof x.owner.startDefaultDispatchPreparation,'function');let getters=0;const fake=Object.defineProperty({},'raw',{get(){getters++;throw Error('forbidden');}});
 for(const context of [undefined,{...actor},{requestSource:'user'},{requestSource:'agent'}])assert.throws(()=>x.owner.startDefaultDispatchPreparation('p',fake,context),/SCHEDULER|OWNER/);
 assert.equal(f.snapshot(),before);assert.equal(x.posts.length,0);const record=startPreparation(f,x,p),view=sendView(f,x,record);view.raw.catch(()=>{});
 for(const candidate of [fake,{...record},new Proxy(record,{get(){getters++;throw Error('forbidden');}})]){assert.throws(()=>sendView(f,x,candidate),/RECORD/);assert.throws(()=>sendCompletion(f,x,candidate),/RECORD/);}
 assert.throws(()=>f.port.readDefaultDispatchPreparationSend(record,x.owner,{...actor}),/RECORD|OWNER/);assert.equal(getters,0);await sendCompletion(f,x,record);await x.client.drainDefaultDispatchPreparations();
});
test('a send without original admission proof invokes no SDK and has a genuine no-SDK completion',async t=>{
 const f=await fixture(t),x=transport(f),before=f.snapshot();assert.equal(typeof x.owner.startDefaultDispatchPreparation,'function');const record=x.owner.startDefaultDispatchPreparation('p',{},actor),view=sendView(f,x,record);assert.equal(view.result.ok,false);assert.equal(view.raw,null);assert.equal(view.sendStatus,'not_invoked');assert.equal(x.posts.length,0);assert.equal(f.snapshot(),before);await sendCompletion(f,x,record);await x.client.drainDefaultDispatchPreparations();
});
test('repeated original preparation sends only request observation with stable admitted identity',async t=>{
 const f=await fixture(t),p=f.prepare(),x=transport(f),first=startPreparation(f,x,p),a=sendView(f,x,first);a.raw.catch(()=>{});await sendCompletion(f,x,first);
 const before=f.snapshot(),again=startPreparation(f,x,p),b=sendView(f,x,again);b.raw.catch(()=>{});assert.equal(b.result.preparation.operation,'observe');assert.equal(b.sendStatus,'observe_requested');assert.equal(b.result.preparation.runId,a.result.preparation.runId);await sendCompletion(f,x,again);assert.equal(f.snapshot(),before);assert.deepEqual(x.posts.map(row=>JSON.parse(row.input.body).kind),['default_dispatch_prepare_v1','default_dispatch_read_preparation_v1']);await x.client.drainDefaultDispatchPreparations();
});
test('original completion remains readable after seal and a late HTTP failure revokes the call before EOF',async t=>{
 let controller;const f=await fixture(t),p=f.prepare(),x=transport(f,{fetchSdk:()=>Promise.resolve(new Response(new ReadableStream({start(value){controller=value;}}),{status:403}))}),record=startPreparation(f,x,p),view=sendView(f,x,record);view.raw.catch(()=>{});const completion=sendCompletion(f,x,record);completion.catch(()=>{});
 try{await new Promise(yes=>setImmediate(yes));assert.throws(()=>f.port.assertDefaultDispatchPreparationTransportCurrent(view.result.preparation.admissionId,x.owner,actor),/UNQUALIFIED/);f.port.sealDefaultDispatchPreparationTransport(x.owner,actor);assert.equal(sendCompletion(f,x,record),completion);let done=false;completion.then(()=>{done=true;},()=>{done=true;});await new Promise(yes=>setTimeout(yes,10));assert.equal(done,false);}finally{if(controller){controller.enqueue(new TextEncoder().encode('{}'));controller.close();}await assert.rejects(completion,/HTTP_FAILED/);await x.client.drainDefaultDispatchPreparations();}
});
test('an unobservable original Net SDK keeps the Hub reservation strong after logical failure',async t=>{
 let getters=0;const f=await fixture(t,{unconfirmedSourceFixtureCleanup:true}),p=f.prepare(),unknown=Object.defineProperty({},'then',{get(){getters++;throw Error('forbidden');}}),x=transport(f,{fetchSdk:()=>unknown}),record=startPreparation(f,x,p),view=sendView(f,x,record);view.raw.catch(()=>{});const completion=sendCompletion(f,x,record);let done=false;completion.then(()=>{done=true;},()=>{done=true;});
 await assert.rejects(view.raw,/SDK_UNCONFIRMED/);await new Promise(yes=>setTimeout(yes,10));assert.equal(done,false);assert.equal(view.sendStatus,'unconfirmed');assert.equal(getters,0);assert.throws(()=>f.hub.closePersistence(),/BUSY/);x.client.sealDefaultDispatchPreparations();
});
test('a changed native Promise environment cannot create an unobserved rejected bridge or clear the original reservation',async t=>{
 const f=await fixture(t,{unconfirmedSourceFixtureCleanup:true}),p=f.prepare(),species=Object.getOwnPropertyDescriptor(Promise,Symbol.species);let getters=0,release;const held=new Promise(yes=>{release=yes;}),x=transport(f,{fetchSdk(){Object.defineProperty(Promise,Symbol.species,{configurable:true,get(){getters++;throw Error('forbidden species');}});return held;}});let record;
 try{record=startPreparation(f,x,p);}finally{Object.defineProperty(Promise,Symbol.species,species);release(new Response('{}'));}
 const view=sendView(f,x,record);view.raw.catch(()=>{});assert.equal(view.sendStatus,'unconfirmed');assert.throws(()=>sendCompletion(f,x,record),/COMPLETION_UNCONFIRMED/);await assert.rejects(view.raw,/SDK_UNCONFIRMED/);assert.equal(getters,0);assert.throws(()=>f.hub.closePersistence(),/BUSY/);x.client.sealDefaultDispatchPreparations();
});
for(const statement of ['BEGIN IMMEDIATE','COMMIT'])test('the sole owner preserves the original '+statement+' cause and invokes no Net after a Native admission failure',async t=>{
 let armed=false,original;const f=await fixture(t,{onAfterExec(sql,{backend}){if(armed&&sql===statement){armed=false;try{backend.close();}catch(error){original=error;}}}}),p=f.prepare(),x=transport(f);armed=true;
 assert.throws(()=>startPreparation(f,x,p),error=>error.name==='PersistenceCommitError'&&error.cause===original&&(statement==='COMMIT'?error.durableCommitted===true:error.durableCommitted!==true));assert.ok(original);assert.equal(x.posts.length,0);assert.equal(!!f.row(f.child.childKey+':preparation-admission'),statement==='COMMIT');await x.client.drainDefaultDispatchPreparations();
});
test('a reentrant sole-owner preparation reports busy as an inert result before any second source or SDK',async t=>{
 let armed=false,f,x,p,nested;f=await fixture(t,{onCurrent({purpose}){if(armed&&purpose==='admit'){armed=false;nested=x.owner.startDefaultDispatchPreparation('p',f.frame('admit',f.admissionData(p)),actor);}}});p=f.prepare();x=transport(f);armed=true;const record=startPreparation(f,x,p),view=sendView(f,x,record);view.raw.catch(()=>{});
 try{const busy=sendView(f,x,nested);assert.equal(busy.result?.error,'DURABLE_DISPATCH_OPERATION_BUSY');assert.equal(busy.raw,null);assert.equal(busy.sendStatus,'not_invoked');await sendCompletion(f,x,nested);}finally{await sendCompletion(f,x,record);await x.client.drainDefaultDispatchPreparations();}assert.equal(x.posts.length,1);
});
test('the sole-owner preparation refuses the original generic save cut before source or Net entry',async t=>{
 let armed=false,f,x,p,record,resolves=0;f=await fixture(t,{onResolve({purpose}){if(purpose==='admit')resolves++;},afterRevisionWrite(){if(armed){armed=false;record=x.owner.startDefaultDispatchPreparation('p',f.frame('admit',f.admissionData(p)),actor);}}});p=f.prepare();x=transport(f);armed=true;
 assert.equal(f.hub.handleHumanAddTasks('p',[{id:'b',title:'Later task',assignedAgent:'worker'}],{requestSource:'user'}).ok,true);const view=sendView(f,x,record);assert.equal(view.result.error,'DURABLE_DISPATCH_OPERATION_BUSY');assert.equal(view.raw,null);assert.equal(resolves,0);assert.equal(x.posts.length,0);await sendCompletion(f,x,record);await x.client.drainDefaultDispatchPreparations();
});
test('the preparation basis reads one original child graph before intent and after admission without writes',async t=>{
 const f=await fixture(t),before=f.snapshot(),r=basis(f);assert.equal(r.ok,true,JSON.stringify(r));assert.equal(r.protocol,'ordinary_default_dispatch_preparation_basis_v2');assert.deepEqual(r.hostEffect,{registration:null,noEffectFinish:null});assert.equal(r.child.id,f.child.childKey);assert.equal(r.child.payloadHash,f.child.payloadHash);assert.equal(r.intent,null);assert.equal(r.admission,null);assert.equal(r.observation,null);assert.equal(Object.isFrozen(r.child.payload),true);assert.equal(f.snapshot(),before);
 const p=f.prepare();f.admit(p);const admitted=f.snapshot(),current=basis(f);assert.equal(current.ok,true,JSON.stringify(current));assert.deepEqual(current.intent,f.row(f.child.childKey+':preparation'));assert.deepEqual(current.admission,f.row(f.child.childKey+':preparation-admission'));assert.equal(current.observation,null);assert.equal(f.snapshot(),admitted);assert.equal(f.hub.checkProjectExecutionStart('p').ok,false);
 f.reopen();assert.deepEqual(basis(f),current);assert.equal(f.snapshot(),admitted);
});
test('basis requires its independent source purpose before reading any unknown frame getters',async t=>{
 const f=await fixture(t,{unconfirmedSourceFixtureCleanup:true}),before=f.snapshot();assert.equal(typeof f.port.readDefaultDispatchPreparationBasis,'function');let getters=0;
 const fake=Object.defineProperty({},'scope',{get(){getters++;throw Error('forbidden');}});
 assert.equal(f.port.readDefaultDispatchPreparationBasis('p',fake,actor).ok,false);assert.equal(f.port.readDefaultDispatchPreparationBasis('p',f.frame('observe'),actor).ok,false);
 for(const requestSource of ['user','agent'])assert.throws(()=>f.port.readDefaultDispatchPreparationBasis('p',fake,{requestSource}),/SCHEDULER/);
 const malformed=Object.defineProperty({...basisLookup(f)},'payloadHash',{enumerable:true,get(){getters++;throw Error('forbidden');}});
 assert.equal(basis(f,malformed).ok,false);assert.equal(getters,0);assert.equal(f.snapshot(),before);
});
test('basis source data binds exact scope project key and original immutable payload hash',async t=>{
 const f=await fixture(t),before=f.snapshot();
 for(const raw of [{...basisLookup(f),extra:true},{...basisLookup(f),projectId:'other'},{...basisLookup(f),scope:{...scope,profileId:'c'.repeat(64)}},{...basisLookup(f),payloadHash:'0'.repeat(64)}])assert.equal(basis(f,raw).ok,false);
 assert.equal(f.snapshot(),before);f.closeProject();assert.equal(basis(f).ok,true);
});
test('basis rejects the original in-flight admission SQL cut before invoking source',async t=>{
 let armed=false,f,observed,sourceReads=0,resolves=0;f=await fixture(t,{onResolve({purpose}){if(purpose==='read_basis')resolves++;},onCurrent({purpose}){if(purpose==='read_basis')sourceReads++;},onAfterExec(sql){if(armed&&sql==='BEGIN IMMEDIATE'){armed=false;observed=basis(f);}}});const p=f.prepare();armed=true;assert.equal(f.admit(p).ok,true);assert.equal(observed.error,'DURABLE_DISPATCH_OPERATION_BUSY');assert.equal(sourceReads,0);assert.equal(resolves,0);assert.equal(basis(f).ok,true);
});
test('basis revalidates physical graph after its last source callback without repairing corruption',async t=>{
 let armed=false,f,checks=0;f=await fixture(t,{onCurrent({purpose,db}){if(armed&&purpose==='read_basis'&&++checks===2){armed=false;db.prepare("DELETE FROM state_entities WHERE collection='protocolReceipt' AND entity_key=?").run(f.child.childKey);}}});armed=true;
 assert.equal(basis(f).ok,false);assert.equal(checks,2);assert.equal(f.row(f.child.childKey),undefined);
});
test('basis reads a historical storage-five child without enabling runtime writes',async t=>{
 const f=await fixture(t,{storageOnly:true}),before=f.snapshot(),r=basis(f);assert.equal(r.ok,true,JSON.stringify(r));assert.equal(r.intent,null);assert.equal(r.admission,null);assert.equal(r.observation,null);assert.equal(f.port.prepareDefaultDispatchChild('p',f.frame('prepare'),actor).ok,false);assert.equal(f.snapshot(),before);
});
test('basis refuses the original generic Human save frame before invoking source',async t=>{
 let armed=false,f,observed,sourceReads=0,resolves=0;f=await fixture(t,{onResolve({purpose}){if(purpose==='read_basis')resolves++;},onCurrent({purpose}){if(purpose==='read_basis')sourceReads++;},afterRevisionWrite(){if(armed){armed=false;observed=basis(f);}}});armed=true;
 assert.equal(f.hub.handleHumanAddTasks('p',[{id:'b',title:'Later task',assignedAgent:'worker'}],{requestSource:'user'}).ok,true);assert.equal(observed.error,'DURABLE_DISPATCH_OPERATION_BUSY');assert.equal(sourceReads,0);assert.equal(resolves,0);assert.equal(basis(f).ok,true);
});
test('basis preserves independent source withdrawal and denies reentrant basis reads',async t=>{
 let armed=false,f,nested,checks=0;f=await fixture(t,{onCurrent({purpose}){if(!armed||purpose!=='read_basis')return;if(++checks===1)nested=basis(f);else f.withdraw();}});armed=true;const before=f.snapshot();assert.equal(basis(f).ok,false);assert.equal(nested.error,'DURABLE_DISPATCH_OPERATION_BUSY');assert.equal(checks,2);assert.equal(f.snapshot(),before);
});
test('a preparation intent COMMIT alone cannot mint a first-send proof',async t=>{
 const f=await fixture(t),x=transport(f),r=f.port.prepareDefaultDispatchChildTransport('p',f.frame('prepare'),x.owner,actor);
 assert.equal(r.result.ok,true);assert.equal(r.proof,null);assert.equal(r.transportError?.message,'DURABLE_DISPATCH_PREPARATION_ADMISSION_REQUIRED');assert.equal(x.posts.length,0);await x.client.drainDefaultDispatchPreparations();
});
test('original B commits one immutable admission in the same graph, with stable run and blocked launch',async t=>{
 const f=await fixture(t),p=f.prepare(),revision=f.backend.revision,r=f.admit(p);assert.equal(r.ok,true,JSON.stringify(r));assert.equal(r.preparation.operation,'admit');assert.match(r.preparation.admissionId,/^default-dispatch-preparation-admission:/);
 const admission=f.row(f.child.childKey+':preparation-admission');assert.equal(admission.admissionId,r.preparation.admissionId);assert.equal(admission.preparationIntentDigest,p.intentDigest);assert.equal(admission.runId,p.runId);assert.equal(admission.sourceIncarnation,'f'.repeat(64));assert.equal(f.backend.revision,revision+1);
 const head=f.row(f.child.childKey+':status'),outbox=f.row(f.child.childKey+':outbox');assert.equal(head.revision,3);assert.equal(outbox.revision,3);assert.equal(head.preparationAdmissionReceiptId,admission.id);assert.equal(outbox.preparationAdmissionReceiptId,admission.id);assert.equal(head.launchState,'blocked');assert.equal(f.hub.checkProjectExecutionStart('p').ok,false);
 const before=f.snapshot(),again=f.admit(p);assert.equal(again.preparation.operation,'observe');assert.equal(again.preparation.admissionId,r.preparation.admissionId);assert.equal(f.snapshot(),before);
 assert.equal(f.admit(p,{...f.admissionData(p),sourceIncarnation:'a'.repeat(64)}).ok,false);assert.equal(f.snapshot(),before);
 f.reopen();assert.equal(f.admit(p).preparation.operation,'observe');assert.equal(f.snapshot(),before);
});
test('admission requires its independent original source purpose, exact digest and raw two-field shape',async t=>{
 const f=await fixture(t,{unconfirmedSourceFixtureCleanup:true}),p=f.prepare();assert.equal(typeof f.port.admitDefaultDispatchChildPreparation,'function');const before=f.snapshot();let getters=0;
 for(const frame of [{},f.frame('prepare'),f.frame('observe')])assert.equal(f.port.admitDefaultDispatchChildPreparation('p',frame,actor).ok,false);
 const getter=Object.defineProperty({sourceIncarnation:'f'.repeat(64)},'preparationIntentDigest',{enumerable:true,get(){getters++;throw Error('forbidden');}});
 for(const raw of [{...f.admissionData(p),extra:undefined},{...f.admissionData(p),preparationIntentDigest:'a'.repeat(64)},{...f.admissionData(p),sourceIncarnation:'invalid'},getter])assert.equal(f.admit(p,raw).ok,false);
 assert.equal(getters,0);assert.equal(f.snapshot(),before);
 for(const requestSource of ['user','agent'])assert.throws(()=>f.port.admitDefaultDispatchChildPreparation('p',f.frame('admit',f.admissionData(p)),{requestSource}),/SCHEDULER/);
 assert.equal(f.snapshot(),before);
});
test('first admission rejects a legitimately dropped task even when the original child remains a plan member',async t=>{
 const f=await fixture(t),p=f.prepare();assert.equal(f.hub.handleRevisePlan('p',{reason:'Original cancellation',changes:[{type:'drop',itemId:'a'}]},'po').ok,true);
 assert.ok(f.plan().tasks.some(row=>row.childKey===f.child.childKey));const before=f.snapshot();const r=f.admit(p);assert.equal(r.ok,false);assert.equal(r.error,'DURABLE_DISPATCH_TASK_NOT_READY');assert.equal(f.snapshot(),before);
});
test('new parent and unrelated task do not reject an unchanged ready child at first admission',async t=>{
 const f=await fixture(t),p=f.prepare();assert.equal(f.hub.handleHumanAddTasks('p',[{id:'b',title:'Unrelated task',assignedAgent:'worker'}],{requestSource:'user'}).ok,true);f.capture();
 assert.equal(f.admit(p).ok,true);
});
test('only a normally returned admission COMMIT can mint one prepare proof and repeats can only observe',async t=>{
 const f=await fixture(t),p=f.prepare(),x=transport(f);assert.equal(typeof f.port.admitDefaultDispatchChildPreparationTransport,'function');
 const send=()=>f.port.admitDefaultDispatchChildPreparationTransport('p',f.frame('admit',f.admissionData(p)),x.owner,actor);
 const first=send();assert.equal(first.result.ok,true);assert.ok(first.proof);assert.equal(first.result.preparation.operation,'admit');
 await x.client.sendDefaultDispatchPreparation(first.proof,'scheduler');assert.equal(x.posts.length,1);const body=JSON.parse(x.posts[0].input.body);assert.equal(body.kind,'default_dispatch_prepare_v1');assert.equal(body.payload.admissionId,first.result.preparation.admissionId);
 await assert.rejects(x.client.sendDefaultDispatchPreparation(first.proof,'scheduler'),/PROOF_REQUIRED/);
 const repeat=send();assert.ok(repeat.proof);assert.equal(repeat.result.preparation.operation,'observe');await x.client.sendDefaultDispatchPreparation(repeat.proof,'scheduler');assert.equal(JSON.parse(x.posts[1].input.body).kind,'default_dispatch_read_preparation_v1');await x.client.drainDefaultDispatchPreparations();
});
test('acknowledgement without a durable admission cannot write a prepared fact',async t=>{
 const f=await fixture(t),p=f.prepare(),before=f.snapshot();
 const fact={version:1,contract:'ordinary_default_dispatch_task_preparation_v1',scope:p.scope,projectId:p.projectId,kswarmTaskId:p.kswarmTaskId,runId:p.runId,businessExecutionGeneration:p.businessExecutionGeneration,childKey:p.childKey,payloadHash:p.payloadHash,bindingDigest:p.bindingDigest,hostId:p.hostId,inputDigest:p.inputDigest,taskId:p.taskId,sessionId:p.sessionId,preparationId:p.preparationId,preparedContentDigest:'a'.repeat(64)};
 const r=f.port.acknowledgeDefaultDispatchChild('p',f.frame('acknowledge',{preparationIntentDigest:p.intentDigest,fact}),actor);assert.equal(r.ok,false);assert.equal(r.error,'DURABLE_DISPATCH_PREPARATION_ADMISSION_REQUIRED');assert.equal(f.snapshot(),before);
});
for(const statement of ['BEGIN IMMEDIATE','COMMIT'])test('a real '+statement+' fault during admission cannot return a prepare proof',async t=>{
 let armed=false,original;const f=await fixture(t,{onAfterExec(sql,{backend}){if(armed&&sql===statement){armed=false;try{backend.close();}catch(error){original=error;}}}}),p=f.prepare(),x=transport(f);
 assert.equal(typeof f.port.admitDefaultDispatchChildPreparationTransport,'function');armed=true;
 assert.throws(()=>f.port.admitDefaultDispatchChildPreparationTransport('p',f.frame('admit',f.admissionData(p)),x.owner,actor),error=>error.name==='PersistenceCommitError'&&error.cause===original&&(statement==='COMMIT'?error.durableCommitted===true:error.durableCommitted!==true));
 assert.ok(original);assert.equal(x.posts.length,0);assert.equal(!!f.row(f.child.childKey+':preparation-admission'),statement==='COMMIT');await x.client.drainDefaultDispatchPreparations();
});
test('withdrawal after admission COMMIT preserves the receipt and returns no proof',async t=>{
 let armed=false,f;f=await fixture(t,{onAfterExec(sql){if(armed&&sql==='COMMIT'){armed=false;f.withdraw();}}});const p=f.prepare(),x=transport(f);
 assert.equal(typeof f.port.admitDefaultDispatchChildPreparationTransport,'function');armed=true;
 const result=f.port.admitDefaultDispatchChildPreparationTransport('p',f.frame('admit',f.admissionData(p)),x.owner,actor);assert.equal(result.result.ok,true);assert.equal(result.proof,null);assert.ok(result.transportError);assert.ok(f.row(f.child.childKey+':preparation-admission'));assert.equal(f.row(f.child.childKey+':outbox').state,'sending');assert.equal(x.posts.length,0);await x.client.drainDefaultDispatchPreparations();
});
test('first admission checks actual private task state after its first original source guard',async t=>{
 let armed=false;const f=await fixture(t,{onCurrent({hub,purpose}){if(armed&&purpose==='admit'){armed=false;hub.getBoard('p').getTask('a').status='cancelled';}}}),p=f.prepare(),before=f.snapshot();armed=true;
 assert.equal(f.admit(p).ok,false);assert.equal(f.snapshot(),before);assert.equal(f.row(f.child.childKey+':preparation-admission'),undefined);
});
test('admission rechecks task state after actual BEGIN before staging its receipt',async t=>{
 let armed=false;const f=await fixture(t,{onAfterExec(sql,{hub}){if(armed&&sql==='BEGIN IMMEDIATE'){armed=false;hub.getBoard('p').getTask('a').status='cancelled';}}}),p=f.prepare(),before=f.snapshot();assert.equal(typeof f.port.admitDefaultDispatchChildPreparation,'function');armed=true;
 assert.throws(()=>f.admit(p),error=>error.name==='PersistenceCommitError');assert.equal(f.snapshot(),before);assert.equal(f.row(f.child.childKey+':preparation-admission'),undefined);
});
test('a post-COMMIT private task change prevents proof delivery without deleting the committed admission',async t=>{
 let armed=false;const f=await fixture(t,{onAfterExec(sql,{hub}){if(armed&&sql==='COMMIT'){armed=false;hub.getBoard('p').getTask('a').status='cancelled';}}}),p=f.prepare(),x=transport(f);assert.equal(typeof f.port.admitDefaultDispatchChildPreparationTransport,'function');armed=true;
 const result=f.port.admitDefaultDispatchChildPreparationTransport('p',f.frame('admit',f.admissionData(p)),x.owner,actor);assert.equal(result.result.ok,true);assert.equal(result.proof,null);assert.ok(f.row(f.child.childKey+':preparation-admission'));assert.equal(x.posts.length,0);await x.client.drainDefaultDispatchPreparations();
});
test('final original source current rejects a changed task before actual fetch and preserves committed admission',async t=>{
 const f=await fixture(t),p=f.prepare(),x=transport(f);assert.equal(typeof f.port.admitDefaultDispatchChildPreparationTransport,'function');
 const result=f.port.admitDefaultDispatchChildPreparationTransport('p',f.frame('admit',f.admissionData(p)),x.owner,actor);assert.ok(result.proof);const before=f.snapshot();f.hub.getBoard('p').getTask('a').status='cancelled';
 await assert.rejects(x.client.sendDefaultDispatchPreparation(result.proof,'scheduler'));assert.equal(x.posts.length,0);assert.equal(f.snapshot(),before);await x.client.drainDefaultDispatchPreparations();
});
test('an admitted marker cannot advance either head without an issued Host effect, including after reopen',async t=>{
 const f=await fixture(t),p=f.prepare();assert.equal(f.admit(p).ok,true);
 const fact={version:1,contract:'ordinary_default_dispatch_task_preparation_v1',scope:p.scope,projectId:p.projectId,kswarmTaskId:p.kswarmTaskId,runId:p.runId,businessExecutionGeneration:p.businessExecutionGeneration,childKey:p.childKey,payloadHash:p.payloadHash,bindingDigest:p.bindingDigest,hostId:p.hostId,inputDigest:p.inputDigest,taskId:p.taskId,sessionId:p.sessionId,preparationId:p.preparationId,preparedContentDigest:'a'.repeat(64)};
 const ack=()=>f.port.acknowledgeDefaultDispatchChild('p',f.frame('acknowledge',{preparationIntentDigest:p.intentDigest,fact}),actor);
 const original=f.snapshot(),r=ack();assert.equal(r.ok,false);assert.equal(r.error,'DURABLE_DISPATCH_HOST_EFFECT_PERMISSION_UNAVAILABLE');assert.equal(f.snapshot(),original);assert.equal(f.row(f.child.childKey+':status').revision,3);assert.equal(f.row(f.child.childKey+':outbox').revision,3);
 const observedBasis=basis(f);assert.equal(observedBasis.ok,true,JSON.stringify(observedBasis));assert.equal(observedBasis.observation,null);assert.equal(f.row(f.child.childKey+':prepared'),undefined);
 const before=f.snapshot();assert.deepEqual(ack(),r);assert.equal(f.snapshot(),before);f.reopen();assert.deepEqual(ack(),r);assert.equal(f.snapshot(),before);
});
test('neither a new observer nor a retired frame grants a first Host ACK after original user close',async t=>{
 const f=await fixture(t),p=f.prepare();assert.equal(f.admit(p).ok,true);
 const fact={version:1,contract:'ordinary_default_dispatch_task_preparation_v1',scope:p.scope,projectId:p.projectId,kswarmTaskId:p.kswarmTaskId,runId:p.runId,businessExecutionGeneration:p.businessExecutionGeneration,childKey:p.childKey,payloadHash:p.payloadHash,bindingDigest:p.bindingDigest,hostId:p.hostId,inputDigest:p.inputDigest,taskId:p.taskId,sessionId:p.sessionId,preparationId:p.preparationId,preparedContentDigest:'a'.repeat(64)},data={preparationIntentDigest:p.intentDigest,fact},retired=f.frame('acknowledge',data);f.retire(retired);
 assert.equal(f.hub.handleHumanAddTasks('p',[{id:'b',title:'Later task',assignedAgent:'worker'}],{requestSource:'user'}).ok,true);f.capture();assert.equal(f.closeProject().ok,true);
 const before=f.snapshot();assert.equal(f.port.acknowledgeDefaultDispatchChild('p',retired,actor).ok,false);assert.equal(f.snapshot(),before);
 const ack=f.port.acknowledgeDefaultDispatchChild('p',f.frame('acknowledge',data),actor);assert.equal(ack.ok,false);assert.equal(ack.error,'DURABLE_DISPATCH_HOST_EFFECT_PERMISSION_UNAVAILABLE');assert.equal(f.snapshot(),before);assert.equal(f.row(f.child.childKey+':status').revision,3);
});
test('the original preparation admission port defaults closed without its constructor source',async t=>{
 const f=await fixture(t,{source:false}),before=f.snapshot();assert.equal(f.port.admitDefaultDispatchChildPreparation('p',{},actor).error,'DURABLE_DISPATCH_PREPARATION_SOURCE_REQUIRED');assert.equal(f.snapshot(),before);
});
test('the original B binding rejects a construction-only client which never owned the actual SDK lane',async t=>{
 const f=await fixture(t),owner=createServerTaskDeliveryOwner({hub:f.hub,scheduler:f.port,context:actor,originalConstructionBinding:f.port.takeTaskDeliveryOwnerConstructionBinding(actor),getBrokerClient:()=>null});f.port.bindTaskDeliveryOwner(owner,actor);
 const source=f.port.takeDefaultDispatchPreparationTransportSource(owner,actor),fake=createOriginalBrokerClient({preparationSource:source,methods:{sendDefaultDispatchPreparation:async()=>({ok:true}),sealDefaultDispatchPreparations(){},drainDefaultDispatchPreparations:async()=>{}}});
 assert.throws(()=>f.port.bindDefaultDispatchPreparationClient(owner,fake,actor),/ORIGINAL_PREPARATION_CLIENT_REQUIRED/);
});
test('the original B prepare-call cut rejects unused and in-SDK proofs, allows held body, and rejects a sealed lane',async t=>{
 const f=await fixture(t),p=f.prepare();let x,check,inside=0,release;const held=new Promise(yes=>{release=yes;});
 x=transport(f,{fetchSdk(){assert.throws(()=>check());inside++;return Promise.resolve(new Response(new ReadableStream({start(controller){held.then(()=>{controller.enqueue(new TextEncoder().encode('{"ok":true}'));controller.close();});}})));}});
 const r=f.port.admitDefaultDispatchChildPreparationTransport('p',f.frame('admit',f.admissionData(p)),x.owner,actor);assert.ok(r.proof);assert.equal(typeof f.port.assertDefaultDispatchPreparationTransportCurrent,'function');
 check=()=>f.port.assertDefaultDispatchPreparationTransportCurrent(r.result.preparation.admissionId,x.owner,actor);assert.throws(check);let sent;
 try{sent=x.client.sendDefaultDispatchPreparation(r.proof,'scheduler');check();assert.equal(inside,1);x.client.sealDefaultDispatchPreparations();assert.throws(check);}finally{release();await sent;await x.client.drainDefaultDispatchPreparations();}
});
test('the actual revision UPSERT SDK cannot change task state after the first SQL guard and still admit',async t=>{
 let armed=false;const f=await fixture(t,{afterRevisionWrite({hub}){if(armed){armed=false;hub.getBoard('p').getTask('a').status='cancelled';}}}),p=f.prepare(),before=f.snapshot();armed=true;
 assert.throws(()=>f.admit(p),error=>error.name==='PersistenceCommitError');assert.equal(f.snapshot(),before);assert.equal(f.row(f.child.childKey+':preparation-admission'),undefined);
});
test('a late Object.freeze hook cannot replace the original SQL-phase checks with noops',async t=>{
 const original=Object.freeze;let armed=false,hooks=0;
 const f=await fixture(t,{onCurrent({purpose}){if(armed&&purpose==='admit')Object.freeze=value=>{if(value&&typeof value==='object'&&Object.keys(value).length===2&&typeof value.assertCurrent==='function'&&typeof value.assertLocal==='function'){hooks++;return original({assertCurrent(){},assertLocal(){}});}return original(value);};},onAfterExec(sql,{hub}){if(armed&&sql==='BEGIN IMMEDIATE')hub.getBoard('p').getTask('a').status='cancelled';}}),p=f.prepare(),before=f.snapshot();let error;
 try{armed=true;try{f.admit(p);}catch(cause){error=cause;}}finally{Object.freeze=original;}
 console.log(JSON.stringify({test:'original-runtime-checks-freeze-hook',hooks,rejected:!!error,hasAdmission:!!f.row(f.child.childKey+':preparation-admission')}));
 assert.ok(error);assert.equal(error.name,'PersistenceCommitError');assert.equal(hooks,0);assert.equal(f.snapshot(),before);
});
test('the final SQL-phase source guard cannot delete original protected lineage after earlier required-row verification',async t=>{
 let armed=false,changed=false,f;f=await fixture(t,{onCurrent({db,backend,purpose}){if(armed&&purpose==='admit'&&Number(db.prepare("SELECT meta_value FROM state_meta WHERE meta_key='revision'").get().meta_value)>backend.revision){armed=false;changed=true;db.prepare("DELETE FROM state_entities WHERE collection='protocolReceipt' AND entity_key=?").run(f.child.childKey);}}});const p=f.prepare(),before=f.snapshot();armed=true;
 assert.throws(()=>f.admit(p),error=>error.name==='PersistenceCommitError'&&error.cause?.message==='DEFAULT_DISPATCH_GRAPH_COMMIT_UNVERIFIED');assert.equal(changed,true);assert.equal(f.snapshot(),before);assert.equal(f.row(f.child.childKey+':preparation-admission'),undefined);
});
test('actual first-admission transactions reject pending tasks with lease, run or future backoff residue',async t=>{
 for(const [field,value] of [['activeRunId',false],['runLease',0],['retryNotBefore',Date.now()+60_000]]){
  const f=await fixture(t),p=f.prepare();f.hub.getBoard('p').getTask('a')[field]=value;f.hub.persistState({type:'project',projectId:'p'});const before=f.snapshot();const r=f.admit(p);assert.equal(r.ok,false);assert.equal(r.error,'DURABLE_DISPATCH_TASK_NOT_READY');assert.equal(f.snapshot(),before);
 }
});
test('actual first admission does not bypass verified-pass dependencies with missing current evaluation',async t=>{
 const f=await fixture(t,{executionGateSchemaVersion:2,tasks:[{id:'up',title:'Review',assignedAgent:'worker'},{id:'a',title:'A',assignedAgent:'worker',dependencies:['up'],dependencyPolicy:{up:'verified_pass'}}]}),p=f.prepare();
 const upstream=f.hub.getBoard('p').getTask('up');upstream.status='done';f.hub.persistState({type:'project',projectId:'p'});const before=f.snapshot();assert.equal(f.admit(p).error,'DURABLE_DISPATCH_TASK_NOT_READY');assert.equal(f.snapshot(),before);
});
async function preAdmissionRuntime(root){
 const fixtures=new URL('./fixtures/d19x-pre-admission-runtime6/',import.meta.url),manifest=JSON.parse(readFileSync(new URL('manifest.json',fixtures),'utf8')),core=new URL('../src/core/',import.meta.url),targets={};
 for(const row of manifest.files){const text=readFileSync(new URL(row.fixture,fixtures),'utf8');assert.equal(createHash('sha256').update(text).digest('hex'),row.sha256);const name=row.source.split('/').at(-1);targets[name]=join(root,'pre-admission-'+name+'.mjs');}
 for(const row of manifest.files){const text=readFileSync(new URL(row.fixture,fixtures),'utf8'),output=text.replace(/from '(\.\/[^']+)'/g,(_all,relative)=>{const name=relative.slice(2),url=targets[name]?pathToFileURL(targets[name]).href:new URL(name,core).href;return "from '"+url+"'";});writeFileSync(targets[row.source.split('/').at(-1)],output);}
 return{contract:await import(pathToFileURL(targets['initial-plan-acceptance-contract.js']).href),floor:await import(pathToFileURL(targets['sqlite-writer-floor.js']).href)};
}
test('the retained pre-admission runtime6 identity and nine precompiled SQL classes cannot write the new semantics',async t=>{
 let old,oldDb,oldFloor,compiled;const clauses=[
  ['state_entities','insert',"INSERT INTO state_entities VALUES('project','old-six','old-six','{}','x',1,'x')"],
  ['state_entities','update',"UPDATE state_entities SET updated_at='old-six'"],['state_entities','delete','DELETE FROM state_entities'],
  ['state_entity_history','insert',"INSERT INTO state_entity_history VALUES('project','old-six','old-six','{}','x',1,'x')"],
  ['state_entity_history','update',"UPDATE state_entity_history SET updated_at='old-six'"],['state_entity_history','delete','DELETE FROM state_entity_history'],
  ['state_meta','insert',"INSERT INTO state_meta VALUES('old-six','x')"],['state_meta','update',"UPDATE state_meta SET meta_value='0' WHERE meta_key='revision'"],['state_meta','delete',"DELETE FROM state_meta WHERE meta_key='revision'"],
 ];
 try{
  const f=await fixture(t,{async beforePrepare({root,filePath}){old=await preAdmissionRuntime(root);oldDb=new DatabaseSync(filePath);oldFloor=old.floor.createSqliteWriterFloor(oldDb);assert.equal(oldFloor.assertWritable(),null);compiled=clauses.map(([table,operation,sql])=>({table,operation,statement:oldDb.prepare(sql)}));}});
  const current=await import('../src/core/initial-plan-acceptance-contract.js');assert.notEqual(current.DURABLE_DISPATCH_RUNTIME_WRITER_DIGEST,old.contract.DURABLE_DISPATCH_RUNTIME_WRITER_DIGEST);
  assert.equal(current.DURABLE_DISPATCH_WRITER_DIGEST,old.contract.DURABLE_DISPATCH_WRITER_DIGEST);
  const before=f.snapshot();assert.throws(()=>oldFloor.assertWritable(),/writer_floor_integrity_failed|writer_profile_unsupported/);
  for(const {table,operation,statement} of compiled){const count=oldDb.prepare('SELECT total_changes() n').get().n;assert.throws(()=>statement.run(),/writer_floor_profile_required/);assert.equal(oldDb.prepare('SELECT total_changes() n').get().n,count);assert.equal(f.snapshot(),before);console.log(JSON.stringify({test:'pre-admission-six-nine-sql',table,operation,totalChangesDelta:0}));}
 }finally{oldDb?.close();}
});

function hostRegistrationData(f,p,admissionId){return{scope,projectId:'p',childKey:f.child.childKey,payloadHash:f.child.payloadHash,admissionId,preparationIntentDigest:p.intentDigest,sourceIncarnation:'f'.repeat(64),hostLeaseKey:'7'.repeat(64)};}
function registerHost(f,x,input){assert.equal(typeof f.port.registerDefaultDispatchHostEffect,'function');return f.port.registerDefaultDispatchHostEffect('p',f.frame('register_host',input),x.owner,actor);}
test('original Host registration consumes the same admission once in real SQLite and preserves its original used Net call',async t=>{
 const f=await fixture(t,{unconfirmedSourceFixtureCleanup:true}),p=f.prepare(),x=transport(f),record=startPreparation(f,x,p),view=sendView(f,x,record);view.raw.catch(()=>{});await sendCompletion(f,x,record);
 try{
  const input=hostRegistrationData(f,p,view.result.preparation.admissionId),before=f.backend.revision,first=registerHost(f,x,input);
  assert.equal(first.ok,true,JSON.stringify(first));assert.equal(first.hostEffect.operation,'registered');assert.equal(first.hostEffect.effectPermission,'not_issued');
  const receipt=f.row(f.child.childKey+':host-registration');assert.equal(receipt.admissionId,input.admissionId);assert.equal(receipt.hostLeaseKey,input.hostLeaseKey);assert.equal(receipt.inputDigest,p.inputDigest);assert.equal(receipt.hostId,p.hostId);assert.equal(f.backend.revision,before+1);
  const head=f.row(f.child.childKey+':status'),outbox=f.row(f.child.childKey+':outbox');assert.equal(head.hostRegistrationReceiptId,receipt.id);assert.equal(outbox.hostRegistrationReceiptId,receipt.id);
  f.port.assertDefaultDispatchPreparationTransportCurrent(input.admissionId,x.owner,actor);
  const bytes=f.snapshot(),again=registerHost(f,x,input);assert.equal(again.ok,true,JSON.stringify(again));assert.equal(again.hostEffect.operation,'history');assert.equal(f.snapshot(),bytes);assert.equal(x.posts.length,1);assert.equal(f.hub.checkProjectExecutionStart('p').ok,false);
  const changed=registerHost(f,x,{...input,hostLeaseKey:'8'.repeat(64)});assert.equal(changed.ok,false);assert.equal(f.snapshot(),bytes);assert.throws(()=>f.hub.closePersistence(),/BUSY/);
 }finally{await x.client.drainDefaultDispatchPreparations();}
});
test('Host registration refuses admission metadata without its original invoked and classified prepare SDK',async t=>{
 const f=await fixture(t),p=f.prepare(),x=transport(f),admitted=f.port.admitDefaultDispatchChildPreparationTransport('p',f.frame('admit',f.admissionData(p)),x.owner,actor),before=f.snapshot();
 try{assert.throws(()=>registerHost(f,x,hostRegistrationData(f,p,admitted.result.preparation.admissionId)),/CALL_UNAVAILABLE|CALL_UNQUALIFIED/);assert.equal(f.snapshot(),before);assert.equal(x.posts.length,0);}finally{await x.client.drainDefaultDispatchPreparations();}
});
test('Host registration checks the exact original owner and source before unknown frame getters',async t=>{
 const f=await fixture(t),p=f.prepare(),x=transport(f),before=f.snapshot();let getters=0;
 const fake=Object.defineProperty({},'hostLeaseKey',{enumerable:true,get(){getters++;throw Error('forbidden');}});
 assert.equal(typeof f.port.registerDefaultDispatchHostEffect,'function');
 for(const owner of [{},{...x.owner},null])assert.throws(()=>f.port.registerDefaultDispatchHostEffect('p',fake,owner,actor),/OWNER/);
 for(const requestSource of ['user','agent'])assert.throws(()=>f.port.registerDefaultDispatchHostEffect('p',fake,x.owner,{requestSource}),/SCHEDULER|OWNER/);
 assert.equal(f.port.registerDefaultDispatchHostEffect('p',fake,x.owner,actor).ok,false);assert.equal(getters,0);assert.equal(f.snapshot(),before);await x.client.drainDefaultDispatchPreparations();
});

test('Host registration remains strong after the actual original Net body EOF and rejects unrelated graph rebasing',async t=>{
 let release;const held=new Promise(yes=>{release=yes;}),f=await fixture(t,{unconfirmedSourceFixtureCleanup:true}),p=f.prepare(),x=transport(f,{fetchSdk:()=>Promise.resolve(new Response(new ReadableStream({start(stream){held.then(()=>{stream.enqueue(new TextEncoder().encode('{}'));stream.close();});}})))}),record=startPreparation(f,x,p),view=sendView(f,x,record);view.raw.catch(()=>{});
 try{
  const input=hostRegistrationData(f,p,view.result.preparation.admissionId);assert.equal(registerHost(f,x,input).ok,true);assert.throws(()=>f.hub.closePersistence(),/BUSY/);release();await sendCompletion(f,x,record);assert.throws(()=>f.hub.closePersistence(),/BUSY/);
  f.port.assertDefaultDispatchPreparationTransportCurrent(input.admissionId,x.owner,actor);
  const head=f.row(f.child.childKey+':status');head.hostRegistrationReceiptId='forged';f.db.prepare("UPDATE state_entities SET state_json=? WHERE collection='protocolHead' AND entity_key=?").run(JSON.stringify(head),head.id);
  assert.throws(()=>f.port.assertDefaultDispatchPreparationTransportCurrent(input.admissionId,x.owner,actor));assert.equal(registerHost(f,x,input).ok,false);
 }finally{release();await sendCompletion(f,x,record);await x.client.drainDefaultDispatchPreparations();}
});
for(const statement of ['BEGIN IMMEDIATE','COMMIT'])test('Host registration preserves the original '+statement+' Native failure without issuing effect permission',async t=>{
 let armed=false,original;const f=await fixture(t,{unconfirmedSourceFixtureCleanup:true,onAfterExec(sql,{backend}){if(armed&&sql===statement){armed=false;try{backend.close();}catch(error){original=error;}}}}),p=f.prepare(),x=transport(f),record=startPreparation(f,x,p),view=sendView(f,x,record);view.raw.catch(()=>{});await sendCompletion(f,x,record);
 try{
  armed=true;assert.throws(()=>registerHost(f,x,hostRegistrationData(f,p,view.result.preparation.admissionId)),error=>error.name==='PersistenceCommitError'&&error.cause===original&&(statement==='COMMIT'?error.durableCommitted===true:error.durableCommitted!==true));assert.ok(original);assert.equal(!!f.row(f.child.childKey+':host-registration'),statement==='COMMIT');assert.equal(x.posts.length,1);
 }finally{await x.client.drainDefaultDispatchPreparations();}
});
test('Host registration keeps committed reservation when its post-COMMIT Source withdraws',async t=>{
 let armed=false,revision,f;f=await fixture(t,{unconfirmedSourceFixtureCleanup:true,onCurrent({purpose,backend}){if(armed&&purpose==='register_host'&&backend.revision>revision){armed=false;f.withdraw();}}});const p=f.prepare(),x=transport(f),record=startPreparation(f,x,p),view=sendView(f,x,record);view.raw.catch(()=>{});await sendCompletion(f,x,record);
 try{revision=f.backend.revision;armed=true;assert.throws(()=>registerHost(f,x,hostRegistrationData(f,p,view.result.preparation.admissionId)),/SOURCE_UNVERIFIED/);assert.ok(f.row(f.child.childKey+':host-registration'));assert.equal(f.backend.revision,revision+1);assert.throws(()=>f.hub.closePersistence(),/BUSY/);assert.equal(x.posts.length,1);}finally{await x.client.drainDefaultDispatchPreparations();}
});

test('Host registration cannot advance its old cursor over a raw SQL change from the last post-COMMIT Source callback',async t=>{
 let armed=false,revision,checks=0,f;f=await fixture(t,{unconfirmedSourceFixtureCleanup:true,onCurrent({purpose,backend,db}){if(armed&&purpose==='register_host'&&backend.revision>revision&&++checks===2){armed=false;const row=f.row(f.child.childKey+':host-registration');row.hostLeaseKey='9'.repeat(64);db.prepare("UPDATE state_entities SET state_json=? WHERE collection='protocolReceipt' AND entity_key=?").run(JSON.stringify(row),row.id);}}});const p=f.prepare(),x=transport(f),record=startPreparation(f,x,p),view=sendView(f,x,record);view.raw.catch(()=>{});await sendCompletion(f,x,record);
 try{revision=f.backend.revision;armed=true;assert.throws(()=>registerHost(f,x,hostRegistrationData(f,p,view.result.preparation.admissionId)));assert.equal(checks,2);assert.equal(f.row(f.child.childKey+':host-registration').hostLeaseKey,'9'.repeat(64));assert.throws(()=>f.hub.closePersistence(),/BUSY/);}finally{await x.client.drainDefaultDispatchPreparations();}
});

test('Host registration retains an unconfirmed reservation when actual COMMIT succeeds but its original SDK wrapper throws',async t=>{
 let armed=false;const original=Error('actual host registration commit wrapper failure');const f=await fixture(t,{unconfirmedSourceFixtureCleanup:true,onAfterExec(sql){if(armed&&sql==='COMMIT'){armed=false;throw original;}}}),p=f.prepare(),x=transport(f),record=startPreparation(f,x,p),view=sendView(f,x,record);view.raw.catch(()=>{});await sendCompletion(f,x,record);
 try{armed=true;assert.throws(()=>registerHost(f,x,hostRegistrationData(f,p,view.result.preparation.admissionId)),error=>error.name==='PersistenceCommitError'&&(error.cause===original||error.cause?.cause===original));assert.ok(f.row(f.child.childKey+':host-registration'));assert.throws(()=>f.hub.closePersistence(),/BUSY/);}finally{await x.client.drainDefaultDispatchPreparations();}
});

test('Host registration blocks the original migration sibling before reading an unknown actor',async t=>{
 const f=await fixture(t,{unconfirmedSourceFixtureCleanup:true}),p=f.prepare(),x=transport(f),record=startPreparation(f,x,p),view=sendView(f,x,record);view.raw.catch(()=>{});await sendCompletion(f,x,record);let getters=0;
 try{assert.equal(registerHost(f,x,hostRegistrationData(f,p,view.result.preparation.admissionId)).ok,true);const actor=Object.defineProperty({},'requestSource',{enumerable:true,get(){getters++;throw Error('forbidden');}}),before=f.snapshot();const result=await f.hub.migrateDefaultDispatchWriter(actor);assert.equal(result.error,'DEFAULT_DISPATCH_MIGRATION_BUSY');assert.equal(getters,0);assert.equal(f.snapshot(),before);}finally{await x.client.drainDefaultDispatchPreparations();}
});

function noEffectFinishData(registration){return{scope,projectId:'p',registrationDigest:protocolDigest(registration),hostLeaseKey:registration.hostLeaseKey,sourceIncarnation:registration.sourceIncarnation,reason:'final_gate_denied'};}
function finishNoEffect(f,x,input){assert.equal(typeof f.port.finishDefaultDispatchHostNoEffect,'function');return f.port.finishDefaultDispatchHostNoEffect('p',f.frame('finish_host_no_effect',input),x.owner,actor);}
test('an original no-effect finish settles the same registered Host domain once without granting preparation',async t=>{
 const f=await fixture(t,{unconfirmedSourceFixtureCleanup:true}),p=f.prepare(),x=transport(f),record=startPreparation(f,x,p),view=sendView(f,x,record);view.raw.catch(()=>{});await sendCompletion(f,x,record);
 try{const registered=registerHost(f,x,hostRegistrationData(f,p,view.result.preparation.admissionId));assert.equal(registered.ok,true);const registration=registered.hostEffect.registration,revision=f.backend.revision;
  const done=finishNoEffect(f,x,noEffectFinishData(registration));assert.equal(done.ok,true,JSON.stringify(done));assert.equal(done.hostEffect.operation,'no_effect_finished');assert.equal(done.hostEffect.effectPermission,'not_issued');assert.equal(f.backend.revision,revision+1);
  const receipt=f.row(registration.id+':no-effect-finish');assert.equal(receipt.registrationDigest,protocolDigest(registration));assert.equal(receipt.disposition,'no_effect');assert.equal(f.row(f.child.childKey+':status').hostEffectState,'no_effect_finished');
  const settledBasis=basis(f);assert.equal(settledBasis.protocol,'ordinary_default_dispatch_preparation_basis_v2');assert.deepEqual(settledBasis.hostEffect.registration,registration);assert.deepEqual(settledBasis.hostEffect.noEffectFinish,receipt);
  const bytes=f.snapshot(),again=finishNoEffect(f,x,noEffectFinishData(registration));assert.equal(again.ok,true,JSON.stringify(again));assert.equal(again.hostEffect.operation,'history');assert.equal(f.snapshot(),bytes);assert.equal(x.posts.length,1);
 }finally{await x.client.drainDefaultDispatchPreparations();}
});
test('no-effect settlement refuses an unrelated lease key and does not release the original Host row',async t=>{
 const f=await fixture(t,{unconfirmedSourceFixtureCleanup:true}),p=f.prepare(),x=transport(f),record=startPreparation(f,x,p),view=sendView(f,x,record);view.raw.catch(()=>{});await sendCompletion(f,x,record);
 try{const registered=registerHost(f,x,hostRegistrationData(f,p,view.result.preparation.admissionId));assert.equal(registered.ok,true);const bytes=f.snapshot(),input=noEffectFinishData(registered.hostEffect.registration);
  for(const bad of [{...input,hostLeaseKey:'6'.repeat(64)},{...input,sourceIncarnation:'5'.repeat(64)},{...input,registrationDigest:'4'.repeat(64)}])assert.equal(finishNoEffect(f,x,bad).ok,false);
  assert.equal(f.snapshot(),bytes);assert.throws(()=>f.hub.closePersistence(),/BUSY/);
 }finally{await x.client.drainDefaultDispatchPreparations();}
});

for(const statement of ['BEGIN IMMEDIATE','COMMIT'])test('no-effect finish retains its Host row after the original '+statement+' SDK throws',async t=>{
 let armed=false;const original=Error('finish '+statement+' wrapper failure');
 const f=await fixture(t,{unconfirmedSourceFixtureCleanup:true,onAfterExec(sql){if(armed&&sql===statement){armed=false;throw original;}}}),p=f.prepare(),x=transport(f),record=startPreparation(f,x,p),view=sendView(f,x,record);view.raw.catch(()=>{});await sendCompletion(f,x,record);
 try{const registration=registerHost(f,x,hostRegistrationData(f,p,view.result.preparation.admissionId)).hostEffect.registration;armed=true;
  assert.throws(()=>finishNoEffect(f,x,noEffectFinishData(registration)),error=>error.name==='PersistenceCommitError'&&(error.cause===original||error.cause?.cause===original));
  assert.equal(!!f.row(registration.id+':no-effect-finish'),statement==='COMMIT');assert.throws(()=>f.hub.closePersistence(),/BUSY/);
 }finally{await x.client.drainDefaultDispatchPreparations();}
});
test('no-effect finish cannot retire a Host row after the last post-COMMIT Source changes its physical graph',async t=>{
 let armed=false,revision,checks=0,f;
 f=await fixture(t,{unconfirmedSourceFixtureCleanup:true,onCurrent({purpose,backend,db}){if(armed&&purpose==='finish_host_no_effect'&&backend.revision>revision&&++checks===2){armed=false;const row=f.row(f.child.childKey+':host-registration:no-effect-finish');row.reason='cancelled';db.prepare("UPDATE state_entities SET state_json=? WHERE collection='protocolReceipt' AND entity_key=?").run(JSON.stringify(row),row.id);}}});
 const p=f.prepare(),x=transport(f),record=startPreparation(f,x,p),view=sendView(f,x,record);view.raw.catch(()=>{});await sendCompletion(f,x,record);
 try{const registration=registerHost(f,x,hostRegistrationData(f,p,view.result.preparation.admissionId)).hostEffect.registration;revision=f.backend.revision;armed=true;
  assert.throws(()=>finishNoEffect(f,x,noEffectFinishData(registration)));assert.equal(checks,2);assert.equal(f.row(registration.id+':no-effect-finish').reason,'cancelled');assert.throws(()=>f.hub.closePersistence(),/BUSY/);
 }finally{await x.client.drainDefaultDispatchPreparations();}
});
test('no-effect finish remains available to the same owner after normal Net seal and project close',async t=>{
 const f=await fixture(t),p=f.prepare(),x=transport(f),record=startPreparation(f,x,p),view=sendView(f,x,record);view.raw.catch(()=>{});await sendCompletion(f,x,record);
 const registration=registerHost(f,x,hostRegistrationData(f,p,view.result.preparation.admissionId)).hostEffect.registration;
 assert.equal(f.closeProject().ok,true);await x.client.drainDefaultDispatchPreparations();
 const done=finishNoEffect(f,x,noEffectFinishData(registration));assert.equal(done.ok,true,JSON.stringify(done));assert.equal(done.hostEffect.operation,'no_effect_finished');
 assert.doesNotThrow(()=>f.hub.closePersistence());
});
test('an admitted JSON marker without a genuine issued Host effect cannot create a new ACK',async t=>{
 const f=await fixture(t),p=f.prepare();assert.equal(f.admit(p).ok,true);
 const fact={version:1,contract:'ordinary_default_dispatch_task_preparation_v1',scope:p.scope,projectId:p.projectId,kswarmTaskId:p.kswarmTaskId,runId:p.runId,businessExecutionGeneration:p.businessExecutionGeneration,childKey:p.childKey,payloadHash:p.payloadHash,bindingDigest:p.bindingDigest,hostId:p.hostId,inputDigest:p.inputDigest,taskId:p.taskId,sessionId:p.sessionId,preparationId:p.preparationId,preparedContentDigest:'a'.repeat(64)};
 const before=f.snapshot(),result=f.port.acknowledgeDefaultDispatchChild('p',f.frame('acknowledge',{preparationIntentDigest:p.intentDigest,fact}),actor);
 assert.equal(result.ok,false);assert.equal(result.error,'DURABLE_DISPATCH_HOST_EFFECT_PERMISSION_UNAVAILABLE');assert.equal(f.snapshot(),before);assert.equal(f.row(f.child.childKey+':prepared'),undefined);
});

test('a cold unresolved Host registration fences migration before caller getters and cannot be adopted for finish',async t=>{
 const f=await fixture(t,{unconfirmedSourceFixtureCleanup:true}),p=f.prepare(),x=transport(f),record=startPreparation(f,x,p),view=sendView(f,x,record);view.raw.catch(()=>{});await sendCompletion(f,x,record);
 const registration=registerHost(f,x,hostRegistrationData(f,p,view.result.preparation.admissionId)).hostEffect.registration;await x.client.drainDefaultDispatchPreparations();f.reopenAfterUnconfirmedFixtureExit();
 let getters=0;const caller=Object.defineProperty({},'requestSource',{enumerable:true,get(){getters++;throw Error('forbidden');}}),before=f.snapshot();
 assert.equal((await f.hub.migrateDefaultDispatchWriter(caller)).error,'DEFAULT_DISPATCH_MIGRATION_BUSY');assert.equal(getters,0);assert.equal(f.snapshot(),before);
 const next=transport(f);try{const r=finishNoEffect(f,next,noEffectFinishData(registration));assert.equal(r.ok,false);assert.equal(f.snapshot(),before);}finally{await next.client.drainDefaultDispatchPreparations();}
});

test('a late Array map cannot hide the cold durable Host fence from the original migration sibling',async t=>{
 const f=await fixture(t,{unconfirmedSourceFixtureCleanup:true}),p=f.prepare(),x=transport(f),record=startPreparation(f,x,p),view=sendView(f,x,record);view.raw.catch(()=>{});await sendCompletion(f,x,record);
 assert.equal(registerHost(f,x,hostRegistrationData(f,p,view.result.preparation.admissionId)).ok,true);await x.client.drainDefaultDispatchPreparations();f.reopenAfterUnconfirmedFixtureExit();
 const original=Array.prototype.map;let calls=0,result;
 Array.prototype.map=function(...args){if(this.length&&this[0]&&Object.hasOwn(this[0],'state_json')){calls++;return [];}return Reflect.apply(original,this,args);};
 try{result=await f.hub.migrateDefaultDispatchWriter({requestSource:'scheduler'});}finally{Array.prototype.map=original;}
 assert.equal(result.error,'DEFAULT_DISPATCH_MIGRATION_BUSY');assert.equal(calls,0);
});

test('a late String prefix hook cannot erase the cold protected Host population',async t=>{
 const f=await fixture(t,{unconfirmedSourceFixtureCleanup:true}),p=f.prepare(),x=transport(f),record=startPreparation(f,x,p),view=sendView(f,x,record);view.raw.catch(()=>{});await sendCompletion(f,x,record);
 assert.equal(registerHost(f,x,hostRegistrationData(f,p,view.result.preparation.admissionId)).ok,true);await x.client.drainDefaultDispatchPreparations();f.reopenAfterUnconfirmedFixtureExit();
 const original=String.prototype.startsWith;let result;
 String.prototype.startsWith=function(prefix,...rest){if(prefix==='ordinary_default_dispatch_')return false;return Reflect.apply(original,this,[prefix,...rest]);};
 try{result=await f.hub.migrateDefaultDispatchWriter({requestSource:'scheduler'});}finally{String.prototype.startsWith=original;}
 assert.equal(result.error,'DEFAULT_DISPATCH_MIGRATION_BUSY');
});
