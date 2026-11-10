import {captureExecutionData} from './task-execution-content.js';
import {protocolDigest,isProjectProtocolScope} from './project-protocol.js';
const own=Object.hasOwn,keys=Object.keys;
const bad=()=>{throw Error('DURABLE_DISPATCH_ACTION_DATA_INVALID');};
function exact(value,names){if(!value||typeof value!=='object'||Array.isArray(value)||keys(value).length!==names.length)bad();for(let i=0;i<names.length;i++)if(!own(value,names[i]))bad();}
/** Canonical data contract shared with original Main A. Data/hash is not an
 * admission capability; only the constructor-bound business source admits it. */
export function defaultDispatchActionRecord(raw){
 const data=captureExecutionData(raw);exact(data,['scope','projectId','planRevision','dispatchGeneration','bindingDigest','taskSetDigest']);
 if(!isProjectProtocolScope(data.scope)||typeof data.projectId!=='string'||!data.projectId.length||data.projectId.length>512||!Number.isSafeInteger(data.planRevision)||data.planRevision<1||!Number.isSafeInteger(data.dispatchGeneration)||data.dispatchGeneration<1||typeof data.bindingDigest!=='string'||!(/^[a-f0-9]{64}$/.test(data.bindingDigest))||typeof data.taskSetDigest!=='string'||!(/^[a-f0-9]{64}$/.test(data.taskSetDigest)))bad();
 const actorId='desktop-user:'+data.scope.profileId,key=protocolDigest(['main-default-dispatch-key-v1',data.scope.profileId,data.scope.workspaceId,actorId,data.projectId,data.planRevision,data.dispatchGeneration]);
 return captureExecutionData({...data,schemaVersion:1,kind:'default_dispatch_user_action_v1',actorId,actionId:'main-default-dispatch:'+key,payloadHash:protocolDigest(['main-default-dispatch-payload-v1',actorId,data])});
}
export function captureDefaultDispatchActionRecord(raw){
 const value=captureExecutionData(raw);exact(value,['scope','projectId','planRevision','dispatchGeneration','bindingDigest','taskSetDigest','schemaVersion','kind','actorId','actionId','payloadHash']);
 const expected=defaultDispatchActionRecord({scope:value.scope,projectId:value.projectId,planRevision:value.planRevision,dispatchGeneration:value.dispatchGeneration,bindingDigest:value.bindingDigest,taskSetDigest:value.taskSetDigest});
 if(protocolDigest(value)!==protocolDigest(expected))bad();return expected;
}
