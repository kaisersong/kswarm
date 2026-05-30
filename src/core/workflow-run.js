/**
 * WorkflowRun — durable control-plane state for KSwarm dynamic workflows.
 *
 * This module deliberately contains no agent execution logic. It only validates
 * workflow shape, advances node/run state, and derives summaries for UI/API.
 */

const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const TERMINAL_NODE_STATUSES = new Set(['completed', 'failed', 'blocked', 'cancelled']);

export function validateWorkflowRunInput(input = {}) {
  if (!input.projectId) return { ok: false, error: 'project_id_required' };
  if (!input.workflowId) return { ok: false, error: 'workflow_id_required' };
  if (!input.title) return { ok: false, error: 'title_required' };

  const phases = Array.isArray(input.phases) ? input.phases : [];
  const nodes = Array.isArray(input.nodes) ? input.nodes : [];
  if (phases.length === 0) return { ok: false, error: 'phases_required' };
  if (nodes.length === 0) return { ok: false, error: 'nodes_required' };

  const phaseIds = new Set(phases.map(phase => String(phase?.id || '')).filter(Boolean));
  if (phaseIds.size !== phases.length) return { ok: false, error: 'phase_id_required' };

  const nodeIds = new Set();
  for (const node of nodes) {
    const nodeId = String(node?.id || '');
    if (!nodeId) return { ok: false, error: 'node_id_required' };
    if (nodeIds.has(nodeId)) return { ok: false, error: 'duplicate_node_id', nodeId };
    nodeIds.add(nodeId);
    if (!phaseIds.has(String(node.phaseId || ''))) return { ok: false, error: 'unknown_phase', nodeId };
  }

  const graph = new Map();
  for (const node of nodes) {
    const nodeId = String(node.id);
    const deps = normalizeDependsOn(node.dependsOn);
    for (const depId of deps) {
      if (!nodeIds.has(depId)) return { ok: false, error: 'unknown_dependency', nodeId, dependency: depId };
    }
    graph.set(nodeId, deps);
  }

  const visiting = new Set();
  const visited = new Set();
  function visit(nodeId) {
    if (visited.has(nodeId)) return false;
    if (visiting.has(nodeId)) return true;
    visiting.add(nodeId);
    for (const depId of graph.get(nodeId) || []) {
      if (visit(depId)) return true;
    }
    visiting.delete(nodeId);
    visited.add(nodeId);
    return false;
  }
  for (const nodeId of nodeIds) {
    if (visit(nodeId)) return { ok: false, error: 'dependency_cycle', nodeId };
  }

  return { ok: true };
}

export function createWorkflowRun(input = {}) {
  const validation = validateWorkflowRunInput(input);
  if (!validation.ok) {
    const error = new Error(validation.error);
    error.validation = validation;
    throw error;
  }

  const now = input.now || Date.now();
  const approvalRequired = input.approval?.required === true;
  const nodes = input.nodes.map(node => normalizeNode(node));
  const phases = input.phases.map(phase => ({
    id: String(phase.id),
    title: String(phase.title || phase.id),
    status: 'pending',
    nodeIds: nodes.filter(node => node.phaseId === String(phase.id)).map(node => node.id),
  }));

  let run = {
    id: input.id || `wf-${now}`,
    projectId: String(input.projectId),
    workflowId: String(input.workflowId),
    title: String(input.title),
    strategy: 'workflow',
    source: input.source || 'builtin',
    status: approvalRequired ? 'awaiting_approval' : 'running',
    createdAt: now,
    updatedAt: now,
    startedAt: approvalRequired ? null : now,
    completedAt: null,
    cancelledAt: null,
    requestedBy: input.requestedBy || null,
    approval: {
      required: approvalRequired,
      status: approvalRequired ? 'pending' : 'not_required',
      budget: input.approval?.budget || null,
      approvedBy: null,
      decidedAt: null,
    },
    phases,
    nodes,
    summary: null,
    diagnosis: input.diagnosis || null,
  };
  run = refreshReadiness(run);
  return refreshSummary(run);
}

export function applyWorkflowEvent(run, event = {}, { now = Date.now() } = {}) {
  if (!run || TERMINAL_RUN_STATUSES.has(run.status)) return run;

  const next = cloneRun(run);
  next.updatedAt = now;

  if (event.type === 'approved') {
    next.approval = {
      ...(next.approval || {}),
      status: 'approved',
      approvedBy: event.by || null,
      decidedAt: now,
    };
    next.status = 'running';
    next.startedAt = next.startedAt || now;
    return refreshSummary(refreshReadiness(next));
  }

  if (event.type === 'cancelled') {
    next.status = 'cancelled';
    next.cancelledAt = now;
    next.nodes = next.nodes.map(node => TERMINAL_NODE_STATUSES.has(node.status)
      ? node
      : { ...node, status: 'cancelled', error: event.reason || null });
    return refreshSummary(refreshPhases(next));
  }

  const node = next.nodes.find(item => item.id === event.nodeId);
  if (!node) {
    const error = new Error('workflow_node_not_found');
    error.nodeId = event.nodeId;
    throw error;
  }

  if (event.type === 'node_dispatched') {
    node.status = 'running';
    node.startedAt = node.startedAt || now;
    node.assignedAgent = event.assignedAgent || node.assignedAgent || null;
    node.attempt = Number.isFinite(Number(event.attempt)) ? Number(event.attempt) : ((node.attempt || 0) + 1);
    node.input = clonePlainValue(event.input || node.input || null);
    node.runtime = {
      ...(node.runtime || {}),
      handoffId: event.handoffId || node.runtime?.handoffId || null,
      runId: next.id,
      participantId: event.assignedAgent || node.runtime?.participantId || null,
      lastProgressAt: now,
    };
    next.status = 'running';
    next.startedAt = next.startedAt || now;
  } else if (event.type === 'node_started') {
    node.status = 'running';
    node.startedAt = node.startedAt || now;
    next.status = 'running';
    next.startedAt = next.startedAt || now;
  } else if (event.type === 'node_completed') {
    node.status = 'completed';
    node.completedAt = now;
    node.output = event.output || null;
    node.producerAgent = event.fromAgent || node.assignedAgent || null;
  } else if (event.type === 'node_failed') {
    node.status = 'failed';
    node.completedAt = now;
    node.error = event.error || 'node_failed';
    next.status = 'failed';
    next.completedAt = now;
  } else if (event.type === 'node_blocked') {
    node.status = 'blocked';
    node.completedAt = now;
    node.error = event.reason || 'node_blocked';
    next.status = 'blocked';
  } else if (event.type === 'node_reviewed') {
    node.status = 'completed';
    node.completedAt = now;
    node.output = event.output || null;
    node.reviewDecision = clonePlainValue(event.reviewDecision);
    node.producerAgent = event.fromAgent || node.assignedAgent || null;
  } else if (event.type === 'gate_completed') {
    node.status = 'completed';
    node.completedAt = now;
    node.output = { decision: clonePlainValue(event.decision) };
    next.gateDecision = clonePlainValue(event.decision);
    next.status = event.decision?.status === 'passed' ? 'completed' : 'blocked';
    next.completedAt = now;
  } else {
    const error = new Error('unknown_workflow_event');
    error.eventType = event.type;
    throw error;
  }

  return refreshSummary(refreshReadiness(next));
}

export function summarizeWorkflowRun(run = {}) {
  const nodes = Array.isArray(run.nodes) ? run.nodes : [];
  const counts = {
    total: nodes.length,
    completed: nodes.filter(node => node.status === 'completed').length,
    failed: nodes.filter(node => node.status === 'failed').length,
    blocked: nodes.filter(node => node.status === 'blocked').length,
    running: nodes.filter(node => node.status === 'running').length,
    pending: nodes.filter(node => ['pending', 'ready'].includes(node.status)).length,
  };
  return {
    ...counts,
    progress: counts.total === 0 ? 0 : counts.completed / counts.total,
    primaryMessage: formatGateDecisionMessage(run.gateDecision) || run.diagnosis?.recommendedActions?.[0]?.label || null,
  };
}

function normalizeNode(node) {
  const dependsOn = normalizeDependsOn(node.dependsOn);
  return {
    id: String(node.id),
    phaseId: String(node.phaseId),
    title: String(node.title || node.id),
    status: dependsOn.length === 0 ? 'ready' : 'pending',
    kind: node.kind || 'control',
    dependsOn,
    assignedAgent: node.assignedAgent || null,
    attempt: Number.isFinite(Number(node.attempt)) ? Number(node.attempt) : 0,
    input: clonePlainValue(node.input || null),
    output: node.output || null,
    reviewDecision: clonePlainValue(node.reviewDecision || null),
    runtime: clonePlainValue(node.runtime || null),
    producerAgent: node.producerAgent || null,
    error: node.error || null,
    startedAt: node.startedAt || null,
    completedAt: node.completedAt || null,
  };
}

function normalizeDependsOn(dependsOn) {
  return Array.isArray(dependsOn) ? dependsOn.map(String).filter(Boolean) : [];
}

function refreshReadiness(run) {
  const completed = new Set(run.nodes.filter(node => node.status === 'completed').map(node => node.id));
  const nodes = run.nodes.map(node => {
    if (node.status !== 'pending') return node;
    return node.dependsOn.every(depId => completed.has(depId)) ? { ...node, status: 'ready' } : node;
  });
  return refreshPhases({ ...run, nodes });
}

function refreshPhases(run) {
  const nodesByPhase = new Map();
  for (const node of run.nodes) {
    if (!nodesByPhase.has(node.phaseId)) nodesByPhase.set(node.phaseId, []);
    nodesByPhase.get(node.phaseId).push(node);
  }
  return {
    ...run,
    phases: run.phases.map(phase => {
      const nodes = nodesByPhase.get(phase.id) || [];
      let status = 'pending';
      if (nodes.length > 0 && nodes.every(node => node.status === 'completed')) status = 'completed';
      else if (nodes.some(node => node.status === 'failed')) status = 'failed';
      else if (nodes.some(node => node.status === 'blocked')) status = 'blocked';
      else if (nodes.length > 0 && nodes.every(node => node.status === 'cancelled')) status = 'cancelled';
      else if (nodes.some(node => ['running', 'ready'].includes(node.status))) status = 'running';
      return { ...phase, status };
    }),
  };
}

function refreshSummary(run) {
  const summary = summarizeWorkflowRun(run);
  let status = run.status;
  if (!TERMINAL_RUN_STATUSES.has(status) && status !== 'awaiting_approval') {
    if (run.gateDecision?.status && run.gateDecision.status !== 'passed') status = 'blocked';
    else if (summary.failed > 0) status = 'failed';
    else if (summary.blocked > 0) status = 'blocked';
    else if (summary.total > 0 && summary.completed === summary.total) status = 'completed';
    else status = 'running';
  }
  return {
    ...run,
    status,
    completedAt: status === 'completed' ? (run.completedAt || run.updatedAt) : run.completedAt,
    summary,
  };
}

function cloneRun(run) {
  return {
    ...run,
    approval: run.approval ? { ...run.approval, budget: run.approval.budget ? { ...run.approval.budget } : null } : null,
    phases: (run.phases || []).map(phase => ({ ...phase, nodeIds: [...(phase.nodeIds || [])] })),
    nodes: (run.nodes || []).map(node => ({
      ...node,
      dependsOn: [...(node.dependsOn || [])],
      output: clonePlainValue(node.output),
    })),
    summary: run.summary ? { ...run.summary } : null,
    diagnosis: clonePlainValue(run.diagnosis),
    gateDecision: clonePlainValue(run.gateDecision),
  };
}

function clonePlainValue(value) {
  if (value === null || value === undefined) return value;
  return JSON.parse(JSON.stringify(value));
}

function formatGateDecisionMessage(decision) {
  if (!decision?.status) return null;
  if (decision.status === 'passed') return 'Review gate passed';
  if (decision.status === 'needs_rework') return 'Review gate needs rework';
  if (decision.status === 'blocked') return 'Review gate blocked';
  return null;
}
