import {roomSourceFor} from './fixtures/room-user-source-data.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import net from 'node:net';
import {createHub} from '../src/core/hub.js';
import {createProjectInputAuthority} from '../src/core/project-input-authority.js';
import {createSqlitePersistence} from '../src/core/sqlite-persistence.js';

test('real owner HTTP authenticates reads and writes, derives scope from host and claims one input set',async t=>{
 const root=mkdtempSync(join(tmpdir(),'ordinary-input-http-'));
 const scope={profileId:'a'.repeat(64),workspaceId:'b'.repeat(64)},authority=createProjectInputAuthority(scope);
 const dataDir={backend:'sqlite',filePath:join(root,'state.sqlite')};
 const hub=createHub({silent:true,dataDir,brokerClient:{async getRoomSnapshot(){return {ok:true,room:{status:'active'},members:[{status:'active',subject:{kind:'agent',logicalAgentId:'xiaok-po'}}]};},async acquireRoomMembershipLease(){return {ok:true};}}});
 await hub.createProject({id:'p',name:'P',poAgent:'xiaok-po',primaryRoomId:'room',autoAssignPo:false},{requestSource:'user',projectInputAuthority:authority.creator('main-create-fixture')});
 const foreign=createProjectInputAuthority({...scope,workspaceId:'c'.repeat(64)});
 await hub.createProject({id:'foreign-p',name:'Other scope',poAgent:'xiaok-po',primaryRoomId:'room',autoAssignPo:false},{requestSource:'user',projectInputAuthority:foreign.creator('other-main-create')});hub.closePersistence();
 // Seed a pre-protocol project shape through the real persistence, with no
 // binding/receipt rows. It stays unknown and never gets new input authority.
 const oldShape=createHub({silent:true});oldShape.createProject({id:'legacy',name:'Legacy',goal:'G',poAgent:'xiaok-po',autoAssignPo:false});
 const legacy=structuredClone(oldShape.getProject('legacy'));oldShape.closePersistence();
 const disk=createSqlitePersistence({filePath:dataDir.filePath});try{disk.load();disk.save({entities:[{collection:'project',key:'legacy',projectId:'legacy',value:legacy},{collection:'board',key:'legacy',projectId:'legacy',value:{projectId:'legacy',tasks:[]}}],scope:{type:'project',projectId:'legacy'}});}finally{disk.close();}
 const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
 const child=spawn(process.execPath,['src/server/index.js'],{cwd:process.cwd(),env:{...process.env,HOME:root,USERPROFILE:root,KSWARM_DATA_ROOT:root,KSWARM_PORT:String(port),BROKER_URL:'http://127.0.0.1:1',KSWARM_DESKTOP_MUTATION_TOKEN:'fixture-only',KSWARM_DESKTOP_PROFILE_ID:scope.profileId,KSWARM_DESKTOP_WORKSPACE_ID:scope.workspaceId},stdio:'ignore'});
 const close=new Promise(resolve=>child.once('exit',(code,signal)=>{console.log(JSON.stringify({test:'ordinary-input-http-child',pid:child.pid,code,signal,reaped:true}));resolve();}));
 t.after(async()=>{if(child.exitCode===null)child.kill('SIGTERM');await close;rmSync(root,{recursive:true,force:true});});
 const base='http://127.0.0.1:'+port;const deadline=Date.now()+10000;
 for(;;){try{if((await fetch(base+'/health')).ok)break;}catch{}if(child.exitCode!==null||Date.now()>deadline)throw Error('isolated_startup_failed');await new Promise(resolve=>setTimeout(resolve,25));}
 const headers={'x-kswarm-mutation-token':'fixture-only','content-type':'application/json'};
 const get=async path=>(await fetch(base+path,{headers})).json();
 const post=async(path,body,auth=headers)=>fetch(base+path,{method:'POST',headers:auth,body:JSON.stringify(body)});
 assert.equal((await fetch(base+'/projects/p/execution-start-admission')).status,401);
 const admission=await get('/projects/p/execution-start-admission');assert.equal(admission.ok,true);assert.equal(admission.protocol,'ordinary_project_execution_start_read_v1');assert.equal(admission.classification,'ordinary');assert.equal(admission.projectId,'p');assert.match(admission.bindingDigest,/^[a-f0-9]{64}$/);assert.deepEqual(Object.keys(admission).sort(),['bindingDigest','classification','ok','projectId','protocol','scope']);assert.deepEqual(admission.scope,scope);
 assert.equal((await fetch(base+'/projects/foreign-p/execution-start-admission',{headers})).status,403);
 assert.equal((await fetch(base+'/projects/missing/execution-start-admission',{headers})).status,404);
 assert.equal((await post('/projects/p/execution-start-admission',{})).status,405);
 const legacyAdmission=await get('/projects/legacy/execution-start-admission');assert.equal(legacyAdmission.classification,'legacy_ordinary');assert.equal(legacyAdmission.bindingDigest,null);
 assert.equal((await fetch(base+'/projects/p/followup-context')).status,401);
 const context=await get('/projects/p/followup-context');assert.equal(context.protocol,'ordinary_project_followup_context_v1');assert.equal(context.primaryRoomId,'room');assert.equal(context.conversionActions.add_task.eligible,false);assert.equal(Object.hasOwn(context,'goal'),false);
 assert.equal((await fetch(base+'/projects/foreign-p/followup-context',{headers})).status,403);
 assert.equal((await post('/projects/p/followup-context',{})).status,405);
 assert.equal((await get('/projects/legacy/followup-context')).ok,false);
 // New-family transport remains explicitly versioned and bounded. A header
 // selects a parser budget, never a native/user/model permission.
 const roomBody=roomSourceFor(context.bindingDigest);
 assert.equal((await post('/projects/p/ordinary-inputs',roomBody)).status,403);
 const roomHeaders={...headers,'x-kswarm-source-contract':'main_room_conversion_v1'};
 for(const brief of ['b'.repeat(65536),'\0'.repeat(60000)]){
  const large=roomSourceFor(context.bindingDigest,{action:'add_task',expectedProjectRevision:1,brief,body:brief},{roomMessageId:'max-brief-'+brief.length});
  assert.ok(Buffer.byteLength(JSON.stringify(large),'utf8')>131072);assert.ok(Buffer.byteLength(JSON.stringify(large),'utf8')<1048576);
  const response=await post('/projects/p/ordinary-inputs',large,roomHeaders);assert.equal(response.status,409);assert.equal((await response.json()).error,'CANDIDATE_WORKSPACE_UNAVAILABLE');
 }
 const tooLarge={...roomBody,padding:'x'.repeat(1048576)};
 const denied=await post('/projects/p/ordinary-inputs',tooLarge,roomHeaders);assert.equal(denied.status,400);assert.equal((await denied.json()).error,'request_body_too_large');
 assert.equal((await fetch(base+'/projects/p/initial-plan-inputs')).status,401);
 assert.equal((await fetch(base+'/projects/p/ordinary-inputs/guessed')).status,401);
 const body='new user plan input',hash=createHash('sha256').update(body).digest('hex');
 const source={schemaVersion:1,...scope,threadId:'thread',canonicalUserTaskId:'main-user-task:'+hash,canonicalMessageId:'main-user-message:'+hash,promptSha256:hash,permissionMode:'auto',sourceGoalId:'goal',sourceGoalEpoch:1,sourceGoalTurnId:'turn'};
 const input={action:'add_plan_input',body,expectedProjectRevision:1,sourceMessageId:source.canonicalMessageId};
 assert.equal((await post('/projects/p/ordinary-inputs',{input,source},roomHeaders)).status,403);
 assert.equal((await post('/projects/p/ordinary-inputs',{...roomBody,extra:'unsupported'},roomHeaders)).status,403);
 assert.equal((await post('/projects/p/ordinary-inputs',roomBody,{...headers,'x-kswarm-source-contract':'future'})).status,403);
 assert.equal((await get('/projects/p/initial-plan-inputs')).planInputRevision,0);
 assert.equal((await post('/projects/p/ordinary-inputs',{input,source},{})).status,401);
 assert.equal((await post('/projects/p/ordinary-inputs',{input,source:{...source,workspaceId:'c'.repeat(64)}})).status,403);
 const accepted=await (await post('/projects/p/ordinary-inputs',{input,source})).json();assert.equal(accepted.operation.status,'accepted_pending');
 const state=await get('/projects/p/initial-plan-inputs');assert.equal(state.planInputRevision,1);
 const request={enqueueKey:state.enqueueKey,planRunId:'persisted-main-run',planGeneration:state.planGeneration,expectedPlanInputRevision:state.planInputRevision,startPolicy:state.startPolicy};
 const claim=await (await post('/projects/p/initial-plan-inputs/claim',request)).json();assert.equal(claim.ok,true);
 assert.deepEqual(claim.inputs.map(value=>value.body),[body]);
 const receipt=await get('/projects/p/ordinary-inputs/'+encodeURIComponent(accepted.operation.operationId));assert.equal(receipt.acknowledged,true);
 const replay=await (await post('/projects/p/initial-plan-inputs/claim',request)).json();assert.equal(replay.reused,true);assert.deepEqual(replay.reservation,claim.reservation);
 const command={reservationId:claim.reservation.id,enqueueKey:request.enqueueKey,planRunId:request.planRunId,commandId:claim.reservation.commitCommandId,expectedProjectRevision:claim.reservation.ownerRevision,fromAgent:'xiaok-po',plan:{analysis:'initial plan',phases:[]},tasks:[{id:'task-1',title:'Write report'}]};
 assert.equal((await post('/projects/p/initial-plan-inputs/commit',command,{})).status,401);
 const committed=await (await post('/projects/p/initial-plan-inputs/commit',command)).json();assert.equal(committed.ok,true,JSON.stringify(committed));
 assert.deepEqual((await (await post('/projects/p/initial-plan-inputs/commit',command)).json()).receipt,committed.receipt);
 assert.equal((await get('/projects/p/initial-plan-inputs')).commitReceipt.outcome,'applied');
 assert.equal((await post('/projects/p/close',{},{})).status,401);
 assert.equal((await fetch(base+'/projects/p',{method:'DELETE',headers:{}})).status,401);
 assert.equal((await (await post('/projects/p/close',{})).json()).ok,true);
 assert.equal((await get('/projects/p/followup-context')).projectStatus,'closed');
 assert.equal((await get('/projects/p/initial-plan-inputs')).error,'PROJECT_TERMINAL_REQUIRES_REOPEN');
 assert.equal((await (await fetch(base+'/projects/p',{method:'DELETE',headers})).json()).ok,true);
 assert.equal((await fetch(base+'/projects/p/followup-context',{headers})).status,404);
 const deleted=await get('/projects/p/ordinary-inputs/'+encodeURIComponent(accepted.operation.operationId));
 assert.equal(deleted.operation.status,'applied');assert.equal(deleted.operation.projectDisposition,'deleted');assert.equal(deleted.consumption.state,'consumed');
 assert.equal((await fetch(base+'/projects/p/ordinary-inputs/'+encodeURIComponent(accepted.operation.operationId))).status,401);
 assert.equal((await post('/projects/legacy/close',{},{})).status,401);
 assert.equal((await (await post('/projects/legacy/close',{})).json()).ok,true);
 assert.equal((await get('/projects/legacy/initial-plan-producer')).producer,'legacy_unverified');
 assert.equal((await (await fetch(base+'/projects/legacy',{method:'DELETE',headers})).json()).ok,true);
},{timeout:15000});
