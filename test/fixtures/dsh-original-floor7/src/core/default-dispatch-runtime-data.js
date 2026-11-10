import {isDeepStrictEqual} from 'node:util';
import {captureExecutionData} from './task-execution-content.js';
import {protocolDigest} from './project-protocol.js';
export const DURABLE_DISPATCH_RUNTIME_CONTRACT='ordinary_default_dispatch_runtime_v1';
export class DispatchPreparationDataError extends Error {}
const fail=()=>{throw new DispatchPreparationDataError('DURABLE_DISPATCH_PREPARATION_UNVERIFIED');};
const same=(a,b)=>{if(!isDeepStrictEqual(a,b))fail();};
const own=Object.hasOwn,descriptors=Object.getOwnPropertyDescriptors,ownKeys=Reflect.ownKeys,isArray=Array.isArray;
const exec=Function.prototype.call.bind(RegExp.prototype.exec);
const hex=value=>typeof value==='string'&&exec(/^[a-f0-9]{64}$/,value)!==null;
const identity=value=>typeof value==='string'&&value.length>0&&value.length<=256&&exec(/[\x00-\x1f\x7f]/,value)===null;
const kinds=Object.freeze({ordinary_default_dispatch_host_no_effect_finish:'protocolReceipt',ordinary_default_dispatch_host_registration:'protocolReceipt',ordinary_default_dispatch_preparation_intent:'protocolReceipt',ordinary_default_dispatch_preparation_admission:'protocolReceipt',ordinary_default_dispatch_preparation_observation:'protocolReceipt',ordinary_default_dispatch_child_head:'protocolHead',ordinary_default_dispatch_outbox_head:'protocolHead'});
// Separate from the storage5 classifier: recognizing these never expands5.
export function runtimeDispatchRecordCollection(value){
 if(value?.contract!==DURABLE_DISPATCH_RUNTIME_CONTRACT||!own(kinds,value.kind))return;
 return value.schemaVersion===(kinds[value.kind]==='protocolHead'?2:1)?kinds[value.kind]:undefined;
}
function fields(value,names){
 if(!value||typeof value!=='object'||isArray(value))fail();
 const rows=descriptors(value);if(ownKeys(rows).length!==names.length)fail();
 for(let i=0;i<names.length;i++){
  const name=names[i];if(!own(rows,name)||!own(rows[name],'value')||!rows[name].enumerable)fail();
 }
}
function base(child,kind,schemaVersion=1){return{kind,schemaVersion,contract:DURABLE_DISPATCH_RUNTIME_CONTRACT,projectId:child.projectId,scope:child.scope,writerStoreId:child.writerStoreId,bindingDigest:child.bindingDigest};}
export function runtimePreparationBase(child,value){return base(child,value.kind,value.schemaVersion);}
const targetFields=Object.freeze(['scope','writerStoreId','projectId','bindingDigest','childKey','payloadHash','hostId','targetParticipantId','targetIncarnation','inputMapperVersion','inputDigest']);
const markerFields=Object.freeze(['version','contract','scope','projectId','kswarmTaskId','runId','businessExecutionGeneration','childKey','payloadHash','bindingDigest','hostId','inputDigest','taskId','sessionId','preparationId','preparedContentDigest']);
/** Close every required own field before even selecting a historical child.
 * Data-only lookup; never derives a new run or preparation intent. */
export function runtimePreparationChildLookup(data,purpose){
 if(purpose==='prepare'||purpose==='observe'){fields(data,targetFields);return data.childKey;}
 if(purpose!=='acknowledge')fail();fields(data,['preparationIntentDigest','fact']);fields(data.fact,markerFields);return data.fact.childKey;
}
export function runtimePreparationIntent(child,raw){
 const data=captureExecutionData(raw);
 fields(data,targetFields);
 same({scope:data.scope,writerStoreId:data.writerStoreId,projectId:data.projectId,bindingDigest:data.bindingDigest,childKey:data.childKey,payloadHash:data.payloadHash},{scope:child.scope,writerStoreId:child.writerStoreId,projectId:child.projectId,bindingDigest:child.bindingDigest,childKey:child.id,payloadHash:child.payloadHash});
 if(!identity(data.hostId)||!identity(data.targetParticipantId)||!identity(data.targetIncarnation)||data.inputMapperVersion!=='kswarm_task_handoff_prompt_v1'||!hex(data.inputDigest))fail();
 const runId='default-dispatch-run:'+protocolDigest(['default-dispatch-run-v1',child.scope,child.id]);
 const key=protocolDigest(['default-dispatch-host-task-v1',child.scope,child.id]);
 return captureExecutionData({...base(child,'ordinary_default_dispatch_preparation_intent'),id:child.id+':preparation',childKey:child.id,payloadHash:child.payloadHash,runId,
  preparationClaimId:'default-dispatch-preparation-claim:'+protocolDigest(['default-dispatch-preparation-claim-v1',child.scope,child.id,child.payloadHash,runId,data.hostId,data.targetParticipantId,data.targetIncarnation,data.inputMapperVersion,data.inputDigest]),
  hostId:data.hostId,targetParticipantId:data.targetParticipantId,targetIncarnation:data.targetIncarnation,inputMapperVersion:data.inputMapperVersion,inputDigest:data.inputDigest,
  taskId:'task_default_dispatch_'+key,sessionId:'session_default_dispatch_'+key,preparationId:'default-dispatch-task-prepare:'+key});
}
export function runtimePreparationTarget(intent){return{scope:intent.scope,writerStoreId:intent.writerStoreId,projectId:intent.projectId,bindingDigest:intent.bindingDigest,childKey:intent.childKey,payloadHash:intent.payloadHash,hostId:intent.hostId,targetParticipantId:intent.targetParticipantId,targetIncarnation:intent.targetIncarnation,inputMapperVersion:intent.inputMapperVersion,inputDigest:intent.inputDigest};}
export function runtimePreparationObservation(child,intent,raw){
 const data=captureExecutionData(raw);fields(data,['preparationIntentDigest','fact']);if(data.preparationIntentDigest!==protocolDigest(intent))fail();
 const fact=data.fact;fields(fact,markerFields);
 if(!hex(fact.preparedContentDigest))fail();
 same(fact,{version:1,contract:'ordinary_default_dispatch_task_preparation_v1',scope:child.scope,projectId:child.projectId,kswarmTaskId:child.taskId,runId:intent.runId,businessExecutionGeneration:child.businessExecutionGeneration,childKey:child.id,payloadHash:child.payloadHash,bindingDigest:child.bindingDigest,hostId:intent.hostId,inputDigest:intent.inputDigest,taskId:intent.taskId,sessionId:intent.sessionId,preparationId:intent.preparationId,preparedContentDigest:fact.preparedContentDigest});
 return captureExecutionData({...base(child,'ordinary_default_dispatch_preparation_observation'),id:child.id+':prepared',childKey:child.id,payloadHash:child.payloadHash,preparationIntentDigest:data.preparationIntentDigest,fact});
}
const blocked=['budget_admission_unavailable','resource_admission_unavailable'];
export function runtimePreparationChildHead(child,intent,observation,admission,registration,noEffectFinish){return captureExecutionData({...base(child,'ordinary_default_dispatch_child_head',2),id:child.id+':status',childKey:child.id,payloadHash:child.payloadHash,revision:2+(admission?1:0)+(observation?1:0)+(registration?1:0)+(noEffectFinish?1:0),state:'intent_pending',intentReceiptId:child.id+':intent',preparationIntentReceiptId:intent.id,preparationAdmissionReceiptId:admission?.id??null,preparationObservationReceiptId:observation?.id??null,...(registration?{hostRegistrationReceiptId:registration.id}:{}),...(noEffectFinish?{hostNoEffectFinishReceiptId:noEffectFinish.id,hostEffectState:'no_effect_finished'}:{}),preparationState:observation?'prepared':'requested',runId:intent.runId,launchState:'blocked',launchBlockedReasons:blocked});}
export function runtimePreparationOutbox(child,intent,observation,admission,registration,noEffectFinish){return captureExecutionData({...base(child,'ordinary_default_dispatch_outbox_head',2),id:child.id+':outbox',childKey:child.id,payloadHash:child.payloadHash,revision:2+(admission?1:0)+(observation?1:0)+(registration?1:0)+(noEffectFinish?1:0),state:observation?'acknowledged':'sending',operation:'prepare_project_task',intentReceiptId:child.id+':intent',preparationIntentReceiptId:intent.id,preparationAdmissionReceiptId:admission?.id??null,preparationObservationReceiptId:observation?.id??null,...(registration?{hostRegistrationReceiptId:registration.id}:{}),...(noEffectFinish?{hostNoEffectFinishReceiptId:noEffectFinish.id,hostEffectState:'no_effect_finished'}:{}),runId:intent.runId,preparationClaimId:intent.preparationClaimId,targetParticipantId:intent.targetParticipantId,targetIncarnation:intent.targetIncarnation});}
export function runtimePreparationProjection(child,intent,observation,operation,admission){return captureExecutionData({childKey:child.id,payloadHash:child.payloadHash,runId:intent.runId,preparationClaimId:intent.preparationClaimId,hostId:intent.hostId,targetParticipantId:intent.targetParticipantId,targetIncarnation:intent.targetIncarnation,inputMapperVersion:intent.inputMapperVersion,inputDigest:intent.inputDigest,taskId:intent.taskId,sessionId:intent.sessionId,preparationId:intent.preparationId,intentDigest:protocolDigest(intent),admissionId:admission?.admissionId??null,scope:child.scope,projectId:child.projectId,kswarmTaskId:child.taskId,businessExecutionGeneration:child.businessExecutionGeneration,bindingDigest:child.bindingDigest,payload:child.payload,operation,state:observation?'prepared':'requested',launchState:'blocked',launchBlockedReasons:blocked,...(observation?{observedFact:observation.fact}:{})});}
