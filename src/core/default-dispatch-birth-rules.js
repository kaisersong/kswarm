import {isDeepStrictEqual} from 'node:util';
import {DEFAULT_DISPATCH_CONTRACT,durableDispatchRecordCollection,isDurableDispatchStorageProfile,DURABLE_DISPATCH_PLAN_CONTRACT,DEFAULT_DISPATCH_WRITER_PROFILE,isDefaultDispatchBirthProfile,semanticWriterByProfile} from './initial-plan-acceptance-contract.js';
import {protocolDigest,isProjectProtocolScope,projectProtocolIds} from './project-protocol.js';
import {resolveProjectInputAuthority} from './project-input-authority.js';
import {captureExecutionData,taskBusinessContentDigest,projectHandoffContent} from './task-execution-content.js';
class BirthStateError extends Error{}
const fail=code=>{throw new BirthStateError(code);},deny=error=>({ok:false,error});
const same=(a,b)=>{if(!isDeepStrictEqual(a,b))fail('DEFAULT_DISPATCH_BIRTH_UNVERIFIED');};
const sameScope=(a,b)=>a?.profileId===b?.profileId&&a?.workspaceId===b?.workspaceId;
const rowKey=(c,k)=>JSON.stringify([c,k]);
export function defaultDispatchBusinessIdentity(scope,projectId,taskId){const key=protocolDigest(['default-dispatch-business-key-v1',scope,projectId,taskId,1]);return{receipt:'dispatch-birth:'+key,head:'dispatch-generation:'+key,childKey:'default-dispatch-child:'+key};}
/** Child of the original acceptance controller, sharing its ONLY backend.
 * No public data, board method or reader creates these private preparations. */
export function createDefaultDispatchBirthRules({persistence,backend,projects,boards,receipts,heads,readBinding,floor}){
 const preparations=new WeakMap(),pending=new Map(),projectBirths=new Map();
 const active=()=>isDefaultDispatchBirthProfile(floor()?.profile);
 const rows=()=>new Map(backend.rows().map(row=>[rowKey(row.collection,row.key),row]));
 function context(projectId,physical=rows()){
  const value=floor(),writer=semanticWriterByProfile(value?.profile),binding=readBinding(projectId);
  if(!isDefaultDispatchBirthProfile(value?.profile)||!writer||value.profile!==writer.profile||value.schemaVersion!==writer.schemaVersion||value.writerProfileDigest!==writer.digest)fail('DEFAULT_DISPATCH_PROFILE_UNQUALIFIED');
  if(binding.classification!=='ordinary'||!isProjectProtocolScope(binding.binding.scope)||!sameScope(binding.binding.scope,value.scope))fail('DEFAULT_DISPATCH_SCOPE_UNVERIFIED');
  const ids=projectProtocolIds(projectId);for(const id of [ids.binding,ids.receipt]){const row=physical.get(rowKey('protocolReceipt',id)),record=receipts.get(id);if(!row||row.projectId!==projectId||row.key!==record?.id||!isDeepStrictEqual(row.value,record))fail('DEFAULT_DISPATCH_BINDING_UNVERIFIED');}
  const project=physical.get(rowKey('project',projectId));if(!project||project.projectId!==projectId||project.value.id!==projectId)fail('DEFAULT_DISPATCH_BIRTH_UNVERIFIED');same(projectHandoffContent(project.value),projectHandoffContent(projects.get(projectId)));
  return{value,binding,physical};
 }
 function boardData(board){const original=board.getAllTasks(),data=captureExecutionData(original),ids=data.map(task=>task.id);if(new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'||!id)||data.some((task,index)=>board.getTask(task.id)!==original[index]))fail('DEFAULT_DISPATCH_BIRTH_UNVERIFIED');return data;}
 function physicalBoard(projectId,physical){const row=physical.get(rowKey('board',projectId));if(!row||row.projectId!==projectId||row.value.projectId!==projectId||!Array.isArray(row.value.tasks))fail('DEFAULT_DISPATCH_BIRTH_UNVERIFIED');const data=captureExecutionData(row.value.tasks);if(new Set(data.map(task=>task.id)).size!==data.length)fail('DEFAULT_DISPATCH_BIRTH_UNVERIFIED');return data;}
 function record(projectId,task,ctx){const ids=defaultDispatchBusinessIdentity(ctx.value.scope,projectId,task.id),birth={id:ids.receipt,kind:'ordinary_default_dispatch_birth',schemaVersion:1,contract:DEFAULT_DISPATCH_CONTRACT,projectId,scope:{...ctx.value.scope},writerStoreId:ctx.value.storeId,bindingDigest:protocolDigest(ctx.binding.binding),taskId:task.id,businessExecutionGeneration:1,childKey:ids.childKey,contentDigest:taskBusinessContentDigest(projects.get(projectId),task)};
  return{birth,head:{id:ids.head,kind:'ordinary_default_dispatch_generation',schemaVersion:1,contract:DEFAULT_DISPATCH_CONTRACT,projectId,scope:{...ctx.value.scope},writerStoreId:ctx.value.storeId,bindingDigest:birth.bindingDigest,taskId:task.id,businessExecutionGeneration:1,revision:1,birthReceiptId:birth.id,birthDigest:protocolDigest(birth)}};
 }
 function checked(projectId,task,ctx){
  const ids=defaultDispatchBusinessIdentity(ctx.value.scope,projectId,task.id),birth=receipts.get(ids.receipt),head=heads.get(ids.head);
  if(!birth&&!head&&!ctx.physical.has(rowKey('protocolReceipt',ids.receipt))&&!ctx.physical.has(rowKey('protocolHead',ids.head)))fail('DEFAULT_DISPATCH_NEEDS_RECONCILIATION');
  const expected=record(projectId,task,ctx);
  // Current content may differ, but the original immutable birth is never reminted.
  same({...birth,contentDigest:expected.birth.contentDigest},expected.birth);
  same(head,{...expected.head,birthDigest:protocolDigest(birth)});
  for(const [collection,id,current] of [['protocolReceipt',ids.receipt,birth],['protocolHead',ids.head,head]]){const row=ctx.physical.get(rowKey(collection,id));if(!row||row.projectId!==projectId||row.key!==id)fail('DEFAULT_DISPATCH_BIRTH_UNVERIFIED');same(row.value,current);}
  if(birth.contentDigest!==expected.birth.contentDigest)fail('DEFAULT_DISPATCH_CONTENT_CONFLICT');
  return captureExecutionData({taskId:task.id,businessExecutionGeneration:1,contentDigest:birth.contentDigest,childKey:birth.childKey,birthReceiptId:birth.id});
 }
 function inspect(projectId){
  try{const ctx=context(projectId),tasks=boards.get(projectId)?.getAllTasks();if(!tasks)fail('project_not_found');same(boardData(boards.get(projectId)),physicalBoard(projectId,ctx.physical));return captureExecutionData({ok:true,protocol:'ordinary_default_dispatch_birth_read_v1',projectId,scope:ctx.value.scope,tasks:tasks.map(task=>checked(projectId,task,ctx))});}
  catch(error){if(!(error instanceof BirthStateError))throw error;return deny(error.message);}
 }
 return Object.freeze({
  inspect,active,
  noteProjectCreate(project,board){if(active())projectBirths.set(project.id,{project,board});},
  assertFreshPreparation(scope){
   const value=floor();if(value){if(!isDefaultDispatchBirthProfile(value.profile)||!sameScope(value.scope,scope))return deny('DEFAULT_DISPATCH_MIGRATION_REQUIRED');return{ok:true};}
   if(!backend||backend.rows().length)return deny('DEFAULT_DISPATCH_MIGRATION_REQUIRED');return{ok:true};
  },
  prepare(project,board,addition){
   if(!active())return;
   const ctx=context(project.id),before=boardData(board),actual=captureExecutionData(addition),previous=pending.get(project.id)??[];
   if(projects.get(project.id)!==project||boards.get(project.id)!==board||preparations.has(addition)||previous.length>=4096)fail('DEFAULT_DISPATCH_BIRTH_UNVERIFIED');
   const physical=physicalBoard(project.id,ctx.physical),known=new Set(physical.map(task=>task.id));for(const marker of previous)for(const task of marker.newRows)known.add(task.id);
   same(before.map(task=>task.id).sort(),[...known].sort());
   if(previous.length)same(before,previous.at(-1).after);
   const oldIds=new Set(before.map(task=>task.id)),expected=actual.identityPreview.filter(task=>!oldIds.has(task.id));
   const marker={project,board,globalRevision:persistence.getHealth().revision,physical,before,prepared:actual,expected:new Map(expected.map(task=>[task.id,taskBusinessContentDigest(project,task)])),used:false,committed:false,newRows:[]};
   preparations.set(addition,marker);
  },
  beforeCommit(project,board,addition){
   if(!active())return;
   const marker=preparations.get(addition);if(!marker||marker.used||marker.project!==project||marker.board!==board||projects.get(project.id)!==project||boards.get(project.id)!==board||marker.globalRevision!==persistence.getHealth().revision)fail('DEFAULT_DISPATCH_BIRTH_UNVERIFIED');
   same(captureExecutionData(addition),marker.prepared);same(boardData(board),marker.before);marker.used=true;
  },
  afterCommit(project,board,addition,result){
   if(!active())return;
   const marker=preparations.get(addition);if(!marker?.used||marker.committed||!result.ok)fail('DEFAULT_DISPATCH_BIRTH_UNVERIFIED');
   const after=boardData(board),beforeIds=new Set(marker.before.map(task=>task.id)),newRows=after.filter(task=>!beforeIds.has(task.id));
   same(newRows.map(task=>task.id).sort(),[...marker.expected.keys()].sort());same([...new Set(result.taskIds)].sort(),marker.prepared.identityPreview.map(task=>task.id).sort());
   for(const task of newRows)if(task.status!=='pending'||task.activeRunId||task.runLease||taskBusinessContentDigest(project,task)!==marker.expected.get(task.id))fail('DEFAULT_DISPATCH_BIRTH_UNVERIFIED');
   marker.after=after;marker.newRows=newRows;marker.committed=true;pending.set(project.id,[...(pending.get(project.id)??[]),marker]);
  },
  stage(scope,birthIds){
   if(!active())return [];
   const physical=rows(),changes=[];
   for(const [projectId,board] of boards){
    if(scope.type!=='full'&&scope.projectId!==projectId)continue;
    const oldRow=physical.get(rowKey('board',projectId));if(!oldRow){const birth=projectBirths.get(projectId);if(birth?.project!==projects.get(projectId)||birth?.board!==board||physical.has(rowKey('project',projectId))||boardData(board).length)fail('DEFAULT_DISPATCH_BIRTH_UNVERIFIED');changes.push({projectId,born:true,taskIds:[]});continue;} // Original project create writes only an empty board.
    const old=physicalBoard(projectId,physical),tasks=boardData(board),oldIds=new Set(old.map(task=>task.id)),newRows=tasks.filter(task=>!oldIds.has(task.id)),markers=pending.get(projectId)??[];
    if(old.some(task=>!tasks.some(current=>current.id===task.id)))fail('DEFAULT_DISPATCH_BIRTH_UNVERIFIED');
    if(markers.length){
     for(const marker of markers){if(!marker.committed||marker.globalRevision!==persistence.getHealth().revision||marker.project!==projects.get(projectId)||marker.board!==board)fail('DEFAULT_DISPATCH_BIRTH_UNVERIFIED');same(marker.physical,old);}
     same(tasks,markers.at(-1).after);
    }
    const claimed=markers.flatMap(marker=>marker.newRows);same(newRows.map(t=>t.id).sort(),claimed.map(t=>t.id).sort());
    if(!newRows.length)continue;
    const ctx=context(projectId,physical);
    for(const task of newRows){const {birth,head}=record(projectId,task,ctx),ids=defaultDispatchBusinessIdentity(ctx.value.scope,projectId,task.id);if(receipts.has(ids.receipt)||heads.has(ids.head)||physical.has(rowKey('protocolReceipt',ids.receipt))||physical.has(rowKey('protocolHead',ids.head)))fail('DEFAULT_DISPATCH_BIRTH_UNVERIFIED');
     const marker=markers.find(m=>m.newRows.some(t=>t.id===task.id));if(taskBusinessContentDigest(projects.get(projectId),task)!==marker.expected.get(task.id))fail('DEFAULT_DISPATCH_BIRTH_UNVERIFIED');
     receipts.set(birth.id,birth);heads.set(head.id,head);birthIds.push(rowKey('protocolReceipt',birth.id),rowKey('protocolHead',head.id));
    }
    changes.push({projectId,born:false,taskIds:tasks.map(task=>task.id)});
   }
   // Existing reserved ownership is retained and cannot be altered through an
   // otherwise valid controller frame for an unrelated original Hub mutation.
   for(const row of physical.values())if(['protocolReceipt','protocolHead'].includes(row.collection)&&row.value.kind?.startsWith('ordinary_default_dispatch_')){
    if(isDurableDispatchStorageProfile(floor()?.profile)&&durableDispatchRecordCollection(row.value)===row.collection)continue;
    if(isDurableDispatchStorageProfile(floor()?.profile)&&row.collection==='protocolHead'&&row.value.kind==='ordinary_default_dispatch_plan_head'&&row.value.contract===DURABLE_DISPATCH_PLAN_CONTRACT&&row.value.schemaVersion===1)continue;
    same((row.collection==='protocolReceipt'?receipts:heads).get(row.key),row.value);
   }
   return changes;
  },
  read(projectId,token){
   const authority=resolveProjectInputAuthority(token);if(authority?.requestSource!=='user'||authority.kind!=='desktop_control')return deny('PROJECT_INPUT_AUTHORITY_REQUIRED');
   try{
    const ctx=context(projectId);if(!sameScope(authority,ctx.value.scope))return deny('DEFAULT_DISPATCH_SCOPE_UNVERIFIED');
    const tasks=boards.get(projectId)?.getAllTasks();if(!tasks)fail('project_not_found');
    same(boardData(boards.get(projectId)),physicalBoard(projectId,ctx.physical));
    const values=tasks.map(task=>checked(projectId,task,ctx));return captureExecutionData({ok:true,protocol:'ordinary_default_dispatch_birth_read_v1',projectId,scope:ctx.value.scope,tasks:values});
   }catch(error){if(!(error instanceof BirthStateError))throw error;return deny(error.message);}
  },
  clear(scope){for(const map of [pending,projectBirths])for(const projectId of map.keys())if(scope.type==='full'||scope.projectId===projectId)map.delete(projectId);},
  abort(projectId){pending.delete(projectId);projectBirths.delete(projectId);},
 });
}
