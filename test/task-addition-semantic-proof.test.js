import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createHub} from '../src/core/hub.js';
import {readTaskAdditionSemanticSnapshot,readCanonicalTaskAdditionSemantic} from '../src/core/initial-plan-semantic-schema.js';
const api=await import('../src/core/initial-plan-task-additive-proof.js').catch(()=>({}));
const hash=value=>createHash('sha256').update(value,'utf8').digest('hex');
function fixture(t,{bodyMap=false}={}){
 const root=mkdtempSync(join(tmpdir(),'task-proof-v2-')),filePath=join(root,'state.sqlite'),hub=createHub({silent:true,dataDir:{backend:'sqlite',filePath}});
 t.after(()=>{hub.closePersistence();rmSync(root,{recursive:true,force:true});});
 hub.createProject({id:'p',name:'Original project',goal:'Read original state',poAgent:'po',members:['writer','reviewer'],autoAssignPo:false,requestedStartPolicy:'plan_only'});
 if(bodyMap){hub.getProject('p').ordinaryInputBodies={};hub.persistState();}
 const snapshot=()=>structuredClone({project:hub.getProject('p'),tasks:hub.getBoard('p').getAllTasks(),related:{workflowRuns:[],workflowProposals:[],finalDeliverables:[],reviewGateDecisions:[],reviewConditions:[]}});
 const add=(index,previousProofDigest=null,taskOverrides={})=>{
  const before=snapshot(),operationId='ordinary-input:'+hash('operation-'+index),body='Original user task '+index;
  assert.equal(hub.handleHumanAddTasks('p',[{id:'task-'+index,title:'Original task '+index,brief:'Actual original factory body',...taskOverrides}],{requestSource:'user'}).ok,true);
  const project=hub.getProject('p');project.ordinaryInputRevision=(project.ordinaryInputRevision??0)+1;project.ordinaryInputBodies={...project.ordinaryInputBodies,[operationId]:body};hub.persistState();
  const after=snapshot();return{before,after,projectId:'p',operationId,expectedBodyHash:hash(body),addedTaskIds:after.tasks.slice(before.tasks.length).map(task=>task.id),policyDelta:[],ordinal:index,previousProofDigest};
 };
 return{hub,snapshot,add};
}
function prove(input){assert.equal(typeof api.proveTaskAdditionTransition,'function');return api.proveTaskAdditionTransition(input);}
for(const bodyMap of [false,true])test(`actual original SQLite/factory transition roundtrips body-map presence=${bodyMap}`,t=>{
 const f=fixture(t,{bodyMap}),input=f.add(1),proof=prove(input),after=readTaskAdditionSemanticSnapshot(input.after);
 assert.equal(proof.controlBefore.bodyMapPresent,bodyMap);assert.equal(proof.bodyHash,input.expectedBodyHash);assert.equal(JSON.stringify(proof).includes('Actual original factory body'),false);assert.equal(JSON.stringify(proof).includes('Original user task'),false);
 const reversed=api.reverseTaskAdditionProof(after.semantic,proof);assert.equal(reversed.digest,readTaskAdditionSemanticSnapshot(input.before).digest);assert.equal(Object.hasOwn(reversed.semantic.project,'ordinaryInputBodies'),bodyMap);
});
test('two original factory additions reverse through an exact continuous digest chain',t=>{
 const f=fixture(t),one=f.add(1),first=prove(one),two=f.add(2,api.taskAdditionProofDigest(first)),second=prove(two);
 const result=api.verifyTaskAdditionProofChain({current:readTaskAdditionSemanticSnapshot(two.after).semantic,bornDigest:readTaskAdditionSemanticSnapshot(one.before).digest,proofs:[first,second]});
 assert.equal(result.digest,readTaskAdditionSemanticSnapshot(one.before).digest);
 for(const proofs of [[second],[first,first],[second,first],[first,{...second,previousProofDigest:'a'.repeat(64)}]])assert.throws(()=>api.verifyTaskAdditionProofChain({current:readTaskAdditionSemanticSnapshot(two.after).semantic,bornDigest:result.digest,proofs}),/TASK_ADDITIVE_PROOF/);
});
for(const change of ['old-task','old-control','body','order','empty'])test(`transition rejects ${change} before producing a semantic proof`,t=>{
 const f=fixture(t),first=prove(f.add(1)),input=f.add(2,api.taskAdditionProofDigest(first));prove(input);
 if(change==='old-task')input.after.tasks[0].brief='Changed old task';
 if(change==='old-control')input.after.project.goal='Changed old goal';
 if(change==='body')input.after.project.ordinaryInputBodies[input.operationId]='Forged body';
 if(change==='order')input.after.tasks.reverse();
 if(change==='empty')input.addedTaskIds=[];
 assert.equal(typeof api.proveTaskAdditionTransition,'function');assert.throws(()=>api.proveTaskAdditionTransition(input),/TASK_ADDITIVE_PROOF|INITIAL_PLAN_SEMANTIC_SCHEMA/);
});
test('reverse requires the exact original new rows and controls, without accepting a supplied after digest',t=>{
 const f=fixture(t),input=f.add(1),proof=prove(input),current=readTaskAdditionSemanticSnapshot(input.after).semantic;
 for(const mutate of [value=>{value.tasks[0].brief='changed';},value=>{delete value.project.ordinaryInputBodies[input.operationId];},value=>{value.project.projectRevision++;}]){const value=structuredClone(current);mutate(value);assert.throws(()=>api.reverseTaskAdditionProof(value,proof),/TASK_ADDITIVE_PROOF|INITIAL_PLAN_SEMANTIC_SCHEMA/);}
});

test('a genuine original normalized new target policy reverses without changing old policy keys',t=>{
 const f=fixture(t),first=prove(f.add(1)),input=f.add(2,api.taskAdditionProofDigest(first),{dependencies:['p__task-1'],dependencyPolicy:{'p__task-1':'verified_pass'}});
 input.policyDelta=[['p__task-1','verified_pass']];const proof=prove(input),current=readTaskAdditionSemanticSnapshot(input.after);
 assert.deepEqual(proof.policyDelta,[['p__task-1','verified_pass']]);assert.equal(api.reverseTaskAdditionProof(current.semantic,proof).digest,readTaskAdditionSemanticSnapshot(input.before).digest);
 const changed=structuredClone(input);changed.after.project.dependencyPolicies['p__task-1']='completed';assert.throws(()=>prove(changed),/TASK_ADDITIVE_PROOF/);
});
test('the whole proof invocation rejects hooks and an overlong chain before reading any getter',t=>{
 const f=fixture(t),input=f.add(1),proof=prove(input),current=readTaskAdditionSemanticSnapshot(input.after).semantic;let hooks=0;
 const hostile={...proof};Object.defineProperty(hostile,'bodyHash',{enumerable:true,get(){hooks++;return proof.bodyHash;}});
 assert.throws(()=>api.reverseTaskAdditionProof(current,hostile),/INITIAL_PLAN_SEMANTIC_SCHEMA/);assert.equal(hooks,0);
 assert.throws(()=>api.verifyTaskAdditionProofChain({current,bornDigest:proof.beforeDigest,proofs:Array(201).fill(proof)}),/INITIAL_PLAN_SEMANTIC_SCHEMA/);
 const huge={...input,expectedBodyHash:'a'.repeat(8388609)};assert.throws(()=>prove(huge),/INITIAL_PLAN_SEMANTIC_SCHEMA/);
});
test('the complete 200-step chain from the actual original SQLite factory verifies without skipping a middle record',t=>{
 const f=fixture(t),proofs=[];let input,previous=null,bornDigest;
 for(let index=1;index<=200;index++){
  input=f.add(index,previous);const proof=prove(input);if(index===1)bornDigest=proof.beforeDigest;
  proofs.push(proof);previous=api.taskAdditionProofDigest(proof);
 }
 const current=readTaskAdditionSemanticSnapshot(input.after).semantic;
 assert.equal(api.verifyTaskAdditionProofChain({current,bornDigest,proofs}).digest,bornDigest);
 const missing=[...proofs];missing.splice(99,1);assert.throws(()=>api.verifyTaskAdditionProofChain({current,bornDigest,proofs:missing}),/TASK_ADDITIVE_PROOF/);
});

for(const kind of ['input-revision','status','empty-body','unrelated-policy'])test(`reverse must recheck the forward predicate for ${kind} with the genuine born digest`,t=>{
 const f=fixture(t),input=f.add(1),proof=prove(input),current=readTaskAdditionSemanticSnapshot(input.after).semantic;
 if(kind==='input-revision')current.project.ordinaryInputRevision=7;
 if(kind==='status')current.project.status='created';
 if(kind==='empty-body'){current.project.ordinaryInputBodies[input.operationId]='';proof.bodyHash=hash('');}
 if(kind==='unrelated-policy'){current.project.dependencyPolicies['p__task-1']='verified_pass';proof.policyDelta=[['p__task-1','verified_pass']];}
 proof.afterDigest=readCanonicalTaskAdditionSemantic(current).digest;
 // Keep the real original born digest; a hash-consistent inverse is insufficient.
 assert.equal(proof.beforeDigest,readTaskAdditionSemanticSnapshot(input.before).digest);
 assert.throws(()=>api.reverseTaskAdditionProof(current,proof),/TASK_ADDITIVE_PROOF/);
 assert.throws(()=>api.verifyTaskAdditionProofChain({current,bornDigest:proof.beforeDigest,proofs:[proof]}),/TASK_ADDITIVE_PROOF/);
});
test('the complete encoded transition budget rejects escaped valid data exceeding 8MiB',t=>{
 const f=fixture(t);f.hub.getProject('p').requirements='\\'.repeat(2200000);f.hub.persistState();const input=f.add(1);
 assert.ok(Buffer.byteLength(JSON.stringify(input),'utf8')>8388608);
 // Each independent snapshot remains valid and below its own encoded limit.
 readTaskAdditionSemanticSnapshot(input.before);readTaskAdditionSemanticSnapshot(input.after);
 assert.throws(()=>prove(input),/INITIAL_PLAN_SEMANTIC_SCHEMA/);
});
for(const target of [Object.prototype,Array.prototype])test(`proof encoded budget rejects inherited ${target===Object.prototype?'object':'array'} serialization hooks without invoking them`,t=>{
 const f=fixture(t),input=f.add(1),previous=Object.getOwnPropertyDescriptor(target,'toJSON');let hooks=0;
 Object.defineProperty(target,'toJSON',{configurable:true,value(){hooks++;return {changed:true};}});
 try{try{api.proveTaskAdditionTransition(input);}catch{/* The exact schema denial is asserted after hook count. */}assert.equal(hooks,0);assert.throws(()=>api.proveTaskAdditionTransition(input),/INITIAL_PLAN_SEMANTIC_SCHEMA/);}finally{if(previous)Object.defineProperty(target,'toJSON',previous);else delete target.toJSON;}
});
