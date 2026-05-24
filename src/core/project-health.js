const ACTIVE_STATUSES = new Set(['dispatched', 'accepted', 'in_progress']);
const OUTPUT_CONTRACT_FAILURES = new Set(['artifact_type_mismatch', 'artifact_missing', 'artifact_invalid', 'inline_artifact_forbidden', 'artifact_hash_mismatch', 'artifact_path_escape']);

export function deriveProjectHealth({ project = {}, tasks = [], dispatchPlan = null } = {}) {
  const counts = countStatuses(tasks);
  const taskMap = new Map(tasks.map(task => [task.id, task]));
  const blockedTasks = tasks.filter(task => task.status === 'blocked');

  if (project?.preparation?.state === 'checking') {
    return { state: 'preparing', gate: 'project_preparation', counts, reasons: [] };
  }

  if (project?.preparation?.state === 'blocked') {
    return {
      state: 'preparation_blocked',
      gate: 'project_preparation',
      counts,
      reasons: (project.preparation.blockers || []).map(blocker => ({
        agentId: blocker.agentId || null,
        message: blocker.reason || 'agent_not_ready',
        selectedBy: blocker.selectedBy || null,
        readiness: blocker.readiness || null,
      })),
    };
  }

  const outputContractTasks = tasks.filter(hasOutputContractFailure);
  if (outputContractTasks.length > 0) {
    return {
      state: 'repair_output_contract',
      gate: 'output_contract',
      counts,
      reasons: outputContractTasks.map(task => ({
        taskId: task.id,
        message: task.failureReason || task.lastFailureClass || 'output_contract_failed',
        missing: latestMissingOutputs(task),
      })),
    };
  }

  if (blockedTasks.length > 0) {
    const replacementBlocks = blockedTasks.filter(task => task.blockKind === 'agent_replacement_confirmation_required');
    if (replacementBlocks.length > 0) {
      return {
        state: 'waiting_for_agent_replacement',
        gate: 'agent_replacement',
        counts,
        reasons: replacementBlocks.map(task => ({
          taskId: task.id,
          message: task.blockedReason || 'agent replacement confirmation required',
          nextActions: task.nextActions || [],
        })),
      };
    }
    return {
      state: 'blocked',
      gate: 'blocked_tasks',
      counts,
      reasons: blockedTasks.map(task => ({
        taskId: task.id,
        message: task.blockedReason || task.failureReason || '任务已阻塞',
        nextActions: task.nextActions || [],
      })),
    };
  }

  if (counts.submitted > 0) {
    return { state: 'needs_review', gate: 'submitted_tasks', counts, reasons: [] };
  }
  if (tasks.some(task => ACTIVE_STATUSES.has(task.status))) {
    return { state: 'running', gate: null, counts, reasons: [] };
  }
  if (dispatchPlan?.projectGate) {
    return {
      state: 'waiting',
      gate: dispatchPlan.projectGate,
      counts,
      reasons: [
        ...(dispatchPlan.skipped || []).map(item => ({ taskId: item.taskId, message: item.reason, agent: item.agent })),
        ...(dispatchPlan.blocked || []).map(item => ({ taskId: item.taskId, message: item.reason, dependencies: item.dependencies })),
      ],
    };
  }
  if (dispatchPlan?.dispatchedTasks?.length > 0) {
    return { state: 'dispatchable', gate: null, counts, reasons: [] };
  }
  if (tasks.length > 0 && tasks.every(task => isDoneForProjectCompletion(task, taskMap))) {
    return { state: project.status === 'closed' ? 'closed' : 'complete', gate: null, counts, reasons: [] };
  }
  return { state: 'idle', gate: null, counts, reasons: [] };
}

function hasOutputContractFailure(task = {}) {
  if (!['failed', 'blocked'].includes(task.status)) return false;
  if (OUTPUT_CONTRACT_FAILURES.has(String(task.lastFailureClass || ''))) return true;
  if (OUTPUT_CONTRACT_FAILURES.has(String(task.failureReason || ''))) return true;
  return (Array.isArray(task.rejectedSubmissions) ? task.rejectedSubmissions : [])
    .some(submission => OUTPUT_CONTRACT_FAILURES.has(String(submission?.failureClass || '')));
}

function latestMissingOutputs(task = {}) {
  const rejected = Array.isArray(task.rejectedSubmissions) ? task.rejectedSubmissions : [];
  for (let index = rejected.length - 1; index >= 0; index -= 1) {
    const missing = rejected[index]?.missing;
    if (Array.isArray(missing) && missing.length > 0) return missing.map(String);
  }
  return Array.isArray(task.missingOutputs) ? task.missingOutputs.map(String) : [];
}

function isDoneForProjectCompletion(task = {}, taskMap) {
  if (['done', 'cancelled'].includes(task.status)) return true;
  if (!task.parentTaskId) return false;
  const parent = taskMap.get(task.parentTaskId);
  return Boolean(parent && ['done', 'cancelled'].includes(parent.status));
}

function countStatuses(tasks) {
  return {
    total: tasks.length,
    pending: tasks.filter(task => task.status === 'pending').length,
    dispatched: tasks.filter(task => task.status === 'dispatched').length,
    accepted: tasks.filter(task => task.status === 'accepted').length,
    inProgress: tasks.filter(task => task.status === 'in_progress').length,
    submitted: tasks.filter(task => task.status === 'submitted').length,
    done: tasks.filter(task => task.status === 'done').length,
    failed: tasks.filter(task => task.status === 'failed').length,
    blocked: tasks.filter(task => task.status === 'blocked').length,
    cancelled: tasks.filter(task => task.status === 'cancelled').length,
  };
}
