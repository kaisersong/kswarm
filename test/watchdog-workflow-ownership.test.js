import test from 'node:test';
import assert from 'node:assert/strict';
import {createHub} from '../src/core/hub.js';
import {createWatchdog} from '../src/core/watchdog.js';

test('legacy watchdog cannot reset a real Hub workflow source behind its execution owner',()=>{
  const hub=createHub({silent:true,getAgentProfiles:()=>[{id:'fictional-worker',status:'idle',brokerOnline:true,roles:['worker'],runtimeHealth:{state:'healthy',outputCapabilities:['markdown']}}]});
  const project=hub.createProject({id:'proj-fictional-watchdog',name:'Fictional report',goal:'Write a report',poAgent:'fictional-po',members:['fictional-worker']});
  assert.equal(hub.handleHumanAddTasks(project.id,[{title:'Produce a fictional artifact',assignedAgent:'fictional-worker',requiredOutputs:['markdown']}]).ok,true);
  assert.equal(hub.handleApprove(project.id).ok,true);
  const board=hub.getBoard(project.id),task=board.getAllTasks()[0];task.executionStrategyOverride='workflow';
  const dispatch=hub.handleRequestDispatch(project.id,'fictional-po');assert.deepEqual(dispatch.workflowDispatched,[task.id]);
  const active=board.getTask(task.id),runId=active.activeRunId;assert.ok(runId.startsWith('workflow-'));
  const watchdog=createWatchdog({listProjects:()=>hub.listProjects(),getBoard:id=>hub.getBoard(id),timeoutMs:600000,maxRetries:2});
  const now=Date.now();for(let attempt=1;attempt<=3;attempt++)assert.deepEqual(watchdog.check(now+attempt*1200000),[]);
  assert.equal(board.getTask(task.id).status,'dispatched');assert.equal(board.getTask(task.id).activeRunId,runId);
  assert.equal(watchdog.getRetryCount(task.id),0);
});
