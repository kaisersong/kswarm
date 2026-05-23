import { createTaskHandoffPackage } from '../core/handoff-package.js';

export function createBrokerTaskRequest({
  handoffRoot,
  project,
  workspace,
  task,
  targetAgent,
} = {}) {
  if (!handoffRoot) return { ok: false, error: 'handoff_root_required' };
  if (!project?.id) return { ok: false, error: 'project_required' };
  if (!task?.id) return { ok: false, error: 'task_required' };
  if (!task.activeRunId) return { ok: false, error: 'run_id_required' };

  const handoff = createTaskHandoffPackage({
    projectRoot: handoffRoot,
    project: {
      ...project,
      workFolder: workspace?.path || project.workFolder || null,
      artifactsDir: workspace?.artifacts || null,
    },
    task,
    runId: task.activeRunId,
    targetParticipantId: targetAgent,
  });
  if (!handoff.ok) return handoff;

  return {
    ok: true,
    handoffPath: handoff.handoffPath,
    request: {
      taskId: task.id,
      threadId: `thread-${task.id}`,
      payload: {
        projectId: project.id,
        taskId: task.id,
        localTaskId: task.localTaskId,
        runId: task.activeRunId,
        attempt: task.attempt || 1,
        title: task.title,
        brief: task.brief,
        projectName: project.name,
        workFolder: workspace?.path || project.workFolder || '',
        handoffPath: handoff.handoffPath,
        handoffKind: 'kswarm_task_handoff_v1',
      },
    },
  };
}
