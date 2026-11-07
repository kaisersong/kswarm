import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {createHub,bindHubServerScheduler} from '../src/core/hub.js';
import {createSqlitePersistence} from '../src/core/sqlite-persistence.js';
import {createProjectInputAuthority} from '../src/core/project-input-authority.js';
import {createAgentStore} from '../src/core/agent-store.js';
const scope={profileId:'a'.repeat(64),workspaceId:'b'.repeat(64)},context=Object.freeze({requestSource:'scheduler'});
function fixture(t,options={}){
 const root=mkdtempSync(join(tmpdir(),'server-agent-input-')),filePath=join(root,'state.sqlite'),sql=[];let native;
 const persistence=createSqlitePersistence({filePath,sqliteFactory(path){native=new DatabaseSync(path);const exec=native.exec.bind(native);native.exec=statement=>{sql.push(statement);return exec(statement);};return native;},...options});
 const hub=createHub({silent:true,dataDir:{backend:'sqlite',filePath},persistence,...(options.brokerClient?{brokerClient:options.brokerClient}:{})}),port=bindHubServerScheduler(hub),authority=createProjectInputAuthority(scope),control={requestSource:'user',projectInputAuthority:authority.reader()};
 t.after(()=>{hub.closePersistence();rmSync(root,{recursive:true,force:true});});return{root,hub,port,persistence,sql,get db(){return native;},authority,control,notify:(agentId,ctx=context)=>port.invalidateAgentTeamPlans(agentId,ctx)};
}
test('actual AgentStore seed profile updates notify the fixed Server owner with zero SQL and preserve fresh admission',t=>{
 const f=fixture(t),filePath=join(f.root,'agents.json'),notifications=[],store=createAgentStore({filePath,onTeamRelevantChange:({agentId})=>notifications.push(f.notify(agentId))});
 const before=f.persistence.revision,count=f.sql.length;store.update('xiaok-po',{name:'Original PO updated'});store.update('xiaok-worker',{name:'Original Worker updated'});
 assert.deepEqual(notifications,[0,0]);assert.equal(f.persistence.revision,before);assert.equal(f.sql.length,count);assert.equal(JSON.parse(readFileSync(filePath,'utf8')).find(agent=>agent.id==='xiaok-po').name,'Original PO updated');assert.equal(f.hub.prepareFreshInitialPlanAcceptanceWriter(f.control).ok,true);
});
test('a verified zero does not clear a prior unknown source while the old public API retains its original persist behavior',t=>{
 const f=fixture(t);f.hub.getProject('missing');const count=f.sql.length;assert.equal(f.notify('unrelated'),0);assert.equal(f.sql.length,count);assert.equal(f.hub.prepareFreshInitialPlanAcceptanceWriter(f.control).error,'INITIAL_PLAN_FRESH_RECONCILIATION_REQUIRED');
 const before=f.persistence.revision;assert.equal(f.hub.invalidateTeamPlansForAgent('unrelated'),0);assert.equal(f.persistence.revision,before+1);
});
for(const match of ['po','member','preferred-applied','preferred-stale','member-nullplan'])test(`original ${match} match still counts and bumps the actual project in one native commit`,t=>{
 const f=fixture(t);f.hub.createProject({id:'p',name:'Original',poAgent:match==='po'?'target':'po',members:match.startsWith('member')?['target']:[],autoAssignPo:false});
 const project=f.hub.getProject('p');project.teamPlan=match.startsWith('preferred')?{status:match.endsWith('applied')?'applied':'stale',roles:[{preferredExistingAgentId:'target'}]}:null;f.hub.persistState();
 const revision=f.persistence.revision,before=project.projectRevision;assert.equal(f.notify('target'),1);assert.equal(f.persistence.revision,revision+1);assert.equal(project.projectRevision,before+1);
 assert.equal(project.teamPlan?.status,match==='preferred-applied'?'applied':match==='preferred-stale'?'stale':undefined);
});
test('wrong scheduler source and an accessor agent ID cannot invoke a getter or write state',t=>{
 const f=fixture(t),before=f.persistence.revision;let getters=0;const id={get toString(){getters++;return ()=>'target';}};
 for(const ctx of [{},{requestSource:'agent'},{requestSource:'user'},{requestSource:'scheduler',extra:true}])assert.throws(()=>f.notify('target',ctx),/SERVER_SCHEDULER_AUTHORITY_REQUIRED/);
 assert.throws(()=>f.notify(id),/SERVER_AGENT_INPUT_INVALID/);assert.equal(getters,0);assert.equal(f.persistence.revision,before);
});
test('an unsafe project getter is rejected before the scan can report a verified zero',t=>{
 const f=fixture(t);f.hub.createProject({id:'p',name:'Original',poAgent:'po',members:[],autoAssignPo:false});const project=f.hub.getProject('p');let touched=0;Object.defineProperty(project,'members',{configurable:true,enumerable:true,get(){touched++;return [];}});
 const before=f.persistence.revision;assert.throws(()=>f.notify('unrelated'));assert.equal(touched,0);assert.equal(f.persistence.revision,before);
});
test('a replaced array filter cannot erase the original member reference from the complete source snapshot',t=>{
 const f=fixture(t);f.hub.createProject({id:'p',name:'Original',poAgent:'po',members:['target'],autoAssignPo:false});const before=f.persistence.revision,original=Array.prototype.filter;let invoked=0,result;
 Array.prototype.filter=function(callback,thisArg){if(this.includes('members')){invoked++;return Reflect.apply(original,this,[key=>key!=='members']);}return Reflect.apply(original,this,[callback,thisArg]);};
 try{result=f.notify('target');}finally{Array.prototype.filter=original;}
 assert.equal(result,1);assert.equal(invoked,0);assert.equal(f.persistence.revision,before+1);
});
async function planning(t){
 let hold=false,enter,release;const entered=new Promise(resolve=>{enter=resolve;}),held=new Promise(resolve=>{release=resolve;});
 const f=fixture(t,{brokerClient:{async getRoomSnapshot(){if(hold){enter();await held;}return{ok:true,room:{status:'active'},messages:[{messageId:'msg'}],members:['po','worker'].map(logicalAgentId=>({status:'active',subject:{kind:'agent',logicalAgentId}}))};},async acquireRoomMembershipLease(){return{ok:true};},async publishRoomProjectEvent(){return{ok:true};}}});
 assert.equal(f.hub.prepareInitialPlanAcceptanceWriter(f.control).ok,true);
 const p=f.hub.planningMigration;await p.createProject({id:'p',name:'Original',goal:'Original goal',poAgent:'po',members:['worker'],primaryRoomId:'room',sourceMessageIds:['msg'],requestedStartPolicy:'plan_only',autoAssignPo:false},{requestSource:'user',projectInputAuthority:f.authority.creator('main-seed-plan','ordinary_initial_plan_additive_v1')});
 const input=p.readInputs('p',f.authority.reader()),claim=p.claim('p',{protocol:'ordinary_initial_plan_additive_v1',fromAgent:'po',enqueueKey:input.enqueueKey,planRunId:'run',planGeneration:1,expectedPlanInputRevision:input.planInputRevision,expectedProjectControlDigest:input.projectControlDigest,startPolicy:'plan_only'},{requestSource:'user',projectInputAuthority:f.authority.planner()});assert.equal(claim.ok,true);const r=claim.reservation;
 assert.equal(p.commit('p',{reservationId:r.id,enqueueKey:r.enqueueKey,planRunId:r.planRunId,commandId:r.commitCommandId,expectedProjectRevision:r.ownerRevision,fromAgent:'po',plan:{analysis:'Original planning',phases:[]},tasks:[{id:'task',title:'Original task'}]},{requestSource:'user',projectInputAuthority:f.authority.planner()}).ok,true);
 hold=true;const publication=f.hub.flushRoomEventOutbox();await entered;return{...f,release,publication};
}
test('a saved AgentStore change during actual migration closing remains unknown before runPublic refuses admission',async t=>{
 const f=await planning(t),path=join(f.root,'closing-agents.json'),store=createAgentStore({filePath:path,onTeamRelevantChange:({agentId})=>f.notify(agentId)}),migration=f.hub.migrateDefaultDispatchWriter(f.control);
 try{assert.throws(()=>store.update('xiaok-po',{name:'Already saved before observer refusal'}),/SERVER_AGENT_INPUT_UNVERIFIED/);assert.equal(JSON.parse(readFileSync(path,'utf8')).find(agent=>agent.id==='xiaok-po').name,'Already saved before observer refusal');}
 finally{f.release();await f.publication;}
 const result=await migration;assert.equal(result.ok,false);assert.match(result.error,/RECONCILIATION_REQUIRED/);assert.equal(f.persistence.getWriterProfile().floor.schemaVersion,2);
});
test('a wrong scheduler role cannot mark an otherwise eligible closing migration unknown',async t=>{
 const f=await planning(t),migration=f.hub.migrateDefaultDispatchWriter(f.control);
 try{assert.throws(()=>f.notify('unrelated',{requestSource:'agent'}),/SERVER_SCHEDULER_AUTHORITY_REQUIRED/);}finally{f.release();await f.publication;}
 assert.equal((await migration).ok,true);assert.equal(f.persistence.getWriterProfile().floor.schemaVersion,4);
});
test('a native commit fault preserves the original cause and the AgentStore already-saved prefix',t=>{
 let armed=false;const cause=Error('original team-change native COMMIT fault');
 const f=fixture(t,{sqliteFactory(path){const db=new DatabaseSync(path),exec=db.exec.bind(db);db.exec=sql=>{if(armed&&sql==='COMMIT'){armed=false;throw cause;}return exec(sql);};return db;}});
 f.hub.createProject({id:'p',name:'Original',poAgent:'xiaok-po',members:[],autoAssignPo:false});const path=join(f.root,'commit-agents.json'),store=createAgentStore({filePath:path,onTeamRelevantChange:({agentId})=>f.notify(agentId)});armed=true;
 assert.throws(()=>store.update('xiaok-po',{name:'Already durably saved agent prefix'}),error=>error.name==='PersistenceCommitError'&&error.cause===cause);
 assert.equal(f.persistence.getHealth().status,'failed');assert.equal(JSON.parse(readFileSync(path,'utf8')).find(agent=>agent.id==='xiaok-po').name,'Already durably saved agent prefix');
});
