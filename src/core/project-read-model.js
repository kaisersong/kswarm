import { createHash } from 'node:crypto';

const TASK_TERMINAL_OK = new Set(['done', 'cancelled']);
const TASK_TERMINAL_BAD = new Set(['failed', 'blocked']);
const EXECUTION_STATUS_ORDER = new Map([
  ['pending', 0],
  ['ready', 1],
  ['dispatched', 2],
  ['accepted', 3],
  ['in_progress', 4],
  ['submitted', 5],
  ['reviewing', 6],
  ['done', 7],
  ['failed', 8],
  ['blocked', 9],
  ['cancelled', 10],
]);

export function parseStrictWorkflowLabel(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;

  const matches = [];
  const matcher = /(?:\bitem-(\d+)\b|\bItem\s+(\d+)\b|\bAgent\s*(\d+)\b|支柱\s*([零〇一二三四五六七八九十百\d]+)|任务\s*([零〇一二三四五六七八九十百\d]+))/g;
  let match;
  while ((match = matcher.exec(text)) !== null) {
    const raw = match[1] || match[2] || match[3] || match[4] || match[5];
    const n = parsePositiveInteger(raw);
    if (!n) return null;
    matches.push({ start: match.index, end: matcher.lastIndex, n });
  }
  if (matches.length === 0) return null;

  const unique = new Set(matches.map(item => item.n));
  if (unique.size !== 1) return null;

  const remainder = removeMatchedRanges(text, matches).trim();
  if (/[A-Za-z0-9\u4e00-\u9fff]/.test(remainder)) return null;
  return `item-${matches[0].n}`;
}

export function deriveExecutionGraph({
  project = null,
  tasks = [],
  workflowRuns = [],
  bindings = [],
  artifacts = [],
  finalDeliverables = [],
} = {}) {
  const normalizedTasks = Array.isArray(tasks) ? tasks : [];
  const normalizedWorkflowRuns = Array.isArray(workflowRuns) ? workflowRuns : [];
  const taskLookup = buildTaskLookup(project?.id, normalizedTasks);
  const claimedTaskIds = new Set();
  const nodes = [];

  for (const task of normalizedTasks) {
    nodes.push({
      stableNodeId: task.localTaskId || task.userFacingId || normalizeTaskDisplayId(project?.id, task.id) || task.id,
      displayId: task.localTaskId || task.userFacingId || normalizeTaskDisplayId(project?.id, task.id) || task.id,
      title: task.title || task.id,
      source: 'task_board',
      ownership: isDelegatedTask(project, task, normalizedWorkflowRuns) ? 'delegated_to_workflow' : 'canonical',
      taskId: task.id,
      status: normalizeTaskStatus(task.status),
      required: task.required !== false,
      expectedDeliverableKind: inferExpectedDeliverableKind(task),
      expectedFormat: inferExpectedFormat(task),
      assignedAgent: task.assignedAgent || null,
      assignedRuntimeInstance: task.assignedRuntimeInstance || null,
      artifacts: collectTaskArtifacts(task),
      consistencyIssues: [],
      statusSource: 'task_board',
    });
  }

  for (const workflowRun of normalizedWorkflowRuns) {
    for (const workflowNode of Array.isArray(workflowRun?.nodes) ? workflowRun.nodes : []) {
      const binding = resolveWorkflowNodeBinding({
        project,
        workflowRun,
        workflowNode,
        taskLookup,
        bindings,
        claimedTaskIds,
      });
      const status = normalizeWorkflowNodeStatus(workflowNode.status, workflowRun.status);
      nodes.push({
        stableNodeId: binding.stableNodeId,
        displayId: binding.userFacingId || binding.stableNodeId,
        title: workflowNode.title || workflowNode.label || workflowNode.id,
        source: workflowRun.scope?.taskId ? 'script_workflow' : 'project_workflow',
        ownership: binding.taskId ? 'delegated_to_workflow' : 'unbound',
        ...(binding.taskId ? { taskId: binding.taskId } : {}),
        workflowRunId: workflowRun.id,
        workflowNodeId: workflowNode.id,
        status,
        required: workflowNode.required !== false,
        expectedDeliverableKind: inferWorkflowExpectedDeliverableKind(workflowNode),
        expectedFormat: inferExpectedFormat(workflowNode),
        assignedAgent: workflowNode.assignedAgent || null,
        assignedRuntimeInstance: workflowNode.assignedRuntimeInstance || workflowNode.runtime?.participantId || null,
        artifacts: collectWorkflowNodeArtifacts(workflowNode, finalDeliverables, artifacts),
        consistencyIssues: binding.issue ? [binding.issue] : [],
        statusSource: 'workflow_run',
        ...(binding.bindingSource ? { bindingSource: binding.bindingSource } : {}),
      });
    }
  }

  const counts = countExecutionNodes(nodes);
  return {
    projectId: project?.id || null,
    nodes,
    counts,
    derivedAt: new Date().toISOString(),
  };
}

export function deriveProjectLifecycle({
  project = null,
  tasks = [],
  workflowRuns = [],
  bindings = [],
  artifacts = [],
  finalDeliverables = [],
  reviewGateDecisions = [],
  now = Date.now(),
} = {}) {
  const executionGraph = deriveExecutionGraph({ project, tasks, workflowRuns, bindings, artifacts, finalDeliverables });
  const issues = [];
  const legacyStatus = project?.status || 'created';
  const approvedFinal = selectApprovedFinalDeliverable(finalDeliverables);
  const gateDecision = approvedFinal
    ? selectGateDecisionForDeliverable(reviewGateDecisions, approvedFinal.deliverableId)
    : null;
  const allRequiredTerminalOk = executionGraph.nodes
    .filter(node => node.required !== false)
    .every(node => isExecutionNodeTerminalOk(node));
  const hasCandidateFinal = finalDeliverables.some(item => ['candidate', 'under_review'].includes(item?.status));
  const hasLegacyWorkflowCandidate = hasCandidateFinal && ['created', 'planning'].includes(legacyStatus);
  const canAutoClose = Boolean(
    approvedFinal &&
    approvedFinal.approval?.requestContext?.requestSource === 'user' &&
    gateDecision?.finalDeliverableId === approvedFinal.deliverableId &&
    gateDecision?.decision === 'passed' &&
    gateDecision?.autoCloseAllowed === true &&
    allRequiredTerminalOk &&
    deterministicChecksPassedForApprovedDeliverable(approvedFinal),
  );

  let state = normalizeLegacyLifecycleState(legacyStatus);
  let primaryAction = null;

  if (legacyStatus === 'closed') {
    state = 'closed';
  } else if (canAutoClose || legacyStatus === 'delivered') {
    state = canAutoClose ? 'delivered' : 'ready_to_deliver';
    if (legacyStatus === 'delivered' && !canAutoClose) {
      issues.push({ kind: 'legacy_status_drift', legacyStatus, lifecycleState: state });
    }
  } else if (hasLegacyWorkflowCandidate) {
    state = 'legacy_needs_reconciliation';
    primaryAction = { id: 'user_select_or_confirm_final_deliverable', strategy: 'confirm_final_deliverable' };
    issues.push({ kind: 'legacy_final_deliverable_needs_confirmation' });
  } else if (hasCandidateFinal && allRequiredTerminalOk) {
    state = 'ready_to_deliver';
    primaryAction = { id: 'user_review_final_deliverable', strategy: 'review_final_deliverable' };
  } else if (executionGraph.nodes.some(node => node.status === 'blocked' || node.status === 'failed')) {
    state = 'blocked';
    primaryAction = { id: 'resolve_blocker', strategy: 'resolve_project_blocker' };
  } else if (executionGraph.nodes.some(node => ['dispatched', 'accepted', 'in_progress', 'submitted', 'reviewing'].includes(node.status))) {
    state = 'running';
  } else if (legacyStatus === 'planning' && executionGraph.nodes.length > 0) {
    state = 'ready_to_start';
    primaryAction = { id: 'approve_or_start_project', strategy: 'activate_project' };
  }

  if (legacyStatus && !isLegacyStatusCompatible(legacyStatus, state)) {
    issues.push({ kind: 'legacy_status_drift', legacyStatus, lifecycleState: state });
  }

  return {
    projectId: project?.id || null,
    state,
    canDispatch: ['active', 'running', 'ready_to_start'].includes(state),
    canResume: state === 'blocked' || workflowRuns.some(run => run?.recovery?.nextAction === 'resume_workflow'),
    canRegisterFinalDeliverable: ['active', 'running', 'ready_to_deliver', 'legacy_needs_reconciliation'].includes(state),
    canAutoClose,
    ...(primaryAction ? { primaryAction } : {}),
    issues: dedupeIssues(issues),
    counts: executionGraph.counts,
    version: Number(project?.lifecycleVersion || project?.version || project?.updatedAt || project?.createdAt || 0),
    derivedAt: new Date(now).toISOString(),
  };
}

function parsePositiveInteger(raw) {
  if (/^\d+$/.test(String(raw))) {
    const value = Number(raw);
    return Number.isInteger(value) && value > 0 ? value : 0;
  }
  const value = parseChinesePositiveInteger(String(raw));
  return Number.isInteger(value) && value > 0 ? value : 0;
}

function parseChinesePositiveInteger(value) {
  const text = value.replace(/[零〇]/g, '').trim();
  const digits = {
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };
  if (digits[text]) return digits[text];
  if (text === '十') return 10;
  const ten = text.match(/^([一二两三四五六七八九])?十([一二三四五六七八九])?$/);
  if (ten) return (ten[1] ? digits[ten[1]] : 1) * 10 + (ten[2] ? digits[ten[2]] : 0);
  return 0;
}

function removeMatchedRanges(text, matches) {
  let result = '';
  let cursor = 0;
  for (const item of matches) {
    result += text.slice(cursor, item.start);
    cursor = item.end;
  }
  return result + text.slice(cursor);
}

function buildTaskLookup(projectId, tasks) {
  const byRef = new Map();
  for (const task of tasks) {
    for (const ref of new Set(taskRefs(projectId, task))) {
      if (!byRef.has(ref)) byRef.set(ref, []);
      const bucket = byRef.get(ref);
      if (!bucket.some(item => item.id === task.id)) bucket.push(task);
    }
  }
  return byRef;
}

function taskRefs(projectId, task) {
  return [
    task.id,
    task.localTaskId,
    task.userFacingId,
    task.planItemId,
    normalizeTaskDisplayId(projectId, task.id),
    task.title,
  ].map(value => String(value || '').trim()).filter(Boolean);
}

function normalizeTaskDisplayId(projectId, taskId) {
  const value = String(taskId || '');
  if (!value) return '';
  const prefix = `${projectId || ''}__`;
  if (projectId && value.startsWith(prefix)) return value.slice(prefix.length);
  return value;
}

function resolveWorkflowNodeBinding({ project, workflowRun, workflowNode, taskLookup, bindings, claimedTaskIds }) {
  const explicit = resolveExplicitBinding({ workflowRun, workflowNode, taskLookup, bindings });
  if (explicit) {
    claimedTaskIds.add(explicit.task.id);
    return {
      stableNodeId: explicit.task.localTaskId || explicit.task.userFacingId || normalizeTaskDisplayId(project?.id, explicit.task.id) || explicit.task.id,
      userFacingId: explicit.task.localTaskId || explicit.task.userFacingId || normalizeTaskDisplayId(project?.id, explicit.task.id) || explicit.task.id,
      taskId: explicit.task.id,
      bindingSource: explicit.bindingSource,
    };
  }

  const parsed = parseStrictWorkflowLabel(workflowNode.title || workflowNode.label || '');
  const candidates = parsed ? taskLookup.get(parsed) || [] : [];
  if (candidates.length === 1 && !claimedTaskIds.has(candidates[0].id)) {
    claimedTaskIds.add(candidates[0].id);
    return {
      stableNodeId: parsed,
      userFacingId: parsed,
      taskId: candidates[0].id,
      bindingSource: 'strict_label',
    };
  }

  const stableNodeId = `wf-node-${hashStableId(project?.id, workflowRun?.id, workflowNode?.id)}`;
  return {
    stableNodeId,
    issue: { kind: 'workflow_node_unbound', workflowRunId: workflowRun?.id, workflowNodeId: workflowNode?.id },
  };
}

function resolveExplicitBinding({ workflowRun, workflowNode, taskLookup, bindings }) {
  const candidates = [
    workflowNode.taskId,
    workflowNode.userFacingId,
    workflowNode.sourceTask?.taskId,
    workflowRun?.scope?.taskId && workflowNode.kind !== 'review_gate' ? workflowRun.scope.taskId : null,
  ].map(value => String(value || '').trim()).filter(Boolean);
  for (const binding of Array.isArray(bindings) ? bindings : []) {
    if (binding.workflowRunId === workflowRun?.id && binding.workflowNodeId === workflowNode?.id) {
      candidates.unshift(binding.taskId || binding.userFacingId);
    }
  }
  for (const ref of candidates) {
    const matches = taskLookup.get(ref) || [];
    if (matches.length === 1) return { task: matches[0], bindingSource: 'explicit' };
  }
  return null;
}

function hashStableId(...parts) {
  return createHash('sha1').update(parts.map(part => String(part || '')).join('\0')).digest('hex').slice(0, 16);
}

function normalizeTaskStatus(status) {
  if (status === 'accepted') return 'accepted';
  if (status === 'in_progress') return 'in_progress';
  if (status === 'submitted') return 'submitted';
  if (status === 'done') return 'done';
  if (status === 'failed') return 'failed';
  if (status === 'blocked') return 'blocked';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'dispatched') return 'dispatched';
  if (status === 'ready') return 'ready';
  return 'pending';
}

function normalizeWorkflowNodeStatus(nodeStatus, runStatus) {
  if (nodeStatus === 'completed') return 'done';
  if (nodeStatus === 'running') return 'in_progress';
  if (nodeStatus === 'ready') return 'ready';
  if (nodeStatus === 'failed') return 'failed';
  if (nodeStatus === 'blocked') return 'blocked';
  if (nodeStatus === 'cancelled') return 'cancelled';
  if (runStatus === 'completed') return 'done';
  return 'pending';
}

function countExecutionNodes(nodes) {
  const counts = {
    total: nodes.length,
    pending: 0,
    ready: 0,
    dispatched: 0,
    accepted: 0,
    inProgress: 0,
    submitted: 0,
    reviewing: 0,
    done: 0,
    failed: 0,
    blocked: 0,
    cancelled: 0,
  };
  for (const node of nodes) {
    if (node.status === 'in_progress') counts.inProgress++;
    else if (Object.prototype.hasOwnProperty.call(counts, node.status)) counts[node.status]++;
  }
  return counts;
}

function isDelegatedTask(project, task, workflowRuns) {
  if (task?.execution?.strategy === 'workflow') return true;
  if (project?.executionMode !== 'workflow_preferred') return false;
  return workflowRuns.some(run => run?.scope?.projectId === project?.id && !run?.scope?.taskId);
}

function inferExpectedDeliverableKind(item) {
  const outputs = Array.isArray(item?.requiredOutputs) ? item.requiredOutputs : [];
  return outputs.length > 0 ? 'file' : 'none';
}

function inferWorkflowExpectedDeliverableKind(node) {
  if (node?.outputContract || Array.isArray(node?.output?.artifacts)) return 'file';
  return 'none';
}

function inferExpectedFormat(item) {
  const outputs = Array.isArray(item?.requiredOutputs) ? item.requiredOutputs : [];
  const first = outputs[0];
  if (typeof first === 'string') return normalizeFormat(first);
  if (first?.type) return normalizeFormat(first.type);
  if (item?.expectedFormat) return normalizeFormat(item.expectedFormat);
  return undefined;
}

function normalizeFormat(value) {
  const lower = String(value || '').toLowerCase();
  if (lower.includes('markdown') || lower === 'md') return 'markdown';
  if (lower.includes('html')) return 'html';
  if (lower.includes('ppt')) return 'pptx';
  if (lower.includes('pdf')) return 'pdf';
  if (lower.includes('json')) return 'json';
  if (lower.includes('csv')) return 'csv';
  if (lower === 'none') return 'none';
  return undefined;
}

function collectTaskArtifacts(task) {
  return Array.isArray(task?.result?.artifacts) ? task.result.artifacts : [];
}

function collectWorkflowNodeArtifacts(node, finalDeliverables, artifacts) {
  const result = [];
  if (Array.isArray(node?.output?.artifacts)) result.push(...node.output.artifacts);
  if (Array.isArray(artifacts)) {
    result.push(...artifacts.filter(item => item?.workflowNodeId === node?.id));
  }
  if (Array.isArray(finalDeliverables)) {
    result.push(...finalDeliverables
      .filter(item => item?.workflowNodeId === node?.id || item?.executionNodeId === node?.id)
      .map(item => item.artifactRef)
      .filter(Boolean));
  }
  return result;
}

function selectApprovedFinalDeliverable(deliverables) {
  return [...(Array.isArray(deliverables) ? deliverables : [])]
    .filter(item => item?.status === 'approved')
    .sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')))[0] || null;
}

function selectGateDecisionForDeliverable(decisions, deliverableId) {
  return [...(Array.isArray(decisions) ? decisions : [])]
    .filter(item => item?.finalDeliverableId === deliverableId)
    .sort((a, b) => String(b.decidedAt || '').localeCompare(String(a.decidedAt || '')))[0] || null;
}

function deterministicChecksPassedForApprovedDeliverable(deliverable) {
  if (deliverable.kind === 'none') return true;
  return Boolean(deliverable.artifactRef && deliverable.serviceComputedHash);
}

function isExecutionNodeTerminalOk(node) {
  if (node.required === false) return true;
  if (node.status === 'done') return true;
  if (node.status === 'cancelled' && node.expectedDeliverableKind === 'none') return true;
  return false;
}

function normalizeLegacyLifecycleState(status) {
  if (status === 'created') return 'created';
  if (status === 'planning' || status === 'setup') return 'planning';
  if (status === 'active') return 'active';
  if (status === 'delivered') return 'delivered';
  if (status === 'closed') return 'closed';
  if (status === 'abandoned') return 'abandoned';
  return 'created';
}

function isLegacyStatusCompatible(legacyStatus, state) {
  if (legacyStatus === state) return true;
  if (legacyStatus === 'active' && ['active', 'running', 'blocked', 'ready_to_deliver', 'needs_review'].includes(state)) return true;
  if (legacyStatus === 'planning' && ['planning', 'ready_to_start', 'legacy_needs_reconciliation'].includes(state)) return true;
  if (legacyStatus === 'created' && ['created', 'planning', 'ready_to_start'].includes(state)) return true;
  return false;
}

function dedupeIssues(issues) {
  const seen = new Set();
  const result = [];
  for (const issue of issues) {
    const key = `${issue.kind}:${issue.legacyStatus || ''}:${issue.lifecycleState || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(issue);
  }
  return result;
}
