import {types,isDeepStrictEqual} from 'node:util';
import {captureExecutionData} from './task-execution-content.js';
import {protocolDigest} from './project-protocol.js';
import {DispatchPreparationDataError,runtimePreparationBase} from './default-dispatch-runtime-data.js';
const own=Object.hasOwn,descriptors=Object.getOwnPropertyDescriptors,keys=Reflect.ownKeys,prototype=Object.getPrototypeOf;
const isProxy=types.isProxy,isArray=Array.isArray,objectPrototype=Object.prototype;
const names=Object.freeze(['scope','projectId','registrationDigest','hostLeaseKey','sourceIncarnation','reason']);
const fail=()=>{throw new DispatchPreparationDataError('DURABLE_DISPATCH_HOST_NO_EFFECT_INVALID');};
/** Data-only settlement projection. Only the original constructor-fixed
 * Source may attest a private handle's known, never-entered effect fate. */
export function captureHostNoEffectData(raw){
 if(!raw||typeof raw!=='object'||isProxy(raw)||isArray(raw)||prototype(raw)!==objectPrototype&&prototype(raw)!==null)fail();
 const rows=descriptors(raw);if(keys(rows).length!==names.length)fail();
 for(let i=0;i<names.length;i++)if(!own(rows,names[i])||!own(rows[names[i]],'value')||!rows[names[i]].enumerable)fail();
 const data=captureExecutionData(raw);
 if(data.reason!=='cancelled'&&data.reason!=='revoked'&&data.reason!=='final_gate_denied')fail();
 return data;
}
export function runtimeHostNoEffectFinish(child,registration,raw){
 const data=captureHostNoEffectData(raw);
 if(!isDeepStrictEqual({scope:data.scope,projectId:data.projectId,registrationDigest:data.registrationDigest,hostLeaseKey:data.hostLeaseKey,sourceIncarnation:data.sourceIncarnation},{scope:child.scope,projectId:child.projectId,registrationDigest:protocolDigest(registration),hostLeaseKey:registration.hostLeaseKey,sourceIncarnation:registration.sourceIncarnation}))fail();
 if(registration.childKey!==child.id||registration.payloadHash!==child.payloadHash)fail();
 return captureExecutionData({...runtimePreparationBase(child,{kind:'ordinary_default_dispatch_host_no_effect_finish',schemaVersion:1}),id:registration.id+':no-effect-finish',childKey:child.id,payloadHash:child.payloadHash,
  registrationId:registration.id,registrationDigest:data.registrationDigest,admissionId:registration.admissionId,preparationIntentDigest:registration.preparationIntentDigest,sourceIncarnation:registration.sourceIncarnation,hostLeaseKey:registration.hostLeaseKey,disposition:'no_effect',reason:data.reason});
}
