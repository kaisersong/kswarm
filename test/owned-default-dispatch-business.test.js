import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHub} from '../src/core/hub.js';
const scope={profileId:'a'.repeat(64),workspaceId:'b'.repeat(64)};
async function original(){return import('../src/server/owned-default-dispatch-business.js');}
test('a source without the actual original parent descriptor cannot mint a user business frame',async t=>{
 const {createOwnedDefaultDispatchBusiness}=await original(),endpoint=createOwnedDefaultDispatchBusiness({scope});let getters=0;
 const fake=new Proxy({},{get(){getters++;throw Error('not_reached');},getPrototypeOf(){getters++;throw Error('not_reached');}});
 assert.throws(()=>endpoint.source.resolve(fake));assert.equal(getters,0);
 const root=mkdtempSync(join(tmpdir(),'dispatch-business-api-')),hub=createHub({silent:true,dataDir:{backend:'sqlite',filePath:join(root,'state.sqlite')},defaultDispatchActionSource:endpoint.source});
 t.after(()=>{hub.closePersistence();rmSync(root,{recursive:true,force:true});});
 const owner=endpoint.install(hub);assert.equal(owner.available,false);assert.throws(()=>endpoint.source.resolve({}));await owner.drain();
});
test('the endpoint binds only to an actual Hub born with its exact constructor source',async t=>{
 const {createOwnedDefaultDispatchBusiness}=await original(),endpoint=createOwnedDefaultDispatchBusiness({scope});let getters=0;
 assert.throws(()=>endpoint.install(new Proxy({},{get(){getters++;throw Error('not_reached');}})),/BUSINESS_HUB_OWNER_REQUIRED/);assert.equal(getters,0);
 const root=mkdtempSync(join(tmpdir(),'dispatch-business-foreign-')),hub=createHub({silent:true,dataDir:{backend:'sqlite',filePath:join(root,'state.sqlite')},defaultDispatchActionSource:{resolve(){throw Error('different_owner');}}});
 t.after(()=>{hub.closePersistence();rmSync(root,{recursive:true,force:true});});assert.throws(()=>endpoint.install(hub),/BUSINESS_HUB_OWNER_REQUIRED/);
});
test('private business source rejects serialized action data and copied source handles as authority',async()=>{
 const {createOwnedDefaultDispatchBusiness}=await original(),endpoint=createOwnedDefaultDispatchBusiness({scope});
 for(const frame of [{},JSON.parse('{"kind":"default_dispatch_user_action_v1"}'),{scope,projectId:'p',requestSource:'user'}])assert.throws(()=>endpoint.source.resolve(frame));
 assert.equal(Object.isFrozen(endpoint.source),true);assert.deepEqual(Object.keys(endpoint.source),['resolve']);
});

import {spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {defaultDispatchActionRecord} from '../src/core/default-dispatch-action-data.js';
const protocol='kswarm_dispatch_business_v1',cfg='kswarm_owned_desktop_control_v2';
const delay=ms=>new Promise(yes=>setTimeout(yes,ms));
async function processFixture(t,{hold=false,offReentry=false,businessScope=scope,sdkMode='',handshake=true,realServer=false,parentFixture=null,onSpawn}={}){
 const root=parentFixture?.root??mkdtempSync(join(tmpdir(),'dispatch-business-process-')),ownedChildren=parentFixture?.ownedChildren??new Set(),messages=[],waiters=[];let output='';
 if(realServer&&!parentFixture){const authority=(await import('../src/core/project-input-authority.js')).createProjectInputAuthority(scope),control={requestSource:'user',projectInputAuthority:authority.reader()},hub=createHub({silent:true,dataDir:{backend:'sqlite',filePath:join(root,'state.sqlite')},projectStorageRoot:join(root,'projects'),brokerClient:{async getRoomSnapshot(){return{ok:true,room:{status:'active'},messages:[{messageId:'msg'}],members:['po','worker'].map(logicalAgentId=>({status:'active',subject:{kind:'agent',logicalAgentId}}))};},async acquireRoomMembershipLease(){return{ok:true,leaseId:'fixture-lease'};},async releaseRoomMembershipLease(){return{ok:true};}}});try{assert.equal(hub.prepareDurableDispatchWriter(control).ok,true);await hub.createProject({id:'p',name:'P',goal:'Original server storage fixture',poAgent:'po',members:['worker'],primaryRoomId:'room',sourceMessageIds:['msg'],requestedStartPolicy:'plan_only',autoAssignPo:false},control);assert.equal(hub.handleHumanAddTasks('p',[{id:'a',title:'A',assignedAgent:'worker'}],{requestSource:'user'}).ok,true);}finally{hub.closePersistence();}}
 const child=spawn(process.execPath,[...(offReentry||sdkMode?['-r','./test/fixtures/owned-default-dispatch-business/sdk-preload.cjs']:[]),realServer?'src/server/index.js':'test/fixtures/owned-default-dispatch-business/entry.js'],{env:{...process.env,...(realServer?{HOME:root,USERPROFILE:root,XIAOK_CONFIG_DIR:join(root,'config'),KSWARM_DATA_ROOT:root,KSWARM_PORT:'0',BROKER_URL:'http://127.0.0.1:9',KSWARM_DESKTOP_PROFILE_ID:scope.profileId,KSWARM_DESKTOP_WORKSPACE_ID:scope.workspaceId,XIAOK_DISABLE_GLOBAL_PLUGINS:'1'}:{}),DISPATCH_BUSINESS_TEST_ROOT:root,DISPATCH_BUSINESS_DOMAIN_WORKSPACE:businessScope.workspaceId,DISPATCH_BUSINESS_SDK_MODE:sdkMode||'off-reentry',...(hold?{DISPATCH_BUSINESS_HOLD_CALLBACK:'1'}:{})},stdio:['pipe','pipe','pipe','ipc']});
 const exited=new Promise(yes=>child.once('close',(code,signal)=>{console.log(JSON.stringify({test:'owned-dispatch-business',pid:child.pid,code,signal,reaped:true,childCloseObserved:true,notWholeServerDrain:signal!==null}));yes({code,signal});}));
 const wait=(predicate,timeout=4000)=>new Promise((yes,no)=>{const old=messages.find(predicate);if(old)return yes(old);const row={predicate,yes,no,timer:setTimeout(()=>{const index=waiters.indexOf(row);if(index>=0)waiters.splice(index,1);no(Error('business_response_timeout '+output+' MESSAGES='+JSON.stringify(messages)));},timeout)};waiters.push(row);});
 child.on('message',message=>{messages.push(message);for(const row of [...waiters])if(row.predicate(message)){clearTimeout(row.timer);waiters.splice(waiters.indexOf(row),1);row.yes(message);}});
 child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.on('data',chunk=>{output+=chunk;});
 ownedChildren.add({child,exited,waiters});
 if(!parentFixture)t.after(async()=>{for(const record of ownedChildren){const {child,exited,waiters}=record;if(child.exitCode===null&&child.signalCode===null)child.stdin.write('release-sdk\nrestore\nrelease\nclose\n');await Promise.race([exited,delay(1000)]);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');await Promise.race([exited,delay(1000)]);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exited;for(const row of waiters)clearTimeout(row.timer);}rmSync(root,{recursive:true,force:true,maxRetries:5});});
 onSpawn?.({child,root,messages});
 const ready=realServer?undefined:await wait(m=>m.protocol==='fixture_ready');
 const nonce='c'.repeat(64);let hello;if(handshake){child.send({protocol,type:'hello',scope:businessScope,nonce});hello=await wait(m=>m.protocol===protocol&&m.type==='hello_ack');}let sequence=0;
 const common={protocol,scope:businessScope,nonce,instance:hello?.instance};
 const request=async(op,input=null,timeout=4000)=>{const id=++sequence;child.send({...common,type:'request',id,op,projectId:'p',input});return wait(m=>m.protocol===protocol&&m.type==='response'&&m.id===id,timeout);};
 const rows=()=>{const db=new DatabaseSync(join(root,'state.sqlite'),{readOnly:true});try{return db.prepare("SELECT entity_key,state_json,revision FROM state_entities WHERE collection IN ('protocolReceipt','protocolHead') ORDER BY entity_key").all();}finally{db.close();}};
 return{root,child,closed:exited,ownedChildren,messages,wait,request,common,rows,ready,get sequence(){return sequence;},get output(){return output;}};
}
function fact(head){return defaultDispatchActionRecord({scope,projectId:'p',planRevision:head.revision,dispatchGeneration:head.dispatchGeneration,bindingDigest:head.bindingDigest,taskSetDigest:head.taskSetDigest});}
test('actual parent IPC captures the original Native graph once and history reads without reminting a frame',async t=>{
 const f=await processFixture(t),plan=await f.request('read_plan');assert.equal(plan.result.ok,true,JSON.stringify(plan));const input=fact(plan.result.plan),first=await f.request('capture_default_dispatch',input);assert.equal(first.result.ok,true,JSON.stringify(first));assert.equal(first.result.operation.children.length,1);
 const before=f.rows(),again=await f.request('capture_default_dispatch',input);assert.deepEqual(again.result,first.result);assert.deepEqual(f.rows(),before);
 const history=await f.request('read_operation',{planRevision:input.planRevision,dispatchGeneration:input.dispatchGeneration});assert.deepEqual(history.result,first.result);assert.deepEqual(f.rows(),before);
 assert.equal(f.rows().filter(row=>JSON.parse(row.state_json).contract==='ordinary_default_dispatch_operations_v1').length,6);
});
test('an installed business sibling cannot poison the original configuration v2 session',async t=>{
 const f=await processFixture(t),nonce='d'.repeat(64);f.child.send({protocol:cfg,type:'hello',scope,nonce});const hello=await f.wait(m=>m.protocol===cfg&&m.type==='hello_ack');
 await f.request('read_plan');assert.equal(f.messages.filter(m=>m.protocol===cfg&&m.type==='fault').length,0,JSON.stringify(f.messages));
 f.child.send({protocol:cfg,type:'request',scope,nonce,instance:hello.instance,id:1,op:'inspect_writer'});const result=await f.wait(m=>m.protocol===cfg&&m.type==='response'&&m.id===1);assert.equal(result.result.ok,true);
});
test('a normal business prefix waits the actual held SDK response callback',async t=>{
 const f=await processFixture(t,{hold:true}),plan=await f.request('read_plan');assert.equal(plan.result.ok,true);
 f.child.send({...f.common,type:'seal_prefix',throughId:f.sequence,sealNonce:'e'.repeat(64)});await delay(80);assert.equal(f.messages.some(m=>m.protocol===protocol&&m.type==='prefix_drained'),false);
 f.child.stdin.write('release\n');const cut=await f.wait(m=>m.protocol===protocol&&m.type==='prefix_drained');assert.equal(cut.throughId,1);
});

for(const mode of ['scope','instance','operation','sequence','response','actor'])test('actual business endpoint denies a forged '+mode+' without Native graph writes',async t=>{
 const f=await processFixture(t),frame={...f.common,type:'request',id:1,op:'read_plan',projectId:'p',input:null};
 if(mode==='scope')frame.scope={...scope,workspaceId:'f'.repeat(64)};if(mode==='instance')frame.instance='f'.repeat(64);if(mode==='operation')frame.op='prepare_initial_plan_writer';if(mode==='sequence')frame.id=2;if(mode==='response')frame.type='response';if(mode==='actor')frame.requestSource='agent';
 const before=f.rows();f.child.send(frame);const fault=await f.wait(m=>m.protocol===protocol&&m.type==='fault');assert.equal(fault.error.message,'DISPATCH_BUSINESS_PROTOCOL_INVALID');assert.deepEqual(f.rows(),before);
 const refused=await f.request('read_plan');assert.equal(refused.result.notInvoked,true);assert.equal(refused.result.ok,false);assert.deepEqual(f.rows(),before);
});
test('a copied Main fact with the wrong actor is denied while a fresh valid admitted record can still capture',async t=>{const f=await processFixture(t),head=(await f.request('read_plan')).result.plan,input=fact(head),before=f.rows();const denied=await f.request('capture_default_dispatch',{...input,actorId:'agent:worker'});assert.equal(denied.result.ok,false);assert.deepEqual(f.rows(),before);const allowed=await f.request('capture_default_dispatch',input);assert.equal(allowed.result.ok,true,JSON.stringify(allowed));});

test('own listener cleanup cannot certify a reentrant response whose actual SDK callback is still held',async t=>{const f=await processFixture(t,{offReentry:true});assert.equal((await f.request('read_plan')).result.ok,true);f.child.stdin.write('drain\n');await delay(80);const results=f.output.split('\n').filter(line=>line.startsWith('{')).map(line=>JSON.parse(line)).filter(row=>row.fixture==='drain-result');for(const result of results)assert.equal(result.status==='success'&&result.sdk.secondSendInvocations>0&&!result.sdk.secondCallbackDone,false,JSON.stringify(result));f.child.stdin.write('release\n');});

test('a business session for another workspace cannot use a known canonical Main fact to mutate the original workspace',async t=>{const f=await processFixture(t,{businessScope:{...scope,workspaceId:'f'.repeat(64)}}),before=f.rows(),denied=await f.request('capture_default_dispatch',f.ready.localFact);assert.equal(denied.result.ok,false,JSON.stringify(denied));assert.deepEqual(f.rows(),before);});

for(const sdkMode of ['async-on','async-off'])test('declared '+sdkMode+' process SDK is rejected before its message body',async t=>{const f=await processFixture(t,{sdkMode,handshake:false});f.child.stdin.write('drain\n');await delay(80);f.child.stdin.write('facts\n');await delay(40);const line=f.output.split('\n').find(line=>line.includes('"fixture":"sdk-facts"'));assert.ok(line,f.output);const facts=JSON.parse(line);assert.equal(facts.sdk[sdkMode==='async-on'?'asyncOnBodies':'asyncOffBodies'],0,JSON.stringify(facts));assert.equal(facts.available,false);});
test('a response SDK cannot make private completion await read inherited Promise constructor or then getters',async t=>{const f=await processFixture(t,{sdkMode:'promise-constructor'});assert.equal((await f.request('read_plan')).result.ok,true);f.child.stdin.write('facts\nrestore\n');await delay(80);const line=f.output.split('\n').find(line=>line.includes('"fixture":"sdk-facts"'));assert.ok(line,f.output);const facts=JSON.parse(line);assert.equal(facts.sdk.constructorGetterCalls,0,JSON.stringify(facts));assert.equal(facts.sdk.thenGetterCalls,0,JSON.stringify(facts));});
test('a terminal protocol fault reserves its only reply before a synchronous SDK reentry',async t=>{const f=await processFixture(t,{sdkMode:'fault-reentry'});f.child.send({...f.common,type:'request',id:1,op:'unknown',projectId:'p',input:null});await f.wait(m=>m.protocol===protocol&&m.type==='fault');f.child.stdin.write('facts\n');await delay(80);const line=f.output.split('\n').find(line=>line.includes('"fixture":"sdk-facts"'));assert.ok(line,f.output);assert.equal(JSON.parse(line).sdk.faultSendInvocations,1,line);});

test('the actual original Server owns the business source and original SQLite capture without a test Hub substitute',async t=>{const f=await processFixture(t,{realServer:true}),plan=await f.request('read_plan');assert.equal(plan.result.ok,true,JSON.stringify(plan));const input=fact(plan.result.plan),result=await f.request('capture_default_dispatch',input);assert.equal(result.result.ok,true,JSON.stringify(result));const before=f.rows();assert.deepEqual((await f.request('read_operation',{planRevision:input.planRevision,dispatchGeneration:input.dispatchGeneration})).result,result.result);assert.deepEqual(f.rows(),before);});

test('an SDK array hook cannot widen the closed operation allowlist into a capture branch',async t=>{const f=await processFixture(t,{sdkMode:'op-includes'}),before=f.rows();f.child.send({...f.common,type:'request',id:1,op:'unknown',projectId:'p',input:f.ready.localFact});const reply=await f.wait(m=>m.protocol===protocol&&(m.type==='fault'||m.type==='response'));assert.equal(reply.type,'fault',JSON.stringify(reply));assert.deepEqual(f.rows(),before);});

for(const sdkMode of ['commit-before','commit-after'])test('actual Server business '+sdkMode+' keeps original cause, EXIT75 and physical truth after restart',async t=>{const f=await processFixture(t,{realServer:true,sdkMode}),plan=await f.request('read_plan'),input=fact(plan.result.plan),reply=await f.request('capture_default_dispatch',input,10000);assert.equal(reply.error.name,'PersistenceCommitError',JSON.stringify(reply));assert.equal(reply.error.durableCommitted,false,JSON.stringify(reply));if(sdkMode==='commit-after')assert.ok(JSON.stringify(reply.error).includes('persistence rollback unknown'));assert.ok(JSON.stringify(reply.error).includes(sdkMode==='commit-after'?'actual business after COMMIT':'actual business before COMMIT'));assert.equal((await f.closed).code,75);assert.equal(f.rows().filter(row=>JSON.parse(row.state_json).contract==='ordinary_default_dispatch_operations_v1').length,sdkMode==='commit-after'?6:0);const reopened=await processFixture(t,{realServer:true,parentFixture:f}),history=await reopened.request('read_operation',{planRevision:input.planRevision,dispatchGeneration:input.dispatchGeneration});assert.equal(history.result.ok,sdkMode==='commit-after',JSON.stringify(history));const firstRows=reopened.rows(),capture=await reopened.request('capture_default_dispatch',input);assert.equal(capture.result.ok,true,JSON.stringify(capture));if(sdkMode==='commit-after')assert.deepEqual(reopened.rows(),firstRows);});

test('an original owner-confirmed COMMIT reentry error preserves its true durableCommitted flag',async t=>{const f=await processFixture(t,{sdkMode:'commit-known'}),plan=await f.request('read_plan'),reply=await f.request('capture_default_dispatch',fact(plan.result.plan));assert.equal(reply.error.name,'PersistenceCommitError',JSON.stringify(reply));assert.equal(reply.error.durableCommitted,true,JSON.stringify(reply));assert.equal(f.rows().filter(row=>JSON.parse(row.state_json).contract==='ordinary_default_dispatch_operations_v1').length,6);});

test('actual original post-COMMIT bookkeeping failure is terminal and cannot sign a healthy business prefix',async t=>{const f=await processFixture(t,{realServer:true,sdkMode:'post-bookkeeping'}),plan=await f.request('read_plan'),reply=await f.request('capture_default_dispatch',fact(plan.result.plan));assert.equal(reply.error.code,'persistence_post_commit_failure',JSON.stringify(reply));assert.equal(reply.error.durableCommitted,true,JSON.stringify(reply));assert.ok(JSON.stringify(reply.error).includes('actual post-COMMIT bookkeeping'));f.child.send({...f.common,type:'seal_prefix',throughId:f.sequence,sealNonce:'e'.repeat(64)});await delay(80);assert.equal(f.messages.some(m=>m.protocol===protocol&&m.type==='prefix_drained'),false,JSON.stringify(f.messages));assert.equal((await Promise.race([f.closed,delay(500).then(()=>({code:'still-live'}))])).code,75);assert.equal(f.rows().filter(row=>JSON.parse(row.state_json).contract==='ordinary_default_dispatch_operations_v1').length,6);});

for(const sdkMode of ['startup-compile-held','startup-instantiate-held'])test('the actual '+sdkMode+' Native SDK remains owned before every ordinary hello publisher',async t=>{
 let spawned;const birth=new Promise(yes=>{spawned=yes;});let born=false;
 const opening=processFixture(t,{sdkMode,handshake:false,onSpawn:spawned});opening.then(()=>{born=true;},()=>{});
 const raw=await birth;
 try{for(let n=0;n<100&&!existsSync(join(raw.root,'startup-sdk-held.json'));n++)await delay(10);assert.equal(existsSync(join(raw.root,'startup-sdk-held.json')),true);await delay(80);assert.equal(born,false,'original Native SDK raw still held before module export');assert.equal(raw.messages.some(message=>message.protocol===protocol&&message.type==='hello_ack'),false);}
 finally{raw.child.stdin.write('release-sdk\n');}
 const f=await opening;f.child.send({protocol,type:'hello',scope,nonce:'c'.repeat(64)});
 const hello=await f.wait(message=>message.protocol===protocol&&message.type==='hello_ack');
 f.child.send({protocol,type:'request',scope,nonce:'c'.repeat(64),instance:hello.instance,id:1,op:'read_plan',projectId:'p',input:null});
 const result=await f.wait(message=>message.protocol===protocol&&message.type==='response'&&message.id===1);assert.equal(result.result.ok,true);
});
