/**
 * Built-in workflows for KSwarm control-plane operations.
 *
 * Built-ins stay deterministic at the control-plane level: KSwarm owns
 * workflow graph, gate reduction, and state transitions. Agent nodes may
 * produce artifacts through the desktop runtime when the spec permits it.
 */

import { applyWorkflowEvent, createWorkflowRun } from './workflow-run.js';

export const PROJECT_DIAGNOSE_WORKFLOW_ID = 'project-diagnose';
export const AGENT_REVIEW_SMOKE_WORKFLOW_ID = 'agent-review-smoke';
export const PO_GENERATED_TASK_WORKFLOW_ID = 'po-generated-task-workflow';
export const PO_GENERATED_PROJECT_WORKFLOW_ID = 'po-generated-project-workflow';
export const TASK_WORKFLOW_DELIVERABLE_NODE_ID = 'worker-produce-deliverable';
export const PROJECT_WORKFLOW_DELIVERABLE_NODE_ID = 'worker-produce-project-deliverable';

export function createProjectDiagnoseWorkflowSpec({ project } = {}) {
  if (!project?.id) throwProjectRequired();
  return {
    kind: 'kswarm_workflow_spec_v1',
    id: PROJECT_DIAGNOSE_WORKFLOW_ID,
    name: '快速诊断',
    description: '系统内置读取项目状态、任务阻塞和派发建议，不调用智能体。',
    scope: { projectId: project.id },
    budgets: { maxNodes: 3, maxParallelism: 1, maxAgents: 0, maxMinutes: 1, maxTokens: 0 },
    permissions: { toolCategories: ['read_project_state'], allowWrite: false, allowShell: false, allowNetwork: false, allowRenderer: false },
    outputContract: { kind: 'diagnosis', requiredArtifactTypes: [] },
    assumptions: ['只读取 KSwarm 项目状态和任务状态', '不调用智能体，不生成外部产物'],
    acceptanceRubric: {
      id: 'project-diagnose-rubric',
      title: '项目诊断验收标准',
      machineChecks: [
        { id: 'project_state_readable', title: '项目状态可读取', checkKind: 'schema', required: true, inputRefs: ['project.snapshot'] },
      ],
      judgmentChecks: [
        { id: 'recommendation_has_reason', title: '建议包含原因', prompt: '检查系统诊断建议是否包含原因。', evidenceRequired: true, reviewerCount: 1, required: true },
      ],
      disagreementPolicy: 'block',
    },
    phases: [
      {
        id: 'inspect',
        title: '检查项目状态',
        nodes: [
          { id: 'collect-project-state', title: '收集项目状态', kind: 'budget_check', required: true, inputRefs: ['project.snapshot'], evidenceRequired: true, permissions: { toolCategories: ['read_project_state'] }, failurePolicy: { strategy: 'block' } },
          { id: 'classify-blockers', title: '识别阻塞与等待原因', kind: 'budget_check', dependsOn: ['collect-project-state'], required: true, inputRefs: ['collect-project-state.output'], evidenceRequired: true, permissions: { toolCategories: ['read_project_state'] }, failurePolicy: { strategy: 'block' } },
        ],
      },
      {
        id: 'recommend',
        title: '生成处理建议',
        nodes: [
          { id: 'recommend-actions', title: '生成下一步建议', kind: 'reduce', dependsOn: ['classify-blockers'], required: true, inputRefs: ['classify-blockers.output'], evidenceRequired: true, permissions: { toolCategories: ['read_project_state'] }, failurePolicy: { strategy: 'block' } },
        ],
      },
    ],
  };
}

export function createAgentReviewSmokeWorkflowSpec({ project, task = null, workerAgent = 'xiaok-worker', reviewerAgent = 'xiaok-po' } = {}) {
  if (!project?.id) throwProjectRequired();
  const scope = task?.id ? { projectId: project.id, taskId: task.id } : { projectId: project.id };
  return {
    kind: 'kswarm_workflow_spec_v1',
    id: AGENT_REVIEW_SMOKE_WORKFLOW_ID,
    name: 'Agent 复核诊断',
    description: task?.id
      ? `Worker Agent 诊断任务「${task.title || task.id}」，Reviewer Agent 对抗性复核，并由 KSwarm gate reducer 归约。`
      : 'Worker Agent 诊断项目，Reviewer Agent 对抗性复核，并由 KSwarm gate reducer 归约。',
    scope,
    budgets: { maxNodes: 3, maxParallelism: 1, maxAgents: 2, maxMinutes: 10, maxTokens: 12_000 },
    permissions: { toolCategories: ['read_project_state'], allowWrite: false, allowShell: false, allowNetwork: false, allowRenderer: false },
    outputContract: { kind: 'diagnosis', requiredArtifactTypes: [] },
    assumptions: [
      task?.id
        ? 'Worker 只诊断当前任务状态、上下文和阻塞，不修改项目计划'
        : 'Worker 只诊断项目状态和任务阻塞，不修改项目计划',
      'Reviewer 只产出结构化 reviewDecision，不直接改变任务或产物状态',
      'Gate reducer 由 KSwarm 持久化归约结果',
    ],
    acceptanceRubric: {
      id: 'agent-review-diagnosis-rubric',
      title: 'Agent 复核诊断验收标准',
      machineChecks: [
        { id: 'worker_output_schema', title: 'Worker 输出结构合法', checkKind: 'schema', required: true, inputRefs: ['worker-diagnose-project.output'] },
      ],
      judgmentChecks: [
        { id: 'review_evidence', title: '复核结论有证据', prompt: '检查 reviewer 是否引用 worker diagnosis 的证据。', evidenceRequired: true, reviewerCount: 1, required: true },
      ],
      disagreementPolicy: 'block',
    },
    phases: [
      {
        id: 'inspect',
        title: 'Agent 诊断',
        nodes: [
          { id: 'worker-diagnose-project', title: 'Worker 项目诊断', kind: 'agent', required: true, inputRefs: ['project.snapshot'], agentSelector: { participantId: workerAgent, requiredCapabilities: ['project_diagnosis'] }, outputSchema: { type: 'object', required: ['summary'] }, evidenceRequired: true, permissions: { toolCategories: ['read_project_state'] }, failurePolicy: { strategy: 'block' } },
        ],
      },
      {
        id: 'review',
        title: '对抗性复核',
        nodes: [
          { id: 'reviewer-adversarial-check', title: 'Reviewer 对抗性检查', kind: 'review', dependsOn: ['worker-diagnose-project'], required: true, inputRefs: ['worker-diagnose-project.output'], agentSelector: { participantId: reviewerAgent, requiredCapabilities: ['review_gate'] }, outputSchema: { type: 'object', required: ['reviewDecision'] }, evidenceRequired: true, permissions: { toolCategories: ['read_project_state'] }, failurePolicy: { strategy: 'block' } },
        ],
      },
      {
        id: 'reduce',
        title: '门禁归约',
        nodes: [
          { id: 'reduce-review-gate', title: '归约 review gate', kind: 'reduce', dependsOn: ['reviewer-adversarial-check'], required: true, inputRefs: ['reviewer-adversarial-check.reviewDecision'], outputSchema: { type: 'object', required: ['status'] }, evidenceRequired: true, permissions: { toolCategories: ['read_project_state'] }, failurePolicy: { strategy: 'block' } },
        ],
      },
    ],
  };
}

export function createPoGeneratedTaskWorkflowSpec({ project, task, workerAgent = 'xiaok-worker', reviewerAgent = 'xiaok-po' } = {}) {
  if (!project?.id) throwProjectRequired();
  if (!task?.id) {
    const error = new Error('task_required');
    error.code = 'task_required';
    throw error;
  }
  const assignedWorker = task.assignedAgent || workerAgent || 'xiaok-worker';

  return {
    kind: 'kswarm_workflow_spec_v1',
    id: PO_GENERATED_TASK_WORKFLOW_ID,
    name: '任务交付物工作流',
    description: `Worker Agent 执行任务「${task.title || task.id}」并产出可复核交付物，Reviewer Agent 对抗性复核，通过后由 KSwarm 提交任务结果。`,
    scope: { projectId: project.id, taskId: task.id },
    budgets: { maxNodes: 3, maxParallelism: 1, maxAgents: 2, maxMinutes: 15, maxTokens: 16_000 },
    permissions: { toolCategories: ['read_project_state', 'write_artifact'], allowWrite: true, allowShell: false, allowNetwork: false, allowRenderer: false },
    outputContract: { kind: 'task_deliverable', requiredArtifactTypes: Array.isArray(task.requiredOutputs) ? task.requiredOutputs : [] },
    assumptions: [
      'Worker 产出的是任务交付物，不是 raw JavaScript 或未执行计划',
      'Worker 只能在项目工作区内写入任务交付物文件',
      'Reviewer 必须用 evidence refs 复核 Worker 交付物，不能直接修改任务状态',
      'Gate reducer 由 KSwarm 在 passed 后提交任务结果',
    ],
    acceptanceRubric: {
      id: 'po-generated-task-workflow-rubric',
      title: '任务交付物工作流验收标准',
      machineChecks: [
        { id: 'worker_deliverable_schema', title: 'Worker 交付物输出结构合法', checkKind: 'schema', required: true, inputRefs: [`${TASK_WORKFLOW_DELIVERABLE_NODE_ID}.output`] },
      ],
      judgmentChecks: [
        { id: 'task_deliverable_evidence', title: '任务交付物和证据充分', prompt: '检查 Worker 交付物是否围绕当前任务，是否包含可复核 artifact 和必要证据。', evidenceRequired: true, reviewerCount: 1, required: true },
      ],
      disagreementPolicy: 'block',
    },
    phases: [
      {
        id: 'deliver',
        title: 'Worker 生成交付物',
        nodes: [
          { id: TASK_WORKFLOW_DELIVERABLE_NODE_ID, title: 'Worker 生成任务交付物', kind: 'agent', required: true, inputRefs: ['project.snapshot', 'task.snapshot'], agentSelector: { participantId: assignedWorker, requiredCapabilities: ['writing'] }, outputSchema: { type: 'object', required: ['summary', 'artifacts'] }, evidenceRequired: true, permissions: { toolCategories: ['read_project_state', 'write_artifact'], allowWrite: true }, failurePolicy: { strategy: 'block' } },
        ],
      },
      {
        id: 'review',
        title: '对抗性复核',
        nodes: [
          { id: 'reviewer-adversarial-check', title: 'Reviewer 复核交付物', kind: 'review', dependsOn: [TASK_WORKFLOW_DELIVERABLE_NODE_ID], required: true, inputRefs: [`${TASK_WORKFLOW_DELIVERABLE_NODE_ID}.output`], agentSelector: { participantId: reviewerAgent, requiredCapabilities: ['review_gate'] }, outputSchema: { type: 'object', required: ['reviewDecision'] }, evidenceRequired: true, permissions: { toolCategories: ['read_project_state'] }, failurePolicy: { strategy: 'block' } },
        ],
      },
      {
        id: 'reduce',
        title: '门禁归约',
        nodes: [
          { id: 'reduce-review-gate', title: '归约 review gate', kind: 'reduce', dependsOn: ['reviewer-adversarial-check'], required: true, inputRefs: ['reviewer-adversarial-check.reviewDecision'], outputSchema: { type: 'object', required: ['status'] }, evidenceRequired: true, permissions: { toolCategories: ['read_project_state'] }, failurePolicy: { strategy: 'block' } },
        ],
      },
    ],
  };
}

export function createPoGeneratedProjectWorkflowSpec({ project, tasks = [], workerAgent = 'xiaok-worker', reviewerAgent = 'xiaok-po' } = {}) {
  if (!project?.id) throwProjectRequired();
  const assignedWorker = workerAgent || (Array.isArray(project.members) && project.members[0]) || 'xiaok-worker';

  return {
    kind: 'kswarm_workflow_spec_v1',
    id: PO_GENERATED_PROJECT_WORKFLOW_ID,
    name: '项目交付物工作流',
    description: `Worker Agent 执行项目「${project.name || project.id}」并产出最终项目交付物，Reviewer Agent 对抗性复核，通过后由 KSwarm 交付整个项目。`,
    scope: { projectId: project.id },
    budgets: { maxNodes: 3, maxParallelism: 1, maxAgents: 2, maxMinutes: 30, maxTokens: 30_000 },
    permissions: { toolCategories: ['read_project_state', 'write_artifact'], allowWrite: true, allowShell: false, allowNetwork: false, allowRenderer: false },
    outputContract: { kind: 'project_deliverable', requiredArtifactTypes: collectProjectRequiredOutputs(tasks) },
    assumptions: [
      'Worker 产出的是整个项目最终交付物，不是单个任务交付物或诊断摘要',
      'Worker 必须在项目工作区内写入可复核的最终项目交付物文件',
      'Reviewer 必须用 evidence refs 复核 Worker 项目交付物，不能直接修改任务或项目状态',
      'Gate reducer 由 KSwarm 在 passed 后完成项目交付闭环',
    ],
    acceptanceRubric: {
      id: 'po-generated-project-workflow-rubric',
      title: '项目交付物工作流验收标准',
      machineChecks: [
        { id: 'project_deliverable_schema', title: 'Worker 项目交付物输出结构合法', checkKind: 'schema', required: true, inputRefs: [`${PROJECT_WORKFLOW_DELIVERABLE_NODE_ID}.output`] },
      ],
      judgmentChecks: [
        { id: 'project_deliverable_evidence', title: '项目交付物和证据充分', prompt: '检查 Worker 交付物是否覆盖项目目标、项目要求和任务快照，是否包含可复核 artifact 和必要证据。', evidenceRequired: true, reviewerCount: 1, required: true },
      ],
      disagreementPolicy: 'block',
    },
    phases: [
      {
        id: 'deliver',
        title: 'Worker 生成项目交付物',
        nodes: [
          { id: PROJECT_WORKFLOW_DELIVERABLE_NODE_ID, title: 'Worker 生成项目交付物', kind: 'agent', required: true, inputRefs: ['project.snapshot', 'task.snapshot'], agentSelector: { participantId: assignedWorker, requiredCapabilities: ['writing'] }, outputSchema: { type: 'object', required: ['summary', 'artifacts'] }, evidenceRequired: true, permissions: { toolCategories: ['read_project_state', 'write_artifact'], allowWrite: true }, failurePolicy: { strategy: 'block' } },
        ],
      },
      {
        id: 'review',
        title: '对抗性复核',
        nodes: [
          { id: 'reviewer-adversarial-check', title: 'Reviewer 复核项目交付物', kind: 'review', dependsOn: [PROJECT_WORKFLOW_DELIVERABLE_NODE_ID], required: true, inputRefs: [`${PROJECT_WORKFLOW_DELIVERABLE_NODE_ID}.output`], agentSelector: { participantId: reviewerAgent, requiredCapabilities: ['review_gate'] }, outputSchema: { type: 'object', required: ['reviewDecision'] }, evidenceRequired: true, permissions: { toolCategories: ['read_project_state'] }, failurePolicy: { strategy: 'block' } },
        ],
      },
      {
        id: 'reduce',
        title: '门禁归约',
        nodes: [
          { id: 'reduce-review-gate', title: '归约 review gate', kind: 'reduce', dependsOn: ['reviewer-adversarial-check'], required: true, inputRefs: ['reviewer-adversarial-check.reviewDecision'], outputSchema: { type: 'object', required: ['status'] }, evidenceRequired: true, permissions: { toolCategories: ['read_project_state'] }, failurePolicy: { strategy: 'block' } },
        ],
      },
    ],
  };
}

export function createProjectDiagnoseWorkflowRun({
  project,
  tasks = [],
  projectHealth = null,
  dispatchPlan = null,
  requestedBy = 'human',
  now = Date.now(),
} = {}) {
  if (!project?.id) {
    const error = new Error('project_required');
    error.code = 'project_required';
    throw error;
  }

  const diagnosis = buildProjectDiagnosis({ project, tasks, projectHealth, dispatchPlan });
  const spec = createProjectDiagnoseWorkflowSpec({ project });
  let run = createWorkflowRun({
    id: `wf-${project.id}-${PROJECT_DIAGNOSE_WORKFLOW_ID}-${now}`,
    projectId: project.id,
    workflowId: PROJECT_DIAGNOSE_WORKFLOW_ID,
    title: '项目诊断工作流',
    requestedBy,
    source: 'builtin',
    spec,
    budgets: spec.budgets,
    permissions: spec.permissions,
    outputContract: spec.outputContract,
    acceptanceRubric: spec.acceptanceRubric,
    assumptions: spec.assumptions,
    phases: [
      { id: 'inspect', title: '检查项目状态' },
      { id: 'recommend', title: '生成处理建议' },
    ],
    nodes: [
      { id: 'collect-project-state', phaseId: 'inspect', title: '收集项目状态', kind: 'control' },
      { id: 'classify-blockers', phaseId: 'inspect', title: '识别阻塞与等待原因', kind: 'control', dependsOn: ['collect-project-state'] },
      { id: 'recommend-actions', phaseId: 'recommend', title: '生成下一步建议', kind: 'review', dependsOn: ['classify-blockers'] },
    ],
    diagnosis,
    now,
  });

  const outputs = {
    'collect-project-state': {
      projectStatus: project.status || null,
      taskCount: tasks.length,
      healthState: diagnosis.healthState,
    },
    'classify-blockers': {
      blockedTasks: diagnosis.blockedTasks,
      waitingCount: diagnosis.waitingCount,
      dispatchableCount: diagnosis.dispatchableCount,
    },
    'recommend-actions': {
      recommendedActions: diagnosis.recommendedActions,
    },
  };

  for (const nodeId of ['collect-project-state', 'classify-blockers', 'recommend-actions']) {
    run = applyWorkflowEvent(run, { type: 'node_started', nodeId }, { now });
    run = applyWorkflowEvent(run, { type: 'node_completed', nodeId, output: outputs[nodeId] }, { now });
  }
  return run;
}

export function createAgentReviewSmokeWorkflowRun({
  project,
  tasks = [],
  task = null,
  workerAgent = 'xiaok-worker',
  reviewerAgent = 'xiaok-po',
  requestedBy = 'human',
  now = Date.now(),
} = {}) {
  if (!project?.id) {
    const error = new Error('project_required');
    error.code = 'project_required';
    throw error;
  }
  const spec = createAgentReviewSmokeWorkflowSpec({ project, task, workerAgent, reviewerAgent });

  return createWorkflowRun({
    id: `wf-${project.id}-${AGENT_REVIEW_SMOKE_WORKFLOW_ID}-${now}`,
    projectId: project.id,
    workflowId: AGENT_REVIEW_SMOKE_WORKFLOW_ID,
    title: 'Agent 工作流 smoke',
    requestedBy,
    source: 'builtin-smoke',
    scope: spec.scope,
    sourceTask: task ? formatSourceTask(task) : null,
    spec,
    budgets: spec.budgets,
    permissions: spec.permissions,
    outputContract: spec.outputContract,
    acceptanceRubric: spec.acceptanceRubric,
    assumptions: spec.assumptions,
    phases: [
      { id: 'inspect', title: 'Agent 诊断' },
      { id: 'review', title: '对抗性复核' },
      { id: 'reduce', title: '门禁归约' },
    ],
    nodes: [
      {
        id: 'worker-diagnose-project',
        phaseId: 'inspect',
        title: 'Worker 项目诊断',
        kind: 'agent_task',
        assignedAgent: workerAgent,
        input: buildWorkerSmokeInput({ project, tasks, task }),
      },
      {
        id: 'reviewer-adversarial-check',
        phaseId: 'review',
        title: 'Reviewer 对抗性检查',
        kind: 'review',
        dependsOn: ['worker-diagnose-project'],
        assignedAgent: reviewerAgent,
        input: { reviewFocus: ['事实完整性', '阻塞判断', '下一步建议是否可执行'] },
      },
      {
        id: 'reduce-review-gate',
        phaseId: 'reduce',
        title: '归约 review gate',
        kind: 'control',
        dependsOn: ['reviewer-adversarial-check'],
      },
    ],
    now,
  });
}

export function createPoGeneratedTaskWorkflowRun({
  project,
  task,
  tasks = [],
  workerAgent = 'xiaok-worker',
  reviewerAgent = 'xiaok-po',
  requestedBy = 'human',
  now = Date.now(),
} = {}) {
  if (!project?.id) throwProjectRequired();
  if (!task?.id) {
    const error = new Error('task_required');
    error.code = 'task_required';
    throw error;
  }
  const assignedWorker = task.assignedAgent || workerAgent || 'xiaok-worker';
  const spec = createPoGeneratedTaskWorkflowSpec({ project, task, workerAgent: assignedWorker, reviewerAgent });

  return createWorkflowRun({
    id: `wf-${project.id}-${PO_GENERATED_TASK_WORKFLOW_ID}-${now}`,
    projectId: project.id,
    workflowId: PO_GENERATED_TASK_WORKFLOW_ID,
    title: '任务交付物工作流',
    requestedBy,
    source: 'po_generated',
    scope: spec.scope,
    sourceTask: formatSourceTask(task),
    spec,
    budgets: spec.budgets,
    permissions: spec.permissions,
    outputContract: spec.outputContract,
    acceptanceRubric: spec.acceptanceRubric,
    assumptions: spec.assumptions,
    phases: [
      { id: 'deliver', title: 'Worker 生成交付物' },
      { id: 'review', title: '对抗性复核' },
      { id: 'reduce', title: '门禁归约' },
    ],
    nodes: [
      {
        id: TASK_WORKFLOW_DELIVERABLE_NODE_ID,
        phaseId: 'deliver',
        title: 'Worker 生成任务交付物',
        kind: 'agent_task',
        assignedAgent: assignedWorker,
        input: buildPoTaskWorkflowInput({ project, task, tasks }),
      },
      {
        id: 'reviewer-adversarial-check',
        phaseId: 'review',
        title: 'Reviewer 复核交付物',
        kind: 'review',
        dependsOn: [TASK_WORKFLOW_DELIVERABLE_NODE_ID],
        assignedAgent: reviewerAgent,
        input: { reviewFocus: ['任务范围', '交付物可读性', '证据充分性', '预算与权限边界'] },
      },
      {
        id: 'reduce-review-gate',
        phaseId: 'reduce',
        title: '归约 review gate',
        kind: 'control',
        dependsOn: ['reviewer-adversarial-check'],
      },
    ],
    now,
  });
}

export function createPoGeneratedProjectWorkflowRun({
  project,
  tasks = [],
  workerAgent = 'xiaok-worker',
  reviewerAgent = 'xiaok-po',
  requestedBy = 'human',
  now = Date.now(),
} = {}) {
  if (!project?.id) throwProjectRequired();
  const assignedWorker = workerAgent || (Array.isArray(project.members) && project.members[0]) || 'xiaok-worker';
  const spec = createPoGeneratedProjectWorkflowSpec({ project, tasks, workerAgent: assignedWorker, reviewerAgent });

  return createWorkflowRun({
    id: `wf-${project.id}-${PO_GENERATED_PROJECT_WORKFLOW_ID}-${now}`,
    projectId: project.id,
    workflowId: PO_GENERATED_PROJECT_WORKFLOW_ID,
    title: '项目交付物工作流',
    requestedBy,
    source: 'po_generated_project',
    scope: spec.scope,
    sourceTask: null,
    spec,
    budgets: spec.budgets,
    permissions: spec.permissions,
    outputContract: spec.outputContract,
    acceptanceRubric: spec.acceptanceRubric,
    assumptions: spec.assumptions,
    phases: [
      { id: 'deliver', title: 'Worker 生成项目交付物' },
      { id: 'review', title: '对抗性复核' },
      { id: 'reduce', title: '门禁归约' },
    ],
    nodes: [
      {
        id: PROJECT_WORKFLOW_DELIVERABLE_NODE_ID,
        phaseId: 'deliver',
        title: 'Worker 生成项目交付物',
        kind: 'agent_task',
        assignedAgent: assignedWorker,
        input: buildPoProjectWorkflowInput({ project, tasks }),
      },
      {
        id: 'reviewer-adversarial-check',
        phaseId: 'review',
        title: 'Reviewer 复核项目交付物',
        kind: 'review',
        dependsOn: [PROJECT_WORKFLOW_DELIVERABLE_NODE_ID],
        assignedAgent: reviewerAgent,
        input: { reviewFocus: ['项目目标覆盖', '最终交付物可读性', '证据充分性', '任务覆盖范围'] },
      },
      {
        id: 'reduce-review-gate',
        phaseId: 'reduce',
        title: '归约 review gate',
        kind: 'control',
        dependsOn: ['reviewer-adversarial-check'],
      },
    ],
    now,
  });
}

function throwProjectRequired() {
  const error = new Error('project_required');
  error.code = 'project_required';
  throw error;
}

export function buildProjectDiagnosis({ project = {}, tasks = [], projectHealth = null, dispatchPlan = null } = {}) {
  const healthState = projectHealth?.state || projectHealth?.status || null;
  const blockedTasks = collectBlockedTasks({ tasks, projectHealth, dispatchPlan });
  const dispatchableCount = countDispatchable(dispatchPlan, tasks);
  const waitingCount = Array.isArray(dispatchPlan?.waiting)
    ? dispatchPlan.waiting.length
    : (dispatchPlan?.skipped || []).filter(item => String(item.reason || '').includes('busy')).length;
  const recommendedActions = recommendActions({ healthState, blockedTasks, dispatchableCount, waitingCount, project });

  return {
    healthState,
    gate: projectHealth?.gate || dispatchPlan?.projectGate || null,
    blockedTasks,
    dispatchableCount,
    waitingCount,
    recommendedActions,
  };
}

function collectBlockedTasks({ tasks = [], projectHealth = null, dispatchPlan = null }) {
  const byId = new Map();
  for (const reason of projectHealth?.reasons || []) {
    if (!reason?.taskId) continue;
    byId.set(reason.taskId, { taskId: reason.taskId, message: reason.message || reason.reason || '任务已阻塞' });
  }
  for (const item of dispatchPlan?.blocked || []) {
    const taskId = item.taskId || item.id;
    if (!taskId || byId.has(taskId)) continue;
    byId.set(taskId, { taskId, message: item.reason || '任务依赖未满足' });
  }
  for (const task of tasks) {
    if (task.status !== 'blocked' || byId.has(task.id)) continue;
    byId.set(task.id, { taskId: task.id, message: task.blockedReason || task.failureReason || '任务已阻塞' });
  }
  return [...byId.values()];
}

function countDispatchable(dispatchPlan, tasks) {
  if (Array.isArray(dispatchPlan?.dispatchedTasks)) return dispatchPlan.dispatchedTasks.length;
  if (Array.isArray(dispatchPlan?.dispatchable)) return dispatchPlan.dispatchable.length;
  return tasks.filter(task => task.status === 'pending' && task.assignedAgent).length;
}

function recommendActions({ healthState, blockedTasks, dispatchableCount, waitingCount, project }) {
  if (blockedTasks.length > 0 || ['blocked', 'failed', 'repair_output_contract'].includes(String(healthState || ''))) {
    return [{ id: 'continue_project', label: '继续处理阻塞', reason: '项目存在阻塞或失败任务，需要由 KSwarm 推进恢复路径' }];
  }
  if (dispatchableCount > 0 && project.status === 'active') {
    return [{ id: 'dispatch_tasks', label: '派发可执行任务', reason: '存在可派发任务，且项目处于 active 状态' }];
  }
  if (waitingCount > 0) {
    return [{ id: 'wait_for_agents', label: '等待 Agent 空闲', reason: '当前主要瓶颈是 Agent 忙碌或容量不足' }];
  }
  return [{ id: 'observe', label: '继续观察项目状态', reason: '未发现需要立即干预的问题' }];
}

function buildWorkerSmokeInput({ project = {}, tasks = [], task = null }) {
  return {
    project: {
      id: project.id,
      name: project.name,
      goal: project.goal || '',
      status: project.status || '',
    },
    taskSnapshot: tasks.map(task => ({
      id: task.id,
      title: task.title,
      status: task.status,
      assignedAgent: task.assignedAgent || null,
    })),
    sourceTask: task ? formatSourceTask(task) : null,
    instruction: task?.id
      ? '检查当前任务状态，输出结构化诊断摘要、证据引用和下一步建议。'
      : '检查项目当前任务状态，输出结构化诊断摘要、证据引用和下一步建议。',
  };
}

function buildPoTaskWorkflowInput({ project = {}, task = {}, tasks = [] }) {
  return {
    project: {
      id: project.id,
      name: project.name,
      goal: project.goal || '',
      status: project.status || '',
    },
    sourceTask: formatSourceTask(task),
    taskSnapshot: tasks.map(item => ({
      id: item.id,
      title: item.title,
      status: item.status,
      assignedAgent: item.assignedAgent || null,
    })),
    instruction: '执行当前任务并生成最终交付物。必须输出 summary、artifacts、evidenceRefs；如存在项目工作区，应把可复核文件写入工作区。',
  };
}

function buildPoProjectWorkflowInput({ project = {}, tasks = [] }) {
  return {
    project: {
      id: project.id,
      name: project.name,
      goal: project.goal || '',
      requirements: project.requirements || '',
      status: project.status || '',
    },
    taskSnapshot: tasks.map(item => ({
      id: item.id,
      title: item.title,
      description: item.description || item.brief || '',
      status: item.status,
      assignedAgent: item.assignedAgent || null,
      acceptanceCriteria: item.acceptanceCriteria || '',
      requiredOutputs: Array.isArray(item.requiredOutputs) ? clonePlainList(item.requiredOutputs) : [],
    })),
    sourceTask: null,
    instruction: '执行整个项目并生成最终项目交付物。必须输出 summary、artifacts、evidenceRefs；如存在项目工作区，应把可复核文件写入工作区。',
  };
}

function collectProjectRequiredOutputs(tasks = []) {
  const outputs = [];
  for (const task of tasks) {
    if (!Array.isArray(task?.requiredOutputs)) continue;
    for (const output of task.requiredOutputs) outputs.push(output);
  }
  return clonePlainList(outputs);
}

function formatSourceTask(task = {}) {
  return {
    id: task.id,
    title: task.title || '',
    brief: task.brief || '',
    description: task.description || '',
    status: task.status || '',
    assignedAgent: task.assignedAgent || null,
    acceptanceCriteria: task.acceptanceCriteria || '',
    requiredOutputs: Array.isArray(task.requiredOutputs) ? clonePlainList(task.requiredOutputs) : [],
    executionContract: task.executionContract && typeof task.executionContract === 'object' ? { ...task.executionContract } : null,
    evidenceContract: task.evidenceContract && typeof task.evidenceContract === 'object' ? { ...task.evidenceContract } : null,
  };
}

function clonePlainList(list = []) {
  return list.map(item => item && typeof item === 'object' ? { ...item } : item);
}
