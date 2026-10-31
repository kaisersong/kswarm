import {failureRecoveryTaskIds} from '../core/failure-recovery-dispatch.js';

/** Keep adaptive workflow handoffs attached to the dispatch decision that made them. */
export async function deliverDispatchResult({projectId,dispatch,sendTasks,sendWorkflowNodes}) {
  if (dispatch?.ok !== true || dispatch.idempotent === true) return;
  const work=[];
  if (dispatch.dispatched?.length) work.push(Promise.resolve().then(()=>sendTasks(projectId,dispatch.dispatched)));
  if (dispatch.workflowNodeDispatches?.length) work.push(Promise.resolve().then(()=>sendWorkflowNodes(projectId,dispatch.workflowNodeDispatches)));
  const settled=await Promise.allSettled(work);
  const errors=settled.filter(result=>result.status==='rejected').map(result=>result.reason);
  if (errors.length) throw new AggregateError(errors,'task_dispatch_delivery_failed');
  return settled.map(result=>result.value);
}

export async function deliverFailureRecoveryResults({projectId,results,sendTasks,sendWorkflowNodes}) {
  const taskIds=new Set(),nodes=new Map();
  for (const result of results) {
    if (result?.ok !== true) continue;
    for (const taskId of failureRecoveryTaskIds(result)) taskIds.add(taskId);
    if (result.replacementDispatch?.ok !== true) continue;
    for (const node of result.replacementDispatch.workflowNodeDispatches || []) {
      const key=JSON.stringify([node.workflowRunId,node.nodeId,node.attempt,node.handoffId]);
      if (!nodes.has(key)) nodes.set(key,node);
    }
  }
  return deliverDispatchResult({projectId,dispatch:{ok:true,dispatched:[...taskIds],workflowNodeDispatches:[...nodes.values()]},sendTasks,sendWorkflowNodes});
}
