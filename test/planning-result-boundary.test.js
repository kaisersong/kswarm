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
function fixture(t,options={}){
 const root=mkdtempSync(join(tmpdir(),'planning-result-boundary-')),filePath=join(root,'state.sqlite'),persistence=createSqlitePersistence({filePath,...options}),authority=createProjectInputAuthority(scope);
 const hub=createHub({silent:true,dataDir:{backend:'sqlite',filePath},persistence,brokerClient:{async getRoomSnapshot(){return{ok:true,room:{status:'active'},messages:[{messageId:'msg'}],members:['po','worker'].map(logicalAgentId=>({status:'active',subject:{kind:'agent',logicalAgentId}}))};},async acquireRoomMembershipLease(){return{ok:true};}}});
 t.after(()=>{delete Object.prototype.toJSON;hub.closePersistence();rmSync(root,{recursive:true,force:true,maxRetries:5});});
 assert.equal(hub.prepareInitialPlanAcceptanceWriter({requestSource:'user',projectInputAuthority:authority.reader()}).ok,true);
 const port=hub.planningMigration,actor=()=>({requestSource:'user',projectInputAuthority:authority.planner()});
 const create=(extra={})=>port.createProject({id:'p',name:'P',goal:'Original goal',poAgent:'po',members:['worker'],primaryRoomId:'room',sourceMessageIds:['msg'],requestedStartPolicy:'plan_only',autoAssignPo:false,...extra},{requestSource:'user',projectInputAuthority:authority.creator('create-op:'+(extra.id??'p'),'ordinary_initial_plan_additive_v1')});
 const claim=()=>{const state=port.readInputs('p',authority.reader());return port.claim('p',{protocol:'ordinary_initial_plan_additive_v1',fromAgent:'po',enqueueKey:state.enqueueKey,planRunId:'run',planGeneration:1,expectedPlanInputRevision:state.planInputRevision,expectedProjectControlDigest:state.projectControlDigest,startPolicy:'plan_only'},actor());};
 const commit=r=>port.commit('p',{reservationId:r.id,enqueueKey:r.enqueueKey,planRunId:r.planRunId,commandId:r.commitCommandId,expectedProjectRevision:r.ownerRevision,fromAgent:'po',plan:{analysis:'Original plan',phases:[]},tasks:[{id:'one',title:'Original task'}]},actor());
 const physical=()=>{const db=new DatabaseSync(filePath,{readOnly:true});try{return db.prepare('SELECT collection,entity_key,state_json FROM state_entities ORDER BY collection,entity_key').all().map(row=>({...row,value:JSON.parse(row.state_json)}));}finally{db.close();}};
 return{hub,persistence,authority,port,create,claim,commit,physical};
}
for(const operation of ['create','claim','commit'])test('fixed '+operation+' returns its original prevalidated receipt when the actual committed notice changes serializer hooks',async t=>{
 const f=fixture(t);let reservation;if(operation!=='create')await f.create();if(operation==='commit'){const claim=f.claim();assert.equal(claim.ok,true);reservation=claim.reservation;}
 const before=f.persistence.revision;let notified=0,caught,result;const stop=f.hub.serverObservation.subscribe(()=>{notified++;Object.defineProperty(Object.prototype,'toJSON',{configurable:true,value(){return{};}});});
 try{result=operation==='create'?await f.create():operation==='claim'?f.claim():f.commit(reservation);}catch(error){caught=error;}finally{delete Object.prototype.toJSON;stop();}
 assert.ok(notified>0,'the actual post-COMMIT activity notification must execute');assert.ifError(caught);assert.equal(f.persistence.revision,before+1);assert.equal(Object.isFrozen(result),true);
 const rows=f.physical();if(operation==='create'){assert.equal(result.id,'p');assert.equal(rows.filter(row=>row.collection==='project').length,1);assert.deepEqual(JSON.parse(JSON.stringify(result)),rows.find(row=>row.collection==='project').value,'the fixed create DTO must include the original committed activity projection');}else if(operation==='claim'){assert.equal(result.ok,true);assert.equal(rows.filter(row=>row.value.kind==='initial_plan_reservation').length,1);assert.equal(Object.isFrozen(result.reservation),true);}else{assert.equal(result.ok,true);assert.equal(rows.filter(row=>row.value.kind==='initial_plan_commit_receipt').length,1);assert.equal(rows.find(row=>row.collection==='board').value.tasks.length,1);assert.equal(Object.isFrozen(result.receipt),true);}
});

test('fixed create rejects an oversized returned project before the actual native COMMIT and restores its original VM',async t=>{
 const f=fixture(t),before=f.persistence.revision;await assert.rejects(f.create({goal:'x'.repeat(8387500)}),/CONTENT_UNAVAILABLE/);assert.equal(f.persistence.revision,before);assert.equal(f.physical().filter(row=>row.collection==='project').length,0);assert.equal(f.hub.serverObservation.project('p'),null);assert.notEqual(f.hub.getPersistenceHealth().status,'failed');assert.equal((await f.create()).id,'p');assert.equal(f.persistence.revision,before+1);
});

test('original public create still returns its original mutable object outside the fixed planning port',async t=>{
 const f=fixture(t),result=await f.hub.createProject({id:'legacy-api',name:'Legacy API',goal:'G',poAgent:'po',members:['worker'],primaryRoomId:'room',sourceMessageIds:['msg'],requestedStartPolicy:'plan_only',autoAssignPo:false},{requestSource:'user',projectInputAuthority:f.authority.creator('legacy-api-create','ordinary_initial_plan_additive_v1')});assert.equal(Object.isFrozen(result),false);assert.equal(f.physical().filter(row=>row.collection==='project').length,1);
});

for(const committed of [false,true])for(const operation of ['create','claim','commit'])test('fixed '+operation+' preserves the actual native failure and durable truth (COMMIT='+committed+')',async t=>{
 let armed=false,backend,inner;const fault=Error('original planning COMMIT failed');const f=fixture(t,{sqliteFactory(path){const db=new DatabaseSync(path),exec=db.exec.bind(db);db.exec=sql=>{if(armed&&sql==='COMMIT'&&!committed){armed=false;throw fault;}const result=exec(sql);if(armed&&sql==='COMMIT'&&committed){armed=false;try{backend.close();}catch(error){inner=error;}}return result;};return db;}});backend=f.persistence;let reservation;if(operation!=='create')await f.create();if(operation==='commit')reservation=f.claim().reservation;armed=true;let caught;try{if(operation==='create')await f.create();else if(operation==='claim')f.claim();else f.commit(reservation);}catch(error){caught=error;}assert.ok(caught);assert.equal(caught.cause,committed?inner:fault);assert.equal(caught.durableCommitted===true,committed);
 const rows=f.physical();if(operation==='create')assert.equal(rows.filter(row=>row.collection==='project').length,committed?1:0);else if(operation==='claim')assert.equal(rows.filter(row=>row.value.kind==='initial_plan_reservation').length,committed?1:0);else assert.equal(rows.filter(row=>row.value.kind==='initial_plan_commit_receipt').length,committed?1:0);
});

test('a rejected create leaves no original birth markers for a different next create or subsequent full save',async t=>{
 const f=fixture(t);await assert.rejects(f.create({goal:'x'.repeat(8387500)}),/CONTENT_UNAVAILABLE/);assert.equal((await f.create({id:'q'})).id,'q');f.hub.persistState();assert.notEqual(f.hub.getPersistenceHealth().status,'failed');assert.deepEqual(f.physical().filter(row=>row.collection==='project').map(row=>row.entity_key),['q']);
});
test('original public claim and commit keep their mutable ABI while fixed no-transaction replays remain frozen',async t=>{
 const f=fixture(t);await f.create();const state=f.port.readInputs('p',f.authority.reader()),input={protocol:'ordinary_initial_plan_additive_v1',fromAgent:'po',enqueueKey:state.enqueueKey,planRunId:'run',planGeneration:1,expectedPlanInputRevision:state.planInputRevision,expectedProjectControlDigest:state.projectControlDigest,startPolicy:'plan_only'};const claim=f.hub.claimInitialPlanInputs('p',input,f.authority.planner());assert.equal(claim.ok,true);assert.equal(Object.isFrozen(claim),false);const replay=f.port.claim('p',input,{requestSource:'user',projectInputAuthority:f.authority.planner()});assert.equal(replay.reused,true);assert.equal(Object.isFrozen(replay.reservation),true);
 const r=claim.reservation,command={reservationId:r.id,enqueueKey:r.enqueueKey,planRunId:r.planRunId,commandId:r.commitCommandId,expectedProjectRevision:r.ownerRevision,fromAgent:'po',plan:{analysis:'Original plan',phases:[]},tasks:[{id:'one',title:'Original task'}]},committed=f.hub.commitInitialPlan('p',command,f.authority.planner());assert.equal(committed.ok,true);assert.equal(Object.isFrozen(committed),false);const before=f.persistence.revision,result=f.port.commit('p',command,{requestSource:'user',projectInputAuthority:f.authority.planner()});assert.equal(result.reused,true);assert.equal(Object.isFrozen(result.receipt),true);assert.deepEqual(result.receipt,committed.receipt);assert.equal(f.persistence.revision,before);
});
test('the original auto-ID create keeps its private response preparation through original ID normalization',async t=>{
 const f=fixture(t);let notified=0,caught,result;const stop=f.hub.serverObservation.subscribe(()=>{notified++;Object.defineProperty(Object.prototype,'toJSON',{configurable:true,value(){return{};}});});
 try{result=await f.create({id:undefined});}catch(error){caught=error;}finally{delete Object.prototype.toJSON;stop();}
 assert.ok(notified>0);assert.ifError(caught);assert.equal(typeof result.id,'string');assert.ok(result.id);assert.equal(Object.isFrozen(result),true);assert.deepEqual(JSON.parse(JSON.stringify(result)),f.physical().find(row=>row.collection==='project').value);
});
for(const id of ['q',undefined])test('original canonical create reuse observes the existing project without a second native write (requested id='+id+')',async t=>{
 const f=fixture(t),first=await f.create({clientRequestKey:'canonical-create'}),before=f.persistence.revision,rows=f.physical(),result=await f.create({id,clientRequestKey:'canonical-create'});
 assert.equal(result.id,first.id);assert.equal(Object.isFrozen(result),true);assert.deepEqual(result,first);assert.equal(f.persistence.revision,before);assert.deepEqual(f.physical(),rows);assert.notEqual(f.hub.getPersistenceHealth().status,'failed');
});
for(const [prototype,method]of [[WeakSet.prototype,'has'],[WeakMap.prototype,'get'],[WeakMap.prototype,'has']])test('fixed create has no post-COMMIT dynamic '+prototype.constructor.name+'.'+method+' lookup for its response',async t=>{
 const f=fixture(t),descriptor=Object.getOwnPropertyDescriptor(prototype,method),fault=Error('postcommit data lookup replaced');let notified=0,caught,result;const stop=f.hub.serverObservation.subscribe(()=>{notified++;Object.defineProperty(prototype,method,{...descriptor,value(){throw fault;}});});
 try{result=await f.create();}catch(error){caught=error;}finally{Object.defineProperty(prototype,method,descriptor);stop();}
 assert.ok(notified>0);assert.ifError(caught);assert.equal(result.id,'p');assert.equal(Object.isFrozen(result),true);assert.deepEqual(JSON.parse(JSON.stringify(result)),f.physical().find(row=>row.collection==='project').value);
});
