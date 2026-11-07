/** Original timeout decisions and retry counts have one owner. A decision is
 * ephemeral provenance for the fixed Hub callback, never a JSON authority. */
const watchdogOwners=new WeakMap(),decisions=new WeakMap();
export function isOriginalWatchdog(watchdog){return watchdogOwners.has(watchdog);}
export function consumeWatchdogDecision(watchdog,frame){
 const owner=watchdogOwners.get(watchdog),entry=decisions.get(frame);
 if(!owner||!entry||entry.owner!==owner||entry.used||!owner.checking||entry.round!==owner.round)throw Error('WATCHDOG_DECISION_UNAVAILABLE');
 entry.used=true;return entry.data;
}
/** Shared original state-machine transition algorithm. Retry counts stay in
 * createWatchdog and advance only after the fixed owner reports success. */
export function applyWatchdogTimeout(board,task,retries,maxRetries){
 let result;
 if(retries>=maxRetries){result=board.transition(task.id,task.status==='in_progress'?'failed':'cancelled');return result.ok?{action:'failed_permanently',finalStatus:result.to}:null;}
 if(task.status==='in_progress'){result=board.transition(task.id,'failed');if(!result.ok)return null;}
 result=board.transition(task.id,'pending');return result.ok?{action:'retry',retry:retries+1}:null;
}
export function createWatchdog(opts){
 const {listProjects,getBoard,getTasks,applyTimeout,onTimeout,onError,intervalMs=60000,timeoutMs=600000,maxRetries=2}=opts;
 const retryCounts=new Map(),owner={checking:false,round:null,checks:0,lastCheckAt:null};let timer=null;
 function check(now=Date.now()){
  if(owner.checking)throw Error('WATCHDOG_CHECK_REENTRY');owner.checking=true;owner.round=Object.freeze({});owner.checks++;owner.lastCheckAt=now;
  try{
   const actions=[];
   for(const project of listProjects()){
    if(project.status==='closed'||project.status==='delivered')continue;
    const board=getTasks?null:getBoard(project.id),tasks=getTasks?getTasks(project.id):board?.getAllTasks();if(!tasks)continue;
    for(const observed of tasks){
     let task=observed;
     if(!['dispatched','accepted','in_progress'].includes(task.status))continue;
     if(now-(task.updatedAt||task.createdAt||now)<timeoutMs)continue;
     if(getTasks){task=getTasks(project.id).find(current=>current.id===observed.id);if(!task||!['dispatched','accepted','in_progress'].includes(task.status)||now-(task.updatedAt||task.createdAt||now)<timeoutMs)continue;}
     const retries=retryCounts.get(task.id)||0;let action;
     if(applyTimeout){
      const frame=Object.freeze(Object.create(null));decisions.set(frame,{owner,round:owner.round,used:false,data:Object.freeze({projectId:project.id,task,now,retries,maxRetries,timeoutMs})});
      const result=applyTimeout(project.id,task,frame);if(result?.ok!==true)continue;action=result.action;
     }else action=applyWatchdogTimeout(board,task,retries,maxRetries);
     if(action){
      if(action.action==='retry')retryCounts.set(task.id,action.retry);
      actions.push({projectId:project.id,taskId:task.id,...action});if(onTimeout)onTimeout(project.id,task,action);
     }
    }
   }
   return actions;
  }finally{owner.checking=false;owner.round=null;}
 }
 function start(){if(timer)return;timer=setInterval(()=>{try{check();}catch(error){if(onError)onError(error);else throw error;}},intervalMs);}
 function stop(){if(timer){clearInterval(timer);timer=null;}}
 function getRetryCount(taskId){return retryCounts.get(taskId)||0;}
 function resetRetries(taskId){if(owner.checking)throw Error('WATCHDOG_CHECK_REENTRY');retryCounts.delete(taskId);}
 const api={check,start,stop,getRetryCount,resetRetries,getDiagnostics:()=>({checks:owner.checks,lastCheckAt:owner.lastCheckAt,running:timer!==null})};watchdogOwners.set(api,owner);return api;
}
