const START_POLICIES = new Set([
  'plan_only',
  'auto_activate_after_plan',
  'activate_and_dispatch_after_plan',
]);

export function decideProjectStartPolicy({
  requestedStartPolicy = 'auto_activate_after_plan',
  requestContext = null,
  project = null,
  tasks = [],
  workflowRuns = [],
  agentProfiles = [],
  callerRiskHints = undefined,
} = {}) {
  const requested = START_POLICIES.has(requestedStartPolicy)
    ? requestedStartPolicy
    : 'auto_activate_after_plan';
  const source = requestContext?.requestSource || 'agent';
  const serviceComputedRisk = computeStartRisk({ project, tasks, workflowRuns, agentProfiles });
  let effective = requested;
  const downgradeReasons = [];

  if (source === 'scheduler' && requested === 'activate_and_dispatch_after_plan') {
    effective = 'auto_activate_after_plan';
    downgradeReasons.push('scheduler_cannot_dispatch_after_plan');
  } else if (source === 'agent' && requested === 'activate_and_dispatch_after_plan' && !isLowRisk(serviceComputedRisk)) {
    effective = 'auto_activate_after_plan';
    downgradeReasons.push(...riskDowngradeReasons(serviceComputedRisk));
  }

  return {
    requestedStartPolicy: requested,
    effectiveStartPolicy: effective,
    requestContext,
    serviceComputedRisk,
    ...(callerRiskHints !== undefined ? { callerRiskHints } : {}),
    downgraded: effective !== requested,
    downgradeReasons: [...new Set(downgradeReasons)],
  };
}

export function computeStartRisk({ project = null, tasks = [], workflowRuns = [], agentProfiles = [] } = {}) {
  const normalizedTasks = Array.isArray(tasks) ? tasks : [];
  const normalizedWorkflowRuns = Array.isArray(workflowRuns) ? workflowRuns : [];
  const profiles = normalizeProfiles(agentProfiles);
  const workflowNodeCount = normalizedWorkflowRuns.reduce((sum, run) => sum + (Array.isArray(run?.nodes) ? run.nodes.length : 0), 0);
  const assignedAgents = normalizedTasks.map(task => task.assignedAgent).filter(Boolean);
  const knownAgents = new Set(profiles.map(profile => profile.id).filter(Boolean));
  const hasUnknownProfiles = profiles.length === 0 && assignedAgents.length > 0;
  const hasAmbiguousAgents = hasUnknownProfiles || assignedAgents.some(agentId => knownAgents.size > 0 && !knownAgents.has(agentId));
  const hasMissingRuntimeInstances = normalizedTasks.some(task => task.assignedAgent && !task.assignedRuntimeInstance);
  const expectedArtifactFormats = [...new Set(normalizedTasks.flatMap(task => inferTaskFormats(task)))];
  const hasKnownExternalWrite = normalizedTasks.some(task => task.requiresExternalSideEffect === true || task.writesUserFactSource === true);
  const unknownSideEffects = normalizedTasks.some(task => task.requiresExternalSideEffect === undefined || task.writesUserFactSource === undefined);
  const usesProjectScopedWorkflow = project?.executionMode === 'workflow_preferred' || normalizedWorkflowRuns.some(run => run?.scope?.projectId === project?.id && !run?.scope?.taskId);

  return {
    nodeCount: normalizedTasks.length,
    workflowNodeCount,
    expectedRuntimeMinutes: undefined,
    expectedArtifactFormats,
    requiresExternalSideEffect: hasKnownExternalWrite || unknownSideEffects,
    writesUserFactSource: hasKnownExternalWrite || unknownSideEffects,
    usesProjectScopedWorkflow,
    hasUnboundWorkflowNodes: workflowNodeCount > 0 && normalizedWorkflowRuns.some(run => !Array.isArray(run?.bindings) || run.bindings.length === 0),
    hasAmbiguousAgents,
    hasMissingRuntimeInstances,
    estimatedCostClass: estimateCostClass(normalizedTasks, workflowNodeCount, hasUnknownProfiles),
  };
}

function isLowRisk(risk) {
  return (
    risk.nodeCount <= 4 &&
    (risk.workflowNodeCount === 0 || risk.usesProjectScopedWorkflow === false) &&
    risk.requiresExternalSideEffect === false &&
    risk.writesUserFactSource === false &&
    risk.hasUnboundWorkflowNodes === false &&
    risk.hasAmbiguousAgents === false &&
    risk.estimatedCostClass !== 'high' &&
    risk.estimatedCostClass !== 'unknown'
  );
}

function riskDowngradeReasons(risk) {
  const reasons = [];
  if (risk.nodeCount > 4) reasons.push('node_count_high');
  if (risk.workflowNodeCount > 0 && risk.usesProjectScopedWorkflow) reasons.push('project_workflow_requires_confirmation');
  if (risk.requiresExternalSideEffect) reasons.push('external_side_effect_unknown_or_required');
  if (risk.writesUserFactSource) reasons.push('writes_user_fact_source_unknown_or_required');
  if (risk.hasUnboundWorkflowNodes) reasons.push('unbound_workflow_nodes');
  if (risk.hasAmbiguousAgents) reasons.push('ambiguous_agents');
  if (risk.hasMissingRuntimeInstances) reasons.push('missing_runtime_instances');
  if (risk.estimatedCostClass === 'unknown') reasons.push('estimated_cost_unknown');
  if (risk.estimatedCostClass === 'high') reasons.push('estimated_cost_high');
  return reasons.length > 0 ? reasons : ['risk_not_low'];
}

function normalizeProfiles(agentProfiles) {
  if (agentProfiles instanceof Map) return [...agentProfiles.values()];
  if (Array.isArray(agentProfiles)) return agentProfiles;
  if (agentProfiles && typeof agentProfiles === 'object') return Object.values(agentProfiles);
  return [];
}

function inferTaskFormats(task) {
  const outputs = Array.isArray(task?.requiredOutputs) ? task.requiredOutputs : [];
  return outputs.map(output => {
    if (typeof output === 'string') return output;
    return output?.type || output?.format || null;
  }).filter(Boolean);
}

function estimateCostClass(tasks, workflowNodeCount, unknownProfiles) {
  if (unknownProfiles) return 'unknown';
  if (tasks.length === 0 && workflowNodeCount === 0) return 'low';
  if (tasks.length > 8 || workflowNodeCount > 8) return 'high';
  if (tasks.length > 4 || workflowNodeCount > 4) return 'medium';
  return 'low';
}
