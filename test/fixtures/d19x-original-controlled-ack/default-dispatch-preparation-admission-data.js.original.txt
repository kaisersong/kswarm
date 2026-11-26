import {types,isDeepStrictEqual} from 'node:util';
import {captureExecutionData} from './task-execution-content.js';
import {protocolDigest} from './project-protocol.js';
import {DispatchPreparationDataError,runtimePreparationIntent,runtimePreparationTarget,runtimePreparationBase} from './default-dispatch-runtime-data.js';
const descriptors=Object.getOwnPropertyDescriptors,keys=Reflect.ownKeys,own=Object.hasOwn,prototype=Object.getPrototypeOf;
const objectPrototype=Object.prototype,isArray=Array.isArray,isProxy=types.isProxy;
const exec=Function.prototype.call.bind(RegExp.prototype.exec);
const fail=cause=>{throw new DispatchPreparationDataError('DURABLE_DISPATCH_PREPARATION_ADMISSION_INVALID',{cause});};
const hex=value=>typeof value==='string'&&exec(/^[a-f0-9]{64}$/,value)!==null;
function sourceData(raw){
 if(!raw||typeof raw!=='object'||isProxy(raw)||isArray(raw))fail();
 const proto=prototype(raw);if(proto!==objectPrototype&&proto!==null)fail();
 const rows=descriptors(raw);if(keys(rows).length!==2||!own(rows,'preparationIntentDigest')||!own(rows,'sourceIncarnation'))fail();
 const digest=rows.preparationIntentDigest,incarnation=rows.sourceIncarnation;
 if(!own(digest,'value')||!digest.enumerable||!own(incarnation,'value')||!incarnation.enumerable||!hex(digest.value)||!hex(incarnation.value))fail();
 return captureExecutionData(raw);
}
/** DATA ONLY. The caller must independently qualify the original source,
 * current business and Native graph before any stage/COMMIT. Neither this
 * receipt DTO nor sourceIncarnation is a write, send, Host or launch proof.
 * The runtime floor recognizes its shape; only the original owner can stage
 * the receipt together with the matching graph and current source checks. */
export function runtimePreparationAdmission(rawChild,rawIntent,rawSource){
 const source=sourceData(rawSource);let child,intent;
 try{child=captureExecutionData(rawChild);intent=captureExecutionData(rawIntent);}catch(error){fail(error);}
 const expected=runtimePreparationIntent(child,runtimePreparationTarget(intent));
 if(!isDeepStrictEqual(intent,expected)||source.preparationIntentDigest!==protocolDigest(intent))fail();
 const admissionId='default-dispatch-preparation-admission:'+protocolDigest(['default-dispatch-preparation-admission-v1',child.scope,child.id,source.preparationIntentDigest,source.sourceIncarnation]);
 return captureExecutionData({
  ...runtimePreparationBase(child,{kind:'ordinary_default_dispatch_preparation_admission',schemaVersion:1}),
  id:child.id+':preparation-admission',admissionId,childKey:child.id,payloadHash:child.payloadHash,
  preparationIntentDigest:source.preparationIntentDigest,sourceIncarnation:source.sourceIncarnation,purpose:'prepare',
  runId:intent.runId,preparationClaimId:intent.preparationClaimId,hostId:intent.hostId,targetParticipantId:intent.targetParticipantId,
  targetIncarnation:intent.targetIncarnation,inputMapperVersion:intent.inputMapperVersion,inputDigest:intent.inputDigest,
 });
}
