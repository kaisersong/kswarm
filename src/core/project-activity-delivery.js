import {randomUUID} from 'node:crypto';
import {protocolDigest} from './project-protocol.js';
import {deriveExecutionGraph,deriveProjectLifecycle,selectApprovedFinalDeliverable} from './project-read-model.js';
const FIELD='activityDeliveryHead',MAX_REFS=128;
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const hash=/^[a-f0-9]{64}$/;
const states=new Set(['created','planning','ready_to_start','active','running','blocked','ready_to_deliver','delivered','closed','legacy_needs_reconciliation','unknown']);
const actions=new Set(['review_final_deliverable','confirm_final_deliverable','revise_plan','resolve_project_blocker','activate_project']);
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const id=value=>typeof value==='string'&&value.length>0&&value.length<=256;
const closed=(value,keys)=>plain(value)&&Object.keys(value).length===keys.length&&Object.keys(value).every(key=>keys.includes(key));
const validationErrors=new WeakSet();
const deliveryError=message=>{const error=Error(message);validationErrors.add(error);return error;};
const fail=()=>{throw deliveryError('project_activity_delivery_integrity_failed');};
export const isProjectDeliveryValidationError=error=>validationErrors.has(error);
const factId=(projectId,epoch,incarnation,revision)=>'project-delivery:'+protocolDigest([projectId,epoch,incarnation,revision]);
const semanticDigest=(core,inputDigest)=>protocolDigest(['project-delivery-attention-v1',core,inputDigest]);
const sorted=values=>[...new Set(values)].sort((a,b)=>a<b?-1:a>b?1:0);
const sortedRows=values=>values.sort((a,b)=>JSON.stringify(a)<JSON.stringify(b)?-1:JSON.stringify(a)>JSON.stringify(b)?1:0);
// These are private derivation inputs, not a transported body or permission.
const withoutPresentationTimes=value=>plain(value)
 ?Object.fromEntries(Object.entries(value).filter(([key])=>!['createdAt','updatedAt','derivedAt'].includes(key)))
 :value;
export function deriveProjectDeliveryAttention(input){
 const lifecycle=deriveProjectLifecycle(input),graph=deriveExecutionGraph(input),project=input.project;
 const finals=input.finalDeliverables??[],candidates=finals.filter(item=>['candidate','under_review'].includes(item.status));
 const evidenceRefs=sorted(candidates.map(item=>item.deliverableId));
 const diagnostics=sorted((lifecycle.issues??[]).map(item=>item.kind));
 const action=lifecycle.primaryAction?.strategy??null;
 const unverified=!states.has(lifecycle.state)||action!==null&&!actions.has(action)||diagnostics.some(kind=>['legacy_status_drift','legacy_final_deliverable_needs_confirmation'].includes(kind))
  ||evidenceRefs.length>MAX_REFS||candidates.some(item=>!id(item.deliverableId)||!hash.test(item.submissionFingerprint??''));
 const ready=!unverified&&!['delivered','closed'].includes(project.status)&&lifecycle.state==='ready_to_deliver'&&action==='review_final_deliverable';
 const core={stage:unverified?'unavailable':ready?'ready_for_acceptance':'none',lifecycleState:states.has(lifecycle.state)?lifecycle.state:'unknown',action:actions.has(action)?action:null,
  diagnostics:diagnostics.slice(0,32),evidenceRefs:evidenceRefs.length<=MAX_REFS?evidenceRefs:[]};
 const inputDigest=protocolDigest({projectStatus:project.status,planRevisionTask:project.planRevisionRequired?.taskId??null,
  approvedSelection:selectApprovedFinalDeliverable(finals)?.deliverableId??null,
  graph:sortedRows(graph.nodes.map(node=>[node.stableNodeId,node.taskId??null,node.workflowRunId??null,node.workflowNodeId??null,node.status,node.required!==false,node.expectedDeliverableKind,node.expectedFormat,node.ownership])),
  finals:sortedRows(finals.map(item=>[item.deliverableId,item.status,item.submissionFingerprint??null,item.serviceComputedHash??null,item.approval??null])),
  reviews:sortedRows((input.tasks??[]).map(task=>[task.id,task.reviewResult??null])),workflowReviews:sortedRows((input.workflowRuns??[]).map(run=>[run.id,run.gateDecision??null])),
  gates:sortedRows((input.reviewGateDecisions??[]).map(withoutPresentationTimes)),conditions:sortedRows((input.reviewConditions??[]).map(withoutPresentationTimes))});
 return{core,inputDigest,semanticDigest:semanticDigest(core,inputDigest)};
}
/** Checks a source head against the actual committed project, not its own IDs. */
export function readProjectDeliveryHead(value,project){
 if(!closed(value,['schemaVersion','kind','projectId','sourceDataEpoch','incarnation','deliveryRevision','factId','semanticDigest','inputDigest','core','recordDigest'])
  ||value.schemaVersion!==1||value.kind!=='project_delivery_attention'||value.projectId!==project.id||value.sourceDataEpoch!==project.activityDataEpoch
  ||!uuid.test(value.sourceDataEpoch??'')||!uuid.test(value.incarnation??'')||!Number.isSafeInteger(value.deliveryRevision)||value.deliveryRevision<1
  ||!hash.test(value.semanticDigest??'')||!hash.test(value.inputDigest??'')||!hash.test(value.recordDigest??''))fail();
 const core=value.core;
 if(!closed(core,['stage','lifecycleState','action','diagnostics','evidenceRefs'])||!['none','ready_for_acceptance','unavailable'].includes(core.stage)||!states.has(core.lifecycleState)
  ||core.action!==null&&!actions.has(core.action)||!Array.isArray(core.diagnostics)||core.diagnostics.length>32||core.diagnostics.some(item=>!id(item))
  ||!Array.isArray(core.evidenceRefs)||core.evidenceRefs.length>MAX_REFS||core.evidenceRefs.some(item=>!id(item))
  ||protocolDigest(core.diagnostics)!==protocolDigest(sorted(core.diagnostics))||protocolDigest(core.evidenceRefs)!==protocolDigest(sorted(core.evidenceRefs)))fail();
 const{recordDigest,...record}=value;
 if(Buffer.byteLength(JSON.stringify(value))>65536||value.factId!==factId(project.id,project.activityDataEpoch,value.incarnation,value.deliveryRevision)
  ||value.semanticDigest!==semanticDigest(core,value.inputDigest)||recordDigest!==protocolDigest(record))fail();
 return structuredClone(value);
}
// An unknown display is not authority to reject or re-run a business action.
// Preserve the actual previous committed bytes (including absence/null/false).
function preserveUnknown(project,committed){
 const original=committed??project;
 if(Object.hasOwn(original,FIELD))project[FIELD]=structuredClone(original[FIELD]);
 else delete project[FIELD];
 project.activityDeliveryUnavailable=true;
}
function previousHead(project,committed){
 if(Object.hasOwn(project,'activityDeliveryUnavailable')&&typeof project.activityDeliveryUnavailable!=='boolean')fail();
 const has=Object.hasOwn(project,FIELD),previous=has?readProjectDeliveryHead(project[FIELD],project):null;
 if(!has&&project.activityDeliveryUnavailable===true)fail();
 if(committed){
  const had=Object.hasOwn(committed,FIELD);
  if(had){
   const old=readProjectDeliveryHead(committed[FIELD],{id:project.id,activityDataEpoch:committed.activityDataEpoch});
   if(!previous||old.recordDigest!==previous.recordDigest)fail();
  }else if(has)fail();
 }
 return previous;
}
/** Only called in the original Hub candidate/save path; never from GET. */
export function stageProjectDeliveryAttention(project,input,committed){
 try{
  if(project.id!==input.project.id||!uuid.test(project.activityDataEpoch??''))fail();
  const previous=previousHead(project,committed);
  const wasUnavailable=project.activityDeliveryUnavailable===true||committed?.activityDeliveryUnavailable===true;
  const next=deriveProjectDeliveryAttention(input);
  if(!wasUnavailable&&previous?.semanticDigest===next.semanticDigest)return previous;
  const deliveryRevision=(previous?.deliveryRevision??0)+1;
  if(!Number.isSafeInteger(deliveryRevision))throw deliveryError('project_activity_delivery_revision_exhausted');
  const incarnation=previous?.incarnation??randomUUID(),record={schemaVersion:1,kind:'project_delivery_attention',projectId:project.id,sourceDataEpoch:project.activityDataEpoch,incarnation,deliveryRevision,
   factId:factId(project.id,project.activityDataEpoch,incarnation,deliveryRevision),...next};
  const head=readProjectDeliveryHead({...record,recordDigest:protocolDigest(record)},project);project[FIELD]=head;project.activityDeliveryUnavailable=false;return head;
 }catch(error){
  if(!isProjectDeliveryValidationError(error))throw error;
  preserveUnknown(project,committed);
 }
}
/** Compatibility writers can invalidate, never certify or resurrect a head. */
export function markProjectDeliveryUnqualified(project,input,committed){
 if(committed?.activityDeliveryUnavailable===true){preserveUnknown(project,committed);return;}
 try{
  const head=previousHead(project,committed);if(!head)return;
  if(deriveProjectDeliveryAttention(input).semanticDigest!==head.semanticDigest)preserveUnknown(project,committed);
 }catch(error){
  if(!isProjectDeliveryValidationError(error))throw error;
  preserveUnknown(project,committed);
 }
}
/** Captured privately by the original save owner before the write-set freeze. */
export function projectDeliveryWriteWitness(project){
 const fields=[FIELD,'activityDeliveryUnavailable'].map(field=>[Object.hasOwn(project,field),typeof project[field],project[field]]);
 return Object.freeze({digest:protocolDigest(fields)});
}
export function projectDeliveryReadView(committed){
 if(Object.hasOwn(committed,'activityDeliveryUnavailable')&&(committed.activityDeliveryUnavailable===true||typeof committed.activityDeliveryUnavailable!=='boolean'))return{status:'unavailable',reasonCode:'SNAPSHOT_INCOMPLETE'};
 if(!Object.hasOwn(committed,FIELD))return{status:'unavailable',reasonCode:'SNAPSHOT_INCOMPLETE'};
 try{return{status:'current',head:readProjectDeliveryHead(committed[FIELD],{id:committed.projectId,activityDataEpoch:committed.activityDataEpoch})};}
 catch{return{status:'unavailable',reasonCode:'SNAPSHOT_INCOMPLETE'};}
}
/** Recompute from the exact detached write set after the original owner freeze. */
export function assertProjectDeliveryWriteSet(rows,expectedProjects){
 const projects=rows.filter(row=>row.collection==='project');
 if(projects.length!==expectedProjects.size)throw Error('project_activity_delivery_write_set_conflict');
 const seen=new Set();
 for(const row of projects){
  const project=row.value,expected=expectedProjects.get(row.key);
  if(!expected||seen.has(row.key)||row.projectId!==row.key||project.id!==row.key
   ||projectDeliveryWriteWitness(project).digest!==expected.digest)throw Error('project_activity_delivery_write_set_conflict');
  seen.add(row.key);
  if(Object.hasOwn(project,'activityDeliveryUnavailable')&&typeof project.activityDeliveryUnavailable!=='boolean')fail();
  if(project.activityDeliveryUnavailable===true){
   continue;
  }
  if(!Object.hasOwn(project,FIELD))continue;
  const head=readProjectDeliveryHead(project[FIELD],project);
  const related=collection=>rows.filter(item=>item.projectId===project.id&&item.collection===collection).map(item=>item.value);
  const board=related('board');if(board.length!==1)fail();
  const derived=deriveProjectDeliveryAttention({project,tasks:board[0].tasks,workflowRuns:related('workflowRun'),finalDeliverables:related('finalDeliverable'),reviewGateDecisions:related('reviewGateDecision'),reviewConditions:related('reviewCondition')});
  if(derived.semanticDigest!==head.semanticDigest)throw Error('project_activity_delivery_write_set_conflict');
 }
}
