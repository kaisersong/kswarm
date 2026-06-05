/**
 * Restart recovery planner.
 *
 * Pure decision layer: it reads project/task/journal facts and returns actions.
 * It does not mutate boards, send broker messages, or touch the filesystem.
 */

const ACTIVE_RUN_STATUSES = new Set(['dispatched', 'accepted', 'in_progress']);
const DURABLE_ARTIFACT_STATUSES = new Set(['artifact_written', 'submitting', 'submitted']);

function journalKey(taskId, runId) {
  return `${taskId}::${runId}`;
}

function indexJournals(journals = []) {
  const byTaskRun = new Map();
  for (const journal of journals) {
    if (!journal || journal.schemaVersion !== 1) continue;
    if (!journal.taskId || !journal.runId) continue;
    byTaskRun.set(journalKey(journal.taskId, journal.runId), journal);
  }
  return byTaskRun;
}

function isLeaseExpired(task, now, leaseTimeoutMs) {
  const lease = task.runLease || {};
  const tolerance = lease.leaseTimeoutMs || leaseTimeoutMs;
  const lastSeen = lease.lastHeartbeatAt || task.updatedAt || task.createdAt || null;
  if (typeof lastSeen === 'number') return now - lastSeen >= tolerance;
  if (typeof lease.leaseExpiresAt === 'number') return now >= lease.leaseExpiresAt;
  return true;
}

function durableArtifactsFromJournal(journal) {
  if (!journal || !DURABLE_ARTIFACT_STATUSES.has(journal.status)) return [];
  const artifacts = Array.isArray(journal.artifactManifest) ? journal.artifactManifest : [];
  return artifacts.filter(artifact => artifact && artifact.filename);
}

export function planProjectRecovery({
  project,
  tasks = [],
  journals = [],
  onlineAgents = new Set(),
  now = Date.now(),
  leaseTimeoutMs = 600_000,
} = {}) {
  const actions = [];
  const diagnostics = [];

  if (!project || project.status !== 'active') return { actions, diagnostics };

  const journalByRun = indexJournals(journals);

  for (const task of tasks) {
    if (!task) continue;
    if (task.status === 'done' || task.status === 'cancelled') continue;
    if (isWorkflowOwnedTask(task)) continue;

    const runId = task.activeRunId || task.runLease?.runId || null;
    const journal = runId ? journalByRun.get(journalKey(task.id, runId)) : null;
    const durableArtifacts = durableArtifactsFromJournal(journal);

    if ((ACTIVE_RUN_STATUSES.has(task.status) || task.status === 'failed') && runId && durableArtifacts.length > 0) {
      actions.push({
        type: 'recover_submission',
        projectId: project.id,
        taskId: task.id,
        runId,
        agentId: journal.agentId || task.assignedAgent || null,
        artifacts: durableArtifacts,
        reason: 'journal_artifact_written',
      });
      continue;
    }

    if (ACTIVE_RUN_STATUSES.has(task.status)) {
      const agentId = task.assignedAgent || task.runLease?.assignedAgent || null;
      const runtimeInstance = task.assignedRuntimeInstance || task.runLease?.assignedRuntimeInstance || null;
      const expired = isLeaseExpired(task, now, leaseTimeoutMs);
      const liveOnline = (runtimeInstance && onlineAgents.has(runtimeInstance)) || (agentId && onlineAgents.has(agentId));
      if (task.suspendedAt) {
        actions.push({
          type: 'resume_task',
          projectId: project.id,
          taskId: task.id,
          runId,
          agentId,
          reason: 'resume_after_suspend',
        });
      } else if (!expired && liveOnline) {
        actions.push({
          type: 'resume_task',
          projectId: project.id,
          taskId: task.id,
          runId,
          agentId,
          reason: 'lease_unexpired_agent_online',
        });
      } else if (!expired && !liveOnline) {
        actions.push({
          type: 'defer_recovery',
          projectId: project.id,
          taskId: task.id,
          runId,
          agentId,
          reason: 'agent_not_yet_online',
        });
      } else {
        actions.push({
          type: 'reset_pending',
          projectId: project.id,
          taskId: task.id,
          runId,
          agentId,
          reason: 'lease_expired',
        });
      }
      continue;
    }

    if (task.status === 'submitted' && task.result && !hasCurrentReviewResult(task)) {
      actions.push({
        type: 'notify_po_review',
        projectId: project.id,
        taskId: task.id,
        poAgent: project.poAgent,
        agentId: task.result.participantId || task.assignedAgent || null,
        result: task.result,
        reason: 'submitted_without_review',
      });
    }
  }

  return { actions, diagnostics };
}

function hasCurrentReviewResult(task = {}) {
  if (!task.reviewResult) return false;
  if (task.reviewResult.passed === false) {
    const reviewedAt = Number(task.reviewResult.reviewedAt || 0);
    const submittedAt = Number(task.updatedAt || task.recoveredAt || 0);
    if (submittedAt && (!reviewedAt || reviewedAt < submittedAt)) return false;
  }
  return true;
}

function isWorkflowOwnedTask(task) {
  if (!task || typeof task !== 'object') return false;
  if (task.assignedExecutor === 'workflow') return true;
  if (task.execution?.strategy === 'workflow') return true;
  const runId = task.activeRunId || task.runLease?.runId || '';
  return typeof runId === 'string' && runId.startsWith('workflow-');
}
