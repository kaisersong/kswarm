import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHub} from '../src/core/hub.js';
import {createSqlitePersistence} from '../src/core/sqlite-persistence.js';

const input={id:'p',name:'Ordinary',goal:'g',poAgent:'po',members:[],requestedStartPolicy:'plan_only'};
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'kswarm-protocol-create-'));
 const dataDir={backend:'sqlite',filePath:join(root,'state.sqlite')};
 let hub=createHub({silent:true,dataDir});
 t.after(()=>{hub.closePersistence();rmSync(root,{recursive:true,force:true});});
 return {get hub(){return hub;},reopen(){hub.closePersistence();hub=createHub({silent:true,dataDir});return hub;}};
}
test('ordinary create atomically persists protected binding and exact create receipt',t=>{
 const f=fixture(t);f.hub.createProject(input);
 const before=f.hub.getProjectProtocolBinding('p');
 assert.equal(before.classification,'ordinary');assert.equal(before.binding.projectId,'p');
 assert.equal(before.binding.canonicalCreateDigest,before.createReceipt.canonicalCreateDigest);
 assert.equal(before.createReceipt.snapshot.requestedStartPolicy,'plan_only');
 assert.deepEqual(f.reopen().getProjectProtocolBinding('p'),before);
});
test('permanent protected creation evidence contains hashes and identity, not project body or paths',t=>{
 const f=fixture(t);f.hub.createProject({...input,name:'sensitive project title',goal:'private source body',requirements:'private requirements',planningGuidance:'private planning notes'});
 const proof=JSON.stringify(f.hub.getProjectProtocolBinding('p'));
 for(const body of ['sensitive project title','private source body','private requirements','private planning notes'])assert.equal(proof.includes(body),false);
 assert.match(f.hub.getProjectProtocolBinding('p').createReceipt.snapshot.creationPayloadHash,/^[a-f0-9]{64}$/);
});
test('mutable project protocol fields never reclassify protected binding',t=>{
 const f=fixture(t);const p=f.hub.createProject(input);
 p.requiredProtocol='dsh_v1';p.projectProtocolBinding={protocol:'dsh_v1'};
 assert.equal(f.hub.getProjectProtocolBinding('p').classification,'ordinary');
 const view=f.hub.getProjectProtocolBinding('p');view.binding.protocol='dsh_v1';
 assert.equal(f.hub.getProjectProtocolBinding('p').binding.protocol,'ordinary_v1');
});
test('legacy state without authenticated create evidence stays unknown on restore',()=>{
 const hub=createHub({silent:true,persistence:{load:()=>({projects:[{...input,status:'created'}]}),save(){}}});
 assert.equal(hub.getProjectProtocolBinding('p').classification,'unknown');
 assert.equal(hub.getProjectProtocolBinding('missing').classification,'unknown');
});
test('failed create commit exposes neither project nor binding and never starts PO',()=>{
 let sent=0;
 const hub=createHub({silent:true,bridge:{send(){sent++;}},persistence:{load:()=>null,save(){throw new Error('injected commit fault');}}});
 assert.throws(()=>hub.createProject(input),/injected commit fault/);
 assert.equal(hub.getProject('p'),undefined);assert.equal(hub.getProjectProtocolBinding('p').classification,'unknown');
 assert.equal(sent,0);
});
test('PO transport is invoked after committed project, binding, and receipt exist',()=>{
 let durable;let sent=0;
 const hub=createHub({silent:true,persistence:{load:()=>null,save(build){durable=structuredClone(build().full());}},
  bridge:{send(){sent++;assert.equal(durable.projects[0].id,'p');assert.equal(durable.protocolReceipts.length,2);}}});
 hub.createProject(input);assert.equal(sent,1);
});
test('same project ID cannot replace immutable create identity',t=>{
 const f=fixture(t);f.hub.createProject(input);
 const before=f.hub.getProjectProtocolBinding('p');
 assert.throws(()=>f.hub.createProject({...input,goal:'replacement'}),/project_already_exists/);
 assert.equal(f.hub.getProject('p').goal,'g');assert.deepEqual(f.reopen().getProjectProtocolBinding('p'),before);
});
test('omitting projects on later saves retains protected creation evidence',t=>{
 const f=fixture(t);f.hub.createProject(input);const before=f.hub.getProjectProtocolBinding('p');
 f.hub.deleteProject('p',{requestSource:'user'});assert.deepEqual(f.reopen().getProjectProtocolBinding('p'),before);
});
test('a failed asynchronous Room create cannot roll back another committed create audit',async()=>{
 let release;const wait=new Promise(resolve=>{release=resolve;});
 const hub=createHub({silent:true,persistence:{load:()=>null,save(build){const payload=build();if(payload.scope.projectId==='p')throw new Error('room commit fault');}},
  brokerClient:{async getRoomSnapshot(){await wait;return {ok:true,room:{status:'active'},members:[{status:'active',subject:{kind:'agent',logicalAgentId:'po'}}]};},
   async acquireRoomMembershipLease(){return {ok:true};}}});
 const pending=hub.createProject({...input,primaryRoomId:'room'}, {requestSource:'user'});
 hub.createProject({...input,id:'other'});release();
 await assert.rejects(pending,/room commit fault/);
 assert.equal(hub.getProject('other').id,'other');
 assert.equal(hub.getHumanActions('other').filter(a=>a.action==='create_project').length,1);
 assert.equal(hub.getProjectProtocolBinding('other').classification,'ordinary');
});
test('persistence becoming unhealthy during Room validation cannot expose a staged project',async()=>{
 let release;let failed=false;const wait=new Promise(resolve=>{release=resolve;});
 const hub=createHub({silent:true,persistence:{load:()=>null,save(){},getHealth:()=>({status:failed?'failed':'ok'})},
  brokerClient:{async getRoomSnapshot(){await wait;return {ok:true,room:{status:'active'},members:[{status:'active',subject:{kind:'agent',logicalAgentId:'po'}}]};},async acquireRoomMembershipLease(){return {ok:true};}}});
 const pending=hub.createProject({...input,primaryRoomId:'room'},{requestSource:'user'});failed=true;release();
 await assert.rejects(pending,/failed state/);
 assert.equal(hub.getProject('p'),undefined);assert.equal(hub.getProjectProtocolBinding('p').classification,'unknown');
 assert.equal(hub.getHumanActions('p').length,0);
});
test('post-commit PO delivery failure cannot turn committed creation into a failed result',()=>{
 let durable;let sends=0;
 const hub=createHub({silent:true,persistence:{load:()=>null,save(build){durable=structuredClone(build().full());}},
  bridge:{send(){sends++;throw Error('delivery response lost');}}});
 const project=hub.createProject(input);
 assert.equal(project.id,'p');assert.equal(durable.projects[0].id,'p');assert.equal(sends,1);
 assert.equal(hub.getProjectProtocolBinding('p').classification,'ordinary');
});
test('Room validation and create commit expose no microtask window to a FULL save',async()=>{
 let leaked=false;let done=false;
 const hub=createHub({silent:true,persistence:{load:()=>null,save(build,scope){
  if(scope.type==='project'&&scope.projectId==='p')throw new Error('create commit fault');
  const saved=build().full();if(saved.projects.some(p=>p.id==='p'))leaked=true;
 }},brokerClient:{async getRoomSnapshot(){return {ok:true,room:{status:'active'},members:[{status:'active',subject:{kind:'agent',logicalAgentId:'po'}}]};},async acquireRoomMembershipLease(){return {ok:true};}}});
 const observe=()=>{if(done)return;if(hub.getProject('p'))hub.persistState();queueMicrotask(observe);};
 queueMicrotask(observe);
 try{await assert.rejects(hub.createProject({...input,primaryRoomId:'room'},{requestSource:'user'}),/create commit fault/);}finally{done=true;}
 assert.equal(leaked,false);assert.equal(hub.getProject('p'),undefined);
});
test('post-commit bookkeeping failure preserves committed project and receipt and fails health closed',t=>{
 const root=mkdtempSync(join(tmpdir(),'kswarm-post-commit-'));const filePath=join(root,'state.sqlite');
 const store=createSqlitePersistence({filePath});let committed=false;
 const hub=createHub({silent:true,persistence:{load:()=>store.load(),save(...args){store.save(...args);committed=true;},getHealth:()=>store.getHealth(),close:()=>store.close()}});
 t.after(()=>{hub.closePersistence();rmSync(root,{recursive:true,force:true});});
 const original=globalThis.structuredClone;
 try{
  globalThis.structuredClone=(...args)=>{if(committed)throw Error('injected post-commit clone fault');return original(...args);};
  assert.throws(()=>hub.createProject(input),error=>error.durableCommitted===true && error.code==='persistence_post_commit_failure');
 }finally{globalThis.structuredClone=original;}
 try{
  assert.equal(hub.getProject('p').id,'p');assert.equal(hub.getProjectProtocolBinding('p').classification,'ordinary');
  assert.equal(hub.getPersistenceHealth().status,'failed');
  assert.throws(()=>hub.createProject({...input,id:'other'}),/failed state/);
  hub.closePersistence();const reopened=createHub({silent:true,dataDir:{backend:'sqlite',filePath}});
  try{assert.equal(reopened.getProject('p').id,'p');assert.equal(reopened.getProjectProtocolBinding('p').classification,'ordinary');}finally{reopened.closePersistence();}
 }finally{hub.closePersistence();rmSync(root,{recursive:true,force:true});}
});

test('Main-owned create never invokes the legacy PO bridge and legacy retry cannot mutate it',async t=>{
 const {createProjectInputAuthority}=await import('../src/core/project-input-authority.js');
 const root=mkdtempSync(join(tmpdir(),'main-owned-create-'));let sent=0;
 const hub=createHub({silent:true,dataDir:{backend:'sqlite',filePath:join(root,'state.sqlite')},bridge:{send(){sent++;}}});
 t.after(()=>{hub.closePersistence();rmSync(root,{recursive:true,force:true});});
 const authority=createProjectInputAuthority({profileId:'a'.repeat(64),workspaceId:'b'.repeat(64)});
 const project=hub.createProject(input,{projectInputAuthority:authority.creator('main-create')});
 assert.equal(sent,0);const before=structuredClone(project);
 assert.deepEqual(hub.handleRetryPlan(project.id),{ok:false,error:'INITIAL_PLAN_MAIN_RECOVERY_REQUIRED'});
 assert.deepEqual(project,before);assert.equal(sent,0);
});
