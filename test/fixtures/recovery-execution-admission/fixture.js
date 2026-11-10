import assert from'node:assert/strict';
import{mkdtempSync,rmSync}from'node:fs';
import{join}from'node:path';
import{tmpdir}from'node:os';
import{DatabaseSync}from'node:sqlite';
import{createHub}from'../../../src/core/hub.js';
import{createSqlitePersistence}from'../../../src/core/sqlite-persistence.js';
export function fixture(t,options={}){
 const root=mkdtempSync(join(tmpdir(),'recovery-admission-')),filePath=join(root,'state.sqlite'),persistence=createSqlitePersistence({filePath,...options}),hub=createHub({silent:true,dataDir:{backend:'sqlite',filePath},persistence});const hubs=[hub];t.after(()=>{for(const owner of hubs)owner.closePersistence();rmSync(root,{recursive:true,force:true,maxRetries:5});});
 const addLegacy=projectId=>{
 hub.createProject({id:projectId,name:'Original manual project',goal:'G',poAgent:'po',members:['worker'],requestedStartPolicy:'plan_only',autoAssignPo:false});assert.equal(hub.handleHumanAddTasks(projectId,[{title:'Work',assignedAgent:'worker',acceptanceCriteria:'Facts',requiredOutputs:['markdown']}],{requestSource:'user'}).ok,true);assert.equal(hub.handleApprove(projectId).ok,true);const board=hub.getBoard(projectId),task=board.getAllTasks()[0];assert.equal(board.transition(task.id,'dispatched',{assignedAgent:'worker',runId:'original-run'}).ok,true);assert.equal(board.transition(task.id,'accepted',{assignedAgent:'worker'}).ok,true);assert.equal(board.transition(task.id,'in_progress').ok,true);task.suspendedAt=1000;task.runLease.lastHeartbeatAt=1000;task.runLease.leaseExpiresAt=2000;hub.persistState();
 return{board,task};};const{board,task}=addLegacy('p');
 const action={type:'resume_task',projectId:'p',taskId:task.id,runId:task.activeRunId},physical=()=>{const db=new DatabaseSync(filePath,{readOnly:true});try{return{rows:db.prepare('SELECT * FROM state_entities ORDER BY collection,entity_key').all(),history:db.prepare('SELECT * FROM state_entity_history ORDER BY rowid').all()};}finally{db.close();}};
 return{hub,persistence,board,task,action,physical,addLegacy,filePath,reopen(){hub.closePersistence();const backend=createSqlitePersistence({filePath}),fresh=createHub({silent:true,dataDir:{backend:'sqlite',filePath},persistence:backend});hubs.push(fresh);return{hub:fresh,persistence:backend};}};
}
