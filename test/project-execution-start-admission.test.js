import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {createProjectInputAuthority} from '../src/core/project-input-authority.js';
import {createHub} from '../src/core/hub.js';
import {protocolDigest,projectProtocolIds} from '../src/core/project-protocol.js';
import {TASK_ADDITIVE_DESCRIPTOR} from '../src/core/initial-plan-acceptance-contract.js';
function fixture(t,descriptor,prepare=()=>({}),corrupt=()=>{}){
 const root=mkdtempSync(join(tmpdir(),'project-start-gate-')),filePath=join(root,'state.sqlite'),sent=[],reserved=[];let hub;
 const bridge={send(message){sent.push(message);},requestTask(message){sent.push({kind:'request_task',...message});}},allocator={reserveWorkerInstance(input){reserved.push(input);return{ok:true,instanceId:'worker-instance'};}};
 const open=()=>createHub({silent:true,bridge,runtimeInstanceAllocator:allocator,dataDir:{backend:'sqlite',filePath},projectStorageRoot:join(root,'physical-projects')});hub=open();
 t.after(()=>{hub.closePersistence();rmSync(root,{recursive:true,force:true});});
 hub.createProject({id:'p',name:'P',goal:'legacy ordinary',poAgent:'po',members:['worker'],autoAssignPo:false});assert.equal(hub.handleCreateTasks('p',[{id:'task',title:'Task',assignedAgent:'worker',dependencies:[]}],'po').ok,true);assert.equal(hub.handleApprove('p').ok,true);const prepared=prepare(hub);hub.persistState({type:'project',projectId:'p'});hub.closePersistence();
 if(descriptor!==undefined||arguments.length>=4){
  // Explicit privileged fixture corruption, not a supported creation/upgrade:
  // prove the original physical producer cannot trust even a self-consistent
  // unknown/future protected binding loaded from disk.
  const db=new DatabaseSync(filePath);try{const ids=projectProtocolIds('p'),read=id=>JSON.parse(db.prepare("SELECT state_json FROM state_entities WHERE collection='protocolReceipt' AND entity_key=?").get(id).state_json),receipt=read(ids.receipt),binding=read(ids.binding),initialPlanning={producer:'desktop_main_v1',canonicalCreateOperationId:'injected-create',planGeneration:1,contract:descriptor};if(descriptor!==undefined){receipt.initialPlanning=initialPlanning;binding.initialPlanning=initialPlanning;}corrupt(receipt,binding);binding.createReceiptDigest=protocolDigest(receipt);
   const update=db.prepare("UPDATE state_entities SET state_json=?,checksum=? WHERE collection='protocolReceipt' AND entity_key=?");
   for(const value of [receipt,binding]){const bytes=JSON.stringify(value);update.run(bytes,createHash('sha256').update(bytes).digest('hex'),value.id);}
  }finally{db.close();}
 }
 sent.length=0;reserved.length=0;hub=open();
 return{root,filePath,prepared,get hub(){return hub;},sent,reserved};
}
test('untouched original ordinary project still reaches original worker reservation and actual handoff',t=>{
 const f=fixture(t);const result=f.hub.handleRequestDispatch('p','po');assert.equal(result.ok,true);assert.equal(result.dispatched.length,1);assert.equal(f.reserved.length,1);const handoff=f.sent.find(row=>row.kind==='request_task');assert.ok(handoff);assert.equal(existsSync(handoff.handoffPath),true);
});
for(const [name,descriptor] of [['v2 candidate-required',TASK_ADDITIVE_DESCRIPTOR],['future reserved',{...TASK_ADDITIVE_DESCRIPTOR,protocol:'ordinary_initial_plan_additive_v999'}],['damaged contract',{}]])test('original dispatch refuses '+name+' before worker reserve, task transition and physical handoff',t=>{
 const f=fixture(t,descriptor);let result,fault;try{result=f.hub.handleRequestDispatch('p','po');}catch(error){fault=error;}
 assert.equal(f.reserved.length,0,'must reject before actual worker reservation');assert.equal(f.sent.length,0,'must reject before actual bridge message');assert.equal(existsSync(join(f.root,'physical-projects','p')),false,'must reject before physical handoff directory');assert.equal(f.hub.getBoard('p').getAllTasks()[0].status,'pending');assert.equal(fault,undefined);assert.equal(result?.ok,false);
});

test('original human approval refuses unsupported binding before active state and plan_approved message',t=>{
 const f=fixture(t,TASK_ADDITIVE_DESCRIPTOR,hub=>{hub.getProject('p').status='planning';return{};});
 const result=f.hub.handleApprove('p');assert.equal(result.ok,false);assert.equal(f.hub.getProject('p').status,'planning');assert.equal(f.sent.length,0);assert.equal(f.reserved.length,0);
});
test('original rework refuses unsupported binding before reopening a completed task or sending a new attempt',t=>{
 const f=fixture(t,TASK_ADDITIVE_DESCRIPTOR,hub=>{const board=hub.getBoard('p'),task=board.getAllTasks()[0];for(const status of ['dispatched','accepted','in_progress','submitted','done'])assert.equal(board.transition(task.id,status,{assignedAgent:'worker',result:{summary:'old actual result'}}).ok,true);return{taskId:task.id};});
 const result=f.hub.handleRework('p',f.prepared.taskId,'new work','po');assert.equal(result.ok,false);assert.equal(f.hub.getBoard('p').getTask(f.prepared.taskId).status,'done');assert.equal(f.sent.length,0);assert.equal(f.reserved.length,0);
});
test('original proposal start refuses unsupported binding before approval, run birth or node dispatch descriptor',t=>{
 const f=fixture(t,TASK_ADDITIVE_DESCRIPTOR,hub=>{const result=hub.createWorkflowProposal('p','agent-review-smoke',{taskId:hub.getBoard('p').getAllTasks()[0].id,now:1770000000000});assert.equal(result.ok,true);return{proposalId:result.workflowProposal.id};});
 const result=f.hub.startWorkflowRunFromProposal(f.prepared.proposalId);assert.equal(result.ok,false);assert.equal(f.hub.listProjectWorkflowRuns('p').length,0);const db=new DatabaseSync(f.filePath,{readOnly:true});try{assert.equal(JSON.parse(db.prepare("SELECT state_json FROM state_entities WHERE collection='workflowProposal' AND entity_key=?").get(f.prepared.proposalId).state_json).approval.status,'pending');}finally{db.close();}assert.equal(f.sent.length,0);assert.equal(f.reserved.length,0);
});

test('fixed protected creation keys and physical ownership cannot become legacy when JSON ownership is damaged',t=>{
 const f=fixture(t,TASK_ADDITIVE_DESCRIPTOR,()=>({}),(receipt,binding)=>{receipt.projectId='q';binding.projectId='q';});
 let result;try{result=f.hub.handleRequestDispatch('p','po');}catch{/* old unsafe final-write rejection does not excuse earlier physical effects */}
 assert.equal(f.reserved.length,0);assert.equal(f.sent.length,0);assert.equal(existsSync(join(f.root,'physical-projects','p')),false);assert.equal(result?.ok,false);
});

for(const [name,scope] of [['null',null],['incomplete',{profileId:'a'.repeat(64)}],['extended',{profileId:'a'.repeat(64),workspaceId:'b'.repeat(64),extra:true}]])test('present '+name+' scope is unknown, never the unscoped old ordinary domain',t=>{
 const f=fixture(t,undefined,()=>({}),(receipt,binding)=>{receipt.scope=scope;binding.scope=scope;});
 const token=createProjectInputAuthority({profileId:'a'.repeat(64),workspaceId:'b'.repeat(64)}).reader();assert.equal(f.hub.readProjectExecutionStart('p',token).ok,false);
 let result;try{result=f.hub.handleRequestDispatch('p','po');}catch{}assert.equal(f.reserved.length,0);assert.equal(f.sent.length,0);assert.equal(result?.ok,false);
});
