import{createOriginalTaskDeliveryOwner}from'../core/original-task-delivery-owner.js';
import{isPersistenceCommitError}from'../core/sqlite-persistence.js';
import{join}from'node:path';
import{createBrokerTaskRequest}from'./broker-task-request.js';
import{sendTaskToBrokerParticipant,isBrokerDeliveryGuardFailure}from'./broker-task-delivery.js';
import{failureRecoveryTaskIds}from'../core/failure-recovery-dispatch.js';
const deliveryApply=Reflect.apply;
/** Fixed composition of the existing Server send path. No durable state,
 * poller or public HTTP capability; all facts stay with the original owners. */
export function createServerTaskDeliveryOwner(options){
 const{hub,scheduler,context,getBrokerClient,getProjectWorkspace,resolveAgentIntentRoute,projectsDir,agentStore,isAgentOnBroker,recordAgentRuntimeFailure,broadcast,log,desktopParticipantId,signal}=options;
 if(!context||Object.getOwnPropertyDescriptor(context,'requestSource')?.value!=='scheduler')throw Error('DELIVERY_SCHEDULER_AUTHORITY_REQUIRED');
 const prepare=scheduler.prepareDelivery.bind(scheduler),isAdmissionFailure=scheduler.isDeliveryAdmissionFailure.bind(scheduler),retainTail=scheduler.retainDeliveryGuardTail.bind(scheduler);
 const failWorker=hub.handleWorkerFailure.bind(hub),getAgent=agentStore?.get.bind(agentStore),setOffline=agentStore?.setOffline.bind(agentStore);
 const persistenceFailure=error=>isPersistenceCommitError(error)||error?.durableCommitted===true;
 const refused=error=>({ok:false,error:'TASK_DELIVERY_ADMISSION_REFUSED',cause:error});
 const controlWithTransport=(control,transport)=>{
  const combined=new AggregateError([transport,control],'TASK_DELIVERY_FAILED_WITH_PERSISTENCE',{cause:control});combined.transportCause=transport;
  if(isPersistenceCommitError(control))combined.name='PersistenceCommitError';
  for(const key of ['code','durableCommitted','exitCode','recoverable']){const field=Object.getOwnPropertyDescriptor(control,key);if(field&&Object.hasOwn(field,'value'))Object.defineProperty(combined,key,{value:field.value,enumerable:true});}
  return combined;
 };
 async function send(projectId,taskIds=[],actor){
  signal?.throwIfAborted();
  if(actor!==context||actor.requestSource!=='scheduler')throw Error('DELIVERY_SCHEDULER_AUTHORITY_REQUIRED');
  const brokerClient=getBrokerClient();if(!brokerClient||!brokerClient.isConnected())return{ok:false,error:'broker_unavailable'};
  const retryTaskIds=[];let firstFailure;
  for(const taskId of taskIds){
   let prepared;
   try{prepared=await prepare(projectId,taskId,context);}catch(error){if(persistenceFailure(error))throw error;if(isAdmissionFailure(error)){firstFailure??=refused(error);continue;}throw error;}
   signal?.throwIfAborted();
   if(!prepared.ok){firstFailure??=prepared;log('warn','Workspace delivery rejected',{projectId,taskId,error:prepared.error});continue;}
   const{project,task,assertCurrent}=prepared;if(!task.assignedAgent)continue;
   const route=task.assignedRuntimeInstance?{targetParticipantId:task.assignedRuntimeInstance,targetAgentId:task.assignedRuntimeInstance,executionMode:'self_running'}:resolveAgentIntentRoute(task.assignedAgent);
   const targetAgent=task.assignedAgent,targetParticipantId=route.targetParticipantId,guard={beforeSend:assertCurrent,onGuardTail:(raw,error)=>retainTail(raw,context,error)};let acknowledged=false;
   try{
    assertCurrent();const workspace=getProjectWorkspace(projectId);assertCurrent();
    const taskRequest=createBrokerTaskRequest({handoffRoot:join(projectsDir,projectId),project,workspace,task,targetAgent,targetParticipantId});
    if(!taskRequest.ok){
     firstFailure??=taskRequest;assertCurrent();log('warn','Failed to create task handoff',{projectId,taskId:task.id,agent:targetAgent,error:taskRequest.error});
     const failed=failWorker(projectId,task.id,targetAgent,task.activeRunId,'handoff_create_failed',taskRequest.error||'handoff_create_failed');retryTaskIds.push(...failureRecoveryTaskIds(failed));continue;
    }
    const delivery=await sendTaskToBrokerParticipant({brokerClient,targetId:targetParticipantId,kind:'request_task',isOnline:isAgentOnBroker,signal,waitTimeoutMs:8000,waitIntervalMs:200,request:taskRequest.request,...guard});
    if(delivery.ok){acknowledged=true;continue;}
    assertCurrent();log('warn','Failed to deliver request_task',{projectId,taskId:task.id,agent:targetAgent,targetParticipantId,error:delivery.error,delivery:delivery.delivery||null});
    const fallbackAgent=!task.assignedRuntimeInstance?getAgent?.(task.assignedAgent):null;let recordFailure=false;
    if(fallbackAgent?.fallbackToDesktopModel===true&&targetParticipantId!==desktopParticipantId){
     assertCurrent();const fallbackRequest=createBrokerTaskRequest({handoffRoot:join(projectsDir,projectId),project,workspace,task,targetAgent,targetParticipantId:desktopParticipantId});
     const fallback=fallbackRequest.ok?await sendTaskToBrokerParticipant({brokerClient,targetId:desktopParticipantId,kind:'request_task',isOnline:isAgentOnBroker,signal,waitTimeoutMs:8000,waitIntervalMs:200,request:fallbackRequest.request,...guard}):{ok:false,error:fallbackRequest.error||'fallback_handoff_failed'};
     if(fallback.ok){
      acknowledged=true;recordAgentRuntimeFailure(task.assignedAgent,'runtime_offline',delivery.error||'delivery_failed');
      log('warn','Agent runtime unavailable; task routed to Desktop current model',{projectId,taskId:task.id,agent:task.assignedAgent,fallbackRuntime:'desktop_current_model'});
      broadcast({type:'agent_runtime_fallback',projectId,taskId:task.id,agent:task.assignedAgent,fallbackRuntime:'desktop_current_model'});continue;
     }
     recordFailure=true;
    }
    firstFailure??=delivery;assertCurrent();const failed=failWorker(projectId,task.id,targetAgent,task.activeRunId,'runtime_offline',delivery.error||'delivery_failed');retryTaskIds.push(...failureRecoveryTaskIds(failed));
    if(recordFailure)recordAgentRuntimeFailure(task.assignedAgent,'runtime_offline',delivery.error||'delivery_failed');
    if(!task.assignedRuntimeInstance&&task.assignedAgent)setOffline?.(task.assignedAgent);
   }catch(error){
    if(signal?.aborted)throw error;
    if(persistenceFailure(error))throw error;
    if(acknowledged)throw error;
    if(isAdmissionFailure(error)||isBrokerDeliveryGuardFailure(error)){firstFailure??=refused(error);continue;}
    // The original transport error is retained; no new failure/retry mutation
    // may use a stale task after its awaited request.
    try{assertCurrent();}catch(admission){if(persistenceFailure(admission))throw controlWithTransport(admission,error);firstFailure??={...refused(admission),transportCause:error};continue;}
    firstFailure??={ok:false,error:'task_delivery_failed',cause:error};
    log('warn','Failed to send request_task',{projectId,taskId:task.id,agent:targetAgent,targetParticipantId,error:error.message});
    const failed=failWorker(projectId,task.id,targetAgent,task.activeRunId,'runtime_offline',error.message);retryTaskIds.push(...failureRecoveryTaskIds(failed));
    if(!task.assignedRuntimeInstance&&task.assignedAgent)setOffline?.(task.assignedAgent);
   }
  }
  if(retryTaskIds.length){const retried=await send(projectId,retryTaskIds,actor);if(!retried.ok)firstFailure??=retried;}
  return firstFailure??{ok:true};
 }
 let owner;
 const startPreparation=scheduler.startDefaultDispatchPreparationTransport;
 function preparationSend(projectId,frame,actor){
  if(actor!==context)throw Error('DELIVERY_SCHEDULER_AUTHORITY_REQUIRED');
  return deliveryApply(startPreparation,scheduler,[projectId,frame,owner,actor]);
 }
 owner=createOriginalTaskDeliveryOwner({constructionBinding:options.originalConstructionBinding,legacySend:send,preparationSend});return owner;
}
