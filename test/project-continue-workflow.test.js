import test from 'node:test';
import assert from 'node:assert/strict';
import {createHub} from '../src/core/hub.js';

function fixture() {
  const agents=['worker-a','worker-b'].map(id=>({id,status:'idle',roles:['worker'],brokerOnline:true,runtimeHealth:{state:'healthy'}}));
  const hub=createHub({silent:true,getAgentProfiles:()=>agents});
  const p=hub.createProject({id:'proj-fictional-continue',name:'Fictional project',goal:'Fictional report',poAgent:'po',members:agents.map(a=>a.id)});
  hub.handleCreateTasks(p.id,[{id:'item-1',title:'Fictional analysis',assignedAgent:'worker-a',maxAttempts:1}], 'po');
  hub.handleApprove(p.id);
  const board=hub.getBoard(p.id),task=board.getAllTasks()[0];
  task.executionStrategyOverride='workflow';
  board.transition(task.id,'failed',{failureReason:'runtime_stalled',failureClass:'runtime_stalled'});
  return {hub,p,board,task};
}

test('continue returns actual workflow dispatch descriptors for a failed root task',()=>{
  const {hub,p,task}=fixture();
  const r=hub.handleContinueProject(p.id,{idempotencyKey:'root'});
  assert.equal(r.ok,true);
  assert.deepEqual(r.workflowDispatched,[task.id]);
  assert.equal(r.workflowNodeDispatches.length,1);
  assert.ok(r.workflowNodeDispatches[0].handoffId);
  assert.deepEqual(r.dispatched,[]);
});

test('continue retains descriptors for an existing pending retry child',()=>{
  const {hub,p,board,task}=fixture();
  const a=board.addTasksChecked([{id:'retry-1',title:task.title,parentTaskId:task.id,assignedAgent:'worker-b',attempt:2,maxAttempts:2}]);
  assert.equal(a.ok,true);
  const child=board.getTask(a.taskIds[0]);child.executionStrategyOverride='workflow';
  const r=hub.handleContinueProject(p.id,{idempotencyKey:'child'});
  assert.equal(r.ok,true);
  assert.deepEqual(r.workflowDispatched,[child.id]);
  assert.equal(r.workflowNodeDispatches.length,1);
});
