import {types,isDeepStrictEqual} from 'node:util';
import {captureExecutionData} from './task-execution-content.js';
import {protocolDigest} from './project-protocol.js';
import {DispatchPreparationDataError,runtimePreparationBase,runtimePreparationIntent,runtimePreparationTarget} from './default-dispatch-runtime-data.js';
import {runtimePreparationAdmission} from './default-dispatch-preparation-admission-data.js';
const own=Object.hasOwn,descriptors=Object.getOwnPropertyDescriptors,keys=Reflect.ownKeys,prototype=Object.getPrototypeOf;
const exec=Function.prototype.call.bind(RegExp.prototype.exec);
const names=Object.freeze(['scope','projectId','childKey','payloadHash','admissionId','preparationIntentDigest','sourceIncarnation','hostLeaseKey']);
const fail=()=>{throw new DispatchPreparationDataError('DURABLE_DISPATCH_HOST_REGISTRATION_INVALID');};
/** Closed data, never a Host grant. Membership, original prepare-used SDK cut,
 * the Native transaction and its normal return are independently required. */
export function captureHostRegistrationData(raw){
 if(!raw||typeof raw!=='object'||types.isProxy(raw)||Array.isArray(raw)||![Object.prototype,null].includes(prototype(raw)))fail();
 const rows=descriptors(raw);if(keys(rows).length!==names.length)fail();
 for(let i=0;i<names.length;i++)if(!own(rows,names[i])||!own(rows[names[i]],'value')||!rows[names[i]].enumerable)fail();
 if(typeof rows.hostLeaseKey.value!=='string'||exec(/^[a-f0-9]{64}$/,rows.hostLeaseKey.value)===null)fail();
 return captureExecutionData(raw);
}
export function runtimeHostRegistration(child,intent,admission,raw){
 const data=captureHostRegistrationData(raw);
 if(!isDeepStrictEqual(intent,runtimePreparationIntent(child,runtimePreparationTarget(intent))))fail();
 if(!isDeepStrictEqual(admission,runtimePreparationAdmission(child,intent,{preparationIntentDigest:data.preparationIntentDigest,sourceIncarnation:data.sourceIncarnation})))fail();
 if(!isDeepStrictEqual({scope:data.scope,projectId:data.projectId,childKey:data.childKey,payloadHash:data.payloadHash,admissionId:data.admissionId},{scope:child.scope,projectId:child.projectId,childKey:child.id,payloadHash:child.payloadHash,admissionId:admission.admissionId}))fail();
 return captureExecutionData({...runtimePreparationBase(child,{kind:'ordinary_default_dispatch_host_registration',schemaVersion:1}),id:child.id+':host-registration',childKey:child.id,payloadHash:child.payloadHash,
  admissionId:admission.admissionId,preparationIntentDigest:protocolDigest(intent),sourceIncarnation:admission.sourceIncarnation,hostLeaseKey:data.hostLeaseKey,
  runId:intent.runId,preparationClaimId:intent.preparationClaimId,hostId:intent.hostId,targetParticipantId:intent.targetParticipantId,targetIncarnation:intent.targetIncarnation,inputMapperVersion:intent.inputMapperVersion,inputDigest:intent.inputDigest});
}
