const ALLOWED_NODE_KINDS = new Set(['agent', 'review', 'reduce', 'artifact_check', 'budget_check']);
const ALLOWED_CHECK_KINDS = new Set(['schema', 'file_exists', 'test_command', 'renderer_metadata', 'budget', 'permission', 'artifact_path']);
const ALLOWED_DISAGREEMENT_POLICIES = new Set(['block', 'adversarial_review', 'human_review']);
const ALLOWED_GATE_STATUSES = new Set(['passed', 'needs_rework', 'needs_replanning', 'needs_rubric_clarification', 'blocked']);
const NODE_MUTATION_KEYS = ['taskMutations', 'workflowGraphMutation', 'projectStatus'];
const DECISION_MUTATION_KEYS = ['taskStatus', 'artifactStatus', 'suggestedTaskMutations'];

export function validateWorkflowSpec(spec = {}, { policy = null, capabilities = [] } = {}) {
  if (!spec || typeof spec !== 'object') return { ok: false, error: 'workflow_spec_required' };
  if (spec.kind !== 'kswarm_workflow_spec_v1') return { ok: false, error: 'workflow_spec_kind_invalid' };
  if (!spec.scope?.projectId) return { ok: false, error: 'workflow_scope_project_required' };
  if (!Array.isArray(spec.phases) || spec.phases.length === 0) return { ok: false, error: 'workflow_phases_required' };
  if (!spec.acceptanceRubric) return { ok: false, error: 'acceptance_rubric_required' };

  const rubric = validateAcceptanceRubric(spec.acceptanceRubric, { workflowKind: inferWorkflowKind(spec) });
  if (!rubric.ok) return rubric;

  const phaseIds = new Set();
  const nodes = [];
  for (const phase of spec.phases) {
    const phaseId = String(phase?.id || '');
    if (!phaseId) return { ok: false, error: 'phase_id_required' };
    if (phaseIds.has(phaseId)) return { ok: false, error: 'duplicate_phase_id', phaseId };
    phaseIds.add(phaseId);
    if (!Array.isArray(phase.nodes) || phase.nodes.length === 0) return { ok: false, error: 'phase_nodes_required', phaseId };
    for (const node of phase.nodes) nodes.push({ ...node, phaseId });
  }

  const nodeIds = new Set();
  for (const node of nodes) {
    const nodeId = String(node?.id || '');
    if (!nodeId) return { ok: false, error: 'node_id_required' };
    if (nodeIds.has(nodeId)) return { ok: false, error: 'duplicate_node_id', nodeId };
    if (!ALLOWED_NODE_KINDS.has(String(node.kind || ''))) return { ok: false, error: 'unsupported_node_kind', nodeId, nodeKind: node.kind };
    if (node.required !== true && node.required !== false) return { ok: false, error: 'node_required_flag_required', nodeId };
    nodeIds.add(nodeId);
  }

  const graph = new Map();
  for (const node of nodes) {
    const nodeId = String(node.id);
    const deps = normalizeStringArray(node.dependsOn);
    for (const depId of deps) {
      if (!nodeIds.has(depId)) return { ok: false, error: 'unknown_dependency', nodeId, dependency: depId };
    }
    graph.set(nodeId, deps);
  }
  const cycle = findDependencyCycle(graph, nodeIds);
  if (cycle) return { ok: false, error: 'dependency_cycle', nodeId: cycle };

  const budget = validateWorkflowBudget({ ...spec, phases: spec.phases }, policy);
  if (!budget.ok) return budget;

  const permission = validateNodePermissions(spec, nodes);
  if (!permission.ok) return permission;

  const capability = validateNodeCapabilities(nodes, capabilities);
  if (!capability.ok) return capability;

  return {
    ok: true,
    normalized: {
      nodeCount: nodes.length,
      nodeIds: nodes.map(node => String(node.id)),
      budget: budget.normalized,
      rubric: rubric.normalized,
    },
  };
}

export function validateWorkflowBudget(spec = {}, policy = null) {
  const nodes = flattenSpecNodes(spec);
  const budgets = spec.budgets || {};
  const limits = policy || {};
  const checks = [
    ['maxNodes', nodes.length, 'budget_max_nodes_exceeded'],
    ['maxParallelism', Number(budgets.maxParallelism || 0), 'budget_max_parallelism_exceeded'],
    ['maxAgents', Number(budgets.maxAgents || 0), 'budget_max_agents_exceeded'],
    ['maxMinutes', Number(budgets.maxMinutes || 0), 'budget_max_minutes_exceeded'],
    ['maxTokens', Number(budgets.maxTokens || 0), 'budget_max_tokens_exceeded'],
  ];
  for (const [key, actual, error] of checks) {
    const limit = Number(limits[key] || 0);
    if (limit > 0 && actual > limit) return { ok: false, error, limit, actual };
  }
  return {
    ok: true,
    normalized: {
      nodeCount: nodes.length,
      maxParallelism: Number(budgets.maxParallelism || 1),
      maxAgents: Number(budgets.maxAgents || 0),
      maxMinutes: Number(budgets.maxMinutes || 0),
      maxTokens: Number(budgets.maxTokens || 0),
    },
  };
}

export function validateAcceptanceRubric(rubric = {}, { workflowKind = 'generic' } = {}) {
  if (!rubric || typeof rubric !== 'object') return rubricClarification('acceptance_rubric_required');
  if (!rubric.id) return rubricClarification('rubric_id_required');
  if (!rubric.title) return rubricClarification('rubric_title_required');
  if (!ALLOWED_DISAGREEMENT_POLICIES.has(String(rubric.disagreementPolicy || ''))) {
    return rubricClarification('rubric_disagreement_policy_invalid');
  }

  const machineChecks = Array.isArray(rubric.machineChecks) ? rubric.machineChecks : [];
  const judgmentChecks = Array.isArray(rubric.judgmentChecks) ? rubric.judgmentChecks : [];
  const ids = new Set();
  for (const check of [...machineChecks, ...judgmentChecks]) {
    const id = String(check?.id || '');
    if (!id) return rubricClarification('rubric_check_id_required');
    if (ids.has(id)) return rubricClarification('rubric_duplicate_check_id', { checkId: id });
    ids.add(id);
  }

  const requiredMachineCheckIds = [];
  for (const check of machineChecks) {
    if (!ALLOWED_CHECK_KINDS.has(String(check.checkKind || ''))) {
      return rubricClarification('machine_check_kind_invalid', { checkId: check.id });
    }
    if (!Array.isArray(check.inputRefs) || check.inputRefs.length === 0) {
      return rubricClarification('machine_check_input_refs_required', { checkId: check.id });
    }
    if (check.required === true) requiredMachineCheckIds.push(String(check.id));
  }

  if (workflowKind === 'artifact' && requiredMachineCheckIds.length === 0) {
    return rubricClarification('required_machine_check_required');
  }

  const requiredJudgmentCheckIds = [];
  for (const check of judgmentChecks) {
    if (check.required === true) requiredJudgmentCheckIds.push(String(check.id));
    if (check.required === true && check.evidenceRequired !== true) {
      return rubricClarification('judgment_evidence_required', { checkId: check.id });
    }
    if (!Number.isFinite(Number(check.reviewerCount)) || Number(check.reviewerCount) < 1) {
      return rubricClarification('judgment_reviewer_count_invalid', { checkId: check.id });
    }
  }

  return {
    ok: true,
    normalized: {
      id: String(rubric.id),
      title: String(rubric.title),
      requiredMachineCheckIds,
      requiredJudgmentCheckIds,
      disagreementPolicy: String(rubric.disagreementPolicy),
    },
  };
}

export function validateWorkflowGateDecision(decision = {}) {
  if (!decision || typeof decision !== 'object') return { ok: false, error: 'gate_decision_required' };
  if (!ALLOWED_GATE_STATUSES.has(String(decision.status || ''))) return { ok: false, error: 'gate_decision_status_invalid' };
  if (typeof decision.reason !== 'string' || !decision.reason.trim()) return { ok: false, error: 'gate_decision_reason_required' };
  if (decision.evidenceRefs !== undefined && !Array.isArray(decision.evidenceRefs)) return { ok: false, error: 'gate_decision_evidence_refs_invalid' };
  return { ok: true, decision: sanitizeWorkflowGateDecision(decision) };
}

export function reduceWorkflowGate({ rubric, machineResults = [], judgmentResults = [] } = {}) {
  const validation = validateAcceptanceRubric(rubric, { workflowKind: 'artifact' });
  if (!validation.ok) return validation.decision;

  const machineById = new Map(machineResults.map(result => [String(result.id), result]));
  const failedMachineChecks = [];
  for (const checkId of validation.normalized.requiredMachineCheckIds) {
    const result = machineById.get(checkId);
    if (!result || result.status !== 'passed') {
      failedMachineChecks.push({ id: checkId, reason: result?.reason || 'required machine check failed' });
    }
  }
  if (failedMachineChecks.length > 0) {
    return {
      status: 'blocked',
      reason: `Required machine check failed: ${failedMachineChecks.map(item => item.id).join(', ')}`,
      evidenceRefs: [],
      failedMachineChecks,
    };
  }

  for (const check of rubric.judgmentChecks || []) {
    if (check.required !== true) continue;
    const results = judgmentResults.filter(result => result.id === check.id);
    const failed = results.filter(result => result.status !== 'passed');
    const missingEvidence = check.evidenceRequired === true && results.some(result => !Array.isArray(result.evidenceRefs) || result.evidenceRefs.length === 0);
    if (results.length < Number(check.reviewerCount || 1)) {
      return { status: 'blocked', reason: `Required judgment check incomplete: ${check.id}`, evidenceRefs: [] };
    }
    if (failed.length > 0 || missingEvidence) {
      const nextAction = rubric.disagreementPolicy === 'adversarial_review' ? 'adversarial_review' : rubric.disagreementPolicy === 'human_review' ? 'human_review' : 'block';
      return {
        status: nextAction === 'block' ? 'blocked' : 'needs_rework',
        reason: `Judgment check disagreement: ${check.id}`,
        evidenceRefs: collectEvidenceRefs(results),
        nextAction,
      };
    }
  }

  return { status: 'passed', reason: 'All required machine and judgment checks passed', evidenceRefs: collectEvidenceRefs(judgmentResults) };
}

export function sanitizeWorkflowNodeOutput(output) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return output;
  const sanitized = { ...output };
  const rejected = [];
  for (const key of NODE_MUTATION_KEYS) {
    if (Object.prototype.hasOwnProperty.call(sanitized, key)) {
      rejected.push(key);
      delete sanitized[key];
    }
  }
  if (rejected.length > 0) sanitized.rejectedMutations = rejected;
  return sanitized;
}

export function sanitizeWorkflowGateDecision(decision = {}) {
  const sanitized = {
    status: String(decision.status || ''),
    reason: String(decision.reason || ''),
    evidenceRefs: Array.isArray(decision.evidenceRefs) ? decision.evidenceRefs.filter(ref => typeof ref === 'string') : [],
  };
  const rejected = [];
  for (const key of DECISION_MUTATION_KEYS) {
    if (Object.prototype.hasOwnProperty.call(decision, key)) rejected.push(key);
  }
  if (rejected.length > 0) sanitized.rejectedMutations = rejected;
  if (decision.invalidationScope && typeof decision.invalidationScope === 'object') sanitized.invalidationScope = clonePlainValue(decision.invalidationScope);
  return sanitized;
}

function flattenSpecNodes(spec = {}) {
  const nodes = [];
  for (const phase of Array.isArray(spec.phases) ? spec.phases : []) {
    for (const node of Array.isArray(phase.nodes) ? phase.nodes : []) nodes.push(node);
  }
  return nodes;
}

function validateNodePermissions(spec, nodes) {
  const allowedCategories = new Set(normalizeStringArray(spec.permissions?.toolCategories));
  for (const node of nodes) {
    for (const category of normalizeStringArray(node.permissions?.toolCategories)) {
      if (!allowedCategories.has(category)) return { ok: false, error: 'permission_not_allowed', nodeId: String(node.id), permission: category };
    }
    if (node.permissions?.allowWrite === true && spec.permissions?.allowWrite !== true) return { ok: false, error: 'permission_not_allowed', nodeId: String(node.id), permission: 'write' };
    if (node.permissions?.allowShell === true && spec.permissions?.allowShell !== true) return { ok: false, error: 'permission_not_allowed', nodeId: String(node.id), permission: 'shell' };
    if (node.permissions?.allowNetwork === true && spec.permissions?.allowNetwork !== true) return { ok: false, error: 'permission_not_allowed', nodeId: String(node.id), permission: 'network' };
    if (node.permissions?.allowRenderer === true && spec.permissions?.allowRenderer !== true) return { ok: false, error: 'permission_not_allowed', nodeId: String(node.id), permission: 'renderer' };
  }
  return { ok: true };
}

function validateNodeCapabilities(nodes, capabilities) {
  const available = new Set(normalizeStringArray(capabilities));
  for (const node of nodes) {
    for (const capability of normalizeStringArray(node.agentSelector?.requiredCapabilities)) {
      if (!available.has(capability)) return { ok: false, error: 'missing_agent_capability', nodeId: String(node.id), capability };
    }
  }
  return { ok: true };
}

function findDependencyCycle(graph, nodeIds) {
  const visiting = new Set();
  const visited = new Set();
  function visit(nodeId) {
    if (visited.has(nodeId)) return null;
    if (visiting.has(nodeId)) return nodeId;
    visiting.add(nodeId);
    for (const depId of graph.get(nodeId) || []) {
      const cycle = visit(depId);
      if (cycle) return cycle;
    }
    visiting.delete(nodeId);
    visited.add(nodeId);
    return null;
  }
  for (const nodeId of nodeIds) {
    const cycle = visit(nodeId);
    if (cycle) return cycle;
  }
  return null;
}

function inferWorkflowKind(spec) {
  const kind = String(spec.outputContract?.kind || '').toLowerCase();
  if (['artifact', 'report', 'slide', 'document'].includes(kind)) return 'artifact';
  return 'generic';
}

function rubricClarification(error, extra = {}) {
  return {
    ok: false,
    error,
    ...extra,
    decision: {
      status: 'needs_rubric_clarification',
      reason: error,
      evidenceRefs: [],
    },
  };
}

function collectEvidenceRefs(results = []) {
  return Array.from(new Set(results.flatMap(result => Array.isArray(result.evidenceRefs) ? result.evidenceRefs : []).filter(ref => typeof ref === 'string')));
}

function normalizeStringArray(value) {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function clonePlainValue(value) {
  if (value === null || value === undefined) return value;
  return JSON.parse(JSON.stringify(value));
}
