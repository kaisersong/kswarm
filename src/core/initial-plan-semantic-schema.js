import {readProjectDeliveryHead} from './project-activity-delivery.js';
import {types} from 'node:util';
import {protocolDigest} from './project-protocol.js';
import {PROJECT_ACTIVITY_FIELDS,assertProjectActivityBounds,projectActivitySnapshot} from './project-activity.js';
import {PROJECT_EXECUTION_MODES} from './execution-mode.js';

export class InitialPlanSemanticSchemaError extends Error {}
const bad=path=>{throw new InitialPlanSemanticSchemaError('INITIAL_PLAN_SEMANTIC_SCHEMA:'+path);};
const optional=schema=>({optional:true,schema});
const nullable=schema=>(value,path)=>value===null?null:schema(value,path);
const string=(value,path)=>typeof value==='string'?value:bad(path);
const boolean=(value,path)=>typeof value==='boolean'?value:bad(path);
const integer=(value,path)=>Number.isSafeInteger(value)&&value>=0?value:bad(path);
const positive=(value,path)=>Number.isSafeInteger(value)&&value>0?value:bad(path);
const exact=expected=>(value,path)=>value===expected?value:bad(path);
const oneOf=(...values)=>(value,path)=>values.includes(value)?value:bad(path);
const nil=exact(null);
function descriptors(value,path,array=false){
  if(!value||typeof value!=='object'||types.isProxy(value)||Object.getOwnPropertySymbols(value).length
    ||(array?!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype:Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value))))bad(path);
  const rows=Object.getOwnPropertyDescriptors(value);
  if(Object.entries(rows).some(([key,row])=>!Object.hasOwn(row,'value')||!row.enumerable&&!(array&&key==='length')))bad(path);
  return rows;
}
function preflight(value,path,budget,ancestors,depth=0){
  if(++budget.nodes>100000||depth>64)bad(path+'.budget');
  if(value===null||value===undefined||typeof value==='boolean')return;
  if(typeof value==='number'){if(!Number.isFinite(value))bad(path);return;}
  if(typeof value==='string'){budget.bytes+=Buffer.byteLength(value,'utf8');if(budget.bytes>8388608)bad(path+'.bytes');return;}
  if(ancestors.has(value))bad(path+'.cycle');
  const isArray=Array.isArray(value),rows=descriptors(value,path,isArray);
  if(Object.keys(rows).length>100000)bad(path+'.budget');
  ancestors.add(value);
  for(const [key,row] of Object.entries(rows)){
    budget.bytes+=Buffer.byteLength(key,'utf8');if(budget.bytes>8388608)bad(path+'.bytes');
    if(isArray&&key==='length')continue;
    preflight(row.value,path+'.'+key,budget,ancestors,depth+1);
  }
  ancestors.delete(value);
}
const object=fields=>(value,path)=>{
  const rows=descriptors(value,path);if(Object.keys(rows).some(key=>!Object.hasOwn(fields,key)))bad(path+'.unknown');
  const output=[];
  for(const [key,definition] of Object.entries(fields)){
    const row=rows[key],schema=definition.optional?definition.schema:definition;
    if(!row||row.value===undefined){if(definition.optional)continue;bad(path+'.'+key);}
    output.push([key,schema(row.value,path+'.'+key)]);
  }
  return Object.fromEntries(output);
};
const array=(schema,max=4096)=>(value,path)=>{
  const rows=descriptors(value,path,true);if(value.length>max||Object.keys(rows).some(key=>key!=='length'&&!/^(0|[1-9][0-9]*)$/.test(key)))bad(path);
  const output=[];for(let i=0;i<value.length;i++){if(!Object.hasOwn(rows,String(i)))bad(path);output.push(schema(rows[i].value,path+'['+i+']'));}
  if(Object.keys(rows).length!==value.length+1)bad(path);return output;
};
const map=schema=>(value,path)=>Object.fromEntries(Object.entries(descriptors(value,path)).map(([key,row])=>[key,schema(row.value,path+'.'+key)]));
const strings=array(string),emptyArray=array(string,0),emptyObject=object({});
// These are explicitly data maps in the quality library, not arbitrary control
// records. Every data byte enters the digest; no key is silently discarded.
function data(value,path,depth=0){
  if(depth>32)bad(path+'.depth');if(value===null||typeof value==='string'||typeof value==='boolean')return value;
  if(typeof value==='number')return Number.isFinite(value)?value:bad(path);
  if(Array.isArray(value))return array((v,p)=>data(v,p,depth+1))(value,path);
  return map((v,p)=>data(v,p,depth+1))(value,path);
}
const selected=object({agentId:string,source:oneOf('default_seed','explicit_user','system_migration')});
const quality=object({compilerVersion:string,ruleSetVersion:positive,createdAt:string,
  knowledgePacks:array(object({id:string,version:positive,source:string})),
  requestSignals:object({matchedPacks:strings,requiresRecentEvidence:boolean,executiveAudience:boolean,
    explicitCountRequirement:nullable(object({count:positive,operator:exact('at_least')})),softCountPreference:nullable(object({count:positive})),explicitNoWebSearch:boolean}),
  rules:array(object({id:string,packId:string,source:string,severity:string,defaultSeverity:string,appliesTo:strings,description:string,
    promptExcerpt:object({po:optional(string),worker:optional(string)}),metadata:map(data),scope:optional(data)})),
  conflicts:array(object({type:string,ruleId:string,sources:strings,resolution:string,chosenSeverity:string,needsConfirmation:boolean})),
});
const readiness=object({agentId:nullable(string),role:nullable(string),selectedBy:nullable(string),ready:boolean,readiness:string,
  reason:nullable(string),checks:strings,participantId:nullable(string),capacity:string,canCreateRuntimeInstance:nullable(boolean)});
const preparation=nullable(object({state:oneOf('ready','blocked'),checkedAt:integer,generation:positive,checks:array(readiness),
  blockers:array(object({agentId:nullable(string),role:nullable(string),selectedBy:nullable(string),reason:nullable(string),readiness:string,participantId:nullable(string),capacity:string})),replacements:emptyArray}));
const tag=(value,key,path)=>descriptors(value,path)[key]?.value;
const linkedBy=(value,path)=>object(tag(value,'kind',path)==='system'?{kind:exact('system'),service:string}:{kind:exact('user'),userId:string})(value,path);
const directory=object({dev:integer,ino:integer});
const activeMapping=object({projectId:string,roomId:string,workspaceId:string,originHostId:string,bindingId:string,generation:positive,expectedProjectRevision:positive,
  workFolder:string,artifactsDir:string,mappingRevision:positive,state:exact('active'),operationId:string,directoryIdentities:object({workFolder:directory,artifactsDir:directory})});
const mapping=(value,path)=>tag(value,'state',path)==='mapping_required'?object({state:exact('mapping_required'),roomId:string,projectId:string})(value,path):activeMapping(value,path);
const mappingOperationFields={ticketId:string,operationId:string,projectId:string,roomId:string,payloadDigest:string,mappingRevision:positive,mapping:activeMapping,status:oneOf('pending','applied')};
const mappingOperation=object(mappingOperationFields);
const sourceRefs=object({projectId:string,taskId:optional(string),artifactId:optional(string),artifact:optional(object({projectId:string,filename:string,kind:optional(string),mimeType:optional(string)}))});
const roomItemFields={projectionEventId:string,projectId:string,roomId:string,eventType:string,summary:nullable(string),sourceRefs,createdAt:integer,
  status:oneOf('pending','published','parked','suppressed_room_archived'),attempts:optional(integer),totalAttempts:optional(integer),nextAttemptAt:optional(integer),
  lastError:optional(string),publishedAt:optional(integer),suppressedAt:optional(integer)};
const roomItem=object(roomItemFields);
const projectFields={id:string,name:string,goal:optional(string),requirements:string,planningGuidance:string,qualityPlanningGuidance:string,qualityRuleSet:quality,
  agentSelection:object({poAgent:selected,members:array(selected)}),preparation,poAgent:string,members:strings,
  executionMode:(value,path)=>typeof value==='string'&&PROJECT_EXECUTION_MODES.has(value)?value:bad(path),executionModeUpdatedAt:integer,executionModeUpdatedBy:string,
  requestedStartPolicy:oneOf('plan_only','auto_activate_after_plan','activate_and_dispatch_after_plan'),status:oneOf('created','planning'),createdAt:integer,
  closedAt:nil,closedBy:nil,deliverable:nil,plan:nil,planArtifact:nil,enableSummary:boolean,summary:nil,summaryScore:nil,lifecycleVersion:integer,projectRevision:positive,teamPlan:nil,
  primaryRoomId:nullable(string),roomLink:optional(object({kind:exact('primary'),sourceMessageIds:strings,linkedBy,linkedAt:string})),
  dependencyPolicies:map(oneOf('completed','completed_for_remediation','verified_pass')),gateEvaluations:emptyObject,canonicalArtifacts:emptyObject,manifestRevision:exact(0),
  requestedOutput:nullable(object({kind:string,audience:optional(string)})),executionGateSchemaVersion:optional(exact(2)),
  clientRequestKey:optional(string),workFolder:optional(string),artifactsDir:optional(string),requiredProtocol:optional(exact('room_workspace_v1')),
  workspaceMapping:optional(mapping),workspaceMappingOperations:optional(map(mappingOperation)),
  ordinaryInputRevision:optional(integer),ordinaryInputBodies:optional(map(string)),updatedAt:optional(integer),
  roomEventSeq:optional(integer),roomEventOutbox:optional(array(roomItem)),roomOutboxRetryOperations:optional(emptyObject),
};
const activitySnapshot=object({id:string,name:string,status:string,projectRevision:integer,primaryRoomId:nullable(string),deliveredAt:nil,preparation:nullable(string),mapping:nullable(string),tasks:array(object({id:string,status:string,attempt:integer}))});
const activityEvent=object({schemaVersion:exact(1),eventId:string,source:exact('kswarm'),workId:string,sourceSequence:positive,sourceDataEpoch:string,sourceRevision:string,
  kind:string,occurredAt:integer,sourceType:string,evidenceRefs:strings,summary:optional(string),taskId:optional(string),executionStarted:optional(exact(true))});
const activityFields={activityDeliveryUnavailable:optional(boolean),activityDeliveryHead:optional(value=>value),activityDataEpoch:optional(string),activityEventSeq:optional(integer),activityEventOutbox:optional(array(activityEvent)),activitySnapshot:optional(activitySnapshot),
  committedActivitySeq:optional(integer),activityLastProgressAt:optional(integer),activityGapRanges:optional(array(object({from:positive,through:positive,reason:oneOf('retention_expired','progress_compacted','mixed_retention_compaction')})))};
const evidence=(value,path)=>{
  if(value===null)return null;
  if(tag(value,'kind',path)==='review_iteration_v1')return object({version:exact(1),kind:exact('review_iteration_v1'),requiredArtifacts:strings,requiredFields:strings})(value,path);
  if(tag(value,'required',path)===false)return object({version:positive,kind:exact('none'),required:exact(false),reason:string})(value,path);
  return object({version:oneOf(1,2),kind:oneOf('external_source_v1','external_source_v2'),required:exact(true),requiresRecentEvidence:boolean,freshnessWindowDays:positive,
    minQueries:integer,minResults:integer,minFetchedPages:integer,requireSourceUrls:boolean,disallowSpeculativeLanguage:boolean,requiredArtifact:string})(value,path);
};
const taskFields={
  id:string,title:string,brief:optional(string),description:optional(string),requirements:optional(string),
  acceptanceCriteria:optional((value,path)=>typeof value==='string'?value:strings(value,path)),assignedAgent:nullable(string),assignee:optional(string),
  dependencies:strings,dependencyPolicy:optional(map(oneOf('completed','completed_for_remediation','verified_pass'))),phaseId:optional(string),planItemId:string,type:optional(string),maxAttempts:positive,maxQualityReworks:optional(integer),
  requiredOutputs:array(object({type:string,enforcement:string,source:string})),requiredCapabilities:strings,executionGateSchemaVersion:optional(exact(2)),
  executionContract:object({version:exact(1),minSummaryChars:integer,requireMeaningfulSummary:boolean,requireArtifactForEmptySummary:boolean}),evidenceContract:evidence,
  composite:optional(boolean),requiresIndependentReview:optional(boolean),reviewAgent:optional(string),reviewBrief:optional(string),finalBrief:optional(string),
  projectId:string,localTaskId:string,displayTaskId:string,legacyTaskId:string,dependencyRefs:strings,unresolvedDependencies:emptyArray,status:exact('pending'),assignedExecutor:nil,result:nil,attempt:positive,
  failureReason:nil,failureHistory:emptyArray,runtimeFailureCount:exact(0),qualityFailureCount:exact(0),qualityReviewHistory:emptyArray,rejectedSubmissions:emptyArray,lastFailureClass:nil,
  blockedAt:nil,blockedReason:nil,blockKind:nil,nextActions:emptyArray,isCompositeParent:boolean,childTaskIds:strings,parentTaskId:nullable(string),
  activeRunId:nil,runLease:nil,runTelemetry:nil,selectedRoute:nil,preferredAssignedAgent:nil,lastRunLease:nil,recoveryStatus:nil,recoveryReason:nil,startedAt:nil,completedAt:nil,createdAt:integer,updatedAt:integer,
  compositeStatus:optional(exact('waiting_children')),compositeRole:optional(oneOf('draft','review','final')),reviewOfTaskId:optional(string),
};
const relatedSchema=object(Object.fromEntries(['workflowRuns','workflowProposals','finalDeliverables','reviewGateDecisions','reviewConditions'].map(name=>[name,emptyArray])));

/** Validate raw activity before the original persistence stage substitutes its
 * committed projection. Only declared optional undefined may normalize away. */
export function readInitialPlanActivityProjection(project){
 const rows=descriptors(project,'project');
 const raw=Object.fromEntries(Object.keys(activityFields).filter(key=>Object.hasOwn(rows,key)).map(key=>[key,rows[key].value]));
 preflight(raw,'activity',{nodes:0,bytes:0},new Set());return object(activityFields)(raw,'activity');
}

/** Pure versioned snapshot of actual original-owner durable business values.
 * This is never an authority/grant or an additive classification by itself.
 * Unsupported extensions invalidate a live acceptance head at its final save;
 * they do not prevent the original legacy mutation from being persisted. */
export function readInitialPlanSemanticSnapshot(input){return readSemanticSnapshot(input,1);}
export function readTaskAdditionSemanticSnapshot(input){return readSemanticSnapshot(input,2);}
function readSemanticSnapshot(input,schemaVersion){
  preflight(input,'snapshot',{nodes:0,bytes:0},new Set());
  if(schemaVersion===2)proofEncodedBudget(input,'snapshot');
  const envelope=object({project:(v)=>v,tasks:(v)=>v,related:relatedSchema})(input,'snapshot');
  const project=object({...projectFields,...activityFields})(envelope.project,'project');
  const tasks=array(object(taskFields),200)(envelope.tasks,'tasks');
  assertSemanticRelationships(project,tasks);
  const projection={activity:Object.fromEntries(PROJECT_ACTIVITY_FIELDS.filter(key=>Object.hasOwn(project,key)).map(key=>[key,project[key]])),room:[],workspace:[]};
  if(schemaVersion===2&&!Object.keys(projection.activity).length)bad('activity.incomplete');
  if(Object.keys(projection.activity).length){
    if(!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(project.activityDataEpoch)
      ||!project.activitySnapshot||!Array.isArray(project.activityEventOutbox)
      ||!Number.isSafeInteger(project.activityEventSeq)||project.activityEventSeq<1
      ||project.committedActivitySeq!==project.activityEventSeq)bad('activity.incomplete');
    try{assertProjectActivityBounds(project);if(project.activityDeliveryUnavailable!==true&&Object.hasOwn(project,'activityDeliveryHead'))readProjectDeliveryHead(project.activityDeliveryHead,project);}catch{bad('activity.bounds');}
    if(protocolDigest(project.activitySnapshot)!==protocolDigest(projectActivitySnapshot(project,tasks)))bad('activity.snapshot');
    for(const event of project.activityEventOutbox)if(event.workId!==project.id||event.eventId!==project.id+'#'+event.sourceSequence||event.sourceRevision!==String(event.sourceSequence))bad('activity.event');
    const ranges=[...project.activityEventOutbox.map(event=>({from:event.sourceSequence,through:event.sourceSequence})),...(project.activityGapRanges??[])].sort((a,b)=>a.from-b.from);
    let through=0;for(const range of ranges){if(range.from!==through+1)bad('activity.coverage');through=range.through;}
    if(through!==project.activityEventSeq)bad('activity.coverage');
  }
  for(const key of PROJECT_ACTIVITY_FIELDS)delete project[key];
  if(project.roomEventOutbox){
    project.roomEventOutbox=project.roomEventOutbox.map(item=>{
      if(item.projectId!==project.id||item.roomId!==project.primaryRoomId||item.sourceRefs.projectId!==project.id)bad('room.binding');
      const {status,attempts,totalAttempts,nextAttemptAt,lastError,publishedAt,suppressedAt,...payload}=item;
      projection.room.push({projectionEventId:item.projectionEventId,status,attempts,totalAttempts,nextAttemptAt,lastError,publishedAt,suppressedAt});return payload;
    });
  }
  if(project.workspaceMappingOperations){
    project.workspaceMappingOperations=Object.fromEntries(Object.entries(project.workspaceMappingOperations).map(([key,item])=>{
      if(item.operationId!==key||item.projectId!==project.id||item.roomId!==project.primaryRoomId)bad('workspace.binding');
      const {status,...payload}=item;projection.workspace.push({operationId:key,status});return [key,payload];
    }));
  }
  const semantic={project,tasks,related:envelope.related};
  const bytes=JSON.stringify(semantic);if(Buffer.byteLength(bytes,'utf8')>8388608)bad('bytes');
  const domain=schemaVersion===1?'ordinary-initial-plan-semantic-v1':'ordinary-initial-plan-semantic-v2';
  return {schemaVersion,projectRevision:project.projectRevision,semantic,projection,digest:protocolDigest([domain,semantic])};
}

export function readInitialPlanPendingTasks(value,projectId){
 preflight(value,'tasks',{nodes:0,bytes:0},new Set());const tasks=array(object(taskFields),1000)(value,'tasks'),ids=new Set(tasks.map(task=>task.id));
 if(ids.size!==tasks.length||tasks.some(task=>task.projectId!==projectId||task.dependencies.some(id=>!ids.has(id))))bad('tasks.identity');return tasks;
}
export function readInitialPlanCandidateInput(value){
 const textList=(v,p)=>typeof v==='string'?v:strings(v,p);
 const item=object({id:string,title:string,brief:optional(string),acceptanceCriteria:optional(textList),assignedAgent:optional(string),status:optional(exact('pending')),dependencies:optional(strings)});
 const plan=object({analysis:optional(string),goal:optional(string),name:optional(string),phases:array(object({id:string,name:optional(string),title:optional(string),description:optional(string),items:array(item,200)}),200)});
 const inputs=taskInputSchema(true);
 preflight(value,'candidate',{nodes:0,bytes:0},new Set());return object({plan,tasks:array(inputs,200)})(value,'candidate');
}

// Shared field parser, retaining v1 candidate field order and normalization.
// v2 identity is allocated only by the original owner after parsing.
function taskInputSchema(candidate){
 const allowed=['id','title','brief','description','requirements','acceptanceCriteria','assignedAgent','assignee','dependencies','dependencyPolicy','phaseId','planItemId','type','maxAttempts','maxQualityReworks','requiredOutputs','requiredCapabilities','executionGateSchemaVersion','executionContract','evidenceContract','composite','requiresIndependentReview','reviewAgent','reviewBrief','finalBrief'];
 return object(Object.fromEntries(allowed.filter(key=>candidate||!['id','planItemId'].includes(key)).map(key=>[key,key==='title'?string:optional(taskFields[key]?.optional?taskFields[key].schema:taskFields[key])])));
}
/** Data validation only; no authority, task creation or floor qualification. */
export function readOrdinaryTaskAdditionInput(value){
 preflight(value,'taskAddition',{nodes:0,bytes:0},new Set());proofEncodedBudget(value,'taskAddition');
 return array(taskInputSchema(false),200)(value,'taskAddition');
}

/** The full original policy map is required; null/missing is never known-empty. */
export function readOrdinaryTaskDependencyPolicies(value){
 preflight(value,'dependencyPolicies',{nodes:0,bytes:0},new Set());proofEncodedBudget(value,'dependencyPolicies');
 return map(oneOf('completed','completed_for_remediation','verified_pass'))(value,'dependencyPolicies');
}

function assertSemanticRelationships(project,tasks){
 const taskIds=new Set(tasks.map(task=>task.id));
 if(taskIds.size!==tasks.length||tasks.some(task=>task.projectId!==project.id||task.dependencies.some(id=>!taskIds.has(id))))bad('tasks.identity');
 if(project.agentSelection.poAgent.agentId!==project.poAgent
   ||protocolDigest(project.agentSelection.members.map(item=>item.agentId))!==protocolDigest(project.members))bad('project.agentSelection.binding');
}
const without=(fields,keys)=>Object.fromEntries(Object.entries(fields).filter(([key])=>!keys.includes(key)));
const canonicalRoomItem=object(without(roomItemFields,['status','attempts','totalAttempts','nextAttemptAt','lastError','publishedAt','suppressedAt']));
const canonicalMappingOperation=object(without(mappingOperationFields,['status']));
const canonicalProject=object({...projectFields,roomEventOutbox:optional(array(canonicalRoomItem)),workspaceMappingOperations:optional(map(canonicalMappingOperation))});
/** Reverse-proof data parser only. Raw projections must first pass the raw
 * reader; callers cannot fill in missing activity or turn this into an ACK. */
export function readCanonicalTaskAdditionSemantic(value){
 preflight(value,'canonicalSemantic',{nodes:0,bytes:0},new Set());proofEncodedBudget(value,'canonicalSemantic');
 const semantic=object({project:canonicalProject,tasks:array(object(taskFields),200),related:relatedSchema})(value,'canonicalSemantic');
 const {project,tasks}=semantic;assertSemanticRelationships(project,tasks);
 for(const item of project.roomEventOutbox??[])if(item.projectId!==project.id||item.roomId!==project.primaryRoomId||item.sourceRefs.projectId!==project.id)bad('room.binding');
 for(const [key,item] of Object.entries(project.workspaceMappingOperations??{}))if(item.operationId!==key||item.projectId!==project.id||item.roomId!==project.primaryRoomId)bad('workspace.binding');
 if(Buffer.byteLength(JSON.stringify(semantic),'utf8')>8388608)bad('bytes');
 return {schemaVersion:2,projectRevision:project.projectRevision,semantic,digest:protocolDigest(['ordinary-initial-plan-semantic-v2',semantic])};
}

const proofHash=(value,path)=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)?value:bad(path);
const proofId=(value,path)=>typeof value==='string'&&value.length>0&&value.length<=256&&value.trim()===value&&!value.includes('\0')?value:bad(path);
const policyPair=(value,path)=>{
 const values=array((item)=>item,2)(value,path);if(values.length!==2)bad(path);
 return [proofId(values[0],path+'.id'),oneOf('completed','completed_for_remediation','verified_pass')(values[1],path+'.policy')];
};
const integerPresence=(value,path)=>object(tag(value,'present',path)===true?{present:exact(true),value:integer}:{present:exact(false)})(value,path);
const taskAdditionProofSchema=object({kind:exact('ordinary_task_addition_semantic_proof'),schemaVersion:exact(2),
 projectId:proofId,operationId:proofId,ordinal:positive,previousProofDigest:nullable(proofHash),bodyHash:proofHash,
 beforeRevision:positive,afterRevision:positive,beforeDigest:proofHash,afterDigest:proofHash,
 addedTaskRows:array(object({taskId:proofId,rowDigest:proofHash}),200),policyDelta:array(policyPair,200),
 controlBefore:object({status:oneOf('created','planning'),bodyMapPresent:boolean,ordinaryInputRevision:integerPresence,updatedAt:integerPresence}),
});
export function readTaskAdditionTransitionInput(value){
 preflight(value,'taskAdditionTransition',{nodes:0,bytes:0},new Set());proofEncodedBudget(value,'taskAdditionTransition');
 return object({before:(item)=>item,after:(item)=>item,projectId:proofId,operationId:proofId,expectedBodyHash:proofHash,
   addedTaskIds:array(proofId,200),policyDelta:array(policyPair,200),ordinal:positive,previousProofDigest:nullable(proofHash)})(value,'taskAdditionTransition');
}
export function readTaskAdditionSemanticProof(value){
 preflight(value,'taskAdditionProof',{nodes:0,bytes:0},new Set());proofEncodedBudget(value,'taskAdditionProof');return taskAdditionProofSchema(value,'taskAdditionProof');
}
export function readTaskAdditionReverseInput(value){
 preflight(value,'taskAdditionReverse',{nodes:0,bytes:0},new Set());proofEncodedBudget(value,'taskAdditionReverse');
 return object({current:(item)=>item,proof:taskAdditionProofSchema})(value,'taskAdditionReverse');
}
export function readTaskAdditionProofChainInput(value){
 preflight(value,'taskAdditionChain',{nodes:0,bytes:0},new Set());proofEncodedBudget(value,'taskAdditionChain');
 return object({current:(item)=>item,bornDigest:proofHash,proofs:array(taskAdditionProofSchema,200)})(value,'taskAdditionChain');
}

// Preflight has already excluded own hooks, proxies, cycles and non-data values.
// Reject inherited hooks before measuring the exact encoded whole invocation.
function proofEncodedBudget(value,path){
 if(Object.getOwnPropertyDescriptor(Object.prototype,'toJSON')||Object.getOwnPropertyDescriptor(Array.prototype,'toJSON'))bad(path+'.serializationHook');
 const encoded=JSON.stringify(value);
 if(typeof encoded!=='string'||Buffer.byteLength(encoded,'utf8')>8388608)bad(path+'.encodedBytes');
}

/** Closed raw transport containers, before any ACK digest or projection split.
 * Shape validation is not proof that a remote publication/receipt occurred. */
export function readInitialPlanTransportProjection(project){
 const fields=descriptors(project,'project'),raw=Object.fromEntries(['roomEventOutbox','workspaceMappingOperations'].filter(key=>Object.hasOwn(fields,key)).map(key=>[key,fields[key].value]));
 preflight(raw,'transportProjection',{nodes:0,bytes:0},new Set());proofEncodedBudget(raw,'transportProjection');
 const result=object({roomEventOutbox:optional(array(roomItem)),workspaceMappingOperations:optional(map(mappingOperation))})(raw,'transportProjection');
 const projectId=fields.id?.value,roomId=fields.primaryRoomId?.value;
 for(const item of result.roomEventOutbox??[])if(item.projectId!==projectId||item.roomId!==roomId||item.sourceRefs.projectId!==projectId)bad('room.binding');
 for(const [key,item] of Object.entries(result.workspaceMappingOperations??{}))if(item.operationId!==key||item.projectId!==projectId||item.roomId!==roomId)bad('workspace.binding');
 return result;
}

/** Trusted composition still supplies its opaque source separately. No field
 * in this data envelope selects a writer, authority or execution capability. */
export function readOrdinaryTaskMetadataEnvelope(value){
 preflight(value,'taskMetadataInput',{nodes:0,bytes:0},new Set());proofEncodedBudget(value,'taskMetadataInput');
 const input=object({action:exact('add_task'),expectedProjectRevision:positive,sourceMessageId:proofId,body:string,
  title:optional(string),brief:optional(string),tasks:optional(array(taskInputSchema(false),200))})(value,'taskMetadataInput');
 if(input.tasks&&(Object.hasOwn(input,'title')||Object.hasOwn(input,'brief')))bad('taskMetadataInput.ambiguous');
 if(!input.body||Buffer.byteLength(input.body,'utf8')>65536||input.title&&Buffer.byteLength(input.title,'utf8')>4096||input.brief&&Buffer.byteLength(input.brief,'utf8')>65536)bad('taskMetadataInput.bytes');
 return input;
}

const taskOwnerCommon={id:proofId,projectId:proofId,scope:object({profileId:proofHash,workspaceId:proofHash}),
 writerStoreId:proofId,bindingDigest:proofHash,createReceiptDigest:proofHash,contract:exact('ordinary_initial_plan_additive_v2')};
const taskOwnerRows=array(object({taskId:proofId,rowDigest:proofHash,inputDigest:proofHash}),200);
const taskOwnerRefs=array(object({id:proofId,digest:proofHash}),200);
const taskOwnerReceipt=object({...taskOwnerCommon,kind:exact('ordinary_task_addition_receipt'),schemaVersion:exact(1),
 operationId:proofId,operationDigest:proofHash,envelopeDigest:proofHash,bodyHash:proofHash,ownerRevision:positive,
 taskRows:taskOwnerRows,policyDelta:array(policyPair,200),semanticProof:taskAdditionProofSchema});
const taskOwnerBaseline=object({...taskOwnerCommon,kind:exact('initial_plan_acceptance_baseline'),schemaVersion:exact(1),
 claimDigest:proofHash,ownerRevision:positive,semanticDigest:proofHash,taskReceiptRefs:taskOwnerRefs,taskRows:taskOwnerRows,policyDigest:proofHash});
const taskOwnerDelta=object({...taskOwnerCommon,kind:exact('initial_plan_additive_delta'),schemaVersion:exact(1),claimDigest:proofHash,
 ordinal:positive,previousDeltaDigest:nullable(proofHash),taskReceiptId:proofId,taskReceiptDigest:proofHash,semanticProofDigest:proofHash,
 fromProjectRevision:positive,toProjectRevision:positive,fromHeadRevision:positive,toHeadRevision:positive});
const taskOwnerInvalidation=object({...taskOwnerCommon,kind:exact('initial_plan_acceptance_invalidation'),schemaVersion:exact(2),
 headDigest:proofHash,reasonCode:exact('UNPROVEN_OWNER_CHANGE')});
const taskOwnerHead=(value,path)=>object({...taskOwnerCommon,kind:exact('initial_plan_acceptance_head'),schemaVersion:exact(2),
 revision:positive,state:oneOf('valid','invalidated','committed'),claimDigest:proofHash,baselineId:proofId,baselineDigest:proofHash,
 baseProjectRevision:positive,tailProjectRevision:positive,baseSemanticDigest:proofHash,tailSemanticDigest:proofHash,deltaCount:integer,prevDeltaDigest:nullable(proofHash),
 ...(tag(value,'state',path)==='committed'?{commitCommandId:proofId}:tag(value,'state',path)==='invalidated'?{invalidationReceiptId:proofId}:{})})(value,path);
/** A closed record parser only. Immutable ownership and physical row matching
 * must be verified by the original controller before these records are used. */
export function readTaskAdditionOwnerRecord(value){
 preflight(value,'taskOwnerRecord',{nodes:0,bytes:0},new Set());proofEncodedBudget(value,'taskOwnerRecord');
 const kind=tag(value,'kind','taskOwnerRecord'),schemas={ordinary_task_addition_receipt:taskOwnerReceipt,initial_plan_acceptance_baseline:taskOwnerBaseline,
  initial_plan_additive_delta:taskOwnerDelta,initial_plan_acceptance_head:taskOwnerHead,initial_plan_acceptance_invalidation:taskOwnerInvalidation,initial_plan_reservation:taskOwnerClaim};
 if(!Object.hasOwn(schemas,kind))bad('taskOwnerRecord.kind');return schemas[kind](value,'taskOwnerRecord');
}

export function readTaskInitialClaimInput(value){
 preflight(value,'taskInitialClaim',{nodes:0,bytes:0},new Set());proofEncodedBudget(value,'taskInitialClaim');
 return object({protocol:exact('ordinary_initial_plan_additive_v2'),fromAgent:proofId,enqueueKey:proofId,planRunId:proofId,planGeneration:exact(1),
  expectedPlanInputRevision:integer,expectedProjectControlDigest:proofHash,startPolicy:oneOf('plan_only','auto_activate_after_plan','activate_and_dispatch_after_plan')})(value,'taskInitialClaim');
}

// Schema3 is a distinct immutable Main request, not a v1 claim with a flag.
const taskOwnerClaim=(value,path)=>object({...taskOwnerCommon,kind:exact('initial_plan_reservation'),schemaVersion:exact(3),poAgent:proofId,
 enqueueKey:proofId,planRunId:proofId,planGeneration:exact(1),startPolicy:oneOf('plan_only','auto_activate_after_plan','activate_and_dispatch_after_plan'),
 planInputRevision:integer,consumedMessageIds:array(proofId,100000),consumedOperationIds:array(proofId,100000),requestDigest:proofHash,
 commitCommandId:proofId,ownerRevision:positive,claimRequest:readTaskInitialClaimInput,
 ...(Object.hasOwn(value,'compositeRequest')?{compositeRequest:readTaskInitialClaimInput,compositeTaskOperationId:proofId,compositeEnvelopeDigest:proofHash}:{})})(value,path);
