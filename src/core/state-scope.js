/**
 * state-scope — shared helpers for durable entity persistence.
 *
 *  - sha256Hex: canonical checksum for a serialized entity value.
 *  - decomposeState / composeEntities: convert between the legacy full Hub state
 *    object and a flat entity list ({ collection, key, projectId, value }).
 *  - resolveMutationScope: map a Hub mutation (name + args) to the set of projects
 *    it affects, so SQLite only re-syncs the impacted entities. Unknown mutations
 *    default to FULL scope (never silently skip persistence).
 */

import { createHash, randomUUID } from 'node:crypto';

// Collections whose keys participate in scoped delete-detection. humanAction is
// intentionally excluded: it is append-only and never rewritten/deleted in P0.
export const DELETABLE_COLLECTIONS = Object.freeze([
  'project',
  'board',
  'workflowRun',
  'workflowProposal',
  'finalDeliverable',
  'reviewGateDecision',
  'reviewCondition',
]);

export const ALL_COLLECTIONS = Object.freeze([...DELETABLE_COLLECTIONS, 'humanAction']);

export const FULL_SCOPE = Object.freeze({ type: 'full' });

export function projectScope(projectId) {
  return projectId ? { type: 'project', projectId } : FULL_SCOPE;
}

export function sha256Hex(str) {
  return createHash('sha256').update(str, 'utf8').digest('hex');
}

/** Stable serialization of an entity value used for checksum + storage. */
export function serializeValue(value) {
  return JSON.stringify(value);
}

/**
 * Decompose the legacy full Hub state object into a flat entity list.
 * humanActions receive a stable id + monotonic seq if missing (used by migration).
 */
export function decomposeState(state) {
  const entities = [];
  if (!state || typeof state !== 'object') return entities;

  for (const p of state.projects || []) {
    if (!p || !p.id) continue;
    entities.push({ collection: 'project', key: p.id, projectId: p.id, value: p });
  }
  for (const b of state.boards || []) {
    if (!b || !b.projectId) continue;
    entities.push({ collection: 'board', key: b.projectId, projectId: b.projectId, value: b });
  }
  for (const r of state.workflowRuns || []) {
    if (!r || !r.id) continue;
    entities.push({ collection: 'workflowRun', key: r.id, projectId: r.projectId ?? null, value: r });
  }
  for (const pr of state.workflowProposals || []) {
    if (!pr || !pr.id) continue;
    entities.push({ collection: 'workflowProposal', key: pr.id, projectId: pr.projectId ?? null, value: pr });
  }
  for (const d of state.finalDeliverables || []) {
    if (!d || !d.deliverableId) continue;
    entities.push({ collection: 'finalDeliverable', key: d.deliverableId, projectId: d.projectId ?? null, value: d });
  }
  for (const g of state.reviewGateDecisions || []) {
    if (!g || !g.gateId) continue;
    entities.push({ collection: 'reviewGateDecision', key: g.gateId, projectId: g.projectId ?? null, value: g });
  }
  for (const c of state.reviewConditions || []) {
    if (!c || !c.conditionId) continue;
    entities.push({ collection: 'reviewCondition', key: c.conditionId, projectId: c.projectId ?? null, value: c });
  }
  let seq = 0;
  for (const a of state.humanActions || []) {
    if (!a || typeof a !== 'object') continue;
    const value = { ...a };
    if (!value.id) value.id = randomUUID();
    if (typeof value.seq !== 'number') value.seq = seq;
    seq += 1;
    entities.push({ collection: 'humanAction', key: value.id, projectId: value.projectId ?? null, value });
  }
  return entities;
}

/** Compose a flat entity list back into the legacy full Hub state object. */
export function composeEntities(entities) {
  const state = {
    projects: [],
    boards: [],
    workflowRuns: [],
    workflowProposals: [],
    finalDeliverables: [],
    reviewGateDecisions: [],
    reviewConditions: [],
    humanActions: [],
  };
  for (const e of entities || []) {
    switch (e.collection) {
      case 'project': state.projects.push(e.value); break;
      case 'board': state.boards.push(e.value); break;
      case 'workflowRun': state.workflowRuns.push(e.value); break;
      case 'workflowProposal': state.workflowProposals.push(e.value); break;
      case 'finalDeliverable': state.finalDeliverables.push(e.value); break;
      case 'reviewGateDecision': state.reviewGateDecisions.push(e.value); break;
      case 'reviewCondition': state.reviewConditions.push(e.value); break;
      case 'humanAction': state.humanActions.push(e.value); break;
      default: break;
    }
  }
  state.humanActions.sort((a, b) => {
    const sa = typeof a.seq === 'number' ? a.seq : 0;
    const sb = typeof b.seq === 'number' ? b.seq : 0;
    if (sa !== sb) return sa - sb;
    return String(a.ts || '').localeCompare(String(b.ts || ''));
  });
  return state;
}

// ── Mutation -> scope mapping ──────────────────────────────────────────────
// lookups: { getProposalProjectId(id), getRunProjectId(id) }

function firstArgProjectId(args) {
  const a = args[0];
  if (typeof a === 'string') return a;
  if (a && typeof a === 'object' && typeof a.id === 'string') return a.id; // createProject({ id })
  return null;
}

const PROJECT_FIRST_ARG = new Set([
  'createProject',
  'setProjectTeamPlan',
  'attachTeamOperationMembers',
  'updateProjectExecutionMode',
  'handleApprove',
  'activateAndStartProject',
  'handleRetryPlan',
  'handleHumanAddTasks',
  'handleCloseProject',
  'deleteProject',
  'handleCreateTasks',
  'handleAssignTask',
  'handleReassignTask',
  'handleRequestDispatch',
  'handleMarkDone',
  'handleRework',
  'handleTaskFail',
  'handleContinueProject',
  'handleResolveProjectIntervention',
  'handleDeliver',
  'registerFinalDeliverable',
  'approveFinalDeliverable',
  'submitReviewConditionEvidence',
  'resolveReviewConditionEntry',
  'handleAcceptTask',
  'handleProgress',
  'handleWorkerFailure',
  'handleSubmitResult',
  'handleRecoverSubmission',
  'handleResetTaskForRecovery',
  'handleResumeTaskForRecovery',
  'handleSubmitPlan',
  'handleRevisePlan',
  'handleQualityReview',
  'createWorkflowProposal',
  'createScriptWorkflowProposal',
  'startProjectDiagnoseWorkflow',
  'startAgentReviewSmokeWorkflow',
]);

const PROPOSAL_KEYED = new Set([
  'cancelWorkflowProposal',
  'startWorkflowRunFromProposal',
  'startScriptWorkflowRunFromProposal',
]);

const RUN_KEYED_FIRST_ARG = new Set([
  'beginWorkflowScriptParallelGroup',
  'dispatchWorkflowScriptAgentNode',
  'retryWorkflowScriptAgentNode',
  'completeScriptWorkflowRun',
  'cancelWorkflowRun',
  'handleWorkflowProgressBatch',
]);

const RUN_KEYED_OBJECT_ARG = new Set([
  'handleWorkflowNodeResult',
  'handleWorkflowNodeReview',
  'handleWorkflowRuntimeUnavailable',
]);

const GLOBAL_MUTATIONS = new Set([
  'handleSuspendActiveRuns',
  'handleResumeSuspendedRuns',
  'recoverInterruptedTaskWorkflows',
]);

export function resolveMutationScope(name, args = [], lookups = {}) {
  if (name === 'invalidateTeamPlansForAgent') return FULL_SCOPE;
  if (GLOBAL_MUTATIONS.has(name)) return FULL_SCOPE;
  if (PROJECT_FIRST_ARG.has(name)) return projectScope(firstArgProjectId(args));
  if (PROPOSAL_KEYED.has(name)) {
    const pid = lookups.getProposalProjectId?.(args[0]);
    return projectScope(pid);
  }
  if (RUN_KEYED_FIRST_ARG.has(name)) {
    const pid = lookups.getRunProjectId?.(args[0]);
    return projectScope(pid);
  }
  if (RUN_KEYED_OBJECT_ARG.has(name)) {
    const pid = lookups.getRunProjectId?.(args[0]?.workflowRunId);
    return projectScope(pid);
  }
  // Unknown mutation -> full scope, never silently skip.
  return FULL_SCOPE;
}
