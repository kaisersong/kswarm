import { createHash } from 'node:crypto';
import { basename, extname, isAbsolute } from 'node:path';
import { deriveProjectIntervention } from './project-intervention.js';

const PREVIEWABLE_EXTENSIONS = new Set(['.md', '.txt', '.html', '.htm', '.json', '.csv']);
const MIME_TYPES = {
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.json': 'application/json',
  '.csv': 'text/csv',
};

export function resolveProjectIntervention({
  project,
  board,
  agents = [],
  request = {},
  recoverSubmission,
  writeArtifact,
  sendReviewSubmission,
  emitEvent,
  now = Date.now(),
} = {}) {
  if (!project || !board) return notAdvanced({ ok: false, error: 'project_not_found' });

  const idempotencyKey = String(request.idempotencyKey || '').trim();
  if (!idempotencyKey) {
    return notAdvanced({ ok: false, error: 'idempotency_key_required', status: 400 });
  }

  const requestHash = fingerprintRequest(request);
  project.interventionResolveIdempotency = project.interventionResolveIdempotency && typeof project.interventionResolveIdempotency === 'object'
    ? project.interventionResolveIdempotency
    : {};
  const previous = project.interventionResolveIdempotency[idempotencyKey];
  if (previous) {
    if (previous.requestHash !== requestHash) {
      return notAdvanced({
        ok: false,
        error: 'idempotency_conflict',
        status: 409,
      });
    }
    return { ...previous.result, idempotent: true };
  }

  const resolution = String(request.resolution || '').trim();
  if (resolution !== 'repair_and_submit') {
    return remember(project, idempotencyKey, requestHash, notAdvanced({
      ok: false,
      error: 'unsupported_resolution',
      status: 400,
      resolution,
    }));
  }

  const intervention = deriveProjectIntervention({
    project,
    tasks: board.getAllTasks(),
    agents,
    now,
  });
  if (!intervention?.required) {
    return remember(project, idempotencyKey, requestHash, notAdvanced({
      ok: false,
      error: 'no_intervention_required',
      intervention,
    }));
  }

  const task = board.getTask(request.expectedPrimaryTaskId || intervention.primaryTaskId);
  if (!task) {
    return remember(project, idempotencyKey, requestHash, notAdvanced({
      ok: false,
      error: 'task_not_found',
      status: 404,
      intervention,
    }));
  }

  const stale = validateExpectedState(task, request, intervention);
  if (!stale.ok) {
    return remember(project, idempotencyKey, requestHash, notAdvanced(stale));
  }

  const artifacts = Array.isArray(request.artifacts) ? request.artifacts : [];
  if (artifacts.length === 0) {
    return remember(project, idempotencyKey, requestHash, notAdvanced({
      ok: false,
      error: 'artifacts_required',
      status: 400,
      intervention,
    }));
  }

  const validatedArtifacts = [];
  for (const artifact of artifacts) {
    const validation = validateRepairArtifact(artifact);
    if (!validation.ok) {
      return remember(project, idempotencyKey, requestHash, notAdvanced({
        ...validation,
        intervention,
      }));
    }
    validatedArtifacts.push(validation.artifact);
  }

  if (!['cancelled', 'failed', 'in_progress', 'accepted', 'dispatched', 'blocked'].includes(task.status)) {
    return remember(project, idempotencyKey, requestHash, notAdvanced({
      ok: false,
      error: `cannot_repair_from_status: ${task.status}`,
      status: 409,
      intervention,
    }));
  }

  if (typeof writeArtifact !== 'function') {
    return remember(project, idempotencyKey, requestHash, notAdvanced({
      ok: false,
      error: 'write_artifact_unavailable',
      status: 500,
      intervention,
    }));
  }

  const submittedArtifacts = [];
  for (const artifact of validatedArtifacts) {
    let written;
    try {
      written = writeArtifact(artifact);
    } catch (err) {
      return remember(project, idempotencyKey, requestHash, notAdvanced({
        ok: false,
        error: 'artifact_write_failed',
        status: 500,
        message: String(err?.message || err),
        intervention,
      }));
    }
    if (written?.ok === false) {
      return remember(project, idempotencyKey, requestHash, notAdvanced({
        ok: false,
        error: written.error || 'artifact_write_failed',
        status: written.status || 500,
        intervention,
      }));
    }
    submittedArtifacts.push(buildSubmittedArtifact(project.id, artifact, written));
  }

  const fromAgent = String(request.fromAgent || 'human').trim() || 'human';
  const resultPayload = {
    summary: buildRepairSummary({ requestedSummary: request.summary, task, artifacts: submittedArtifacts }),
    participantId: fromAgent,
    artifacts: submittedArtifacts,
    ...(project.workFolder ? { workFolder: project.workFolder, workspacePath: project.workFolder } : {}),
    recovered: true,
  };

  const recovered = recoverSubmission
    ? recoverSubmission(task.id, resultPayload, fromAgent, {
        recoveryReason: 'intervention_repair_and_submit',
        idempotencyKey,
      })
    : { ok: false, error: 'recover_submission_unavailable' };
  if (!recovered.ok) {
    return remember(project, idempotencyKey, requestHash, notAdvanced({
      ...recovered,
      intervention,
    }));
  }

  let reviewNotification = 'not_available';
  let reviewNotificationError = null;
  if (typeof sendReviewSubmission === 'function') {
    try {
      sendReviewSubmission({
        taskId: recovered.taskId || task.id,
        payload: {
          projectId: project.id,
          taskId: recovered.taskId || task.id,
          fromWorker: fromAgent,
          result: resultPayload,
        },
      });
      reviewNotification = 'sent';
    } catch (err) {
      reviewNotification = 'failed';
      reviewNotificationError = String(err?.message || err);
    }
  }

  emitEvent?.('project.intervention_resolved', {
    projectId: project.id,
    taskId: recovered.taskId || task.id,
    resolution,
    reviewNotification,
  });

  return remember(project, idempotencyKey, requestHash, {
    ok: true,
    action: 'resolve_project_intervention',
    resolution,
    outcome: 'submitted_for_review',
    projectChanged: true,
    humanActionRequired: false,
    taskId: recovered.taskId || task.id,
    intervention,
    artifacts: submittedArtifacts,
    result: resultPayload,
    reviewNotification,
    ...(reviewNotificationError ? { reviewNotificationError } : {}),
  });
}

export function validateRepairArtifact(input = {}) {
  const content = typeof input.content === 'string' ? input.content : '';
  if (content.trim()) {
    return {
      ok: false,
      error: 'inline_content_forbidden',
      status: 400,
      message: 'deliverable content must be written to an artifacts file and submitted by path',
    };
  }

  const artifactPath = String(input.artifactPath || input.relativePath || input.path || '').trim();
  if (!artifactPath) {
    return { ok: false, error: 'artifact_path_required', status: 400 };
  }
  const normalizedPath = artifactPath.replace(/\\/g, '/');
  const segments = normalizedPath.split('/').filter(Boolean);
  if (
    !normalizedPath ||
    isAbsolute(normalizedPath) ||
    normalizedPath.includes('\0') ||
    segments.includes('..') ||
    segments.length === 0 ||
    basename(normalizedPath).startsWith('.')
  ) {
    return { ok: false, error: 'artifact_path_escape', status: 400, path: artifactPath };
  }

  const filename = basename(normalizedPath);
  const ext = extname(filename).toLowerCase();
  return {
    ok: true,
    artifact: {
      filename,
      path: normalizedPath,
      relativePath: normalizedPath.startsWith('artifacts/') ? normalizedPath : `artifacts/${normalizedPath}`,
      mimeType: input.mimeType || MIME_TYPES[ext] || 'application/octet-stream',
      role: input.role || 'primary',
    },
  };
}

function buildSubmittedArtifact(projectId, artifact, written = {}) {
  const filename = written.filename || artifact.filename;
  const relativePath = written.relativePath || artifact.relativePath || artifact.path;
  const ext = extname(filename).toLowerCase();
  const encodedPath = String(relativePath || `artifacts/${filename}`)
    .replace(/^artifacts\//, '')
    .split('/')
    .map(encodeURIComponent)
    .join('/');
  return {
    filename,
    url: `/projects/${projectId}/artifacts/${encodedPath}`,
    previewable: PREVIEWABLE_EXTENSIONS.has(ext),
    mimeType: written.mimeType || artifact.mimeType || MIME_TYPES[ext] || 'application/octet-stream',
    path: written.path || null,
    relativePath,
    size: typeof written.size === 'number' ? written.size : undefined,
    sha256: written.sha256 || undefined,
    generatedAt: written.generatedAt || undefined,
    role: artifact.role || written.role || 'primary',
  };
}

function buildRepairSummary({ requestedSummary = '', task = {}, artifacts = [] } = {}) {
  const summary = String(requestedSummary || '').trim();
  const min = Number(task?.executionContract?.minSummaryChars ?? 50);
  if (summary.length >= min && !isPlaceholderSummary(summary)) return summary;

  const artifactNames = artifacts
    .map(artifact => artifact?.filename || artifact?.relativePath || artifact?.path || '')
    .filter(Boolean);
  const artifactLabel = artifactNames.length > 0 ? artifactNames.join(', ') : '已登记的 artifact 文件';
  const taskLabel = task?.title || task?.id || '当前任务';
  const prefix = summary && !isPlaceholderSummary(summary) ? `${summary}。` : '';
  return [
    prefix,
    `提交修复产物 ${artifactLabel}，作为任务“${taskLabel}”的主要可审核输出。`,
    '本次修复只登记产物文件路径，不以内联文本替代交付内容；请 PO 按验收标准、证据要求和文件正文继续审核。',
  ].join('');
}

function isPlaceholderSummary(value = '') {
  return /^(done|ok|complete|completed|完成|已完成|已修复)$/i.test(String(value || '').trim());
}

function validateExpectedState(task, request, intervention) {
  if (request.expectedPrimaryTaskId && request.expectedPrimaryTaskId !== task.id) {
    return {
      ok: false,
      error: 'task_state_changed',
      status: 409,
      currentPrimaryTaskId: task.id,
      intervention,
    };
  }
  if (
    request.expectedTaskUpdatedAt !== undefined &&
    Number(request.expectedTaskUpdatedAt) !== Number(task.updatedAt || 0)
  ) {
    return {
      ok: false,
      error: 'task_state_changed',
      status: 409,
      currentTaskUpdatedAt: task.updatedAt || null,
      intervention,
    };
  }
  if (intervention.primaryTaskId && task.id !== intervention.primaryTaskId) {
    return {
      ok: false,
      error: 'task_state_changed',
      status: 409,
      currentPrimaryTaskId: intervention.primaryTaskId,
      intervention,
    };
  }
  return { ok: true };
}

function notAdvanced(result) {
  return {
    ...result,
    outcome: 'not_advanced',
    projectChanged: false,
    humanActionRequired: false,
  };
}

function remember(project, idempotencyKey, requestHash, result) {
  project.interventionResolveIdempotency[idempotencyKey] = {
    requestHash,
    result,
  };
  return result;
}

function fingerprintRequest(request = {}) {
  const artifacts = Array.isArray(request.artifacts)
    ? request.artifacts.map(artifact => ({
        filename: String(artifact?.filename || ''),
        path: String(artifact?.artifactPath || artifact?.relativePath || artifact?.path || ''),
        mimeType: String(artifact?.mimeType || ''),
      }))
    : [];
  return hash(JSON.stringify({
    resolution: String(request.resolution || ''),
    fromAgent: String(request.fromAgent || ''),
    expectedPrimaryTaskId: String(request.expectedPrimaryTaskId || ''),
    expectedTaskUpdatedAt: request.expectedTaskUpdatedAt ?? null,
    summary: String(request.summary || ''),
    artifacts,
  }));
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}
