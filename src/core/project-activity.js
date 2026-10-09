import { randomUUID } from 'node:crypto';

const MAX_EVENTS = 4096;
const MAX_SUMMARY = 512;
const MAX_PROGRESS = 256;
export const PROJECT_ACTIVITY_FIELDS = ['activityDataEpoch','activityEventSeq','activityEventOutbox','activitySnapshot','committedActivitySeq','activityLastProgressAt','activityGapRanges'];

export function assertProjectActivityAdmission(project) {
  if ((project?.activityEventOutbox ?? []).filter(event => event.kind !== 'progress').length >= MAX_EVENTS) {
    throw new Error('project_activity_capacity_exceeded');
  }
}

// Reviewed producer callgraph: task/artifact loops emit ordinary details;
// scoped calls emit at most one critical/project. FULL operations only alter
// metadata or pause/recover execution; legacy first observation is separate.
const FULL_ACTIVITY_MUTATIONS = new Set(['invalidateTeamPlansForAgent', 'handleSuspendActiveRuns', 'handleResumeSuspendedRuns', 'recoverInterruptedTaskWorkflows']);
const SCOPED_ACTIVITY_MUTATIONS = new Set(`serverProjectState applyWorkspaceMapping dispatchWorkspaceTask submitWorkspaceTaskResult recoverProjectDelivery createProject submitTaskResult setProjectTeamPlan attachTeamOperationMembers updateProjectExecutionMode handleApprove activateAndStartProject handleRetryPlan handleHumanAddTasks handleCloseProject deleteProject handleCreateTasks handleAssignTask handleReassignTask handleRequestDispatch handleMarkDone handleRework handleDeliver registerFinalDeliverable approveFinalDeliverable submitReviewConditionEvidence resolveReviewConditionEntry handleSubmitPlan handleRevisePlan handleQualityReview handleAcceptTask handleProgress handleWorkerFailure handleSubmitResult handleRecoverSubmission handleResetTaskForRecovery handleResumeTaskForRecovery handleTaskFail handleContinueProject handleResolveProjectIntervention createWorkflowProposal cancelWorkflowProposal createScriptWorkflowProposal startWorkflowRunFromProposal startScriptWorkflowRunFromProposal beginWorkflowScriptParallelGroup dispatchWorkflowScriptAgentNode retryWorkflowScriptAgentNode completeScriptWorkflowRun startProjectDiagnoseWorkflow startAgentReviewSmokeWorkflow handleWorkflowNodeResult handleWorkflowNodeReview handleWorkflowRuntimeUnavailable handleWorkflowProgressBatch cancelWorkflowRun`.split(' '));
export function activityMutationCriticalBudget(name) {
  if (FULL_ACTIVITY_MUTATIONS.has(name)) return 0;
  if (SCOPED_ACTIVITY_MUTATIONS.has(name)) return 1;
  throw new Error('unreviewed_project_activity_mutation');
}
export function assertProjectActivityBounds(project) {
  if (!project?.activityDataEpoch) return; // Uninitialized legacy feed.
  const head = project.activityEventSeq ?? 0;
  if (!Number.isSafeInteger(head) || head < 0) throw new Error('invalid_project_activity_epoch');
  let sequence = 0;
  const retained = [];
  for (const event of project.activityEventOutbox ?? []) {
    if (!Number.isSafeInteger(event.sourceSequence) || event.sourceSequence <= sequence || event.sourceSequence > head
      || event.sourceDataEpoch !== undefined && event.sourceDataEpoch !== project.activityDataEpoch) throw new Error('invalid_project_activity_epoch');
    retained.push(event.sourceSequence); sequence = event.sourceSequence;
  }
  let through = 0;
  for (const range of project.activityGapRanges ?? []) {
    if (!Number.isSafeInteger(range.from) || !Number.isSafeInteger(range.through) || range.from <= through || range.through < range.from
      || range.through > head || !['progress_compacted','retention_expired','mixed_retention_compaction'].includes(range.reason)
      || retained.some(seq => seq >= range.from && seq <= range.through)) throw new Error('invalid_project_activity_gap');
    through = range.through;
  }
}
export class ProjectActivityReservations {
  #held = new Map();
  reserve(projectId, project, budget) {
    const count = (project?.activityEventOutbox ?? []).filter(event => event.kind !== 'progress').length;
    if (!Number.isSafeInteger(budget) || budget < 0 || count + (this.#held.get(projectId) ?? 0) + budget > MAX_EVENTS) throw new Error('project_activity_capacity_exceeded');
    assertProjectActivityBounds(project);
    this.#held.set(projectId, (this.#held.get(projectId) ?? 0) + budget);
    let remaining = budget;
    const consume = count => {
      if (!Number.isSafeInteger(count) || count < 0 || count > remaining) throw new Error('unreviewed_project_activity_critical_batch');
      const total = (this.#held.get(projectId) ?? 0) - count;
      if (total) this.#held.set(projectId, total); else this.#held.delete(projectId);
      remaining -= count;
    };
    return { assertFits: count => { if (count > remaining) throw new Error('unreviewed_project_activity_critical_batch'); },
      consume, release: () => consume(remaining) };
  }
}

function recordRemoved(project, removed, reason) {
  if (!removed.length) return;
  const ranges = [...(project.activityGapRanges ?? []), ...removed.map(event => ({ from: event.sourceSequence, through: event.sourceSequence, reason }))]
    .sort((a, b) => a.from - b.from);
  const merged = [];
  for (const range of ranges) {
    const prior = merged.at(-1);
    if (prior && prior.through + 1 === range.from) {
      prior.through = range.through;
      if (prior.reason !== range.reason) prior.reason = 'mixed_retention_compaction';
    }
    else merged.push({ ...range });
  }
  // N retained facts imply at most N+1 maximal gaps. Preserve mixed deletion
  // provenance explicitly; this is not a logical quota after business writes.
  if (merged.length > MAX_EVENTS * 2 || merged.some(range => (project.activityEventOutbox ?? [])
    .some(event => event.sourceSequence >= range.from && event.sourceSequence <= range.through))) throw new Error('invalid_project_activity_gap');
  project.activityGapRanges = merged;
}

export function createProjectActivityCandidate(project, snapshot, observations) {
  const candidate = { ...project };
  for (const field of PROJECT_ACTIVITY_FIELDS) if (field in project) candidate[field] = structuredClone(project[field]);
  stageProjectActivity(candidate, snapshot, observations);
  return candidate;
}

export function projectActivitySnapshot(project, tasks) {
  return {
    id: project.id, name: project.name, status: project.status,
    projectRevision: project.projectRevision ?? 0,
    primaryRoomId: project.primaryRoomId ?? null,
    deliveredAt: project.deliveredAt ?? null,
    preparation: project.preparation?.state ?? null,
    mapping: project.workspaceMapping?.state ?? null,
    tasks: tasks.map(task => ({ id: task.id, status: task.status, attempt: task.attempt ?? 0 })),
  };
}

function kindFor(type, snapshot) {
  if (type === 'project.created') return 'accepted';
  if (type === 'project.delivered') return 'completed';
  if (type === 'project.closed') return snapshot.deliveredAt ? 'completed' : 'cancelled';
  if (/^state\.(?:observed|changed)$/.test(type)) {
    if (snapshot.status === 'delivered') return 'completed';
    if (snapshot.status === 'closed') return snapshot.deliveredAt ? 'completed' : 'cancelled';
  }
  if (/approval|review.required|needs_user/.test(type)) return 'input_required';
  if (/failed|blocked|intervention/.test(type)) return 'blocked';
  if (/artifact|delivered/.test(type)) return 'artifact_available';
  // A child finishing or a delivery being prepared does not close the project.
  return 'progress';
}

/** Staged on the same project object as business state, before its durable save. */
export function stageProjectActivity(project, snapshot, observations = []) {
  const previous = project.activitySnapshot;
  if (!previous && !observations.some(item => kindFor(item.type, snapshot) !== 'progress')) observations = [{ type: 'state.observed', payload: {} }, ...observations];
  if (!observations.length && JSON.stringify(previous) !== JSON.stringify(snapshot)) {
    const terminalChanged = !previous || previous.status !== snapshot.status || previous.deliveredAt !== snapshot.deliveredAt;
    observations = [{ type: terminalChanged ? 'state.changed' : 'state.progress', payload: {} }];
  }
  if (!observations.length) return;
  project.activityDataEpoch ??= randomUUID();
  project.activityEventSeq ??= 0;
  project.activityEventOutbox ??= [];
  const now = Date.now();
  // Ordinary progress is sampled before the source commit, never by replacing
  // an already durable event under the same identity. The snapshot stays current.
  let progressAccepted = false;
  observations = observations.filter(item => {
    if (kindFor(item.type, snapshot) !== 'progress' || !/(?:^|[._])(?:progress|heartbeat)$/.test(item.type)) return true;
    if (item.type === 'task.progress' && item.payload.stage === 'started') return true;
    if (progressAccepted || now - (project.activityLastProgressAt ?? -Infinity) < 1000) return false;
    progressAccepted = true; return true;
  });
  if (!observations.length) { project.activitySnapshot = structuredClone(snapshot); return; }
  const expired = project.activityEventOutbox.filter(event => !['input_required','blocked','failed'].includes(event.kind)
    && now - event.occurredAt > (event.kind === 'progress' ? 7 : 90) * 86400_000);
  const expiredIds = new Set(expired.map(event => event.eventId));
  project.activityEventOutbox = project.activityEventOutbox.filter(event => !expiredIds.has(event.eventId));
  recordRemoved(project, expired, 'retention_expired');
  for (const { type, payload } of observations) {
    if (kindFor(type, snapshot) === 'progress') {
      const progress = project.activityEventOutbox.filter(event => event.kind === 'progress');
      const removed = progress.slice(0, Math.max(0, progress.length - MAX_PROGRESS + 1));
      const ids = new Set(removed.map(event => event.eventId));
      project.activityEventOutbox = project.activityEventOutbox.filter(event => !ids.has(event.eventId));
      recordRemoved(project, removed, 'progress_compacted');
    }
    if (project.activityEventOutbox.length >= MAX_EVENTS) {
      const ordinary = project.activityEventOutbox.find(event => event.kind === 'progress');
      if (ordinary) {
        project.activityEventOutbox = project.activityEventOutbox.filter(event => event.eventId !== ordinary.eventId);
        recordRemoved(project, [ordinary], 'progress_compacted');
      }
    }
    // At a full critical boundary an ordinary detail is optional. Do not
    // allocate a sequence, reject an already accepted critical fact, or latch
    // a dirty business state just because its trailing progress cannot fit.
    if (project.activityEventOutbox.length >= MAX_EVENTS && kindFor(type, snapshot) === 'progress') continue;
    if (project.activityEventOutbox.length >= MAX_EVENTS) throw new Error('project_activity_capacity_exceeded');
    const sequence = ++project.activityEventSeq;
    const summary = [payload.stage, payload.summary, payload.reason, payload.message]
      .find(value => typeof value === 'string')?.slice(0, MAX_SUMMARY);
    project.activityEventOutbox.push({
      schemaVersion: 1, eventId: `${project.id}#${sequence}`,
      source: 'kswarm', workId: project.id, sourceSequence: sequence,
      sourceDataEpoch: project.activityDataEpoch, sourceRevision: String(sequence),
      kind: kindFor(type, snapshot), occurredAt: now,
      sourceType: type, evidenceRefs: typeof payload.finalDeliverableId === 'string' ? [payload.finalDeliverableId] : [],
      ...(summary ? { summary } : {}),
      ...(typeof payload.taskId === 'string' ? { taskId: payload.taskId } : {}),
      ...(type === 'task.progress' && snapshot.tasks?.some(task => task.id === payload.taskId && task.status === 'in_progress') ? { executionStarted: true } : {}),
    });
  }
  if (progressAccepted) project.activityLastProgressAt = now;
  project.activitySnapshot = structuredClone(snapshot);
  project.committedActivitySeq = project.activityEventSeq;
}

/** The view supplied here must be the last successful durable commit. */
export function readProjectActivity(committed, { after = 0, limit = 100 } = {}) {
  if (!Number.isSafeInteger(after) || after < 0) throw new Error('invalid_activity_cursor');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('invalid_activity_limit');
  if (!committed) return { ok: false, code: 'project_activity_unavailable' };
  const outbox = committed.activityEventOutbox ?? [];
  const head = committed.committedActivitySeq ?? 0;
  const retainedFromSeq = outbox[0]?.sourceSequence ?? head + 1;
  const events = outbox.filter(event => event.sourceSequence > after && event.sourceSequence <= head).slice(0, limit);
  const coveredThrough = events.length === limit ? events.at(-1).sourceSequence : head;
  const gapRanges = (committed.activityGapRanges ?? []).filter(range => range.through > after && range.from <= coveredThrough)
    .map(range => ({ ...range, from: Math.max(range.from, after + 1), through: Math.min(range.through, coveredThrough) }));
  const gap = after < retainedFromSeq - 1 || after > head || gapRanges.length > 0;
  return structuredClone({ ok: true, sourceDataEpoch: committed.activityDataEpoch,
    retainedFromSeq, headSeq: head, gap, gapRanges, coveredThrough, nextCursor: coveredThrough,
    snapshotRevision: String(head), snapshot: committed.activitySnapshot, events });
}
