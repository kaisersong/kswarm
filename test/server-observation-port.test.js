import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHub} from '../src/core/hub.js';
import {createProjectInputAuthority} from '../src/core/project-input-authority.js';
const scope={profileId:'a'.repeat(64),workspaceId:'b'.repeat(64)};
function fixture(t,options={}){
 const root=mkdtempSync(join(tmpdir(),'server-observation-')),hub=createHub({silent:true,dataDir:{backend:'sqlite',filePath:join(root,'state.sqlite')},...options}),authority=createProjectInputAuthority(scope),control={requestSource:'user',projectInputAuthority:authority.reader()};
 t.after(()=>{hub.closePersistence();rmSync(root,{recursive:true,force:true,maxRetries:5});});return{root,hub,authority,control,port(){assert.ok(hub.serverObservation,'the original Hub must install its fixed immutable Server observation port');return hub.serverObservation;}};
}
test('original safe Server observations leave the real empty planning epoch eligible for migration',async t=>{
 const f=fixture(t),port=f.port();assert.equal(f.hub.prepareInitialPlanAcceptanceWriter(f.control).ok,true);
 for(let n=0;n<3;n++){
  assert.equal(port.health().projects,0);assert.deepEqual(port.projects(),[]);assert.equal(port.project('missing'),null);assert.deepEqual(port.tasks('missing'),[]);assert.deepEqual(port.projectListView(),[]);assert.equal(port.projectDetailView('missing'),null);
 }
 const result=await f.hub.migrateDefaultDispatchWriter(f.control);assert.equal(result.ok,true);assert.equal(result.transition.toFloor.schemaVersion,4);
});
test('the new observations do not qualify a previously exposed original raw getter',async t=>{
 const f=fixture(t);assert.equal(f.hub.prepareInitialPlanAcceptanceWriter(f.control).ok,true);f.hub.listProjects();assert.equal(f.port().health().projects,0);const result=await f.hub.migrateDefaultDispatchWriter(f.control);assert.equal(result.ok,false);assert.match(result.error,/RECONCILIATION_REQUIRED/);
});
test('immutable Server aggregate views cannot mutate the original in-memory or durable project',async t=>{
 const f=fixture(t);await f.hub.createProject({id:'p',name:'Original',goal:'Original goal',poAgent:'po',members:['worker'],autoAssignPo:false});const port=f.port(),project=port.project('p');assert.equal(project.id,'p');assert.equal(Object.isFrozen(project),true);assert.equal(Object.isFrozen(project.members),true);assert.throws(()=>{project.name='forged';},TypeError);assert.throws(()=>{project.members.push('forged');},TypeError);
 const list=port.projectListView(),detail=port.projectDetailView('p');assert.equal(Object.isFrozen(list),true);assert.equal(Object.isFrozen(detail),true);assert.equal(detail.project.name,'Original');assert.equal(port.project('p').name,'Original');assert.deepEqual(port.tasks('p'),[]);
});
test('closing health is a local diagnostic while ordinary DTO reads remain closed and a closed native owner is unhealthy',async t=>{
 const f=fixture(t),port=f.port();assert.equal(f.hub.prepareInitialPlanAcceptanceWriter(f.control).ok,true);const work=f.hub.migrateDefaultDispatchWriter(f.control);assert.equal(port.health().ok,true);assert.equal(port.health().migrationPhase,'closing');assert.throws(()=>port.projects(),/MIGRATION_ACTIVE/);assert.equal((await work).ok,true);f.hub.closePersistence();assert.equal(port.health().ok,false);
});
test('an activity sink registered during a committed notice starts at the next notice',async t=>{
 const f=fixture(t),port=f.port();let first=0,late=0;
 port.subscribe(()=>{if(first++===0)port.subscribe(()=>{late++;});});
 await f.hub.createProject({id:'p',name:'P',goal:'G',poAgent:'po',members:['worker'],autoAssignPo:false});assert.equal(first,1);assert.equal(late,0);
 await f.hub.createProject({id:'p2',name:'P2',goal:'Second real commit',poAgent:'po',members:['worker'],autoAssignPo:false});assert.equal(late,1);
});
for(const method of ['projectListView','projectDetailView'])test('safe '+method+' rejects original project accessors before executing them',async t=>{
 const f=fixture(t);await f.hub.createProject({id:'p',name:'P',goal:'G',poAgent:'po',members:['worker'],autoAssignPo:false});const raw=f.hub.getProject('p');let reads=0;
 Object.defineProperty(raw,method==='projectListView'?'name':'plan',{enumerable:true,configurable:true,get(){reads++;return method==='projectListView'?'forged':null;}});
 let caught;try{f.port()[method]('p');}catch(error){caught=error;}assert.equal(reads,0,'data accessors must never execute during a safe observation');assert.ok(caught,'an accessor-bearing original row must be typed unavailable');
});
test('safe tasks bypasses a replaced public Board method and reads only its original private data owner',async t=>{
 const f=fixture(t);await f.hub.createProject({id:'p',name:'P',goal:'G',poAgent:'po',members:['worker'],autoAssignPo:false});let reads=0;Object.defineProperty(f.hub.getBoard('p'),'getAllTasks',{get(){reads++;return()=>[];},configurable:true});assert.deepEqual(f.port().tasks('p'),[]);assert.equal(reads,0);
});
test('captured aggregate derivations preserve the existing production views and original task plan progress',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.now()});
 const f=fixture(t);await f.hub.createProject({id:'p',name:'P',goal:'G',poAgent:'po',members:['worker'],autoAssignPo:false});const board=f.hub.getBoard('p');board.addTasks([{id:'one',title:'One',phaseId:'phase-1'},{id:'two',title:'Two',phaseId:'phase-1'}]);f.hub.persistState();
 const wire=value=>JSON.parse(JSON.stringify(value));const detail=f.port().projectDetailView('p');assert.deepEqual(detail.planProgress,board.getPlanProgress());assert.deepEqual(detail.dispatchPlan,wire(f.hub.getDispatchPlan('p')));assert.deepEqual(detail.projectHealth,wire(f.hub.getProjectHealth('p')));assert.deepEqual(detail.projectIntervention,wire(f.hub.getProjectIntervention('p')));assert.deepEqual(detail.projectLifecycle,wire(f.hub.getProjectLifecycle('p')));assert.deepEqual(detail.executionGraph,wire(f.hub.getExecutionGraph('p')));assert.equal(detail.tasks.length,2);assert.equal(Object.isFrozen(detail.tasks[0]),true);
});
test('captured aggregate derivations reject original task field accessors without invoking them',async t=>{
 const f=fixture(t);await f.hub.createProject({id:'p',name:'P',goal:'G',poAgent:'po',members:['worker'],autoAssignPo:false});const board=f.hub.getBoard('p');board.addTasks([{id:'one',title:'One'}]);const task=board.getAllTasks()[0];let reads=0;Object.defineProperty(task,'status',{get(){reads++;return'pending';},enumerable:true,configurable:true});for(const name of ['tasks','projectListView','projectDetailView'])assert.throws(()=>f.port()[name]('p'));assert.equal(reads,0);
});

for(const method of ['projectListView','projectDetailView'])test('safe '+method+' cannot export after its fixed agent source closes the original native owner',async t=>{
 let armed=false,f;f=fixture(t,{getAgentProfiles:()=>{if(armed){armed=false;f.hub.closePersistence();}return[];}});await f.hub.createProject({id:'p',name:'P',goal:'G',poAgent:'po',members:['worker'],autoAssignPo:false});armed=true;assert.throws(()=>f.port()[method]('p'),/UNAVAILABLE|closed|CLOSED/);assert.equal(f.port().health().ok,false);
});
test('health and original list observations remain available when independently valid rows exceed the aggregate body budget',async t=>{
 const f=fixture(t);for(let n=0;n<10;n++)await f.hub.createProject({id:'large-'+n,name:'Large '+n,goal:'g'.repeat(1024*1024),poAgent:'po',members:['worker'],autoAssignPo:false});const bytes=Buffer.byteLength(JSON.stringify(f.hub.listProjects()),'utf8');console.log(JSON.stringify({test:'server-health-large-project-data',bytes,projects:10}));assert.ok(bytes>8388608);const revision=f.hub.getPersistenceHealth().revision;assert.equal(f.port().health().projects,10);assert.equal(f.port().projects().length,10);assert.equal(f.port().projectListView().length,10);assert.equal(f.hub.getPersistenceHealth().revision,revision);
});

test('project detail filters other project events before capturing their unconsumed bodies',async t=>{
 const f=fixture(t);await f.hub.createProject({id:'p',name:'P',goal:'G',poAgent:'po',members:[],autoAssignPo:false});const log=f.hub.getEventLog();let reads=0;
 for(let n=0;n<9;n++)log.emit('other.large',{projectId:'other',data:{body:'x'.repeat(1024*1024)}});
 const unrelated=log.emit('other.accessor',{projectId:'other'});Object.defineProperty(unrelated,'unconsumed',{enumerable:true,get(){reads++;return'no';}});const view=f.port().projectDetailView('p');assert.equal(view.project.id,'p');assert.ok(view.activities.every(event=>event.projectId==='p'));assert.equal(reads,0);
});
test('captured related-row collections keep the original workflow ordering without sorting frozen source arrays',async t=>{
 const f=fixture(t);await f.hub.createProject({id:'p',name:'P',goal:'G',poAgent:'po',members:[],autoAssignPo:false});for(const now of [1770000000000,1770000005000])assert.equal(f.hub.startProjectDiagnoseWorkflow('p',{requestedBy:'human',now}).ok,true);assert.equal(f.hub.listProjectWorkflowRuns('p').length,2);
 const detail=f.port().projectDetailView('p'),expected=f.hub.listProjectWorkflowRuns('p').map(run=>run.id);assert.deepEqual(detail.workflowRuns.map(run=>run.id),expected);assert.equal(f.port().projectListView()[0].latestWorkflowRun.id,expected[0]);assert.equal(Object.isFrozen(detail.workflowRuns),true);
});
test('ordinary global event records do not make an unrelated project detail unavailable',async t=>{
 const f=fixture(t);await f.hub.createProject({id:'p',name:'P',goal:'G',poAgent:'po',members:[],autoAssignPo:false});f.hub.getEventLog().emit('system.ready',{message:'ok'});const view=f.port().projectDetailView('p');assert.equal(view.project.id,'p');assert.ok(view.activities.every(event=>event.projectId==='p'));assert.equal(f.port().projectListView().length,1);
});
