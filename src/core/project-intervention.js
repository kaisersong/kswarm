const ACTIVE_STATUSES = new Set(['dispatched', 'accepted', 'in_progress']);
const ATTENTION_STATUSES = new Set(['failed', 'blocked']);
const DONE_STATUSES = new Set(['done', 'cancelled']);
const MAX_AUTO_QUALITY_RETRIES = 2;

export function deriveProjectIntervention({
  project = {},
  tasks = [],
  agents = [],
  dispatchPlan = null,
  now = Date.now(),
} = {}) {
  const normalizedTasks = Array.isArray(tasks) ? tasks : [];
  const secondaryAction = makeAskXiaokAction({ project, primaryTask: null, downstreamBlockedCount: 0 });

  if (!project || project.status === 'closed' || project.status === 'delivered') {
    return noIntervention({ project, secondaryAction, reason: 'project_not_active' });
  }

  const taskMap = new Map(normalizedTasks.map(task => [task.id, task]));
  const candidate = selectPrimaryCandidate({
    project,
    tasks: normalizedTasks,
    taskMap,
    agents: listAgents(agents),
    dispatchPlan,
    now,
  });

  if (!candidate) {
    return noIntervention({ project, secondaryAction, reason: 'no_blocking_task' });
  }

  const primaryTask = candidate.task;
  const downstreamBlockedCount = countDownstreamBlocked(primaryTask, normalizedTasks);
  const primaryFailure = describeFailure(primaryTask);
  const resolvedSecondaryAction = makeAskXiaokAction({ project, primaryTask, downstreamBlockedCount, primaryFailure });

  return {
    required: true,
    severity: candidate.strategy === 'needs_conversation' ? 'warning' : 'action_required',
    projectId: project.id || null,
    primaryTaskId: primaryTask.id,
    primaryTaskTitle: primaryTask.title || primaryTask.id,
    lastEventAt: latestTimestamp(primaryTask),
    downstreamBlockedCount,
    primaryFailure,
    headline: '需要处理',
    message: buildMessage({ task: primaryTask, strategy: candidate.strategy, downstreamBlockedCount }),
    primaryAction: {
      id: 'continue_project',
      label: '继续推进',
      strategy: candidate.strategy,
      taskId: primaryTask.id,
      taskUpdatedAt: primaryTask.updatedAt || null,
    },
    secondaryAction: resolvedSecondaryAction,
  };
}

function noIntervention({ project, secondaryAction, reason }) {
  return {
    required: false,
    severity: 'normal',
    projectId: project?.id || null,
    reason,
    headline: null,
    message: '',
    primaryTaskId: null,
    primaryTaskTitle: null,
    lastEventAt: null,
    downstreamBlockedCount: 0,
    primaryFailure: null,
    primaryAction: null,
    secondaryAction,
  };
}

function selectPrimaryCandidate({ project, tasks, taskMap, agents, dispatchPlan, now }) {
  const retryParent = findCompletedRetryParentCandidate(tasks, taskMap);
  if (retryParent) {
    return { task: retryParent, strategy: 'complete_retry_parent', rank: 0 };
  }

  const candidates = [];
  for (const task of tasks) {
    if (isHistoricalRetryChild(task, taskMap)) continue;
    if (isRetryChildMaskingQualityDeadloop(task, taskMap)) continue;

    if (ACTIVE_STATUSES.has(task.status)) {
      if (hasUnexpiredLease(task, now)) continue;
      if (hasExpiredLease(task, now)) {
        candidates.push({ task, strategy: chooseRetryStrategy(task, agents, 'restart_then_retry'), rank: 20 });
      }
      continue;
    }

    if (isSubmittedAwaitingReview(task)) {
      candidates.push({ task, strategy: 'notify_po_review', rank: rankTask(task, 'notify_po_review') });
      continue;
    }

    if (!ATTENTION_STATUSES.has(task.status)) continue;

    const strategy = chooseAttentionStrategy(task, agents);
    candidates.push({ task, strategy, rank: rankTask(task, strategy) });
  }

  if (candidates.length === 0) return null;
  candidates.sort((left, right) => {
    if (left.rank !== right.rank) return left.rank - right.rank;
    return latestTimestamp(right.task) - latestTimestamp(left.task);
  });
  return candidates[0];
}

function findCompletedRetryParentCandidate(tasks, taskMap) {
  const candidates = tasks
    .filter(task => task.parentTaskId && task.status === 'done')
    .map(task => ({ child: task, parent: taskMap.get(task.parentTaskId) }))
    .filter(({ parent }) => parent && ATTENTION_STATUSES.has(parent.status) && !parent.isCompositeParent);
  if (candidates.length === 0) return null;
  candidates.sort((left, right) => latestTimestamp(right.child) - latestTimestamp(left.child));
  return candidates[0].parent;
}

function isHistoricalRetryChild(task, taskMap) {
  if (!task?.parentTaskId) return false;
  const parent = taskMap.get(task.parentTaskId);
  return Boolean(parent && !ATTENTION_STATUSES.has(parent.status));
}

function isRetryChildMaskingQualityDeadloop(task, taskMap) {
  if (!task?.parentTaskId) return false;
  const parent = taskMap.get(task.parentTaskId);
  if (!parent || !ATTENTION_STATUSES.has(parent.status)) return false;
  const parentHasQualityFeedback = hasCurrentQualityRejection(parent) || hasQualityFeedback(parent);
  return parentHasQualityFeedback && shouldEscalateQualityRepair(parent);
}

function chooseAttentionStrategy(task, agents) {
  const hasCurrentQuality = hasCurrentQualityRejection(task);
  const hasAnyQualityFeedback = hasCurrentQuality || hasQualityFeedback(task);
  if (hasAnyQualityFeedback && shouldEscalateQualityRepair(task)) return 'needs_conversation';
  if (hasCurrentQuality) return chooseRetryStrategy(task, agents, 'retry_with_repair_instruction');
  if (hasRecoverableArtifact(task)) return 'recover_submission';
  if (hasAnyQualityFeedback) return chooseRetryStrategy(task, agents, 'retry_with_repair_instruction');
  return chooseRetryStrategy(task, agents, 'retry_best_agent');
}

function chooseRetryStrategy(task, agents, preferredStrategy) {
  if (!hasHealthyAgentForTask(task, agents)) return 'needs_conversation';
  return preferredStrategy;
}

function rankTask(task, strategy) {
  if (strategy === 'recover_submission') return 10;
  if (strategy === 'notify_po_review') return 12;
  if (strategy === 'needs_conversation' && hasQualityFeedback(task) && shouldEscalateQualityRepair(task)) return 15;
  if (strategy === 'retry_with_repair_instruction') return 20;
  if (strategy === 'restart_then_retry') return 30;
  if (strategy === 'retry_best_agent') return 40;
  if (strategy === 'needs_conversation') return 90;
  return 100;
}

function isSubmittedAwaitingReview(task = {}) {
  return task.status === 'submitted' && Boolean(task.result) && !task.reviewResult;
}

function hasRecoverableArtifact(task) {
  return (
    artifactCount(task.lastRunLease) > 0 ||
    artifactCount(task.runLease) > 0 ||
    artifactCount(task.result) > 0 ||
    artifactCount(task) > 0
  );
}

function artifactCount(container = {}) {
  if (!container || typeof container !== 'object') return 0;
  const manifest = Array.isArray(container.artifactManifest) ? container.artifactManifest : [];
  const artifacts = Array.isArray(container.artifacts) ? container.artifacts : [];
  return manifest.length + artifacts.length;
}

function hasQualityFeedback(task = {}) {
  if (Number(task.qualityFailureCount || 0) > 0) return true;
  if (task.reviewResult?.passed === false) return true;
  if (String(task.lastFailureClass || '').startsWith('quality_')) return true;
  if (task.blockKind && String(task.blockKind).includes('quality')) return true;
  return latestFailedReview(task) !== null;
}

function hasCurrentQualityRejection(task = {}) {
  if (task.reviewResult?.passed === false) return true;
  if (String(task.lastFailureClass || '').startsWith('quality_')) return true;
  return Boolean(task.blockKind && String(task.blockKind).includes('quality'));
}

function shouldEscalateQualityRepair(task = {}) {
  if (Number(task.qualityFailureCount || 0) > MAX_AUTO_QUALITY_RETRIES) return true;
  return hasStartedRecovery(task, 'retry_with_repair_instruction');
}

function hasStartedRecovery(task = {}, strategy) {
  const history = Array.isArray(task.continueRecoveryHistory) ? task.continueRecoveryHistory : [];
  return history.some(entry => entry?.strategy === strategy && entry?.result === 'started');
}

function latestFailedReview(task = {}) {
  const reviews = Array.isArray(task.qualityReviewHistory) ? task.qualityReviewHistory : [];
  for (let index = reviews.length - 1; index >= 0; index -= 1) {
    if (reviews[index]?.passed === false) return reviews[index];
  }
  return null;
}

function hasUnexpiredLease(task = {}, now) {
  if (!ACTIVE_STATUSES.has(task.status)) return false;
  if (!task.activeRunId && !task.runLease) return false;
  const expiresAt = Number(task.runLease?.leaseExpiresAt || 0);
  return expiresAt > now;
}

function hasExpiredLease(task = {}, now) {
  if (!ACTIVE_STATUSES.has(task.status)) return false;
  if (!task.activeRunId && !task.runLease) return false;
  const expiresAt = Number(task.runLease?.leaseExpiresAt || 0);
  return expiresAt > 0 && expiresAt <= now;
}

function hasHealthyAgentForTask(task, agents) {
  if (agents.length === 0) return Boolean(task?.assignedAgent);
  return agents.some(agent => {
    if (!agent || agent.archived) return false;
    if (['offline', 'error', 'failed', 'stopped', 'archived'].includes(String(agent.status || '').toLowerCase())) return false;
    const state = String(agent.runtimeHealth?.state || 'healthy').toLowerCase();
    if (['unhealthy', 'error', 'failed', 'offline', 'cooldown'].includes(state)) return false;
    return true;
  });
}

function countDownstreamBlocked(rootTask, tasks) {
  if (!rootTask) return 0;
  const titleToId = new Map(tasks.map(task => [task.title, task.id]).filter(([title]) => title));
  const reverseDeps = new Map();
  for (const task of tasks) {
    for (const depRef of task.dependencies || []) {
      const depId = titleToId.get(depRef) || depRef;
      const dependents = reverseDeps.get(depId) || [];
      dependents.push(task);
      reverseDeps.set(depId, dependents);
    }
  }

  const seen = new Set();
  const queue = [...(reverseDeps.get(rootTask.id) || [])];
  while (queue.length > 0) {
    const task = queue.shift();
    if (!task || seen.has(task.id)) continue;
    seen.add(task.id);
    for (const next of reverseDeps.get(task.id) || []) queue.push(next);
  }

  return [...seen]
    .map(taskId => tasks.find(task => task.id === taskId))
    .filter(task => task && !DONE_STATUSES.has(task.status))
    .length;
}

function describeFailure(task = {}) {
  const failedReview = latestFailedReview(task);
  return {
    reason: task.failureReason || task.blockedReason || task.lastFailureClass || null,
    feedback: failedReview?.feedback || task.reviewResult?.feedback || task.blockedReason || task.failureReason || '',
    assignedAgent: task.assignedAgent || null,
    status: task.status || null,
    qualityFailureCount: Number(task.qualityFailureCount || 0),
  };
}

function buildMessage({ task, strategy, downstreamBlockedCount }) {
  const suffix = downstreamBlockedCount > 0
    ? `后续 ${downstreamBlockedCount} 个任务正在等待它。`
    : '后续任务暂未受阻。';
  if (strategy === 'needs_conversation') {
    return `${task.title || task.id} 无法安全自动推进，需要让小K帮忙确认下一步。${suffix}`;
  }
  if (strategy === 'recover_submission') {
    return `${task.title || task.id} 已有可恢复产物，可以继续推进。${suffix}`;
  }
  if (strategy === 'notify_po_review') {
    return `${task.title || task.id} 已提交，等待 PO 复审；可以重新通知 PO。${suffix}`;
  }
  if (strategy === 'complete_retry_parent') {
    return `${task.title || task.id} 的重试结果已完成，可以补齐父任务状态。${suffix}`;
  }
  if (strategy === 'retry_with_repair_instruction') {
    return `${task.title || task.id} 需要带着质量反馈重新执行。${suffix}`;
  }
  if (strategy === 'restart_then_retry') {
    return `${task.title || task.id} 的执行租约已过期，可以重启后继续。${suffix}`;
  }
  return `${task.title || task.id} 执行失败，可以重新派发继续推进。${suffix}`;
}

function makeAskXiaokAction({ project, primaryTask, downstreamBlockedCount, primaryFailure = null }) {
  return {
    id: 'ask_xiaok',
    label: '让小K帮忙',
    context: {
      projectId: project?.id || null,
      projectName: project?.name || '',
      taskId: primaryTask?.id || null,
      taskTitle: primaryTask?.title || '',
      downstreamBlockedCount,
      lastFailure: primaryFailure?.feedback || primaryFailure?.reason || '',
    },
  };
}

function latestTimestamp(task = {}) {
  return Number(task.updatedAt || task.failedAt || task.blockedAt || task.completedAt || task.createdAt || 0);
}

function listAgents(agents) {
  if (agents instanceof Map) return [...agents.values()];
  if (Array.isArray(agents)) return agents;
  if (agents && typeof agents === 'object') return Object.values(agents);
  return [];
}
