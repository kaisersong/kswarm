/**
 * WorkflowRun — durable control-plane state for KSwarm dynamic workflows.
 *
 * This module deliberately contains no agent execution logic. It only validates
 * workflow shape, advances node/run state, and derives summaries for UI/API.
 */

import { createHash } from 'node:crypto';

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
    scope: clonePlainValue(input.scope || input.spec?.scope || { projectId: String(input.projectId) }),
    sourceTask: clonePlainValue(input.sourceTask || null),
    spec: clonePlainValue(input.spec || null),
    budgets: clonePlainValue(input.budgets || input.approval?.budget || null),
    budgetGate: clonePlainValue(input.budgetGate || null),
    permissions: clonePlainValue(input.permissions || null),
    outputContract: clonePlainValue(input.outputContract || null),
    acceptanceRubric: clonePlainValue(input.acceptanceRubric || input.spec?.acceptanceRubric || null),
    assumptions: Array.isArray(input.assumptions) ? input.assumptions.map(String) : [],
    approval: {
      required: approvalRequired,
      status: approvalRequired ? 'pending' : 'not_required',
      budget: input.approval?.budget || null,
      approvedBy: null,
      decidedAt: null,
    },
    phases,
    nodes,
    parallelGroups: Array.isArray(input.parallelGroups) ? input.parallelGroups.map(group => normalizeParallelGroup(group)) : [],
    scriptCheckpoints: Array.isArray(input.scriptCheckpoints) ? input.scriptCheckpoints.map(checkpoint => normalizeScriptCheckpoint(checkpoint)) : [],
    summary: null,
    diagnosis: input.diagnosis || null,
    recovery: null,
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
    node.cache = buildNodeCache(next, node, { now });
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
    node.cache = buildNodeCache(next, node, { now });
  } else if (event.type === 'gate_completed') {
    node.status = 'completed';
    node.completedAt = now;
    node.output = { decision: clonePlainValue(event.decision) };
    node.cache = buildNodeCache(next, node, { now });
    next.gateDecision = clonePlainValue(event.decision);
    next.status = event.decision?.status === 'passed' ? 'completed' : 'blocked';
    next.completedAt = now;
    if (event.decision?.status === 'needs_replanning') {
      next.revisedProposalRequest = {
        status: 'pending_user_confirmation',
        reason: event.decision.reason || 'needs_replanning',
        evidenceRefs: clonePlainValue(event.decision.evidenceRefs || []),
        invalidationScope: clonePlainValue(event.decision.invalidationScope || null),
      };
    }
  } else {
    const error = new Error('unknown_workflow_event');
    error.eventType = event.type;
    throw error;
  }

  return refreshSummary(refreshReadiness(next));
}

export function refreshWorkflowRunState(run = {}) {
  return refreshSummary(refreshReadiness(cloneRun(run)));
}

export function summarizeWorkflowRun(run = {}) {
  const nodes = Array.isArray(run.nodes) ? run.nodes : [];
  const parallelGroups = Array.isArray(run.parallelGroups) ? run.parallelGroups : [];
  const scriptCheckpoints = Array.isArray(run.scriptCheckpoints) ? run.scriptCheckpoints : [];
  const counts = {
    total: nodes.length,
    completed: nodes.filter(node => node.status === 'completed').length,
    failed: nodes.filter(node => node.status === 'failed').length,
    blocked: nodes.filter(node => node.status === 'blocked').length,
    running: nodes.filter(node => node.status === 'running').length,
    pending: nodes.filter(node => ['pending', 'ready'].includes(node.status)).length,
  };
  const storedNodes = nodes.filter(node => node.cache?.status === 'stored');
  const reusableNodes = storedNodes.filter(node => node.status === 'completed');
  return {
    ...counts,
    progress: counts.total === 0 ? 0 : counts.completed / counts.total,
    primaryMessage: formatGateDecisionMessage(run.gateDecision) || run.diagnosis?.recommendedActions?.[0]?.label || null,
    cache: {
      storedNodeCount: storedNodes.length,
      reusableNodeCount: reusableNodes.length,
    },
    parallelGroups: {
      total: parallelGroups.length,
      completed: parallelGroups.filter(group => group.status === 'completed').length,
      failed: parallelGroups.filter(group => group.status === 'failed').length,
      blocked: parallelGroups.filter(group => group.status === 'blocked').length,
      running: parallelGroups.filter(group => ['queued', 'running', 'waiting_for_children'].includes(group.status)).length,
      cancelled: parallelGroups.filter(group => group.status === 'cancelled').length,
    },
    checkpoints: {
      total: scriptCheckpoints.length,
      completed: scriptCheckpoints.filter(checkpoint => checkpoint.status === 'completed').length,
      waiting: scriptCheckpoints.filter(checkpoint => checkpoint.status === 'waiting').length,
      failed: scriptCheckpoints.filter(checkpoint => checkpoint.status === 'failed').length,
    },
    blockingFailures: nodes
      .filter(node => ['failed', 'blocked'].includes(node.status))
      .map(node => ({ nodeId: node.id, title: node.title, status: node.status, reason: node.error || null })),
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
    cache: clonePlainValue(node.cache || null),
    producerAgent: node.producerAgent || null,
    error: node.error || null,
    startedAt: node.startedAt || null,
    completedAt: node.completedAt || null,
    parallelGroupId: node.parallelGroupId || null,
    fanoutItemKey: node.fanoutItemKey || null,
    fanoutItemLabel: node.fanoutItemLabel || null,
    pipelineStageIndex: Number.isFinite(Number(node.pipelineStageIndex)) ? Number(node.pipelineStageIndex) : null,
    required: node.required !== false,
    outputSchema: clonePlainValue(node.outputSchema || null),
    evidenceRequired: node.evidenceRequired === true,
  };
}

function normalizeParallelGroup(group = {}) {
  const failurePolicy = ['required_all', 'collect_errors', 'fail_fast', 'quorum'].includes(group.failurePolicy)
    ? group.failurePolicy
    : 'required_all';
  return {
    id: String(group.id || ''),
    workflowRunId: group.workflowRunId ? String(group.workflowRunId) : null,
    phaseId: group.phaseId ? String(group.phaseId) : null,
    primitiveId: group.primitiveId ? String(group.primitiveId) : null,
    kind: ['parallel', 'pipeline'].includes(group.kind) ? group.kind : 'parallel',
    label: String(group.label || group.id || '并行分组'),
    status: group.status || 'queued',
    limit: Math.max(1, Number(group.limit || 1)),
    totalCount: Math.max(0, Number(group.totalCount || 0)),
    completedCount: Math.max(0, Number(group.completedCount || 0)),
    failedCount: Math.max(0, Number(group.failedCount || 0)),
    cancelledCount: Math.max(0, Number(group.cancelledCount || 0)),
    requiredFailedCount: Math.max(0, Number(group.requiredFailedCount || 0)),
    failurePolicy,
    quorum: Number.isFinite(Number(group.quorum)) ? Number(group.quorum) : null,
    createdAt: group.createdAt || null,
    updatedAt: group.updatedAt || null,
    completedAt: group.completedAt || null,
  };
}

function normalizeScriptCheckpoint(checkpoint = {}) {
  return {
    id: String(checkpoint.id || ''),
    workflowRunId: checkpoint.workflowRunId ? String(checkpoint.workflowRunId) : null,
    scriptHash: checkpoint.scriptHash ? String(checkpoint.scriptHash) : null,
    primitiveType: checkpoint.primitiveType ? String(checkpoint.primitiveType) : null,
    primitiveId: checkpoint.primitiveId ? String(checkpoint.primitiveId) : null,
    phaseId: checkpoint.phaseId ? String(checkpoint.phaseId) : null,
    parallelGroupId: checkpoint.parallelGroupId ? String(checkpoint.parallelGroupId) : null,
    status: checkpoint.status || 'started',
    inputHash: checkpoint.inputHash ? String(checkpoint.inputHash) : null,
    outputRefs: Array.isArray(checkpoint.outputRefs) ? checkpoint.outputRefs.map(String).filter(Boolean) : [],
    createdAt: checkpoint.createdAt || null,
    updatedAt: checkpoint.updatedAt || null,
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
  const withGroups = refreshParallelGroups(run);
  const withCheckpoints = refreshScriptCheckpoints(withGroups);
  const summary = summarizeWorkflowRun(withCheckpoints);
  let status = withCheckpoints.status;
  if (!TERMINAL_RUN_STATUSES.has(status) && status !== 'awaiting_approval') {
    if (withGroups.gateDecision?.status && withGroups.gateDecision.status !== 'passed') status = 'blocked';
    else if (summary.failed > 0) status = 'failed';
    else if (summary.blocked > 0) status = 'blocked';
    else if (summary.total > 0 && summary.completed === summary.total) status = 'completed';
    else status = 'running';
  }
  return {
    ...withGroups,
    ...withCheckpoints,
    status,
    completedAt: status === 'completed' ? (withCheckpoints.completedAt || withCheckpoints.updatedAt) : withCheckpoints.completedAt,
    summary,
    recovery: summarizeRecovery({ ...withCheckpoints, status, summary }),
  };
}

function refreshParallelGroups(run) {
  const parallelGroups = Array.isArray(run.parallelGroups) ? run.parallelGroups : [];
  if (parallelGroups.length === 0) return { ...run, parallelGroups: [] };
  const nodes = Array.isArray(run.nodes) ? run.nodes : [];
  return {
    ...run,
    parallelGroups: parallelGroups.map(rawGroup => {
      const group = normalizeParallelGroup(rawGroup);
      const groupNodes = nodes.filter(node => node.parallelGroupId === group.id);
      const completedCount = groupNodes.filter(node => node.status === 'completed').length;
      const failedCount = groupNodes.filter(node => node.status === 'failed').length;
      const blockedCount = groupNodes.filter(node => node.status === 'blocked').length;
      const cancelledCount = groupNodes.filter(node => node.status === 'cancelled').length;
      const requiredFailedCount = groupNodes.filter(node => node.required !== false && ['failed', 'blocked'].includes(node.status)).length;
      const totalCount = Math.max(group.totalCount, groupNodes.length);
      const terminalCount = completedCount + failedCount + blockedCount + cancelledCount;
      const quorum = Number.isFinite(Number(group.quorum)) ? Math.max(1, Number(group.quorum)) : totalCount;
      let status = group.status;
      if (group.failurePolicy === 'quorum' && completedCount >= quorum) status = 'completed';
      else if (totalCount > 0 && completedCount >= totalCount) status = 'completed';
      else if (group.failurePolicy === 'collect_errors' && totalCount > 0 && terminalCount >= totalCount) status = 'completed';
      else if (group.failurePolicy === 'fail_fast' && requiredFailedCount > 0) status = 'failed';
      else if (group.failurePolicy === 'required_all' && requiredFailedCount > 0) status = 'failed';
      else if (group.failurePolicy === 'quorum' && totalCount > 0 && (completedCount + Math.max(0, totalCount - terminalCount)) < quorum) status = 'failed';
      else if (blockedCount > 0) status = 'blocked';
      else if (totalCount > 0 && cancelledCount >= totalCount) status = 'cancelled';
      else if (groupNodes.length > 0) status = 'waiting_for_children';
      else if (status === 'queued') status = 'running';
      return {
        ...group,
        status,
        totalCount,
        completedCount,
        failedCount,
        cancelledCount,
        requiredFailedCount,
        updatedAt: run.updatedAt || group.updatedAt,
        completedAt: status === 'completed' ? (group.completedAt || run.updatedAt || null) : group.completedAt,
      };
    }),
  };
}

function refreshScriptCheckpoints(run) {
  const checkpoints = Array.isArray(run.scriptCheckpoints) ? run.scriptCheckpoints : [];
  if (checkpoints.length === 0) return { ...run, scriptCheckpoints: [] };
  const nodes = Array.isArray(run.nodes) ? run.nodes : [];
  const groups = Array.isArray(run.parallelGroups) ? run.parallelGroups : [];
  return {
    ...run,
    scriptCheckpoints: checkpoints.map(rawCheckpoint => {
      const checkpoint = normalizeScriptCheckpoint(rawCheckpoint);
      let status = checkpoint.status;
      if (checkpoint.primitiveType === 'parallel' || checkpoint.primitiveType === 'pipeline') {
        const group = groups.find(item => item.id === checkpoint.parallelGroupId);
        if (group?.status === 'completed') status = 'completed';
        else if (['failed', 'blocked', 'cancelled'].includes(group?.status)) status = group.status;
        else if (group) status = 'waiting';
      } else if (checkpoint.primitiveType === 'agent') {
        const node = nodes.find(item => checkpoint.outputRefs.includes(item.id));
        if (node?.status === 'completed') status = 'completed';
        else if (['failed', 'blocked', 'cancelled'].includes(node?.status)) status = node.status;
        else if (node) status = 'waiting';
      }
      return {
        ...checkpoint,
        status,
        updatedAt: run.updatedAt || checkpoint.updatedAt,
      };
    }),
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
      cache: clonePlainValue(node.cache),
      outputSchema: clonePlainValue(node.outputSchema),
    })),
    parallelGroups: (run.parallelGroups || []).map(group => ({ ...group })),
    scriptCheckpoints: (run.scriptCheckpoints || []).map(checkpoint => ({
      ...checkpoint,
      outputRefs: [...(checkpoint.outputRefs || [])],
    })),
    summary: run.summary ? { ...run.summary } : null,
    diagnosis: clonePlainValue(run.diagnosis),
    gateDecision: clonePlainValue(run.gateDecision),
    revisedProposalRequest: clonePlainValue(run.revisedProposalRequest),
    spec: clonePlainValue(run.spec),
    scope: clonePlainValue(run.scope),
    sourceTask: clonePlainValue(run.sourceTask),
    budgets: clonePlainValue(run.budgets),
    budgetGate: clonePlainValue(run.budgetGate),
    permissions: clonePlainValue(run.permissions),
    outputContract: clonePlainValue(run.outputContract),
    acceptanceRubric: clonePlainValue(run.acceptanceRubric),
    assumptions: Array.isArray(run.assumptions) ? [...run.assumptions] : [],
  };
}

function summarizeRecovery(run) {
  const reusableNodeCount = run.summary?.cache?.reusableNodeCount || 0;
  if (run.status === 'completed') {
    return { mode: 'not_needed', reusableNodeCount, nextAction: 'none' };
  }
  if (run.status === 'blocked') {
    const runtimeBlocked = (run.summary?.blockingFailures || []).some(item => String(item.reason || '').includes('runtime'));
    if (runtimeBlocked) return { mode: 'blocked_waiting_runtime', reusableNodeCount, nextAction: 'wait_for_runtime' };
  }
  if (reusableNodeCount > 0 && !TERMINAL_RUN_STATUSES.has(run.status)) {
    return { mode: 'resume_completed_nodes', reusableNodeCount, nextAction: 'resume_workflow' };
  }
  if (run.status === 'failed' || run.status === 'cancelled') {
    return { mode: 'rerun_from_start', reusableNodeCount, nextAction: 'rerun_workflow' };
  }
  return { mode: 'not_needed', reusableNodeCount, nextAction: 'none' };
}

function buildNodeCache(run, node, { now }) {
  const inputHash = hashPlainValue(node.input || null);
  const outputHash = hashPlainValue(node.output || node.reviewDecision || null);
  return {
    key: `${run.id}:${node.id}:${node.attempt || 0}:${inputHash}:${outputHash}`,
    status: 'stored',
    storedAt: now,
    inputHash,
    outputHash,
  };
}

function hashPlainValue(value) {
  return createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');
}

function clonePlainValue(value) {
  if (value === null || value === undefined) return value;
  return JSON.parse(JSON.stringify(value));
}

function formatGateDecisionMessage(decision) {
  if (!decision?.status) return null;
  if (decision.status === 'passed') return 'Review gate passed';
  if (decision.status === 'needs_rework') return 'Review gate needs rework';
  if (decision.status === 'needs_replanning') return 'Review gate needs replanning';
  if (decision.status === 'needs_rubric_clarification') return 'Review gate needs rubric clarification';
  if (decision.status === 'blocked') return 'Review gate blocked';
  return null;
}
