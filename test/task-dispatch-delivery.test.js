import test from 'node:test';
import assert from 'node:assert/strict';
import {createHub} from '../src/core/hub.js';
import {deliverDispatchResult, deliverFailureRecoveryResults} from '../src/server/task-dispatch-delivery.js';

function fixture() {
  const hub = createHub({silent: true, getAgentProfiles: () => ['worker-a','worker-b'].map(id => ({
    id, status:'idle', brokerOnline:true, roles:['worker'], runtimeHealth:{state:'healthy',outputCapabilities:['markdown']},
  }))});
  const project = hub.createProject({id:'proj-fictional-recovery',name:'Fictional research',goal:'Write a fictional report',poAgent:'po',members:['worker-a','worker-b']});
  assert.equal(hub.handleHumanAddTasks(project.id,[{title:'Analyze fictional material',assignedAgent:'worker-a',requiredOutputs:['markdown']}]).ok,true);
  assert.equal(hub.handleApprove(project.id).ok,true);
  const board=hub.getBoard(project.id),task=board.getAllTasks()[0];
  task.executionStrategyOverride='direct';
  assert.equal(hub.handleRequestDispatch(project.id,'po').ok,true);
  const activeTask=board.getTask(task.id);
  activeTask.executionStrategyOverride='workflow';
  return {hub,project,board,task:activeTask};
}

test('real agent replacement delivers its workflow handoff even when direct replacementDispatched is false', async () => {
  const {hub,project,task}=fixture();
  const failed=hub.handleTaskFail(project.id,task.id,'desktop_runtime_error','fictional provider admission failure');
  assert.equal(failed.replaced,true);
  assert.equal(failed.replacementDispatched,false);
  const dispatch=failed.replacementDispatch.workflowNodeDispatches[0];
  assert.ok(dispatch?.handoffId);
  const calls=[];
  await deliverFailureRecoveryResults({projectId:project.id,results:[failed],
    sendTasks:async (...args)=>calls.push(['task',...args]),
    sendWorkflowNodes:async (...args)=>calls.push(['workflow',...args]),
  });
  assert.deepEqual(calls,[['workflow',project.id,[dispatch]]]);
  assert.equal(hub.getWorkflowRun(dispatch.workflowRunId).nodes[0].runtime.handoffId,dispatch.handoffId);
});

test('real project continue retains and delivers workflow results',async()=>{
  const {hub,project,board,task}=fixture();
  assert.equal(board.transition(task.id,'failed',{failureReason:'runtime_stalled',failureClass:'runtime_stalled'}).ok,true);
  const result=hub.handleContinueProject(project.id,{idempotencyKey:'fictional-continue',expectedPrimaryTaskId:task.id,expectedTaskUpdatedAt:task.updatedAt});
  assert.equal(result.ok,true);
  assert.deepEqual(result.dispatched,[]);
  assert.deepEqual(result.workflowDispatched,[task.id]);
  assert.equal(result.workflowNodeDispatches.length,1);
  const received=[];
  await deliverDispatchResult({projectId:project.id,dispatch:result,sendTasks:async()=>assert.fail('workflow must not use direct transport'),sendWorkflowNodes:async(_project,nodes)=>received.push(...nodes)});
  assert.equal(received[0].handoffId,result.workflowNodeDispatches[0].handoffId);
  const replay=hub.handleContinueProject(project.id,{idempotencyKey:'fictional-continue'});
  assert.equal(replay.idempotent,true);
  await deliverDispatchResult({projectId:project.id,dispatch:replay,sendTasks:async()=>assert.fail('no replay'),sendWorkflowNodes:async(_project,nodes)=>received.push(...nodes)});
  assert.equal(received.length,1);
});

test('mixed recovery batches deduplicate identities while retaining separate node attempts',async()=>{
  const n1={workflowRunId:'wf-fictional',nodeId:'worker',attempt:1,handoffId:'handoff-1'};
  const n2={...n1,attempt:2,handoffId:'handoff-2'};
  const calls=[];
  await deliverFailureRecoveryResults({projectId:'proj-fictional',results:[
    {ok:true,retryDispatched:true,retryTaskId:'retry-1'},
    {ok:true,retryDispatched:true,retryTaskId:'retry-1',replacementDispatch:{ok:true,workflowNodeDispatches:[n1,n1,n2]}},
    {ok:false,retryDispatched:true,retryTaskId:'must-not-run',replacementDispatch:{ok:true,workflowNodeDispatches:[{...n1,handoffId:'rejected'}]}},
  ],sendTasks:async(p,ids)=>calls.push(['tasks',ids]),sendWorkflowNodes:async(p,nodes)=>calls.push(['nodes',nodes])});
  assert.deepEqual(calls,[['tasks',['retry-1']],['nodes',[n1,n2]]]);
});

test('starts both transports and reports errors after the other settles',async()=>{
  const calls=[];
  await assert.rejects(deliverDispatchResult({projectId:'proj-fictional',dispatch:{ok:true,dispatched:['task'],workflowNodeDispatches:[{handoffId:'h'}]},
    sendTasks:async()=>{calls.push('tasks');throw Error('fixture_delivery_failure');},
    sendWorkflowNodes:async()=>{await Promise.resolve();calls.push('workflow');},
  }),error=>error instanceof AggregateError&&error.errors[0].message==='fixture_delivery_failure');
  assert.deepEqual(calls,['tasks','workflow']);
});

test('failed dispatch results do not send either transport',async()=>{
  await deliverDispatchResult({projectId:'proj-fictional',dispatch:{ok:false,dispatched:['task'],workflowNodeDispatches:[{}]},sendTasks:async()=>assert.fail(),sendWorkflowNodes:async()=>assert.fail()});
});

test('completed real task workflow hands its submitted artifact to the PO review queue',async()=>{
  const {deliverWorkflowTaskReview}=await import('../src/server/task-dispatch-delivery.js');
  const {mkdtempSync,writeFileSync,rmSync}=await import('node:fs'),{join}=await import('node:path'),{tmpdir}=await import('node:os');
  const root=mkdtempSync(join(tmpdir(),'fictional-workflow-review-'));
  try{const {hub,project,board,task}=fixture(),failed=hub.handleTaskFail(project.id,task.id,'desktop_runtime_error','fictional protocol failure');
    const worker=failed.replacementDispatch.workflowNodeDispatches[0],artifact=join(root,'fictional-analysis.md');writeFileSync(artifact,'# Fictional analysis\nEvidence and conclusions.\n');
    const produced=hub.handleWorkflowNodeResult({workflowRunId:worker.workflowRunId,nodeId:worker.nodeId,attempt:worker.attempt,handoffId:worker.handoffId,fromAgent:worker.targetParticipantId,output:{summary:'Fictional analysis complete',artifacts:[{path:artifact,kind:'markdown'}],workFolder:root,evidenceRefs:['artifact:'+artifact]}});
    const review=produced.dispatches[0],completed=hub.handleWorkflowNodeReview({workflowRunId:worker.workflowRunId,nodeId:review.nodeId,attempt:review.attempt,handoffId:review.handoffId,fromAgent:review.targetParticipantId,reviewDecision:{status:'passed',reason:'Fictional evidence verified',evidenceRefs:['artifact:'+artifact]},output:{summary:'Review complete'}});
    assert.equal(completed.workflowRun.status,'completed');assert.equal(board.getTask(task.id).status,'submitted');
    const calls=[],getTask=(p,t)=>hub.getBoard(p)?.getTask(t);
    await deliverWorkflowTaskReview({result:completed,getTask,sendReview:async input=>calls.push(input)});
    assert.equal(calls.length,1);assert.equal(calls[0].projectId,project.id);assert.equal(calls[0].taskId,task.id);
    assert.equal(calls[0].result.provenance.workflowRunId,worker.workflowRunId);assert.equal(calls[0].fromWorker,board.getTask(task.id).assignedAgent);
    assert.deepEqual(calls[0].result,board.getTask(task.id).result);assert.equal(calls[0].submittedAt,board.getTask(task.id).updatedAt);
    assert.equal(board.getTask(task.id).status,'submitted','notification must not approve task');
    const rejects=[{...completed,ok:false},{...completed,workflowRun:{...completed.workflowRun,status:'blocked'}},{...completed,workflowRun:{...completed.workflowRun,taskSubmission:{...completed.workflowRun.taskSubmission,status:'already_submitted'}}}];
    for(const result of rejects)await deliverWorkflowTaskReview({result,getTask,sendReview:async()=>assert.fail('rejected receipt notified')});
    await deliverWorkflowTaskReview({result:completed,getTask:()=>({...board.getTask(task.id),activeRunId:'other-run',result:{...board.getTask(task.id).result,provenance:{workflowRunId:'other-run'}}}),sendReview:async()=>assert.fail('wrong run notified')});
  }finally{rmSync(root,{recursive:true,force:true});}
});
