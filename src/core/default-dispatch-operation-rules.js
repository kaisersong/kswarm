import {DispatchPreparationDataError,runtimeDispatchRecordCollection,runtimePreparationBase,runtimePreparationChildLookup,runtimePreparationIntent,runtimePreparationTarget,runtimePreparationObservation,runtimePreparationChildHead,runtimePreparationOutbox,runtimePreparationProjection} from './default-dispatch-runtime-data.js';
import {retainSourceErrorTails} from './source-error-tails.js';
import {IntrinsicMap as Map,IntrinsicSet as Set,IntrinsicWeakMap as WeakMap} from './intrinsic-collections.js';
import {types,isDeepStrictEqual} from 'node:util';
import {captureExecutionData,taskHandoffContent,taskBusinessContentDigest} from './task-execution-content.js';
import {protocolDigest,projectProtocolIds} from './project-protocol.js';
import {defaultDispatchBusinessIdentity} from './default-dispatch-birth-rules.js';
import {dispatchPlanTaskSetDigest} from './durable-dispatch-plan-rules.js';
import {resolveProjectInputAuthority} from './project-input-authority.js';
import {captureDefaultDispatchActionRecord} from './default-dispatch-action-data.js';
import {captureHostNoEffectData,runtimeHostNoEffectFinish} from './default-dispatch-host-no-effect-data.js';
import {captureHostRegistrationData,runtimeHostRegistration} from './default-dispatch-host-registration-data.js';
import {runtimePreparationAdmission} from './default-dispatch-preparation-admission-data.js';
import {readTaskBoardSnapshot,readOriginalTaskBoardFirstAdmitReadiness} from './task-board.js';
import {firstAdmitTaskDependencyContext} from './task-dependency-gate-context.js';
import {DEFAULT_DISPATCH_CONTRACT,DURABLE_DISPATCH_RUNTIME_WRITER_PROFILE,isAcceptanceRecord,acceptanceRecordMatchesFloor,isDurableDispatchStorageProfile,DURABLE_DISPATCH_OPERATION_CONTRACT,durableDispatchRecordCollection as storageDispatchRecordCollection} from './initial-plan-acceptance-contract.js';
const apply=Reflect.apply,descriptors=Object.getOwnPropertyDescriptors,own=Object.hasOwn,keys=Object.keys,prototype=Object.getPrototypeOf,define=Object.defineProperty,create=Object.create,freeze=Object.freeze;
const ownKeys=Reflect.ownKeys,isProxy=types.isProxy,isPromise=types.isPromise,isAsyncFunction=types.isAsyncFunction,isArray=Array.isArray;
const asyncPrototype=prototype(async()=>{}),sort=Function.prototype.call.bind(Array.prototype.sort);
const childReadExec=Function.prototype.call.bind(RegExp.prototype.exec);
class DispatchError extends Error{}
const fail=(code='DURABLE_DISPATCH_OPERATION_UNVERIFIED',cause)=>{throw new DispatchError(code,{cause});};
const equal=(a,b)=>{if(!isDeepStrictEqual(a,b))fail();};
const append=(array,value)=>define(array,String(array.length),{__proto__:null,value,writable:true,enumerable:true,configurable:true});
function result(data){const captured=captureExecutionData(data),out=create(null),fields=descriptors(captured),names=keys(fields);for(let i=0;i<names.length;i++)define(out,names[i],{__proto__:null,value:fields[names[i]].value,enumerable:true});return freeze(out);}
function fields(value,names){if(!value||typeof value!=='object'||isProxy(value)||isArray(value)||![Object.prototype,null].includes(prototype(value)))fail('DURABLE_DISPATCH_SOURCE_UNVERIFIED');const rows=descriptors(value);if(ownKeys(rows).length!==names.length)fail('DURABLE_DISPATCH_SOURCE_UNVERIFIED');for(let i=0;i<names.length;i++)if(!own(rows,names[i])||!own(rows[names[i]],'value')||!rows[names[i]].enumerable)fail('DURABLE_DISPATCH_SOURCE_UNVERIFIED');return rows;}
function syncFunction(fn){return typeof fn==='function'&&!isProxy(fn)&&!isAsyncFunction(fn)&&prototype(fn)!==asyncPrototype;}
const rowKey=(collection,id)=>JSON.stringify([collection,id]);
function parentId(fact){return'default-dispatch-parent:'+protocolDigest(['default-dispatch-parent-v1',fact.scope,fact.actorId,fact.projectId,fact.planRevision,fact.dispatchGeneration]);}
const operationKinds={action:'ordinary_default_dispatch_user_action',parent:'ordinary_default_dispatch_parent',child:'ordinary_default_dispatch_child',intent:'ordinary_default_dispatch_intent',status:'ordinary_default_dispatch_child_head',outbox:'ordinary_default_dispatch_outbox_head'};
/** Original acceptance-owner child. Preparations are private in-memory markers;
 * durable facts are added only AFTER its original stage rollback snapshots. */
export function createDefaultDispatchOperationRules({backend,projects,boards,receipts,heads,readBinding,floor,inspectPlan,source,preparationSource,invokeGuard,retainSourceTail,isPreparationReadQuiescent,inspectPreparationTransportCall,readPreparationTransportCandidate,readPreparationHostRegistration}){
 const cursors=new WeakMap(),finishAdvances=new WeakMap(),hostAdvances=new WeakMap(),acceptedTokens=new WeakMap();
 const prepared=new WeakMap(),pending=new Map(),preparing=new Set(),entryProjection=new Map();let sourceBroken=false,sourceFailure;
 let resolver;try{if(source&&!isProxy(source)){const entry=Object.getOwnPropertyDescriptor(source,'resolve');if(entry&&own(entry,'value'))resolver=entry.value;}}catch{}
 function durableDispatchRecordCollection(value){return storageDispatchRecordCollection(value)??(floor()?.profile===DURABLE_DISPATCH_RUNTIME_WRITER_PROFILE?runtimeDispatchRecordCollection(value):undefined);}
 function active(){return isDurableDispatchStorageProfile(floor()?.profile);}
 function nativeRevision(){const value=backend.readCurrentRevision();if(!value||value.actual!==value.cached||!Number.isSafeInteger(value.actual)||value.actual<0)fail();return value.actual;}
 function unexpected(raw,cause){sourceBroken=true;sourceFailure??=cause;if(raw!==null&&(typeof raw==='object'||typeof raw==='function'))retainSourceTail(raw,cause);fail('DURABLE_DISPATCH_SOURCE_UNCONFIRMED',cause);}
 function scanSourceData(data,envelope=false){
  const seen=new Set(),unsafe=new Set();let nodes=0;
  const walk=(value,depth)=>{
   if(value===null||typeof value!=='object'&&typeof value!=='function')return;
   if(seen.has(value))return;seen.add(value);
   if(isProxy(value)){unsafe.add(value);return;}
   const array=isArray(value),proto=prototype(value);if(isPromise(value)||typeof value==='function'||(array?proto!==Array.prototype:proto!==Object.prototype&&proto!==null))unsafe.add(value);
   if(++nodes>100000||depth>64){unsafe.add(value);return;}
   const rows=descriptors(value),names=ownKeys(rows);if(own(rows,'then'))unsafe.add(value);
   for(let i=0;i<names.length;i++){const name=names[i],row=rows[name];if(!own(row,'value')){unsafe.add(value);continue;}if(envelope&&depth===0&&name==='assertCurrent'&&syncFunction(row.value))continue;walk(row.value,depth+1);}
  };
  walk(data,0);if(unsafe.size){const error=Error('DURABLE_DISPATCH_SOURCE_DATA_ASYNC');sourceBroken=true;sourceFailure??=error;for(const raw of unsafe)retainSourceTail(raw,error);fail('DURABLE_DISPATCH_SOURCE_UNCONFIRMED',error);}
 }
 function invoke(fn,receiver,args,voidResult){
  return invokeGuard(()=>{
   if(!syncFunction(fn))fail('DURABLE_DISPATCH_SOURCE_SYNCHRONOUS_REQUIRED');
   let raw;try{raw=apply(fn,receiver,args);}catch(error){retainSourceErrorTails(error,(raw,cause,kind)=>{sourceBroken=true;sourceFailure??=cause;retainSourceTail(raw,cause,kind==='unknown');});fail('DURABLE_DISPATCH_SOURCE_UNVERIFIED',error);}
   if(voidResult){if(raw!==undefined)unexpected(raw,Error('DURABLE_DISPATCH_SOURCE_GUARD_RETURN_INVALID'));return;}
   if(isProxy(raw)||isPromise(raw)||typeof raw==='function'||raw&&typeof raw==='object'&&(![Object.prototype,null].includes(prototype(raw))||Object.getOwnPropertyDescriptor(raw,'then'))){scanSourceData(raw,true);unexpected(raw,Error('DURABLE_DISPATCH_SOURCE_RETURN_ASYNC'));}
   return raw;
  });
 }
 function control(projectId){const value=floor(),binding=readBinding(projectId);if(!active()||binding.classification!=='ordinary'||!isDeepStrictEqual(binding.binding.scope,value.scope))fail('DURABLE_DISPATCH_PROFILE_UNQUALIFIED');return{value,binding};}
 function base(kind,projectId){const {value,binding}=control(projectId);return{kind,schemaVersion:1,contract:DURABLE_DISPATCH_OPERATION_CONTRACT,projectId,scope:value.scope,writerStoreId:value.storeId,bindingDigest:protocolDigest(binding.binding)};}
 function actionRecord(fact){return captureExecutionData({...base(operationKinds.action,fact.projectId),id:fact.actionId,fact});}
 function parentRecord(fact,childKeys){return captureExecutionData({...base(operationKinds.parent,fact.projectId),id:parentId(fact),actorId:fact.actorId,planRevision:fact.planRevision,dispatchGeneration:fact.dispatchGeneration,actionReceiptId:fact.actionId,taskSetDigest:fact.taskSetDigest,childKeys,payloadHash:protocolDigest(['default-dispatch-parent-payload-v1',fact,childKeys])});}
 function childRecord(projectId,taskId,birth,originActionReceiptId){
  const project=projects.get(projectId),task=boards.get(projectId)?.getTask(taskId);if(!project||!task)fail();
  if(isProxy(project)||isProxy(task))fail();const projectFields=descriptors(project),room=own(projectFields,'primaryRoomId')?projectFields.primaryRoomId:undefined;if(room&&!own(room,'value'))fail('DURABLE_DISPATCH_PROJECT_DATA_UNVERIFIED');
  const raw=descriptors(task),get=name=>{const row=own(raw,name)?raw[name]:undefined;if(!row)return null;if(!own(row,'value'))fail();return row.value??null;};
  const route=captureExecutionData({desiredRoute:get('desiredRoute'),candidateRef:get('candidateRef'),candidateRefs:get('candidateRefs')}),logicalAgentId=get('assignedAgent');if(typeof logicalAgentId!=='string'||!logicalAgentId)fail('DURABLE_DISPATCH_ROUTE_UNQUALIFIED');
  const payload=captureExecutionData({execution:taskHandoffContent(project,task),route,logicalAgentId,roomId:room?.value??null});
  if(taskBusinessContentDigest(payload.execution.project,{...payload.execution.task,...route})!==birth.contentDigest)fail('DEFAULT_DISPATCH_CONTENT_CONFLICT');
  const body={...base(operationKinds.child,projectId),id:birth.childKey,taskId,businessExecutionGeneration:birth.businessExecutionGeneration,birthReceiptId:birth.birthReceiptId,contentDigest:birth.contentDigest,payload};
  return captureExecutionData({...body,originActionReceiptId,payloadHash:protocolDigest(['default-dispatch-child-payload-v1',body.scope,projectId,taskId,body.businessExecutionGeneration,body.contentDigest,body.bindingDigest,payload])});
 }
 function roomValue(project){if(!project||typeof project!=='object'||isProxy(project))fail('DURABLE_DISPATCH_PROJECT_DATA_UNVERIFIED');const fields=descriptors(project),row=own(fields,'primaryRoomId')?fields.primaryRoomId:undefined;if(row&&!own(row,'value'))fail('DURABLE_DISPATCH_PROJECT_DATA_UNVERIFIED');return row?.value??null;}
 function candidates(projectId,plan,actionId){
  const revision=nativeRevision(),live=projects.get(projectId),room=roomValue(live);let physical;
  for(const row of backend.rows())if(row.collection==='project'&&row.key===projectId)physical=row.value;
  if(roomValue(physical)!==room)fail('DURABLE_DISPATCH_EXECUTION_SOURCE_CHANGED');
  const values=[];for(let i=0;i<plan.tasks.length;i++)append(values,childRecord(projectId,plan.tasks[i].taskId,plan.tasks[i],actionId));
  const observed=inspectPlan(projectId);if(!observed.ok)fail(observed.error);equal(observed.plan,plan);
  if(projects.get(projectId)!==live||roomValue(live)!==room||nativeRevision()!==revision)fail('DURABLE_DISPATCH_EXECUTION_SOURCE_CHANGED');return freeze(values);
 }
 function intentRecord(child){return captureExecutionData({...base(operationKinds.intent,child.projectId),id:child.id+':intent',childKey:child.id,payloadHash:child.payloadHash,operation:'prepare_project_task'});}
 function childHead(child){return captureExecutionData({...base(operationKinds.status,child.projectId),id:child.id+':status',childKey:child.id,payloadHash:child.payloadHash,revision:1,state:'intent_pending',intentReceiptId:child.id+':intent'});}
 function outboxHead(child){return captureExecutionData({...base(operationKinds.outbox,child.projectId),id:child.id+':outbox',childKey:child.id,payloadHash:child.payloadHash,revision:1,state:'pending',intentReceiptId:child.id+':intent'});}
 function originalMap(collection){return collection==='protocolReceipt'?receipts:heads;}
 function snapshot(projectId){
  const revision=nativeRevision(),rows=new Map(),lineage=new Map(),sourceRows=new Map(),profile=floor();
  const physicalRows=backend.rows();for(let physicalIndex=0;physicalIndex<physicalRows.length;physicalIndex++){const row=physicalRows[physicalIndex];
   if((row.collection==='project'||row.collection==='board')&&row.key===projectId)sourceRows.set(row.collection,row.value);
   if(row.collection!=='protocolReceipt'&&row.collection!=='protocolHead')continue;
   if(row.projectId!==projectId&&row.value.projectId!==projectId)continue;
   if(row.projectId!==projectId||row.value.projectId!==projectId)fail();
   if(['protocolReceipt','protocolHead'].includes(row.collection)){
    if(isAcceptanceRecord(row.value)&&!acceptanceRecordMatchesFloor(row.value,profile))fail();
    lineage.set(rowKey(row.collection,row.key),row.value);
   }
   if(row.projectId===projectId&&durableDispatchRecordCollection(row.value)){
   if(row.key!==row.value.id||durableDispatchRecordCollection(row.value)!==row.collection)fail();equal(originalMap(row.collection).get(row.key),row.value);rows.set(rowKey(row.collection,row.key),row.value);
  }}
  const bindingIds=projectProtocolIds(projectId);for(const id of [bindingIds.binding,bindingIds.receipt]){const stored=lineage.get(rowKey('protocolReceipt',id));if(!stored)fail();equal(stored,receipts.get(id));}
  for(const collection of ['protocolReceipt','protocolHead'])for(const [id,value]of originalMap(collection))if(value.projectId===projectId&&durableDispatchRecordCollection(value)){if(!rows.has(rowKey(collection,id)))fail();}
  verifyGraph(projectId,rows,lineage);if(nativeRevision()!==revision)fail();return{revision,rows,lineage,sourceRows};
 }
 function verifyGraph(projectId,rows,lineage){
  const children=new Map(),parents=new Map(),actions=new Map(),referenced=new Set();
  for(const [key,value]of rows){
   const collection=durableDispatchRecordCollection(value);if(!collection||key!==rowKey(collection,value.id))fail();equal(runtimeDispatchRecordCollection(value)?runtimePreparationBase({...control(projectId).value,scope:floor().scope,writerStoreId:floor().storeId,projectId,bindingDigest:protocolDigest(control(projectId).binding.binding)},value):base(value.kind,projectId),{kind:value.kind,schemaVersion:value.schemaVersion,contract:value.contract,projectId:value.projectId,scope:value.scope,writerStoreId:value.writerStoreId,bindingDigest:value.bindingDigest});
   if(value.kind===operationKinds.action){const fact=captureDefaultDispatchActionRecord(value.fact);equal(value,actionRecord(fact));actions.set(value.id,value);}
   if(value.kind===operationKinds.parent)parents.set(value.id,value);
   if(value.kind===operationKinds.child)children.set(value.id,value);
  }
  for(const parent of parents.values()){
   const action=actions.get(parent.actionReceiptId);if(!action)fail();const fact=action.fact,ids=[];if(!isArray(parent.childKeys))fail();
   for(let i=0;i<parent.childKeys.length;i++){const id=parent.childKeys[i];if(!children.has(id)||ids.includes(id))fail();append(ids,id);referenced.add(id);}equal(parent,parentRecord(fact,ids));const members=[];for(let i=0;i<ids.length;i++){const child=children.get(ids[i]);append(members,{taskId:child.taskId,businessExecutionGeneration:child.businessExecutionGeneration,childKey:child.id,contentDigest:child.contentDigest,birthReceiptId:child.birthReceiptId});}sort(members,(a,b)=>a.taskId<b.taskId?-1:a.taskId>b.taskId?1:0);if(dispatchPlanTaskSetDigest(members)!==fact.taskSetDigest)fail();
  }
  for(const child of children.values()){
   const origin=actions.get(child.originActionReceiptId),originParent=origin&&parents.get(parentId(origin.fact));if(!originParent||!originParent.childKeys.includes(child.id)||!referenced.has(child.id))fail();
   const identity=defaultDispatchBusinessIdentity(child.scope,projectId,child.taskId);if(child.id!==identity.childKey||child.birthReceiptId!==identity.receipt)fail();
   const birth=lineage.get(rowKey('protocolReceipt',identity.receipt)),generation=lineage.get(rowKey('protocolHead',identity.head));if(!birth||!generation)fail();equal(birth,receipts.get(identity.receipt));equal(generation,heads.get(identity.head));
   const original={id:identity.receipt,kind:'ordinary_default_dispatch_birth',schemaVersion:1,contract:DEFAULT_DISPATCH_CONTRACT,projectId,scope:child.scope,writerStoreId:child.writerStoreId,bindingDigest:child.bindingDigest,taskId:child.taskId,businessExecutionGeneration:child.businessExecutionGeneration,childKey:child.id,contentDigest:child.contentDigest};equal(birth,original);equal(generation,{id:identity.head,kind:'ordinary_default_dispatch_generation',schemaVersion:1,contract:DEFAULT_DISPATCH_CONTRACT,projectId,scope:child.scope,writerStoreId:child.writerStoreId,bindingDigest:child.bindingDigest,taskId:child.taskId,businessExecutionGeneration:child.businessExecutionGeneration,revision:1,birthReceiptId:birth.id,birthDigest:protocolDigest(birth)});
   const body={...base(operationKinds.child,projectId),id:child.id,taskId:child.taskId,businessExecutionGeneration:child.businessExecutionGeneration,birthReceiptId:child.birthReceiptId,contentDigest:child.contentDigest,payload:child.payload};
   if(child.businessExecutionGeneration!==1||child.payload.execution.task.id!==child.taskId||child.payload.execution.project.id!==projectId||taskBusinessContentDigest(child.payload.execution.project,{...child.payload.execution.task,...child.payload.route})!==child.contentDigest)fail();
   equal(child,captureExecutionData({...body,originActionReceiptId:child.originActionReceiptId,payloadHash:protocolDigest(['default-dispatch-child-payload-v1',body.scope,projectId,child.taskId,child.businessExecutionGeneration,child.contentDigest,child.bindingDigest,child.payload])}));
   equal(rows.get(rowKey('protocolReceipt',child.id+':intent')),intentRecord(child));
   const preparation=rows.get(rowKey('protocolReceipt',child.id+':preparation')),admission=rows.get(rowKey('protocolReceipt',child.id+':preparation-admission')),observed=rows.get(rowKey('protocolReceipt',child.id+':prepared')),registration=rows.get(rowKey('protocolReceipt',child.id+':host-registration')),noEffectFinish=rows.get(rowKey('protocolReceipt',child.id+':host-registration:no-effect-finish'));
   if(preparation){
    if(floor()?.profile!==DURABLE_DISPATCH_RUNTIME_WRITER_PROFILE)fail();equal(preparation,runtimePreparationIntent(child,runtimePreparationTarget(preparation)));
    if(admission)equal(admission,runtimePreparationAdmission(child,preparation,{preparationIntentDigest:admission.preparationIntentDigest,sourceIncarnation:admission.sourceIncarnation}));
    if(registration){if(!admission)fail();equal(registration,runtimeHostRegistration(child,preparation,admission,{scope:registration.scope,projectId,childKey:child.id,payloadHash:child.payloadHash,admissionId:registration.admissionId,preparationIntentDigest:registration.preparationIntentDigest,sourceIncarnation:registration.sourceIncarnation,hostLeaseKey:registration.hostLeaseKey}));}
    if(noEffectFinish){if(!registration||observed)fail('DURABLE_DISPATCH_HOST_FATE_CONFLICT');equal(noEffectFinish,runtimeHostNoEffectFinish(child,registration,{scope:child.scope,projectId,registrationDigest:protocolDigest(registration),hostLeaseKey:registration.hostLeaseKey,sourceIncarnation:registration.sourceIncarnation,reason:noEffectFinish.reason}));}
    if(observed){if(!admission)fail('DURABLE_DISPATCH_PREPARATION_ADMISSION_REQUIRED');equal(observed,runtimePreparationObservation(child,preparation,{preparationIntentDigest:observed.preparationIntentDigest,fact:observed.fact}));}
    equal(rows.get(rowKey('protocolHead',child.id+':status')),runtimePreparationChildHead(child,preparation,observed,admission,registration,noEffectFinish));equal(rows.get(rowKey('protocolHead',child.id+':outbox')),runtimePreparationOutbox(child,preparation,observed,admission,registration,noEffectFinish));
   }else{if(observed||admission||registration||noEffectFinish)fail();equal(rows.get(rowKey('protocolHead',child.id+':status')),childHead(child));equal(rows.get(rowKey('protocolHead',child.id+':outbox')),outboxHead(child));}
  }
  for(const value of rows.values())if((runtimeDispatchRecordCollection(value)||[operationKinds.intent,operationKinds.status,operationKinds.outbox].includes(value.kind))&&!children.has(value.childKey))fail();
  for(const action of actions.values())if(!parents.has(parentId(action.fact)))fail();
 }
 function projection(parent,rows){const children=[];for(let i=0;i<parent.childKeys.length;i++){const key=parent.childKeys[i],child=rows.get(rowKey('protocolReceipt',key)),head=rows.get(rowKey('protocolHead',key+':status'));append(children,{childKey:key,taskId:child.taskId,payloadHash:child.payloadHash,state:head.state});}return captureExecutionData({parentId:parent.id,projectId:parent.projectId,planRevision:parent.planRevision,dispatchGeneration:parent.dispatchGeneration,children});}
 function actor(context,fact){const value=captureExecutionData(context);if(keys(value).length!==2||value.requestSource!=='user'||value.actorId!==fact.actorId)fail('DURABLE_DISPATCH_USER_REQUIRED');}
 function current(projectId,fact,context,guard,receiver){
  actor(context,fact);invoke(guard,receiver,[],true);actor(context,fact);
  const observed=inspectPlan(projectId);if(!observed.ok)fail(observed.error);const plan=observed.plan;
  equal({scope:fact.scope,projectId:fact.projectId,planRevision:fact.planRevision,dispatchGeneration:fact.dispatchGeneration,bindingDigest:fact.bindingDigest,taskSetDigest:fact.taskSetDigest},{scope:plan.scope,projectId:plan.projectId,planRevision:plan.revision,dispatchGeneration:plan.dispatchGeneration,bindingDigest:plan.bindingDigest,taskSetDigest:plan.taskSetDigest});return plan;
 }
 let preparationResolver;
 if(preparationSource&&!isProxy(preparationSource)){const row=Object.getOwnPropertyDescriptor(preparationSource,'resolve');if(row&&own(row,'value'))preparationResolver=row.value;}
 function prepareRuntime(projectId,frame,context,purpose){
  if(preparing.has(projectId)||pending.has(projectId))return result({ok:false,error:'DURABLE_DISPATCH_OPERATION_BUSY'});preparing.add(projectId);
  try{
   if(floor()?.profile!==DURABLE_DISPATCH_RUNTIME_WRITER_PROFILE)fail('DURABLE_DISPATCH_PREPARATION_PROFILE_REQUIRED');
   fields(context,['requestSource']);if(context.requestSource!=='scheduler')fail('DURABLE_DISPATCH_PREPARATION_SCHEDULER_REQUIRED');
   if(!preparationSource||!syncFunction(preparationResolver)||!invokeGuard||!retainSourceTail)fail('DURABLE_DISPATCH_PREPARATION_SOURCE_REQUIRED');
   if(sourceBroken)fail('DURABLE_DISPATCH_SOURCE_UNCONFIRMED',sourceFailure);
   const reply=invoke(preparationResolver,preparationSource,[frame,purpose],false);scanSourceData(reply,true);const envelope=fields(reply,['data','assertCurrent']);
   if(purpose==='admit')fields(envelope.data.value,['preparationIntentDigest','sourceIncarnation']);
   const data=captureExecutionData(envelope.data.value),guard=envelope.assertCurrent.value;
   const assertCurrent=()=>{invoke(guard,reply,[],true);if(sourceBroken)fail('DURABLE_DISPATCH_SOURCE_UNCONFIRMED',sourceFailure);control(projectId);};assertCurrent();
   // Admit source data binds the complete existing intent digest, not a
   // caller-selected child key or payload. Resolve only original physical rows.
   const lookup=purpose==='admit'?null:runtimePreparationChildLookup(data,purpose),before=snapshot(projectId);
   let childKey=lookup;
   if(purpose==='admit')for(const value of before.rows.values())if(value.kind==='ordinary_default_dispatch_preparation_intent'&&protocolDigest(value)===data.preparationIntentDigest){if(childKey!==null)fail();childKey=value.childKey;}
   const child=before.rows.get(rowKey('protocolReceipt',childKey));if(child?.kind!==operationKinds.child)fail('DURABLE_DISPATCH_PREPARATION_NOT_FOUND');
   const originalBoard=boards.get(projectId),originalProject=projects.get(projectId);
   const registration=before.rows.get(rowKey('protocolReceipt',child.id+':host-registration')),noEffectFinish=before.rows.get(rowKey('protocolReceipt',child.id+':host-registration:no-effect-finish'));
   let intent=before.rows.get(rowKey('protocolReceipt',child.id+':preparation')),admission=before.rows.get(rowKey('protocolReceipt',child.id+':preparation-admission')),observation=before.rows.get(rowKey('protocolReceipt',child.id+':prepared'));const additions=[],updates=[];let operation='observe';
   if(purpose==='observe'){if(!intent)fail('DURABLE_DISPATCH_PREPARATION_NOT_FOUND');equal(data,captureExecutionData(runtimePreparationTarget(intent)));}
   else if(purpose==='prepare'){
    const candidate=runtimePreparationIntent(child,data);if(intent)equal(intent,candidate);else{intent=candidate;append(additions,{collection:'protocolReceipt',value:intent});operation='prepare';}
   }else if(purpose==='admit'){
    if(!intent)fail('DURABLE_DISPATCH_PREPARATION_NOT_FOUND');const candidate=runtimePreparationAdmission(child,intent,data);
    if(admission)equal(admission,candidate);else{admission=candidate;operation='admit';append(additions,{collection:'protocolReceipt',value:admission});}
   }else{
    if(!intent)fail();if(!admission)fail('DURABLE_DISPATCH_PREPARATION_ADMISSION_REQUIRED');if(!observation||registration||noEffectFinish)fail('DURABLE_DISPATCH_HOST_EFFECT_PERMISSION_UNAVAILABLE');const candidate=runtimePreparationObservation(child,intent,data);equal(observation,candidate);
   }
   const firstPreparation=purpose==='prepare'&&operation==='prepare',firstAdmission=purpose==='admit'&&operation==='admit';
   const assertRuntimeLocal=()=>{
    if(boards.get(projectId)!==originalBoard||projects.get(projectId)!==originalProject)fail('DURABLE_DISPATCH_EXECUTION_SOURCE_CHANGED');
    equal(captureExecutionData(originalProject),before.sourceRows.get('project'));
    const currentTasks=readTaskBoardSnapshot(originalBoard);equal(captureExecutionData(currentTasks),before.sourceRows.get('board')?.tasks);
    if(!firstPreparation&&!firstAdmission)return;
    const project=captureExecutionData(projects.get(projectId));
    if(!project||(project.status!=='active'&&project.status!=='planning')||project.status!==before.sourceRows.get('project')?.status)fail('DURABLE_DISPATCH_PROJECT_NOT_ACTIVE');
    if(firstAdmission){
     const gate=firstAdmitTaskDependencyContext(project,currentTasks,child.taskId);if(!gate.ok)fail(gate.error);
     const ready=readOriginalTaskBoardFirstAdmitReadiness(originalBoard,child.taskId,gate.context);if(!ready.ok)fail('DURABLE_DISPATCH_TASK_NOT_READY');
    }
   };
   const assertRuntimeCurrent=()=>{
    assertCurrent();assertRuntimeLocal();
    if(firstPreparation||firstAdmission){
     const inspected=inspectPlan(projectId);if(!inspected.ok)fail(inspected.error);
     let member;for(let i=0;i<inspected.plan.tasks.length;i++)if(inspected.plan.tasks[i].childKey===child.id){if(member)fail();member=inspected.plan.tasks[i];}if(!member)fail();
     equal(childRecord(projectId,child.taskId,member,child.originActionReceiptId),child);
    }
    assertRuntimeLocal();
   };
   assertRuntimeCurrent();
   if(additions.length){append(updates,{collection:'protocolHead',value:runtimePreparationChildHead(child,intent,observation,admission,registration,noEffectFinish)});append(updates,{collection:'protocolHead',value:runtimePreparationOutbox(child,intent,observation,admission,registration,noEffectFinish)});}
   const combined=new Map(before.rows);for(const row of [...additions,...updates])combined.set(rowKey(row.collection,row.value.id),row.value);verifyGraph(projectId,combined,before.lineage);assertRuntimeCurrent();if(nativeRevision()!==before.revision)fail();
   const response=result({ok:true,preparation:runtimePreparationProjection(child,intent,observation,operation,admission)});
   // A private candidate is not transport authority. Only the original Hub's
   // normal transaction return may turn first-write provenance into a proof.
   const cursor={revision:before.revision+(additions.length?1:0),rows:combined,sourceRows:before.sourceRows};
   const transportCandidate=purpose==='acknowledge'||purpose==='prepare'&&!admission?null:freeze({
    purpose:firstAdmission?'prepare':'observe',admissionId:admission?.admissionId??null,sourceIncarnation:admission?.sourceIncarnation??null,preparation:response.preparation,
    assertCurrent(){assertRuntimeCurrent();const now=snapshot(projectId);if(now.revision!==cursor.revision||now.rows.size!==cursor.rows.size)fail();for(const [key,value]of cursor.rows)equal(now.rows.get(key),value);equal(now.sourceRows.get('project'),cursor.sourceRows.get('project'));equal(now.sourceRows.get('board'),cursor.sourceRows.get('board'));assertRuntimeCurrent();if(nativeRevision()!==now.revision)fail();},
   });
   if(transportCandidate)cursors.set(transportCandidate,cursor);
   if(!additions.length)return{ok:true,needsWrite:false,response,transportCandidate};
   const token=freeze(create(null)),entry=freeze({runtime:true,projectId,revision:before.revision,before:before.rows,lineage:before.lineage,sourceRows:before.sourceRows,additions:freeze(additions),updates:freeze(updates),assertCurrent:assertRuntimeCurrent,assertSqlCurrent(){assertCurrent();assertRuntimeLocal();},assertLocal:assertRuntimeLocal,response});prepared.set(token,entry);return{ok:true,needsWrite:true,token,response,transportCandidate};
  }catch(error){if(error instanceof DispatchError||error instanceof DispatchPreparationDataError)return result({ok:false,error:error.message});throw error;}finally{preparing.delete(projectId);}
 }
 function prepareHostRegistration(projectId,frame,context){
  if(preparing.has(projectId)||pending.has(projectId))return result({ok:false,error:'DURABLE_DISPATCH_OPERATION_BUSY'});preparing.add(projectId);
  try{
   fields(context,['requestSource']);if(context.requestSource!=='scheduler')fail('DURABLE_DISPATCH_PREPARATION_SCHEDULER_REQUIRED');
   if(floor()?.profile!==DURABLE_DISPATCH_RUNTIME_WRITER_PROFILE)fail('DURABLE_DISPATCH_PREPARATION_PROFILE_REQUIRED');
   if(sourceBroken)fail('DURABLE_DISPATCH_SOURCE_UNCONFIRMED',sourceFailure);
   if(!preparationSource||!syncFunction(preparationResolver)||!readPreparationTransportCandidate)fail('DURABLE_DISPATCH_PREPARATION_SOURCE_REQUIRED');
   const reply=invoke(preparationResolver,preparationSource,[frame,'register_host'],false);scanSourceData(reply,true);const envelope=fields(reply,['data','assertCurrent']);
   const data=captureHostRegistrationData(envelope.data.value),guard=envelope.assertCurrent.value;
   const current=()=>{invoke(guard,reply,[],true);if(sourceBroken)fail('DURABLE_DISPATCH_SOURCE_UNCONFIRMED',sourceFailure);equal(control(projectId).value.scope,data.scope);if(data.projectId!==projectId)fail('DURABLE_DISPATCH_HOST_REGISTRATION_INVALID');};
   current();const candidate=readPreparationTransportCandidate(projectId,data.admissionId,data.preparationIntentDigest,data.sourceIncarnation),cursor=cursors.get(candidate);if(!cursor)fail('DURABLE_DISPATCH_HOST_CURSOR_REQUIRED');
   current();candidate.assertCurrent();const before=snapshot(projectId),child=before.rows.get(rowKey('protocolReceipt',data.childKey)),intent=before.rows.get(rowKey('protocolReceipt',data.childKey+':preparation')),admission=before.rows.get(rowKey('protocolReceipt',data.childKey+':preparation-admission')),observed=before.rows.get(rowKey('protocolReceipt',data.childKey+':prepared'));
   if(!child||!intent||!admission)fail('DURABLE_DISPATCH_PREPARATION_ADMISSION_REQUIRED');
   const registration=runtimeHostRegistration(child,intent,admission,data),existing=before.rows.get(rowKey('protocolReceipt',registration.id));
   const assertCurrent=()=>{current();candidate.assertCurrent();};assertCurrent();
   if(existing){equal(existing,registration);return{ok:true,needsWrite:false,response:result({ok:true,hostEffect:{registration,operation:'history',effectPermission:'not_issued'}})};}
   const additions=freeze([freeze({collection:'protocolReceipt',value:registration})]),updates=freeze([freeze({collection:'protocolHead',value:runtimePreparationChildHead(child,intent,observed,admission,registration)}),freeze({collection:'protocolHead',value:runtimePreparationOutbox(child,intent,observed,admission,registration)})]);
   const combined=new Map(before.rows);for(const row of [...additions,...updates])combined.set(rowKey(row.collection,row.value.id),row.value);verifyGraph(projectId,combined,before.lineage);assertCurrent();if(nativeRevision()!==before.revision)fail();
   const originalProject=projects.get(projectId),originalBoard=boards.get(projectId);
   const assertLocal=()=>{if(projects.get(projectId)!==originalProject||boards.get(projectId)!==originalBoard)fail('DURABLE_DISPATCH_EXECUTION_SOURCE_CHANGED');equal(captureExecutionData(originalProject),before.sourceRows.get('project'));equal(captureExecutionData(readTaskBoardSnapshot(originalBoard)),before.sourceRows.get('board')?.tasks);};
   const token=freeze(create(null)),advanceToken=freeze(create(null)),response=result({ok:true,hostEffect:{registration,operation:'registered',effectPermission:'not_issued'}});
   const entry=freeze({runtime:true,projectId,revision:before.revision,before:before.rows,lineage:before.lineage,sourceRows:before.sourceRows,additions,updates,assertCurrent,assertSqlCurrent(){current();assertLocal();},assertLocal,response});
   prepared.set(token,entry);hostAdvances.set(advanceToken,{token,entry,candidate,cursor,oldRevision:cursor.revision,oldRows:cursor.rows,nextRows:combined,used:false,current});
   return{ok:true,needsWrite:true,token,response,hostAdvanceToken:advanceToken};
  }catch(error){if(error instanceof DispatchError||error instanceof DispatchPreparationDataError)return result({ok:false,error:error.message});throw error;}finally{preparing.delete(projectId);}
 }
 function prepareHostNoEffectFinish(projectId,frame,context){
  if(preparing.has(projectId)||pending.has(projectId))return result({ok:false,error:'DURABLE_DISPATCH_OPERATION_BUSY'});preparing.add(projectId);
  try{
   fields(context,['requestSource']);if(context.requestSource!=='scheduler')fail('DURABLE_DISPATCH_PREPARATION_SCHEDULER_REQUIRED');
   if(floor()?.profile!==DURABLE_DISPATCH_RUNTIME_WRITER_PROFILE)fail('DURABLE_DISPATCH_PREPARATION_PROFILE_REQUIRED');
   if(sourceBroken)fail('DURABLE_DISPATCH_SOURCE_UNCONFIRMED',sourceFailure);
   if(!preparationSource||!syncFunction(preparationResolver)||!readPreparationHostRegistration)fail('DURABLE_DISPATCH_PREPARATION_SOURCE_REQUIRED');
   const reply=invoke(preparationResolver,preparationSource,[frame,'finish_host_no_effect'],false);scanSourceData(reply,true);const envelope=fields(reply,['data','assertCurrent']),data=captureHostNoEffectData(envelope.data.value),guard=envelope.assertCurrent.value;
   const current=()=>{invoke(guard,reply,[],true);if(sourceBroken)fail('DURABLE_DISPATCH_SOURCE_UNCONFIRMED',sourceFailure);equal(control(projectId).value.scope,data.scope);if(data.projectId!==projectId)fail('DURABLE_DISPATCH_HOST_NO_EFFECT_INVALID');};
   current();const registrationToken=readPreparationHostRegistration(projectId,data),original=hostAdvances.get(registrationToken);if(!original||acceptedTokens.get(original.token)!==original.entry)fail('DURABLE_DISPATCH_HOST_SETTLEMENT_REQUIRED');
   const registration=original.entry.additions[0].value,before=snapshot(projectId);equal(before.rows.get(rowKey('protocolReceipt',registration.id)),registration);
   const child=before.rows.get(rowKey('protocolReceipt',registration.childKey)),intent=before.rows.get(rowKey('protocolReceipt',registration.childKey+':preparation')),admission=before.rows.get(rowKey('protocolReceipt',registration.childKey+':preparation-admission'));
   if(before.rows.has(rowKey('protocolReceipt',registration.childKey+':prepared')))fail('DURABLE_DISPATCH_HOST_FATE_CONFLICT');
   const finish=runtimeHostNoEffectFinish(child,registration,data),existing=before.rows.get(rowKey('protocolReceipt',finish.id));
   const checkSnapshot=()=>{const now=snapshot(projectId);equal(now.revision,before.revision);for(const key of ['rows','lineage','sourceRows'])equal([...now[key]],[...before[key]]);};
   const assertCurrent=()=>{current();checkSnapshot();current();checkSnapshot();};assertCurrent();
   if(existing){equal(existing,finish);return{ok:true,needsWrite:false,response:result({ok:true,hostEffect:{registration,noEffectFinish:existing,operation:'history',effectPermission:'not_issued'}})};}
   const additions=freeze([freeze({collection:'protocolReceipt',value:finish})]),updates=freeze([freeze({collection:'protocolHead',value:runtimePreparationChildHead(child,intent,undefined,admission,registration,finish)}),freeze({collection:'protocolHead',value:runtimePreparationOutbox(child,intent,undefined,admission,registration,finish)})]);
   const combined=new Map(before.rows);for(const row of [...additions,...updates])combined.set(rowKey(row.collection,row.value.id),row.value);verifyGraph(projectId,combined,before.lineage);assertCurrent();
   const project=projects.get(projectId),board=boards.get(projectId),assertLocal=()=>{if(projects.get(projectId)!==project||boards.get(projectId)!==board)fail();equal(captureExecutionData(project),before.sourceRows.get('project'));equal(captureExecutionData(readTaskBoardSnapshot(board)),before.sourceRows.get('board')?.tasks);};
   const token=freeze(create(null)),advanceToken=freeze(create(null)),response=result({ok:true,hostEffect:{registration,noEffectFinish:finish,operation:'no_effect_finished',effectPermission:'not_issued'}});
   const entry=freeze({runtime:true,projectId,revision:before.revision,before:before.rows,lineage:before.lineage,sourceRows:before.sourceRows,additions,updates,assertCurrent,assertSqlCurrent(){current();assertLocal();},assertLocal,response});prepared.set(token,entry);
   finishAdvances.set(advanceToken,{token,entry,registrationToken,original,nextRows:combined,current,used:false});return{ok:true,needsWrite:true,token,response,finishAdvanceToken:advanceToken,registrationToken};
  }catch(error){if(error instanceof DispatchError||error instanceof DispatchPreparationDataError)return result({ok:false,error:error.message});throw error;}finally{preparing.delete(projectId);}
 }
 return freeze({
  hasUnresolvedHostRegistration(){
   if(floor()?.profile!==DURABLE_DISPATCH_RUNTIME_WRITER_PROFILE)return false;
   const revision=nativeRevision(),count=backend.physicalRowCount(),physical=backend.rows(),candidates=new Set();
   if(!Number.isSafeInteger(count)||count<0||physical.length!==count)fail();
   for(let i=0;i<physical.length;i++){
    const row=physical[i];if(!isAcceptanceRecord(row.value))continue;
    if(!acceptanceRecordMatchesFloor(row.value,floor()))fail();
    if(row.projectId!==row.value.projectId||typeof row.projectId!=='string')fail();candidates.add(row.projectId);
   }
   let unresolved=false;
   for(const projectId of candidates){const observed=snapshot(projectId);if(observed.revision!==revision)fail();for(const value of observed.rows.values())if(value.kind==='ordinary_default_dispatch_host_registration'&&!observed.rows.has(rowKey('protocolReceipt',value.id+':no-effect-finish')))unresolved=true;}
   const checked=backend.rows();equal(checked,physical);if(checked.length!==backend.physicalRowCount()||nativeRevision()!==revision)fail();
   return unresolved;
  },
  prepareHostNoEffectFinish,
  advanceHostNoEffectFinish(token){
   const row=finishAdvances.get(token);if(!row||row.used||acceptedTokens.get(row.token)!==row.entry)fail('DURABLE_DISPATCH_HOST_SETTLEMENT_REQUIRED');row.used=true;
   const check=()=>{const now=snapshot(row.entry.projectId);if(now.revision!==row.entry.revision+1||now.rows.size!==row.nextRows.size)fail();for(const [key,value]of row.nextRows)equal(now.rows.get(key),value);equal([...now.sourceRows],[...row.entry.sourceRows]);if(nativeRevision()!==now.revision)fail();};
   row.current();check();row.current();check();return row.registrationToken;
  },
  prepareHostRegistration,
  advanceRegisteredHost(token){
   const row=hostAdvances.get(token);if(!row||row.used||acceptedTokens.get(row.token)!==row.entry)fail('DURABLE_DISPATCH_HOST_ADVANCE_REQUIRED');row.used=true;
   row.current();const now=snapshot(row.entry.projectId);if(row.cursor.revision!==row.oldRevision||row.cursor.rows!==row.oldRows||now.revision!==row.oldRevision+1||now.rows.size!==row.nextRows.size)fail('DURABLE_DISPATCH_HOST_ADVANCE_REQUIRED');
   for(const [key,value]of row.nextRows)equal(now.rows.get(key),value);equal(now.sourceRows.get('project'),row.entry.sourceRows.get('project'));equal(now.sourceRows.get('board'),row.entry.sourceRows.get('board'));row.current();const checked=snapshot(row.entry.projectId);if(checked.revision!==now.revision||checked.rows.size!==row.nextRows.size)fail('DURABLE_DISPATCH_HOST_ADVANCE_REQUIRED');for(const [key,value]of row.nextRows)equal(checked.rows.get(key),value);equal(checked.sourceRows.get('project'),row.entry.sourceRows.get('project'));equal(checked.sourceRows.get('board'),row.entry.sourceRows.get('board'));if(nativeRevision()!==checked.revision)fail();
   if(row.cursor.revision!==row.oldRevision||row.cursor.rows!==row.oldRows)fail('DURABLE_DISPATCH_HOST_ADVANCE_REQUIRED');row.cursor.revision=now.revision;row.cursor.rows=row.nextRows;
  },
  readPreparationCall(projectId,frame,context){
   if(preparing.has(projectId)||pending.has(projectId))return result({ok:false,error:'DURABLE_DISPATCH_OPERATION_BUSY'});preparing.add(projectId);
   try{
    fields(context,['requestSource']);if(context.requestSource!=='scheduler')fail('DURABLE_DISPATCH_PREPARATION_SCHEDULER_REQUIRED');
    if(!preparationSource||!syncFunction(preparationResolver)||!invokeGuard||!retainSourceTail||!inspectPreparationTransportCall)fail('DURABLE_DISPATCH_PREPARATION_SOURCE_REQUIRED');
    if(sourceBroken)fail('DURABLE_DISPATCH_SOURCE_UNCONFIRMED',sourceFailure);
    const available=()=>{if(!isPreparationReadQuiescent||isPreparationReadQuiescent()!==true)fail('DURABLE_DISPATCH_OPERATION_BUSY');};available();
    if(typeof projectId!=='string'||!projectId||projectId.length>256||childReadExec(/[\x00-\x1f\x7f]/,projectId)!==null)fail('DURABLE_DISPATCH_CHILD_LOOKUP_INVALID');
    const reply=invoke(preparationResolver,preparationSource,[frame,'read_call'],false);available();scanSourceData(reply,true);
    const envelope=fields(reply,['data','assertCurrent']);fields(envelope.data.value,['scope','projectId','admissionId','preparationIntentDigest','sourceIncarnation']);const data=captureExecutionData(envelope.data.value),guard=envelope.assertCurrent.value;
    fields(data.scope,['profileId','workspaceId']);if(data.projectId!==projectId||typeof data.admissionId!=='string'||typeof data.preparationIntentDigest!=='string'||childReadExec(/^[a-f0-9]{64}$/,data.preparationIntentDigest)===null||typeof data.sourceIncarnation!=='string'||childReadExec(/^[a-f0-9]{64}$/,data.sourceIncarnation)===null)fail('DURABLE_DISPATCH_PREPARATION_CALL_UNAVAILABLE');
    const current=()=>{invoke(guard,reply,[],true);available();if(sourceBroken)fail('DURABLE_DISPATCH_SOURCE_UNCONFIRMED',sourceFailure);equal(control(projectId).value.scope,data.scope);};
    current();const observed=inspectPreparationTransportCall(projectId,data.admissionId,data.preparationIntentDigest,data.sourceIncarnation);current();equal(inspectPreparationTransportCall(projectId,data.admissionId,data.preparationIntentDigest,data.sourceIncarnation),observed);
    return result({ok:true,protocol:'ordinary_default_dispatch_preparation_call_v1',...observed});
   }catch(error){if(error instanceof DispatchError)return result({ok:false,error:error.message});throw error;}finally{preparing.delete(projectId);}
  },
  readPreparationBasis(projectId,frame,context){
   if(preparing.has(projectId)||pending.has(projectId))return result({ok:false,error:'DURABLE_DISPATCH_OPERATION_BUSY'});preparing.add(projectId);
   try{
    fields(context,['requestSource']);if(context.requestSource!=='scheduler')fail('DURABLE_DISPATCH_PREPARATION_SCHEDULER_REQUIRED');
    if(!preparationSource||!syncFunction(preparationResolver)||!invokeGuard||!retainSourceTail)fail('DURABLE_DISPATCH_PREPARATION_SOURCE_REQUIRED');
    if(sourceBroken)fail('DURABLE_DISPATCH_SOURCE_UNCONFIRMED',sourceFailure);
    const available=()=>{if(!isPreparationReadQuiescent||isPreparationReadQuiescent()!==true)fail('DURABLE_DISPATCH_OPERATION_BUSY');};available();
    if(typeof projectId!=='string'||!projectId||projectId.length>256||childReadExec(/[\x00-\x1f\x7f]/,projectId)!==null)fail('DURABLE_DISPATCH_CHILD_LOOKUP_INVALID');
    // Only the original source may identify this scheduler read. Its opaque
    // frame is resolved before any caller data or candidate getter is read.
    const reply=invoke(preparationResolver,preparationSource,[frame,'read_basis'],false);available();scanSourceData(reply,true);
    const envelope=fields(reply,['data','assertCurrent']);fields(envelope.data.value,['scope','projectId','childKey','payloadHash']);
    const data=captureExecutionData(envelope.data.value),guard=envelope.assertCurrent.value;
    fields(data.scope,['profileId','workspaceId']);
    if(data.projectId!==projectId||typeof data.childKey!=='string'||childReadExec(/^default-dispatch-child:[a-f0-9]{64}$/,data.childKey)===null||typeof data.payloadHash!=='string'||childReadExec(/^[a-f0-9]{64}$/,data.payloadHash)===null)fail('DURABLE_DISPATCH_CHILD_LOOKUP_INVALID');
    const current=()=>{invoke(guard,reply,[],true);available();if(sourceBroken)fail('DURABLE_DISPATCH_SOURCE_UNCONFIRMED',sourceFailure);equal(control(projectId).value.scope,data.scope);};
    current();const observed=snapshot(projectId);current();
    // Reentrant source callbacks may change physical rows without advancing
    // the cached revision. Verify the complete same graph after the last one.
    const checked=snapshot(projectId);available();equal(checked.revision,observed.revision);
    const collections=['rows','lineage','sourceRows'];
    for(let i=0;i<collections.length;i++){
     const before=observed[collections[i]],after=checked[collections[i]];if(before.size!==after.size)fail();
     for(const [key,value]of before)equal(after.get(key),value);
    }
    const child=observed.rows.get(rowKey('protocolReceipt',data.childKey));
    if(!child||child.kind!==operationKinds.child)fail('DURABLE_DISPATCH_CHILD_NOT_FOUND');
    if(child.payloadHash!==data.payloadHash)fail('DURABLE_DISPATCH_CHILD_HASH_MISMATCH');
    return result({ok:true,protocol:'ordinary_default_dispatch_preparation_basis_v2',revision:observed.revision,child,
     hostEffect:{registration:observed.rows.get(rowKey('protocolReceipt',child.id+':host-registration'))??null,noEffectFinish:observed.rows.get(rowKey('protocolReceipt',child.id+':host-registration:no-effect-finish'))??null},
     intent:observed.rows.get(rowKey('protocolReceipt',child.id+':preparation'))??null,
     admission:observed.rows.get(rowKey('protocolReceipt',child.id+':preparation-admission'))??null,
     observation:observed.rows.get(rowKey('protocolReceipt',child.id+':prepared'))??null});
   }catch(error){if(error instanceof DispatchError)return result({ok:false,error:error.message});throw error;}finally{preparing.delete(projectId);}
  },
  readChildPreparation:(projectId,frame,context)=>prepareRuntime(projectId,frame,context,'observe'),
  prepareChild:(projectId,frame,context)=>prepareRuntime(projectId,frame,context,'prepare'),
  admitChildPreparation:(projectId,frame,context)=>prepareRuntime(projectId,frame,context,'admit'),
  acknowledgeChild:(projectId,frame,context)=>prepareRuntime(projectId,frame,context,'acknowledge'),
  prepare(projectId,frame,context){
   if(preparing.has(projectId)||pending.has(projectId))return result({ok:false,error:'DURABLE_DISPATCH_OPERATION_BUSY'});preparing.add(projectId);
   try{
    if(!source||!resolver||!invokeGuard||!retainSourceTail)fail('DURABLE_DISPATCH_SOURCE_UNAVAILABLE');if(sourceBroken)fail('DURABLE_DISPATCH_SOURCE_UNCONFIRMED',sourceFailure);
    const contextData=captureExecutionData(context);if(!contextData||!own(contextData,'requestSource')||contextData.requestSource!=='user')fail('DURABLE_DISPATCH_USER_REQUIRED');
    const reply=invoke(resolver,source,[frame],false);scanSourceData(reply,true);const envelope=fields(reply,['data','assertCurrent']);
    const fact=captureDefaultDispatchActionRecord(envelope.data.value),guard=envelope.assertCurrent.value,plan=current(projectId,fact,context,guard,reply),before=snapshot(projectId),additions=[],ids=[],selected=candidates(projectId,plan,fact.actionId);
    const add=(collection,value)=>{const key=rowKey(collection,value.id),old=before.rows.get(key);if(old)equal(old,value);else append(additions,{collection,value});};
    add('protocolReceipt',actionRecord(fact));
    for(let i=0;i<plan.tasks.length;i++){
     const birth=plan.tasks[i],candidate=selected[i],old=before.rows.get(rowKey('protocolReceipt',candidate.id));
     if(old){equal({...old,originActionReceiptId:fact.actionId},candidate);}else{add('protocolReceipt',candidate);add('protocolReceipt',intentRecord(candidate));add('protocolHead',childHead(candidate));add('protocolHead',outboxHead(candidate));}
     append(ids,candidate.id);
    }
    sort(ids);const parent=parentRecord(fact,ids);add('protocolReceipt',parent);const combined=new Map(before.rows);for(let i=0;i<additions.length;i++)combined.set(rowKey(additions[i].collection,additions[i].value.id),additions[i].value);verifyGraph(projectId,combined,before.lineage);
    current(projectId,fact,context,guard,reply);equal(candidates(projectId,plan,fact.actionId),selected);if(nativeRevision()!==before.revision)fail();const response=result({ok:true,operation:projection(parent,combined)});
    if(!additions.length)return{ok:true,needsWrite:false,response};
    for(let i=0;i<additions.length;i++)freeze(additions[i]);freeze(additions);const token=freeze(create(null)),entry=freeze({projectId,fact,context,guard,reply,plan,revision:before.revision,before:before.rows,sourceRows:before.sourceRows,selected,additions,response});prepared.set(token,entry);return{ok:true,needsWrite:true,token,response};
   }catch(error){if(error instanceof DispatchError||error?.message==='DURABLE_DISPATCH_ACTION_DATA_INVALID')return result({ok:false,error:error.message});throw error;}finally{preparing.delete(projectId);}
  },
  accept(token){const entry=prepared.get(token);if(!entry||pending.has(entry.projectId))fail();prepared.delete(token);acceptedTokens.set(token,entry);pending.set(entry.projectId,entry);return entry.response;},
  stage(scope,birthIds,projectCandidates){
   if(!active())return;
   const projectsToCheck=new Set();for(const row of backend.rows())if(durableDispatchRecordCollection(row.value)&&(scope.type==='full'||row.projectId===scope.projectId))projectsToCheck.add(row.projectId);
   for(const [projectId,entry]of pending)if(scope.type==='full'||scope.projectId===projectId)projectsToCheck.add(projectId);
   for(const projectId of projectsToCheck){const before=snapshot(projectId),entry=pending.get(projectId);if(!entry)continue;if(before.revision!==entry.revision)fail();equal([...before.rows],[...entry.before]);if(entry.runtime){entry.assertCurrent();}else{equal(current(projectId,entry.fact,entry.context,entry.guard,entry.reply),entry.plan);equal(candidates(projectId,entry.plan,entry.fact.actionId),entry.selected);}if(nativeRevision()!==entry.revision)fail();const projected=projectCandidates?.get(projectId);if(!projected||!entry.sourceRows.has('board'))fail();if(entry.runtime)equal(captureExecutionData(projected),entry.sourceRows.get('project'));entryProjection.set(projectId,captureExecutionData(projected));
    for(let i=0;i<entry.additions.length;i++){const row=entry.additions[i],map=originalMap(row.collection);if(map.has(row.value.id))fail();map.set(row.value.id,row.value);append(birthIds,rowKey(row.collection,row.value.id));}
    if(entry.runtime)for(const update of entry.updates){const map=originalMap(update.collection);equal(map.get(update.value.id),entry.before.get(rowKey(update.collection,update.value.id)));map.set(update.value.id,update.value);}
   }
  },
  runtimeChecks(scope){
   const entries=[];for(const [projectId,entry]of pending)if(entry.runtime&&(scope.type==='full'||scope.projectId===projectId))append(entries,entry);
   if(!entries.length)return;
   return freeze({assertCurrent(){for(let i=0;i<entries.length;i++){const entry=entries[i];if(pending.get(entry.projectId)!==entry)fail();entry.assertSqlCurrent();}},assertLocal(){for(let i=0;i<entries.length;i++)entries[i].assertLocal();}});
  },
  requiredRows(scope){
   const rows=[];
   for(const [projectId,entry]of pending)if(scope.type==='full'||scope.projectId===projectId){
    const expected=new Map();
    // SQL-phase guards may run after the revision UPSERT. Keep the entire
    // original protected lineage in inverse coverage, not only new receipts.
    if(entry.runtime)for(const [key,value]of entry.lineage){const collection=key===rowKey('protocolReceipt',value.id)?'protocolReceipt':'protocolHead';expected.set(key,{collection,key:value.id,projectId,value});}
    for(const row of [...entry.additions,...(entry.updates??[])])expected.set(rowKey(row.collection,row.value.id),{collection:row.collection,key:row.value.id,projectId,value:row.value});
    for(const value of expected.values())append(rows,freeze(value));
    append(rows,freeze({collection:'project',key:projectId,projectId,value:entryProjection.get(projectId),comparison:'json'}));append(rows,freeze({collection:'board',key:projectId,projectId,value:entry.sourceRows.get('board'),comparison:'json'}));
   }
   return freeze(rows);
  },
  clear(scope){for(const projectId of pending.keys())if(scope.type==='full'||scope.projectId===projectId){pending.delete(projectId);entryProjection.delete(projectId);}},
  abort(projectId){{pending.delete(projectId);entryProjection.delete(projectId);}},
  readChild(projectId,lookup,token){
   try{
    const authority=resolveProjectInputAuthority(token);if(authority?.requestSource!=='user'||authority.kind!=='desktop_control')fail('PROJECT_INPUT_AUTHORITY_REQUIRED');
    if(typeof projectId!=='string'||!projectId||projectId.length>256||childReadExec(/[\x00-\x1f\x7f]/,projectId)!==null)fail('DURABLE_DISPATCH_CHILD_LOOKUP_INVALID');
    fields(lookup,['childKey','payloadHash']);
    let data;try{data=captureExecutionData(lookup);}catch(error){fail('DURABLE_DISPATCH_CHILD_LOOKUP_INVALID',error);}
    fields(data,['childKey','payloadHash']);
    if(typeof data.childKey!=='string'||childReadExec(/^default-dispatch-child:[a-f0-9]{64}$/,data.childKey)===null||typeof data.payloadHash!=='string'||childReadExec(/^[a-f0-9]{64}$/,data.payloadHash)===null)fail('DURABLE_DISPATCH_CHILD_LOOKUP_INVALID');
    const {value}=control(projectId);equal(value.scope,{profileId:authority.profileId,workspaceId:authority.workspaceId});
    const observed=snapshot(projectId),child=observed.rows.get(rowKey('protocolReceipt',data.childKey));
    if(!child||child.kind!==operationKinds.child)fail('DURABLE_DISPATCH_CHILD_NOT_FOUND');
    if(child.payloadHash!==data.payloadHash)fail('DURABLE_DISPATCH_CHILD_HASH_MISMATCH');
    // Detached immutable data, not a preparation, transport or launch proof.
    return result({ok:true,child});
   }catch(error){if(error instanceof DispatchError)return result({ok:false,error:error.message});throw error;}
  },
  read(projectId,lookup,token){
   try{const authority=resolveProjectInputAuthority(token);if(authority?.requestSource!=='user'||authority.kind!=='desktop_control')fail('PROJECT_INPUT_AUTHORITY_REQUIRED');const {value}=control(projectId);equal(value.scope,{profileId:authority.profileId,workspaceId:authority.workspaceId});const data=captureExecutionData(lookup);if(keys(data).length!==2||!Number.isSafeInteger(data.planRevision)||data.planRevision<1||!Number.isSafeInteger(data.dispatchGeneration)||data.dispatchGeneration<1)fail();const observed=snapshot(projectId),id=parentId({scope:value.scope,actorId:'desktop-user:'+value.scope.profileId,projectId,...data}),parent=observed.rows.get(rowKey('protocolReceipt',id));if(!parent)return result({ok:false,error:'DURABLE_DISPATCH_OPERATION_NOT_FOUND'});return result({ok:true,operation:projection(parent,observed.rows)});}catch(error){if(error instanceof DispatchError)return result({ok:false,error:error.message});throw error;}
  },
 });
}
