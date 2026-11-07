import {createDshDraftRules} from './dsh-draft-rules.js';
import {DSH_COMMIT_PROOF_FIELDS} from './dsh-draft-data.js';
import {dshPolicyId} from './dsh-scope-control-data.js';
import {createDshScopeControlRules} from './dsh-scope-control-rules.js';
import {types,isDeepStrictEqual} from 'node:util';
import {retainSourceErrorTails} from './source-error-tails.js';
import {IntrinsicMap as Map,IntrinsicSet as Set,IntrinsicWeakMap as WeakMap} from './intrinsic-collections.js';
import {protocolDigest,isProjectProtocolScope} from './project-protocol.js';
import {captureDispatchBusinessData} from './dispatch-business-data.js';
import {makeTaskId} from './task-identity.js';
import {readTaskBoardSnapshot} from './task-board.js';
import {PROJECT_ACTIVITY_FIELDS} from './project-activity.js';
import {DSH_ADMISSION_CONTRACT,dshWorkModeScopeKey,dshWorkModeIdentity,DSH_CONTRACT,DshStateError,dshFail as fail,dshClosed as closed,dshFields as fields,dshText as text,dshHash as hash,dshRevision as revision,dshThread,dshAuthScope,dshThreadId,dshEvidenceManifest,dshWorkId,dshCommandIdentity,dshCommitKey,dshRecord,dshRecordVerified,dshRecordCollection} from './dsh-owner-data.js';
const apply=Reflect.apply,descriptors=Object.getOwnPropertyDescriptors,own=Object.hasOwn,keys=Reflect.ownKeys,prototype=Object.getPrototypeOf,define=Object.defineProperty,freeze=Object.freeze,isProxy=types.isProxy,isPromise=types.isPromise,isAsync=types.isAsyncFunction,isArray=Array.isArray,finite=Number.isFinite,now=Date.now;
const asyncPrototype=prototype(async()=>{}),json=JSON.stringify,dateParse=Date.parse,starts=Function.prototype.call.bind(String.prototype.startsWith);
const has=(array,value)=>{for(let i=0;i<array.length;i++)if(array[i]===value)return true;return false;};
const put=(array,item)=>define(array,array.length,{__proto__:null,value:item,enumerable:true,writable:true,configurable:true});
const equal=(a,b)=>{if(protocolDigest(closed(a))!==protocolDigest(closed(b)))fail();};
const key=(collection,id)=>json([collection,id]);
const axes=freeze(['mode','mandate','egress','privacy','readonly']);
const activityFields=[];for(let i=0;i<PROJECT_ACTIVITY_FIELDS.length;i++)put(activityFields,PROJECT_ACTIVITY_FIELDS[i]);freeze(activityFields);
const profile='dsh_owner_writer_v1',admissionProfile='dsh_admission_owner_writer_v1';
const NativeDate=Date,dateIso=Date.prototype.toISOString,safeInteger=Number.isSafeInteger,nativeSort=Array.prototype.sort;
const creationIso=value=>{if(!safeInteger(value)||value<0||value>253402300799999)fail('DSH_CREATED_AT_UNVERIFIED');return apply(dateIso,new NativeDate(value),[]);};
function equalGraph(a,b){if(a.size!==b.size)fail();for(const [id,row]of a){if(!b.has(id))fail();equal(row,b.get(id));}}
const policy='draft_only_no_business_dispatch';
const commands=freeze(['scope','thread','authScope','schemaVersion','commandId','bindingId','generation','ownerKind','mandateId','mandateRevision','authorizationEpoch','action','purpose','inputId','input','canonical','targetWorkId','expectedOwnerVersion','targetFenceEpoch','dispatchPolicy','assessmentRef','assessmentHash','admissionWindowRef','freshnessAttestationRef','evidenceManifestHash','evidence','freshness','egressGuard','budgetReservationRef','authorityValidUntil','executionDeadline','executionProfile','modeGuards','controlGuards','operationKey','semanticPayloadHash','attemptPayloadHash']);
const workModeCommandFields=freeze(['scope','thread','bindingId','generation','ownerWorkId','targetMode','targetEpoch','expectedGuardRevision','commandId','operationKey','attemptPayloadHash','semanticPayloadHash','authorityRef']);
const recordFields=freeze(['kind','id','projectId','schemaVersion','contract','scope','writerStoreId','recordDigest']);
const sync=fn=>typeof fn==='function'&&!isProxy(fn)&&!isAsync(fn)&&prototype(fn)!==asyncPrototype;
function originalResolve(source){if(!source||isProxy(source))return;const rows=descriptors(source),row=own(rows,'resolve')?rows.resolve:undefined;return row&&own(row,'value')&&sync(row.value)?row.value:undefined;}
function semanticProject(project){const data=closed(project),out={};const names=keys(data);for(let i=0;i<names.length;i++){const name=names[i];let activity=false;for(let j=0;j<activityFields.length;j++)if(activityFields[j]===name)activity=true;if(!activity)define(out,name,{__proto__:null,value:data[name],enumerable:true});}return out;}
/** Child of the original Hub acceptance owner. There is no secondary store,
 * dispatcher, queue, budget ledger or runtime grant in this module. */
export function createDshOwnerRules({backend,projects,boards,receipts,heads,floor,source,budgetSource,invokeGuard,retainSourceTail,createProject,isReadQuiescent}){
 const scopeRules=createDshScopeControlRules({heads,receipts,record});
 const resolve=originalResolve(source),resolveBudget=originalResolve(budgetSource),tokens=new WeakMap();let pending=null,sourceFault;const sourceFailures=new Set();
 function active(){return floor()?.profile===profile||floor()?.profile===admissionProfile;}
 function admission(){return floor()?.profile===admissionProfile;}
 function contract(){return admission()?DSH_ADMISSION_CONTRACT:DSH_CONTRACT;}
 function unexpected(raw,cause,kind){sourceFault??=cause;sourceFailures.add(cause);if(raw!==null&&(typeof raw==='object'||typeof raw==='function'))retainSourceTail(raw,cause,kind==='unknown');}
 function data(raw){try{captureDispatchBusinessData(raw,(value)=>unexpected(value,Error('DSH_SOURCE_DATA_UNCONFIRMED')));return closed(raw);}catch(error){fail('DSH_SOURCE_UNCONFIRMED',error);}}
 function invoke(fn,receiver,args,voidResult=false){return invokeGuard(()=>{
  if(!sync(fn))fail('DSH_SOURCE_REQUIRED');let raw;try{raw=apply(fn,receiver,args);}catch(error){sourceFailures.add(error);retainSourceErrorTails(error,(raw,cause,kind)=>unexpected(raw,cause,kind));fail('DSH_SOURCE_REJECTED',error);}
  if(voidResult){if(raw!==undefined){try{captureDispatchBusinessData(raw,value=>unexpected(value,Error('DSH_SOURCE_GUARD_RETURN_INVALID')));}catch{}unexpected(raw,Error('DSH_SOURCE_GUARD_RETURN_INVALID'));fail('DSH_SOURCE_UNCONFIRMED');}return;}
  if(raw&&typeof raw==='object'&&!isProxy(raw)&&!isPromise(raw))return raw;
  unexpected(raw,Error('DSH_SOURCE_RETURN_UNCONFIRMED'));fail('DSH_SOURCE_UNCONFIRMED');
 });}
 function open(frame,purpose){
  if(sourceFault)fail('DSH_SOURCE_UNCONFIRMED',sourceFault);
  if(!resolve)fail('DSH_SOURCE_REQUIRED');
  // Original Source authenticates opaque membership before touching DTO data.
  const raw=invoke(resolve,source,[frame,purpose]);let rows;
  try{rows=fields(raw,['data','assertCurrent','budgetProof']);}catch(error){data(raw);throw error;}
  if(!sync(rows.assertCurrent.value))fail('DSH_SOURCE_REQUIRED');
  const guard=()=>{if(sourceFault)fail('DSH_SOURCE_UNCONFIRMED',sourceFault);invoke(rows.assertCurrent.value,undefined,[],true);};
  const value=data(rows.data.value),proof=rows.budgetProof.value;
  if(proof!==null&&(isProxy(proof)||isPromise(proof)||typeof proof!=='object')){unexpected(proof,Error('DSH_BUDGET_PROOF_INVALID'));fail('DSH_BUDGET_REQUIRED');}
  guard();return{data:value,guard,proof};
 }
 function domain(value){if(!active()||!isProjectProtocolScope(value.scope)||!isDeepStrictEqual(value.scope,floor().scope))fail('DSH_PROFILE_UNQUALIFIED');dshThread(value.thread);}
 function nativeRevision(){const row=backend.readCurrentRevision();if(!row||row.actual!==row.cached)fail('DSH_NATIVE_CUT_UNCONFIRMED');return row.actual;}
function requiredRecordFields(extra) {
  const names = [];
  for (let i = 0; i < recordFields.length; i++) put(names, recordFields[i]);
  for (let i = 0; i < extra.length; i++) put(names, extra[i]);
  return names;
}
function validateAdmissionControlRecord(value) {
  const names = requiredRecordFields([
    "revision",
    "ownerVersion",
    "inputSetRevision",
    "bindingDigest",
    "stopped",
    "generationClosed",
    "completionLatch",
    "stopFenceEpoch",
    "currentDraftValid",
    "executionDeadline",
    "expectedControlIds",
    "inputIds",
    "validInputIds",
    "workCreatedAt",
    "workGuardId",
  ]);
  if (own(value, "closingFence")) put(names, "closingFence");
  if(own(value,'currentDraftRef'))put(names,'currentDraftRef');
  if(own(value,'completionReachedAt'))put(names,'completionReachedAt');
  fields(value, names);
  if(value.completionLatch&&(!text(value.currentDraftRef)||typeof value.completionReachedAt!=='string'||!finite(dateParse(value.completionReachedAt))))fail('DSH_GRAPH_UNVERIFIED');
  if(value.completionLatch){const artifact=receipts.get(value.currentDraftRef);if(!artifact||artifact.kind!=='dsh_draft_artifact'||artifact.projectId!==value.projectId||artifact.createdAt!==value.completionReachedAt)fail('DSH_GRAPH_UNVERIFIED');}
  if (
    !revision(value.revision) ||
    !revision(value.ownerVersion) ||
    !revision(value.inputSetRevision) ||
    !safeInteger(value.stopFenceEpoch) ||
    value.stopFenceEpoch < 0 ||
    typeof value.stopped !== "boolean" ||
    typeof value.generationClosed !== "boolean" ||
    typeof value.completionLatch !== "boolean" ||
    typeof value.currentDraftValid !== "boolean" ||
    !hash(value.bindingDigest) ||
    typeof value.executionDeadline !== "string" ||
    !finite(dateParse(value.executionDeadline)) ||
    typeof value.workCreatedAt !== "string" ||
    value.workGuardId !== value.projectId + ":work-guard"
  )
    fail("DSH_GRAPH_UNVERIFIED");
  if (own(value, "closingFence")) {
    fields(value.closingFence, ["id", "epoch", "canonicalHash"]);
    if (
      !text(value.closingFence.id) ||
      !revision(value.closingFence.epoch) ||
      !hash(value.closingFence.canonicalHash)
    )
      fail("DSH_GRAPH_UNVERIFIED");
  }
}
function validateWorkGuardRecord(value) {
  fields(
    value,
    requiredRecordFields([
      "ownerWorkId",
      "scopeKey",
      "mode",
      "epoch",
      "revision",
    ]),
  );
  const binding = receipts.get(value.projectId + ":binding"),
    control = heads.get(value.projectId + ":control");
  if (
    !admission() ||
    !binding ||
    !control ||
    value.ownerWorkId !== value.projectId ||
    value.id !== value.projectId + ":work-guard" ||
    value.scopeKey !== dshWorkModeScopeKey(value.scope, value.ownerWorkId) ||
    !revision(value.epoch) ||
    !revision(value.revision) ||
    value.epoch < value.revision ||
    (value.mode !== "auto_draft" &&
      value.mode !== "observe" &&
      value.mode !== "off") ||
    (value.mode !== "auto_draft" &&
      (!control.stopped || !control.generationClosed))
  )
    fail("DSH_WORK_GUARD_UNVERIFIED");
}
function validateWorkModeReceiptRecord(value) {
  fields(
    value,
    requiredRecordFields([
      "command",
      "commandId",
      "operationKey",
      "attemptPayloadHash",
      "semanticPayloadHash",
      "result",
      "guardId",
      "guardEpoch",
      "guardRevision",
      "mode",
      "ownerWorkId",
    ]),
  );
  validateWorkModeCommand(value.command);
  const ctx = work(value.command);
  if (
    value.command.ownerWorkId !== ctx.id ||
    value.commandId !== value.command.commandId ||
    !isDeepStrictEqual(value.scope, value.command.scope)
  )
    fail("DSH_WORK_GUARD_UNVERIFIED");
  const identity = dshWorkModeIdentity(value.command),
    operation = receipts.get(value.operationKey);
  if (
    !admission() ||
    value.result !== "applied" ||
    value.id !==
      "dsh-work-mode-command:" +
        protocolDigest([value.scope, value.command.commandId]) ||
    value.operationKey !== identity.operationKey ||
    value.attemptPayloadHash !== identity.attemptPayloadHash ||
    value.semanticPayloadHash !== identity.semanticPayloadHash ||
    value.projectId !== value.command.ownerWorkId ||
    value.ownerWorkId !== value.projectId ||
    value.guardId !== value.projectId + ":work-guard" ||
    value.guardEpoch !== value.command.targetEpoch ||
    value.guardRevision !== value.command.expectedGuardRevision + 1 ||
    value.mode !== value.command.targetMode ||
    operation?.kind !== "dsh_work_mode_operation" ||
    operation.commandReceiptId !== value.id
  )
    fail("DSH_WORK_GUARD_UNVERIFIED");
}
function validateWorkModeOperationRecord(value) {
  fields(
    value,
    requiredRecordFields(["semanticPayloadHash", "commandReceiptId"]),
  );
  const receipt = receipts.get(value.commandReceiptId);
  if (
    !admission() ||
    receipt?.kind !== "dsh_work_mode_receipt" ||
    receipt.operationKey !== value.id ||
    receipt.semanticPayloadHash !== value.semanticPayloadHash ||
    receipt.projectId !== value.projectId
  )
    fail("DSH_WORK_GUARD_UNVERIFIED");
}
 function physical(){
  const start=nativeRevision(),rows=backend.rows(),all=new Map(),graph=new Map();
  if(backend.physicalRowCount()!==rows.length)fail('DSH_NATIVE_CUT_UNCONFIRMED');
  for(let i=0;i<rows.length;i++){
   const row=rows[i];all.set(key(row.collection,row.key),row);
   if(!dshNamespace(row.value))continue;
   if(!dshRecordVerified(row.value)||row.value.contract!==contract()||dshRecordCollection(row.value)!==row.collection||row.key!==row.value.id||row.projectId!==row.value.projectId||!isDeepStrictEqual(row.value.scope,floor()?.scope)||row.value.writerStoreId!==floor()?.storeId)fail('DSH_GRAPH_UNVERIFIED');
   const heap=(row.collection==='protocolReceipt'?receipts:heads).get(row.key);equal(heap,row.value);graph.set(key(row.collection,row.key),row);
  }
  const maps=[['protocolReceipt',receipts],['protocolHead',heads]];for(let mi=0;mi<maps.length;mi++){const collection=maps[mi][0],map=maps[mi][1];for(const [id,value]of map)if(dshNamespace(value)&&!graph.has(key(collection,id)))fail('DSH_GRAPH_UNVERIFIED');}
  for(const row of graph.values())if(row.value.kind==='dsh_binding'){
   const binding=row.value,id=row.projectId,project=all.get(key('project',id)),board=all.get(key('board',id));
   if(!project||!board||project.value.id!==id||board.value.projectId!==id||!projects.has(id)||!boards.has(id))fail('DSH_WORK_UNVERIFIED');
   equal(semanticProject(project.value),semanticProject(projects.get(id)));equal(closed(board.value.tasks),readTaskBoardSnapshot(boards.get(id)));
   if(project.value.dispatchPolicy!==policy||project.value.requiredProtocol!==contract()||board.value.tasks.length!==1||board.value.tasks[0].id!==binding.taskId)fail('DSH_WORK_UNVERIFIED');
   const control=heads.get(id+':control'),create=receipts.get(id+':create');if(!control||!create||control.bindingDigest!==binding.recordDigest||create.bindingDigest!==binding.recordDigest||dshWorkId(binding)!==id)fail('DSH_GRAPH_UNVERIFIED');
   if(admission()){const guard=heads.get(id+':work-guard');if(!guard||control.workGuardId!==guard.id||control.workCreatedAt!==creationIso(project.value.createdAt))fail('DSH_WORK_GUARD_UNVERIFIED');}
  }

  for(const row of graph.values()){
   const value=row.value;
   if(value.kind==='dsh_command'){
    const command=value.command;if(admission())validateCommand(command,own(command,'inputSetRevision'));const identity=dshCommandIdentity(command);if(value.id!=='dsh-command:'+protocolDigest([command.scope,command.thread,command.commandId])||value.ownerWorkId!==dshWorkId(command)||value.projectId!==value.ownerWorkId||value.commandId!==command.commandId||value.operationKey!==identity.operationKey||value.attemptPayloadHash!==identity.attemptPayloadHash||value.semanticPayloadHash!==identity.semanticPayloadHash||value.result!=='applied'&&value.result!=='blocked')fail('DSH_GRAPH_UNVERIFIED');
    if(value.result==='applied'){const operation=receipts.get(value.operationKey);if(operation?.kind!=='dsh_applied_operation'||operation.commandReceiptId!==value.id)fail('DSH_GRAPH_UNVERIFIED');}
   }else if(value.kind==='dsh_applied_operation'){
    const command=receipts.get(value.commandReceiptId);if(command?.kind!=='dsh_command'||command.result!=='applied'||command.operationKey!==value.id||command.projectId!==value.projectId||command.semanticPayloadHash!==value.semanticPayloadHash)fail('DSH_GRAPH_UNVERIFIED');
    if(own(value,'slotId')){const slot=receipts.get(value.slotId);if(slot?.kind!=='dsh_draft_slot'||slot.projectId!==value.projectId||command.slotId!==slot.id)fail('DSH_GRAPH_UNVERIFIED');}
   }else if(value.kind==='dsh_input'){
    input(value.input);const control=heads.get(value.projectId+':control');if(!control||value.id!==value.projectId+':input:'+protocolDigest(value.input.inputId)||value.inputDigest!==protocolDigest(value.input)||!has(control.inputIds,value.input.inputId))fail('DSH_GRAPH_UNVERIFIED');
   }else if(value.kind==='dsh_draft_candidate'||value.kind==='dsh_draft_attempt'||value.kind==='dsh_draft_artifact'||value.kind==='dsh_draft_commit_receipt'||value.kind==='dsh_budget_proof_consumption'||value.kind==='dsh_budget_commit_ack'||value.kind==='dsh_draft_content'){drafts.validateRecord(value);
   }else if(value.kind==='dsh_draft_slot'){
    const binding=receipts.get(value.projectId+':binding');if(!binding||value.state!=='prepared'||value.id!==dshCommitKey({...binding,inputSetRevision:value.inputSetRevision,assessmentHash:value.assessmentHash})||value.draftCommitKey!==value.id||value.draftInvocationId!=='dsh-invocation:'+protocolDigest(value.id)||value.artifactId!=='dsh-artifact:'+protocolDigest(value.id)||value.readContextRef!=='dsh-read-context:'+protocolDigest(value.id)||value.readSetRevision!==0||!isArray(value.readManifest)||value.readManifest.length!==0)fail('DSH_GRAPH_UNVERIFIED');
   }else if(value.kind==='dsh_work_guard'){validateWorkGuardRecord(value);
   }else if(value.kind==='dsh_work_mode_receipt'){validateWorkModeReceiptRecord(value);
   }else if(value.kind==='dsh_work_mode_operation'){validateWorkModeOperationRecord(value);
   }else if(value.kind==='dsh_scope_control'||value.kind==='dsh_authorization_leaf'){
    scopeRules.validateRecord(value);
   }else if(value.kind==='dsh_control'){
    if(admission())validateAdmissionControlRecord(value);const binding=receipts.get(value.projectId+':binding');if(!binding||value.id!==value.projectId+':control'||!revision(value.ownerVersion)||!revision(value.inputSetRevision)||!isArray(value.inputIds)||!isArray(value.validInputIds))fail('DSH_GRAPH_UNVERIFIED');scopeRules.assertExpectation({...binding,mandateId:binding.mandateId},value.expectedControlIds);const seen=new Set();for(let i=0;i<value.inputIds.length;i++){const id=value.inputIds[i];if(!text(id)||seen.has(id)||!receipts.has(value.projectId+':input:'+protocolDigest(id)))fail('DSH_GRAPH_UNVERIFIED');seen.add(id);}for(let i=0;i<value.validInputIds.length;i++)if(!seen.has(value.validInputIds[i]))fail('DSH_GRAPH_UNVERIFIED');
   }
  }
  if(nativeRevision()!==start)fail('DSH_NATIVE_CUT_UNCONFIRMED');return{revision:start,all,graph};
 }
 function dshNamespace(row){return typeof row?.contract==='string'&&starts(row.contract,'dsh_')||typeof row?.kind==='string'&&starts(row.kind,'dsh_');}
 function base(kind,id,projectId,value){return{kind,id,projectId,schemaVersion:1,contract:contract(),scope:value.scope,writerStoreId:floor().storeId};}
 function record(kind,id,projectId,value,rest){return dshRecord({...base(kind,id,projectId,value),...rest});}
 function work(value){const id=dshWorkId(value),binding=receipts.get(id+':binding'),control=heads.get(id+':control');if(!binding||!control)fail('DSH_WORK_NOT_FOUND');if(binding.threadKey!==dshThreadId(value.thread)||binding.bindingId!==value.bindingId||binding.generation!==value.generation)fail('DSH_WORK_UNVERIFIED');if(own(value,'mandateId')&&binding.mandateId!==value.mandateId)fail('MANDATE_BINDING_MISMATCH');return{id,binding,control,guard:admission()?heads.get(id+':work-guard'):undefined};}
 function stageToken(value,snapshot,entry,guard){const token=freeze(Object.create(null));tokens.set(token,{...entry,value,snapshot,guard,used:false});return{ok:true,needsWrite:true,token,projectId:entry.projectId,response:entry.response};}
 function input(value){fields(value,['inputId','sourceObjectId','sourceRevision','contentHash','provenanceHash','objectKind','provenanceVersion','actorMappingVersion','snapshotRef']);if(!text(value.inputId)||!text(value.sourceObjectId)||!text(value.sourceRevision)||!text(value.snapshotRef)||!hash(value.contentHash)||!hash(value.provenanceHash)||(value.objectKind!=='issue'&&value.objectKind!=='comment')||!revision(value.provenanceVersion)||!revision(value.actorMappingVersion))fail('DSH_INPUT_UNVERIFIED');return value;}
 function baseline(value,requireAuth=true){return scopeRules.baseline(value,requireAuth);}
 function requiredDraftAction(value, committing = false) {
  if (value.action === 'create_draft_work') return 'local.draft.create';
  if (value.action === 'append_input') return 'local.draft.revise';
  if (value.action !== 'prepare_draft') fail('DSH_COMMAND_INVALID');
  const projectId = dshWorkId(value);
  // The original post-COMMIT guard sees this attempt's newly written artifact.
  // Exclude only that exact slot; earlier immutable artifacts still require revise.
  const currentSlot = committing ? dshCommitKey(value) : null;
  for (const row of receipts.values()) {
   if (row.kind === 'dsh_draft_artifact' && row.projectId === projectId &&
       row.draftCommitKey !== currentSlot) return 'local.draft.revise';
  }
  return 'local.draft.create';
 }
 function generating(value,bases,slot){
  const time=now();if(admission()&&value.action!=='create_draft_work'){const ctx=work(value);if(!ctx.guard)fail('DSH_WORK_GUARD_UNVERIFIED');fields(value.workGuard,['scopeKey','epoch','revision']);equal(value.workGuard,{scopeKey:ctx.guard.scopeKey,epoch:ctx.guard.epoch,revision:ctx.guard.revision});if(ctx.guard.mode!=='auto_draft'||ctx.control.stopped||ctx.control.generationClosed)fail('DSH_WORK_GUARD_CLOSED');}fields(value.egressGuard,['policyRef','epoch','policyHash']);const mandate=scopeRules.generating(value,bases,time,requiredDraftAction(value));
  let activeWorks=0,draftRuns=0;for(const row of receipts.values()){if(row.kind==='dsh_binding'&&row.mandateId===value.mandateId){const control=heads.get(row.projectId+':control');if(!control)fail('DSH_AUTHORITY_SUSPECT');if(!control.stopped&&!control.generationClosed&&!control.completionLatch)activeWorks++;}if(slot&&row.kind==='dsh_draft_slot'&&row.projectId===value.targetWorkId)draftRuns++;}
  if(value.action==='create_draft_work'&&activeWorks>=mandate.limits.maxActiveWorks||slot&&draftRuns>=mandate.limits.maxDraftRunsPerWork)fail('DSH_MANDATE_LIMIT_REACHED');
  if(typeof value.authorityValidUntil!=='string'||typeof value.executionDeadline!=='string'||!finite(dateParse(value.authorityValidUntil))||!finite(dateParse(value.executionDeadline))||dateParse(value.authorityValidUntil)<=time||dateParse(value.executionDeadline)<=time||dateParse(value.executionDeadline)>dateParse(value.authorityValidUntil))fail('DSH_AUTHORITY_EXPIRED');
  if(value.executionProfile!=='model_text_only_v1'&&value.executionProfile!=='dsh_readonly_v1')fail('DSH_EXECUTION_PROFILE_UNSUPPORTED');
  if(!text(value.assessmentRef)||!hash(value.assessmentHash)||!text(value.admissionWindowRef)||!text(value.freshnessAttestationRef)||!hash(value.evidenceManifestHash))fail('DSH_AUTHORITY_REQUIRED');
  fields(value.evidence,['manifest','attestationRef']);if(!text(value.evidence.attestationRef))fail('DSH_EVIDENCE_REQUIRED');const manifest=value.evidence.manifest;fields(manifest,['schemaVersion','thread','entries','sourceSnapshotAt','manifestHash']);
  if(manifest.schemaVersion!==1||!isArray(manifest.entries)||!manifest.entries.length||manifest.entries.length>4096||typeof manifest.sourceSnapshotAt!=='string'||!finite(dateParse(manifest.sourceSnapshotAt))||dateParse(manifest.sourceSnapshotAt)>time)fail('DSH_EVIDENCE_REQUIRED');equal(manifest.thread,value.thread);
  const seenInputs=new Set();for(let i=0;i<manifest.entries.length;i++){const entry=manifest.entries[i];fields(entry,['inputId','objectKind','objectId','revision','contentHash','provenanceVersion','actorEvidenceHash','actorMappingVersion']);if(!text(entry.inputId)||!text(entry.objectId)||!text(entry.revision)||(entry.objectKind!=='issue'&&entry.objectKind!=='comment')||!hash(entry.contentHash)||!hash(entry.actorEvidenceHash)||!revision(entry.provenanceVersion)||!revision(entry.actorMappingVersion)||seenInputs.has(entry.inputId))fail('DSH_EVIDENCE_REQUIRED');seenInputs.add(entry.inputId);}
  const canonical=dshEvidenceManifest(value.thread,manifest.entries,manifest.sourceSnapshotAt);if(canonical.manifestHash!==manifest.manifestHash||value.evidenceManifestHash!==manifest.manifestHash)fail('DSH_EVIDENCE_HASH_CONFLICT');
  fields(value.freshness,['window','eventTimeEvidenceRef','attestationRef']);if(!text(value.freshness.eventTimeEvidenceRef)||value.freshness.attestationRef!==value.freshnessAttestationRef)fail('DSH_FRESHNESS_REQUIRED');const window=value.freshness.window;fields(window,['windowId','sourceBindingId','prefixModeGuardsHash','admissionGrantHash','effectiveAt','baselineCheckpointRef','providerTimeBasisProofRef','freshnessPolicyVersion']);
  if(window.windowId!==value.admissionWindowRef||window.sourceBindingId!==value.thread.sourceBindingId||window.prefixModeGuardsHash!==protocolDigest(value.modeGuards)||!hash(window.admissionGrantHash)||typeof window.effectiveAt!=='string'||!finite(dateParse(window.effectiveAt))||dateParse(window.effectiveAt)>time||!text(window.baselineCheckpointRef)||!text(window.providerTimeBasisProofRef)||window.freshnessPolicyVersion!==1)fail('DSH_FRESHNESS_REQUIRED');

 }
 function budget(opened,value,bases){
  if(!resolveBudget||opened.proof===null)fail('DSH_BUDGET_REQUIRED');const raw=invoke(resolveBudget,budgetSource,[opened.proof]);let rows;try{rows=fields(raw,['data','assertCurrent']);}catch(error){data(raw);throw error;}if(!sync(rows.assertCurrent.value))fail('DSH_BUDGET_REQUIRED');
  const reservation=data(rows.data.value);fields(reservation,['reservationId','issuerDomain','mandateId','mandateRevision','authorizationEpoch','scope','thread','operationKey','semanticPayloadHash','assessmentRef','purpose','state']);
  if(reservation.issuerDomain!==bases.facts.mandate.value.budgetRef||reservation.mandateId!==value.mandateId||reservation.mandateRevision!==value.mandateRevision||reservation.authorizationEpoch!==value.authorizationEpoch||reservation.reservationId!==value.budgetReservationRef||reservation.operationKey!==value.operationKey||reservation.semanticPayloadHash!==value.semanticPayloadHash||reservation.assessmentRef!==value.assessmentRef||reservation.purpose!==(value.action==='prepare_draft'?'draft_prepare':'draft_admission')||reservation.state!=='reserved')fail('DSH_BUDGET_REQUIRED');equal(reservation.scope,value.scope);equal(reservation.thread,value.thread);
  const guard=()=>invoke(rows.assertCurrent.value,undefined,[],true);guard();return{guard,attestation:reservation};
 }
 function validateCommand(value,slot){
  const expected=[];for(let i=0;i<commands.length;i++)put(expected,commands[i]);if(slot)put(expected,'inputSetRevision');if(admission())put(expected,'workGuard');fields(value,expected);domain(value);dshAuthScope(value.authScope,value.thread);
  if(value.schemaVersion!==(admission()?2:1)||value.ownerKind!=='kswarm_dsh'||value.generation!==1||!text(value.bindingId)||!text(value.commandId)||!text(value.mandateId)||!revision(value.mandateRevision)||!revision(value.authorizationEpoch)||value.dispatchPolicy!==policy)fail('DSH_COMMAND_INVALID');
  if(slot?value.action!=='prepare_draft':value.action!=='create_draft_work'&&value.action!=='append_input'&&value.action!=='invalidate_input'&&value.action!=='request_stop')fail('DSH_COMMAND_INVALID');
  const identity=dshCommandIdentity(value);if(identity.operationKey!==value.operationKey||identity.semanticPayloadHash!==value.semanticPayloadHash||identity.attemptPayloadHash!==value.attemptPayloadHash)fail('DSH_COMMAND_HASH_CONFLICT');
  if(value.action==='create_draft_work'&&(value.targetWorkId!==null||value.expectedOwnerVersion!==null)||value.action!=='create_draft_work'&&(value.targetWorkId!==dshWorkId(value)||(value.action==='request_stop'?value.expectedOwnerVersion!==null&&!revision(value.expectedOwnerVersion):!revision(value.expectedOwnerVersion))))fail('DSH_COMMAND_INVALID');
  if(value.action==='request_stop'?!revision(value.targetFenceEpoch):value.targetFenceEpoch!==null)fail('DSH_COMMAND_INVALID');
  if(admission()&&(value.action==='append_input'||value.action==='prepare_draft')){fields(value.workGuard,['scopeKey','epoch','revision']);if(value.workGuard.scopeKey!==dshWorkModeScopeKey(value.scope,dshWorkId(value))||!revision(value.workGuard.epoch)||!revision(value.workGuard.revision))fail('DSH_WORK_GUARD_INVALID');}
  if(admission()&&(value.action==='create_draft_work'||value.action==='request_stop'||value.action==='invalidate_input')&&value.workGuard!==null)fail('DSH_WORK_GUARD_INVALID');
  if(value.purpose!==(value.action==='request_stop'?'control':value.action==='invalidate_input'?'invalidation':'draft'))fail('DSH_COMMAND_INVALID');return value;
 }
 function inputEvidence(value){return{inputId:value.inputId,objectKind:value.objectKind,objectId:value.sourceObjectId,revision:value.sourceRevision,contentHash:value.contentHash,provenanceVersion:value.provenanceVersion,actorEvidenceHash:value.provenanceHash,actorMappingVersion:value.actorMappingVersion};}
 function receipt(value,result,ownerWorkId,control,consumedInputIds=[],reasonCode,budgetAttestation=null){return record('dsh_command','dsh-command:'+protocolDigest([value.scope,value.thread,value.commandId]),ownerWorkId,value,{command:value,budgetAttestation,commandId:value.commandId,operationKey:value.operationKey,action:value.action,attemptPayloadHash:value.attemptPayloadHash,semanticPayloadHash:value.semanticPayloadHash,result,...(reasonCode?{reasonCode}:{}),ownerWorkId,ownerVersion:control?.ownerVersion??0,inputSetRevision:control?.inputSetRevision??0,consumedInputIds});}
 function commandOutcome(value,snapshot,opened,slot){
  const binding=receipts.get(dshWorkId(value)+':binding');if(binding&&binding.mandateId!==value.mandateId)fail('MANDATE_BINDING_MISMATCH');
  const bases=baseline(value,value.action!=='request_stop'&&value.action!=='invalidate_input');
  const existing=receipts.get('dsh-command:'+protocolDigest([value.scope,value.thread,value.commandId]));
  if(existing){if(existing.attemptPayloadHash!==value.attemptPayloadHash)fail('DSH_COMMAND_ID_CONFLICT');return{ok:existing.result==='applied',needsWrite:false,response:closed({ok:existing.result==='applied',receipt:existing,...(slot&&existing.slotId?{slot:receipts.get(existing.slotId)}:{})})};}
  const applied=receipts.get(value.operationKey);if(applied){if(applied.semanticPayloadHash!==value.semanticPayloadHash)fail('DSH_OPERATION_CONFLICT');const old=receipts.get(applied.commandReceiptId);return{ok:true,needsWrite:false,response:closed(slot?{ok:true,receipt:old,slot:receipts.get(applied.slotId)}:{ok:true,receipt:old})};}
  let ctx=value.action==='create_draft_work'?null:work(value),id=ctx?.id??dshWorkId(value),control=ctx?.control;
  let denied;
  try{
   if(ctx&&value.action!=='request_stop'&&value.action!=='invalidate_input'&&(value.expectedOwnerVersion!==control.ownerVersion||control.generationClosed||control.stopped))fail('DSH_WORK_CONFLICT');
   if(ctx&&value.action!=='request_stop'&&value.action!=='invalidate_input'&&(dateParse(control.executionDeadline)<=now()||dateParse(value.executionDeadline)>dateParse(control.executionDeadline)))fail('DSH_WORK_DEADLINE_CONFLICT');
   if(value.action==='create_draft_work'&&(projects.has(id)||receipts.has(id+':binding')))fail('DSH_CANONICAL_CREATE_CONFLICT');
   if(value.action!=='request_stop'&&value.action!=='invalidate_input')generating(value,bases,slot);
   if(value.action==='invalidate_input'){input(value.input);if(value.input.inputId!==value.inputId)fail('DSH_INPUT_UNVERIFIED');}
   if(value.action==='request_stop'&&value.targetFenceEpoch<control.stopFenceEpoch)fail('DSH_STOP_FENCE_STALE');
   if(value.action==='create_draft_work'||value.action==='append_input'){input(value.input);if(value.input.inputId!==value.inputId)fail('DSH_INPUT_UNVERIFIED');const entries=value.evidence.manifest.entries;if(entries.length!==1)fail('DSH_EVIDENCE_REQUIRED');equal(entries[0],inputEvidence(value.input));}
   if(value.action==='append_input'){for(const item of receipts.values())if(item.projectId===id&&item.kind==='dsh_input_invalidation'&&item.objectKind===value.input.objectKind&&item.objectId===value.input.sourceObjectId&&item.inputRevision===value.input.sourceRevision)fail('DSH_INPUT_INVALIDATED');}
   if(slot){if(value.inputSetRevision!==control.inputSetRevision)fail('DSH_INPUT_SET_CONFLICT');const ids=control.validInputIds;if(!ids.length||value.evidence.manifest.entries.length!==ids.length)fail('DSH_INPUT_SET_CONFLICT');const seen=new Set();for(let i=0;i<value.evidence.manifest.entries.length;i++){const entry=value.evidence.manifest.entries[i];if(!has(ids,entry.inputId)||seen.has(entry.inputId))fail('DSH_INPUT_SET_CONFLICT');seen.add(entry.inputId);const stored=receipts.get(id+':input:'+protocolDigest(entry.inputId));if(!stored)fail('DSH_INPUT_UNVERIFIED');equal(entry,inputEvidence(stored.input));}}

   if(value.action==='create_draft_work'){fields(value.canonical,['inputId','createManifestHash']);if(value.canonical.inputId!==value.inputId||!hash(value.canonical.createManifestHash))fail('DSH_CANONICAL_INPUT_CONFLICT');}
  }catch(error){if(!(error instanceof DshStateError))throw error;denied=error.message;}
  let budgetGuard,budgetAttestation=null;if(!denied&&value.action!=='request_stop'&&value.action!=='invalidate_input'){try{const admitted=budget(opened,value,bases);budgetGuard=admitted.guard;budgetAttestation=admitted.attestation;}catch(error){if(!(error instanceof DshStateError))throw error;denied=error.message;}}
  const responseReceipt=receipt(value,denied?'blocked':'applied',id,control,[],denied);
  if(denied)return stageToken(value,snapshot,{projectId:id,records:[['protocolReceipt',responseReceipt]],response:closed({ok:false,error:denied,receipt:responseReceipt})},opened.guard);
  let birth;const records=[],consumed=[],next=control?{...control,revision:control.revision+1,ownerVersion:control.ownerVersion+1}:null;
  if(value.action==='create_draft_work'){
   const taskId=makeTaskId(id,'draft'),binding=record('dsh_binding',id+':binding',id,value,{thread:value.thread,threadKey:dshThreadId(value.thread),bindingId:value.bindingId,mandateId:value.mandateId,generation:value.generation,taskId,ownerKind:'kswarm_dsh',dispatchPolicy:policy});
   put(records,['protocolReceipt',binding]);put(records,['protocolReceipt',record('dsh_create',id+':create',id,value,{bindingDigest:binding.recordDigest,canonicalInputId:value.inputId,canonicalCreateManifestHash:value.canonical.createManifestHash})]);
   if(admission()){const createdAt=now(),workCreatedAt=creationIso(createdAt);birth={createdAt,contract:contract()};const guard=record('dsh_work_guard',id+':work-guard',id,value,{ownerWorkId:id,scopeKey:dshWorkModeScopeKey(value.scope,id),mode:'auto_draft',epoch:1,revision:1});put(records,['protocolHead',guard]);}
   control=record('dsh_control',id+':control',id,value,{...(admission()?{workCreatedAt:creationIso(birth.createdAt),workGuardId:id+':work-guard'}:{}),revision:1,ownerVersion:1,inputSetRevision:1,bindingDigest:binding.recordDigest,stopped:false,generationClosed:false,completionLatch:false,stopFenceEpoch:0,currentDraftValid:false,executionDeadline:value.executionDeadline,expectedControlIds:bases.expectation,inputIds:[value.inputId],validInputIds:[value.inputId]});put(consumed,value.inputId);
  }else{control={...next};delete control.recordDigest;if(value.action==='append_input'){if(has(control.inputIds,value.inputId))fail('DSH_INPUT_ALREADY_CONSUMED');control.inputIds=[...control.inputIds,value.inputId];control.validInputIds=[...control.validInputIds,value.inputId];control.inputSetRevision++;control.currentDraftValid=false;put(consumed,value.inputId);}
   else if(value.action==='invalidate_input'){
    const invalidated=[],matching=new Set();
    for(let i=0;i<control.inputIds.length;i++){const inputId=control.inputIds[i],stored=receipts.get(id+':input:'+protocolDigest(inputId));if(!stored)fail('DSH_INPUT_UNVERIFIED');const item=stored.input;if(item.objectKind===value.input.objectKind&&item.sourceObjectId===value.input.sourceObjectId&&item.sourceRevision===value.input.sourceRevision){put(invalidated,inputId);matching.add(inputId);}}
    if(!invalidated.length)fail('DSH_INPUT_NOT_FOUND');const valid=[];for(let i=0;i<control.validInputIds.length;i++)if(!matching.has(control.validInputIds[i]))put(valid,control.validInputIds[i]);control.validInputIds=valid;control.inputSetRevision++;control.currentDraftValid=false;
    put(records,['protocolReceipt',record('dsh_input_invalidation',value.operationKey+':invalidation',id,value,{objectKind:value.input.objectKind,objectId:value.input.sourceObjectId,inputRevision:value.input.sourceRevision,invalidatedInputIds:invalidated,inputSetRevision:control.inputSetRevision})]);
   }
   else if(value.action==='request_stop'){control.stopFenceEpoch=control.stopFenceEpoch<value.targetFenceEpoch?value.targetFenceEpoch:control.stopFenceEpoch;control.stopped=true;control.generationClosed=true;control.currentDraftValid=false;}
   else if(slot){if(value.inputSetRevision!==control.inputSetRevision)fail('DSH_INPUT_SET_CONFLICT');}
   control=dshRecord(control);
  }
  if(consumed.length)put(records,['protocolReceipt',record('dsh_input',id+':input:'+protocolDigest(value.inputId),id,value,{input:value.input,inputDigest:protocolDigest(value.input)})]);
  if(value.action==='invalidate_input')for(const item of heads.values())if(item.projectId===id&&item.kind==='dsh_draft_content'&&item.state==='stored')put(records,['protocolHead',record('dsh_draft_content',item.id,id,value,{...omitDigest(item),revision:item.revision+1,state:'redacted',text:null})]);
  let draftSlot;if(slot){const commitKey=dshCommitKey(value);draftSlot=record('dsh_draft_slot',commitKey,id,value,{draftCommitKey:commitKey,state:'prepared',draftInvocationId:'dsh-invocation:'+protocolDigest(commitKey),artifactId:'dsh-artifact:'+protocolDigest(commitKey),inputSetRevision:control.inputSetRevision,assessmentHash:value.assessmentHash,executionProfile:value.executionProfile,readContextRef:'dsh-read-context:'+protocolDigest(commitKey),readSetRevision:0,readManifest:[]});put(records,['protocolReceipt',draftSlot]);}
  const appliedReceipt=receipt(value,'applied',id,control,consumed,undefined,budgetAttestation);const finalReceipt=slot?dshRecord({...omitDigest(appliedReceipt),slotId:draftSlot.id}):appliedReceipt;
  put(records,['protocolReceipt',finalReceipt]);put(records,['protocolReceipt',record('dsh_applied_operation',value.operationKey,id,value,{semanticPayloadHash:value.semanticPayloadHash,commandReceiptId:finalReceipt.id,...(slot?{slotId:draftSlot.id}:{})})]);put(records,['protocolHead',control]);
  return stageToken(value,snapshot,{projectId:id,create:value.action==='create_draft_work',birth,records,response:closed(slot?{ok:true,receipt:finalReceipt,slot:draftSlot}:{ok:true,receipt:finalReceipt})},()=>{opened.guard();budgetGuard?.();});
 }
 function omitDigest(value){const out={},names=keys(value);for(let i=0;i<names.length;i++){const name=names[i];if(name!=='recordDigest')define(out,name,{__proto__:null,value:value[name],enumerable:true});}return out;}
 function draftManifest(ctx,slot,control=ctx.control){
  const entries=[];
  for(let i=0;i<control.validInputIds.length;i++){
   const inputId=control.validInputIds[i],stored=receipts.get(ctx.id+':input:'+protocolDigest(inputId));
   if(!stored||stored.kind!=='dsh_input')fail('DSH_INPUT_UNVERIFIED');
   let consumed;
   for(const row of receipts.values())if(row.kind==='dsh_command'&&row.projectId===ctx.id&&row.result==='applied'&&has(row.consumedInputIds,inputId)){if(consumed)fail('DSH_INPUT_UNVERIFIED');consumed=row;}
   if(!consumed)fail('DSH_INPUT_UNVERIFIED');
   put(entries,{...inputEvidence(stored.input),admissionEvidenceManifestHash:consumed.command.evidenceManifestHash});
  }
  apply(nativeSort,entries,[(a,b)=>a.inputId<b.inputId?-1:a.inputId>b.inputId?1:0]);
  const core={bindingId:ctx.binding.bindingId,inputSetRevision:slot.inputSetRevision,aggregateEvidenceHash:protocolDigest(['dsh-input-aggregate-v1',entries]),triggerAssessmentHash:slot.assessmentHash,entries,sourceSnapshotAt:null};
  // The canonical snapshot time is the real accepted slot command's evidence.
  let preparation;for(const row of receipts.values())if(row.kind==='dsh_command'&&row.projectId===ctx.id&&row.slotId===slot.id){if(preparation)fail('DSH_GRAPH_UNVERIFIED');preparation=row;}
  if(!preparation)fail('DSH_GRAPH_UNVERIFIED');core.sourceSnapshotAt=preparation.command.evidence.manifest.sourceSnapshotAt;
  return closed({...core,manifestHash:protocolDigest(['dsh-input-manifest-v1',core])});
 }
 function draftCurrent(value,control){
  if(!admission())fail('DSH_DRAFT_PROFILE_REQUIRED');
  const ctx=work(value),bases=baseline(value,true),time=now();
  if(control.stopped||control.generationClosed||control.completionLatch||!ctx.guard||ctx.guard.mode!=='auto_draft')fail('DSH_WORK_GUARD_CLOSED');
  equal(value.workGuard,{scopeKey:ctx.guard.scopeKey,epoch:ctx.guard.epoch,revision:ctx.guard.revision});
  const mandate=scopeRules.generating(value,bases,time,requiredDraftAction(value,true));let draftRuns=0;for(const row of receipts.values())if(row.kind==='dsh_draft_slot'&&row.projectId===ctx.id)draftRuns++;if(draftRuns>mandate.limits.maxDraftRunsPerWork)fail('DSH_MANDATE_LIMIT_REACHED');
  if(value.executionProfile!=='model_text_only_v1'||dateParse(control.executionDeadline)<=time||dateParse(value.executionDeadline)>dateParse(control.executionDeadline)||dateParse(value.executionDeadline)<=time||dateParse(value.authorityValidUntil)<=time)fail('DSH_WORK_DEADLINE_CONFLICT');
 }
 function draftLocal(snapshot,records){
  const expected=new Map(snapshot.graph);for(let i=0;i<records.length;i++)expected.set(key(records[i][0],records[i][1].id),{value:records[i][1]});
  let count=0;const maps=[['protocolReceipt',receipts],['protocolHead',heads]];
  for(let j=0;j<maps.length;j++)for(const [id,value]of maps[j][1])if(dshNamespace(value)){count++;const row=expected.get(key(maps[j][0],id));if(!row)fail('DSH_GRAPH_UNVERIFIED');equal(value,row.value);}
  if(count!==expected.size)fail('DSH_GRAPH_UNVERIFIED');
  for(const row of snapshot.all.values()){
   if(row.collection==='project'&&projects.has(row.key))equal(semanticProject(projects.get(row.key)),semanticProject(row.value));
   if(row.collection==='board'&&boards.has(row.key))equal(readTaskBoardSnapshot(boards.get(row.key)),row.value.tasks);
  }
 }
 function draftBudget(opened,value){
  if(!resolveBudget||opened.proof===null)fail('DSH_BUDGET_COMMIT_REQUIRED');
  const raw=invoke(resolveBudget,budgetSource,[opened.proof]),rows=fields(raw,['data','assertCurrent']);
  if(!sync(rows.assertCurrent.value))fail('DSH_BUDGET_COMMIT_REQUIRED');
  const verified=data(rows.data.value);fields(verified,['issuerDomain','proof']);fields(verified.proof,DSH_COMMIT_PROOF_FIELDS);
  equal(verified.proof,value.budgetCommitProof);
  const bases=baseline(value.authority,true);
  if(verified.issuerDomain!==bases.facts.mandate.value.budgetRef||verified.proof.operationKey!==value.authority.operationKey)fail('DSH_BUDGET_COMMIT_REQUIRED');
  const guard=()=>{invoke(rows.assertCurrent.value,undefined,[],true);if(!finite(dateParse(verified.proof.validUntil))||dateParse(verified.proof.validUntil)<=now())fail('DSH_BUDGET_COMMIT_EXPIRED');};guard();return guard;
 }
 const drafts=createDshDraftRules({receipts,heads,record,work,validateAuthority:value=>validateCommand(value,true),current:draftCurrent,manifest:draftManifest,budget:draftBudget,localGraph:draftLocal});
 function prepareDraft(frame,purpose,context){
  try{
   const rows=fields(context,['requestSource']);if(rows.requestSource.value!=='scheduler'||!admission())fail('DSH_DRAFT_PROFILE_REQUIRED');
   const opened=open(frame,purpose),snapshot=physical(),result=drafts.prepare(opened.data,purpose,opened,snapshot);
   if(result.old)return{needsWrite:false,response:result.response};
   return stageToken(opened.data,snapshot,{...result,draft:true},result.guard);
  }catch(error){if(!(error instanceof DshStateError))throw error;return closed({ok:false,error:error.message});}
 }
 function afterDraft(token,response){
  const row=tokens.get(token);
  if(!row||!row.used||!row.draft)fail('DSH_PREPARATION_REQUIRED');
  // A committed transaction remains durable even if this last Source fails.
  // Neither a lost result nor a later retry authorizes another artifact.
  row.guard();physical();row.local();return response;
 }
 function prepared(frame,purpose,context){
  try{const rows=fields(context,['requestSource']);if(rows.requestSource.value!=='scheduler'&&(purpose!=='narrow'||rows.requestSource.value!=='user'))fail('DSH_SOURCE_REQUIRED');const opened=open(frame,purpose),value=opened.data;validateCommand(value,purpose==='slot');if(purpose==='narrow'?(value.action!=='request_stop'&&value.action!=='invalidate_input'):(purpose==='effect'&&(value.action==='request_stop'||value.action==='invalidate_input')))fail('DSH_COMMAND_PURPOSE_REQUIRED');const snapshot=physical();const result=commandOutcome(value,snapshot,opened,purpose==='slot');opened.guard();return result;}
  catch(error){if(!(error instanceof DshStateError))throw error;return closed({ok:false,error:error.message});}
 }
 function prepareControl(frame,context){
  try{const rows=fields(context,['requestSource']);if(rows.requestSource.value!=='scheduler'&&rows.requestSource.value!=='user')fail('DSH_SOURCE_REQUIRED');const opened=open(frame,'control'),value=opened.data;if(!active()||!isProjectProtocolScope(value.scope)||!isDeepStrictEqual(value.scope,floor().scope))fail('DSH_PROFILE_UNQUALIFIED');
   const snapshot=physical(),result=scopeRules.prepare(value);opened.guard();if(result.old)return{ok:true,needsWrite:false,response:result.response};return stageToken(value,snapshot,{projectId:null,records:result.records,response:result.response},opened.guard);
  }catch(error){if(!(error instanceof DshStateError))throw error;return closed({ok:false,error:error.message});}
 }
function validateWorkModeCommand(value) {
  fields(value, workModeCommandFields);
  domain(value);
  if (
    value.generation !== 1 ||
    !text(value.bindingId) ||
    !text(value.commandId) ||
    !text(value.authorityRef) ||
    !text(value.ownerWorkId) ||
    !revision(value.targetEpoch) ||
    !revision(value.expectedGuardRevision) ||
    (value.targetMode !== "off" &&
      value.targetMode !== "observe" &&
      value.targetMode !== "auto_draft")
  )
    fail("DSH_WORK_MODE_INVALID");
  const identity = dshWorkModeIdentity(value);
  if (
    identity.operationKey !== value.operationKey ||
    identity.attemptPayloadHash !== value.attemptPayloadHash ||
    identity.semanticPayloadHash !== value.semanticPayloadHash
  )
    fail("DSH_COMMAND_HASH_CONFLICT");
}
function prepareWorkMode(frame, context) {
  try {
    if (!admission()) fail("DSH_ADMISSION_PROFILE_REQUIRED");
    fields(context, ["requestSource"]);
    if (
      context.requestSource !== "user" &&
      context.requestSource !== "scheduler"
    )
      fail("DSH_SOURCE_REQUIRED");
    const opened = open(frame, "work_control"),
      value = opened.data;
    validateWorkModeCommand(value);
    const snapshot = physical(),
      ctx = work(value);
    if (value.ownerWorkId !== ctx.id || !ctx.guard)
      fail("DSH_WORK_GUARD_UNVERIFIED");
    const receiptId =
        "dsh-work-mode-command:" +
        protocolDigest([value.scope, value.commandId]),
      sameCommand = receipts.get(receiptId),
      operation = receipts.get(value.operationKey);
    if (sameCommand) {
      if (sameCommand.attemptPayloadHash !== value.attemptPayloadHash)
        fail("DSH_COMMAND_ID_CONFLICT");
      return {
        ok: true,
        needsWrite: false,
        response: closed({ ok: true, receipt: sameCommand }),
      };
    }
    if (operation) {
      if (operation.semanticPayloadHash !== value.semanticPayloadHash)
        fail("DSH_OPERATION_CONFLICT");
      return {
        ok: true,
        needsWrite: false,
        response: closed({
          ok: true,
          receipt: receipts.get(operation.commandReceiptId),
        }),
      };
    }
    if (value.targetEpoch <= ctx.guard.epoch)
      fail(
        value.targetEpoch === ctx.guard.epoch
          ? "DSH_CONTROL_CONFLICT"
          : "DSH_CONTROL_STALE",
      );
    if (value.expectedGuardRevision !== ctx.guard.revision)
      fail("DSH_WORK_GUARD_CONFLICT");
    if (value.targetMode === "auto_draft") {
      const bases = scopeRules.baseline(
        { ...ctx.binding, mandateId: ctx.binding.mandateId },
        false,
      );
      for (let i = 0; i < bases.policies.length; i++) {
        const row = heads.get(
          dshPolicyId(bases.policies[i].scopeKey, bases.policies[i].axis),
        );
        if (
          !row ||
          (row.axis === "mode"
            ? row.value.mode !== "auto_draft"
            : !row.value.allowed)
        )
          fail("DSH_SCOPE_POLICY_BLOCKED");
      }
    }
    const guard = record("dsh_work_guard", ctx.guard.id, ctx.id, value, {
        ownerWorkId: ctx.id,
        scopeKey: ctx.guard.scopeKey,
        mode: value.targetMode,
        epoch: value.targetEpoch,
        revision: ctx.guard.revision + 1,
      }),
      records = [["protocolHead", guard]];
    if (value.targetMode !== "auto_draft") {
      const control = { ...omitDigest(ctx.control) };
      control.revision++;
      control.ownerVersion++;
      control.stopped = true;
      control.generationClosed = true;
      control.currentDraftValid = false;
      put(records, ["protocolHead", dshRecord(control)]);
    }
    const receipt = record("dsh_work_mode_receipt", receiptId, ctx.id, value, {
      command: value,
      commandId: value.commandId,
      operationKey: value.operationKey,
      attemptPayloadHash: value.attemptPayloadHash,
      semanticPayloadHash: value.semanticPayloadHash,
      result: "applied",
      guardId: guard.id,
      guardEpoch: guard.epoch,
      guardRevision: guard.revision,
      mode: guard.mode,
      ownerWorkId: ctx.id,
    });
    put(records, ["protocolReceipt", receipt]);
    put(records, [
      "protocolReceipt",
      record("dsh_work_mode_operation", value.operationKey, ctx.id, value, {
        semanticPayloadHash: value.semanticPayloadHash,
        commandReceiptId: receipt.id,
      }),
    ]);
    opened.guard();
    return stageToken(
      value,
      snapshot,
      { projectId: ctx.id, records, response: closed({ ok: true, receipt }) },
      opened.guard,
    );
  } catch (error) {
    if (!(error instanceof DshStateError)) throw error;
    return closed({ ok: false, error: error.message });
  }
}
 return freeze({active,prepare:prepared,prepareControl,prepareWorkMode,prepareDraft,afterDraft,
  isProject(projectId){if(typeof projectId!=='string')return false;const row=receipts.get(projectId+':binding');if(row?.kind==='dsh_binding')return true;const rows=backend?.rows()??[];for(let i=0;i<rows.length;i++){const item=rows[i];if(item.projectId===projectId&&item.value.kind==='dsh_binding')return true;}return false;},
  accept(token){const row=tokens.get(token);if(!row||row.used||pending)fail('DSH_PREPARATION_REQUIRED');row.used=true;pending=row;row.guard();if(row.create){createProject(row.projectId,row.birth);const tasks=readTaskBoardSnapshot(boards.get(row.projectId));if(tasks.length!==1)fail('DSH_WORK_UNVERIFIED');}return row.response;},
  abort(){pending=null;},clear(){pending=null;},
  runtimeChecks(){if(!pending)return;const entry=pending;return freeze({assertCurrent(){if(pending!==entry)fail('DSH_PREPARATION_REQUIRED');entry.guard();},assertLocal(){if(pending!==entry||sourceFault)fail('DSH_SOURCE_UNCONFIRMED');if(entry.draft)entry.local();for(let i=0;i<entry.records.length;i++){const pair=entry.records[i],map=pair[0]==='protocolReceipt'?receipts:heads;equal(map.get(pair[1].id),pair[1]);}}});},
  stage(scope,candidates,birthIds){
   if(!active()){if(pending)fail('DSH_PROFILE_UNQUALIFIED');return [];}
   const old=physical();if(pending){equal(old.revision,pending.snapshot.revision);equalGraph(old.graph,pending.snapshot.graph);pending.guard();
    for(let i=0;i<pending.records.length;i++){const collection=pending.records[i][0],row=pending.records[i][1];const map=collection==='protocolReceipt'?receipts:heads;if(collection==='protocolReceipt'&&map.has(row.id))fail('DSH_IMMUTABLE_CONFLICT');map.set(row.id,row);put(birthIds,key(collection,row.id));}}
   const unrelated=[];
   if(pending&&pending.projectId===null){for(const row of old.all.values()){
    if(dshNamespace(row.value)||row.collection==='humanAction')continue;
    if(row.collection==='project'){const candidate=candidates.get(row.key);if(!candidate)fail('DSH_STATE_UNVERIFIED');equal(semanticProject(row.value),semanticProject(candidate));put(unrelated,{collection:row.collection,key:row.key,projectId:row.projectId,value:candidate,comparison:'json'});}
    else put(unrelated,{collection:row.collection,key:row.key,projectId:row.projectId,value:row.value,comparison:'json'});
   }}
   const rows=[],maps=[['protocolReceipt',receipts],['protocolHead',heads]];for(let mi=0;mi<maps.length;mi++){const collection=maps[mi][0],map=maps[mi][1];for(const [id,value]of map)if(dshNamespace(value)){if(!active()||!dshRecordVerified(value)||dshRecordCollection(value)!==collection||value.id!==id)fail('DSH_GRAPH_UNVERIFIED');put(rows,{collection,key:id,projectId:value.projectId,value});}}
   const graphLength=rows.length;for(let ri=0;ri<graphLength;ri++){const row=rows[ri];if(row.value.kind!=='dsh_binding')continue;
    const id=row.projectId,project=candidates.get(id)??projects.get(id),board=boards.get(id);if(!project||!board)fail('DSH_WORK_UNVERIFIED');
    if(!(pending?.create&&pending.projectId===id)){const previous=old.all.get(key('project',id));if(!previous)fail('DSH_WORK_UNVERIFIED');equal(semanticProject(previous.value),semanticProject(project));}
    put(rows,{collection:'project',key:id,projectId:id,value:project,comparison:'json'});put(rows,{collection:'board',key:id,projectId:id,value:{projectId:id,tasks:readTaskBoardSnapshot(board)},comparison:'json'});
   }
   if(pending){pending.guard();if(nativeRevision()!==pending.snapshot.revision)fail('DSH_NATIVE_CUT_UNCONFIRMED');}const scoped=[];for(let i=0;i<unrelated.length;i++)put(scoped,unrelated[i]);for(let i=0;i<rows.length;i++)if(scope.type==='full'||rows[i].projectId===scope.projectId)put(scoped,rows[i]);return scoped;
  },
  read(frame,kind){try{if(kind==='admission_basis'&&!admission())fail('DSH_ADMISSION_PROFILE_REQUIRED');if(!isReadQuiescent())fail('DSH_READ_BUSY');const opened=open(frame,'read'),value=opened.data;
    if(kind==='domain'){
     fields(value,['scope']);if(!admission()||!isProjectProtocolScope(value.scope)||!isDeepStrictEqual(value.scope,floor().scope))fail('DSH_ADMISSION_PROFILE_REQUIRED');
     const before=physical(),writer=floor(),controlHeads=[];for(const row of heads.values())if(row.kind==='dsh_scope_control'||row.kind==='dsh_authorization_leaf')put(controlHeads,row);const response=closed({ok:true,controlHeads,domain:{schemaVersion:1,kind:'kswarm_dsh',ownerKind:'kswarm_dsh',domainId:'kswarm-dsh-domain:'+protocolDigest(['kswarm-dsh-owner-domain-v1',writer.storeId,writer.scope]),storeId:writer.storeId,scope:writer.scope,writerProfile:writer.profile,writerSchemaVersion:writer.schemaVersion,nativeRevision:before.revision}});
     opened.guard();if(!isReadQuiescent())fail('DSH_READ_BUSY');const after=physical();equal(before.revision,after.revision);equalGraph(before.graph,after.graph);return response;
    }
    const names=['scope','thread','bindingId','generation',...((kind==='operation'||kind==='admission_basis')?['operationKey']:(kind==='slot'||kind==='draft')?['ownerWorkId','draftCommitKey']:['ownerWorkId'])];if(kind==='admission_basis'&&own(value,'commandId')){put(names,'commandId');if(!text(value.commandId))fail('DSH_READ_INVALID');}fields(value,names);domain(value);if(!text(value.bindingId)||value.generation!==1)fail('DSH_READ_INVALID');const before=physical();let result;
    if(kind==='operation'||kind==='admission_basis'){
     if(!text(value.operationKey))fail('DSH_READ_INVALID');
     const operation=receipts.get(value.operationKey);
     if(!operation||operation.kind!=='dsh_applied_operation'){
      if(kind!=='admission_basis'||!own(value,'commandId'))fail('DSH_OPERATION_NOT_FOUND');
      const blocked=receipts.get('dsh-command:'+protocolDigest([value.scope,value.thread,value.commandId]));
      if(!blocked||blocked.kind!=='dsh_command'||blocked.result!=='blocked')fail('DSH_OPERATION_NOT_FOUND');
      const command=blocked.command;
      if(command.commandId!==value.commandId||command.operationKey!==value.operationKey||command.bindingId!==value.bindingId||command.generation!==value.generation||protocolDigest(command.scope)!==protocolDigest(value.scope)||protocolDigest(command.thread)!==protocolDigest(value.thread))fail('DSH_READ_FORBIDDEN');
      if(!text(blocked.reasonCode))fail('DSH_GRAPH_UNVERIFIED');
      result={ok:false,error:blocked.reasonCode,receipt:blocked};
     }else{
      const binding=receipts.get(operation.projectId+':binding');
      if(!binding||binding.threadKey!==dshThreadId(value.thread)||binding.bindingId!==value.bindingId||binding.generation!==value.generation)fail('DSH_READ_FORBIDDEN');
      result={ok:true,receipt:receipts.get(operation.commandReceiptId)};
      if(kind==='admission_basis'){
       if(!admission())fail('DSH_ADMISSION_PROFILE_REQUIRED');
       const id=operation.projectId,project=before.all.get(key('project',id)),control=heads.get(id+':control'),guard=heads.get(id+':work-guard');
       if(!project||!control||!guard)fail('DSH_GRAPH_UNVERIFIED');
       result={ok:true,basis:{schemaVersion:1,commandReceipt:result.receipt,appliedOperation:operation,binding,createRecord:receipts.get(id+':create'),control,workGuard:guard,projectCreatedAt:project.value.createdAt,nativeRevision:before.revision}};
      }
     }
    }
    else{const ctx=work(value);if(value.ownerWorkId!==ctx.id)fail('DSH_READ_FORBIDDEN');if(kind==='work')result={ok:true,work:{ownerWorkId:ctx.id,binding:ctx.binding,control:ctx.control,...(admission()?{guard:ctx.guard}:{})}};else{if(!text(value.draftCommitKey))fail('DSH_READ_INVALID');const slot=receipts.get(value.draftCommitKey);if(slot?.kind!=='dsh_draft_slot'||slot.projectId!==ctx.id)fail('DSH_SLOT_NOT_FOUND');result=kind==='draft'?drafts.read(ctx,slot):{ok:true,slot,...(admission()?{inputManifest:draftManifest(ctx,slot)}:{})};}}
    const response=closed(result);opened.guard();if(!isReadQuiescent())fail('DSH_READ_BUSY');const after=physical();equal(before.revision,after.revision);equalGraph(before.graph,after.graph);return response;
   }catch(error){if(!(error instanceof DshStateError))throw error;return closed({ok:false,error:error.message});}}
 });
}
