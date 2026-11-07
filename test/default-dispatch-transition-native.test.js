import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {sha256Hex} from '../src/core/state-scope.js';
import {createSqlitePersistence} from '../src/core/sqlite-persistence.js';
import {bindInitialPlanWriteBackend} from '../src/core/initial-plan-write-fence.js';
import {createProjectInputAuthority} from '../src/core/project-input-authority.js';
import {createOrdinaryProtocolRecords} from '../src/core/project-protocol.js';
import {createSqliteWriterFloor as createB1Floor} from './fixtures/b1-original-writer/sqlite-writer-floor.js';
import {createSqlitePersistence as createB1Persistence} from './fixtures/b1-original-writer/sqlite-persistence.js';
const scope={profileId:'a'.repeat(64),workspaceId:'b'.repeat(64)},target='ordinary_default_dispatch_writer_v1';
function fixture(t,{sourceEnabled=true,sqliteFactory,base='ordinary_initial_plan_acceptance_writer_v1',nativeScope=scope}={}){
 const root=mkdtempSync(join(tmpdir(),'dispatch-transition-native-')),filePath=join(root,'state.sqlite'),authority=createProjectInputAuthority(scope),admissions=new WeakMap(),owned=[];let guardHook,resolveHook,sourceCalls=0;
 const source={resolve(frame){sourceCalls++;resolveHook?.();const state=admissions.get(frame);if(!state)throw Error('actual_transition_source_foreign');return{observation:state.observation,assertCurrent(audience,context){assert.equal(audience.targetProfile,target);assert.equal(audience.fromFloorDigest,sha256Hex(snapshot().floor));assert.deepEqual(audience.scope,scope);if(!state.current)throw Error('actual_transition_source_withdrawn');return guardHook?.(audience,context);}};}};
 let store=createSqlitePersistence({filePath,...(sqliteFactory?{sqliteFactory}:{})});store.load();let owner=bindInitialPlanWriteBackend(store,sourceEnabled?{defaultDispatchTransitionSource:source}:{});const control={requestSource:'user',projectInputAuthority:authority.reader()};
 if(base==='sqlite_writer_gate_v1')store.save({requiredWriterProfile:base,entities:[]});else{const profile=owner.prepare(nativeScope,base);store.save(()=>owner.freeze({requiredWriterProfile:profile,entities:[],scope:{type:'full'}},{profilePreparation:profile}));}
 t.after(()=>{for(const close of owned.reverse())close();store.close();rmSync(root,{recursive:true,force:true});});
 const capture=()=>{assert.equal(typeof owner.captureDefaultDispatchTransitionObservation,'function');return owner.captureDefaultDispatchTransitionObservation();};
 const frame=(observation=capture())=>{const value=Object.freeze({});admissions.set(value,{observation,current:true});return value;};
 const migrate=(value=frame(),context=control)=>{assert.equal(typeof owner.transitionDefaultDispatch,'function');return owner.transitionDefaultDispatch(value,context);};
 const raw=fn=>{const db=new DatabaseSync(filePath);try{return fn(db);}finally{db.close();}};
 const snapshot=()=>raw(db=>({entities:db.prepare('SELECT * FROM state_entities ORDER BY collection,entity_key').all(),history:db.prepare('SELECT rowid,* FROM state_entity_history ORDER BY rowid').all(),floor:db.prepare("SELECT meta_value FROM state_meta WHERE meta_key='writer_floor_v1'").get().meta_value,transition:db.prepare("SELECT meta_value FROM state_meta WHERE meta_key='writer_transition_v1'").get()?.meta_value,triggers:db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name GLOB 'kswarm_writer_floor_*' ORDER BY name").all()}));
 const seed=()=>{const project={id:'p',name:'Original project',goal:'Original immutable content'},records=createOrdinaryProtocolRecords(project,{requestSource:'user'},authority.reader());const values=[{collection:'project',key:'p',projectId:'p',value:project},{collection:'board',key:'p',projectId:'p',value:{projectId:'p',tasks:[{id:'p__legacy',title:'Old pending task',status:'pending',activeRunId:null,attempt:1}]}},...Object.values(records).map(value=>({collection:'protocolReceipt',key:value.id,projectId:'p',value}))];store.save(()=>owner.freeze({scope:{type:'full'},entities:values},{birthIds:values.filter(v=>v.collection==='protocolReceipt').map(v=>JSON.stringify([v.collection,v.key]))}));};
 const seedHistory=()=>{const entities=raw(db=>db.prepare('SELECT collection,entity_key,project_id,state_json FROM state_entities ORDER BY collection,entity_key').all()).map(row=>({collection:row.collection,key:row.entity_key,projectId:row.project_id,value:JSON.parse(row.state_json)}));entities.find(row=>row.collection==='project').value.name='Updated original project';store.save(()=>owner.freeze({scope:{type:'full'},entities}));};
 return{root,filePath,authority,control,frame,capture,migrate,raw,snapshot,seed,seedHistory,source,own(close){owned.push(close);},admissions,get store(){return store;},get owner(){return owner;},get sourceCalls(){return sourceCalls;},setGuard(fn){guardHook=fn;},setResolve(fn){resolveHook=fn;},reopen(){store.close();store=createSqlitePersistence({filePath,...(sqliteFactory?{sqliteFactory}:{})});const loaded=store.load();owner=bindInitialPlanWriteBackend(store,sourceEnabled?{defaultDispatchTransitionSource:source}:{});return loaded;}};
}
test('original native transition preserves every business/history/base-floor byte and original nine SQL gates',t=>{
 const f=fixture(t);f.seed();f.seedHistory();const before=f.snapshot();assert.equal(before.history.length,1);const revision=f.store.revision,receipt=f.migrate();assert.equal(receipt.kind,'writer_floor_transition');assert.equal(receipt.schemaVersion,1);assert.equal(f.store.revision,revision+1);const after=f.snapshot();assert.deepEqual(after.entities,before.entities);assert.deepEqual(after.history,before.history);assert.equal(after.floor,before.floor);for(const trigger of before.triggers)assert.deepEqual(after.triggers.find(row=>row.name===trigger.name),trigger);assert.equal(after.triggers.length,18);assert.equal(f.store.getWriterProfile().floor.profile,target);assert.deepEqual(f.store.getWriterProfile().transition,receipt);assert.equal(f.reopen().projects[0].goal,'Original immutable content');assert.deepEqual(f.store.getWriterProfile().transition,receipt);
});
test('native observation and a reader alone do not create a transition when fixed independent source is absent',t=>{
 const f=fixture(t,{sourceEnabled:false}),before=f.snapshot();assert.throws(()=>f.migrate(),/TRANSITION_SOURCE_UNAVAILABLE/);assert.deepEqual(f.snapshot(),before);
});
test('forged user contexts reject before invoking the fixed source or inspecting foreign data',t=>{
 const f=fixture(t),before=f.snapshot();assert.equal(typeof f.owner.transitionDefaultDispatch,'function');for(const context of [{},{requestSource:'agent',projectInputAuthority:f.authority.reader()},{requestSource:'scheduler',projectInputAuthority:f.authority.reader()},{requestSource:'user',projectInputAuthority:{kind:'desktop_control',...scope}}])assert.throws(()=>f.migrate({},context),/TRANSITION_AUTHORITY_REQUIRED/);assert.equal(f.sourceCalls,0);assert.deepEqual(f.snapshot(),before);
});
test('copy or foreign observations cannot be rebranded by a valid controlled user source frame',t=>{
 const f=fixture(t),g=fixture(t),observation=f.capture(),before=f.snapshot();for(const value of [{...observation},JSON.parse(JSON.stringify(observation)),g.capture()])assert.throws(()=>f.migrate(f.frame(value)),/TRANSITION_OBSERVATION_UNVERIFIED/);assert.deepEqual(f.snapshot(),before);
});
test('a source withdrawn after real observation never commits, and asynchronous guards cannot grant admission',t=>{
 const f=fixture(t),value=f.frame(),before=f.snapshot();f.admissions.get(value).current=false;assert.throws(()=>f.migrate(value),/actual_transition_source_withdrawn/);assert.deepEqual(f.snapshot(),before);f.admissions.get(value).current=true;f.setGuard(()=>Promise.reject(Error('async source cannot grant')));assert.throws(()=>f.migrate(value),/TRANSITION_GUARD_ASYNC/);assert.deepEqual(f.snapshot(),before);
});
test('a real original commit after capture invalidates the earlier transition observation without rewriting anything',t=>{
 const f=fixture(t),value=f.frame();f.seed();const before=f.snapshot(),revision=f.store.revision;assert.throws(()=>f.migrate(value),/TRANSITION_OBSERVATION_UNVERIFIED|TRANSITION_SNAPSHOT_CONFLICT/);assert.equal(f.store.revision,revision);assert.deepEqual(f.snapshot(),before);
});
test('the actual B1 module cannot open a migrated store before schema or recovery writes',t=>{
 const f=fixture(t);f.seed();f.migrate();f.store.close();const execs=[];const old=createB1Persistence({filePath:f.filePath,sqliteFactory(path){const db=new DatabaseSync(path),exec=db.exec.bind(db);db.exec=sql=>{execs.push(sql);return exec(sql);};return db;}});f.own(()=>old.close());assert.throws(()=>old.load(),/writer.*floor|floor.*integrity|writer.*profile/);assert.deepEqual(execs,[]);
});
for(const seam of ['resolver','guard'])test('a caught reentry from '+seam+' cannot commit an inner transition or wash a failed outer admission',t=>{
 const f=fixture(t),value=f.frame(),before=f.snapshot();let entered=false,inner;
 const hook=()=>{if(entered)return;entered=true;try{f.migrate(value);}catch(error){inner=error;}};if(seam==='resolver')f.setResolve(hook);else f.setGuard(hook);
 assert.throws(()=>f.migrate(value),/reentrant|failed/);assert.ok(inner);assert.deepEqual(f.snapshot(),before);assert.equal(f.raw(db=>db.prepare("SELECT count(*) n FROM state_meta WHERE meta_key='writer_transition_v1'").get().n),0);
});
test('observation cannot mint after actual read COMMIT when a swallowed close reentry poisoned the owner',t=>{
 let armed=false,store,inner;const f=fixture(t,{sqliteFactory(path){const db=new DatabaseSync(path),exec=db.exec.bind(db);db.exec=sql=>{const result=exec(sql);if(armed&&sql==='COMMIT'){armed=false;try{store.close();}catch(error){inner=error;}}return result;};return db;}});store=f.store;armed=true;assert.throws(()=>f.capture(),/reentrant|failed/);assert.ok(inner);assert.equal(f.store.getHealth().status,'failed');
});
for(const table of ['state_entities','state_entity_history'])test('foreign scope reserved protocol in '+table+' cannot be blessed by a transition',t=>{
 const f=fixture(t);f.seed();const value={id:'foreign-reserved',kind:'initial_plan_acceptance_head',schemaVersion:1,contract:'ordinary_initial_plan_additive_v1',projectId:'p',scope:{...scope,workspaceId:'c'.repeat(64)},revision:1},json=JSON.stringify(value),floor=f.store.getWriterProfile().floor;
 f.raw(db=>{db.function('kswarm_initial_plan_acceptance_writer_v1',()=>floor.writerProfileDigest);db.prepare('INSERT INTO '+table+'(collection,entity_key,project_id,state_json,checksum,revision,updated_at) VALUES(?,?,?,?,?,?,?)').run('protocolHead',value.id,'p',json,sha256Hex(json),f.store.revision,'actual fault');});const before=f.snapshot();assert.throws(()=>f.migrate(),/TRANSITION_SNAPSHOT_UNVERIFIED/);assert.deepEqual(f.snapshot(),before);
});
test('a rejected asynchronous guard retains its actual late tail and closes the original backend before it can write',async t=>{
 const f=fixture(t),value=f.frame(),revision=f.store.revision;let release,tail;const held=new Promise(resolve=>{release=resolve;});f.setGuard(()=>{tail=(async()=>{await held;f.store.save({entities:[]});})();return tail;});assert.throws(()=>f.migrate(value),/TRANSITION_GUARD_ASYNC/);release();await assert.rejects(tail,/failed/);assert.equal(f.store.revision,revision);assert.equal(f.store.getHealth().status,'failed');
});
for(const [collection,keyField] of [['workflowRun','id'],['workflowProposal','id'],['humanAction','id'],['finalDeliverable','deliverableId'],['reviewGateDecision','gateId'],['reviewCondition','conditionId'],['project','id']])test('raw historical '+collection+' identity must match its stored key and physical project',t=>{
 const f=fixture(t);f.seed();const value={[keyField]:'wrong-identity',projectId:'p'},json=JSON.stringify(value),floor=f.store.getWriterProfile().floor;f.raw(db=>{db.function('kswarm_initial_plan_acceptance_writer_v1',()=>floor.writerProfileDigest);db.prepare('INSERT INTO state_entity_history(collection,entity_key,project_id,state_json,checksum,revision,updated_at) VALUES(?,?,?,?,?,?,?)').run(collection,'original-key','p',json,sha256Hex(json),f.store.revision,'actual history fault');});assert.throws(()=>f.capture(),/TRANSITION_SNAPSHOT_UNVERIFIED/);
});
test('actual B1 held connection and precompiled statements lack the new function for all nine writes',t=>{
 const f=fixture(t);f.seed();const oldDb=new DatabaseSync(f.filePath);f.own(()=>oldDb.close());createB1Floor(oldDb);
 const statements=["INSERT INTO state_entities VALUES('project','old-probe','old-probe','{}','x',1,'x')","UPDATE state_entities SET updated_at='old-probe'","DELETE FROM state_entities","INSERT INTO state_entity_history VALUES('project','old-probe','old-probe','{}','x',1,'x')","UPDATE state_entity_history SET updated_at='old-probe'","DELETE FROM state_entity_history","INSERT INTO state_meta VALUES('old-probe','x')","UPDATE state_meta SET meta_value='0' WHERE meta_key='revision'","DELETE FROM state_meta WHERE meta_key='revision'"].map(sql=>oldDb.prepare(sql));
 f.migrate();const migrated=f.snapshot();for(const statement of statements)assert.throws(()=>statement.run(),/kswarm_default_dispatch_transition_writer_v1|writer_transition/);assert.deepEqual(f.snapshot(),migrated);
});
for(const phase of ['begin','gate','precommit','postcommit'])test('original native '+phase+' failure preserves actual committed truth and retains the original error',t=>{
 let armed=false,rollbacks=0;const fault=Error('native transition '+phase+' fault'),f=fixture(t,{sqliteFactory(path){const db=new DatabaseSync(path),exec=db.exec.bind(db);db.exec=sql=>{if(sql==='ROLLBACK')rollbacks++;if(armed&&((phase==='begin'&&sql==='BEGIN IMMEDIATE')||(phase==='gate'&&sql.startsWith('CREATE TRIGGER kswarm_writer_floor_transition_state_entity_history_update'))||(phase==='precommit'&&sql==='COMMIT'))){armed=false;throw fault;}const result=exec(sql);if(armed&&phase==='postcommit'&&sql==='COMMIT'){armed=false;throw fault;}return result;};return db;}});f.seed();f.seedHistory();const value=f.frame(),before=f.snapshot();armed=true;let caught;try{f.migrate(value);}catch(error){caught=error;}assert.ok(caught);assert.equal(caught.cause===fault||caught.cause?.cause===fault,true);assert.equal(f.store.getHealth().status,'failed');const after=f.snapshot();assert.equal(after.floor,before.floor);assert.deepEqual(after.entities,before.entities);assert.deepEqual(after.history,before.history);
 if(phase==='postcommit'){assert.equal(after.triggers.length,18);f.reopen();assert.equal(f.store.getWriterProfile().floor.profile,target);assert.equal(f.store.getWriterProfile().transition.kind,'writer_floor_transition');}else{assert.deepEqual(after.triggers,before.triggers);assert.equal(f.raw(db=>db.prepare("SELECT count(*) n FROM state_meta WHERE meta_key='writer_transition_v1'").get().n),0);if(phase==='begin')assert.equal(rollbacks,0);}
});
test('a real committed transition followed by source withdrawal is marked durable and is never undone',t=>{
 let armed=false,withdraw;const f=fixture(t,{sqliteFactory(path){const db=new DatabaseSync(path),exec=db.exec.bind(db);db.exec=sql=>{const result=exec(sql);if(armed&&sql==='COMMIT'){armed=false;withdraw();}return result;};return db;}}),value=f.frame();withdraw=()=>{f.admissions.get(value).current=false;};armed=true;let caught;try{f.migrate(value);}catch(error){caught=error;}assert.equal(caught?.durableCommitted,true);assert.match(caught.message,/actual_transition_source_withdrawn/);assert.equal(f.snapshot().triggers.length,18);f.reopen();assert.equal(f.store.getWriterProfile().floor.profile,target);
});
test('actual empty floor1 can migrate using the fixed authenticated scope without changing its original singleton',t=>{
 const f=fixture(t,{base:'sqlite_writer_gate_v1'}),before=f.snapshot();const result=f.migrate();assert.deepEqual(result.toFloor.scope,scope);assert.equal(f.snapshot().floor,before.floor);assert.equal(f.snapshot().triggers.length,18);
});
test('valid original scope field order does not change the transition identity or authority',t=>{
 const f=fixture(t,{nativeScope:{workspaceId:scope.workspaceId,profileId:scope.profileId}});f.seed();const result=f.migrate();assert.deepEqual(result.toFloor.scope,scope);
});
for(const corruption of ['missing_gate','changed_gate','missing_ledger','future_version','wrong_scope','wrong_store','bad_revision','duplicate_json'])test('migrated native read refuses '+corruption+' without repairing original bytes',t=>{
 const f=fixture(t);f.migrate();f.store.close();f.raw(db=>{
  const gates=db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name GLOB 'kswarm_writer_floor_transition_*' ORDER BY name").all();
  if(corruption==='missing_gate'||corruption==='changed_gate'){const gate=gates[0];db.exec('DROP TRIGGER '+gate.name);if(corruption==='changed_gate')db.exec('CREATE TRIGGER '+gate.name+' BEFORE INSERT ON state_entities BEGIN SELECT 1; END');return;}
  const metadata=gates.filter(row=>row.name.includes('_state_meta_'));for(const row of metadata)db.exec('DROP TRIGGER '+row.name);db.function('kswarm_initial_plan_acceptance_writer_v1',()=>f.raw(inner=>JSON.parse(inner.prepare("SELECT meta_value FROM state_meta WHERE meta_key='writer_floor_v1'").get().meta_value).writerProfileDigest));
  if(corruption==='missing_ledger')db.exec("DELETE FROM state_meta WHERE meta_key='writer_transition_v1'");else{const value=JSON.parse(db.prepare("SELECT meta_value FROM state_meta WHERE meta_key='writer_transition_v1'").get().meta_value);if(corruption==='future_version')value.schemaVersion=2;if(corruption==='wrong_scope')value.toFloor.scope.workspaceId='c'.repeat(64);if(corruption==='wrong_store')value.toFloor.storeId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';if(corruption==='bad_revision')value.committedRevision++;const encoded=corruption==='duplicate_json'?'{"schemaVersion":2,'+JSON.stringify(value).slice(1):JSON.stringify(value);db.prepare("UPDATE state_meta SET meta_value=? WHERE meta_key='writer_transition_v1'").run(encoded);}
  for(const row of metadata)db.exec(row.sql);
 });const damaged=f.snapshot();assert.throws(()=>f.reopen(),/writer.*transition|writer.*floor|floor.*integrity/);assert.deepEqual(f.snapshot(),damaged);
});
test('rollback reporting failure preserves both the original SQL error and the actual raw database state',t=>{
 let armed=false;const fault=Error('actual native transition SQL fault'),rollback=Error('actual rollback report unknown'),f=fixture(t,{sqliteFactory(path){const db=new DatabaseSync(path),exec=db.exec.bind(db);db.exec=sql=>{if(armed&&sql.startsWith('CREATE TRIGGER kswarm_writer_floor_transition_state_entity_history_update'))throw fault;const result=exec(sql);if(armed&&sql==='ROLLBACK'){armed=false;throw rollback;}return result;};return db;}}),value=f.frame(),before=f.snapshot();armed=true;let caught;try{f.migrate(value);}catch(error){caught=error;}assert.equal(caught.cause.cause,fault);assert.ok(caught.cause.errors.includes(rollback));assert.equal(f.store.getHealth().status,'failed');assert.deepEqual(f.snapshot(),before);
});
for(const version of ['profile2-original-writer','profile3-original-writer'])test('actual '+version+' rejects the migrated store before any recovery write',async t=>{
 const {createSqlitePersistence:oldFactory}=await import('./fixtures/'+version+'/sqlite-persistence.js'),f=fixture(t);f.migrate();f.store.close();const execs=[],old=oldFactory({filePath:f.filePath,sqliteFactory(path){const db=new DatabaseSync(path),exec=db.exec.bind(db);db.exec=sql=>{execs.push(sql);return exec(sql);};return db;}});f.own(()=>old.close());assert.throws(()=>old.load(),/writer.*floor|floor.*integrity|writer.*profile/);assert.deepEqual(execs,[]);
});
test('constructor-fixed transition source cannot be replaced after owner binding',t=>{
 const f=fixture(t);f.source.resolve=()=>{throw Error('replacement source must not run');};assert.equal(f.migrate().kind,'writer_floor_transition');
});
test('user context mutated by the fixed verifier cannot obtain a transition',t=>{
 const f=fixture(t),value=f.frame(),before=f.snapshot();f.setGuard((audience,context)=>{context.requestSource='agent';});assert.throws(()=>f.migrate(value),/TRANSITION_AUTHORITY_REQUIRED/);assert.deepEqual(f.snapshot(),before);
});
test('foreign actual control scope rejects before the source guard and writes nothing',t=>{
 const f=fixture(t),value=f.frame(),before=f.snapshot();f.setGuard(()=>{throw Error('guard must not run');});const authority=createProjectInputAuthority({...scope,workspaceId:'c'.repeat(64)});assert.throws(()=>f.migrate(value,{requestSource:'user',projectInputAuthority:authority.reader()}),/TRANSITION_AUTHORITY_REQUIRED/);assert.deepEqual(f.snapshot(),before);
});
