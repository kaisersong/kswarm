import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {protocolDigest} from './project-protocol.js';
import {readTaskAdditionSemanticSnapshot,readCanonicalTaskAdditionSemantic,readTaskAdditionTransitionInput,readTaskAdditionSemanticProof,readTaskAdditionReverseInput,readTaskAdditionProofChainInput} from './initial-plan-semantic-schema.js';
const fail=()=>{throw Error('TASK_ADDITIVE_PROOF_INVALID');};
const bodyHash=value=>createHash('sha256').update(value,'utf8').digest('hex');
const present=(object,key)=>Object.hasOwn(object,key)?{present:true,value:object[key]}:{present:false};
const restore=(object,key,previous)=>{if(previous.present)object[key]=previous.value;else delete object[key];};
const same=(left,right)=>{if(!isDeepStrictEqual(left,right))fail();};
function structural(proof){
 if(proof.afterRevision!==proof.beforeRevision+1||proof.addedTaskRows.length===0
   ||new Set(proof.addedTaskRows.map(row=>row.taskId)).size!==proof.addedTaskRows.length
   ||new Set(proof.policyDelta.map(([id])=>id)).size!==proof.policyDelta.length
   ||(proof.ordinal===1?proof.previousProofDigest!==null:proof.previousProofDigest===null))fail();
 return proof;
}
/** Data witness only. The original owner must bind its actual prepared factory
 * rows, source operation, immutable receipts and private frame independently.
 * Valid raw projection shapes never stand in for original ACK provenance. */
export function proveTaskAdditionTransition(value){
 const input=readTaskAdditionTransitionInput(value),before=readTaskAdditionSemanticSnapshot(input.before),after=readTaskAdditionSemanticSnapshot(input.after);
 return proveCanonicalTransition(input,before,after);
}
function proveCanonicalTransition(input,before,after){
 const old=before.semantic,next=after.semantic;
 if(old.project.id!==input.projectId||next.project.id!==input.projectId||input.addedTaskIds.length===0
   ||next.tasks.length!==old.tasks.length+input.addedTaskIds.length||next.project.projectRevision!==old.project.projectRevision+1)fail();
 same(next.tasks.slice(0,old.tasks.length),old.tasks);
 const added=next.tasks.slice(old.tasks.length);same(added.map(task=>task.id),input.addedTaskIds);
 const oldBodies=old.project.ordinaryInputBodies??{},nextBodies=next.project.ordinaryInputBodies;
 if(Object.hasOwn(oldBodies,input.operationId)||!nextBodies||!Object.hasOwn(nextBodies,input.operationId))fail();
 const body=nextBodies[input.operationId];if(!body||Buffer.byteLength(body,'utf8')>65536||bodyHash(body)!==input.expectedBodyHash)fail();
 same(nextBodies,{...oldBodies,[input.operationId]:body});
 const oldIds=new Set(old.tasks.map(task=>task.id)),targets=new Set(added.flatMap(task=>task.dependencies));
 if(Object.keys(old.project.dependencyPolicies).some(id=>!oldIds.has(id)))fail();
 const policies={...old.project.dependencyPolicies};
 for(const [id,policy] of input.policyDelta){if(Object.hasOwn(policies,id)||!targets.has(id))fail();policies[id]=policy;}
 same(next.project.dependencyPolicies,policies);
 const expected={...old.project,status:'planning',projectRevision:old.project.projectRevision+1,
  ordinaryInputRevision:(old.project.ordinaryInputRevision??0)+1,ordinaryInputBodies:nextBodies,dependencyPolicies:policies};
 if(Object.hasOwn(next.project,'updatedAt'))expected.updatedAt=next.project.updatedAt;
 same(next.project,expected);same(next.related,old.related);
 return structural(readTaskAdditionSemanticProof({kind:'ordinary_task_addition_semantic_proof',schemaVersion:2,
  projectId:input.projectId,operationId:input.operationId,ordinal:input.ordinal,previousProofDigest:input.previousProofDigest,
  bodyHash:input.expectedBodyHash,beforeRevision:before.projectRevision,afterRevision:after.projectRevision,beforeDigest:before.digest,afterDigest:after.digest,
  addedTaskRows:added.map(task=>({taskId:task.id,rowDigest:protocolDigest(task)})),policyDelta:input.policyDelta,
  controlBefore:{status:old.project.status,bodyMapPresent:Object.hasOwn(old.project,'ordinaryInputBodies'),ordinaryInputRevision:present(old.project,'ordinaryInputRevision'),updatedAt:present(old.project,'updatedAt')},
 }));
}
export function taskAdditionProofDigest(value){return protocolDigest(['ordinary-task-addition-semantic-proof-v2',structural(readTaskAdditionSemanticProof(value))]);}
export function reverseTaskAdditionProof(current,proofValue){
 const input=readTaskAdditionReverseInput({current,proof:proofValue}),proof=structural(input.proof),now=readCanonicalTaskAdditionSemantic(input.current);
 if(now.semantic.project.id!==proof.projectId||now.projectRevision!==proof.afterRevision||now.digest!==proof.afterDigest||now.semantic.tasks.length<proof.addedTaskRows.length)fail();
 const previous=structuredClone(now.semantic),project=previous.project,count=proof.addedTaskRows.length;
 const added=previous.tasks.slice(-count);same(added.map(task=>({taskId:task.id,rowDigest:protocolDigest(task)})),proof.addedTaskRows);
 previous.tasks.splice(-count);
 const body=project.ordinaryInputBodies?.[proof.operationId];if(typeof body!=='string'||bodyHash(body)!==proof.bodyHash)fail();
 delete project.ordinaryInputBodies[proof.operationId];
 if(!proof.controlBefore.bodyMapPresent){if(Object.keys(project.ordinaryInputBodies).length)fail();delete project.ordinaryInputBodies;}
 for(const [id,policy] of proof.policyDelta){if(!Object.hasOwn(project.dependencyPolicies,id)||project.dependencyPolicies[id]!==policy)fail();delete project.dependencyPolicies[id];}
 project.status=proof.controlBefore.status;project.projectRevision=proof.beforeRevision;
 restore(project,'ordinaryInputRevision',proof.controlBefore.ordinaryInputRevision);restore(project,'updatedAt',proof.controlBefore.updatedAt);
 const result=readCanonicalTaskAdditionSemantic(previous);if(result.digest!==proof.beforeDigest)fail();
 // A reversible hash edit is not necessarily a legal additive transition.
 // Reuse the exact forward predicates on independently parsed canonical data.
 const reconstructed=proveCanonicalTransition({projectId:proof.projectId,operationId:proof.operationId,expectedBodyHash:proof.bodyHash,
  addedTaskIds:proof.addedTaskRows.map(row=>row.taskId),policyDelta:proof.policyDelta,ordinal:proof.ordinal,previousProofDigest:proof.previousProofDigest},result,now);
 same(reconstructed,proof);return result;
}
/** The supplied born digest and records must come from the original immutable
 * owner. A self-consistent caller-provided chain is not an execution grant. */
export function verifyTaskAdditionProofChain(value){
 const input=readTaskAdditionProofChainInput(value),operations=new Set();let prior=null;
 for(let index=0;index<input.proofs.length;index++){
  const proof=structural(input.proofs[index]);
  if(proof.ordinal!==index+1||proof.previousProofDigest!==prior||operations.has(proof.operationId))fail();
  operations.add(proof.operationId);prior=taskAdditionProofDigest(proof);
 }
 let current=readCanonicalTaskAdditionSemantic(input.current);
 for(let index=input.proofs.length-1;index>=0;index--)current=reverseTaskAdditionProof(current.semantic,input.proofs[index]);
 if(current.digest!==input.bornDigest)fail();return current;
}
