/**
 * Executes restart recovery actions against the Hub.
 *
 * Kept separate from server/index.js so recovery behavior is testable without
 * opening ports or starting broker clients.
 */

import { extname } from 'node:path';
import {types} from 'node:util';

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
    } else if (result.ok && !sendReviewSubmission) {
      return { ...result, ok: false, error: 'review_delivery_unavailable' };
    }
    return result;
  }

  if (action.type === 'reset_pending') {
    return hub.handleResetTaskForRecovery(action.projectId, action.taskId, action.reason || 'lease_expired');
  }

  if (action.type === 'resume_task') {
    if(typeof sendRequestTask!=='function')return{ok:false,error:'task_delivery_unavailable'};
    if(types.isProxy(action))return{ok:false,error:'invalid_recovery_action'};
    const fields=Object.getOwnPropertyDescriptors(action),frame={};
    for(const key of ['projectId','taskId','runId']){
      const field=fields[key];if(field&&!Object.hasOwn(field,'value'))return{ok:false,error:'invalid_recovery_action'};
      frame[key]=field?.value;
    }
    if(!['projectId','taskId'].every(key=>typeof frame[key]==='string'&&frame[key].length>0&&frame[key].length<=1024))return{ok:false,error:'invalid_recovery_action'};
    const originalHub=hub,resume=originalHub?.handleResumeTaskForRecovery;
    if(typeof resume!=='function')return{ok:false,error:'recovery_resume_unavailable'};
    const result=await resume.call(originalHub,frame.projectId,frame.taskId,{expectedRunId:frame.runId});
    if(!result||typeof result!=='object'||types.isProxy(result))return{ok:false,error:'recovery_resume_unavailable'};
    const accepted=Object.getOwnPropertyDescriptor(result,'ok');
    if(!accepted||!Object.hasOwn(accepted,'value'))return{ok:false,error:'recovery_resume_unavailable'};
    if(accepted.value!==true)return accepted.value===false?result:{ok:false,error:'recovery_resume_unavailable'};
    const resultTask=Object.getOwnPropertyDescriptor(result,'taskId');
    if(resultTask&&(!Object.hasOwn(resultTask,'value')||resultTask.value!==frame.taskId))return{ok:false,error:'RECOVERY_RESULT_MISMATCH'};
    const delivery=await sendRequestTask(frame.projectId,frame.taskId);
    if(delivery&&typeof delivery==='object'&&!types.isProxy(delivery)&&Object.getOwnPropertyDescriptor(delivery,'ok')?.value===false)return delivery;
    return { ok: true, action: 'resume_task', projectId: frame.projectId, taskId: frame.taskId };
  }

  if (action.type === 'defer_recovery') {
    return { ok: true, deferred: true, action: 'defer_recovery', projectId: action.projectId, taskId: action.taskId };
  }

  if (action.type === 'notify_po_review') {
    if (!sendReviewSubmission) {
      return { ok: false, error: 'review_delivery_unavailable', action: 'notify_po_review', projectId: action.projectId, taskId: action.taskId };
    }
    await sendReviewSubmission({
      projectId: action.projectId,
      taskId: action.taskId,
      fromWorker: action.agentId || 'recovery',
      result: action.result,
    });
    return { ok: true, action: 'notify_po_review', projectId: action.projectId, taskId: action.taskId };
  }

  return { ok: true, skipped: true, action: action.type };
}

