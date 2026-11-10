import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,writeFileSync,existsSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {DatabaseSync} from 'node:sqlite';
const v1='kswarm_owned_desktop_control_v1',v2='kswarm_owned_desktop_control_v2',scope={profileId:'a'.repeat(64),workspaceId:'b'.repeat(64)},nonce='c'.repeat(64),sealNonce='d'.repeat(64);
async function fixture(t,env={}){
 const root=mkdtempSync(join(tmpdir(),'owned-control-prefix-')),child=spawn(process.execPath,[...(env.CONTROL_PREFIX_RAW_MODE==='orphan'?['--expose-gc']:[]),'test/fixtures/owned-control-prefix/entry.js'],{env:{...process.env,CONTROL_TEST_ROOT:root,...env},stdio:['ignore','pipe','pipe','ipc']});
 const frames=[];let stderr='';child.on('message',frame=>frames.push(frame));child.stderr.on('data',chunk=>{stderr+=chunk;});const closed=new Promise(yes=>child.once('close',(code,signal)=>{console.log(JSON.stringify({test:'prefix-owned-child',pid:child.pid,code,signal,reaped:true,cleanupIsNotWholeServerDrain:true}));yes({code,signal});}));
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');await closed;rmSync(root,{recursive:true,force:true});});
 async function wait(find){for(let i=0;i<800;i++){const row=find();if(row)return row;if(child.exitCode!==null||child.signalCode!==null)throw Error('prefix child exited: '+stderr);await delay(5);}throw Error('prefix fixture timeout: '+stderr);}
 const send=frame=>child.send(frame);const get=(type,id)=>wait(()=>frames.find(row=>row.type===type&&(id===undefined||row.id===id)));
 async function hello(protocol=v2){send({protocol,type:'hello',nonce,scope});const row=await wait(()=>frames[0]);assert.equal(row.type,'hello_ack');assert.equal(row.protocol,protocol);return row;}
 const released=tag=>writeFileSync(join(root,'release-'+tag),'1');
 const file=name=>wait(()=>existsSync(join(root,name))&&JSON.parse(readFileSync(join(root,name),'utf8')));
 const floor=()=>{const db=new DatabaseSync(join(root,'state.sqlite'),{readOnly:true});try{return db.prepare("SELECT count(*) n FROM state_meta WHERE meta_key='writer_floor_v1'").get().n;}finally{db.close();}};
 return {root,child,frames,closed,send,get,hello,released,file,floor,common:(hello,protocol=v2)=>({protocol,type:'request',nonce,scope,instance:hello.instance}),seal:(hello,throughId)=>({protocol:v2,type:'seal_prefix',nonce,scope,instance:hello.instance,throughId,sealNonce})};
}
test('v1 exact hello remains unchanged and v2 advertises only the fixed prefix capability',async t=>{
 const first=await fixture(t),old=await first.hello(v1);assert.deepEqual(Object.keys(old).sort(),['instance','nonce','protocol','scope','type']);
 const f=await fixture(t),hello=await f.hello();assert.deepEqual(hello.capabilities,['prefix_seal_v1']);assert.deepEqual(Object.keys(hello).sort(),['capabilities','instance','nonce','protocol','scope','type']);
 f.send({...f.common(hello),id:1,op:'prepare_initial_plan_writer'});assert.equal((await f.get('response',1)).result.profile.schemaVersion,2);assert.equal(f.floor(),1);
},{timeout:10000});
test('response receipt is not a KS-root drain until its original SDK callback actually returns',async t=>{
 const f=await fixture(t,{CONTROL_PREFIX_HOLD_TYPES:'response'}),hello=await f.hello();f.send({...f.common(hello),id:1,op:'prepare_initial_plan_writer'});assert.equal((await f.get('response',1)).result.ok,true);await f.file('held-response-1.json');assert.equal(f.floor(),1);
 f.send(f.seal(hello,1));await delay(25);assert.equal(f.frames.some(row=>row.type==='prefix_drained'),false);f.released('response-1');const receipt=await f.get('prefix_drained');assert.deepEqual(receipt,{protocol:v2,type:'prefix_drained',nonce,scope,instance:hello.instance,throughId:1,sealNonce});
},{timeout:10000});
test('zero business prefix still waits the original hello SDK send completion',async t=>{
 const f=await fixture(t,{CONTROL_PREFIX_HOLD_TYPES:'hello_ack'}),hello=await f.hello();await f.file('held-hello_ack-0.json');f.send(f.seal(hello,0));await delay(25);assert.equal(f.frames.some(row=>row.type==='prefix_drained'),false);f.released('hello_ack-0');assert.equal((await f.get('prefix_drained')).throughId,0);assert.equal(f.floor(),0);
},{timeout:10000});
test('prefix includes a preaccepted queued root and its future response send, not just current sends',async t=>{
 const f=await fixture(t,{CONTROL_PREFIX_HOLD_TYPES:'response'}),hello=await f.hello();f.send({...f.common(hello),id:1,op:'prepare_initial_plan_writer'});await f.get('response',1);await f.file('held-response-1.json');
 f.send({...f.common(hello),id:2,op:'inspect_writer'});await f.file('received-2.json');f.send(f.seal(hello,2));await delay(25);assert.equal(f.frames.some(row=>row.type==='prefix_drained'),false);
 f.released('response-1');assert.equal((await f.get('response',2)).result.profile.floor.schemaVersion,2);await f.file('held-response-2.json');await delay(25);assert.equal(f.frames.some(row=>row.type==='prefix_drained'),false);f.released('response-2');assert.equal((await f.get('prefix_drained')).throughId,2);
},{timeout:10000});
test('transport fault after prefix reservation cannot run the already queued mutation or claim a healthy prefix',async t=>{
 const f=await fixture(t,{CONTROL_PREFIX_HOLD_TYPES:'response',CONTROL_PREFIX_CALLBACK_ERROR:'response-1'}),hello=await f.hello();f.send({...f.common(hello),id:1,op:'prepare_initial_plan_writer'});await f.get('response',1);await f.file('held-response-1.json');
 f.send({...f.common(hello),id:2,op:'prepare_initial_plan_writer'});await f.file('received-2.json');f.send(f.seal(hello,2));f.released('response-1');await f.file('callback-response-1.json');await delay(40);
 assert.equal(JSON.parse(readFileSync(join(f.root,'prepareFreshInitialPlanAcceptanceWriter.json'),'utf8')).calls,1);assert.equal(f.frames.some(row=>row.type==='response'&&row.id===2),false);assert.equal(f.frames.some(row=>row.type==='prefix_drained'),false);assert.equal(f.floor(),1);
},{timeout:10000});
test('terminal notification tail remains KS-owned and cannot reopen its sealed business prefix',async t=>{
 const f=await fixture(t,{CONTROL_PREFIX_HOLD_TYPES:'prefix_drained'}),hello=await f.hello();f.send(f.seal(hello,0));await f.get('prefix_drained');await f.file('held-prefix_drained-0.json');assert.equal(existsSync(join(f.root,'callback-prefix_drained-0.json')),false);
 f.send({...f.common(hello),id:1,op:'prepare_initial_plan_writer'});await delay(25);assert.equal(f.floor(),0);assert.equal(f.frames.some(row=>row.type==='response'),false);f.released('prefix_drained-0');await f.file('callback-prefix_drained-0.json');
},{timeout:10000});
for(const mode of ['promise','thenable','throw'])test('SDK '+mode+' return cannot be washed into a prefix success',async t=>{
 const f=await fixture(t,{CONTROL_PREFIX_RAW_TYPE:'response',CONTROL_PREFIX_RAW_MODE:mode}),hello=await f.hello();f.send({...f.common(hello),id:1,op:'prepare_initial_plan_writer'});await f.get('response',1);f.send(f.seal(hello,1));await delay(25);assert.equal(f.frames.some(row=>row.type==='prefix_drained'),false);assert.equal(existsSync(join(f.root,'then-read.json')),false);
 if(mode==='promise'){f.released('raw-response-1');await delay(25);assert.equal(f.frames.some(row=>row.type==='prefix_drained'),false);}assert.equal(f.floor(),1);
},{timeout:10000});

for(const [name,change] of [
 ['foreign scope',frame=>({...frame,scope:{...scope,workspaceId:'e'.repeat(64)}})],
 ['foreign nonce',frame=>({...frame,nonce:'e'.repeat(64)})],
 ['foreign boot',frame=>({...frame,instance:'e'.repeat(64)})],
 ['future frontier',frame=>({...frame,throughId:1})],
 ['negative frontier',frame=>({...frame,throughId:-1})],
 ['unsafe frontier',frame=>({...frame,throughId:Number.MAX_SAFE_INTEGER+1})],
 ['invalid seal nonce',frame=>({...frame,sealNonce:'wrong'})],
 ['extra authority field',frame=>({...frame,requestSource:'user'})],
])test('v2 prefix rejects '+name+' without minting a drain witness',async t=>{
 const f=await fixture(t),hello=await f.hello();f.send(change(f.seal(hello,0)));assert.equal((await f.get('fault')).error.code,'OWNED_CONTROL_PROTOCOL_INVALID');
 f.send({...f.common(hello),id:1,op:'prepare_initial_plan_writer'});await delay(20);assert.equal(f.frames.some(row=>row.type==='prefix_drained'||row.type==='response'),false);assert.equal(f.floor(),0);
},{timeout:10000});
test('v2 cannot select the legacy migration command or mutate its original floor',async t=>{
 const f=await fixture(t),hello=await f.hello();f.send({...f.common(hello),id:1,op:'migrate_default_dispatch_writer'});await f.get('fault');f.send(f.seal(hello,0));await delay(20);assert.equal(f.floor(),0);assert.equal(f.frames.some(row=>row.type==='prefix_drained'||row.type==='response'),false);
},{timeout:10000});
test('duplicate seal cannot mint a second prefix witness or reopen business',async t=>{
 const f=await fixture(t),hello=await f.hello();f.send(f.seal(hello,0));await f.get('prefix_drained');f.send(f.seal(hello,0));await f.get('fault');f.send({...f.common(hello),id:1,op:'prepare_initial_plan_writer'});await delay(20);assert.equal(f.frames.filter(row=>row.type==='prefix_drained').length,1);assert.equal(f.floor(),0);
},{timeout:10000});
for(const invalid of [false,true])test('synchronous hello callback/reentrant seal waits SDK return classification: '+(invalid?'unknown':'boolean'),async t=>{
 const f=await fixture(t,{CONTROL_PREFIX_SYNC_HELLO:'1',...(invalid?{CONTROL_PREFIX_RAW_TYPE:'hello_ack',CONTROL_PREFIX_RAW_MODE:'thenable'}:{})});await f.hello();await f.file('hello-return-classification.json');
 if(invalid){await delay(30);assert.equal(f.frames.some(row=>row.type==='prefix_drained'),false);}else await f.get('prefix_drained');
 assert.equal(existsSync(join(f.root,'prefix-reentered.json')),false);assert.equal(existsSync(join(f.root,'then-read.json')),false);assert.equal(f.floor(),0);
},{timeout:10000});
test('original Native COMMIT failure keeps its cause and exit-75, without a healthy prefix',async t=>{
 const f=await fixture(t,{CONTROL_PREFIX_NATIVE_FAULT:'1'}),hello=await f.hello();f.send({...f.common(hello),id:1,op:'prepare_initial_plan_writer'});const response=await f.get('response',1);assert.equal(response.error.name,'PersistenceCommitError');assert.equal(response.error.code,'OWNED_CONTROL_REMOTE_ERROR');assert.equal(response.error.durableCommitted,false);assert.match(JSON.stringify(response.error),/original prefix Native COMMIT failed/);assert.equal((await f.closed).code,75);assert.equal(f.frames.some(row=>row.type==='prefix_drained'),false);assert.equal(f.floor(),0);
},{timeout:10000});

test('standard pending SDK raw is strongly retained by its original send owner after its callback',async t=>{
 const f=await fixture(t,{CONTROL_PREFIX_RAW_TYPE:'response',CONTROL_PREFIX_RAW_MODE:'orphan'}),hello=await f.hello();f.send({...f.common(hello),id:1,op:'prepare_initial_plan_writer'});await f.get('response',1);await f.file('callback-response-1.json');assert.equal((await f.file('raw-retention.json')).retained,true);f.send(f.seal(hello,1));await delay(20);assert.equal(f.frames.some(row=>row.type==='prefix_drained'),false);assert.equal(f.floor(),1);
},{timeout:10000});
test('unexpected original operation throw cannot become a healthy prefix',async t=>{
 const f=await fixture(t,{CONTROL_PREFIX_OPERATION_THROW:'1',CONTROL_PREFIX_HOLD_TYPES:'response'}),hello=await f.hello();f.send({...f.common(hello),id:1,op:'prepare_initial_plan_writer'});const result=await f.get('response',1);assert.match(result.error.message,/original operation threw/);await f.file('held-response-1.json');f.send(f.seal(hello,1));f.released('response-1');await f.file('callback-response-1.json');await delay(30);assert.equal(f.frames.some(row=>row.type==='prefix_drained'),false);assert.equal(f.floor(),1);
},{timeout:10000});
test('unexpected original operation throw closes admission before its SDK callback can execute a later mutation',async t=>{
 const f=await fixture(t,{CONTROL_PREFIX_OPERATION_THROW:'1',CONTROL_PREFIX_HOLD_TYPES:'response'}),hello=await f.hello();f.send({...f.common(hello),id:1,op:'prepare_initial_plan_writer'});await f.get('response',1);await f.file('held-response-1.json');f.send({...f.common(hello),id:2,op:'prepare_initial_plan_writer'});await f.file('received-2.json');f.released('response-1');await f.file('callback-response-1.json');await delay(30);assert.equal(JSON.parse(readFileSync(join(f.root,'prepareFreshInitialPlanAcceptanceWriter.json'),'utf8')).calls,1);assert.equal(f.frames.some(row=>row.type==='response'&&row.id===2),false);assert.equal(f.floor(),1);
},{timeout:10000});
