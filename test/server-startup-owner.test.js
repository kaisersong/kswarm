import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {createHub,bindHubServerScheduler} from '../src/core/hub.js';
import {createSqlitePersistence} from '../src/core/sqlite-persistence.js';
import {createWatchdog} from '../src/core/watchdog.js';
import {createProjectInputAuthority} from '../src/core/project-input-authority.js';
const scope={profileId:'a'.repeat(64),workspaceId:'b'.repeat(64)},scheduler={requestSource:'scheduler'};
function fixture(t,options={}){const root=mkdtempSync(join(tmpdir(),'server-startup-owner-')),filePath=join(root,'state.sqlite'),persistence=createSqlitePersistence({filePath,...options}),hub=createHub({silent:true,dataDir:{backend:'sqlite',filePath},persistence}),authority=createProjectInputAuthority(scope);t.after(()=>{hub.closePersistence();rmSync(root,{recursive:true,force:true,maxRetries:5});});return{hub,persistence,filePath,control:{requestSource:'user',projectInputAuthority:authority.reader()}};}
test('fixed no-op startup uses the original recovery collector and performs no write or migration disqualification',async t=>{
 const f=fixture(t),port=bindHubServerScheduler(f.hub);assert.equal(f.hub.prepareInitialPlanAcceptanceWriter(f.control).ok,true);const before=f.hub.getPersistenceHealth().revision;
 assert.deepEqual(port.recoverStartup(scheduler),{ok:true,recovered:[],skipped:[],resumableScriptRuns:[]});assert.equal(port.normalizePoAgents([],scheduler).changed,0);assert.equal(f.hub.getPersistenceHealth().revision,before);assert.equal((await f.hub.migrateDefaultDispatchWriter(f.control)).ok,true);
});
test('scheduler binding is original-owner-only and startup mutations deny user agent missing and forged sources',t=>{
 const f=fixture(t);assert.throws(()=>bindHubServerScheduler({...f.hub}),/SERVER_SCHEDULER_OWNER/);const port=bindHubServerScheduler(f.hub);assert.throws(()=>bindHubServerScheduler(f.hub),/SERVER_SCHEDULER_BOUND/);
 const revision=f.hub.getPersistenceHealth().revision;for(const context of [{},{requestSource:'user'},{requestSource:'agent'},{requestSource:'scheduler',authority:{}}]){assert.throws(()=>port.recoverStartup(context),/SERVER_SCHEDULER_AUTHORITY/);assert.throws(()=>port.normalizePoAgents([],context),/SERVER_SCHEDULER_AUTHORITY/);}assert.equal(f.hub.getPersistenceHealth().revision,revision);
});
test('actual startup PO normalization reuses the existing resolver and commits its changes to original SQLite',async t=>{
 const f=fixture(t);await f.hub.createProject({id:'p',name:'P',goal:'G',poAgent:'xiaok',members:['worker'],autoAssignPo:false});const port=bindHubServerScheduler(f.hub),before=f.hub.getPersistenceHealth().revision;
 const result=port.normalizePoAgents([{id:'xiaok-po',name:'PO',runtimeType:'xiaok',runtimeSource:'desktop-agent-runtime',roles:['project_owner'],status:'offline'}],scheduler);assert.ok(result.changed>0);assert.equal(f.hub.serverObservation.project('p').poAgent,'xiaok-po');assert.equal(f.hub.getPersistenceHealth().revision,before+1);
 const db=new DatabaseSync(f.filePath,{readOnly:true});try{assert.equal(JSON.parse(db.prepare("SELECT state_json FROM state_entities WHERE collection='project' AND entity_key='p'").get().state_json).poAgent,'xiaok-po');}finally{db.close();}
});
test('binding the original watchdog routes only its live one-shot timeout decision into the original Hub/native owner',async t=>{
 const f=fixture(t);await f.hub.createProject({id:'p',name:'P',goal:'G',poAgent:'po',members:['worker'],autoAssignPo:false});const board=f.hub.getBoard('p');board.addTasks([{id:'one',title:'One',assignedAgent:'worker'}]);const task=board.getAllTasks()[0];board.transition(task.id,'dispatched');task.updatedAt=Date.now()-700000;f.hub.persistState();
 const {createWatchdog}=await import('../src/core/watchdog.js');const schedulerPort=bindHubServerScheduler(f.hub);let owner,notified=0,decision;
 const watchdog=createWatchdog({listProjects:()=>f.hub.serverObservation.projects(),getTasks:id=>f.hub.serverObservation.tasks(id),applyTimeout:(id,task,frame)=>{decision=frame;return owner.applyTimeout(frame,scheduler);},onTimeout:()=>{notified++;},timeoutMs:600000,maxRetries:2});owner=schedulerPort.bindWatchdog(watchdog);
 const result=watchdog.check();assert.equal(result.length,1);assert.equal(result[0].action,'retry');assert.equal(notified,1);assert.equal(f.hub.serverObservation.tasks('p')[0].status,'pending');assert.equal(owner.applyTimeout(decision,scheduler).ok,false);
 const db=new DatabaseSync(f.filePath,{readOnly:true});try{const tasks=JSON.parse(db.prepare("SELECT state_json FROM state_entities WHERE collection='board' AND entity_key='p'").get().state_json);assert.equal(tasks.tasks[0].status,'pending');}finally{db.close();}
});
test('startup normalization validates its complete response before changing any original VM or native row',async t=>{
 const f=fixture(t),oldPo='old-'.repeat(220000);for(let n=0;n<10;n++)await f.hub.createProject({id:'p'+n,name:'P'+n,goal:'G',poAgent:oldPo,members:['worker'],autoAssignPo:false});const port=bindHubServerScheduler(f.hub),revision=f.hub.getPersistenceHealth().revision;
 assert.throws(()=>port.normalizePoAgents([{id:'xiaok-po',runtimeType:'xiaok',runtimeSource:'desktop-agent-runtime',roles:['project_owner']}],scheduler),/CONTENT_UNAVAILABLE/);assert.equal(f.hub.getPersistenceHealth().revision,revision,'a rejected response projection must precede the real COMMIT');assert.equal(f.hub.serverObservation.project('p0').poAgent,oldPo);
});

async function timeoutFixture(t,options={}){
 const f=fixture(t,options);await f.hub.createProject({id:'p',name:'P',goal:'G',poAgent:'po',members:['worker'],autoAssignPo:false});const board=f.hub.getBoard('p');board.addTasks([{id:'one',title:'One',assignedAgent:'worker'}]);const task=board.getAllTasks()[0];board.transition(task.id,'dispatched');task.updatedAt=Date.now()-700000;f.hub.persistState();return{...f,board,task};
}
test('one-shot watchdog frames deny source forgery and postcommit notification reentry cannot duplicate a retry',async t=>{
 const f=await timeoutFixture(t),port=bindHubServerScheduler(f.hub);let owner,watchdog,reentry,notifications=0;
 f.hub.serverObservation.subscribe(()=>{try{watchdog.check();}catch(error){reentry=error;}});
 watchdog=createWatchdog({listProjects:()=>f.hub.serverObservation.projects(),getTasks:id=>f.hub.serverObservation.tasks(id),applyTimeout:(_id,_task,frame)=>{
  for(const source of ['agent','user'])assert.throws(()=>owner.applyTimeout(frame,{requestSource:source}),/SERVER_SCHEDULER_AUTHORITY/);assert.equal(owner.applyTimeout({...frame},scheduler).ok,false);const result=owner.applyTimeout(frame,scheduler);assert.equal(owner.applyTimeout(frame,scheduler).ok,false);return result;
 },onTimeout:()=>{notifications++;}});owner=port.bindWatchdog(watchdog);assert.equal(watchdog.check().length,1);assert.equal(watchdog.getRetryCount(f.task.id),1);assert.equal(notifications,1);assert.match(reentry?.message??'',/WATCHDOG_CHECK_REENTRY/);
});
test('a copied Task DTO cannot be upgraded by a real watchdog decision but the next original observation can commit',async t=>{
 const f=await timeoutFixture(t),port=bindHubServerScheduler(f.hub);let owner,copied=true;
 const watchdog=createWatchdog({listProjects:()=>f.hub.serverObservation.projects(),getTasks:id=>{const tasks=f.hub.serverObservation.tasks(id);return copied?tasks.map(task=>({...task})):tasks;},applyTimeout:(_id,_task,frame)=>owner.applyTimeout(frame,scheduler)});owner=port.bindWatchdog(watchdog);const revision=f.hub.getPersistenceHealth().revision;assert.deepEqual(watchdog.check(),[]);assert.equal(f.hub.getPersistenceHealth().revision,revision);assert.equal(watchdog.getRetryCount(f.task.id),0);copied=false;assert.equal(watchdog.check().length,1);assert.equal(watchdog.getRetryCount(f.task.id),1);
});
test('an original API revision advance rejects a stale watchdog observation even when task bytes are unchanged',async t=>{
 const f=await timeoutFixture(t),port=bindHubServerScheduler(f.hub);let owner,result;
 const watchdog=createWatchdog({listProjects:()=>f.hub.serverObservation.projects(),getTasks:id=>f.hub.serverObservation.tasks(id),applyTimeout:(_id,task,frame)=>{const before=JSON.stringify(task);f.hub.mutateProjectState('p',()=>{});assert.equal(JSON.stringify(f.hub.serverObservation.tasks('p')[0]),before);result=owner.applyTimeout(frame,scheduler);return result;}});owner=port.bindWatchdog(watchdog);assert.deepEqual(watchdog.check(),[]);assert.equal(result.error,'WATCHDOG_OBSERVATION_STALE');assert.equal(watchdog.getRetryCount(f.task.id),0);assert.equal(f.hub.serverObservation.tasks('p')[0].status,'dispatched');
});
for(const committed of [false,true])test('native watchdog failure keeps original cause and no success accounting (known COMMIT='+committed+')',async t=>{
 let armed=false,backend,inner;const fault=Error('original watchdog native fault');const f=await timeoutFixture(t,{sqliteFactory(path){const db=new DatabaseSync(path),exec=db.exec.bind(db);db.exec=sql=>{if(armed&&sql==='COMMIT'&&!committed){armed=false;throw fault;}const result=exec(sql);if(armed&&sql==='COMMIT'&&committed){armed=false;try{backend.close();}catch(error){inner=error;}}return result;};return db;}});backend=f.persistence;const port=bindHubServerScheduler(f.hub);let owner,notified=0;
 const watchdog=createWatchdog({listProjects:()=>f.hub.serverObservation.projects(),getTasks:id=>f.hub.serverObservation.tasks(id),applyTimeout:(_id,_task,frame)=>owner.applyTimeout(frame,scheduler),onTimeout:()=>{notified++;}});owner=port.bindWatchdog(watchdog);armed=true;let caught;try{watchdog.check();}catch(error){caught=error;}assert.ok(caught);assert.equal(caught.cause,committed?inner:fault);assert.equal(caught.durableCommitted===true,committed);assert.equal(watchdog.getRetryCount(f.task.id),0);assert.equal(notified,0);
 const db=new DatabaseSync(f.filePath,{readOnly:true});try{const row=JSON.parse(db.prepare("SELECT state_json FROM state_entities WHERE collection='board' AND entity_key='p'").get().state_json);assert.equal(row.tasks[0].status,committed?'pending':'dispatched');}finally{db.close();}
});
test('one original watchdog check commits every current timeout task without reusing the first task native revision',async t=>{
 const f=await timeoutFixture(t);f.board.addTasks([{id:'two',title:'Two',assignedAgent:'worker'}]);const second=f.board.getAllTasks().find(task=>task.title==='Two');f.board.transition(second.id,'dispatched');second.updatedAt=Date.now()-700000;f.hub.persistState();const port=bindHubServerScheduler(f.hub);let owner;
 const watchdog=createWatchdog({listProjects:()=>f.hub.serverObservation.projects(),getTasks:id=>f.hub.serverObservation.tasks(id),applyTimeout:(_id,_task,frame)=>owner.applyTimeout(frame,scheduler)});owner=port.bindWatchdog(watchdog);const result=watchdog.check();assert.equal(result.length,2);for(const task of f.hub.serverObservation.tasks('p')){assert.equal(task.status,'pending');assert.equal(watchdog.getRetryCount(task.id),1);}
 const db=new DatabaseSync(f.filePath,{readOnly:true});try{assert.ok(JSON.parse(db.prepare("SELECT state_json FROM state_entities WHERE collection='board' AND entity_key='p'").get().state_json).tasks.every(task=>task.status==='pending'));}finally{db.close();}
});
test('an already-started stalled send tail is observed before a later native-health rejection',async t=>{
 const f=fixture(t),port=bindHubServerScheduler(f.hub);let reject;const raw=new Promise((_,no)=>{reject=no;});f.hub.closePersistence();assert.throws(()=>port.retainStalledTail(raw,scheduler),/SERVER_SCHEDULER_UNAVAILABLE/);reject(Error('original late stalled send failure'));await new Promise(resolve=>setImmediate(resolve));
});
for(const kind of ['timeout','recovery'])test('the original '+kind+' owner returns a prevalidated result when a committed notice changes serializer hooks',async t=>{
 const f=kind==='timeout'?await timeoutFixture(t):fixture(t);let expectedRun;
 if(kind==='recovery'){
  await f.hub.createProject({id:'p',name:'P',goal:'G',poAgent:'po',members:['worker'],autoAssignPo:false});assert.equal(f.hub.handleHumanAddTasks('p',[{title:'Report',assignedAgent:'worker',acceptanceCriteria:'Review facts',requiredOutputs:['markdown']}],{requestSource:'user'}).ok,true);assert.equal(f.hub.handleApprove('p').ok,true);f.hub.getBoard('p').getAllTasks()[0].executionStrategyOverride='workflow';const started=f.hub.handleRequestDispatch('p','po');assert.equal(started.ok,true);assert.equal(started.workflowRuns.length,1);expectedRun=started.workflowRuns[0].id;
 }
 const port=bindHubServerScheduler(f.hub);let poisoned=false;f.hub.serverObservation.subscribe(()=>{poisoned=true;Object.defineProperty(Object.prototype,'toJSON',{configurable:true,value(){return{};}});});let caught,result,watchdog;
 try{
  if(kind==='timeout'){let owner;watchdog=createWatchdog({listProjects:()=>f.hub.serverObservation.projects(),getTasks:id=>f.hub.serverObservation.tasks(id),applyTimeout:(_id,_task,frame)=>owner.applyTimeout(frame,scheduler)});owner=port.bindWatchdog(watchdog);result=watchdog.check();}else result=port.recoverStartup(scheduler);
 }catch(error){caught=error;}finally{delete Object.prototype.toJSON;}
 assert.equal(poisoned,true);assert.ifError(caught);if(kind==='timeout'){assert.equal(result.length,1);assert.equal(watchdog.getRetryCount(f.task.id),1);}else{assert.equal(result.ok,true);assert.equal(result.recovered.length,1);assert.equal(result.recovered[0].workflowRunId,expectedRun);}assert.equal(f.hub.serverObservation.tasks('p')[0].status,'pending');
});
