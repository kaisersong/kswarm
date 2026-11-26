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
function fixture(t,{roomRead,sqliteFactory,lease}={}){
 const root=mkdtempSync(join(tmpdir(),'hub-default-migration-')),filePath=join(root,'state.sqlite'),authority=createProjectInputAuthority(scope),effects=[],published=[];let backend,hub;const hubs=[];
 const open=()=>{backend=createSqlitePersistence({filePath,...(sqliteFactory?{sqliteFactory}:{})});hub=createHub({silent:true,dataDir:{backend:'sqlite',filePath},persistence:backend,bridge:{requestTask(value){effects.push(value);return{ok:true};}},brokerClient:{async getRoomSnapshot(){if(roomRead)await roomRead();return{ok:true,room:{status:'active'},messages:[{messageId:'msg'}],members:['po','worker'].map(logicalAgentId=>({status:'active',subject:{kind:'agent',logicalAgentId}}))};},async acquireRoomMembershipLease(input){return lease?lease(input):{ok:true};},async publishRoomProjectEvent(input){published.push(structuredClone(input));return{ok:true};}}});hubs.push(hub);};open();t.after(()=>{for(const h of hubs)h.closePersistence();rmSync(root,{recursive:true,force:true});});
 const control={requestSource:'user',projectInputAuthority:authority.reader()};
 const prepare=()=>hub.prepareInitialPlanAcceptanceWriter(control);
 const port=()=>{assert.ok(hub.planningMigration,'original Hub must expose its fixed planning DTO port');return hub.planningMigration;};
 const create=(input={})=>port().createProject({id:'p',name:'P',goal:'Original goal',poAgent:'po',members:['worker'],primaryRoomId:'room',sourceMessageIds:['msg'],requestedStartPolicy:'plan_only',autoAssignPo:false,...input},{requestSource:'user',projectInputAuthority:authority.creator('main-planning-create','ordinary_initial_plan_additive_v1')});
 const plan=()=>{const p=port(),state=p.readInputs('p',authority.reader());assert.equal(state.ok,true);const claim=p.claim('p',{protocol:'ordinary_initial_plan_additive_v1',fromAgent:'po',enqueueKey:state.enqueueKey,planRunId:'run',planGeneration:1,expectedPlanInputRevision:state.planInputRevision,expectedProjectControlDigest:state.projectControlDigest,startPolicy:'plan_only'},{requestSource:'user',projectInputAuthority:authority.planner()});assert.equal(claim.ok,true);const r=claim.reservation;return p.commit('p',{reservationId:r.id,enqueueKey:r.enqueueKey,planRunId:r.planRunId,commandId:r.commitCommandId,expectedProjectRevision:r.ownerRevision,fromAgent:'po',plan:{analysis:'Original completed planning',phases:[]},tasks:[{id:'planned',title:'Original pending task'}]},{requestSource:'user',projectInputAuthority:authority.planner()});};
 const migrate=context=>{assert.equal(typeof hub.migrateDefaultDispatchWriter,'function');return hub.migrateDefaultDispatchWriter(context??control);};
 const raw=fn=>{const db=new DatabaseSync(filePath,{readOnly:true});try{return fn(db);}finally{db.close();}};
 return{root,filePath,authority,control,effects,published,prepare,port,create,plan,migrate,raw,get hub(){return hub;},get backend(){return backend;},reopen(){hub.closePersistence();open();}};
}
async function planning(t,options){const f=fixture(t,options);assert.equal(f.prepare().ok,true);await f.create();assert.equal(f.plan().ok,true);return f;}
test('original current-epoch planning and a real settled publisher migrate with old task reconciliation and zero execution',async t=>{
 const f=await planning(t);await f.hub.flushRoomEventOutbox();assert.ok(f.published.length>0);const messages=f.published.length,revision=f.backend.revision,result=await f.migrate();assert.equal(result.ok,true);assert.equal(f.backend.revision,revision+1);assert.equal(f.backend.getWriterProfile().floor.schemaVersion,4);assert.equal(f.hub.readDefaultDispatchBirths('p',f.authority.reader()).error,'DEFAULT_DISPATCH_NEEDS_RECONCILIATION');assert.equal(f.published.length,messages);assert.equal(f.effects.length,0);assert.equal(f.hub.checkProjectExecutionStart('p').error,'DEFAULT_DISPATCH_EXECUTION_UNAVAILABLE');
});
test('migration admin entry denies agent scheduler and forged control without changing native state',async t=>{
 const f=await planning(t),revision=f.backend.revision;for(const context of [{},{requestSource:'agent',projectInputAuthority:f.authority.reader()},{requestSource:'scheduler',projectInputAuthority:f.authority.reader()},{requestSource:'user',projectInputAuthority:{kind:'desktop_control',...scope}}]){const result=await f.migrate(context);assert.equal(result.ok,false);assert.equal(f.backend.revision,revision);}assert.equal(f.backend.getWriterProfile().floor.schemaVersion,2);
});
test('a reopened historical pending board cannot reconstruct current-owner planning provenance',async t=>{
 const f=await planning(t);f.reopen();const revision=f.backend.revision,result=await f.migrate();assert.equal(result.ok,false);assert.match(result.error,/RECONCILIATION_REQUIRED/);assert.equal(f.backend.revision,revision);assert.equal(f.backend.getWriterProfile().floor.schemaVersion,2);
});
test('fixed planning output is detached immutable and general raw references make migration unavailable',async t=>{
 const f=fixture(t);assert.equal(f.prepare().ok,true);const result=await f.create();assert.equal(Object.isFrozen(result),true);assert.equal(f.plan().ok,true);f.hub.getProject('p');const outcome=await f.migrate();assert.equal(outcome.ok,false);assert.match(outcome.error,/RECONCILIATION_REQUIRED/);assert.equal(f.backend.getWriterProfile().floor.schemaVersion,2);
});
test('fixed create captures nested caller data before awaiting the actual Room source',async t=>{
 let release,entered;const pending=new Promise(resolve=>{release=resolve;}),called=new Promise(resolve=>{entered=resolve;});const f=fixture(t,{roomRead:async()=>{entered();await pending;}});assert.equal(f.prepare().ok,true);const members=['worker'],creation=f.create({members});await called;members.push('outsider');release();const result=await creation;assert.equal(result.members.includes('outsider'),false);assert.equal(Object.isFrozen(result.members),true);assert.equal(f.plan().ok,true);assert.equal((await f.migrate()).ok,true);
});
test('pure execution eligibility reads cannot be mistaken for an execution effect attempt',async t=>{
 const f=await planning(t);assert.equal(f.hub.checkProjectExecutionStart('p').ok,true);assert.equal(f.hub.readProjectExecutionStart('p',f.authority.reader()).ok,true);assert.equal((await f.migrate()).ok,true);assert.equal(f.effects.length,0);
});
test('migration closes new public admission before awaiting the actual earlier Room publication tail',async t=>{
 let hold=false,release,enter;const pending=new Promise(resolve=>{release=resolve;}),entered=new Promise(resolve=>{enter=resolve;});const f=await planning(t,{roomRead:async()=>{if(hold){enter();await pending;}}});hold=true;const flushing=f.hub.flushRoomEventOutbox();try{await Promise.race([entered,flushing.then(()=>{throw Error('publisher did not reach held source');})]);const migrating=f.migrate();assert.throws(()=>f.port().readInputs('p',f.authority.reader()),/MIGRATION_ACTIVE/);release();await flushing;const result=await migrating;assert.equal(result.ok,true);assert.equal(f.backend.getWriterProfile().floor.schemaVersion,4);}finally{release();await flushing.catch(()=>{});}
});
test('the same already-committed migration only reads back its receipt on retry without poisoning the owner',async t=>{
 const f=await planning(t),first=await f.migrate(),revision=f.backend.revision;assert.equal(first.ok,true);const second=await f.migrate();assert.equal(second.ok,true);assert.deepEqual(second.transition,first.transition);assert.equal(f.backend.revision,revision);assert.equal(f.backend.getHealth().status,'ok');
});
test('preparing an epoch cannot report success after actual COMMIT when a swallowed native reentry poisoned the connection',t=>{
 let armed=false,backend,inner;const f=fixture(t,{sqliteFactory(path){const db=new DatabaseSync(path),exec=db.exec.bind(db);db.exec=sql=>{const result=exec(sql);if(armed&&sql==='COMMIT'){armed=false;try{backend.close();}catch(error){inner=error;}}return result;};return db;}});backend=f.backend;armed=true;let caught;try{f.prepare();}catch(error){caught=error;}assert.ok(caught,'poisoned committed preparation must not return ok:true/profile:null');assert.equal(caught.cause,inner);assert.equal(caught.durableCommitted,true);assert.equal(f.raw(db=>db.prepare("SELECT count(*) n FROM state_meta WHERE meta_key='writer_floor_v1'").get().n),1);assert.equal(f.backend.getHealth().status,'failed');
});
test('an attempted create membership lease with an unknown ACK is not a quiescent empty planning epoch',async t=>{
 const fault=Error('actual lease ACK unknown');let attempts=0;const f=fixture(t,{lease:async()=>{attempts++;throw fault;}});assert.equal(f.prepare().ok,true);await assert.rejects(f.create(),error=>error===fault);assert.equal(attempts,1);const revision=f.backend.revision,result=await f.migrate();assert.equal(result.ok,false);assert.match(result.error,/RECONCILIATION_REQUIRED/);assert.equal(f.backend.revision,revision);assert.equal(f.backend.getWriterProfile().floor.schemaVersion,2);
});
test('an earlier publication continuation may settle but its inherited-context public reentry remains closed',async t=>{
 let hold=false,release,enter,f,reentry;const pending=new Promise(resolve=>{release=resolve;}),entered=new Promise(resolve=>{enter=resolve;});f=await planning(t,{roomRead:async()=>{if(hold){enter();await pending;try{f.port().readInputs('p',f.authority.reader());}catch(error){reentry=error;}}}});hold=true;const flushing=f.hub.flushRoomEventOutbox();try{await entered;const migrating=f.migrate();release();await flushing;assert.equal((await migrating).ok,true);assert.match(reentry?.message??'',/MIGRATION_ACTIVE/);}finally{release();await flushing.catch(()=>{});}
});
test('separate actual controls in the same scope join one in-flight migration and cause one commit',async t=>{
 let hold=false,release,enter;const pending=new Promise(resolve=>{release=resolve;}),entered=new Promise(resolve=>{enter=resolve;});const f=await planning(t,{roomRead:async()=>{if(hold){enter();await pending;}}});hold=true;const flushing=f.hub.flushRoomEventOutbox();try{await entered;const first=f.migrate(),second=f.migrate({requestSource:'user',projectInputAuthority:f.authority.reader()});release();await flushing;const a=await first,b=await second;assert.equal(a.ok,true);assert.equal(b.ok,true);assert.deepEqual(b.transition,a.transition);assert.equal(f.raw(db=>db.prepare("SELECT count(*) n FROM state_meta WHERE meta_key='writer_transition_v1'").get().n),1);}finally{release();await flushing.catch(()=>{});}
});
test('a real callback reentry caught during native migration cannot commit the original attempt',async t=>{
 let armed=false,f,reentry;f=fixture(t,{sqliteFactory(path){const db=new DatabaseSync(path),exec=db.exec.bind(db);db.exec=sql=>{const result=exec(sql);if(armed&&sql.startsWith('CREATE TRIGGER kswarm_writer_floor_transition_')){armed=false;try{f.port().readInputs('p',f.authority.reader());}catch(error){reentry=error;}}return result;};return db;}});assert.equal(f.prepare().ok,true);await f.create();assert.equal(f.plan().ok,true);armed=true;await assert.rejects(f.migrate(),/MIGRATION_REENTRY|SOURCE_UNAVAILABLE/);assert.match(reentry?.message??'',/MIGRATION_ACTIVE/);assert.equal(f.raw(db=>db.prepare("SELECT count(*) n FROM state_meta WHERE meta_key='writer_transition_v1'").get().n),0);assert.equal(f.backend.getHealth().status,'failed');
});
test('ordinary generic late callbacks retain their real tail and cannot grant a migration frame',async t=>{
 const f=await planning(t);let release;const pending=new Promise(resolve=>{release=resolve;});const writing=f.hub.mutateProjectState('p',async()=>{await pending;f.hub.getProject('p').planningGuidance='Actual late generic write';});try{const result=await f.migrate();assert.equal(result.ok,false);assert.match(result.error,/RECONCILIATION_REQUIRED/);assert.equal(f.backend.getWriterProfile().floor.schemaVersion,2);}finally{release();await writing;}assert.equal(f.backend.getWriterProfile().floor.schemaVersion,2);
});
test('a generic native save without the original controller frame invalidates even an otherwise empty epoch',async t=>{
 const f=fixture(t);assert.equal(f.prepare().ok,true);f.backend.save({scope:{type:'full'},entities:[]});const result=await f.migrate();assert.equal(result.ok,false);assert.match(result.error,/RECONCILIATION_REQUIRED/);assert.equal(f.backend.getWriterProfile().floor.schemaVersion,2);
});
test('the final local verifier tail rejects swallowed public reentry before the real migration COMMIT',async t=>{
 let armed=false,revisionWritten=false,f,reentry,commits=0,migrationTransaction=false;f=fixture(t,{sqliteFactory(path){const db=new DatabaseSync(path),prepare=db.prepare.bind(db),exec=db.exec.bind(db);db.exec=sql=>{const result=exec(sql);if(armed&&sql==='BEGIN IMMEDIATE')migrationTransaction=true;if(armed&&sql==='COMMIT'&&migrationTransaction){commits++;migrationTransaction=false;}return result;};db.prepare=sql=>{const statement=prepare(sql);if(sql.startsWith('INSERT INTO state_meta (meta_key, meta_value)')){const run=statement.run.bind(statement);statement.run=(...args)=>{const result=run(...args);if(armed&&args[0]==='revision')revisionWritten=true;return result;};}if(sql==='SELECT collection,entity_key,project_id,state_json FROM state_entities'){const all=statement.all.bind(statement);statement.all=(...args)=>{const result=all(...args);if(armed&&revisionWritten){revisionWritten=false;try{f.port().readInputs('p',f.authority.reader());}catch(error){reentry=error;}}return result;};}return statement;};return db;}});assert.equal(f.prepare().ok,true);await f.create();assert.equal(f.plan().ok,true);armed=true;await assert.rejects(f.migrate(),/MIGRATION_REENTRY|SOURCE_UNAVAILABLE/);assert.ok(reentry);assert.equal(commits,0);assert.equal(f.raw(db=>db.prepare("SELECT count(*) n FROM state_meta WHERE meta_key='writer_transition_v1'").get().n),0);
});
test('fixed planning mutations require explicit user source even when an agent holds the real planner token',async t=>{
 const f=fixture(t);assert.equal(f.prepare().ok,true);await f.create();const token=f.authority.planner(),revision=f.backend.revision;
 for(const requestSource of ['agent','scheduler'])for(const method of ['claim','commit'])assert.throws(()=>f.port()[method]('p',{}, {requestSource,projectInputAuthority:token}),/MIGRATION_AUTHORITY_REQUIRED/);
 assert.equal(f.backend.revision,revision);assert.equal(f.plan().ok,true);
});
