const ALLOWED_PROGRESS_EVENT_TYPES = new Set([
  'workflow.started',
  'workflow.phase.started',
  'workflow.node.queued',
  'workflow.node.started',
  'workflow.node.progress',
  'workflow.agent.heartbeat',
  'workflow.node.completed',
  'workflow.node.failed',
  'workflow.node.cancelled',
  'workflow.budget.updated',
  'workflow.review.completed',
  'workflow.completed',
]);

const MATERIAL_PROGRESS_TYPES = new Set([
  'workflow.started',
  'workflow.phase.started',
  'workflow.node.queued',
  'workflow.node.started',
  'workflow.node.progress',
  'workflow.node.completed',
  'workflow.node.failed',
  'workflow.node.cancelled',
  'workflow.budget.updated',
  'workflow.review.completed',
  'workflow.completed',
]);

export function validateWorkflowProgressBatch(batch = {}) {
  if (!batch || typeof batch !== 'object') return { ok: false, error: 'workflow_progress_batch_required' };
  if (batch.kind !== 'workflow.progress_batch') return { ok: false, error: 'workflow_progress_kind_invalid' };
  for (const field of ['workflowRunId', 'projectId', 'fromParticipantId']) {
    if (!batch[field]) return { ok: false, error: `workflow_progress_${field}_required` };
  }
  if (!Number.isFinite(Number(batch.sequence))) return { ok: false, error: 'workflow_progress_sequence_required' };
  if (!Array.isArray(batch.events)) return { ok: false, error: 'workflow_progress_events_required' };

  for (const event of batch.events) {
    if (!ALLOWED_PROGRESS_EVENT_TYPES.has(String(event?.type || ''))) {
      return { ok: false, error: 'workflow_progress_event_type_invalid', eventType: event?.type };
    }
    if (event.type !== 'workflow.started' && event.type !== 'workflow.completed' && !event.nodeId && event.type.includes('.node.')) {
      return { ok: false, error: 'workflow_progress_event_node_id_required', eventType: event.type };
    }
    if (event.type === 'workflow.agent.heartbeat' && !event.nodeId) {
      return { ok: false, error: 'workflow_progress_event_node_id_required', eventType: event.type };
    }
  }
  return { ok: true };
}

export function applyWorkflowProgressBatch(snapshot = {}, batch = {}) {
  const validation = validateWorkflowProgressBatch(batch);
  if (!validation.ok) return validation;
  if (snapshot.workflowRunId && snapshot.workflowRunId !== batch.workflowRunId) {
    return { ok: false, error: 'workflow_progress_run_mismatch' };
  }

  const participantId = String(batch.fromParticipantId);
  const sequence = Number(batch.sequence);
  const progressState = clonePlainValue(snapshot.progressState || {
    lastSequenceByParticipant: {},
    lastMaterialProgress: {},
  });
  const previous = Number(progressState.lastSequenceByParticipant?.[participantId] || 0);
  if (sequence < previous) return { ok: false, error: 'workflow_progress_sequence_stale', previous, sequence };
  if (sequence === previous) return { ok: true, duplicate: true, snapshot };

  const nodes = (snapshot.nodes || []).map(node => ({
    ...node,
    runtime: node.runtime ? { ...node.runtime } : null,
    output: clonePlainValue(node.output),
  }));

  let lastMaterialProgress = progressState.lastMaterialProgress || {};
  for (const event of batch.events) {
    const node = event.nodeId ? nodes.find(item => item.id === event.nodeId) : null;
    if (node && (event.type === 'workflow.agent.heartbeat' || event.type === 'workflow.node.progress')) {
      node.runtime = {
        ...(node.runtime || {}),
        lastProgressAt: Number(event.at || batch.emittedAt || Date.now()),
      };
    }
    if (MATERIAL_PROGRESS_TYPES.has(event.type) && event.type !== 'workflow.agent.heartbeat') {
      lastMaterialProgress = {
        type: event.type,
        nodeId: event.nodeId || null,
        message: typeof event.message === 'string' ? event.message : undefined,
        at: Number(event.at || batch.emittedAt || Date.now()),
      };
    }
  }

  progressState.lastSequenceByParticipant = {
    ...(progressState.lastSequenceByParticipant || {}),
    [participantId]: sequence,
  };
  progressState.lastMaterialProgress = lastMaterialProgress;

  return {
    ok: true,
    snapshot: {
      ...snapshot,
      nodes,
      progressState,
    },
  };
}

function clonePlainValue(value) {
  if (value === null || value === undefined) return value;
  return JSON.parse(JSON.stringify(value));
}
