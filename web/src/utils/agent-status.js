const ACTIVE_TASK_STATUSES = new Set(['dispatched', 'accepted', 'in_progress']);

const STATUS_LABELS = {
  working: '执行中',
  reviewing: '验收中',
  waiting_review: '待验收',
  waiting: '等待',
  blocked: '阻塞',
  failed: '失败',
  error: '错误',
  cancelled: '已取消',
  done: '完成',
  offline: '离线',
};

export function deriveAgentStatuses({
  project,
  tasks = [],
  agents = [],
  participants = [],
  logs = [],
} = {}) {
  if (!project) return [];

  const onlineIds = new Set(
    participants
      .filter(p => p.kind === 'agent')
      .map(p => p.participantId)
      .filter(Boolean)
  );
  const agentById = new Map(agents.map(a => [a.id, a]));
  const participantById = new Map(participants.map(p => [p.participantId, p]));
  const projectAgentIds = collectProjectAgentIds(project, tasks);
  const poId = project.poAgent;
  const taskIndex = buildTaskIndex(tasks);
  const submittedTasks = tasks.filter(t => t.status === 'submitted');

  return projectAgentIds.map(agentId => {
    const agent = agentById.get(agentId) || {};
    const participant = participantById.get(agentId) || {};
    const assignedTasks = tasks.filter(t => t.assignedAgent === agentId);
    const online = onlineIds.has(agentId) || (agent.status && agent.status !== 'offline');
    const role = agentId === poId ? 'PO' : '成员';
    const base = {
      id: agentId,
      name: agent.name || participant.alias || agentId,
      role,
      online,
      counts: countTasks(assignedTasks),
    };

    const routeError = latestTaskIntentError({ logs, projectId: project.id, agentId });
    if (routeError) {
      return withStatus(base, 'error', {
        detail: routeError.error || '任务上报失败',
        taskId: routeError.taskId || null,
      });
    }

    const hardBlockedTask = assignedTasks.find(t => t.status === 'blocked');
    if (hardBlockedTask) {
      return withTaskStatus(base, 'blocked', hardBlockedTask, hardBlockedTask.blockedReason || '任务已阻塞');
    }

    const failedTask = assignedTasks.find(t => t.status === 'failed');
    if (failedTask) {
      return withTaskStatus(base, 'failed', failedTask, failedTask.failureReason || '任务失败');
    }

    const activeTask = assignedTasks.find(t => ACTIVE_TASK_STATUSES.has(t.status));
    if (activeTask) {
      const detail = activeTask.status === 'dispatched'
        ? '已派发，等待接收'
        : activeTask.status === 'accepted'
        ? '已接收'
        : '正在执行';
      return withTaskStatus(base, 'working', activeTask, detail);
    }

    if (agentId === poId) {
      const poStatus = derivePoStatus(project, tasks, submittedTasks, online);
      return withStatus(base, poStatus.status, poStatus);
    }

    const submittedTask = assignedTasks.find(t => t.status === 'submitted');
    if (submittedTask) {
      return withTaskStatus(base, 'waiting_review', submittedTask, '等待 PO 验收');
    }

    const blockedTask = assignedTasks.find(t => t.status === 'pending' && isTaskBlocked(t, taskIndex));
    if (blockedTask) {
      return withTaskStatus(base, 'blocked', blockedTask, '等待依赖完成');
    }

    const cancelledTask = assignedTasks.find(t => t.status === 'cancelled');
    if (cancelledTask) {
      return withTaskStatus(base, 'cancelled', cancelledTask, '任务已取消');
    }

    const readyTask = assignedTasks.find(t => t.status === 'pending');
    if (readyTask && online) {
      return withTaskStatus(base, 'waiting', readyTask, '等待派发');
    }

    if (assignedTasks.length > 0 && assignedTasks.every(t => t.status === 'done')) {
      return withStatus(base, 'done', { detail: '已完成分配任务' });
    }

    if (!online) {
      return withStatus(base, 'offline', { detail: '未连接' });
    }

    return withStatus(base, 'waiting', { detail: '等待任务' });
  });
}

function collectProjectAgentIds(project, tasks) {
  const ids = [];
  const push = (id) => {
    if (id && !ids.includes(id)) ids.push(id);
  };
  push(project.poAgent);
  for (const member of project.members || []) push(member);
  for (const task of tasks || []) push(task.assignedAgent);
  return ids;
}

function buildTaskIndex(tasks) {
  const index = new Map();
  const titleCounts = new Map();
  for (const task of tasks) {
    if (task.title) titleCounts.set(task.title, (titleCounts.get(task.title) || 0) + 1);
  }
  for (const task of tasks) {
    if (task.id) index.set(task.id, task);
    if (task.localTaskId) index.set(task.localTaskId, task);
    if (task.planItemId) index.set(task.planItemId, task);
    if (task.title && titleCounts.get(task.title) === 1) index.set(task.title, task);
  }
  return index;
}

function isTaskBlocked(task, taskIndex) {
  if (task.unresolvedDependencies?.length > 0) return true;
  return (task.dependencies || []).some(depRef => {
    const dep = taskIndex.get(depRef);
    return !dep || dep.status !== 'done';
  });
}

function derivePoStatus(project, tasks, submittedTasks, online) {
  if (submittedTasks.length > 0) {
    return { status: 'reviewing', detail: `${submittedTasks.length} 个任务待验收` };
  }
  if (project.status === 'closed' || project.status === 'delivered') {
    return { status: 'done', detail: '项目已交付' };
  }
  if (!online) {
    return { status: 'offline', detail: '未连接' };
  }
  if (project.status === 'created' || project.status === 'planning') {
    return { status: 'working', detail: '制定计划中' };
  }
  if (tasks.length > 0 && tasks.every(t => t.status === 'done')) {
    return { status: 'done', detail: '任务已全部完成' };
  }
  const pendingCount = tasks.filter(t => t.status === 'pending').length;
  if (pendingCount > 0) {
    return { status: 'waiting', detail: `${pendingCount} 个任务待派发` };
  }
  return { status: 'waiting', detail: '等待项目事件' };
}

function latestTaskIntentError({ logs, projectId, agentId }) {
  for (let i = logs.length - 1; i >= 0; i--) {
    const entry = logs[i];
    const data = entry.data || entry;
    const isTaskIntentError =
      entry.type === 'task_intent_error' ||
      entry.msg?.startsWith?.('Task intent error:') ||
      data.type === 'task_intent_error';
    if (!isTaskIntentError) continue;
    if (data.projectId && data.projectId !== projectId) continue;
    const workerId = data.worker || entry.worker || data.agent || entry.agent || data.fromParticipantId || entry.fromParticipantId;
    if (!workerId || workerId !== agentId) continue;
    return {
      error: data.error || entry.error || entry.msg,
      taskId: data.taskId || entry.taskId || null,
    };
  }
  return null;
}

function countTasks(tasks) {
  return tasks.reduce((counts, task) => {
    counts[task.status] = (counts[task.status] || 0) + 1;
    counts.total++;
    return counts;
  }, { total: 0 });
}

function withTaskStatus(base, status, task, detail) {
  return withStatus(base, status, {
    detail,
    taskId: task.id || null,
    taskTitle: task.title || task.localTaskId || task.id || '',
  });
}

function withStatus(base, status, extra = {}) {
  return {
    ...base,
    status,
    label: STATUS_LABELS[status] || status,
    detail: extra.detail || STATUS_LABELS[status] || status,
    taskId: extra.taskId || null,
    taskTitle: extra.taskTitle || '',
  };
}
