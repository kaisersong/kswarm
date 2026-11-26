import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import net from 'node:net';
import {createHub} from '../src/core/hub.js';
import {createProjectInputAuthority} from '../src/core/project-input-authority.js';
const scope={profileId:'a'.repeat(64),workspaceId:'b'.repeat(64)};
test('original activity HTTP opt-in uses the fixed opaque reader scope while ordinary feeds remain compatible',async()=>{
 const root=mkdtempSync(join(tmpdir(),'scoped-activity-http-')),filePath=join(root,'state.sqlite');
 const hub=createHub({silent:true,dataDir:{backend:'sqlite',filePath},brokerClient:{async getRoomSnapshot(){return{ok:true,room:{status:'active'},members:[{status:'active',subject:{kind:'agent',logicalAgentId:'po'}}]};},async acquireRoomMembershipLease(){return{ok:true};}}});
 try{for(const[id,domain]of [['p',scope],['q',{...scope,workspaceId:'c'.repeat(64)}]])await hub.createProject({id,name:id,goal:'Read only',poAgent:'po',primaryRoomId:'room-'+id,autoAssignPo:false},{requestSource:'user',projectInputAuthority:createProjectInputAuthority(domain).creator('create-'+id)});
  hub.createProject({id:'legacy',name:'Legacy',goal:'ordinary compatibility',poAgent:'po',autoAssignPo:false});
 }finally{hub.closePersistence();}
 const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
 const child=spawn(process.execPath,['src/server/index.js'],{cwd:process.cwd(),env:{...process.env,HOME:root,USERPROFILE:root,KSWARM_DATA_ROOT:root,KSWARM_PORT:String(port),BROKER_URL:'http://127.0.0.1:1',KSWARM_DESKTOP_MUTATION_TOKEN:'scoped-fixture',KSWARM_DESKTOP_PROFILE_ID:scope.profileId,KSWARM_DESKTOP_WORKSPACE_ID:scope.workspaceId},stdio:'ignore'});
 const exited=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>{console.log(JSON.stringify({test:'scoped-activity-own-B-child',pid:child.pid,code,signal,reaped:true}));resolve();});});
 const base='http://127.0.0.1:'+port,headers={'x-kswarm-mutation-token':'scoped-fixture'},profile={...headers,'x-kswarm-activity-profile':'project_delivery_v1'};
 const rows=()=>{const db=new DatabaseSync(filePath,{readOnly:true});try{return db.prepare("SELECT collection,entity_key,state_json FROM state_entities WHERE collection IN ('project','protocolReceipt','protocolHead') ORDER BY collection,entity_key").all();}finally{db.close();}};
 try{
  const deadline=Date.now()+10000;let health;for(;;){try{const response=await fetch(base+'/health',{signal:AbortSignal.timeout(500)});if(response.ok){health=await response.json();break;}}catch{}if(child.exitCode!==null||Date.now()>deadline)throw Error('isolated scoped B failed to start');await new Promise(resolve=>setTimeout(resolve,25));}
  const before=rows();const ordinary=await(await fetch(base+'/projects/p/activity',{headers})).json();
  assert.equal((await fetch(base+'/projects/p/activity',{headers:{'x-kswarm-activity-profile':'project_delivery_v1'}})).status,401);
  const response=await fetch(base+'/projects/p/activity?limit=200',{headers:profile});assert.equal(response.status,200);
  assert.equal(response.headers.get('x-kswarm-source-instance'),health.service.instanceId);assert.equal(response.headers.get('x-kswarm-activity-profile'),'project_delivery_v1');
  const qualified=await response.json();assert.equal(qualified.protocol,'scoped_project_activity_v1');assert.deepEqual(qualified.scope,scope);assert.deepEqual(qualified.page,ordinary);
  const foreign=await fetch(base+'/projects/q/activity',{headers:profile});assert.equal(foreign.status,403);assert.equal((await foreign.json()).error,'PROJECT_SCOPE_MISMATCH');assert.equal(foreign.headers.get('x-kswarm-activity-profile'),null);
  assert.equal((await fetch(base+'/projects/q/activity',{headers})).status,200);
  assert.equal((await fetch(base+'/projects/legacy/activity',{headers})).status,200);assert.equal((await fetch(base+'/projects/legacy/activity',{headers:profile})).status,409);
  assert.equal((await fetch(base+'/projects/p/activity',{headers:{...headers,'x-kswarm-activity-profile':'future'}})).status,400);
  assert.equal((await fetch(base+'/projects/p/activity?limit=201',{headers:profile})).status,400);assert.deepEqual(rows(),before);
  const source={...headers,'x-kswarm-source-read':'project_source_v1'};
  const sourceLocal=await fetch(base+'/projects/p/activity',{headers:source});assert.equal(sourceLocal.status,200);assert.equal(sourceLocal.headers.get('x-kswarm-activity-profile'),'project_delivery_v1');assert.equal((await sourceLocal.json()).protocol,'scoped_project_activity_v1');
  const sourceLegacy=await fetch(base+'/projects/legacy/activity',{headers:source});assert.equal(sourceLegacy.status,200);assert.equal(sourceLegacy.headers.get('x-kswarm-activity-profile'),null);assert.deepEqual((await sourceLegacy.json()).delivery,{status:'unavailable',reasonCode:'SNAPSHOT_INCOMPLETE'});
  assert.equal((await fetch(base+'/projects/q/activity',{headers:source})).status,403);
  assert.equal((await fetch(base+'/projects/p/activity',{headers:{...source,'x-kswarm-activity-profile':'project_delivery_v1'}})).status,400);
  assert.equal((await fetch(base+'/projects/p/activity',{headers:{...headers,'x-kswarm-source-read':'future'}})).status,400);assert.deepEqual(rows(),before);
 }finally{
  if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');const watchdog=setTimeout(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');},2000);
  try{await exited;}finally{clearTimeout(watchdog);rmSync(root,{recursive:true,force:true});}
 }
},{timeout:15000});
