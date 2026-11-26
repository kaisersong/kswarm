// One projection for legacy dispatch and the stricter first-admit reader.
// Inputs for admission must be original, closed project/task snapshots. This
// projection contains data only; it grants no mutation or execution authority.
const isArray=Array.isArray,define=Object.defineProperty,create=Object.create,descriptor=Object.getOwnPropertyDescriptor,own=Object.hasOwn;
const value=(record,key)=>{if(!record||typeof record!=='object')return undefined;const field=descriptor(record,key);return field&&own(field,'value')?field.value:undefined;};
const put=(target,key,value)=>define(target,key,{__proto__:null,value,enumerable:true,writable:true,configurable:true});

export function taskDependencyGateView(project,tasks){
 const consumedArtifactIdsByTaskId=create(null),currentGateFactsByTaskId=create(null);
 for(let i=0;i<tasks.length;i++){
  const task=tasks[i],taskId=value(task,'id'),declarations=value(task,'consumedArtifactIdsByDependencyTaskId');
  if(declarations&&typeof declarations==='object'&&!isArray(declarations))put(consumedArtifactIdsByTaskId,taskId,declarations);
  const facts=value(value(project,'currentGateFacts'),taskId);
  const currentRunId=value(value(task,'lastRunLease'),'runId')||value(task,'recoveredRunId')||null;
  if(currentRunId&&facts&&value(facts,'sourceRunId')===currentRunId)put(currentGateFactsByTaskId,taskId,{
   sourceRunId:value(facts,'sourceRunId'),canonicalArtifacts:value(facts,'canonicalArtifacts'),evaluationSourceArtifact:value(facts,'evaluationSourceArtifact'),
  });
 }
 return{dependencyPolicies:value(project,'dependencyPolicies')||{},gateEvaluationsByTaskId:value(project,'gateEvaluations')||{},consumedArtifactIdsByTaskId,currentGateFactsByTaskId,schemaV2:value(project,'executionGateSchemaVersion')===2};
}

export function firstAdmitTaskDependencyContext(project,tasks,taskId){
 const version=value(project,'executionGateSchemaVersion');
 if(version!==undefined&&version!==1&&version!==2)return{ok:false,error:'DURABLE_DISPATCH_GATE_SCHEMA_UNSUPPORTED'};
 const view=taskDependencyGateView(project,tasks);
 return{ok:true,context:{dependencyPolicies:view.dependencyPolicies,gateEvaluationsByTaskId:view.gateEvaluationsByTaskId,
  consumedArtifactIdsByDependencyTaskId:view.consumedArtifactIdsByTaskId[taskId]||{},currentGateFactsByTaskId:view.currentGateFactsByTaskId,schemaV2:view.schemaV2}};
}
