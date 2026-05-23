import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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

  const handoffDir = join(projectRoot, 'handoffs', runId);
  mkdirSync(handoffDir, { recursive: true });
  const handoffPath = join(handoffDir, 'request.json');
  const handoff = {
    kind: 'kswarm_task_handoff_v1',
    createdAt: now(),
    runId,
    targetParticipantId,
    project: {
      id: project.id,
      name: project.name,
      goal: project.goal,
      requirements: project.requirements || '',
      workFolder: project.workFolder || null,
      artifactsDir: project.artifactsDir || (project.workFolder ? join(project.workFolder, 'artifacts') : null),
    },
    task: {
      id: task.id,
      localTaskId: task.localTaskId || null,
      title: task.title,
      brief: task.brief || '',
      acceptanceCriteria: task.acceptanceCriteria || '',
      requiredOutputs: task.requiredOutputs || [],
      outputContract: task.outputContract || null,
      executionContract: task.executionContract || null,
      evidenceContract: task.evidenceContract || null,
      repairInstruction: task.repairInstruction || '',
    },
    contextPolicy: {
      largeContent: 'file_reference_only',
      resultManifest: 'result.json',
    },
  };
  writeFileSync(handoffPath, JSON.stringify(handoff, null, 2), 'utf-8');
  return { ok: true, handoffPath, handoff };
}
