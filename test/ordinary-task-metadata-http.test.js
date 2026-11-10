import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import net from 'node:net';
import {DatabaseSync} from 'node:sqlite';
import {EXIT_SAVE_FAILED} from '../src/core/persistence.js';
import {createHub} from '../src/core/hub.js';
import {createProjectInputAuthority} from '../src/core/project-input-authority.js';

for(const failureRoute of ['metadata','ordinary','claim','commit'])test('actual Main task metadata HTTP retains exact original transactions and fail-stop for '+failureRoute,async t=>{
 const root=mkdtempSync(join(tmpdir(),'task-metadata-http-')),scope={profileId:'a'.repeat(64),workspaceId:'b'.repeat(64)},authority=createProjectInputAuthority(scope),dataDir={backend:'sqlite',filePath:join(root,'state.sqlite')};
 let cleanupChild; t.after(async()=>{await cleanupChild?.();rmSync(root,{recursive:true,force:true});});
 const hub=createHub({silent:true,dataDir,brokerClient:{async getRoomSnapshot(){return{ok:true,room:{status:'active'},members:[{status:'active',subject:{kind:'agent',logicalAgentId:'xiaok-po'}}]};},async acquireRoomMembershipLease(){return{ok:true};}}});
 try{assert.equal(hub.prepareOrdinaryTaskInputWriter({requestSource:'user',projectInputAuthority:authority.reader()}).ok,true);for(const [id,contract] of [['p','ordinary_initial_plan_additive_v2'],['manual','ordinary_initial_plan_additive_v2'],['old','ordinary_initial_plan_v1']])await hub.createProject({id,name:id,goal:'Original goal',poAgent:'xiaok-po',primaryRoomId:'room',autoAssignPo:false,requestedStartPolicy:'plan_only'},{requestSource:'user',projectInputAuthority:authority.creator('main-create-'+id,contract)});}finally{hub.closePersistence();}
 const probe=net.createServer();await new Promise(yes=>probe.listen(0,'127.0.0.1',yes));const port=probe.address().port;await new Promise(yes=>probe.close(yes));
 const child=spawn(process.execPath,['src/server/index.js'],{cwd:process.cwd(),env:{...process.env,HOME:root,USERPROFILE:root,KSWARM_DATA_ROOT:root,KSWARM_PORT:String(port),BROKER_URL:'http://127.0.0.1:1',KSWARM_DESKTOP_MUTATION_TOKEN:'fixture-task-metadata',KSWARM_DESKTOP_PROFILE_ID:scope.profileId,KSWARM_DESKTOP_WORKSPACE_ID:scope.workspaceId},stdio:['ignore','pipe','pipe']});let output='';for(const stream of [child.stdout,child.stderr])stream.on('data',data=>{output=(output+data.toString()).slice(-12000);});
 const exit=new Promise(yes=>child.once('exit',(code,signal)=>{console.log(JSON.stringify({test:'task-metadata-original-http-owned-child',pid:child.pid,code,signal,reaped:true}));yes();}));
 cleanupChild=async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');const watchdog=setTimeout(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');},2000);try{await exit;}finally{clearTimeout(watchdog);}};
 const base='http://127.0.0.1:'+port,headers={'content-type':'application/json','x-kswarm-mutation-token':'fixture-task-metadata'},deadline=Date.now()+10000;
 for(;;){try{if((await fetch(base+'/health')).ok)break;}catch{}if(child.exitCode!==null||child.signalCode!==null||Date.now()>deadline)throw Error('isolated_startup_failed: '+output);await new Promise(yes=>setTimeout(yes,25));}
 const get=async path=>(await fetch(base+path,{headers})).json(),post=(id,value,auth=headers)=>fetch(base+'/projects/'+id+'/task-metadata-inputs',{method:'POST',headers:auth,body:JSON.stringify(value)});
 const hash=value=>createHash('sha256').update(value).digest('hex');
 const request=(projectId,message)=>{const body='Original retained body '+message,sha=hash(message),source={schemaVersion:1,...scope,threadId:'thread',canonicalUserTaskId:'main-user-task:'+sha,canonicalMessageId:'main-user-message:'+sha,promptSha256:hash(body),permissionMode:'auto',sourceGoalId:'goal',sourceGoalEpoch:1,sourceGoalTurnId:message};return{protocol:'ordinary_task_metadata_input_v2',source,input:{action:'add_task',expectedProjectRevision:1,sourceMessageId:source.canonicalMessageId,body,title:'Separate original item',brief:''},initialPlanClaim:null};};
 const manual=request('manual','manual');assert.equal((await post('manual',manual,{})).status,401);assert.equal((await fetch(base+'/projects/manual/task-metadata-inputs',{headers})).status,405);
 for(const value of [{...manual,initialPlanClaim:false},{...manual,initialPlanClaim:{}},{...manual,requestSource:'user'},{...manual,initialPlanningAuthority:{}},{...manual,protocol:'future'},{...manual,source:{...manual.source,workspaceId:'f'.repeat(64)}}])assert.ok([400,403].includes((await post('manual',value)).status));
 const applied=await (await post('manual',manual)).json();assert.equal(applied.ok,true,JSON.stringify(applied));assert.equal(applied.taskReceipt.kind,'ordinary_task_addition_receipt');assert.equal(applied.acknowledged,true);assert.equal((await get('/projects/manual/initial-plan-inputs')).reservation,null);
 const replay=await (await post('manual',manual)).json();assert.deepEqual(replay,applied);assert.equal((await get('/projects/manual')).tasks.length,1);
 const old=await (await post('old',request('old','old'))).json();assert.equal(old.ok,false);assert.equal((await get('/projects/old')).tasks.length,0);
 const composite=request('p','composite'),state=await get('/projects/p/initial-plan-inputs');composite.initialPlanClaim={protocol:'ordinary_initial_plan_additive_v2',fromAgent:'xiaok-po',enqueueKey:state.enqueueKey,planRunId:'11111111-1111-4111-8111-111111111111',planGeneration:1,expectedPlanInputRevision:state.planInputRevision,expectedProjectControlDigest:state.projectControlDigest,startPolicy:'plan_only'};
 const combined=await (await post('p',composite)).json();assert.equal(combined.ok,true,JSON.stringify(combined));const after=await get('/projects/p/initial-plan-inputs');assert.equal(after.reservation.planRunId,composite.initialPlanClaim.planRunId);assert.deepEqual(after.reservation.claimRequest,composite.initialPlanClaim);assert.equal(after.reservation.compositeTaskOperationId,combined.operation.operationId);assert.equal(after.reservation.compositeEnvelopeDigest,combined.operation.envelopeDigest);assert.deepEqual(after.taskOwner.scope,scope);assert.equal(after.taskOwner.writerStoreId,combined.taskReceipt.writerStoreId);
 assert.deepEqual(await get('/projects/p/ordinary-inputs/'+encodeURIComponent(combined.operation.operationId)),combined);assert.deepEqual(await (await post('p',composite)).json(),combined);assert.equal((await get('/projects/p')).tasks.length,1);
 const conflict=await (await post('p',{...composite,input:{...composite.input,title:'Changed exact command'}})).json();assert.equal(conflict.error,'OPERATION_ENVELOPE_CONFLICT');assert.equal((await get('/projects/p')).tasks.length,1);assert.equal((await get('/projects/p/initial-plan-inputs')).reservation.planRunId,composite.initialPlanClaim.planRunId);
 const failing=request('manual','actual-commit-lock');failing.input.expectedProjectRevision=(await get('/projects/manual/initial-plan-inputs')).projectRevision;
 const oldState=await get('/projects/old/initial-plan-inputs');let failurePath='/projects/manual/task-metadata-inputs',failureBody=failing;
 if(failureRoute==='ordinary'){const value=request('old','fault-ordinary');failurePath='/projects/old/ordinary-inputs';failureBody={source:value.source,input:{...value.input,action:'add_plan_input'}};delete failureBody.input.title;delete failureBody.input.brief;}
 if(failureRoute==='claim'){failurePath='/projects/old/initial-plan-inputs/claim';failureBody={enqueueKey:oldState.enqueueKey,planRunId:'fault-original-run',planGeneration:1,expectedPlanInputRevision:oldState.planInputRevision,startPolicy:oldState.startPolicy};}
 if(failureRoute==='commit'){const reservation=after.reservation;failurePath='/projects/p/initial-plan-inputs/commit';failureBody={reservationId:reservation.id,enqueueKey:reservation.enqueueKey,planRunId:reservation.planRunId,commandId:reservation.commitCommandId,expectedProjectRevision:reservation.ownerRevision,fromAgent:'xiaok-po',plan:{analysis:'Original owner candidate',phases:[]},tasks:[{id:'initial',title:'Original initial plan item'}]};}
 const externalWriter=new DatabaseSync(dataDir.filePath);externalWriter.exec('BEGIN IMMEDIATE');try{const response=await fetch(base+failurePath,{method:'POST',headers,body:JSON.stringify(failureBody)});assert.equal(response.status,503);assert.deepEqual(await response.json(),{error:'persistence_commit_failed',uncertain:true});}finally{externalWriter.exec('ROLLBACK');externalWriter.close();}
 await exit;assert.equal(child.exitCode,EXIT_SAVE_FAILED);assert.equal(child.signalCode,null);

},{timeout:20000});
