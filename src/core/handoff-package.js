import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {taskHandoffContent} from './task-execution-content.js';

export function createTaskHandoffPackage({
  projectRoot,
  project,
  task,
  runId,
  targetParticipantId,
  now = () => Date.now(),
} = {}) {
  if (!projectRoot) return { ok: false, error: 'project_root_required' };
  if (!project?.id) return { ok: false, error: 'project_required' };
  if (!task?.id) return { ok: false, error: 'task_required' };
  if (!runId) return { ok: false, error: 'run_id_required' };
  if (!/^[a-zA-Z0-9_.-]+$/.test(runId) || runId === '.' || runId === '..') return {ok:false,error:'run_id_invalid'};

  const content=taskHandoffContent(project,task);
  const handoffDir = join(projectRoot, 'handoffs', runId);
  mkdirSync(handoffDir, { recursive: true });
  const handoffPath = join(handoffDir, 'request.json');
  const handoff = {
    kind: 'kswarm_task_handoff_v1',
    createdAt: now(),
    runId,
    targetParticipantId,
    ...content,
    contextPolicy: {
      largeContent: 'file_reference_only',
      resultManifest: join(handoffDir, 'result.json'),
    },
    ...(task.workspaceContext ? {workspaceContext:structuredClone(task.workspaceContext)} : {}),
  };
  writeFileSync(handoffPath, JSON.stringify(handoff, null, 2), 'utf-8');
  return { ok: true, handoffPath, handoff };
}
