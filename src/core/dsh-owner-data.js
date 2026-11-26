import {protocolDigest} from './project-protocol.js';
import {captureExecutionData} from './task-execution-content.js';
import {types} from 'node:util';
const descriptors=Object.getOwnPropertyDescriptors,ownKeys=Reflect.ownKeys,own=Object.hasOwn,isProxy=types.isProxy,isArray=Array.isArray,proto=Object.getPrototypeOf;
const safeInteger=Number.isSafeInteger,exec=Function.prototype.call.bind(RegExp.prototype.exec),define=Object.defineProperty,freeze=Object.freeze,create=Object.create;
export class DshStateError extends Error{}
export const dshFail=(code='DSH_STATE_UNVERIFIED',cause)=>{throw new DshStateError(code,{cause});};
export function dshClosed(raw){const value=captureExecutionData(raw);if(!value||typeof value!=='object'||isArray(value))return value;const out=create(null),rows=descriptors(value),names=ownKeys(rows);for(let i=0;i<names.length;i++)define(out,names[i],{__proto__:null,value:rows[names[i]].value,enumerable:true});return freeze(out);}
export function dshFields(raw,names){
 if(!raw||typeof raw!=='object'||isProxy(raw)||isArray(raw)||(proto(raw)!==Object.prototype&&proto(raw)!==null))dshFail('DSH_DATA_INVALID');
 const rows=descriptors(raw);if(ownKeys(rows).length!==names.length)dshFail('DSH_DATA_INVALID');
 for(let i=0;i<names.length;i++){const name=names[i];if(!own(rows,name)||!own(rows[name],'value')||!rows[name].enumerable)dshFail('DSH_DATA_INVALID');}return rows;
}
export function dshText(value){return typeof value==='string'&&value.length>0&&value.length<=256&&exec(/[\x00-\x1f\x7f]/,value)===null;}
export const dshHash=value=>typeof value==='string'&&exec(/^[a-f0-9]{64}$/,value)!==null;
export const dshRevision=value=>safeInteger(value)&&value>=1;
export function dshThread(raw){
 dshFields(raw,['tenantId','workspaceId','sourceBindingId','provider','repositoryId','kind','threadId']);
 const value=dshClosed(raw),names=ownKeys(value);for(let i=0;i<names.length;i++)if(!dshText(value[names[i]]))dshFail('DSH_THREAD_INVALID');
 if(value.provider!=='github'||value.kind!=='issue')dshFail('DSH_THREAD_INVALID');return value;
}
export function dshAuthScope(raw,thread){
 dshFields(raw,['tenantId','workspaceId','connectionId','providerAccountId','repositoryId','credentialEpoch']);const value=dshClosed(raw);
 const textNames=['tenantId','workspaceId','connectionId','providerAccountId','repositoryId'];for(let i=0;i<textNames.length;i++)if(!dshText(value[textNames[i]]))dshFail('DSH_AUTH_SCOPE_INVALID');
 if(!dshRevision(value.credentialEpoch))dshFail('DSH_AUTH_SCOPE_INVALID');
 const sharedNames=['tenantId','workspaceId','repositoryId'];for(let i=0;i<sharedNames.length;i++)if(value[sharedNames[i]]!==thread[sharedNames[i]])dshFail('DSH_AUTH_SCOPE_INVALID');return value;
}
export const dshThreadId=thread=>'dsh-thread:'+protocolDigest(['dsh-thread-v1',dshThread(thread)]);
/** Canonical metadata only. Callers still need the original private Source. */
export function dshEvidenceManifest(thread,entries,sourceSnapshotAt){
 const body={schemaVersion:1,thread:dshThread(thread),entries,sourceSnapshotAt};
 return dshClosed({...body,manifestHash:protocolDigest(['dsh-evidence-manifest-v1',body])});
}
export function dshWorkId(data){return'dsh-work:'+protocolDigest(['dsh-work-v1',data.scope,dshThread(data.thread),data.generation]);}
/** Pure identity construction, never a Source, input attestation or permission. */
export function dshCommandIdentity(data){
 const thread=dshThread(data.thread),target=data.action==='create_draft_work'?null:data.targetWorkId;
 const semantic={scope:data.scope,thread,generation:data.generation,action:data.action,target,inputId:data.action==='append_input'?data.inputId:null,purpose:data.purpose,...(data.action==='invalidate_input'?{objectKind:data.input.objectKind,objectId:data.input.sourceObjectId,inputRevision:data.input.sourceRevision}:{}),...(data.action==='request_stop'?{targetFenceEpoch:data.targetFenceEpoch}:{}),...(data.action==='prepare_draft'?{inputSetRevision:data.inputSetRevision,assessmentHash:data.assessmentHash}:{})};
 const operationKey='dsh-operation:'+protocolDigest(['dsh-operation-v1',semantic]);
 const content=data.action==='create_draft_work'||data.action==='append_input'?{inputId:data.inputId,input:data.input,canonical:data.action==='create_draft_work'?data.canonical:null}:data.action==='prepare_draft'?{executionProfile:data.executionProfile}:null;
  const semanticPayloadHash=protocolDigest(['dsh-semantic-v1',semantic,data.bindingId,content]);
 const rows=descriptors(data),payload={},names=ownKeys(rows);for(let i=0;i<names.length;i++){const name=names[i];if(typeof name!=='string'||!own(rows[name],'value'))dshFail('DSH_DATA_INVALID');if(name!=='operationKey'&&name!=='attemptPayloadHash'&&name!=='semanticPayloadHash')define(payload,name,{__proto__:null,value:rows[name].value,enumerable:true});}
 return freeze({operationKey,semanticPayloadHash,attemptPayloadHash:protocolDigest(['dsh-attempt-v1',payload,operationKey,semanticPayloadHash])});
}
export function dshCommitKey(data){return'dsh-draft:'+protocolDigest(['dsh-draft-commit-v1',data.scope,dshWorkId(data),data.bindingId,data.generation,data.inputSetRevision,data.assessmentHash]);}
export const DSH_CONTRACT='dsh_owner_v1';
export const DSH_ADMISSION_CONTRACT = "dsh_owner_admission_v1";
export const dshWorkModeScopeKey = (scope, ownerWorkId) =>
  "dsh-work-mode:" +
  protocolDigest(["dsh-work-mode-scope-v1", scope, ownerWorkId]);
export function dshWorkModeIdentity(value) {
  const semantic = {
    scope: value.scope,
    ownerKind: "kswarm_dsh",
    ownerWorkId: value.ownerWorkId,
    targetMode: value.targetMode,
    targetEpoch: value.targetEpoch,
  };
  const operationKey =
      "dsh-work-mode-operation:" +
      protocolDigest(["dsh-work-mode-operation-v1", semantic]),
    semanticPayloadHash = protocolDigest([
      "dsh-work-mode-semantic-v1",
      semantic,
    ]);
  const payload = {},
    rows = descriptors(value),
    names = ownKeys(rows);
  for (let i = 0; i < names.length; i++) {
    const key = names[i];
    if (
      key !== "operationKey" &&
      key !== "attemptPayloadHash" &&
      key !== "semanticPayloadHash"
    )
      define(payload, key, {
        __proto__: null,
        value: rows[key].value,
        enumerable: true,
      });
  }
  return dshClosed({
    operationKey,
    semanticPayloadHash,
    attemptPayloadHash: protocolDigest([
      "dsh-work-mode-attempt-v1",
      payload,
      operationKey,
      semanticPayloadHash,
    ]),
  });
}
const kinds=freeze({dsh_binding:'protocolReceipt',dsh_create:'protocolReceipt',dsh_command:'protocolReceipt',dsh_applied_operation:'protocolReceipt',dsh_input:'protocolReceipt',dsh_input_invalidation:'protocolReceipt',dsh_draft_slot:'protocolReceipt',dsh_control:'protocolHead',dsh_scope_control:'protocolHead',dsh_authorization_leaf:'protocolHead'});
export function dshRecordCollection(value){if(value?.schemaVersion!==1)return;const admission=value.contract===DSH_ADMISSION_CONTRACT;if(value.contract!==DSH_CONTRACT&&!admission)return;if(own(kinds,value.kind))return kinds[value.kind];if(admission){if(value.kind==='dsh_draft_candidate'||value.kind==='dsh_draft_attempt'||value.kind==='dsh_draft_artifact'||value.kind==='dsh_draft_commit_receipt'||value.kind==='dsh_budget_proof_consumption')return'protocolReceipt';if(value.kind==='dsh_budget_commit_ack'||value.kind==='dsh_draft_content')return'protocolHead';if(value.kind==='dsh_work_guard')return'protocolHead';if(value.kind==='dsh_work_mode_receipt'||value.kind==='dsh_work_mode_operation')return'protocolReceipt';}}
export function dshRecord(value){const row=dshClosed(value);return dshClosed({...row,recordDigest:protocolDigest(['dsh-record-v1',row])});}
export function dshRecordVerified(value){if(!dshRecordCollection(value)||!dshHash(value.recordDigest))return false;const rows=descriptors(value),plain={},names=ownKeys(rows);for(let i=0;i<names.length;i++){const key=names[i];if(key!=='recordDigest')define(plain,key,{__proto__:null,value:rows[key].value,enumerable:true});}return protocolDigest(['dsh-record-v1',plain])===value.recordDigest;}
