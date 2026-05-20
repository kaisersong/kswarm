import { deriveProjectIntervention } from './project-intervention.js';

const ACTIVE_STATUSES = new Set(['dispatched', 'accepted', 'in_progress']);
const MUTATING_RETRY_STRATEGIES = new Set(['retry_best_agent', 'retry_with_repair_instruction', 'restart_then_retry']);
const MAX_SAME_STRATEGY_RECOVERIES = 1;

export function handleContinueProjectCore({
  project,
  board,
  agents = [],
  request = {},
  dispatchProjectTasks,
  recoverSubmission,
  emitEvent,
  now = Date.now(),
} = {}) {
  if (!project || !board) return withOutcome({ ok: false, error: 'project_not_found' }, 'not_advanced');

  const idempotencyKey = String(request.idempotencyKey || '').trim();
  if (!idempotencyKey) return withOutcome({ ok: false, error: 'idempotency_key_required', status: 400 }, 'not_advanced');

  project.continueIdempotency = project.continueIdempotency && typeof project.continueIdempotency === 'object'
    ? project.continueIdempotency
    : {};
  if (project.continueIdempotency[idempotencyKey]) {
    return { ...project.continueIdempotency[idempotencyKey], idempotent: true };
  }

  const intervention = deriveProjectIntervention({
    project,
    tasks: board.getAllTasks(),
    agents,
    now,
  });

  if (!intervention?.required) {
    return remember(project, idempotencyKey, {
      ok: false,
      action: 'continue_project',
      error: 'no_intervention_required',
      strategy: null,
      intervention,
      xiaokContext: buildXiaokContext({ project, intervention }),
      ...outcomeFields('not_advanced'),
    });
  }

  const task = board.getTask(intervention.primaryTaskId);
  if (!task) {
    return withOutcome({ ok: false, error: 'task_not_found', status: 404 }, 'not_advanced');
  }

  const stale = validateExpectedState(task, request, intervention);
  if (!stale.ok) return withOutcome(stale, 'not_advanced');

  const strategy = intervention.primaryAction?.strategy || 'needs_conversation';
  if (strategy === 'needs_conversation') {
    return remember(project, idempotencyKey, {
      ok: false,
      action: 'continue_project',
      error: 'needs_conversation',
      strategy,
      intervention,
      xiaokContext: buildXiaokContext({ project, intervention, task }),
      ...outcomeFields('needs_user_action', { humanActionRequired: true }),
      nextActions: buildNextActions({ project, task }),
    });
  }

  if (strategy !== 'notify_po_review' && isRecoveryBudgetExceeded(task, strategy)) {
    return remember(project, idempotencyKey, {
      ok: false,
      action: 'continue_project',
      error: 'recovery_budget_exceeded',
      strategy: 'needs_conversation',
      blockedStrategy: strategy,
      intervention,
      xiaokContext: buildXiaokContext({
        project,
        intervention,
        task,
        reason: `同一恢复策略 ${strategy} 已失败过，需要让小K帮忙确认下一步。`,
      }),
      ...outcomeFields('needs_user_action', { humanActionRequired: true }),
      nextActions: buildNextActions({ project, task }),
    });
  }

  let result;
  if (strategy === 'recover_submission') {
    result = recoverTaskSubmission({ project, task, intervention, recoverSubmission });
  } else if (strategy === 'notify_po_review') {
    result = notifyPoReview({ project, task, intervention });
  } else if (strategy === 'complete_retry_parent') {
    result = completeRetryParent({ board, task });
  } else if (MUTATING_RETRY_STRATEGIES.has(strategy)) {
    result = retryTask({ board, task, strategy, agents, dispatchProjectTasks, intervention });
  } else {
    result = {
      ok: false,
      action: 'continue_project',
      error: 'unsupported_continue_strategy',
      strategy,
      intervention,
      xiaokContext: buildXiaokContext({ project, intervention, task }),
    };
  }

  if (result.ok) {
    if (strategy !== 'notify_po_review') recordRecoveryAttempt(task, strategy, now);
    emitEvent?.('project.continue', {
      projectId: project.id,
      taskId: task.id,
      strategy,
      dispatched: result.dispatched || [],
    });
  }

  return remember(project, idempotencyKey, {
    action: 'continue_project',
    strategy,
    intervention,
    ...result,
    ...outcomeFields(result.ok
      ? (result.recovered || result.reviewNotificationNeeded ? 'submitted_for_review' : 'advanced')
      : (result.strategy === 'needs_conversation' ? 'needs_user_action' : 'not_advanced'), {
        projectChanged: Boolean(result.ok && !result.reviewNotificationNeeded),
        humanActionRequired: !result.ok && result.strategy === 'needs_conversation',
      }),
    ...(!result.ok && result.strategy === 'needs_conversation'
      ? { nextActions: buildNextActions({ project, task }) }
      : {}),
  });
}

function outcomeFields(outcome, { projectChanged = false, humanActionRequired = false } = {}) {
  return {
    outcome,
    projectChanged,
    humanActionRequired,
  };
}

function withOutcome(result, outcome, options = {}) {
  return {
    ...result,
    ...outcomeFields(outcome, options),
  };
}

function buildNextActions({ project = {}, task = null } = {}) {
  if (!project?.id || !task?.id) return [];
  return [{
    id: 'repair_and_submit',
    label: '修复并提交',
    description: '补充或修正任务产物后，直接提交给项目审核流程。',
    toolName: 'repair_project_task_from_file',
    params: {
      projectId: project.id,
      expectedPrimaryTaskId: task.id,
      expectedTaskUpdatedAt: task.updatedAt || null,
    },
  }];
}

function validateExpectedState(task, request, intervention) {
  if (request.expectedPrimaryTaskId && request.expectedPrimaryTaskId !== task.id) {
    return {
      ok: false,
      error: 'task_state_changed',
      status: 409,
      currentPrimaryTaskId: task.id,
      intervention,
    };
  }
  if (
    request.expectedTaskUpdatedAt !== undefined &&
    Number(request.expectedTaskUpdatedAt) !== Number(task.updatedAt || 0)
  ) {
    return {
      ok: false,
      error: 'task_state_changed',
      status: 409,
      currentTaskUpdatedAt: task.updatedAt || null,
      intervention,
    };
  }
  return { ok: true };
}

function recoverTaskSubmission({ project, task, intervention, recoverSubmission }) {
  const lease = task.lastRunLease || task.runLease || {};
  const { artifactManifest, artifacts } = collectRecoverableArtifacts(task, lease);
  if (artifactManifest.length === 0 && artifacts.length === 0) {
    return {
      ok: false,
      error: 'no_recoverable_artifacts',
      strategy: 'needs_conversation',
      xiaokContext: buildXiaokContext({ project, intervention, task }),
    };
  }

  const payload = {
    summary: task.result?.summary || 'Recovered artifacts from interrupted run',
    artifactManifest,
    artifacts,
    runId: lease.runId || task.result?.runId || task.recoveredRunId || null,
  };
  const recovered = recoverSubmission
    ? recoverSubmission(task.id, payload, lease.assignedAgent || task.assignedAgent || 'system', {
        runId: payload.runId,
        recoveryReason: 'continue_project_recover_submission',
      })
    : { ok: false, error: 'recover_submission_unavailable' };
  if (!recovered.ok) return recovered;
  return { ok: true, recovered: true, dispatched: [], taskId: task.id, result: payload };
}

function notifyPoReview({ project, task, intervention }) {
  if (task.status !== 'submitted' || !task.result || task.reviewResult) {
    return {
      ok: false,
      error: 'review_notification_not_applicable',
      strategy: 'needs_conversation',
      xiaokContext: buildXiaokContext({ project, intervention, task }),
    };
  }

  return {
    ok: true,
    reviewNotificationNeeded: true,
    dispatched: [],
    taskId: task.id,
    result: task.result,
    fromWorker: task.result?.participantId || task.result?.agent || task.assignedAgent || 'continue_project',
  };
}

function collectRecoverableArtifacts(task = {}, lease = {}) {
  const sources = [
    lease,
    task.lastRunLease,
    task.runLease,
    task.result,
    task,
  ];
  const artifactManifest = [];
  const artifacts = [];
  const seenManifest = new Set();
  const seenArtifacts = new Set();

  for (const source of sources) {
    for (const item of Array.isArray(source?.artifactManifest) ? source.artifactManifest : []) {
      const key = artifactKey(item);
      if (seenManifest.has(key)) continue;
      seenManifest.add(key);
      artifactManifest.push(item);
    }
    for (const item of Array.isArray(source?.artifacts) ? source.artifacts : []) {
      const key = artifactKey(item);
      if (seenArtifacts.has(key)) continue;
      seenArtifacts.add(key);
      artifacts.push(item);
    }
  }

  return { artifactManifest, artifacts };
}

function artifactKey(item) {
  if (!item || typeof item !== 'object') return String(item);
  return String(item.path || item.url || item.filename || JSON.stringify(item));
}

function completeRetryParent({ board, task }) {
  const retryChild = board.getAllTasks()
    .filter(candidate => candidate.parentTaskId === task.id && candidate.status === 'done')
    .sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0))[0];
  if (!retryChild?.result) {
    return { ok: false, error: 'retry_child_result_missing' };
  }
  const completed = board.completeRetryParent(task.id, retryChild.result, {
    completedBy: 'continue_project',
    completedByTaskId: retryChild.id,
    recoveredBy: retryChild.completedBy || 'retry_child',
    recoveryReason: 'continue_project_complete_retry_parent',
  });
  if (!completed.ok) return completed;
  return { ok: true, completed: true, dispatched: [], taskId: task.id };
}

function retryTask({ board, task, strategy, agents, dispatchProjectTasks, intervention }) {
  const agentId = selectHealthyAgent(task, agents);
  if (!agentId) {
    return {
      ok: false,
      error: 'needs_conversation',
      strategy: 'needs_conversation',
      xiaokContext: buildXiaokContext({ intervention, task }),
    };
  }

  if (strategy === 'retry_with_repair_instruction') {
    task.repairInstruction = buildRepairInstruction(task);
  }

  let reset;
  if (ACTIVE_STATUSES.has(task.status)) {
    reset = board.resetStaleRun(task.id, 'continue_project_restart_then_retry');
  } else {
    reset = board.transition(task.id, 'pending', {
      failureReason: task.failureReason,
      failureClass: task.lastFailureClass,
      qualityFailureCount: task.qualityFailureCount,
    });
  }
  if (!reset.ok) return reset;

  const pendingTask = board.getTask(task.id);
  pendingTask.assignedAgent = agentId;
  pendingTask.recoveryStatus = 'redispatch_ready';
  pendingTask.recoveryReason = `continue_project:${strategy}`;
  if (strategy === 'retry_with_repair_instruction') {
    pendingTask.repairInstruction = buildRepairInstruction(task);
  }

  const dispatch = dispatchProjectTasks ? dispatchProjectTasks() : { ok: false, dispatched: [], error: 'dispatch_unavailable' };
  if (!dispatch.ok) return dispatch;
  return {
    ok: true,
    retried: true,
    dispatched: dispatch.dispatched || [],
    skipped: dispatch.skipped || [],
    blocked: dispatch.blocked || [],
    projectGate: dispatch.projectGate || null,
    taskId: task.id,
    assignedAgent: agentId,
  };
}

function selectHealthyAgent(task, agents) {
  const list = listAgents(agents);
  const healthy = list.filter(isHealthyAgent);
  const previous = task.assignedAgent;
  if (healthy.length === 0) {
    const previousAgent = list.find(agent => agent.id === previous);
    if (isRecoverableContentFailureAgent(previousAgent, task)) return previousAgent.id;
    return list.length === 0 ? (task.assignedAgent || null) : null;
  }
  return (healthy.find(agent => agent.id !== previous) || healthy[0]).id || null;
}

function isHealthyAgent(agent = {}) {
  if (!isAvailableAgent(agent)) return false;
  const state = String(agent.runtimeHealth?.state || 'healthy').toLowerCase();
  return !['unhealthy', 'error', 'failed', 'offline', 'cooldown', 'degraded', 'stalled'].includes(state);
}

function isRecoverableContentFailureAgent(agent = {}, task = {}) {
  if (!isAvailableAgent(agent)) return false;
  const health = agent.runtimeHealth || {};
  const state = String(health.state || '').toLowerCase();
  if (state !== 'degraded') return false;
  if (health.cooldownUntil && Number(health.cooldownUntil) > Date.now()) return false;
  if (String(health.lastFailureClass || '') === 'runtime_stalled') return false;

  const failureText = [
    task.lastFailureClass,
    task.failureReason,
    task.blockedReason,
    task.reviewResult?.feedback,
    health.lastFailureClass,
    health.lastError,
  ].filter(Boolean).join('\n');

  return /model_empty_output|content_too_short|empty output|both failed to generate output/i.test(failureText);
}

function isAvailableAgent(agent = {}) {
  if (!agent || agent.archived) return false;
  return !['offline', 'error', 'failed', 'stopped', 'archived'].includes(String(agent.status || '').toLowerCase());
}

function buildRepairInstruction(task = {}) {
  const latestReview = [...(task.qualityReviewHistory || [])].reverse().find(review => review?.passed === false);
  return [
    latestReview?.feedback,
    task.reviewResult?.feedback,
    task.blockedReason,
    task.failureReason,
  ].filter(Boolean).join('\n');
}

function isRecoveryBudgetExceeded(task, strategy) {
  const history = Array.isArray(task.continueRecoveryHistory) ? task.continueRecoveryHistory : [];
  return history.filter(item => item.strategy === strategy && item.result === 'started').length >= MAX_SAME_STRATEGY_RECOVERIES;
}

function recordRecoveryAttempt(task, strategy, now) {
  task.continueRecoveryHistory = Array.isArray(task.continueRecoveryHistory) ? task.continueRecoveryHistory : [];
  task.continueRecoveryHistory.push({
    strategy,
    result: 'started',
    at: now,
  });
}

function remember(project, idempotencyKey, result) {
  project.continueIdempotency[idempotencyKey] = result;
  return result;
}

export function buildXiaokContext({ project = {}, intervention = {}, task = null, reason = '' } = {}) {
  const downstreamBlockedCount = Number(intervention.downstreamBlockedCount || 0);
  const taskTitle = task?.title || intervention.primaryTaskTitle || '';
  const failure = intervention.primaryFailure || {};
  const lastFailure = reason || failure.feedback || failure.reason || task?.failureReason || task?.blockedReason || '任务失败';
  return {
    projectId: project.id || intervention.projectId || null,
    projectName: project.name || '',
    taskId: task?.id || intervention.primaryTaskId || null,
    taskTitle,
    summary: downstreamBlockedCount > 0
      ? `${taskTitle || '当前任务'} 卡住，后续 ${downstreamBlockedCount} 个任务正在等待。`
      : `${taskTitle || '当前任务'} 需要确认下一步。`,
    lastFailure,
    suggestedInstruction: '请诊断失败原因；如需要提交修复产物，请先把完整产物写入 artifacts 文件，再调用 repair_project_task_from_file 将文件路径提交回项目审核。',
  };
}

function listAgents(agents) {
  if (agents instanceof Map) return [...agents.values()];
  if (Array.isArray(agents)) return agents;
  if (agents && typeof agents === 'object') return Object.values(agents);
  return [];
}
