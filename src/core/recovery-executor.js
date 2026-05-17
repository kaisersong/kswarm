/**
 * Executes restart recovery actions against the Hub.
 *
 * Kept separate from server/index.js so recovery behavior is testable without
 * opening ports or starting broker clients.
 */

import { extname } from 'node:path';

const PREVIEWABLE_EXTS = new Set(['.html', '.md', '.json', '.txt', '.svg', '.png', '.jpg']);
const MIME_TYPES = {
  '.html': 'text/html',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

function artifactToResult(projectId, artifact) {
  const filename = artifact.filename;
  const ext = extname(filename);
  return {
    filename,
    url: `/projects/${projectId}/artifacts/${filename}`,
    previewable: PREVIEWABLE_EXTS.has(ext),
    mimeType: artifact.mimeType || MIME_TYPES[ext] || 'application/octet-stream',
  };
}

export async function executeRecoveryAction(action, {
  hub,
  sendReviewSubmission,
  sendRequestTask,
} = {}) {
  if (!action || !action.type) return { ok: false, error: 'invalid_recovery_action' };

  if (action.type === 'recover_submission') {
    const resultPayload = {
      projectId: action.projectId,
      taskId: action.taskId,
      runId: action.runId,
      summary: `Recovered submission for ${action.taskId}`,
      participantId: action.agentId || 'recovery',
      artifacts: (action.artifacts || []).map(artifact => artifactToResult(action.projectId, artifact)),
      recovered: true,
    };
    const result = hub.handleRecoverSubmission(
      action.projectId,
      action.taskId,
      resultPayload,
      action.agentId || 'recovery',
      { runId: action.runId, recoveryReason: action.reason || 'journal_artifact_written' }
    );
    if (result.ok && sendReviewSubmission) {
      await sendReviewSubmission({
        projectId: action.projectId,
        taskId: result.taskId,
        fromWorker: action.agentId || 'recovery',
        result: resultPayload,
      });
    }
    return result;
  }

  if (action.type === 'reset_pending') {
    return hub.handleResetTaskForRecovery(action.projectId, action.taskId, action.reason || 'lease_expired');
  }

  if (action.type === 'resume_task') {
    if (sendRequestTask) await sendRequestTask(action.projectId, action.taskId);
    return { ok: true, action: 'resume_task', projectId: action.projectId, taskId: action.taskId };
  }

  if (action.type === 'notify_po_review') {
    if (sendReviewSubmission) {
      await sendReviewSubmission({
        projectId: action.projectId,
        taskId: action.taskId,
        fromWorker: action.agentId || 'recovery',
        result: action.result,
      });
    }
    return { ok: true, action: 'notify_po_review', projectId: action.projectId, taskId: action.taskId };
  }

  return { ok: true, skipped: true, action: action.type };
}

