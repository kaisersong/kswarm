import {readOrdinaryTaskMetadataEnvelope,readTaskInitialClaimInput,InitialPlanSemanticSchemaError} from './initial-plan-semantic-schema.js';
import {ADDITIVE_INITIAL_PLAN,ADDITIVE_INITIAL_PLAN_DESCRIPTOR,TASK_ADDITIVE_INITIAL_PLAN,TASK_ADDITIVE_DESCRIPTOR} from './initial-plan-acceptance-contract.js';
import {roomUserSourceMatchesInput} from './room-user-source-contract.js';
import {protocolDigest} from './project-protocol.js';
import {resolveProjectInputAuthority} from './project-input-authority.js';
import {createHash} from 'node:crypto';

const deny = error => ({ok:false,error});
const clone = value => structuredClone(value);
const contentHash = value => createHash('sha256').update(value).digest('hex');
const sameScope = (a,b) => a?.profileId === b?.profileId && a?.workspaceId === b?.workspaceId;
const operationKey = (source,projectId) => source.schemaVersion===3
  ? 'ordinary-room-input:'+protocolDigest(['ordinary-room-input-v1',source.profileId,source.workspaceId,projectId,source.canonicalUserTaskId,source.canonicalMessageId])
  : 'ordinary-input:'+protocolDigest(['ordinary-input-v1',source.profileId,source.workspaceId,projectId,source.threadId,source.canonicalUserTaskId,source.canonicalMessageId]);
const headKey = operationId => operationId+':lifecycle';
const terminalKey=(operationId,projectDisposition,ownerRevision)=>operationId+':owner-terminal:'+protocolDigest([projectDisposition,ownerRevision]);
const claimKey = projectId => 'initial-plan:'+protocolDigest(['initial-plan-reservation-v1',projectId,1]);
export const initialPlanReservationId=claimKey;

/** Owner-local protocol. IO and business mutations share the Hub's transaction;
 * no network, model launch, second PO outbox or cross-database await occurs here.
 * Permanent records contain identity/hashes only; retained bodies live in the
 * original deletable project aggregate. This does not enable candidate/DSH mode.
 */
export function createOrdinaryProjectInputs({projects,receipts,heads,readBinding,transact,storageReady,applyPlan,terminalAuthority,acceptanceOwner,recordTaskAddition,transactionActive=()=>false}) {
  const preparedClaims=new WeakMap();
  function authorize(projectId,token,kinds,operationRead=false) {
    const authority=resolveProjectInputAuthority(token);
    if (!authority || authority.requestSource!=='user' || !kinds.includes(authority.kind)) return deny('PROJECT_INPUT_AUTHORITY_REQUIRED');
    if (!storageReady()) return deny('PROTECTED_PROTOCOL_STORAGE_REQUIRED');
    const binding=readBinding(projectId);
    if (binding.classification!=='ordinary') return deny(binding.reasonCode ?? 'PROTOCOL_BINDING_UNVERIFIED');
    if (!binding.binding.scope) return deny('PROJECT_SCOPE_UNVERIFIED');
    if (!sameScope(binding.binding.scope,authority)) return deny('PROJECT_SCOPE_MISMATCH');
    // Authenticated original-owner reads/replays cannot observe a staged heap.
    if(transactionActive(projectId))return deny('ORDINARY_PROJECT_TRANSACTION_ACTIVE');
    const project=projects.get(projectId);
    if (!project && !operationRead) return deny('PROJECT_NOT_FOUND');
    return {ok:true,authority,project,binding};
  }
  function operationView(receipt) {
    const head=heads.get(headKey(receipt.operationId));
    if (!head || head.id!==headKey(receipt.operationId) || head.projectId!==receipt.projectId || head.kind!=='ordinary_input_lifecycle'
      || head.schemaVersion!==1 || !Number.isSafeInteger(head.revision) || head.revision<1
      || !['accepted_pending','applied','voided','rejected'].includes(head.status)
      || head.operationDigest!==protocolDigest(receipt)) throw Error('ORDINARY_OPERATION_INTEGRITY_FAILED');
    const terminal=readTerminalReceipt(receipt,head);
    if(head.status==='applied' && receipt.action==='add_plan_input'){
      const reservation=receipts.get(head.initialPlanReservationId);
      const index=reservation?.consumedOperationIds?.indexOf(receipt.operationId);
      if(!reservation || reservation.id!==claimKey(receipt.projectId) || reservation.projectId!==receipt.projectId || reservation.kind!=='initial_plan_reservation'
        || !Number.isInteger(index) || index<0 || reservation.consumedMessageIds?.[index]!==receipt.sourceMessageId)throw Error('ORDINARY_OPERATION_INTEGRITY_FAILED');
    }
    const operation={...clone(receipt),status:head.status,
      ...(terminal?{projectDisposition:terminal.projectDisposition,terminalReceiptRef:terminal.id}:{}),
      ...(head.initialPlanReservationId?{initialPlanReservationId:head.initialPlanReservationId}:{})};
    const taskReceipt=receipt.taskReceiptId?acceptanceOwner.readTaskReceipt(receipt.projectId,receipt.taskReceiptId):undefined;
    return {ok:receipt.outcome!=='rejected',operation,...(taskReceipt?{taskReceipt}:{}),acknowledged:head.status==='applied',terminal:head.status!=='accepted_pending',
      consumption:head.status==='applied'&&receipt.action==='add_plan_input'?{state:'consumed',initialPlanReservationId:head.initialPlanReservationId}:{state:head.status==='accepted_pending'?'not_yet_consumed':'not_consumed'},
      ...(receipt.reasonCode?{error:receipt.reasonCode}:{})};
  }
  function readTerminalReceipt(operation,head) {
    if(head?.terminalReceiptRef===undefined)return undefined;
    const terminal=receipts.get(head.terminalReceiptRef);
    if(!terminal || terminal.kind!=='ordinary_input_owner_terminal_receipt' || terminal.schemaVersion!==1
      || !['closed','deleted'].includes(terminal.projectDisposition) || terminal.projectId!==operation.projectId || terminal.operationId!==operation.operationId
      || !Number.isSafeInteger(terminal.previousOwnerRevision) || terminal.previousOwnerRevision<1 || terminal.ownerRevision!==terminal.previousOwnerRevision+1
      || terminal.id!==terminalKey(operation.operationId,terminal.projectDisposition,terminal.ownerRevision)
      || terminal.operationDigest!==protocolDigest(operation) || terminal.bindingDigest!==operation.bindingDigest
      || protocolDigest(terminal.scope)!==protocolDigest(operation.scope) || terminal.lifecycleRevision!==head.revision || terminal.settledStatus!==head.status)throw Error('ORDINARY_OPERATION_INTEGRITY_FAILED');
    return terminal;
  }
  /** Private original-Hub reaction. The Hub's existing terminal mutation and
   * this write set are committed by ONE original persistState, never here. */
  function terminalReaction(projectId,projectDisposition,previousProject,context) {
    if(!terminalAuthority || context?.requestSource!=='scheduler' || context.authority!==terminalAuthority)throw Error('PROJECT_INPUT_AUTHORITY_REQUIRED');
    if(!['closed','deleted'].includes(projectDisposition) || previousProject?.id!==projectId
      || projectDisposition==='closed'&&projects.get(projectId)?.status!=='closed'
      || projectDisposition==='deleted'&&projects.has(projectId))throw Error('ORDINARY_OPERATION_INTEGRITY_FAILED');
    const operations=[...receipts.values()].filter(receipt=>receipt.projectId===projectId&&receipt.kind==='ordinary_input_operation');
    if(!operations.length)return;
    const binding=readBinding(projectId);
    if(!storageReady() || binding.classification!=='ordinary' || !binding.binding.scope)throw Error('PROTECTED_PROTOCOL_STORAGE_REQUIRED');
    const bindingDigest=protocolDigest(binding.binding),ownerRevision=previousProject.projectRevision+1;
    if(!Number.isSafeInteger(ownerRevision)||ownerRevision<2)throw Error('ORDINARY_OPERATION_INTEGRITY_FAILED');
    // Validate the entire original set before staging any terminal transition.
    for(const operation of operations){
      if(operation.bindingDigest!==bindingDigest || !sameScope(operation.scope,binding.binding.scope))throw Error('ORDINARY_OPERATION_INTEGRITY_FAILED');
      operationView(operation);
    }
    let voided=false;
    for(const operation of operations){
      const head=heads.get(headKey(operation.operationId)),pending=operation.action==='add_plan_input'&&head.status==='accepted_pending';
      const status=pending?'voided':head.status,nextRevision=head.revision+1;
      if(!Number.isSafeInteger(nextRevision))throw Error('ORDINARY_OPERATION_INTEGRITY_FAILED');
      const receipt={id:terminalKey(operation.operationId,projectDisposition,ownerRevision),kind:'ordinary_input_owner_terminal_receipt',schemaVersion:1,
        projectId,operationId:operation.operationId,scope:clone(operation.scope),operationDigest:protocolDigest(operation),bindingDigest,
        projectDisposition,previousOwnerRevision:previousProject.projectRevision,ownerRevision,lifecycleRevision:nextRevision,settledStatus:status,
        reasonCode:'PROJECT_TERMINAL_REQUIRES_REOPEN'};
      if(receipts.has(receipt.id))throw Error('ORDINARY_OPERATION_INTEGRITY_FAILED');
      receipts.set(receipt.id,receipt);heads.set(head.id,{...head,revision:nextRevision,status,terminalReceiptRef:receipt.id});voided ||= pending;
    }
    const project=projects.get(projectId);
    if(project){project.projectRevision=ownerRevision;if(voided)project.ordinaryInputRevision=(project.ordinaryInputRevision??0)+1;}
  }
  function planState(projectId,binding,project) {
    const task=binding.binding.initialPlanning?.contract?.protocol===TASK_ADDITIVE_INITIAL_PLAN,additive=task||binding.binding.initialPlanning?.contract?.protocol===ADDITIVE_INITIAL_PLAN;
    const protocol=task?TASK_ADDITIVE_INITIAL_PLAN:ADDITIVE_INITIAL_PLAN,descriptor=task?TASK_ADDITIVE_DESCRIPTOR:ADDITIVE_INITIAL_PLAN_DESCRIPTOR;
    const enqueueKey='initial-plan:'+protocolDigest([task?'main-initial-plan-additive-v2':additive?'main-initial-plan-additive-v1':'main-initial-plan-v3',binding.binding.scope,binding.binding.initialPlanning?.canonicalCreateOperationId,binding.binding.canonicalCreateDigest,projectId,1]);
    return {planGeneration:1,planInputRevision:project.ordinaryInputRevision ?? 0,
      enqueueKey,
      ownerBinding:{protocol:additive?protocol:'ordinary_initial_plan_v1',projectId,...clone(binding.binding.scope),...(additive?{acceptanceSchemaVersion:descriptor.acceptanceSchemaVersion,semanticSchemaVersion:descriptor.semanticSchemaVersion,handlerDigest:descriptor.handlerDigest,writerFloorDigest:descriptor.writerFloorDigest}:{}),
        canonicalCreateOperationId:binding.binding.initialPlanning?.canonicalCreateOperationId,canonicalCreateDigest:binding.binding.canonicalCreateDigest,enqueueKey,planGeneration:1},
      startPolicy:binding.createReceipt.snapshot.requestedStartPolicy};
  }
  const hasMainPlanningOwner=binding=>{
    const owner=binding.binding.initialPlanning;
    if(owner?.producer!=='desktop_main_v1'||owner.planGeneration!==1||typeof owner.canonicalCreateOperationId!=='string')return false;
    if(!Object.hasOwn(owner,'contract'))return Object.keys(owner).every(key=>['producer','planGeneration','canonicalCreateOperationId'].includes(key));
    return acceptanceOwner?.profileMatches(binding)===true&&Object.keys(owner).every(key=>['producer','planGeneration','canonicalCreateOperationId','contract'].includes(key));
  };
  function readInitialPlanInputs(projectId,token) {
    const authorized=authorize(projectId,token,['desktop_control','initial_planner']);
    if (!authorized.ok) return authorized;
    if(['closed','delivered'].includes(authorized.project.status))return deny('PROJECT_TERMINAL_REQUIRES_REOPEN');
    if (!hasMainPlanningOwner(authorized.binding)) return deny('INITIAL_PLAN_OWNER_UNVERIFIED');
    const reservation=receipts.get(claimKey(projectId));
    return {ok:true,...planState(projectId,authorized.binding,authorized.project),...(acceptanceOwner?.isTaskProtocol(projectId)?{taskOwner:acceptanceOwner.taskClaimEnvelope(projectId),projectRevision:authorized.project.projectRevision,poAgent:authorized.project.poAgent}:{}),...(!reservation&&acceptanceOwner?.isNew(projectId)?{projectControlDigest:acceptanceOwner.controlDigest(projectId)}:{}),reservation:clone(reservation ?? null),
      commitReceipt:clone(reservation?receipts.get(reservation.commitCommandId) ?? null:null)};
  }
  function readOrdinaryProjectFollowupContext(projectId,token) {
    const authorized=authorize(projectId,token,['desktop_control']);if(!authorized.ok)return authorized;
    const {project,binding}=authorized;
    if(!Number.isSafeInteger(project.projectRevision)||project.projectRevision<1)return deny('PROJECT_REVISION_INVALID');
    if(!['created','planning','active','delivered','closed'].includes(project.status))return deny('PROJECT_INPUT_STATE_UNAVAILABLE');
    const primaryRoomId=project.primaryRoomId??null;
    if(primaryRoomId!==null&&(typeof primaryRoomId!=='string'||!primaryRoomId||primaryRoomId.length>256||primaryRoomId.trim()!==primaryRoomId||primaryRoomId.includes('\0')))return deny('PROJECT_SCOPE_UNVERIFIED');
    // Explicit projection only: never spread the project, binding, health or
    // an extensible scope object into a source/read capability response.
    return {ok:true,protocol:'ordinary_project_followup_context_v1',classification:'ordinary',projectId,
      projectRevision:project.projectRevision,projectStatus:project.status,primaryRoomId,
      scope:{profileId:binding.binding.scope.profileId,workspaceId:binding.binding.scope.workspaceId},
      bindingDigest:protocolDigest(binding.binding),canonicalCreateDigest:binding.binding.canonicalCreateDigest,
      conversionActions:{add_task:{eligible:false,reasonCode:'CANDIDATE_WORKSPACE_UNAVAILABLE'},add_revision:{eligible:false,reasonCode:'REVISION_BASE_NOT_READY'}}};
  }
  function readOrdinaryProjectOperation(projectId,operationId,token) {
    const authorized=authorize(projectId,token,['desktop_control','initial_planner','user_input'],true);
    if (!authorized.ok) return authorized;
    if(authorized.authority.kind==='user_input'&&authorized.authority.source.schemaVersion===3
      &&(authorized.authority.source.projectId!==projectId||authorized.authority.source.projectBindingDigest!==protocolDigest(authorized.binding.binding)))return deny('PROJECT_INPUT_AUTHORITY_REQUIRED');
    if(authorized.authority.kind==='user_input'&&authorized.authority.source.schemaVersion===3&&authorized.project&&authorized.project.primaryRoomId!==authorized.authority.source.roomId)return deny('PROJECT_SCOPE_MISMATCH');
    const receipt=receipts.get(operationId);
    if (!receipt || receipt.projectId!==projectId || receipt.kind!=='ordinary_input_operation') return deny(authorized.project?'OPERATION_NOT_FOUND':'PROJECT_NOT_FOUND');
    if (authorized.authority.kind==='user_input' && operationKey(authorized.authority.source,projectId)!==operationId) return deny('PROJECT_INPUT_AUTHORITY_REQUIRED');
    if(receipt.bindingDigest!==protocolDigest(authorized.binding.binding)||!sameScope(receipt.scope,authorized.binding.binding.scope))throw Error('ORDINARY_OPERATION_INTEGRITY_FAILED');
    if(!authorized.project && readTerminalReceipt(receipt,heads.get(headKey(operationId)))?.projectDisposition!=='deleted')return deny('PROJECT_NOT_FOUND');
    return operationView(receipt);
  }
  function applyOrdinaryProjectInput(projectId,input,token) {
    const authorized=authorize(projectId,token,['user_input']);
    if (!authorized.ok) return authorized;
    const {authority,project,binding}=authorized,source=authority.source;
    if (!input || !['add_task','add_plan_input','add_revision'].includes(input.action)) return deny('ORDINARY_INPUT_ACTION_INVALID');
    if (input.sourceMessageId!==source.canonicalMessageId || typeof input.body!=='string' || input.body.length===0
      || Buffer.byteLength(input.body,'utf8')>65536 || contentHash(input.body)!==source.promptSha256) return deny('USER_INPUT_SOURCE_MISMATCH');
    if (!Number.isSafeInteger(input.expectedProjectRevision) || input.expectedProjectRevision<1) return deny('PROJECT_REVISION_INVALID');
    // Main attests the exact original user text. Parsed model instructions can
    // propose an action; they cannot replace its source body or elevate plan mode.
    // protocolDigest canonicalizes JSON; promptSha256 hashes raw UTF-8 text.
    if(source.schemaVersion===3&&!roomUserSourceMatchesInput(source,projectId,protocolDigest(binding.binding),input))return deny('USER_INPUT_SOURCE_MISMATCH');
    const operationId=operationKey(source,projectId),envelopeDigest=protocolDigest(['ordinary-input-envelope-v1',projectId,input]);
    const previous=receipts.get(operationId);
    if (previous) {
      if(source.schemaVersion===3&&project.primaryRoomId!==source.roomId)return deny('PROJECT_SCOPE_MISMATCH');
      if (previous.projectId!==projectId || previous.envelopeDigest!==envelopeDigest) return deny('OPERATION_ENVELOPE_CONFLICT');
      return operationView(previous);
    }
    let reasonCode;
    if (['delivered','closed'].includes(project.status)) reasonCode='PROJECT_TERMINAL_REQUIRES_REOPEN';
    else if (!['created','planning','active'].includes(project.status)) reasonCode='PROJECT_INPUT_STATE_UNAVAILABLE';
    else if (input.expectedProjectRevision!==project.projectRevision) reasonCode='PROJECT_REVISION_CONFLICT';
    else if (source.schemaVersion===3 && project.primaryRoomId!==source.roomId) reasonCode='PROJECT_SCOPE_MISMATCH';
    else if (input.action==='add_plan_input' && !hasMainPlanningOwner(binding)) reasonCode='INITIAL_PLAN_OWNER_UNVERIFIED';
    else if (input.action==='add_plan_input' && (project.status!=='created' || receipts.has(claimKey(projectId)))) reasonCode='PLAN_INPUT_WINDOW_CLOSED';
    // These two actions require the candidate/dispatch capability contract. They
    // stay explicit rejections until those production capabilities are certified.
    else if (input.action!=='add_plan_input') reasonCode=input.action==='add_revision'?'REVISION_BASE_NOT_READY':'CANDIDATE_WORKSPACE_UNAVAILABLE';
    const receipt={id:operationId,operationId,kind:'ordinary_input_operation',schemaVersion:1,projectId,
      scope:clone(binding.binding.scope),action:input.action,sourceMessageId:source.canonicalMessageId,
      authorizingUserTaskId:source.canonicalUserTaskId,contentHash:source.promptSha256,
      ...(source.schemaVersion===3?{sourceFamily:source.sourceFamily,sourceSchemaVersion:3,originRefs:{kind:'room_message',captureId:source.captureId,roomId:source.roomId,roomMessageId:source.roomMessageId,messageSequence:source.messageSequence,messageSha256:source.messageSha256}}:{sourceThreadId:source.threadId}),
      envelopeDigest,expectedProjectRevision:input.expectedProjectRevision,bindingDigest:protocolDigest(binding.binding),
      outcome:reasonCode?'rejected':'accepted',...(reasonCode?{reasonCode}:{})};
    return transact(projectId,()=>{
      receipts.set(operationId,receipt);
      heads.set(headKey(operationId),{id:headKey(operationId),kind:'ordinary_input_lifecycle',schemaVersion:1,projectId,
        revision:1,operationDigest:protocolDigest(receipt),status:reasonCode?'rejected':'accepted_pending'});
      if (!reasonCode) {
        project.ordinaryInputBodies={...project.ordinaryInputBodies,[operationId]:input.body};
        project.ordinaryInputRevision=(project.ordinaryInputRevision ?? 0)+1;
        project.projectRevision+=1;
      }
      return operationView(receipt);
    });
  }
  function applyOrdinaryTaskMetadataInput(projectId,value,context){
    if(context?.requestSource!=='user')return deny('PROJECT_INPUT_AUTHORITY_REQUIRED');
    const authorized=authorize(projectId,context.projectInputAuthority,['user_input']);if(!authorized.ok)return authorized;
    let input;try{input=readOrdinaryTaskMetadataEnvelope(value);}catch(error){if(!(error instanceof InitialPlanSemanticSchemaError))throw error;return deny('ORDINARY_TASK_INPUT_INVALID');}
    const {authority,project,binding}=authorized,source=authority.source;
    if(input.sourceMessageId!==source.canonicalMessageId||contentHash(input.body)!==source.promptSha256)return deny('USER_INPUT_SOURCE_MISMATCH');
    if(source.schemaVersion===3&&!roomUserSourceMatchesInput(source,projectId,protocolDigest(binding.binding),input))return deny('USER_INPUT_SOURCE_MISMATCH');
    if(source.schemaVersion===3&&project.primaryRoomId!==source.roomId)return deny('PROJECT_SCOPE_MISMATCH');
    // A composite is one immutable command identity. Authenticate BOTH live
    // opaque authorities before replay, without re-running historical CAS.
    let claimInput;
    if(context.initialPlanClaim!==undefined){
      const planner=authorize(projectId,context.initialPlanningAuthority,['initial_planner']);if(!planner.ok)return planner;
      try{claimInput=readTaskInitialClaimInput(context.initialPlanClaim);}catch(error){if(!(error instanceof InitialPlanSemanticSchemaError))throw error;return deny('INITIAL_PLAN_CLAIM_CONFLICT');}
    }
    const operationId=operationKey(source,projectId),envelopeDigest=protocolDigest(['ordinary-task-metadata-envelope-v2',projectId,input,claimInput??null]),previous=receipts.get(operationId);
    if(previous)return previous.projectId===projectId&&previous.envelopeDigest===envelopeDigest?operationView(previous):deny('OPERATION_ENVELOPE_CONFLICT');
    if(binding.binding.initialPlanning?.contract?.protocol!==TASK_ADDITIVE_INITIAL_PLAN)return deny('TASK_ADDITIVE_CONTRACT_REQUIRED');
    if(!acceptanceOwner.profileMatches(binding)||typeof recordTaskAddition!=='function')return deny('INITIAL_PLAN_PROFILE_UNQUALIFIED');
    let preparedClaim;
    if(claimInput){
      preparedClaim=prepareInitialPlanClaim(projectId,claimInput,context.initialPlanningAuthority,{operationId,envelopeDigest});
      if(!preparedClaim.prepared)return preparedClaim;
    }
    let reasonCode;
    if(['delivered','closed'].includes(project.status))reasonCode='PROJECT_TERMINAL_REQUIRES_REOPEN';
    else if(!['created','planning'].includes(project.status)||project.plan)reasonCode='PROJECT_INPUT_STATE_UNAVAILABLE';
    else if(input.expectedProjectRevision!==project.projectRevision)reasonCode='PROJECT_REVISION_CONFLICT';
    else if(source.schemaVersion===3&&project.primaryRoomId!==source.roomId)reasonCode='PROJECT_SCOPE_MISMATCH';
    const base={id:operationId,operationId,kind:'ordinary_input_operation',schemaVersion:1,projectId,scope:clone(binding.binding.scope),action:'add_task',
      sourceMessageId:source.canonicalMessageId,authorizingUserTaskId:source.canonicalUserTaskId,contentHash:source.promptSha256,
      ...(source.schemaVersion===3?{sourceFamily:source.sourceFamily,sourceSchemaVersion:3,originRefs:{kind:'room_message',captureId:source.captureId,roomId:source.roomId,roomMessageId:source.roomMessageId,messageSequence:source.messageSequence,messageSha256:source.messageSha256}}:{sourceThreadId:source.threadId}),
      envelopeDigest,expectedProjectRevision:input.expectedProjectRevision,bindingDigest:protocolDigest(binding.binding)};
    let operation={...base,outcome:'accepted',taskReceiptId:operationId+':task-addition',...(preparedClaim?{compositeReservationId:claimKey(projectId)}:{})},prepared;
    if(!reasonCode){
      const tasks=input.tasks??[{title:input.title??input.body.trim().slice(0,120),brief:Object.hasOwn(input,'brief')?input.brief:input.body}];
      prepared=acceptanceOwner.prepareTaskAddition(projectId,operation,tasks);if(!prepared.ok)reasonCode=prepared.error;
    }
    if(reasonCode)operation={...base,outcome:'rejected',reasonCode};
    const saveRejected=()=>transact(projectId,()=>{receipts.set(operationId,operation);heads.set(headKey(operationId),{id:headKey(operationId),kind:'ordinary_input_lifecycle',schemaVersion:1,projectId,revision:1,operationDigest:protocolDigest(operation),status:'rejected'});});
    if(reasonCode){saveRejected();return operationView(operation);}
    try{
      transact(projectId,()=>{
        const added=acceptanceOwner.commitPreparedTaskAddition(projectId,prepared.token);
        if(!added.ok){const error=Error(added.error);error.ordinaryTaskRejection=added.error;throw error;}
        project.ordinaryInputBodies={...project.ordinaryInputBodies,[operationId]:input.body};project.ordinaryInputRevision=(project.ordinaryInputRevision??0)+1;
        project.status='planning';project.projectRevision+=1;
        receipts.set(operationId,operation);heads.set(headKey(operationId),{id:headKey(operationId),kind:'ordinary_input_lifecycle',schemaVersion:1,projectId,revision:1,operationDigest:protocolDigest(operation),status:'applied'});
        recordTaskAddition(projectId,operationId,added.taskIds);
        if(preparedClaim)commitPreparedInitialClaim(preparedClaim.prepared,false);
      });
    }catch(error){if(!error?.ordinaryTaskRejection)throw error;operation={...base,outcome:'rejected',reasonCode:error.ordinaryTaskRejection};saveRejected();}
    return operationView(operation);
  }
  function voidOrdinaryPlanInput(projectId,input,token) {
    const authorized=authorize(projectId,token,['desktop_control']);
    if (!authorized.ok) return authorized;
    const receipt=receipts.get(input?.operationId),head=heads.get(headKey(input?.operationId));
    if (!receipt || receipt.projectId!==projectId || receipt.kind!=='ordinary_input_operation' || receipt.action!=='add_plan_input' || !head) return deny('OPERATION_NOT_FOUND');
    if (head.status==='voided') return operationView(receipt);
    if (head.status!=='accepted_pending' || receipts.has(claimKey(projectId))) return deny('PLAN_INPUT_ALREADY_CONSUMED');
    if (input.expectedPlanInputRevision!==(authorized.project.ordinaryInputRevision ?? 0)) return deny('PLAN_INPUT_REVISION_CONFLICT');
    return transact(projectId,()=>{
      heads.set(head.id,{...head,revision:head.revision+1,status:'voided'});
      authorized.project.ordinaryInputRevision+=1;
      authorized.project.projectRevision+=1;
      return operationView(receipt);
    });
  }
  function prepareInitialPlanClaim(projectId,input,token,composite) {
    const authorized=authorize(projectId,token,['initial_planner']);
    if (!authorized.ok) return authorized;
    const {project,binding}=authorized,state=planState(projectId,binding,project);
    const taskProtocol=acceptanceOwner?.isTaskProtocol(projectId);
    if(taskProtocol){try{input=readTaskInitialClaimInput(input);}catch(error){if(!(error instanceof InitialPlanSemanticSchemaError))throw error;return deny('INITIAL_PLAN_CLAIM_CONFLICT');}}
    if(['closed','delivered'].includes(project.status))return deny('PROJECT_TERMINAL_REQUIRES_REOPEN');
    if (!hasMainPlanningOwner(binding)) return deny('INITIAL_PLAN_OWNER_UNVERIFIED');
    if (!input || typeof input.planRunId!=='string' || !input.planRunId || input.planRunId.length>256
      || input.enqueueKey!==state.enqueueKey || input.planGeneration!==state.planGeneration || input.startPolicy!==state.startPolicy) return deny('INITIAL_PLAN_CLAIM_CONFLICT');
    const additive=acceptanceOwner?.isNew(projectId),task=acceptanceOwner?.isTaskProtocol(projectId);
    const id=claimKey(projectId),requestDigest=protocolDigest(composite?['initial-plan-claim-composite-v2',input,composite.operationId,composite.envelopeDigest]:[task?'initial-plan-claim-additive-v2':additive?'initial-plan-claim-additive-v1':'initial-plan-claim-v1',input]),previous=receipts.get(id);
    if(composite&&(!task||previous))return deny('INITIAL_PLAN_CLAIM_CONFLICT');
    if (previous) return previous.requestDigest===requestDigest?claimResult(project,previous,true):deny('INITIAL_PLAN_CLAIM_CONFLICT');
    if(additive){const checked=acceptanceOwner.beforeClaim(projectId,input);if(!checked.ok)return checked;}
    if (!['created','planning'].includes(project.status)) return deny('INITIAL_PLAN_STATE_UNAVAILABLE');
    if (input.expectedPlanInputRevision!==state.planInputRevision) return deny('PLAN_INPUT_REVISION_CONFLICT');
    const pending=[...receipts.values()].filter(receipt=>receipt.kind==='ordinary_input_operation' && receipt.projectId===projectId
      && receipt.action==='add_plan_input' && heads.get(headKey(receipt.operationId))?.status==='accepted_pending').sort((a,b)=>a.operationId.localeCompare(b.operationId));
    for (const receipt of pending) {
      if (typeof project.ordinaryInputBodies?.[receipt.operationId]!=='string') return deny('PLAN_INPUT_BODY_UNAVAILABLE');
      if (contentHash(project.ordinaryInputBodies[receipt.operationId])!==receipt.contentHash) return deny('PLAN_INPUT_BODY_INTEGRITY_FAILED');
      operationView(receipt); // Integrity before any consumed transition.
    }
    const reservation={id,kind:'initial_plan_reservation',schemaVersion:task?3:additive?2:1,projectId,scope:clone(binding.binding.scope),...(additive?{contract:task?TASK_ADDITIVE_INITIAL_PLAN:ADDITIVE_INITIAL_PLAN,poAgent:project.poAgent}:{}),...(task?{...acceptanceOwner.taskClaimEnvelope(projectId),claimRequest:clone(input)}:{}),
      enqueueKey:input.enqueueKey,planRunId:input.planRunId,planGeneration:input.planGeneration,startPolicy:state.startPolicy,
      planInputRevision:state.planInputRevision,consumedMessageIds:pending.map(receipt=>receipt.sourceMessageId),
      consumedOperationIds:pending.map(receipt=>receipt.operationId),requestDigest,
      commitCommandId:'initial-plan-submit:'+protocolDigest(additive?[task?TASK_ADDITIVE_INITIAL_PLAN:ADDITIVE_INITIAL_PLAN,id,input.enqueueKey,input.planRunId]:[id,input.enqueueKey,input.planRunId]),ownerRevision:project.projectRevision+1,...(composite?{compositeRequest:clone(input),compositeTaskOperationId:composite.operationId,compositeEnvelopeDigest:composite.envelopeDigest}:{})};
    const prepared=Object.freeze(Object.create(null));
    preparedClaims.set(prepared,{projectId,project,bindingDigest:protocolDigest(binding.binding),beforeRevision:project.projectRevision,beforeInputRevision:state.planInputRevision,pending:pending.map(receipt=>({receipt,head:clone(heads.get(headKey(receipt.operationId)))})),reservation,additive,composite});
    return{ok:true,prepared};
  }
  function commitPreparedInitialClaim(prepared,incrementRevision){
    const state=preparedClaims.get(prepared);if(!state)throw Error('INITIAL_PLAN_PREPARED_CLAIM_UNVERIFIED');preparedClaims.delete(prepared);
    const {projectId,project,reservation,pending,additive}=state;
    if(projects.get(projectId)!==project||protocolDigest(readBinding(projectId).binding)!==state.bindingDigest
      ||project.projectRevision!==state.beforeRevision+(incrementRevision?0:1)
      ||(project.ordinaryInputRevision??0)!==state.beforeInputRevision+(incrementRevision?0:1)
      ||receipts.has(reservation.id))throw Error('INITIAL_PLAN_PREPARED_CLAIM_UNVERIFIED');
    for(const {receipt,head} of pending){if(receipts.get(receipt.operationId)!==receipt||protocolDigest(heads.get(head.id))!==protocolDigest(head))throw Error('INITIAL_PLAN_PREPARED_CLAIM_UNVERIFIED');}
    for(const {receipt} of pending){const head=heads.get(headKey(receipt.operationId));heads.set(head.id,{...head,revision:head.revision+1,status:'applied',initialPlanReservationId:reservation.id});}
    receipts.set(reservation.id,reservation);if(incrementRevision)project.projectRevision+=1;
    if(additive)acceptanceOwner.born(projectId,reservation);return claimResult(project,reservation);
  }
  function claimInitialPlanInputs(projectId,input,token){
    const prepared=prepareInitialPlanClaim(projectId,input,token);if(!prepared.prepared)return prepared;
    return transact(projectId,()=>commitPreparedInitialClaim(prepared.prepared,true),input);
  }
  function claimResult(project,reservation,reused=false) {
    const inputs=[];
    for (const operationId of reservation.consumedOperationIds) {
      const receipt=receipts.get(operationId),head=heads.get(headKey(operationId)),body=project.ordinaryInputBodies?.[operationId];
      if (!receipt || receipt.projectId!==project.id || typeof body!=='string') return deny('PLAN_INPUT_BODY_UNAVAILABLE');
      if (contentHash(body)!==receipt.contentHash || head?.status!=='applied' || head.initialPlanReservationId!==reservation.id) return deny('PLAN_INPUT_BODY_INTEGRITY_FAILED');
      inputs.push({operationId,sourceMessageId:receipt.sourceMessageId,contentHash:receipt.contentHash,body});
    }
    return {ok:true,...(reused?{reused:true}:{}),reservation:clone(reservation),inputs};
  }
  function commitInitialPlan(projectId,input,token) {
    const authorized=authorize(projectId,token,['initial_planner']);
    if (!authorized.ok) return authorized;
    const {project,binding}=authorized,reservation=receipts.get(claimKey(projectId)),additive=acceptanceOwner?.isNew(projectId),task=acceptanceOwner?.isTaskProtocol(projectId);
    if (!hasMainPlanningOwner(binding) || !reservation || !input || input.reservationId!==reservation.id
      || input.planRunId!==reservation.planRunId || input.enqueueKey!==reservation.enqueueKey
      || input.commandId!==reservation.commitCommandId || input.fromAgent!==(additive?reservation.poAgent:project.poAgent)) return deny('INITIAL_PLAN_CLAIM_REQUIRED');
    const envelopeDigest=protocolDigest([task?'initial-plan-submit-additive-v2':additive?'initial-plan-submit-additive-v1':'initial-plan-submit-v1',input]),previous=receipts.get(input.commandId);
    if (previous) return previous.envelopeDigest===envelopeDigest
      ? {ok:previous.outcome==='applied',reused:true,receipt:clone(previous),...(previous.reasonCode?{error:previous.reasonCode}:{})}
      : deny('INITIAL_PLAN_COMMAND_CONFLICT');
    let reasonCode,acceptedTail;
    if(additive){const checked=acceptanceOwner.validateCommit(projectId,input);if(!checked.ok){if(checked.error==='INITIAL_PLAN_PROJECTION_UNVERIFIED')return checked;reasonCode=checked.error;}else acceptedTail=checked.head?.tailProjectRevision;}
    if (!reasonCode&&['delivered','closed'].includes(project.status)) reasonCode='PROJECT_TERMINAL_REQUIRES_REOPEN';
    else if (!reasonCode&&!['created','planning'].includes(project.status)) reasonCode='INITIAL_PLAN_STATE_UNAVAILABLE';
    else if (!reasonCode&&(input.expectedProjectRevision!==reservation.ownerRevision || project.projectRevision!==(task?acceptedTail:reservation.ownerRevision))) reasonCode='PROJECT_REVISION_CONFLICT';
    else if (!reasonCode&&project.plan) reasonCode='INITIAL_PLAN_COMPETING_WRITE';
    else if (!reasonCode&&(!input.plan || typeof input.plan!=='object' || Array.isArray(input.plan) || !Array.isArray(input.plan.phases)
      || !Array.isArray(input.tasks) || input.tasks.length>200 || Buffer.byteLength(JSON.stringify(input),'utf8')>2097152)) reasonCode='INITIAL_PLAN_PAYLOAD_INVALID';
    const makeReceipt=(outcome,reasonCode,taskIds=[])=>({id:input.commandId,kind:'initial_plan_commit_receipt',schemaVersion:task?3:additive?2:1,projectId,...(additive?{contract:task?TASK_ADDITIVE_INITIAL_PLAN:ADDITIVE_INITIAL_PLAN,scope:clone(binding.binding.scope)}:{}),
      reservationId:reservation.id,planRunId:reservation.planRunId,envelopeDigest,outcome,taskIds,
      ownerRevision:projects.get(projectId).projectRevision,...(reasonCode?{reasonCode}:{})});
    if (reasonCode) return transact(projectId,()=>{
      const receipt=makeReceipt('rejected',reasonCode);receipts.set(receipt.id,receipt);if(additive)acceptanceOwner.rejected(projectId,receipt.id);return {ok:false,error:reasonCode,receipt:clone(receipt)};
    },input);
    try {
      return transact(projectId,()=>{
        const beforeTasks=task?acceptanceOwner.snapshotTaskRows(projectId):undefined;
        const result=applyPlan(projectId,input.plan,input.tasks,input.fromAgent);
        if (!result.ok) {const error=Error(result.error);error.ordinaryPlanRejection=result;throw error;}
        project.projectRevision+=1;
        const receipt=makeReceipt('applied',undefined,result.taskIds);receipts.set(receipt.id,receipt);if(additive)acceptanceOwner.committed(projectId,input,result.taskIds,beforeTasks);
        return {ok:true,receipt:clone(receipt)};
      },input);
    } catch(error) {
      if (!error?.ordinaryPlanRejection) throw error;
      return transact(projectId,()=>{
        const receipt=makeReceipt('rejected',error.ordinaryPlanRejection.error);receipts.set(receipt.id,receipt);if(additive)acceptanceOwner.rejected(projectId,receipt.id);
        return {ok:false,error:receipt.reasonCode,receipt:clone(receipt)};
      },input);
    }
  }
  function readInitialPlanAcceptanceHead(projectId,token){const result=authorize(projectId,token,['desktop_control','initial_planner'],true);return result.ok?acceptanceOwner.read(projectId):result;}
  return {readInitialPlanAcceptanceHead,applyOrdinaryTaskMetadataInput,applyOrdinaryProjectInput,readOrdinaryProjectOperation,readOrdinaryProjectFollowupContext,readInitialPlanInputs,claimInitialPlanInputs,voidOrdinaryPlanInput,commitInitialPlan,terminalReaction};
}
