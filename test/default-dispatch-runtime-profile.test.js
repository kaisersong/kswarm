import {test} from 'node:test';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {createHub} from '../src/core/hub.js';
import {createSqlitePersistence} from '../src/core/sqlite-persistence.js';
import {acceptanceRecordMatchesFloor,isAcceptanceRecord} from '../src/core/initial-plan-acceptance-contract.js';
import {createProjectInputAuthority} from '../src/core/project-input-authority.js';
const scope={profileId:'a'.repeat(64),workspaceId:'b'.repeat(64)};
function fixture(t,{onExec,onAfterExec}={}){
 const root=mkdtempSync(join(tmpdir(),'runtime-dispatch-profile-')),filePath=join(root,'b.sqlite'),authority=createProjectInputAuthority(scope),control={requestSource:'user',projectInputAuthority:authority.reader()},hubs=[],effects=[],sql=[];let hub,backend,db,frames;
 const open=()=>{
  frames=new WeakMap();const fixed=frames;
  backend=createSqlitePersistence({filePath,sqliteFactory(path){db=new DatabaseSync(path);const exec=db.exec.bind(db);db.exec=statement=>{sql.push(statement);const state={db,backend,hub,filePath};onExec?.(statement,state);const value=exec(statement);onAfterExec?.(statement,state);return value;};return db;}});
  hub=createHub({silent:true,persistence:backend,dataDir:{backend:'sqlite',filePath},projectStorageRoot:join(root,'projects'),bridge:{requestTask(input){effects.push(input);return{ok:true};}},defaultDispatchActionSource:{resolve(frame){const data=fixed.get(frame);if(!data)throw Error('original_runtime_fixture_action_required');return{data,assertCurrent(){}};}},brokerClient:{async getRoomSnapshot(){return{ok:true,room:{status:'active'},messages:[{messageId:'msg'}],members:['po','worker'].map(logicalAgentId=>({status:'active',subject:{kind:'agent',logicalAgentId}}))};},async acquireRoomMembershipLease(){return{ok:true};}}});hubs.push(hub);
 };open();t.after(()=>{for(const h of hubs)h.closePersistence();rmSync(root,{recursive:true,force:true});});
 return{root,filePath,scope,authority,control,sql,effects,get hub(){return hub;},get backend(){return backend;},get db(){return db;},prepare(ctx=control){assert.equal(typeof hub.prepareDurableDispatchRuntimeWriter,'function');return hub.prepareDurableDispatchRuntimeWriter(ctx);},async create(){return hub.createProject({id:'p',name:'P',goal:'Original goal',poAgent:'po',members:['worker'],primaryRoomId:'room',sourceMessageIds:['msg'],requestedStartPolicy:'plan_only',autoAssignPo:false},control);},async capture(){const {defaultDispatchActionRecord}=await import('../src/core/default-dispatch-action-data.js'),r=hub.readDefaultDispatchPlan('p',authority.reader());assert.equal(r.ok,true,JSON.stringify(r));const plan=r.plan,data=defaultDispatchActionRecord({scope,projectId:'p',planRevision:plan.revision,dispatchGeneration:plan.dispatchGeneration,bindingDigest:plan.bindingDigest,taskSetDigest:plan.taskSetDigest}),frame=Object.freeze(Object.create(null));frames.set(frame,data);return hub.captureDefaultDispatchOperation('p',frame,{requestSource:'user',actorId:'desktop-user:'+scope.profileId});},snapshot(){return JSON.stringify(db.prepare('SELECT meta_key,meta_value FROM state_meta ORDER BY meta_key').all());},reopen(){hub.closePersistence();open();}};
}
test('unpublished runtime6 supports the original durable graph and stays execution-closed across reopen',async t=>{
 const f=fixture(t),prepared=f.prepare();assert.equal(prepared.ok,true,JSON.stringify(prepared));assert.equal(prepared.profile.schemaVersion,6);assert.equal(prepared.profile.profile,'ordinary_durable_dispatch_runtime_writer_v1');
 const before=f.snapshot(),revision=f.backend.revision;assert.equal(f.prepare().ok,true);assert.equal(f.snapshot(),before);assert.equal(f.backend.revision,revision);
 assert.equal((await f.create()).id,'p');assert.equal(f.hub.handleHumanAddTasks('p',[{id:'a',title:'A',brief:'Original task',assignedAgent:'worker'}],{requestSource:'user'}).ok,true);
 const first=await f.capture();assert.equal(first.ok,true,JSON.stringify(first));assert.equal(first.operation.children[0].state,'intent_pending');const head=f.hub.readDefaultDispatchPlan('p',f.authority.reader()).plan;
 assert.deepEqual(await f.capture(),first);assert.equal(f.hub.checkProjectExecutionStart('p').error,'DEFAULT_DISPATCH_EXECUTION_UNAVAILABLE');assert.equal(f.hub.handleRequestDispatch('p','po').error,'DEFAULT_DISPATCH_EXECUTION_UNAVAILABLE');assert.deepEqual(f.effects,[]);
 f.reopen();assert.deepEqual(f.hub.readDefaultDispatchOperation('p',{planRevision:head.revision,dispatchGeneration:head.dispatchGeneration},f.authority.reader()),first);assert.deepEqual(await f.capture(),first);assert.deepEqual(f.effects,[]);
});
for(const version of [4,5])test('existing storage'+version+' is not implicitly upgraded to runtime6',async t=>{
 const f=fixture(t);const prepared=version===4?f.hub.prepareDefaultDispatchWriter(f.control):f.hub.prepareDurableDispatchWriter(f.control);assert.equal(prepared.ok,true);const before=f.snapshot(),revision=f.backend.revision;assert.equal(f.prepare().ok,false);assert.equal(f.snapshot(),before);assert.equal(f.backend.revision,revision);assert.equal(f.backend.getWriterProfile().floor.schemaVersion,version);
});
for(const requestSource of ['agent','scheduler'])test(requestSource+' and copied readers cannot install runtime6',t=>{
 const f=fixture(t),before=f.snapshot();assert.equal(f.prepare({...f.control,requestSource}).ok,false);assert.equal(f.prepare({requestSource:'user',projectInputAuthority:{...f.control.projectInputAuthority}}).ok,false);assert.equal(f.snapshot(),before);assert.equal(f.backend.getWriterProfile().floor,null);
});
for(const kind of ['board','humanAction','project'])test('full heap '+kind+' refuses fresh6 after physical deletion',t=>{
 const f=fixture(t),value=kind==='board'?{projectId:'old',tasks:[]}:kind==='humanAction'?{id:'audit',action:'old',projectId:null}:{id:'old',name:'Old',members:[]},row={collection:kind,key:kind==='humanAction'?'audit':'old',projectId:kind==='humanAction'?null:'old',value};
 f.backend.save({scope:{type:'full'},entities:kind==='humanAction'?[]:[row],humanActions:kind==='humanAction'?[row]:[]});f.reopen();f.db.exec('DELETE FROM state_entities');f.db.exec('DELETE FROM state_entity_history');const before=f.snapshot(),count=f.sql.length;assert.deepEqual(f.prepare(),{ok:false,error:'INITIAL_PLAN_FRESH_STORE_REQUIRED'});assert.equal(f.snapshot(),before);assert.equal(f.sql.length,count);
});
test('fresh6 rejects physical history without installing a floor',t=>{
 const f=fixture(t);f.db.prepare('INSERT INTO state_entity_history(collection,entity_key,project_id,state_json,checksum,revision,updated_at) VALUES(?,?,?,?,?,?,?)').run('project','old','old','{}','old',1,'old');const before=f.snapshot();assert.deepEqual(f.prepare(),{ok:false,error:'INITIAL_PLAN_FRESH_STORE_REQUIRED'});assert.equal(f.snapshot(),before);
});
test('fresh6 rechecks a real second-connection history write before original BEGIN',t=>{
 let armed=false;const f=fixture(t,{onExec(statement,{filePath}){if(armed&&statement==='BEGIN IMMEDIATE'){armed=false;const other=new DatabaseSync(filePath);try{other.prepare('INSERT INTO state_entity_history(collection,entity_key,project_id,state_json,checksum,revision,updated_at) VALUES(?,?,?,?,?,?,?)').run('project','raced','raced','{}','raced',1,'old');}finally{other.close();}}}});
 armed=true;assert.throws(()=>f.prepare(),error=>error.name==='PersistenceCommitError'&&error.cause?.message==='INITIAL_PLAN_FRESH_STORE_REQUIRED');assert.equal(f.db.prepare("SELECT count(*) n FROM state_meta WHERE meta_key='writer_floor_v1'").get().n,0);assert.equal(f.db.prepare("SELECT count(*) n FROM state_entity_history WHERE entity_key='raced'").get().n,1);
});
test('runtime6 default-denies undeclared runtime record kinds and zero model effects',async t=>{
 const f=fixture(t);assert.equal(f.prepare().ok,true);assert.equal((await f.create()).id,'p');const revision=f.backend.revision;
 const fake={id:'fake',projectId:'p',contract:'ordinary_default_dispatch_runtime_v1',kind:'ordinary_default_dispatch_runtime_grant',schemaVersion:1};assert.equal(isAcceptanceRecord(fake),true);assert.equal(acceptanceRecordMatchesFloor(fake,f.backend.getWriterProfile().floor),false);
 assert.throws(()=>f.backend.save({scope:{type:'project',projectId:'p'},entities:[{collection:'protocolReceipt',key:'fake',projectId:'p',value:fake}]}));
 assert.equal(f.backend.revision,revision);assert.deepEqual(f.effects,[]);
});

async function originalStorage5(root){
 const fixtures=new URL('./fixtures/d19x-original-storage5/',import.meta.url),manifest=JSON.parse(readFileSync(new URL('manifest.json',fixtures),'utf8')),core=new URL('../src/core/',import.meta.url),targets={};
 for(const row of manifest.files){const text=readFileSync(new URL(row.fixture,fixtures),'utf8');assert.equal(createHash('sha256').update(text).digest('hex'),row.sha256);targets[row.source.split('/').at(-1)]=join(root,row.source.split('/').at(-1)+'.mjs');}
 for(const row of manifest.files){const text=readFileSync(new URL(row.fixture,fixtures),'utf8'),output=text.replace(/from '(\.\/[^']+)'/g,(_all,relative)=>{const name=relative.slice(2),url=targets[name]?pathToFileURL(targets[name]).href:new URL(name,core).href;return "from '"+url+"'";});writeFileSync(targets[row.source.split('/').at(-1)],output);}
 return{contract:await import(pathToFileURL(targets['initial-plan-acceptance-contract.js']).href),floor:await import(pathToFileURL(targets['sqlite-writer-floor.js']).href)};
}
test('actual original storage5 registry identity stays byte-for-byte compatible and knows no runtime6',async t=>{
 const f=fixture(t),old=await originalStorage5(f.root),current=await import('../src/core/initial-plan-acceptance-contract.js');
 for(const field of ['DURABLE_DISPATCH_WRITER_PROFILE','DURABLE_DISPATCH_WRITER_DIGEST'])assert.equal(current[field],old.contract[field]);
 assert.deepEqual(current.semanticWriterByProfile(current.DURABLE_DISPATCH_WRITER_PROFILE),old.contract.semanticWriterByProfile(old.contract.DURABLE_DISPATCH_WRITER_PROFILE));
 assert.equal(old.contract.semanticWriterByProfile('ordinary_durable_dispatch_runtime_writer_v1'),undefined);
});
test('the actual original loaded storage5 connection cannot read or write the fresh6 native floor',async t=>{
 const f=fixture(t),old=await originalStorage5(f.root),db=new DatabaseSync(f.filePath);try{
  const floor=old.floor.createSqliteWriterFloor(db);assert.equal(floor.assertWritable(),null);assert.equal(f.prepare().ok,true);
  assert.throws(()=>floor.assertWritable(),/writer_profile_unsupported|writer_floor_integrity_failed/);
  assert.throws(()=>db.prepare("INSERT INTO state_entity_history(collection,entity_key,project_id,state_json,checksum,revision,updated_at) VALUES('project','foreign','foreign','{}','foreign',1,'old')").run(),/kswarm_durable_dispatch_runtime_writer_v1|writer_profile/);
  assert.equal(f.db.prepare("SELECT count(*) n FROM state_entity_history WHERE entity_key='foreign'").get().n,0);
 }finally{db.close();}
});
test('the retained original storage5 connection and nine precompiled SQL classes cannot bypass fresh6',async t=>{
 const f=fixture(t),old=await originalStorage5(f.root),db=new DatabaseSync(f.filePath);
 try{
  const floor=old.floor.createSqliteWriterFloor(db);assert.equal(floor.assertWritable(),null);
  const clauses=[
   ['state_entities','insert',"INSERT INTO state_entities VALUES('project','old-probe','old-probe','{}','x',1,'x')"],
   ['state_entities','update',"UPDATE state_entities SET updated_at='old-probe'"],
   ['state_entities','delete','DELETE FROM state_entities'],
   ['state_entity_history','insert',"INSERT INTO state_entity_history VALUES('project','old-probe','old-probe','{}','x',1,'x')"],
   ['state_entity_history','update',"UPDATE state_entity_history SET updated_at='old-probe'"],
   ['state_entity_history','delete','DELETE FROM state_entity_history'],
   ['state_meta','insert',"INSERT INTO state_meta VALUES('old-probe','x')"],
   ['state_meta','update',"UPDATE state_meta SET meta_value='0' WHERE meta_key='revision'"],
   ['state_meta','delete',"DELETE FROM state_meta WHERE meta_key='revision'"],
  ];
  // Compilation and original storage5 module initialization happen BEFORE
  // the actual original fresh6 owner installs its physical SQL gates.
  const compiled=clauses.map(([table,operation,sql])=>({table,operation,statement:db.prepare(sql)}));
  assert.equal(f.prepare().ok,true);assert.equal((await f.create()).id,'p');
  assert.equal(f.hub.handleHumanAddTasks('p',[{id:'old-writer-probe',title:'Original seeded history',brief:'Actual B history',assignedAgent:'worker'}],{requestSource:'user'}).ok,true);
  for(const table of ['state_entities','state_entity_history','state_meta'])assert.ok(f.db.prepare('SELECT count(*) n FROM '+table).get().n>0,table+' must have real rows for update/delete');
  const before=f.snapshot(),triggers=()=>f.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name GLOB 'kswarm_writer_floor_*' ORDER BY name").all(),originalTriggers=triggers();
  const changes=()=>db.prepare('SELECT total_changes() n').get().n;let refused=0;
  for(const {table,operation,statement}of compiled){
   const count=changes();let failure;assert.throws(()=>statement.run(),error=>{failure=error;return /kswarm_durable_dispatch_runtime_writer_v1|writer_profile/.test(error.message);});refused++;
   assert.equal(changes(),count);assert.equal(f.snapshot(),before);assert.deepEqual(triggers(),originalTriggers);
   console.log(JSON.stringify({test:'original-storage5-precompiled-nine-sql',table,operation,refused:true,totalChangesDelta:changes()-count,error:failure.message}));
  }
  assert.equal(refused,9);assert.deepEqual(f.effects,[]);
 }finally{db.close();}
});
test('another authentic scope cannot reuse an already installed fresh6 profile',t=>{
 const f=fixture(t);assert.equal(f.prepare().ok,true);const before=f.snapshot(),revision=f.backend.revision,other=createProjectInputAuthority({...scope,workspaceId:'c'.repeat(64)});
 assert.equal(f.prepare({requestSource:'user',projectInputAuthority:other.reader()}).ok,false);assert.equal(f.snapshot(),before);assert.equal(f.backend.revision,revision);
});
test('fresh6 cannot turn a prior unqualified owner access into a fresh epoch',t=>{
 const f=fixture(t);f.hub.getProject('missing');const before=f.snapshot(),count=f.sql.length;assert.deepEqual(f.prepare(),{ok:false,error:'INITIAL_PLAN_FRESH_RECONCILIATION_REQUIRED'});assert.equal(f.snapshot(),before);assert.equal(f.sql.length,count);
});
test('fresh6 preserves known COMMIT truth and the original swallowed native reentry cause',t=>{
 let armed=false,original;const f=fixture(t,{onAfterExec(statement,{backend}){if(armed&&statement==='COMMIT'){armed=false;try{backend.close();}catch(error){original=error;}}}});
 armed=true;assert.throws(()=>f.prepare(),error=>error.name==='PersistenceCommitError'&&error.durableCommitted===true&&error.cause===original);assert.ok(original);assert.equal(f.db.prepare("SELECT count(*) n FROM state_meta WHERE meta_key='writer_floor_v1'").get().n,1);assert.equal(f.backend.getHealth().status,'failed');
});
