import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHub} from '../src/core/hub.js';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import net from 'node:net';
import {WebSocket} from 'ws';
import {createServer} from '../../intent-broker/src/http/server.js';
import {createBrokerService} from '../../intent-broker/src/broker/service.js';
const protocol='kswarm_owned_desktop_control_v1',scope={profileId:'a'.repeat(64),workspaceId:'b'.repeat(64)};
test('actual Server no-op startup, connected Broker, WS reads and a default watchdog tick preserve empty-owner migration',async t=>{
 const root=mkdtempSync(join(tmpdir(),'server-observation-process-')),broker=createBrokerService({dbPath:join(root,'broker.sqlite')}),brokerServer=createServer({broker,roomService:broker.room,roomDesktopToken:'test-reader',roomKSwarmToken:'test-owner'});broker.attachWebSocket(brokerServer.raw());await brokerServer.listen(0,'127.0.0.1');
 const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
 const child=spawn(process.execPath,['src/server/index.js'],{cwd:process.cwd(),env:{...process.env,HOME:root,USERPROFILE:root,KSWARM_DATA_ROOT:join(root,'kswarm'),KSWARM_PORT:String(port),BROKER_URL:'http://127.0.0.1:'+brokerServer.address().port,INTENT_BROKER_KSWARM_TOKEN:'test-owner',KSWARM_DESKTOP_PROFILE_ID:scope.profileId,KSWARM_DESKTOP_WORKSPACE_ID:scope.workspaceId,KSWARM_DESKTOP_MUTATION_TOKEN:'test-main'},stdio:['ignore','pipe','pipe','ipc']});let output='';child.stderr.on('data',chunk=>{output+=chunk;});child.stdout.on('data',()=>{});
 const closed=new Promise(resolve=>child.once('exit',(code,signal)=>{console.log(JSON.stringify({test:'actualServer-observer',pid:child.pid,code,signal,reaped:true}));resolve();}));
 t.after(async()=>{if(child.exitCode===null){child.kill('SIGTERM');const kill=setTimeout(()=>child.kill('SIGKILL'),5000);try{await closed;}finally{clearTimeout(kill);}}await brokerServer.close();broker.close();rmSync(root,{recursive:true,force:true,maxRetries:5});});
 const base='http://127.0.0.1:'+port,get=async path=>{const response=await fetch(base+path,{headers:{'x-kswarm-mutation-token':'test-main'}});return{status:response.status,body:await response.json()};};
 let health;for(let n=0;n<200;n++){try{const result=await get('/health');if(result.status===200&&result.body.brokerConnected){health=result.body;break;}}catch{}if(child.exitCode!==null)break;await new Promise(resolve=>setTimeout(resolve,25));}assert.ok(health,'normal Server and real Broker must be ready '+output);assert.equal(typeof health.background?.watchdog?.checks,'number');
 const ws=new WebSocket('ws://127.0.0.1:'+port);const init=await new Promise((resolve,reject)=>{ws.once('message',value=>resolve(JSON.parse(String(value))));ws.once('error',reject);});assert.equal(init.type,'init');assert.deepEqual(init.projects,[]);const socketClosed=new Promise(resolve=>ws.once('close',resolve));ws.close();await socketClosed;
 assert.deepEqual((await get('/projects')).body.projects,[]);assert.equal((await get('/projects/missing')).status,404);assert.equal((await get('/desktop/project-protocol')).status,200);
 // No test-only timer override: wait until the original default 60s owner has really checked.
 for(let n=0;n<320;n++){health=(await get('/health')).body;if(health.background.watchdog.checks>=1&&health.background.recovery.completedAt>0)break;await new Promise(resolve=>setTimeout(resolve,200));}assert.ok(health.background.watchdog.checks>=1);assert.ok(health.background.recovery.completedAt>0);assert.equal(health.brokerConnected,true);
 const send=frame=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.off('message',onMessage);reject(Error('control timeout'));},5000);const onMessage=value=>{clearTimeout(timer);resolve(value);};child.once('message',onMessage);child.send(frame);});
 const nonce='6'.repeat(64),hello=await send({protocol,type:'hello',nonce,scope}),common={protocol,type:'request',nonce,scope,instance:hello.instance};assert.equal((await send({...common,id:1,op:'prepare_initial_plan_writer'})).result.ok,true);const migrated=await send({...common,id:2,op:'migrate_default_dispatch_writer'});assert.equal(migrated.result.ok,true,JSON.stringify(migrated));assert.equal(migrated.result.transition.toFloor.schemaVersion,4);assert.equal((await send({...common,id:3,op:'inspect_writer'})).result.profile.floor.schemaVersion,4);assert.equal(existsSync(join(root,'kswarm','projects','missing')),false);
},{timeout:90000});

test('actual nonempty GET detail and nested artifact helpers neither mkdir nor rewrite the original native rows',async t=>{
 const root=mkdtempSync(join(tmpdir(),'server-detail-observation-')),filePath=join(root,'kswarm','state.sqlite'),missing=join(root,'missing-workspace'),seed=createHub({silent:true,dataDir:{backend:'sqlite',filePath}});
 await seed.createProject({id:'p',name:'P',goal:'G',poAgent:'po',members:[],autoAssignPo:false});seed.mutateProjectState('p',()=>{seed.getProject('p').workFolder=missing;});seed.closePersistence();assert.equal(existsSync(missing),false);
 const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
 const child=spawn(process.execPath,['src/server/index.js'],{env:{...process.env,HOME:root,USERPROFILE:root,KSWARM_DATA_ROOT:join(root,'kswarm'),KSWARM_PORT:String(port),BROKER_URL:'http://127.0.0.1:9'},stdio:['ignore','pipe','pipe']});let output='';child.stderr.on('data',chunk=>{output+=chunk;});child.stdout.on('data',()=>{});const closed=new Promise(resolve=>child.once('exit',(code,signal)=>{console.log(JSON.stringify({test:'actualServer-detail',pid:child.pid,code,signal,reaped:true}));resolve();}));
 t.after(async()=>{if(child.exitCode===null){child.kill('SIGTERM');const kill=setTimeout(()=>child.kill('SIGKILL'),5000);try{await closed;}finally{clearTimeout(kill);}}rmSync(root,{recursive:true,force:true,maxRetries:5});});const base='http://127.0.0.1:'+port;let ready=false;for(let n=0;n<200;n++){try{if((await fetch(base+'/health')).ok){ready=true;break;}}catch{}if(child.exitCode!==null)break;await new Promise(resolve=>setTimeout(resolve,25));}assert.equal(ready,true,output);
 const db=new DatabaseSync(filePath,{readOnly:true}),read=()=>({rows:db.prepare('SELECT collection,entity_key,project_id,state_json FROM state_entities ORDER BY collection,entity_key').all(),history:db.prepare('SELECT * FROM state_entity_history ORDER BY rowid').all(),meta:db.prepare('SELECT * FROM state_meta ORDER BY meta_key').all()});try{const before=read();for(let n=0;n<2;n++){const response=await fetch(base+'/projects/p'),body=await response.json();assert.equal(response.status,200,JSON.stringify(body));assert.equal(body.workspace.path,missing);assert.deepEqual(body.workspace.artifacts,[]);assert.equal(existsSync(missing),false);}assert.deepEqual(read(),before);}finally{db.close();}
},{timeout:15000});
