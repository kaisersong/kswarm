import {IntrinsicMap as Map,IntrinsicSet as Set,IntrinsicWeakMap as WeakMap} from './intrinsic-collections.js';
import {isDeepStrictEqual,types} from 'node:util';
import {captureExecutionData} from './task-execution-content.js';
import {protocolDigest} from './project-protocol.js';
import {isDurableDispatchStorageProfile,DURABLE_DISPATCH_PLAN_CONTRACT} from './initial-plan-acceptance-contract.js';
import {defaultDispatchBusinessIdentity} from './default-dispatch-birth-rules.js';
export const dispatchPlanTaskSetDigest=tasks=>protocolDigest(['default-dispatch-plan-tasks-v1',tasks]);
const kind='ordinary_default_dispatch_plan_head';
const key=(scope,projectId)=>'dispatch-plan:'+protocolDigest(['default-dispatch-plan-v1',scope,projectId]);
const fail=()=>{throw Error('DURABLE_DISPATCH_PLAN_UNVERIFIED');};
const same=(a,b)=>{if(!isDeepStrictEqual(a,b))fail();};
const sort=Function.prototype.call.bind(Array.prototype.sort),define=Object.defineProperty;
function append(items,value){define(items,String(items.length),{__proto__:null,value,enumerable:true,writable:true,configurable:true});}
function version(project){
 if(!project||typeof project!=='object'||types.isProxy(project))fail();
 const plan=Object.getOwnPropertyDescriptor(project,'plan');if(!plan)return null;if(!Object.hasOwn(plan,'value'))fail();if(plan.value===undefined||plan.value===null)return null;
 if(typeof plan.value!=='object'||types.isProxy(plan.value)||![Object.prototype,null].includes(Object.getPrototypeOf(plan.value)))fail();
 const fields=Object.getOwnPropertyDescriptors(plan.value),value=fields.version;if(!value||!Object.hasOwn(value,'value')||!Number.isSafeInteger(value.value)||value.value<1)fail();return value.value;
}
/** A child of the original acceptance owner. Only the original birth stage
 * supplies changes; ordinary saves cannot authorize head creation/advancement. */
export function createDurableDispatchPlanRules({backend,projects,boards,receipts,heads,readBinding,floor,readBirths,inspectBirths}){
 const active=()=>isDurableDispatchStorageProfile(floor()?.profile);
 const preparations=new WeakMap(),planChanges=new Map();
 function nativeRevision(){const value=backend.readCurrentRevision();if(!value||value.actual!==value.cached||!Number.isSafeInteger(value.actual)||value.actual<0)fail();return value.actual;}
 function members(projectId,ids,births=receipts){
  const value=floor(),out=[],ordered=[];for(let i=0;i<ids.length;i++)append(ordered,ids[i]);sort(ordered);let last;
  for(let i=0;i<ordered.length;i++){
   const taskId=ordered[i];if(typeof taskId!=='string'||taskId===last)fail();last=taskId;
   const birth=births.get(defaultDispatchBusinessIdentity(value.scope,projectId,taskId).receipt);
   if(!birth||birth.kind!=='ordinary_default_dispatch_birth'||birth.projectId!==projectId||birth.taskId!==taskId||birth.businessExecutionGeneration!==1||birth.writerStoreId!==value.storeId)fail();
   append(out,{taskId,businessExecutionGeneration:birth.businessExecutionGeneration,childKey:birth.childKey,contentDigest:birth.contentDigest,birthReceiptId:birth.id});
  }
  return captureExecutionData(out);
 }
 function record(projectId,tasks,revision,planVersion){
  const value=floor(),binding=readBinding(projectId);if(binding.classification!=='ordinary'||!isDeepStrictEqual(binding.binding.scope,value.scope))fail();
  return captureExecutionData({id:key(value.scope,projectId),kind,schemaVersion:1,contract:DURABLE_DISPATCH_PLAN_CONTRACT,projectId,scope:value.scope,writerStoreId:value.storeId,bindingDigest:protocolDigest(binding.binding),revision,dispatchGeneration:1,planVersion,taskSetDigest:dispatchPlanTaskSetDigest(tasks),tasks});
 }
 function checked(projectId,physical,basis){
  const id=key(floor().scope,projectId),row=physical.get(id),head=heads.get(id);
  if(!row||row.projectId!==projectId||!head||!Number.isSafeInteger(head.revision)||head.revision<1)fail();same(head,row.value);
  if(head.planVersion!==null&&(!Number.isSafeInteger(head.planVersion)||head.planVersion<1))fail();
  same(head,record(projectId,head.tasks,head.revision,head.planVersion));if(basis){same(head.tasks,basis.tasks);if(head.planVersion!==basis.planVersion)fail();}return head;
 }
 function inspect(projectId){
  if(!active())return{ok:false,error:'DURABLE_DISPATCH_PROFILE_UNQUALIFIED'};
  try{
   const revision=nativeRevision(),births=inspectBirths(projectId);if(!births.ok)return births;
   const physical=new Map();let physicalProject;
   for(const row of backend.rows()){if(row.collection==='project'&&row.key===projectId)physicalProject=row.value;if(row.collection==='protocolHead'&&row.value.kind===kind){if(row.key!==row.value.id||row.key!==key(floor().scope,row.projectId)||physical.has(row.key))fail();physical.set(row.key,row);}}
   const head=checked(projectId,physical),ids=[];for(let i=0;i<births.tasks.length;i++)append(ids,births.tasks[i].taskId);
   same(head.tasks,members(projectId,ids));if(head.planVersion!==version(projects.get(projectId))||head.planVersion!==version(physicalProject)||nativeRevision()!==revision)fail();
   return captureExecutionData({ok:true,plan:head});
  }catch(error){if(error?.message!=='DURABLE_DISPATCH_PLAN_UNVERIFIED')throw error;return{ok:false,error:error.message};}
 }
 return Object.freeze({
  inspect,
  preparePlanChange(projectId){
   if(!active())return;
   const revision=nativeRevision(),project=projects.get(projectId),board=boards.get(projectId);let previous;
   for(const row of backend.rows())if(row.collection==='project'&&row.key===projectId)previous=row.value;
   if(!previous||!project||!board||planChanges.has(projectId))fail();const before=version(previous);if(version(project)!==before||nativeRevision()!==revision)fail();
   const frame=Object.freeze(Object.create(null));preparations.set(frame,{projectId,project,board,revision,before});return frame;
  },
  commitPlanChange(frame){
   if(!active())return;const entry=preparations.get(frame);if(!entry)fail();preparations.delete(frame);
   if(projects.get(entry.projectId)!==entry.project||boards.get(entry.projectId)!==entry.board||nativeRevision()!==entry.revision||planChanges.has(entry.projectId))fail();
   const after=version(entry.project);if(after!==(entry.before===null?1:entry.before+1))fail();
   planChanges.set(entry.projectId,{...entry,after,plan:entry.project.plan,data:captureExecutionData(entry.project.plan)});
  },
  clear(scope){for(const projectId of planChanges.keys())if(scope.type==='full'||scope.projectId===projectId)planChanges.delete(projectId);},
  abort(projectId){planChanges.delete(projectId);},
  stage(scope,birthIds,changes){
   if(!active())return;
   const physical=new Map(),physicalProjects=new Map(),physicalBoards=new Map(),physicalBirths=new Map(),inScope=projectId=>scope.type==='full'||scope.projectId===projectId;
   for(const row of backend.rows()){
    if(row.collection==='project')physicalProjects.set(row.key,row.value);
    if(row.collection==='board')physicalBoards.set(row.key,row.value);
    if(row.collection==='protocolReceipt')physicalBirths.set(row.key,row.value);
    if(row.collection==='protocolHead'&&row.value.kind===kind){if(row.key!==row.value.id||row.key!==key(floor().scope,row.projectId)||physical.has(row.key))fail();physical.set(row.key,row);}
   }
   const basis=projectId=>{const board=physicalBoards.get(projectId);if(!board||!Array.isArray(board.tasks))fail();const ids=[];for(let i=0;i<board.tasks.length;i++)append(ids,board.tasks[i].id);return{tasks:members(projectId,ids,physicalBirths),planVersion:version(physicalProjects.get(projectId))};};
   // The union detects forged additions, missing heap records and changed
   // physical records even when no task was added in this save.
   for(const row of physical.values())if(inScope(row.projectId))checked(row.projectId,physical,basis(row.projectId));
   for(const [id,head]of heads)if(head.kind===kind&&inScope(head.projectId)){if(id!==key(floor().scope,head.projectId)||!physical.has(id))fail();checked(head.projectId,physical,basis(head.projectId));}
   const admitted=[];for(let i=0;i<(changes?.length??0);i++)append(admitted,changes[i]);
   for(const [projectId,change]of planChanges)if(inScope(projectId)){
    if(projects.get(projectId)!==change.project||boards.get(projectId)!==change.board||nativeRevision()!==change.revision||change.project.plan!==change.plan)fail();same(captureExecutionData(change.project.plan),change.data);
    if(version(physicalProjects.get(projectId))!==change.before||version(change.project)!==change.after)fail();
    let exists=false;for(let i=0;i<admitted.length;i++)if(admitted[i].projectId===projectId)exists=true;
    if(!exists){const taskIds=[],tasks=boards.get(projectId).getAllTasks();for(let i=0;i<tasks.length;i++)append(taskIds,tasks[i].id);append(admitted,{projectId,born:false,taskIds});}
   }
   const changed=new Set();
   for(let i=0;i<admitted.length;i++){
    const change=admitted[i],projectId=change.projectId;if(changed.has(projectId)||!inScope(projectId))fail();changed.add(projectId);
    const value=floor(),id=key(value.scope,projectId),current=heads.get(id),tasks=members(projectId,change.taskIds);
    if(change.born){if(current||physical.has(id)||tasks.length||version(projects.get(projectId))!==null)fail();heads.set(id,record(projectId,tasks,1,version(projects.get(projectId))));birthIds.push(JSON.stringify(['protocolHead',id]));}
    else{if(!current)fail();checked(projectId,physical,basis(projectId));if(!planChanges.has(projectId)&&version(projects.get(projectId))!==current.planVersion)fail();if(isDeepStrictEqual(current.tasks,tasks)&&!planChanges.has(projectId))continue;if(current.revision>=Number.MAX_SAFE_INTEGER)fail();heads.set(id,record(projectId,tasks,current.revision+1,version(projects.get(projectId))));}
   }
  },
  read(projectId,token){if(!active())return{ok:false,error:'DURABLE_DISPATCH_PROFILE_UNQUALIFIED'};const births=readBirths(projectId,token);return births.ok?inspect(projectId):births;},
 });
}
