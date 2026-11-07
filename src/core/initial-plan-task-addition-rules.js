import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {TASK_ADDITIVE_INITIAL_PLAN,TASK_ADDITIVE_DESCRIPTOR,TASK_WRITER_PROFILE,TASK_WRITER_DIGEST,semanticWriterForFloor} from './initial-plan-acceptance-contract.js';
import {protocolDigest} from './project-protocol.js';
import {readOrdinaryTaskAdditionInput,readTaskAdditionSemanticSnapshot,readTaskAdditionOwnerRecord,InitialPlanSemanticSchemaError} from './initial-plan-semantic-schema.js';
import {validateAdditiveTaskGraphPolicies,validateTaskPlanUnionPolicies} from './task-graph-policies.js';
import {proveTaskAdditionTransition,taskAdditionProofDigest,verifyTaskAdditionProofChain} from './initial-plan-task-additive-proof.js';

export class TaskAdditionStateError extends Error {}
const fail=code=>{throw new TaskAdditionStateError(code);};
const deny=error=>({ok:false,error});
const known=error=>error instanceof TaskAdditionStateError||error instanceof InitialPlanSemanticSchemaError;
const sha=value=>createHash('sha256').update(value,'utf8').digest('hex');
const same=(left,right)=>{if(!isDeepStrictEqual(left,right))fail('TASK_ADDITION_INTEGRITY_FAILED');};
const claimId=projectId=>'initial-plan:'+protocolDigest(['initial-plan-reservation-v1',projectId,1]);
const receiptId=operationId=>operationId+':task-addition';
const headId=claim=>claim.id+':acceptance';
const baselineId=claim=>claim.id+':task-baseline';
const deltaId=(head,ordinal)=>head.id+':delta:'+ordinal;
const rowKey=(collection,id)=>JSON.stringify([collection,id]);
const rowInputKeys=['id','title','brief','description','requirements','acceptanceCriteria','assignedAgent','assignee','dependencies','dependencyPolicy','phaseId','planItemId','type','maxAttempts','maxQualityReworks','requiredOutputs','requiredCapabilities','executionGateSchemaVersion','executionContract','evidenceContract','composite','requiresIndependentReview','reviewAgent','reviewBrief','finalBrief','projectId','localTaskId','displayTaskId','legacyTaskId','dependencyRefs','isCompositeParent','childTaskIds','parentTaskId','compositeStatus','compositeRole','reviewOfTaskId'];
const taskRow=task=>({taskId:task.id,rowDigest:protocolDigest(task),inputDigest:protocolDigest(Object.fromEntries(rowInputKeys.filter(key=>Object.hasOwn(task,key)).map(key=>[key,task[key]])))});

/** Internal rules of the ORIGINAL acceptance controller, using its existing
 * maps, backend handle and original factory ports. Never binds another backend,
 * saves independently, launches work, or returns a writable frame/capability.
 * The root controller must enforce common projection provenance before stage.
 * The incomplete profile remains disabled in the closed writer registry. */
export function createTaskAdditionProtocolRules({persistence,backend,projects,boards,receipts,heads,readBinding,related,floor,prepareTasks,commitTasks}){
 const markers=new Map(),commits=new Map(),planPreparations=new Map();
 function scopeEqual(left,right){return left?.profileId===right?.profileId&&left?.workspaceId===right?.workspaceId;}
 function isProtocol(projectId){return readBinding(projectId).binding?.initialPlanning?.contract?.protocol===TASK_ADDITIVE_INITIAL_PLAN;}
 function qualified(binding){
  const value=floor();return value?.schemaVersion===3&&value.profile===TASK_WRITER_PROFILE&&value.writerProfileDigest===TASK_WRITER_DIGEST
   &&semanticWriterForFloor(value)?.writable===true&&scopeEqual(value.scope,binding?.binding?.scope)
   &&isDeepStrictEqual(binding.binding?.initialPlanning?.contract,TASK_ADDITIVE_DESCRIPTOR)
   &&binding.createReceipt?.snapshot.initialPlanWriterStoreId===value.storeId;
 }
 function bindingFor(projectId){const binding=readBinding(projectId);if(binding.classification!=='ordinary'||!qualified(binding))fail('INITIAL_PLAN_PROFILE_UNQUALIFIED');return binding;}
 function envelope(projectId,binding){return{projectId,scope:structuredClone(binding.binding.scope),writerStoreId:floor().storeId,
  bindingDigest:protocolDigest(binding.binding),createReceiptDigest:protocolDigest(binding.createReceipt),contract:TASK_ADDITIVE_INITIAL_PLAN};}
 function readRows(){return new Map(backend.rows().map(row=>[rowKey(row.collection,row.key),row]));}
 function physical(record,collection,rows){const row=rows.get(rowKey(collection,record.id));if(!row||row.projectId!==record.projectId||row.value.projectId!==record.projectId||protocolDigest(row.value)!==protocolDigest(record))fail('TASK_ADDITION_PHYSICAL_STATE_UNVERIFIED');}
 function raw(projectId,candidates){const project=candidates?.get(projectId)??projects.get(projectId),tasks=boards.get(projectId)?.getAllTasks();if(!project||!tasks)fail('TASK_ADDITION_STATE_UNAVAILABLE');return{project,tasks,related:related(projectId)};}
 function snapshot(projectId,candidates){return readTaskAdditionSemanticSnapshot(raw(projectId,candidates));}
 function physicalSnapshot(projectId,rows){
  const project=rows.get(rowKey('project',projectId)),board=rows.get(rowKey('board',projectId));
  if(!project||!board||project.projectId!==projectId||board.projectId!==projectId||board.value.projectId!==projectId)fail('TASK_ADDITION_PHYSICAL_STATE_UNVERIFIED');
  const kinds={workflowRuns:'workflowRun',workflowProposals:'workflowProposal',finalDeliverables:'finalDeliverable',reviewGateDecisions:'reviewGateDecision',reviewConditions:'reviewCondition'};
  return readTaskAdditionSemanticSnapshot({project:project.value,tasks:board.value.tasks,related:Object.fromEntries(Object.entries(kinds).map(([name,kind])=>[name,[...rows.values()].filter(row=>row.collection===kind&&row.projectId===projectId).map(row=>row.value)]))});
 }
 function assertEnvelope(record,projectId,binding){const expected=envelope(projectId,binding);for(const [key,value] of Object.entries(expected))same(record[key],value);}
 function stagedSource(projectId,operation,head){
  const marker=markers.get(projectId)?.marker;if(!marker?.stagedReceipt||marker.operation.id!==operation.id)return false;
  same(operation,marker.operation);same(head,{id:operation.id+':lifecycle',kind:'ordinary_input_lifecycle',schemaVersion:1,projectId,revision:1,operationDigest:protocolDigest(operation),status:'applied'});return true;
 }
 function operationFor(record,projectId,binding,rows){
  const operation=receipts.get(record.operationId),head=heads.get(record.operationId+':lifecycle');
  if(!operation||operation.kind!=='ordinary_input_operation'||operation.schemaVersion!==1||operation.projectId!==projectId||operation.action!=='add_task'
    ||operation.outcome!=='accepted'||operation.taskReceiptId!==record.id||operation.bindingDigest!==protocolDigest(binding.binding)||!scopeEqual(operation.scope,binding.binding.scope)
    ||protocolDigest(operation)!==record.operationDigest||operation.envelopeDigest!==record.envelopeDigest||operation.contentHash!==record.bodyHash
    ||!head||head.kind!=='ordinary_input_lifecycle'||head.schemaVersion!==1||head.projectId!==projectId||head.id!==operation.id+':lifecycle'
    ||head.operationDigest!==record.operationDigest||head.status!=='applied')fail('TASK_ADDITION_OPERATION_UNVERIFIED');
  if(!stagedSource(projectId,operation,head)){physical(operation,'protocolReceipt',rows);physical(head,'protocolHead',rows);}return operation;
 }
 function checkedTaskReceipt(id,projectId,binding,rows){
  const record=readTaskAdditionOwnerRecord(receipts.get(id));if(record.kind!=='ordinary_task_addition_receipt'||record.id!==receiptId(record.operationId))fail('TASK_ADDITION_INTEGRITY_FAILED');
  assertEnvelope(record,projectId,binding);const staged=markers.get(projectId)?.marker?.stagedReceipt;
  if(staged&&receipts.get(id)===staged)same(record,staged);else physical(record,'protocolReceipt',rows);operationFor(record,projectId,binding,rows);
  if(record.ownerRevision!==record.semanticProof.afterRevision||record.operationId!==record.semanticProof.operationId||record.bodyHash!==record.semanticProof.bodyHash
   ||record.projectId!==record.semanticProof.projectId||record.taskRows.length===0)fail('TASK_ADDITION_INTEGRITY_FAILED');
  same(record.policyDelta,record.semanticProof.policyDelta);same(record.taskRows.map(row=>({taskId:row.taskId,rowDigest:row.rowDigest})),record.semanticProof.addedTaskRows);
  return record;
 }
 function verifyBodies(projectId,semantic,binding,rows,claim){
  for(const [id,body] of Object.entries(semantic.project.ordinaryInputBodies??{})){
   const operation=receipts.get(id),head=heads.get(id+':lifecycle');
   if(!operation||operation.id!==id||operation.kind!=='ordinary_input_operation'||operation.schemaVersion!==1||operation.projectId!==projectId
    ||operation.outcome!=='accepted'||!['add_task','add_plan_input'].includes(operation.action)||operation.bindingDigest!==protocolDigest(binding.binding)
    ||!scopeEqual(operation.scope,binding.binding.scope)||sha(body)!==operation.contentHash||!head||head.id!==id+':lifecycle'||head.projectId!==projectId
    ||head.kind!=='ordinary_input_lifecycle'||head.schemaVersion!==1||head.operationDigest!==protocolDigest(operation)
    ||!['accepted_pending','applied','voided'].includes(head.status))fail('TASK_ADDITION_BODY_UNVERIFIED');
   if(stagedSource(projectId,operation,head))continue;
   physical(operation,'protocolReceipt',rows);
   if(claim&&operation.action==='add_plan_input'&&claim.consumedOperationIds.includes(id)){
    const old=rows.get(rowKey('protocolHead',head.id))?.value;if(!old||old.status!=='accepted_pending')fail('TASK_ADDITION_BODY_UNVERIFIED');
    same(head,{...old,revision:old.revision+1,status:'applied',initialPlanReservationId:claim.id});
   }else physical(head,'protocolHead',rows);
  }
 }
 function pristine(projectId,view,binding,rows,refs,claim){
  const candidates=refs??[...receipts.values()].filter(record=>record.projectId===projectId&&record.kind==='ordinary_task_addition_receipt').map(record=>({id:record.id,digest:protocolDigest(record)}));
  const records=candidates.map(ref=>{const record=checkedTaskReceipt(ref.id,projectId,binding,rows);if(protocolDigest(record)!==ref.digest)fail('TASK_ADDITION_INTEGRITY_FAILED');return record;}).sort((left,right)=>left.ownerRevision-right.ownerRevision);
  if(new Set(records.map(record=>record.ownerRevision)).size!==records.length)fail('TASK_ADDITION_INTEGRITY_FAILED');
  const expectedRows=[],policies={},seen=new Set();
  for(const record of records){
   if(sha(view.semantic.project.ordinaryInputBodies?.[record.operationId]??'')!==record.bodyHash)fail('TASK_ADDITION_BODY_UNVERIFIED');
   for(const row of record.taskRows){if(seen.has(row.taskId))fail('TASK_ADDITION_INTEGRITY_FAILED');seen.add(row.taskId);expectedRows.push(row);}
   for(const [id,value] of record.policyDelta){if(Object.hasOwn(policies,id))fail('TASK_ADDITION_INTEGRITY_FAILED');policies[id]=value;}
  }
  same(view.semantic.tasks.map(taskRow),expectedRows);same(view.semantic.project.dependencyPolicies,policies);verifyBodies(projectId,view.semantic,binding,rows,claim);
  return{records,refs:records.map(record=>({id:record.id,digest:protocolDigest(record)})),taskRows:expectedRows,policyDigest:protocolDigest(policies)};
 }
 function checkedHead(projectId,rows){
  const binding=bindingFor(projectId),claim=readTaskAdditionOwnerRecord(receipts.get(claimId(projectId)));
  if(claim.kind!=='initial_plan_reservation'||[...receipts.values()].filter(record=>record.projectId===projectId&&record.kind==='initial_plan_reservation').length!==1)fail('INITIAL_PLAN_ACCEPTANCE_INTEGRITY_FAILED');
  assertEnvelope(claim,projectId,binding);physical(claim,'protocolReceipt',rows);
  const request=claim.claimRequest;
  if(request.fromAgent!==claim.poAgent||request.enqueueKey!==claim.enqueueKey||request.planRunId!==claim.planRunId||request.planGeneration!==claim.planGeneration
   ||request.startPolicy!==claim.startPolicy||request.expectedPlanInputRevision!==claim.planInputRevision
   ||claim.commitCommandId!=='initial-plan-submit:'+protocolDigest([TASK_ADDITIVE_INITIAL_PLAN,claim.id,claim.enqueueKey,claim.planRunId])
   ||claim.consumedOperationIds.length!==claim.consumedMessageIds.length||new Set(claim.consumedOperationIds).size!==claim.consumedOperationIds.length
   ||new Set(claim.consumedMessageIds).size!==claim.consumedMessageIds.length)fail('INITIAL_PLAN_ACCEPTANCE_INTEGRITY_FAILED');
  const expectedRequestDigest=Object.hasOwn(claim,'compositeRequest')?protocolDigest(['initial-plan-claim-composite-v2',request,claim.compositeTaskOperationId,claim.compositeEnvelopeDigest]):protocolDigest(['initial-plan-claim-additive-v2',request]);
  if(claim.requestDigest!==expectedRequestDigest)fail('INITIAL_PLAN_ACCEPTANCE_INTEGRITY_FAILED');
  if(Object.hasOwn(claim,'compositeRequest')){
   same(claim.compositeRequest,request);const operation=receipts.get(claim.compositeTaskOperationId);
   if(!operation||operation.compositeReservationId!==claim.id||operation.envelopeDigest!==claim.compositeEnvelopeDigest)fail('INITIAL_PLAN_ACCEPTANCE_INTEGRITY_FAILED');
  }
  same(claim.consumedOperationIds,[...claim.consumedOperationIds].sort((left,right)=>left.localeCompare(right)));
  for(let index=0;index<claim.consumedOperationIds.length;index++){
   const operation=receipts.get(claim.consumedOperationIds[index]),head=operation&&heads.get(operation.id+':lifecycle');
   if(!operation||operation.kind!=='ordinary_input_operation'||operation.action!=='add_plan_input'||operation.outcome!=='accepted'||operation.projectId!==projectId
    ||operation.bindingDigest!==protocolDigest(binding.binding)||!scopeEqual(operation.scope,binding.binding.scope)||operation.sourceMessageId!==claim.consumedMessageIds[index]
    ||!head||head.kind!=='ordinary_input_lifecycle'||head.status!=='applied'||head.initialPlanReservationId!==claim.id||head.operationDigest!==protocolDigest(operation))fail('INITIAL_PLAN_ACCEPTANCE_INTEGRITY_FAILED');
   physical(operation,'protocolReceipt',rows);physical(head,'protocolHead',rows);
  }
  const head=readTaskAdditionOwnerRecord(heads.get(headId(claim))),base=readTaskAdditionOwnerRecord(receipts.get(baselineId(claim)));
  if(head.kind!=='initial_plan_acceptance_head'||base.kind!=='initial_plan_acceptance_baseline'||head.id!==headId(claim)||base.id!==baselineId(claim))fail('INITIAL_PLAN_ACCEPTANCE_INTEGRITY_FAILED');
  for(const record of [head,base]){assertEnvelope(record,projectId,binding);if(record.claimDigest!==protocolDigest(claim))fail('INITIAL_PLAN_ACCEPTANCE_INTEGRITY_FAILED');}
  physical(head,'protocolHead',rows);physical(base,'protocolReceipt',rows);
  if(head.baselineId!==base.id||head.baselineDigest!==protocolDigest(base)||head.baseProjectRevision!==claim.ownerRevision||base.ownerRevision!==claim.ownerRevision
   ||head.baseSemanticDigest!==base.semanticDigest||head.deltaCount>200||head.tailProjectRevision!==claim.ownerRevision+head.deltaCount
   ||head.revision!==head.deltaCount+(head.state==='valid'?1:2))fail('INITIAL_PLAN_ACCEPTANCE_INTEGRITY_FAILED');
  return{binding,claim,head,base};
 }
 function current(projectId,view,rows){
  const state=checkedHead(projectId,rows);if(state.head.state!=='valid')return deny('INITIAL_PLAN_ACCEPTANCE_INVALIDATED');
  if(view.digest!==state.head.tailSemanticDigest||view.projectRevision!==state.head.tailProjectRevision)return deny('INITIAL_PLAN_ACCEPTANCE_INVALIDATED');
  const proofs=[],refs=[...state.base.taskReceiptRefs];let previousDelta=null,previousProof=null;
  for(let ordinal=1;ordinal<=state.head.deltaCount;ordinal++){
   const delta=readTaskAdditionOwnerRecord(receipts.get(deltaId(state.head,ordinal)));assertEnvelope(delta,projectId,state.binding);physical(delta,'protocolReceipt',rows);
   if(delta.kind!=='initial_plan_additive_delta'||delta.id!==deltaId(state.head,ordinal)||delta.ordinal!==ordinal||delta.previousDeltaDigest!==previousDelta||delta.claimDigest!==protocolDigest(state.claim)
    ||delta.fromProjectRevision!==state.head.baseProjectRevision+ordinal-1||delta.toProjectRevision!==delta.fromProjectRevision+1||delta.fromHeadRevision!==ordinal||delta.toHeadRevision!==ordinal+1)fail('INITIAL_PLAN_ACCEPTANCE_INTEGRITY_FAILED');
   const receipt=checkedTaskReceipt(delta.taskReceiptId,projectId,state.binding,rows),proof=receipt.semanticProof;
   if(protocolDigest(receipt)!==delta.taskReceiptDigest||taskAdditionProofDigest(proof)!==delta.semanticProofDigest||proof.previousProofDigest!==previousProof||proof.ordinal!==ordinal)fail('INITIAL_PLAN_ACCEPTANCE_INTEGRITY_FAILED');
   proofs.push(proof);refs.push({id:receipt.id,digest:protocolDigest(receipt)});previousDelta=protocolDigest(delta);previousProof=taskAdditionProofDigest(proof);
  }
  if(previousDelta!==state.head.prevDeltaDigest)fail('INITIAL_PLAN_ACCEPTANCE_INTEGRITY_FAILED');
  const baseView=verifyTaskAdditionProofChain({current:view.semantic,bornDigest:state.base.semanticDigest,proofs});
  const base=pristine(projectId,baseView,state.binding,rows,state.base.taskReceiptRefs);same(base.taskRows,state.base.taskRows);if(base.policyDigest!==state.base.policyDigest)fail('INITIAL_PLAN_ACCEPTANCE_INTEGRITY_FAILED');
  const all=[...receipts.values()].filter(record=>record.projectId===projectId&&record.kind==='ordinary_task_addition_receipt').map(record=>record.id).sort();same(all,refs.map(ref=>ref.id).sort());
  verifyBodies(projectId,view.semantic,state.binding,rows);return{ok:true,...state,view,previousProof};
 }
 function before(projectId){
  const binding=bindingFor(projectId),rows=readRows(),view=snapshot(projectId);same(view.semantic,physicalSnapshot(projectId,rows).semantic);
  const claim=[...receipts.values()].find(record=>record.projectId===projectId&&record.kind==='initial_plan_reservation');
  if(claim){const state=current(projectId,view,rows);if(!state.ok)return state;return{ok:true,binding,rows,view,state};}
  const baseline=pristine(projectId,view,binding,rows);return{ok:true,binding,rows,view,baseline};
 }
 return Object.freeze({
  isProtocol,qualified,claimEnvelope:projectId=>envelope(projectId,bindingFor(projectId)),
  readTaskReceipt(projectId,id){return structuredClone(checkedTaskReceipt(id,projectId,bindingFor(projectId),readRows()));},
  beforeClaim(projectId,input){try{const state=before(projectId);if(!state.ok)return state;if(input.expectedProjectControlDigest!==state.view.digest)return deny('INITIAL_PLAN_CONTROL_CONFLICT');return{ok:true};}catch(error){if(!known(error))throw error;return deny(error.message);}},
  controlDigest:projectId=>snapshot(projectId).digest,
  read(projectId){try{return{ok:true,head:structuredClone(checkedHead(projectId,readRows()).head)};}catch(error){if(!known(error))throw error;return deny('INITIAL_PLAN_ACCEPTANCE_UNAVAILABLE');}},
  validateCommit(projectId,input){try{
   const rows=readRows(),view=snapshot(projectId);same(view.semantic,physicalSnapshot(projectId,rows).semantic);const state=current(projectId,view,rows);if(!state.ok)return state;
   const prepared=prepareTasks(projectId,projects.get(projectId),boards.get(projectId),input.tasks);if(!prepared.ok)return prepared;
   const policies=validateTaskPlanUnionPolicies({projectId,existingTasks:view.semantic.tasks,originalTaskList:input.tasks,expandedTaskInputs:prepared.prepared.tasks,
    identityPreviewTasks:prepared.identityPreview,dependencyPolicies:view.semantic.project.dependencyPolicies,policyWrites:prepared.policyWrites});if(!policies.ok)return policies;
   planPreparations.set(projectId,{inputDigest:protocolDigest(input),globalRevision:persistence.getHealth().revision,beforeTasks:structuredClone(boards.get(projectId).getAllTasks()),
    taskIds:prepared.identityPreview.map(task=>task.id),policies:{...view.semantic.project.dependencyPolicies,...Object.fromEntries(policies.policyDelta)}});return state;
  }catch(error){if(!known(error))throw error;return deny('INITIAL_PLAN_ACCEPTANCE_INVALIDATED');}},
  prepare(projectId,operation,inputTasks){
   try{
    if(markers.has(projectId)||commits.has(projectId))fail('TASK_ADDITION_OWNER_BUSY');
    const state=before(projectId);if(!state.ok)return state;
    const inputs=readOrdinaryTaskAdditionInput(inputTasks);if(!inputs.length)return deny('ORDINARY_TASK_INPUT_INVALID');
    const allocated=inputs.map((task,index)=>({...task,id:'user-'+protocolDigest(['ordinary-task-id-v2',operation.id,index])}));
    const project=projects.get(projectId),board=boards.get(projectId),prepared=prepareTasks(projectId,project,board,allocated);if(!prepared.ok)return prepared;
    const policies=validateAdditiveTaskGraphPolicies({projectId,existingTasks:state.view.semantic.tasks,originalTaskList:allocated,
     identityPreviewTasks:prepared.identityPreview,dependencyPolicies:state.view.semantic.project.dependencyPolicies,policyWrites:prepared.policyWrites});if(!policies.ok)return policies;
    const marker={project,board,globalRevision:persistence.getHealth().revision,projectRevision:project.projectRevision,beforeRaw:structuredClone(raw(projectId)),state,operation:structuredClone(operation),prepared,policyDelta:policies.policyDelta,committed:false};
    const token=Object.freeze(Object.create(null));markers.set(projectId,{token,marker});return{ok:true,token};
   }catch(error){if(!known(error))throw error;return deny(error.message);}
  },
  commitPrepared(projectId,token){
   const entry=markers.get(projectId),marker=entry?.marker;if(!entry||entry.token!==token||marker.committed||projects.get(projectId)!==marker.project||boards.get(projectId)!==marker.board
    ||marker.project.projectRevision!==marker.projectRevision||persistence.getHealth().revision!==marker.globalRevision)fail('TASK_ADDITION_PREPARED_UNVERIFIED');
   const result=commitTasks(marker.project,marker.board,marker.prepared);if(!result.ok)return result;
   marker.taskIds=[...result.taskIds];marker.rows=structuredClone(marker.board.getAllTasks().slice(marker.state.view.semantic.tasks.length));marker.committed=true;return result;
  },
  hasMutation:projectId=>markers.has(projectId)||commits.has(projectId),
  committed(projectId,input,taskIds,beforeTasks){
   const prepared=planPreparations.get(projectId);if(!prepared||prepared.inputDigest!==protocolDigest(input)||prepared.globalRevision!==persistence.getHealth().revision)fail('INITIAL_PLAN_COMMAND_PREPARED_UNVERIFIED');
   same(beforeTasks,prepared.beforeTasks);same(taskIds,prepared.taskIds);same(projects.get(projectId).dependencyPolicies,prepared.policies);
   commits.set(projectId,{input:structuredClone(input),taskIds:[...taskIds],beforeTasks:structuredClone(beforeTasks),afterProject:structuredClone(projects.get(projectId)),afterTasks:structuredClone(boards.get(projectId).getAllTasks())});
  },
  born(projectId,claim,candidates,birthIds){
   const binding=bindingFor(projectId),view=snapshot(projectId,candidates),rows=readRows(),baseline=pristine(projectId,view,binding,rows,undefined,claim);
   if(view.projectRevision!==claim.ownerRevision)fail('INITIAL_PLAN_ACCEPTANCE_INTEGRITY_FAILED');
   const base=readTaskAdditionOwnerRecord({id:baselineId(claim),kind:'initial_plan_acceptance_baseline',schemaVersion:1,...envelope(projectId,binding),claimDigest:protocolDigest(claim),ownerRevision:claim.ownerRevision,
    semanticDigest:view.digest,taskReceiptRefs:baseline.refs,taskRows:baseline.taskRows,policyDigest:baseline.policyDigest});
   const head=readTaskAdditionOwnerRecord({id:headId(claim),kind:'initial_plan_acceptance_head',schemaVersion:2,...envelope(projectId,binding),claimDigest:protocolDigest(claim),baselineId:base.id,baselineDigest:protocolDigest(base),revision:1,state:'valid',
    baseProjectRevision:claim.ownerRevision,tailProjectRevision:claim.ownerRevision,baseSemanticDigest:view.digest,tailSemanticDigest:view.digest,deltaCount:0,prevDeltaDigest:null});
   if(receipts.has(base.id)||heads.has(head.id))fail('INITIAL_PLAN_ACCEPTANCE_INTEGRITY_FAILED');receipts.set(base.id,base);heads.set(head.id,head);
   birthIds.push(rowKey('protocolReceipt',claim.id),rowKey('protocolReceipt',base.id),rowKey('protocolHead',head.id));
  },
  stage(projectId,candidates,birthIds,projectionVerified=true){
   const addition=markers.get(projectId)?.marker,commit=commits.get(projectId);
   if(addition){
    if(!addition.committed||projects.get(projectId)!==addition.project||boards.get(projectId)!==addition.board||persistence.getHealth().revision!==addition.globalRevision)fail('TASK_ADDITION_PREPARED_UNVERIFIED');
    const operation=receipts.get(addition.operation.id);same(operation,addition.operation);
    same(boards.get(projectId).getAllTasks().slice(addition.state.view.semantic.tasks.length),addition.rows);
    const afterRaw=raw(projectId,candidates),state=addition.state.state,ordinal=state?state.head.deltaCount+1:1;
    const proof=proveTaskAdditionTransition({before:addition.beforeRaw,after:afterRaw,projectId,operationId:operation.id,expectedBodyHash:operation.contentHash,addedTaskIds:addition.taskIds,
     policyDelta:addition.policyDelta,ordinal,previousProofDigest:state?state.previousProof:null});
    const record=readTaskAdditionOwnerRecord({id:receiptId(operation.id),kind:'ordinary_task_addition_receipt',schemaVersion:1,...envelope(projectId,addition.state.binding),
     operationId:operation.id,operationDigest:protocolDigest(operation),envelopeDigest:operation.envelopeDigest,bodyHash:operation.contentHash,ownerRevision:proof.afterRevision,
     taskRows:readTaskAdditionSemanticSnapshot(afterRaw).semantic.tasks.slice(addition.state.view.semantic.tasks.length).map(taskRow),policyDelta:addition.policyDelta,semanticProof:proof});
    if(receipts.has(record.id))fail('TASK_ADDITION_INTEGRITY_FAILED');receipts.set(record.id,record);addition.stagedReceipt=record;birthIds.push(rowKey('protocolReceipt',record.id));
    if(state){
     const delta=readTaskAdditionOwnerRecord({id:deltaId(state.head,ordinal),kind:'initial_plan_additive_delta',schemaVersion:1,...envelope(projectId,state.binding),claimDigest:protocolDigest(state.claim),
      ordinal,previousDeltaDigest:state.head.prevDeltaDigest,taskReceiptId:record.id,taskReceiptDigest:protocolDigest(record),semanticProofDigest:taskAdditionProofDigest(proof),
      fromProjectRevision:state.head.tailProjectRevision,toProjectRevision:proof.afterRevision,fromHeadRevision:state.head.revision,toHeadRevision:state.head.revision+1});
     if(receipts.has(delta.id))fail('TASK_ADDITION_INTEGRITY_FAILED');receipts.set(delta.id,delta);birthIds.push(rowKey('protocolReceipt',delta.id));
     heads.set(state.head.id,{...state.head,revision:state.head.revision+1,tailProjectRevision:proof.afterRevision,tailSemanticDigest:proof.afterDigest,deltaCount:ordinal,prevDeltaDigest:protocolDigest(delta)});
    }
    return;
   }
   const rawHead=[...heads.values()].find(record=>record.projectId===projectId&&record.kind==='initial_plan_acceptance_head');if(!rawHead||rawHead.state!=='valid')return;
   if(commit){
    const state=checkedHead(projectId,readRows());same(boards.get(projectId).getAllTasks(),commit.afterTasks);same(commit.afterTasks.slice(0,commit.beforeTasks.length),commit.beforeTasks);
    same(projects.get(projectId),commit.afterProject);same(commit.afterTasks.slice(commit.beforeTasks.length).map(task=>task.id),commit.taskIds);
    birthIds.push(rowKey('protocolReceipt',commit.input.commandId));heads.set(state.head.id,{...state.head,revision:state.head.revision+1,state:'committed',commitCommandId:commit.input.commandId});return;
   }
   let valid=false;try{if(projectionVerified){const state=current(projectId,snapshot(projectId,candidates),readRows());valid=state.ok;}}catch(error){if(!known(error))throw error;}
   if(!valid){
    const state=checkedHead(projectId,readRows()),audit=readTaskAdditionOwnerRecord({id:state.head.id+':invalidated:'+state.head.revision,kind:'initial_plan_acceptance_invalidation',schemaVersion:2,
     ...envelope(projectId,state.binding),headDigest:protocolDigest(state.head),reasonCode:'UNPROVEN_OWNER_CHANGE'});
    if(receipts.has(audit.id))fail('INITIAL_PLAN_ACCEPTANCE_INTEGRITY_FAILED');receipts.set(audit.id,audit);birthIds.push(rowKey('protocolReceipt',audit.id));heads.set(state.head.id,{...state.head,revision:state.head.revision+1,state:'invalidated',invalidationReceiptId:audit.id});
   }
  },
  clearScope(scope){for(const map of [markers,commits,planPreparations])for(const id of map.keys())if(scope.type==='full'||scope.projectId===id)map.delete(id);},
  abort(projectId){markers.delete(projectId);commits.delete(projectId);planPreparations.delete(projectId);},
 });
}
