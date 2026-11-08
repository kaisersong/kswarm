import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import net from 'node:net';
import {DatabaseSync} from 'node:sqlite';
const protocol='kswarm_owned_desktop_control_v1',scope={profileId:'a'.repeat(64),workspaceId:'b'.repeat(64)};
async function fixture(t,{ipc=true,entry='test/fixtures/owned-desktop-control/entry.js',env={}}={}){
 const root=mkdtempSync(join(tmpdir(),'owned-desktop-control-'));
 const child=spawn(process.execPath,[entry],{env:{...process.env,CONTROL_TEST_ROOT:root,HOME:root,USERPROFILE:root,KSWARM_DATA_ROOT:join(root,'kswarm'),...env},stdio:ipc?['ignore','pipe','pipe','ipc']:['ignore','pipe','pipe']});
 let output='';child.stderr.on('data',chunk=>{output+=chunk;});
 const closed=new Promise(resolve=>child.once('exit',(code,signal)=>{console.log(JSON.stringify({test:'owned-desktop-control',pid:child.pid,code,signal,reaped:true}));resolve({code,signal});}));
 t.after(async()=>{if(child.connected)child.disconnect();if(child.exitCode===null&&!child.killed)child.kill('SIGTERM');await closed;rmSync(root,{recursive:true,force:true,maxRetries:5});});
 const wait=()=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.off('message',onMessage);reject(Error('control_response_timeout '+output));},8000);const onMessage=value=>{clearTimeout(timer);resolve(value);};child.once('message',onMessage);});
 const send=async frame=>{const response=wait();child.send(frame);return response;};
 return{root,child,closed,send,wait};
}
test('actual process IPC prepares the original SQLite writer and reads without a second revision',async t=>{
 const f=await fixture(t),nonce='c'.repeat(64);let reply=await f.send({protocol,type:'hello',nonce,scope});
 assert.equal(reply.type,'hello_ack');assert.deepEqual(reply.scope,scope);assert.match(reply.instance,/^[a-f0-9]{64}$/);
 const common={protocol,type:'request',nonce,instance:reply.instance,scope};
 reply=await f.send({...common,id:1,op:'prepare_initial_plan_writer'});assert.equal(reply.type,'response');assert.equal(reply.result.ok,true);assert.equal(reply.result.profile.schemaVersion,2);
 const db=new DatabaseSync(join(f.root,'state.sqlite'),{readOnly:true});t.after(()=>db.close());const before=db.prepare("SELECT meta_value FROM state_meta WHERE meta_key='revision'").get().meta_value;
 reply=await f.send({...common,id:2,op:'inspect_writer'});assert.equal(reply.result.ok,true);assert.equal(reply.result.profile.floor.schemaVersion,2);assert.equal(db.prepare("SELECT meta_value FROM state_meta WHERE meta_key='revision'").get().meta_value,before);
 reply=await f.send({...common,id:3,op:'migrate_default_dispatch_writer'});assert.equal(reply.result.ok,true);assert.equal(reply.result.transition.toFloor.profile,'ordinary_default_dispatch_writer_v1');
},{timeout:10000});
test('duplicate request IDs cannot replay a successful prepare',async t=>{
 const f=await fixture(t),nonce='d'.repeat(64),hello=await f.send({protocol,type:'hello',nonce,scope}),frame={protocol,type:'request',nonce,instance:hello.instance,scope,id:1,op:'prepare_initial_plan_writer'};
 const first=await f.send(frame);assert.equal(first.result.ok,true);const replay=await f.send(frame);assert.equal(replay.type,'fault');assert.equal(replay.error.code,'OWNED_CONTROL_PROTOCOL_INVALID');
},{timeout:10000});
test('actual owned prepare refuses a nonempty original legacy database without installing a writer floor',async t=>{
 const f=await fixture(t,{env:{CONTROL_TEST_LEGACY_PROJECT:'1'}}),nonce='7'.repeat(64),hello=await f.send({protocol,type:'hello',nonce,scope});
 const db=new DatabaseSync(join(f.root,'state.sqlite'),{readOnly:true});t.after(()=>db.close());
 const read=()=>db.prepare('SELECT meta_key,meta_value FROM state_meta ORDER BY meta_key').all(),before=read();
 const result=await f.send({protocol,type:'request',nonce,scope,instance:hello.instance,id:1,op:'prepare_initial_plan_writer'});
 assert.deepEqual(result.result,{ok:false,error:'INITIAL_PLAN_FRESH_STORE_REQUIRED'});assert.deepEqual(read(),before);
 assert.equal(db.prepare("SELECT count(*) n FROM state_meta WHERE meta_key='writer_floor_v1'").get().n,0);
 const observed=await f.send({protocol,type:'request',nonce,scope,instance:hello.instance,id:2,op:'inspect_writer'});assert.equal(observed.result.ok,true);
},{timeout:10000});
test('JSON authority, HTTP credential and foreign scope cannot select an administrative command',async t=>{
 for(const extra of [{requestSource:'user'},{profile:'ordinary_default_dispatch_writer_v1'},{'x-kswarm-mutation-token':'main-only'}]){
  const f=await fixture(t),nonce='e'.repeat(64),hello=await f.send({protocol,type:'hello',nonce,scope});const bad=await f.send({protocol,type:'request',nonce,instance:hello.instance,scope,id:1,op:'prepare_initial_plan_writer',...extra});assert.equal(bad.type,'fault');
 }
 const f=await fixture(t),nonce='f'.repeat(64);assert.equal((await f.send({protocol,type:'hello',nonce,scope:{...scope,workspaceId:'c'.repeat(64)}})).type,'fault');
},{timeout:20000});
test('unknown command, foreign boot instance, reordered sequence and repeated hello are closed faults',async t=>{
 for(const kind of ['unknown','instance','sequence','hello']){
  const f=await fixture(t),nonce='1'.repeat(64),hello=await f.send({protocol,type:'hello',nonce,scope}),frame={protocol,type:'request',nonce,instance:hello.instance,scope,id:1,op:'inspect_writer'};
  if(kind==='unknown')frame.op='execute_sql';if(kind==='instance')frame.instance='2'.repeat(64);if(kind==='sequence')frame.id=2;
  const bad=await f.send(kind==='hello'?{protocol,type:'hello',nonce,scope}:frame);assert.equal(bad.type,'fault',kind);
 }
},{timeout:20000});
test('an ordinary child without an actual IPC descriptor cannot install configuration authority',async t=>{
 const f=await fixture(t,{ipc:false});const result=await f.closed;assert.equal(result.code,0);
},{timeout:10000});

test('actual Server configuration remains IPC-only and a legacy raw read still makes migration unavailable',async t=>{
 const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
 const f=await fixture(t,{entry:'src/server/index.js',env:{KSWARM_PORT:String(port),BROKER_URL:'http://127.0.0.1:9',KSWARM_DESKTOP_PROFILE_ID:scope.profileId,KSWARM_DESKTOP_WORKSPACE_ID:scope.workspaceId,KSWARM_DESKTOP_MUTATION_TOKEN:'controlled-legacy-token'}});
 const base='http://127.0.0.1:'+port;let ready=false;
 for(let n=0;n<200;n++){try{if((await fetch(base+'/health')).ok){ready=true;break;}}catch{}if(f.child.exitCode!==null)break;await new Promise(resolve=>setTimeout(resolve,25));}assert.equal(ready,true);
 const nonce='8'.repeat(64),hello=await f.send({protocol,type:'hello',nonce,scope}),common={protocol,type:'request',nonce,scope,instance:hello.instance};
 const observation=await f.send({...common,id:1,op:'inspect_writer'});assert.equal(observation.result.ok,true);
 const prepared=await f.send({...common,id:2,op:'prepare_initial_plan_writer'});assert.equal(prepared.result.ok,true,JSON.stringify(prepared));assert.equal(prepared.result.profile.schemaVersion,2);
 const before=new DatabaseSync(join(f.root,'kswarm','state.sqlite'),{readOnly:true});t.after(()=>before.close());const read=()=>before.prepare('SELECT meta_key,meta_value FROM state_meta ORDER BY meta_key').all();const raw=read();
 assert.equal((await fetch(base+'/projects/missing/workflows')).status,404);
 const denied=await f.send({...common,id:3,op:'migrate_default_dispatch_writer'});assert.equal(denied.result.ok,false);assert.match(denied.result.error,/RECONCILIATION_REQUIRED/);assert.deepEqual(read(),raw);
 const http=await fetch(base+'/desktop/migrate-default-dispatch-writer',{method:'POST',headers:{'content-type':'application/json','x-kswarm-mutation-token':'controlled-legacy-token'},body:JSON.stringify({requestSource:'user',scope})});assert.notEqual(http.status,200);assert.deepEqual(read(),raw);
},{timeout:15000});
test('actual Server agent profile updates leave an otherwise empty original native writer eligible for fresh preparation',async t=>{
 const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
 const f=await fixture(t,{entry:'src/server/index.js',env:{KSWARM_PORT:String(port),BROKER_URL:'http://127.0.0.1:9',KSWARM_DESKTOP_PROFILE_ID:scope.profileId,KSWARM_DESKTOP_WORKSPACE_ID:scope.workspaceId,KSWARM_DESKTOP_MUTATION_TOKEN:'fixture-native-seed'}}),base='http://127.0.0.1:'+port;
 let ready=false;for(let n=0;n<200;n++){try{if((await fetch(base+'/health')).ok){ready=true;break;}}catch{}if(f.child.exitCode!==null)break;await new Promise(resolve=>setTimeout(resolve,25));}assert.equal(ready,true);
 for(const id of ['xiaok-po','xiaok-worker']){const response=await fetch(base+'/agents/'+id,{method:'PUT',headers:{'content-type':'application/json','x-kswarm-mutation-token':'fixture-native-seed'},body:JSON.stringify({name:'Original '+id})});assert.equal(response.ok,true,await response.text());}
 const nonce='6'.repeat(64),hello=await f.send({protocol,type:'hello',nonce,scope}),reply=await f.send({protocol,type:'request',nonce,scope,instance:hello.instance,id:1,op:'prepare_initial_plan_writer'});assert.equal(reply.result.ok,true,JSON.stringify(reply));
},{timeout:15000});

test('actual Server configuration commit failure retains its remote cause and uses the original exit-75 fail-stop',async t=>{
 const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
 const f=await fixture(t,{entry:'src/server/index.js',env:{KSWARM_PORT:String(port),BROKER_URL:'http://127.0.0.1:9',KSWARM_DESKTOP_PROFILE_ID:scope.profileId,KSWARM_DESKTOP_WORKSPACE_ID:scope.workspaceId}});
 let ready=false;for(let n=0;n<200;n++){try{if((await fetch('http://127.0.0.1:'+port+'/health')).ok){ready=true;break;}}catch{}if(f.child.exitCode!==null)break;await new Promise(resolve=>setTimeout(resolve,25));}assert.equal(ready,true);
 const nonce='9'.repeat(64),hello=await f.send({protocol,type:'hello',nonce,scope}),db=new DatabaseSync(join(f.root,'kswarm','state.sqlite'));
 let response;try{db.exec('BEGIN IMMEDIATE');response=await f.send({protocol,type:'request',nonce,scope,instance:hello.instance,id:1,op:'prepare_initial_plan_writer'});}finally{try{db.exec('ROLLBACK');}finally{db.close();}}
 assert.equal(response.type,'response');assert.equal(response.error.name,'PersistenceCommitError');assert.equal(response.error.durableCommitted,false);assert.ok(response.error.cause);
 const result=await f.closed;assert.equal(result.code,75);
},{timeout:15000});
