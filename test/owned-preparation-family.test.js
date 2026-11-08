import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {createOwnedDefaultDispatchBusiness} from '../src/server/owned-default-dispatch-business.js';
import {protocolDigest} from '../src/core/project-protocol.js';
import {defaultDispatchActionRecord} from '../src/core/default-dispatch-action-data.js';
const scope={profileId:'a'.repeat(64),workspaceId:'b'.repeat(64)},protocol='kswarm_dispatch_business_v1';
const delay=ms=>new Promise(yes=>setTimeout(yes,ms));
async function fixture(t,{installed=true,server=false,bodyMode='held',holdFault=false,holdHostReply=false,holdHostRaw=false}={}){
 const root=mkdtempSync(join(tmpdir(),'original-preparation-family-')),messages=[],waiting=[];let output='',closed=false;
 let broker,brokerHttp,brokerUrl,brokerStop;
 const stopBroker=()=>{if(!brokerStop)brokerStop=(async()=>{if(broker){broker.close();await brokerHttp.close();}})();return brokerStop;};
 if(server){
  const {createBrokerService}=await import('../../intent-broker/src/broker/service.js'),{createServer}=await import('../../intent-broker/src/http/server.js');
  broker=createBrokerService({dbPath:join(root,'broker.sqlite')});brokerHttp=createServer({broker,roomService:broker.room});await brokerHttp.listen(0,'127.0.0.1');broker.attachWebSocket(brokerHttp.raw());brokerUrl='http://127.0.0.1:'+brokerHttp.address().port;
  const {createHub}=await import('../src/core/hub.js'),{createProjectInputAuthority}=await import('../src/core/project-input-authority.js');
  const seed=createHub({silent:true,dataDir:{backend:'sqlite',filePath:join(root,'state.sqlite')},projectStorageRoot:join(root,'projects'),brokerClient:{async getRoomSnapshot(){return{ok:true,room:{status:'active'},messages:[{messageId:'msg'}],members:['po','worker'].map(logicalAgentId=>({status:'active',subject:{kind:'agent',logicalAgentId}}))};},async acquireRoomMembershipLease(){return{ok:true};}}});
  try{const user={requestSource:'user',projectInputAuthority:createProjectInputAuthority(scope).reader()};assert.equal(seed.prepareDurableDispatchRuntimeWriter(user).ok,true);await seed.createProject({id:'p',name:'P',goal:'Original Server preparation composition',poAgent:'po',members:['worker'],primaryRoomId:'room',sourceMessageIds:['msg'],requestedStartPolicy:'plan_only',autoAssignPo:false},user);assert.equal(seed.handleSubmitPlan('p',{analysis:'Controlled empty plan',phases:[]},'po').ok,true);assert.equal(seed.handleHumanAddTasks('p',[{id:'a',title:'A',brief:'Original immutable child',assignedAgent:'worker'}],{requestSource:'user'}).ok,true);}catch(error){broker.close();await brokerHttp.close();throw error;}finally{seed.closePersistence();}
 }
 const child=spawn(process.execPath,[server?'src/server/index.js':'test/fixtures/owned-preparation-family/entry.js'],{stdio:['pipe','pipe','pipe','ipc'],env:{...process.env,PREPARATION_FAMILY_FIXTURE_ROOT:root,PREPARATION_FAMILY_BODY_MODE:bodyMode,...(holdFault?{PREPARATION_FAMILY_HOLD_FAULT:'1'}:{}),...(holdHostReply?{PREPARATION_HOST_HOLD_RESPONSE:'1'}:{}),...(holdHostRaw?{PREPARATION_HOST_HOLD_RAW:'1'}:{}),...(!installed?{PREPARATION_FAMILY_SKIP_INSTALL:'1'}:{}),...(server?{HOME:root,USERPROFILE:root,XIAOK_CONFIG_DIR:join(root,'config'),KSWARM_DATA_ROOT:root,KSWARM_PORT:'0',BROKER_URL:brokerUrl,KSWARM_DESKTOP_PROFILE_ID:scope.profileId,KSWARM_DESKTOP_WORKSPACE_ID:scope.workspaceId,XIAOK_DISABLE_GLOBAL_PLUGINS:'1'}:{})}});
 const close=new Promise(yes=>child.once('close',(code,signal)=>{closed=true;for(const row of waiting){clearTimeout(row.timer);row.no(Error('fixture exited '+code+' '+signal+' '+output));}waiting.length=0;console.log(JSON.stringify({fixture:'original-preparation-family',pid:child.pid,code,signal,reaped:true,notNativeQualification:true,notProductDrain:true}));yes({code,signal});}));
 const wait=(predicate,timeout=4000)=>new Promise((yes,no)=>{const value=messages.find(predicate);if(value)return yes(value);if(closed)return no(Error('fixture already exited '+output));const row={predicate,yes,no,timer:setTimeout(()=>{const at=waiting.indexOf(row);if(at>=0)waiting.splice(at,1);no(Error('fixture response timeout '+output));},timeout)};waiting.push(row);});
 child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.on('data',chunk=>{output+=chunk;});
 child.on('message',message=>{messages.push(message);for(const row of [...waiting])if(row.predicate(message)){clearTimeout(row.timer);waiting.splice(waiting.indexOf(row),1);row.yes(message);}});
 t.after(async()=>{let signals=0;try{if(!closed)child.stdin.write('release\nrelease-fault\nrelease-host-reply\nrelease-host-raw\nclose\n');await Promise.race([close,delay(1000)]);if(!closed){signals++;child.kill('SIGTERM');}await Promise.race([close,delay(1000)]);if(!closed){signals++;child.kill('SIGKILL');}await close;}finally{for(const row of waiting)clearTimeout(row.timer);await stopBroker();console.log(JSON.stringify({fixture:'original-preparation-family-cleanup',signals,ownedChildren:1}));rmSync(root,{recursive:true,force:true,maxRetries:5});}});
 const ready=server?undefined:await wait(row=>row.protocol==='fixture_ready'),nonce='c'.repeat(64);child.send({protocol,type:'hello',scope,nonce});const hello=await wait(row=>row.protocol===protocol&&row.type==='hello_ack'),common={protocol,scope,nonce,instance:hello.instance};let sequence=0;
 const request=(op,input=null,preparation)=>{const id=++sequence;child.send({...common,type:'request',id,op,projectId:'p',input,...(preparation?{family:'preparation',workId:preparation.workId??'d'.repeat(64),sourceIncarnation:preparation.sourceIncarnation??'f'.repeat(64)}:{})});return wait(row=>row.protocol===protocol&&row.type==='response'&&row.id===id);};
 return{root,child,ready,messages,wait,request,common,close,stopBroker,get sequence(){return sequence;}};
}
async function capture(f){const plan=(await f.request('read_plan')).result.plan;const fact=defaultDispatchActionRecord({scope,projectId:'p',planRevision:plan.revision,dispatchGeneration:plan.dispatchGeneration,bindingDigest:plan.bindingDigest,taskSetDigest:plan.taskSetDigest});const result=await f.request('capture_default_dispatch',fact);assert.equal(result.result.ok,true,JSON.stringify(result));return result.result.operation.children[0];}
function target(f,child){return{scope,writerStoreId:f.ready.writerStoreId,projectId:'p',bindingDigest:child.bindingDigest,childKey:child.childKey,payloadHash:child.payloadHash,hostId:'host',targetParticipantId:'desktop',targetIncarnation:'controlled-native-target',inputMapperVersion:'kswarm_task_handoff_prompt_v1',inputDigest:'e'.repeat(64)};}
function physicalRows(f){const db=new DatabaseSync(join(f.root,'state.sqlite'),{readOnly:true});try{return db.prepare('SELECT * FROM state_entities ORDER BY collection,entity_key').all();}finally{db.close();}}
test('the preparation source is independent and rejects unknown frames before getters without the original descriptor',()=>{
 const endpoint=createOwnedDefaultDispatchBusiness({scope});assert.equal(typeof endpoint.preparationSource,'object');assert.notEqual(endpoint.preparationSource,endpoint.source);let getters=0;const fake=new Proxy({},{get(){getters++;throw Error('forbidden');}});
 assert.throws(()=>endpoint.preparationSource.resolve(fake,'read_basis'));assert.equal(getters,0);assert.equal(Object.isFrozen(endpoint.preparationSource),true);
});
test('a not-yet-installed preparation family stays unavailable while original user operations continue',async t=>{
 const f=await fixture(t,{installed:false}),child=await capture(f),reply=await f.request('read_preparation_basis',{childKey:child.childKey,payloadHash:child.payloadHash},{});assert.equal(reply.result.ok,false);assert.match(reply.result.error,/PREPARATION.*UNAVAILABLE/);assert.equal((await f.request('read_plan')).result.ok,true);
});
test('one original session crosses preparation RPCs while held body retains its original prefix root',async t=>{
 const f=await fixture(t),child=await capture(f),basis=await f.request('read_preparation_basis',{childKey:child.childKey,payloadHash:child.payloadHash},{});assert.equal(basis.result.ok,true,JSON.stringify(basis));
 const prepared=await f.request('prepare_intent',target(f,{...child,bindingDigest:basis.result.child.bindingDigest}),{});assert.equal(prepared.result.ok,true,JSON.stringify(prepared));const intent=prepared.result.preparation;
 const sent=await f.request('admit_send',{preparationIntentDigest:intent.intentDigest,sourceIncarnation:'f'.repeat(64)},{});assert.equal(sent.result.ok,true,JSON.stringify(sent));assert.equal(sent.result.sendStatus,'send_started');
 const admission=sent.result.preparation.admissionId,cut=await f.request('read_prepare_call',{admissionId:admission,preparationIntentDigest:intent.intentDigest},{});assert.equal(cut.result.ok,true,JSON.stringify(cut));assert.equal(cut.family,'preparation');assert.equal(cut.workId,'d'.repeat(64));
 f.child.send({...f.common,type:'seal_prefix',throughId:f.sequence,sealNonce:'b'.repeat(64)});await delay(30);assert.equal(f.messages.some(row=>row.protocol===protocol&&row.type==='prefix_drained'),false);
 f.child.stdin.write('release\n');const drained=await f.wait(row=>row.protocol===protocol&&row.type==='prefix_drained');assert.equal(drained.throughId,f.sequence);
});
test('another work id cannot rebind the same original child and source incarnation',async t=>{
 const f=await fixture(t),child=await capture(f),lookup={childKey:child.childKey,payloadHash:child.payloadHash};assert.equal((await f.request('read_preparation_basis',lookup,{})).result.ok,true);const denied=await f.request('read_preparation_basis',lookup,{workId:'9'.repeat(64)});assert.equal(denied.result.ok,false);assert.match(denied.result.error,/WORK_ALREADY_BOUND/);assert.equal((await f.request('read_plan')).result.ok,true);
});
test('a late RegExp exec hook cannot widen the closed preparation work identity',async t=>{
 const f=await fixture(t),child=await capture(f);f.child.stdin.write('poison-hex\n');await f.wait(row=>row.protocol==='fixture_hex_poisoned');
 f.child.send({...f.common,type:'request',id:f.sequence+1,op:'read_preparation_basis',projectId:'p',input:{childKey:child.childKey,payloadHash:child.payloadHash},family:'preparation',workId:'invalid-work-id',sourceIncarnation:'f'.repeat(64)});
 const reply=await f.wait(row=>row.protocol===protocol&&(row.type==='fault'||row.type==='response'&&row.id===f.sequence+1));assert.equal(reply.type,'fault',JSON.stringify(reply));assert.equal(reply.error.message,'DISPATCH_BUSINESS_PROTOCOL_INVALID');
});
test('the actual Server composition binds preparation to its original client and original runtime-six B',async t=>{
 const f=await fixture(t,{server:true}),child=await capture(f),reply=await f.request('read_preparation_basis',{childKey:child.childKey,payloadHash:child.payloadHash},{});assert.equal(reply.result?.ok,true,JSON.stringify(reply));assert.equal(reply.result.child.id,child.childKey);assert.equal(reply.result.intent,null);assert.equal(reply.result.admission,null);assert.equal(reply.result.observation,null);assert.equal((await f.request('read_plan')).result.ok,true);
});
test('a new source incarnation may read history but cannot borrow the original live prepare call',async t=>{
 const f=await fixture(t),child=await capture(f),lookup={childKey:child.childKey,payloadHash:child.payloadHash},basis=await f.request('read_preparation_basis',lookup,{}),prepared=await f.request('prepare_intent',target(f,{...child,bindingDigest:basis.result.child.bindingDigest}),{}),intent=prepared.result.preparation;
 const sent=await f.request('admit_send',{preparationIntentDigest:intent.intentDigest,sourceIncarnation:'f'.repeat(64)},{});assert.equal(sent.result.sendStatus,'send_started');
 const replacement={workId:'9'.repeat(64),sourceIncarnation:'8'.repeat(64)},history=await f.request('read_preparation_basis',lookup,replacement);assert.equal(history.result.ok,true,JSON.stringify(history));
 const cut=await f.request('read_prepare_call',{admissionId:sent.result.preparation.admissionId,preparationIntentDigest:intent.intentDigest},replacement);assert.notEqual(cut.result?.ok,true,JSON.stringify(cut));
});
test('a request beyond a sealed prefix cannot create a new publisher and still obtain a healthy marker',async t=>{
 const f=await fixture(t),child=await capture(f),lookup={childKey:child.childKey,payloadHash:child.payloadHash},basis=await f.request('read_preparation_basis',lookup,{}),prepared=await f.request('prepare_intent',target(f,{...child,bindingDigest:basis.result.child.bindingDigest}),{});
 assert.equal((await f.request('admit_send',{preparationIntentDigest:prepared.result.preparation.intentDigest,sourceIncarnation:'f'.repeat(64)},{})).result.sendStatus,'send_started');
 f.child.send({...f.common,type:'seal_prefix',throughId:f.sequence,sealNonce:'b'.repeat(64)});f.child.send({...f.common,type:'request',id:f.sequence+1,op:'read_preparation_basis',projectId:'p',input:lookup,family:'preparation',workId:'d'.repeat(64),sourceIncarnation:'f'.repeat(64)});
 const reply=await f.wait(row=>row.protocol===protocol&&(row.type==='fault'||row.type==='response'&&row.id===f.sequence+1));assert.equal(reply.type,'fault',JSON.stringify(reply));f.child.stdin.write('release\n');await delay(30);assert.equal(f.messages.some(row=>row.protocol===protocol&&row.type==='prefix_drained'),false);
});
test('a late body failure retains its fault publisher callback before the original endpoint can finish',async t=>{
 const f=await fixture(t,{bodyMode:'reject',holdFault:true}),child=await capture(f),lookup={childKey:child.childKey,payloadHash:child.payloadHash},basis=await f.request('read_preparation_basis',lookup,{}),prepared=await f.request('prepare_intent',target(f,{...child,bindingDigest:basis.result.child.bindingDigest}),{});
 const sent=await f.request('admit_send',{preparationIntentDigest:prepared.result.preparation.intentDigest,sourceIncarnation:'f'.repeat(64)},{});assert.equal(sent.result.sendStatus,'send_started');f.child.send({...f.common,type:'seal_prefix',throughId:f.sequence,sealNonce:'b'.repeat(64)});f.child.stdin.write('release\n');
 const fault=await f.wait(row=>row.protocol===protocol&&row.type==='fault');assert.match(fault.error.message,/controlled late body failure/);f.child.stdin.write('drain\n');await delay(30);assert.equal(f.messages.some(row=>row.protocol==='fixture_drain_result'),false);assert.equal(f.messages.some(row=>row.protocol===protocol&&row.type==='prefix_drained'),false);
 f.child.stdin.write('release-fault\n');const result=await f.wait(row=>row.protocol==='fixture_drain_result');assert.equal(result.ok,false);assert.match(result.error,/controlled late body failure/);
});
test('an original undefined body rejection is not replaced by a later fault publisher error',async t=>{
 const f=await fixture(t,{bodyMode:'reject-undefined',holdFault:true}),child=await capture(f),lookup={childKey:child.childKey,payloadHash:child.payloadHash},basis=await f.request('read_preparation_basis',lookup,{}),prepared=await f.request('prepare_intent',target(f,{...child,bindingDigest:basis.result.child.bindingDigest}),{});
 assert.equal((await f.request('admit_send',{preparationIntentDigest:prepared.result.preparation.intentDigest,sourceIncarnation:'f'.repeat(64)},{})).result.sendStatus,'send_started');f.child.stdin.write('release\n');await f.wait(row=>row.protocol===protocol&&row.type==='fault');f.child.stdin.write('drain\nrelease-fault-error\n');const result=await f.wait(row=>row.protocol==='fixture_drain_result');assert.equal(result.ok,false);assert.equal(result.reasonWasUndefined,true,JSON.stringify(result));
});
for(const mode of ['user-to-preparation','preparation-to-user','wire-request-source'])test('the original endpoint closes role variant '+mode+' before Native writes',async t=>{
 const f=await fixture(t),plan=(await f.request('read_plan')).result.plan,before=physicalRows(f),frame={...f.common,type:'request',id:f.sequence+1,op:'read_preparation_basis',projectId:'p',input:{childKey:'default-dispatch-child:'+'0'.repeat(64),payloadHash:'0'.repeat(64)}};
 if(mode==='preparation-to-user'){frame.op='capture_default_dispatch';frame.input=defaultDispatchActionRecord({scope,projectId:'p',planRevision:plan.revision,dispatchGeneration:plan.dispatchGeneration,bindingDigest:plan.bindingDigest,taskSetDigest:plan.taskSetDigest});frame.family='preparation';frame.workId='d'.repeat(64);frame.sourceIncarnation='f'.repeat(64);}
 if(mode==='wire-request-source'){frame.family='preparation';frame.workId='d'.repeat(64);frame.sourceIncarnation='f'.repeat(64);frame.requestSource='scheduler';}
 f.child.send(frame);const reply=await f.wait(row=>row.protocol===protocol&&(row.type==='fault'||row.type==='response'&&row.id===frame.id));assert.equal(reply.type,'fault',JSON.stringify(reply));assert.deepEqual(physicalRows(f),before);
});
test('immutable preparation target and work identity cannot drift into another source or child',async t=>{
 const f=await fixture(t),child=await capture(f),lookup={childKey:child.childKey,payloadHash:child.payloadHash},basis=await f.request('read_preparation_basis',lookup,{}),input=target(f,{...child,bindingDigest:basis.result.child.bindingDigest});assert.equal((await f.request('prepare_intent',input,{})).result.ok,true);const before=physicalRows(f);
 for(const changed of [{...input,hostId:'other-host'},{...input,inputDigest:'1'.repeat(64)},{...input,childKey:'default-dispatch-child:'+'0'.repeat(64)},{...input,scope:{...scope,workspaceId:'1'.repeat(64)}}])assert.equal((await f.request('prepare_intent',changed,{})).result.ok,false);
 assert.equal((await f.request('read_preparation_basis',lookup,{sourceIncarnation:'2'.repeat(64)})).result.ok,false);assert.deepEqual(physicalRows(f),before);f.child.stdin.write('facts\n');const facts=await f.wait(row=>row.protocol==='fixture_facts');assert.equal(facts.posts.length,0);
});
test('actual Broker disconnect retires preparation while the original user facet remains usable',async t=>{
 const f=await fixture(t,{server:true}),child=await capture(f),lookup={childKey:child.childKey,payloadHash:child.payloadHash};assert.equal((await f.request('read_preparation_basis',lookup,{})).result.ok,true);
 await f.stopBroker();await delay(50);const denied=await f.request('read_preparation_basis',lookup,{});assert.equal(denied.result.ok,false);assert.match(denied.result.error,/PREPARATION.*UNAVAILABLE/);assert.equal((await f.request('read_plan')).result.ok,true);
});

async function registeredPreparation(f){
 const child=await capture(f),lookup={childKey:child.childKey,payloadHash:child.payloadHash},basis=await f.request('read_preparation_basis',lookup,{});
 const prepared=await f.request('prepare_intent',target(f,{...child,bindingDigest:basis.result.child.bindingDigest}),{});assert.equal(prepared.result?.ok,true,JSON.stringify(prepared));
 const sent=await f.request('admit_send',{preparationIntentDigest:prepared.result.preparation.intentDigest,sourceIncarnation:'f'.repeat(64)},{});assert.equal(sent.result?.ok,true,JSON.stringify(sent));
 const input={scope,projectId:'p',childKey:child.childKey,payloadHash:child.payloadHash,admissionId:sent.result.preparation.admissionId,preparationIntentDigest:prepared.result.preparation.intentDigest,sourceIncarnation:'f'.repeat(64),hostLeaseKey:'8'.repeat(64)};
 const registered=await f.request('register_host',input,{});assert.equal(registered.result?.ok,true,JSON.stringify(registered));return{registration:registered.result.hostEffect.registration,input};
}
function noEffect(registration){return{scope,projectId:'p',registrationDigest:protocolDigest(registration),hostLeaseKey:registration.hostLeaseKey,sourceIncarnation:registration.sourceIncarnation,reason:'final_gate_denied'};}
test('original Host registration settles after normal Net seal while its finish excludes only its own prior root',async t=>{
 const f=await fixture(t),{registration}=await registeredPreparation(f);
 f.child.stdin.write('net-seal\n');await f.wait(row=>row.protocol==='fixture_net_sealed');
 let settled=false;const finishing=f.request('finish_host_no_effect',noEffect(registration),{}).then(value=>{settled=true;return value;});
 await delay(40);assert.equal(settled,false);assert.equal(physicalRows(f).some(row=>row.entity_key===registration.id+':no-effect-finish'),false);
 f.child.stdin.write('release\n');const result=await finishing;assert.equal(result.result?.hostEffect.operation,'no_effect_finished',JSON.stringify(result));
 const rows=physicalRows(f),again=await f.request('finish_host_no_effect',noEffect(registration),{});assert.equal(again.result?.hostEffect.operation,'history',JSON.stringify(again));assert.deepEqual(physicalRows(f),rows);
 f.child.send({...f.common,type:'seal_prefix',throughId:f.sequence,sealNonce:'b'.repeat(64)});const drained=await f.wait(row=>row.protocol===protocol&&row.type==='prefix_drained');assert.equal(drained.throughId,f.sequence);
});
test('an unresolved original Host registration cannot be erased by a normal prefix or local drain',async t=>{
 const f=await fixture(t);await registeredPreparation(f);f.child.stdin.write('release\n');f.child.send({...f.common,type:'seal_prefix',throughId:f.sequence,sealNonce:'b'.repeat(64)});
 await delay(40);assert.equal(f.messages.some(row=>row.protocol===protocol&&row.type==='prefix_drained'),false);
 f.child.stdin.write('drain\n');const result=await f.wait(row=>row.protocol==='fixture_drain_result');assert.equal(result.ok,false);assert.match(result.error,/HOST.*UNRESOLVED/);
});
test('a foreign original Work or source incarnation cannot settle another live Host reference',async t=>{
 const f=await fixture(t),{registration}=await registeredPreparation(f),before=physicalRows(f),lookup={childKey:registration.childKey,payloadHash:registration.payloadHash},foreign={workId:'7'.repeat(64),sourceIncarnation:'6'.repeat(64)};
 assert.equal((await f.request('read_preparation_basis',lookup,foreign)).result.ok,true);const refused=await f.request('finish_host_no_effect',noEffect(registration),foreign);assert.equal(refused.result?.ok,false,JSON.stringify(refused));assert.deepEqual(physicalRows(f),before);
 f.child.stdin.write('release\n');assert.equal((await f.request('finish_host_no_effect',noEffect(registration),{})).result?.ok,true);
});

test('normal B finish retires only its HostRef and the original reply callback still holds prefix',async t=>{
 const f=await fixture(t,{holdHostReply:true}),{registration}=await registeredPreparation(f);f.child.stdin.write('release\n');
 const done=await f.request('finish_host_no_effect',noEffect(registration),{});assert.equal(done.result?.hostEffect.operation,'no_effect_finished',JSON.stringify(done));assert.equal(physicalRows(f).some(row=>row.entity_key===registration.id+':no-effect-finish'),true);
 f.child.send({...f.common,type:'seal_prefix',throughId:f.sequence,sealNonce:'b'.repeat(64)});await delay(40);assert.equal(f.messages.some(row=>row.protocol===protocol&&row.type==='prefix_drained'),false);
 f.child.stdin.write('release-host-reply\n');const drained=await f.wait(row=>row.protocol===protocol&&row.type==='prefix_drained');assert.equal(drained.throughId,f.sequence);
});
test('malformed settlement data cannot change or retire its original registered Host row',async t=>{
 const f=await fixture(t),{registration}=await registeredPreparation(f),input=noEffect(registration),before=physicalRows(f);
 for(const changed of [{...input,hostLeaseKey:'9'.repeat(64)},{...input,sourceIncarnation:'9'.repeat(64)},{...input,registrationDigest:'9'.repeat(64)},{...input,scope:{...scope,workspaceId:'9'.repeat(64)}},{...input,reason:'not_entered'},{...input,entered:false}]){
  const reply=await f.request('finish_host_no_effect',changed,{});assert.equal(reply.result?.ok,false,JSON.stringify(reply));assert.deepEqual(physicalRows(f),before);
 }
 f.child.stdin.write('release\n');assert.equal((await f.request('finish_host_no_effect',input,{})).result?.hostEffect.operation,'no_effect_finished');
});

test('a finish SDK callback and nonstandard raw return remain separate actual physical tails',async t=>{
 const f=await fixture(t,{holdHostRaw:true}),{registration}=await registeredPreparation(f);f.child.stdin.write('release\n');const done=await f.request('finish_host_no_effect',noEffect(registration),{});assert.equal(done.result?.hostEffect.operation,'no_effect_finished',JSON.stringify(done));
 f.child.stdin.write('drain\n');await delay(40);assert.equal(f.messages.some(row=>row.protocol==='fixture_drain_result'),false);
 f.child.stdin.write('release-host-reply\n');await delay(40);assert.equal(f.messages.some(row=>row.protocol==='fixture_drain_result'),false);
 f.child.stdin.write('release-host-raw\n');const result=await f.wait(row=>row.protocol==='fixture_drain_result');assert.equal(result.ok,false);assert.match(result.error,/SEND_RETURN_UNCONFIRMED/);
});
test('actual finish COMMIT followed by original SDK failure preserves durable rows and unconfirmed Host custody',async t=>{
 const f=await fixture(t),{registration}=await registeredPreparation(f);f.child.stdin.write('release\narm-host-commit-failure\n');await f.wait(row=>row.protocol==='fixture_host_commit_armed');
 const reply=await f.request('finish_host_no_effect',noEffect(registration),{});assert.equal(reply.error?.name,'PersistenceCommitError',JSON.stringify(reply));assert.match(JSON.stringify(reply.error),/controlled_host_commit_wrapper_failure/);assert.equal(physicalRows(f).some(row=>row.entity_key===registration.id+':no-effect-finish'),true);
 f.child.send({...f.common,type:'seal_prefix',throughId:f.sequence,sealNonce:'b'.repeat(64)});await delay(40);assert.equal(f.messages.some(row=>row.protocol===protocol&&row.type==='prefix_drained'),false);f.child.stdin.write('drain\n');assert.equal((await f.wait(row=>row.protocol==='fixture_drain_result')).ok,false);
});

test('revoking original preparation effects preserves only the same live Host settlement membership',async t=>{
 const f=await fixture(t),{registration,input}=await registeredPreparation(f);f.child.stdin.write('release\nrevoke-preparation\n');await f.wait(row=>row.protocol==='fixture_preparation_revoked');
 const denied=await f.request('read_prepare_call',{admissionId:input.admissionId,preparationIntentDigest:input.preparationIntentDigest},{});assert.equal(denied.result?.ok,false);
 const done=await f.request('finish_host_no_effect',noEffect(registration),{});assert.equal(done.result?.ok,true,JSON.stringify(done));assert.equal(done.result.hostEffect.operation,'no_effect_finished');
 f.child.send({...f.common,type:'seal_prefix',throughId:f.sequence,sealNonce:'b'.repeat(64)});assert.equal((await f.wait(row=>row.protocol===protocol&&row.type==='prefix_drained')).throughId,f.sequence);
});
