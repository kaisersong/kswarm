/**
 * Hub — KSwarm 的核心引擎
 *
 * 角色模型（修正版）：
 * - Human: 项目所有者。创建项目、审批计划、随时添加任务、关闭项目
 * - PO Agent: 项目负责人。规划任务、分配 worker、确认任务完成、汇报
 * - Worker Agent: 执行者。接受任务、报告进度、提交结果（含 artifacts）
 *
 * 关键规则：
 * - 项目关闭只能由 Human 决定（PO 只能确认所有任务 done）
 * - Human 可以在任何阶段添加新任务
 * - 即使所有任务 done，项目仍是 active 直到 Human 关闭
 */

import { createTaskBoard, restoreTaskBoard } from './task-board.js';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createEventLog } from './event-log.js';
import { createPersistence } from './persistence.js';
import * as retryStrategy from './retry-strategy.js';
import { expandCompositeTasks } from './composite-task-expander.js';
import { getActiveTasksAcrossBoards, isReworkReadyForDispatch, planDispatch } from './dispatch-policy.js';
import { superviseTaskFailure } from './failure-supervisor.js';
import { deriveProjectHealth } from './project-health.js';
import { deriveProjectIntervention } from './project-intervention.js';
import { handleContinueProjectCore } from './project-continue.js';
import { resolveProjectIntervention } from './project-intervention-resolution.js';
import { validateTaskResultAgainstContract } from './execution-contract.js';
import { inferTaskRequirements } from './task-requirements.js';
import { validateDeliverableContract } from './deliverable-contract.js';
import { normalizeProjectForPlanRetry } from './plan-retry-recovery.js';
import { createTaskHandoffPackage } from './handoff-package.js';
import { deriveProjectPreparation } from './agent-readiness.js';
import { planAgentReplacement } from './agent-replacement.js';
import { applyWorkflowEvent, createWorkflowRun, refreshWorkflowRunState } from './workflow-run.js';
import {
  AGENT_REVIEW_SMOKE_WORKFLOW_ID,
  PO_GENERATED_PROJECT_WORKFLOW_ID,
  PO_GENERATED_TASK_WORKFLOW_ID,
  PROJECT_WORKFLOW_DELIVERABLE_NODE_ID,
  PROJECT_DIAGNOSE_WORKFLOW_ID,
  TASK_WORKFLOW_DELIVERABLE_NODE_ID,
  createAgentReviewSmokeWorkflowRun,
  createAgentReviewSmokeWorkflowSpec,
  createPoGeneratedProjectWorkflowRun,
  createPoGeneratedProjectWorkflowSpec,
  createPoGeneratedTaskWorkflowRun,
  createPoGeneratedTaskWorkflowSpec,
  createProjectDiagnoseWorkflowRun,
  createProjectDiagnoseWorkflowSpec,
} from './workflow-builtins.js';
import {
  hashWorkflowScript as hashWorkflowScriptSource,
  normalizeWorkflowScript as normalizeWorkflowScriptSource,
} from './workflow-script-source.js';
import {
  sanitizeWorkflowGateDecision,
  sanitizeWorkflowNodeOutput,
  validateWorkflowSpec,
  validateWorkflowGateDecision,
} from './workflow-spec.js';
import { applyWorkflowProgressBatch } from './workflow-progress.js';
import {
  buildTaskExecutionMetadata,
  isValidProjectExecutionMode,
  normalizeProjectExecutionMode,
  selectTaskExecutionStrategy,
} from './execution-mode.js';
import {
  appendQualityPlanningGuidance,
  buildQualityPromptExcerpt,
  compileEffectiveQualityRuleSet,
} from './quality-rules.js';
import { reconcileProjectAgentSelectionWithEffectiveAgents } from './agent-selection.js';

const TASK_LEVEL_WORKER_FAILURE_CLASSES = new Set(['model_empty_output', 'quality_evidence_missing', 'source_provider_unavailable']);
const WORKFLOW_AGENT_CAPABILITIES = ['project_diagnosis', 'review_gate', 'writing', 'report_generation'];

export function createHub({ bridge, eventLogDir, silent = false, dataDir, getAgentProfiles = null, getQualityOverlays = null, runtimeInstanceAllocator = null } = {}) {
  const projects = new Map();
  const boards = new Map();
  const workflowRuns = new Map();
  const workflowProposals = new Map();
  const eventLog = createEventLog({ logDir: eventLogDir, silent });
  const persistence = typeof dataDir === 'string' ? createPersistence(dataDir) : null;

  // Restore state from disk
  if (persistence) {
    const saved = persistence.load();
    if (saved && saved.projects) {
      for (const p of saved.projects) {
        const project = normalizeRecoveredProject(p);
        projects.set(project.id, project);
      }
      for (const { projectId, tasks } of (saved.boards || [])) {
        boards.set(projectId, restoreTaskBoard(tasks, projectId));
      }
      for (const run of (saved.workflowRuns || [])) {
        if (run?.id) workflowRuns.set(run.id, run);
      }
      for (const proposal of (saved.workflowProposals || [])) {
        if (proposal?.id) workflowProposals.set(proposal.id, proposal);
      }
      if (!silent) console.log(`[hub] Restored ${saved.projects.length} projects from disk`);
    }
  }

  function persistState() {
    if (!persistence) return;
    persistence.save(() => ({
      projects: [...projects.values()],
      boards: [...boards.entries()].map(([projectId, board]) => ({
        projectId,
        tasks: board.getAllTasks(),
      })),
      workflowRuns: [...workflowRuns.values()],
      workflowProposals: [...workflowProposals.values()],
      humanActions,
    }));
  }

  // Human action log — tracks all human decisions
  const humanActions = [];

  if (persistence) {
    const reconciliation = reconcileRecoveredScriptWorkflowProjectDeliveries();
    if (reconciliation.delivered.length > 0 || reconciliation.blocked.length > 0) {
      persistState();
    }
  }

  function recordHumanAction(action, data) {
    const entry = { ts: new Date().toISOString(), action, ...data };
    humanActions.push(entry);
    return entry;
  }

  function prepareTasksForBoard(project, taskList) {
    return expandCompositeTasks(taskList, {
      projectId: project.id,
      members: project.members || [],
      poAgent: project.poAgent,
    });
  }

  function buildDispatchPlan(projectId) {
    const board = boards.get(projectId);
    if (!board) return null;
    const project = projects.get(projectId);
    return planDispatch({
      projectId,
      tasks: board.getAllTasks(),
      allActiveTasks: getActiveTasksAcrossLiveProjects(),
      agentProfiles: getProjectAgentProfiles(project),
      agentConcurrency: typeof runtimeInstanceAllocator?.getAgentConcurrency === 'function'
        ? runtimeInstanceAllocator.getAgentConcurrency()
        : {},
    });
  }

  function getProjectAgentProfiles(project) {
    const profiles = listAgentProfiles(typeof getAgentProfiles === 'function' ? getAgentProfiles() : null);
    if (!project) return profiles;
    const allowed = new Set([
      project.poAgent,
      ...(Array.isArray(project.members) ? project.members : []),
    ].map(normalizeAgentId).filter(Boolean));
    if (allowed.size === 0) return profiles;
    return profiles.filter(agent => allowed.has(normalizeAgentId(agent?.id)));
  }

  function listAgentProfiles(agentProfiles) {
    if (agentProfiles instanceof Map) return [...agentProfiles.values()];
    if (Array.isArray(agentProfiles)) return agentProfiles;
    if (agentProfiles && typeof agentProfiles === 'object') return Object.values(agentProfiles);
    return [];
  }

  function normalizeAgentId(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : '';
  }

  function getActiveTasksAcrossLiveProjects() {
    const liveBoards = new Map();
    for (const [projectId, board] of boards.entries()) {
      if (isLiveProject(projects.get(projectId))) liveBoards.set(projectId, board);
    }
    return getActiveTasksAcrossBoards(liveBoards);
  }

  function isLiveProject(project) {
    return Boolean(project && project.status !== 'closed' && project.status !== 'delivered');
  }

  function updatePlanItemCompleted(project, task) {
    if (!project?.plan) return;
    for (const phase of project.plan.phases || []) {
      const item = (phase.items || []).find(i => i.id === task.planItemId || i.title === task.title);
      if (item) { item.status = 'completed'; break; }
    }
  }

  function maybeCompleteCompositeParent(projectId, childTask) {
    if (!childTask?.parentTaskId) return null;
    const board = boards.get(projectId);
    const parent = board?.getTask(childTask.parentTaskId);
    if (!parent?.isCompositeParent || parent.status === 'done') return null;
    const children = (parent.childTaskIds || []).map(id => board.getTask(id)).filter(Boolean);
    if (children.length !== parent.childTaskIds.length || children.some(child => child.status !== 'done')) return null;
    const finalChild = [...children].reverse().find(child => child.compositeRole === 'final') || childTask;
    const result = board.completeCompositeParent(parent.id, finalChild.result || childTask.result || null);
    if (result.ok) {
      const project = projects.get(projectId);
      updatePlanItemCompleted(project, parent);
      eventLog.emit('task.done', {
        projectId,
        taskId: parent.id,
        taskTitle: parent.title,
        confirmedBy: 'composite_children',
      });
    }
    return result;
  }

  function maybeCompleteRetryParent(projectId, retryTask) {
    if (!retryTask?.parentTaskId) return null;
    const board = boards.get(projectId);
    const parent = board?.getTask(retryTask.parentTaskId);
    if (!parent || parent.isCompositeParent || parent.status === 'done') return null;
    if (retryTask.status !== 'done') return null;
    const result = board.completeRetryParent(parent.id, retryTask.result || null, {
      completedBy: 'retry_child',
      completedByTaskId: retryTask.id,
      recoveredBy: retryTask.completedBy || 'retry_child',
      recoveryReason: 'retry_child_completed',
    });
    if (result.ok && !result.alreadyDone) {
      const project = projects.get(projectId);
      updatePlanItemCompleted(project, parent);
      eventLog.emit('task.done', {
        projectId,
        taskId: parent.id,
        taskTitle: parent.title,
        confirmedBy: 'retry_child',
        retryTaskId: retryTask.id,
      });
    }
    return result;
  }

  // ─── Project lifecycle ─────────────────────────────────────────────

  function createProject({ id, name, goal, requirements, planningGuidance, poAgent, members = [], enableSummary, agentSelection = null, preparationContext = null, executionMode = 'direct', autoAssignPo = true, clientRequestKey }) {
    const createdAt = Date.now();
    const normalizedClientRequestKey = normalizeProjectCreateClientRequestKey(clientRequestKey);
    const effectiveName = normalizeProjectNameForDisplay(name);
    const normalizedPoAgent = normalizeAgentId(poAgent);
    const normalizedMembers = normalizeAgentIdList(members).filter(agentId => agentId !== normalizedPoAgent);
    const qualityRuleSet = compileEffectiveQualityRuleSet({
      goal: goal || '',
      requirements: requirements || '',
      overlays: typeof getQualityOverlays === 'function' ? getQualityOverlays() : [],
      now: createdAt,
    });
    const qualityPlanningGuidance = qualityRuleSet.rules.length > 0
      ? buildQualityPromptExcerpt(qualityRuleSet, { role: 'po', budgetChars: 1600 }).text
      : '';
    const effectivePlanningGuidance = appendQualityPlanningGuidance(planningGuidance || '', qualityPlanningGuidance);
    const project = {
      id,
      name: effectiveName,
      goal,
      requirements: requirements || '',
      planningGuidance: planningGuidance || '',
      qualityRuleSet,
      qualityPlanningGuidance,
      agentSelection: normalizeAgentSelection({ poAgent: normalizedPoAgent, members: normalizedMembers, agentSelection }),
      preparation: null,
      poAgent: normalizedPoAgent,
      members: normalizedMembers,
      executionMode: normalizeProjectExecutionMode(executionMode),
      executionModeUpdatedAt: createdAt,
      executionModeUpdatedBy: 'system_default',
      status: 'created',  // created → planning → active → closed
      createdAt,
      closedAt: null,
      closedBy: null,
      deliverable: null,
      plan: null,           // Plan-Do: structured plan set by PO
      planArtifact: null,   // URL to plan markdown artifact
      enableSummary: enableSummary !== false,  // default true, backwards-compatible
      summary: null,        // Project summary section text (set at synthesize)
      summaryScore: null,   // Project score 1-10 (parsed from synthesis)
    };
    if (normalizedClientRequestKey) {
      project.clientRequestKey = normalizedClientRequestKey;
    }
    projects.set(id, project);
    boards.set(id, createTaskBoard(id));

    eventLog.emit('project.created', { projectId: id, projectName: effectiveName, po: normalizedPoAgent });
    recordHumanAction('create_project', { projectId: id, projectName: effectiveName, poAgent: normalizedPoAgent });

    if (preparationContext) {
      project.preparation = deriveProjectPreparation({
        ...preparationContext,
        project,
      });
      eventLog.emit('project.preparation_checked', {
        projectId: id,
        state: project.preparation.state,
        blockers: project.preparation.blockers,
      });
    }

    if (autoAssignPo !== false && (!project.preparation || project.preparation.state === 'ready')) {
      sendAssignPo(project, effectivePlanningGuidance);
    }
    return project;
  }

  function findReusableProjectForCreateRequest({ clientRequestKey } = {}) {
    const normalizedClientRequestKey = normalizeProjectCreateClientRequestKey(clientRequestKey);
    if (normalizedClientRequestKey) {
      const exact = [...projects.values()]
        .find(project => normalizeProjectCreateClientRequestKey(project.clientRequestKey) === normalizedClientRequestKey);
      if (exact) return exact;
    }
    return null;
  }

  function normalizeProjectNameForDisplay(value) {
    if (typeof value !== 'string') return '未命名项目';
    return value.trim().replace(/\s+/g, ' ') || '未命名项目';
  }

  function normalizeProjectCreateClientRequestKey(value) {
    if (typeof value !== 'string') return '';
    return value.trim().replace(/\s+/g, ' ').slice(0, 240);
  }

  function normalizeAgentIdList(values = []) {
    const result = [];
    for (const value of Array.isArray(values) ? values : []) {
      const agentId = normalizeAgentId(value);
      if (agentId && !result.includes(agentId)) result.push(agentId);
    }
    return result;
  }

  function normalizeSelectionMember(member, index, members, fallbackSource) {
    const record = member && typeof member === 'object' && !Array.isArray(member) ? member : null;
    const agentId = record
      ? (normalizeAgentId(record.agentId) || normalizeAgentId(record.id) || normalizeAgentId(members[index]))
      : (normalizeAgentId(member) || normalizeAgentId(members[index]));
    if (!agentId) return null;
    return {
      agentId,
      source: record?.source || fallbackSource,
    };
  }

  function normalizeAgentSelection({ poAgent, members = [], agentSelection = null } = {}) {
    return {
      ...(agentSelection && typeof agentSelection === 'object' ? agentSelection : {}),
      poAgent: {
        agentId: normalizeAgentId(agentSelection?.poAgent?.agentId) || normalizeAgentId(poAgent),
        source: agentSelection?.poAgent?.source || 'system_migration',
      },
      members: Array.isArray(agentSelection?.members)
        ? agentSelection.members
          .map((member, index) => normalizeSelectionMember(member, index, members, 'system_migration'))
          .filter(Boolean)
        : normalizeAgentIdList(members).map(agentId => ({
            agentId,
            source: 'system_migration',
      })),
    };
  }

  function normalizeRecoveredProject(project) {
    const normalized = {
      ...project,
      executionMode: normalizeProjectExecutionMode(project?.executionMode),
    };
    reconcileProjectAgentSelectionWithEffectiveAgents(normalized);
    normalized.preparation = normalizeRecoveredProjectPreparation(normalized, normalized.preparation);
    return normalized;
  }

  function normalizeRecoveredProjectPreparation(project, preparation) {
    if (!preparation || typeof preparation !== 'object') return preparation || null;
    const selectedAgentIds = new Set([
      normalizeAgentId(project?.poAgent),
      ...normalizeAgentIdList(project?.members || []),
    ].filter(Boolean));
    const keepSelectedRecord = record => {
      const agentId = normalizeAgentId(record?.agentId || record?.participantId);
      return agentId && selectedAgentIds.has(agentId);
    };
    const checks = (Array.isArray(preparation.checks) ? preparation.checks : [])
      .filter(keepSelectedRecord);
    const blockers = (Array.isArray(preparation.blockers) ? preparation.blockers : [])
      .filter(keepSelectedRecord);
    if (checks.length === 0 && blockers.length === 0) return null;
    return {
      ...preparation,
      checks,
      blockers,
      state: blockers.length > 0 ? 'blocked' : 'ready',
    };
  }

  function updateProjectExecutionMode(projectId, executionMode, { updatedBy = 'human', now = Date.now() } = {}) {
    const project = projects.get(projectId);
    if (!project) return { ok: false, error: 'project_not_found' };
    if (!isValidProjectExecutionMode(executionMode)) return { ok: false, error: 'invalid_execution_mode' };
    const normalized = normalizeProjectExecutionMode(executionMode);
    project.executionMode = normalized;
    project.executionModeUpdatedAt = now;
    project.executionModeUpdatedBy = updatedBy;
    project.updatedAt = now;
    eventLog.emit('project.execution_mode.updated', {
      projectId,
      executionMode: normalized,
      updatedBy,
    });
    recordHumanAction('update_project_execution_mode', { projectId, executionMode: normalized, updatedBy });
    return { ok: true, project };
  }

  function selectionForTask(project, task) {
    const assignedAgent = normalizeAgentId(task?.assignedAgent);
    if (!project?.agentSelection || !assignedAgent) return { agentId: assignedAgent, source: 'system_migration' };
    if (normalizeAgentId(project.agentSelection.poAgent?.agentId) === assignedAgent) {
      return { agentId: assignedAgent, source: project.agentSelection.poAgent?.source || 'system_migration' };
    }
    const member = (Array.isArray(project.agentSelection.members) ? project.agentSelection.members : [])
      .find(item => normalizeAgentId(item?.agentId || item?.id || item) === assignedAgent);
    return {
      agentId: assignedAgent,
      source: member?.source || 'system_migration',
    };
  }

  function sendAssignPo(project, effectivePlanningGuidance) {
    if (bridge) {
      bridge.send({
        type: 'intent', kind: 'assign_po',
        projectId: project.id, toParticipantId: project.poAgent,
        payload: {
          name: project.name,
          goal: project.goal,
          requirements: project.requirements || '',
          planningGuidance: effectivePlanningGuidance ?? appendQualityPlanningGuidance(project.planningGuidance || '', project.qualityPlanningGuidance || ''),
        },
      });
    }

    eventLog.emit('po.assigned', { projectId: project.id, agent: project.poAgent });
  }

  // ─── Human actions ─────────────────────────────────────────────────

  /**
   * Human 审批计划 → project becomes active
   */
  function handleApprove(projectId) {
    const project = projects.get(projectId);
    if (!project) return { ok: false, error: 'project_not_found' };

    // Idempotency: already active → no-op success (don't re-trigger events)
    if (project.status === 'active') {
      return { ok: true, alreadyActive: true };
    }

    // Guard: plan or tasks must exist before approval
    const board = boards.get(projectId);
    if (!project.plan && board && board.getAllTasks().length === 0) {
      return { ok: false, error: 'no_plan_or_tasks' };
    }

    project.status = 'active';
    eventLog.emit('project.approved', { projectId });
    recordHumanAction('approve_plan', { projectId, projectName: project.name });

    if (bridge) {
      bridge.send({
        type: 'intent', kind: 'plan_approved',
        projectId, toParticipantId: project.poAgent,
        payload: {},
      });
    }
    return { ok: true };
  }

  /**
   * 重新触发 PO 制定计划 — 用于计划卡住或失败后重试
   */
  function handleRetryPlan(projectId) {
    const project = projects.get(projectId);
    if (!project) return { ok: false, error: 'project_not_found' };
    if (!bridge) return { ok: false, error: 'no_bridge' };
    const board = boards.get(projectId);
    const normalized = normalizeProjectForPlanRetry(project, board?.getAllTasks() || []);
    if (!normalized.ok) return normalized;

    bridge.send({
      type: 'intent', kind: 'assign_po',
      projectId: project.id, toParticipantId: project.poAgent,
      payload: {
        name: project.name,
        goal: project.goal,
        requirements: project.requirements || '',
        planningGuidance: appendQualityPlanningGuidance(project.planningGuidance || '', project.qualityPlanningGuidance || ''),
      },
    });

    eventLog.emit('plan.retry', { projectId, po: project.poAgent, previousStatus: normalized.previousStatus });
    return { ok: true, ...normalized };
  }

  /**
   * Human 添加任务（任何时候都可以）
   * 不需要是 PO，Human 就是老板
   */
  function handleHumanAddTasks(projectId, taskList) {
    const project = projects.get(projectId);
    if (!project) return { ok: false, error: 'project_not_found' };

    const board = boards.get(projectId);
    const prepared = prepareTasksForBoard(project, taskList);
    if (!prepared.ok) return prepared;
    const added = board.addTasksChecked(prepared.tasks);
    if (!added.ok) return added;
    const ids = added.taskIds;

    // If project was 'created', move to planning
    if (project.status === 'created') {
      project.status = 'planning';
    }

    eventLog.emit('tasks.added_by_human', {
      projectId,
      count: ids.length,
      tasks: prepared.tasks.map(t => ({ id: t.id, title: t.title, assignedAgent: t.assignedAgent })),
    });
    recordHumanAction('add_tasks', {
      projectId, projectName: project.name,
      taskCount: taskList.length,
      tasks: taskList.map(t => t.title),
    });

    return { ok: true, taskIds: ids };
  }

  /**
   * Human 关闭项目（唯一能关闭的角色）
   */
  function handleCloseProject(projectId, summary) {
    const project = projects.get(projectId);
    if (!project) return { ok: false, error: 'project_not_found' };
    if (project.status === 'closed') return { ok: false, error: 'already_closed' };

    project.status = 'closed';
    project.closedAt = Date.now();
    project.closedBy = 'human';
    if (summary) project.closeSummary = summary;

    eventLog.emit('project.closed', { projectId, projectName: project.name, summary });
    recordHumanAction('close_project', { projectId, projectName: project.name, summary });

    return { ok: true };
  }

  /**
   * Human 彻底删除项目（从列表中移除）
   */
  function deleteProject(projectId) {
    const project = projects.get(projectId);
    if (!project) return { ok: false, error: 'project_not_found' };

    projects.delete(projectId);
    boards.delete(projectId);

    eventLog.emit('project.deleted', { projectId, projectName: project.name });
    recordHumanAction('delete_project', { projectId, projectName: project.name });

    return { ok: true };
  }

  // ─── PO actions ────────────────────────────────────────────────────

  /**
   * PO 提交分解好的任务列表
   */
  function handleCreateTasks(projectId, taskList, fromAgent) {
    const project = projects.get(projectId);
    if (!project) return { ok: false, error: 'project_not_found' };
    if (project.poAgent !== fromAgent) return { ok: false, error: 'not_po' };

    const board = boards.get(projectId);
    const prepared = prepareTasksForBoard(project, taskList);
    if (!prepared.ok) return prepared;
    const added = board.addTasksChecked(prepared.tasks);
    if (!added.ok) return added;
    const ids = added.taskIds;

    if (project.status === 'created') project.status = 'planning';
    eventLog.emit('tasks.created', {
      projectId, count: ids.length, by: fromAgent,
      tasks: prepared.tasks.map(t => ({ id: t.id, title: t.title, assignedAgent: t.assignedAgent })),
    });

    return { ok: true, taskIds: ids, expandedComposites: prepared.composites || [] };
  }

  function handleAssignTask(projectId, taskId, targetAgent, fromAgent) {
    const project = projects.get(projectId);
    if (!project || project.poAgent !== fromAgent) return { ok: false, error: 'not_po' };

    const board = boards.get(projectId);
    const task = board.getTask(taskId);
    if (!task) return { ok: false, error: 'task_not_found' };

    task.assignedAgent = targetAgent;
    eventLog.emit('task.assigned', { projectId, taskId, taskTitle: task.title, agent: targetAgent, by: fromAgent });

    return { ok: true };
  }

  function handleReassignTask(projectId, taskId, { newAgent, reason = 'reassigned', fromPO = null } = {}) {
    const project = projects.get(projectId);
    if (!project) return { ok: false, error: 'project_not_found' };
    if (!newAgent) return { ok: false, error: 'new_agent_required' };

    const board = boards.get(projectId);
    const task = board?.getTask(taskId);
    if (!task) return { ok: false, error: 'task_not_found' };

    const previousStatus = task.status;
    let result = { ok: true };
    if (task.status === 'in_progress') {
      result = board.transition(task.id, 'failed', { failureReason: reason || 'reassigned' });
      if (result.ok) result = board.transition(task.id, 'pending');
    } else if (['dispatched', 'accepted', 'failed', 'blocked'].includes(task.status)) {
      result = board.transition(task.id, 'pending');
    } else if (task.status !== 'pending') {
      return { ok: false, error: `cannot_reassign_from_status: ${task.status}` };
    }

    if (!result?.ok) return result;

    const updatedTask = board.getTask(task.id);
    updatedTask.assignedAgent = newAgent;
    updatedTask.recoveryStatus = 'redispatch_ready';
    updatedTask.recoveryReason = reason || 'manual_reassign';

    eventLog.emit('task.reassigned', {
      projectId,
      taskId: updatedTask.id,
      taskTitle: updatedTask.title,
      newAgent,
      previousStatus,
      reason,
      by: fromPO || project.poAgent || 'system',
    });

    const dispatch = project.status === 'active'
      ? handleRequestDispatch(projectId, project.poAgent)
      : { ok: false, dispatched: [], error: 'project_not_active' };

    return {
      ok: true,
      taskId: updatedTask.id,
      newAgent,
      previousStatus,
      dispatched: dispatch.ok ? dispatch.dispatched : [],
      dispatch,
    };
  }

  function handleRequestDispatch(projectId, fromAgent, options = {}) {
    const project = projects.get(projectId);
    if (!project) return { ok: false, error: 'project_not_found' };
    if (project.status !== 'active') return { ok: false, error: 'project_not_active' };
    if (project.poAgent !== fromAgent) return { ok: false, error: 'not_po' };

    const board = boards.get(projectId);
    const dispatchPlan = buildDispatchPlan(projectId);
    const onlyTaskIds = new Set((options.onlyTaskIds || []).map(String));
    const plannedTasks = onlyTaskIds.size > 0
      ? dispatchPlan.dispatchedTasks.filter(task => onlyTaskIds.has(task.id))
      : dispatchPlan.dispatchedTasks;
    const dispatched = [];
    const workflowDispatched = [];
    const workflowNodeDispatches = [];
    const workflowRunsStarted = [];
    const skipped = [...(dispatchPlan.skipped || [])];

    const projectExecutionMode = normalizeProjectExecutionMode(project.executionMode);
    const explicitTaskWorkflowDispatch = onlyTaskIds.size > 0 && plannedTasks.some(task => {
      const currentTask = board.getTask(task.id) || task;
      const selection = selectTaskExecutionStrategy({ project, task: currentTask });
      return selection.strategy === 'workflow' && selection.modeSource === 'manual_override';
    });

    const taskGraphHasDispatchableWork = plannedTasks.length > 0;
    if (projectExecutionMode === 'workflow_preferred' && !explicitTaskWorkflowDispatch && !taskGraphHasDispatchableWork) {
      const activeProjectWorkflow = findActiveProjectExecutionWorkflow(project.id);
      if (activeProjectWorkflow) {
        return {
          ok: true,
          dispatched,
          workflowDispatched,
          workflowNodeDispatches,
          workflowRuns: workflowRunsStarted,
          skipped,
          blocked: dispatchPlan.blocked,
          projectGate: 'project_workflow_running',
          activeProjectWorkflowRun: activeProjectWorkflow,
        };
      }

      const workflowResult = startProjectWorkflowFromDispatch({
        project,
        board,
        requestedBy: fromAgent,
        now: Date.now(),
      });
      if (!workflowResult.ok) {
        skipped.push({
          reason: workflowResult.error || 'project_workflow_dispatch_failed',
        });
        return {
          ok: true,
          dispatched,
          workflowDispatched,
          workflowNodeDispatches,
          workflowRuns: workflowRunsStarted,
          skipped,
          blocked: dispatchPlan.blocked,
          projectGate: dispatchPlan.projectGate,
        };
      }

      workflowRunsStarted.push(workflowResult.workflowRun);
      workflowNodeDispatches.push(...(workflowResult.dispatches || []));
      return {
        ok: true,
        dispatched,
        workflowDispatched,
        workflowNodeDispatches,
        workflowRuns: workflowRunsStarted,
        skipped,
        blocked: dispatchPlan.blocked,
        projectGate: 'project_workflow_running',
      };
    }

    for (const task of plannedTasks) {
      const currentTask = board.getTask(task.id);
      if (isReworkReadyForDispatch(currentTask)) {
        const reset = board.transition(task.id, 'pending', {
          failureReason: currentTask.failureReason,
          failureClass: currentTask.lastFailureClass,
          qualityFailureCount: currentTask.qualityFailureCount,
        });
        if (!reset.ok) continue;
      }
      const latestTask = {
        ...(board.getTask(task.id) || task),
        selectedRoute: task.selectedRoute || null,
        preferredAssignedAgent: task.preferredAssignedAgent || null,
        assignedAgent: task.assignedAgent,
      };
      const executionSelection = selectTaskExecutionStrategy({ project, task: latestTask });
      if (executionSelection.strategy === 'workflow') {
        const workflowResult = startTaskWorkflowFromDispatch({
          project,
          board,
          task: latestTask,
          selection: executionSelection,
          requestedBy: fromAgent,
          now: Date.now() + workflowRunsStarted.length * 2,
        });
        if (!workflowResult.ok) {
          skipped.push({
            taskId: task.id,
            reason: workflowResult.error || 'workflow_dispatch_failed',
            agent: task.assignedAgent,
          });
          continue;
        }
        workflowDispatched.push(task.id);
        workflowRunsStarted.push(workflowResult.workflowRun);
        workflowNodeDispatches.push(...(workflowResult.dispatches || []));
        continue;
      }
      let assignedRuntimeInstance = task.assignedRuntimeInstance || null;
      if (typeof runtimeInstanceAllocator?.reserveWorkerInstance === 'function') {
        const reservation = runtimeInstanceAllocator.reserveWorkerInstance({ project, task });
        if (reservation?.ok) {
          assignedRuntimeInstance = reservation.instanceId || null;
        } else if (reservation?.error && reservation.error !== 'not_pooled_agent') {
          skipped.push({
            taskId: task.id,
            reason: reservation.error === 'capacity_full' ? 'xiaok_capacity_full' : reservation.error,
            agent: task.assignedAgent,
          });
          continue;
        }
      }
      const result = board.transition(task.id, 'dispatched', {
        assignedAgent: task.assignedAgent,
        assignedExecutor: null,
        assignedRuntimeInstance,
        selectedRoute: task.selectedRoute || null,
      });
      if (!result.ok) continue;
      const storedTask = board.getTask(task.id);
      if (storedTask) {
        storedTask.execution = buildTaskExecutionMetadata(executionSelection, {
          workflowRunId: null,
          selectedAt: Date.now(),
        });
      }

      if (bridge) {
        const targetParticipantId = assignedRuntimeInstance || task.assignedAgent;
        const handoff = createTaskHandoffPackage({
          projectRoot: project.workFolder || project.workspacePath || (dataDir ? join(dirname(dataDir), 'handoffs', projectId) : join(tmpdir(), 'kswarm-handoffs', projectId)),
          project,
          task,
          runId: result.runId,
          targetParticipantId,
        });
        if (!handoff.ok) {
          skipped.push({ taskId: task.id, reason: handoff.error, agent: task.assignedAgent });
          continue;
        }
        bridge.requestTask({
          taskId: task.id, title: task.title, brief: task.brief,
          projectId,
          localTaskId: task.localTaskId,
          runId: result.runId,
          attempt: task.attempt || 1,
          projectName: project.name, targetParticipantId,
          handoffPath: handoff.handoffPath,
        });
      }

      eventLog.emit('task.dispatched', {
        projectId, taskId: task.id, taskTitle: task.title, agent: task.assignedAgent, target: assignedRuntimeInstance || task.assignedAgent, runtimeInstance: assignedRuntimeInstance, executionStrategy: 'direct', executionReasonCode: executionSelection.reasonCode,
      });
      dispatched.push(task.id);
    }

    return {
      ok: true,
      dispatched,
      workflowDispatched,
      workflowNodeDispatches,
      workflowRuns: workflowRunsStarted,
      skipped,
      blocked: dispatchPlan.blocked,
      projectGate: dispatchPlan.projectGate,
    };
  }

  function startTaskWorkflowFromDispatch({ project, board, task, selection, requestedBy = 'xiaok-po', now = Date.now() } = {}) {
    if (!project || !board || !task?.id) return { ok: false, error: 'task_required' };
    const proposal = createWorkflowProposal(project.id, PO_GENERATED_TASK_WORKFLOW_ID, {
      requestedBy: requestedBy || project.poAgent || 'kswarm',
      taskId: task.id,
      now,
    });
    if (!proposal.ok) return proposal;

    const started = startWorkflowRunFromProposal(proposal.workflowProposal.id, {
      projectId: project.id,
      workflowId: PO_GENERATED_TASK_WORKFLOW_ID,
      taskId: task.id,
      approvedBy: requestedBy || project.poAgent || 'kswarm',
      now: now + 1,
    });
    if (!started.ok) return started;

    const transition = board.transition(task.id, 'dispatched', {
      assignedAgent: task.assignedAgent,
      assignedExecutor: null,
      selectedRoute: task.selectedRoute || null,
      preferredAssignedAgent: task.preferredAssignedAgent || null,
      runId: `workflow-${started.workflowRun.id}`,
      leaseTimeoutMs: 24 * 60 * 60 * 1000,
    });
    if (!transition.ok) {
      cancelWorkflowRun(started.workflowRun.id, { reason: 'task_transition_failed', now: now + 2 });
      return { ok: false, error: transition.error || 'task_transition_failed' };
    }

    const storedTask = board.getTask(task.id);
    if (storedTask) {
      storedTask.execution = buildTaskExecutionMetadata(selection, {
        workflowRunId: started.workflowRun.id,
        selectedAt: now + 1,
      });
      storedTask.assignedExecutor = 'workflow';
      storedTask.activeRunId = `workflow-${started.workflowRun.id}`;
      storedTask.runLease = null;
      storedTask.updatedAt = now + 1;
    }

    eventLog.emit('task.workflow_dispatched', {
      projectId: project.id,
      taskId: task.id,
      taskTitle: task.title,
      workflowRunId: started.workflowRun.id,
      workflowId: started.workflowRun.workflowId,
      executionStrategy: 'workflow',
      executionReasonCode: selection.reasonCode,
      modeSource: selection.modeSource,
    });

    return { ok: true, workflowRun: started.workflowRun, workflowProposal: started.workflowProposal, dispatches: started.dispatches || [] };
  }

  function startProjectWorkflowFromDispatch({ project, board, requestedBy = 'xiaok-po', now = Date.now() } = {}) {
    if (!project || !board) return { ok: false, error: 'project_required' };
    const proposal = createWorkflowProposal(project.id, PO_GENERATED_PROJECT_WORKFLOW_ID, {
      requestedBy: requestedBy || project.poAgent || 'kswarm',
      now,
    });
    if (!proposal.ok) return proposal;

    const started = startWorkflowRunFromProposal(proposal.workflowProposal.id, {
      projectId: project.id,
      workflowId: PO_GENERATED_PROJECT_WORKFLOW_ID,
      approvedBy: requestedBy || project.poAgent || 'kswarm',
      now: now + 1,
    });
    if (!started.ok) return started;

    eventLog.emit('project.workflow_dispatched', {
      projectId: project.id,
      workflowRunId: started.workflowRun.id,
      workflowId: started.workflowRun.workflowId,
      executionStrategy: 'workflow',
      executionReasonCode: 'project_workflow_preferred',
      modeSource: 'project_default',
    });

    return { ok: true, workflowRun: started.workflowRun, workflowProposal: started.workflowProposal, dispatches: started.dispatches || [] };
  }

  /**
   * PO 确认任务完成（审核通过）
   */
  function handleMarkDone(projectId, taskId, fromAgent) {
    const project = projects.get(projectId);
    if (!project || project.poAgent !== fromAgent) return { ok: false, error: 'not_po' };

    const board = boards.get(projectId);
    const task = board.getTask(taskId);
    if (!task) return { ok: false, error: 'task_not_found' };
    const result = board.transition(task.id, 'done');
    if (result.ok) {
      updatePlanItemCompleted(project, task);
      eventLog.emit('task.done', {
        projectId, taskId: result.taskId, taskTitle: task?.title, confirmedBy: fromAgent,
      });
      maybeCompleteCompositeParent(projectId, task);
      maybeCompleteRetryParent(projectId, task);
    }
    return result;
  }

  function handleRework(projectId, taskId, reason, fromAgent) {
    const project = projects.get(projectId);
    if (!project || project.poAgent !== fromAgent) return { ok: false, error: 'not_po' };

    const board = boards.get(projectId);
    const task = board.getTask(taskId);
    const result = board.transition(taskId, 'in_progress');
    if (result.ok) {
      eventLog.emit('task.rework', { projectId, taskId: result.taskId, taskTitle: task?.title, reason, by: fromAgent });
      if (bridge && task.assignedAgent) {
        bridge.send({
          type: 'intent', kind: 'rework',
          taskId: result.taskId, toParticipantId: task.assignedAgent,
          payload: { reason, projectId },
        });
      }
    }
    return result;
  }

  /**
   * 任务失败处理 — 自动重试
   */
  function handleTaskFail(projectId, taskId, failureReason, errorMessage) {
    const project = projects.get(projectId);
    if (!project) return { ok: false, error: 'project_not_found' };

    const board = boards.get(projectId);
    const task = board.getTask(taskId);
    if (!task) return { ok: false, error: 'task_not_found' };

    const { classifyFailure, shouldAutoRetry, createRetryTask } = retryStrategy;
    const reason = failureReason || classifyFailure(errorMessage);

    // Mark current task as failed
    const result = board.transition(task.id, 'failed', { failureReason: reason, failureClass: reason });
    if (!result.ok) return result;

    eventLog.emit('task.failed', {
      projectId, taskId: task.id, taskTitle: task.title, failureReason: reason,
      errorMessage: errorMessage || '',
    });

    const replacement = planAgentReplacement({
      task,
      failureClass: reason,
      agents: getProjectAgentProfiles(project),
      selection: selectionForTask(project, task),
      priorReplacements: task.replacementHistory || [],
      replacementBudget: project.agentSelection?.replacementBudget || {},
    });
    if (replacement.action === 'repair_output_contract') {
      return {
        ok: true,
        taskId: task.id,
        retried: false,
        replacement,
        failureReason: reason,
      };
    }
    if (replacement.action === 'replace' && replacement.toAgentId) {
      const reset = board.transition(task.id, 'pending', { failureReason: reason, failureClass: reason });
      if (!reset.ok) return reset;
      const replacedTask = board.getTask(task.id);
      replacedTask.assignedAgent = replacement.toAgentId;
      replacedTask.replacementHistory = Array.isArray(replacedTask.replacementHistory) ? replacedTask.replacementHistory : [];
      replacedTask.replacementHistory.push({
        at: Date.now(),
        fromAgentId: replacement.fromAgentId,
        toAgentId: replacement.toAgentId,
        failureClass: reason,
        source: selectionForTask(project, task).source || 'system_migration',
      });
      replacedTask.recoveryStatus = 'redispatch_ready';
      replacedTask.recoveryReason = 'agent_replaced_after_basic_invocation_failure';
      eventLog.emit('task.agent_replaced', {
        projectId,
        taskId: replacedTask.id,
        fromAgentId: replacement.fromAgentId,
        toAgentId: replacement.toAgentId,
        failureReason: reason,
      });
      const dispatch = project.status === 'active'
        ? handleRequestDispatch(projectId, project.poAgent, { onlyTaskIds: [replacedTask.id] })
        : { ok: false, dispatched: [], skipped: [], error: 'project_not_active' };
      return {
        ok: true,
        taskId: replacedTask.id,
        retried: false,
        replaced: true,
        replacement,
        fromAgentId: replacement.fromAgentId,
        toAgentId: replacement.toAgentId,
        replacementDispatched: dispatch.ok ? dispatch.dispatched.includes(replacedTask.id) : false,
        replacementDispatch: dispatch,
        failureReason: reason,
      };
    }
    if (replacement.action === 'needs_user_confirmation') {
      const blocked = board.blockTask(task.id, {
        blockKind: 'agent_replacement_confirmation_required',
        blockedReason: '显式选择的智能体不可用，需要确认是否更换执行者。',
        failureClass: reason,
        nextActions: [
          {
            id: 'replace_agent_confirm',
            label: '确认更换执行者',
            candidates: replacement.candidates,
          },
        ],
      });
      const blockedTask = board.getTask(task.id);
      blockedTask.replacementPlan = replacement;
      return {
        ok: blocked.ok,
        taskId: task.id,
        retried: false,
        replaced: false,
        replacement,
        blocked: true,
        failureReason: reason,
      };
    }

    // Decide: auto-retry or not
    const shouldRetry = shouldAutoRetry(task);
    if (!silent) console.log('[Retry] task:', JSON.stringify({ id: task.id, attempt: task.attempt, maxAttempts: task.maxAttempts, failureReason: task.failureReason, shouldRetry }));
    if (shouldRetry) {
      const retryTask = createRetryTask(task);
      const added = board.addTasksChecked([retryTask]);
      if (!added.ok) return added;
      const retryTaskId = added.taskIds[0];
      const storedRetryTask = board.getTask(retryTaskId);
      const retryDispatchPlan = storedRetryTask ? planDispatch({
        projectId,
        tasks: [storedRetryTask],
        allActiveTasks: getActiveTasksAcrossLiveProjects(),
        agentProfiles: getProjectAgentProfiles(project),
        agentConcurrency: typeof runtimeInstanceAllocator?.getAgentConcurrency === 'function'
          ? runtimeInstanceAllocator.getAgentConcurrency()
          : {},
      }) : { dispatchedTasks: [], skipped: [] };

      let retryDispatched = false;
      let retryDispatchError = null;
      const routedRetry = retryDispatchPlan.dispatchedTasks[0];
      let assignedRuntimeInstance = routedRetry?.assignedRuntimeInstance || null;
      if (routedRetry) {
        if (typeof runtimeInstanceAllocator?.reserveWorkerInstance === 'function') {
          const reservation = runtimeInstanceAllocator.reserveWorkerInstance({ project, task: routedRetry });
          if (reservation?.ok) {
            assignedRuntimeInstance = reservation.instanceId || null;
          } else if (reservation?.error && reservation.error !== 'not_pooled_agent') {
            retryDispatchPlan.skipped.push({
              taskId: routedRetry.id,
              reason: reservation.error === 'capacity_full' ? 'xiaok_capacity_full' : reservation.error,
              agent: routedRetry.assignedAgent,
            });
            retryDispatchError = reservation.error;
          }
        }
      }
      if (routedRetry && !retryDispatchError) {
        const dispatchedRetry = board.transition(routedRetry.id, 'dispatched', {
          assignedAgent: routedRetry.assignedAgent,
          assignedExecutor: null,
          assignedRuntimeInstance,
          preferredAssignedAgent: routedRetry.preferredAssignedAgent || null,
          selectedRoute: routedRetry.selectedRoute || null,
        });
        retryDispatched = dispatchedRetry.ok;
        retryDispatchError = dispatchedRetry.ok ? null : dispatchedRetry.error;
      }
      const finalRetryTask = board.getTask(retryTaskId);

      eventLog.emit('task.retry', {
        projectId,
        originalTaskId: task.id,
        retryTaskId,
        attempt: retryTask.attempt,
        failureReason: reason,
        assignedAgent: finalRetryTask?.assignedAgent || retryTask.assignedAgent,
        retryDispatched,
        skipped: retryDispatchPlan.skipped,
      });

      return {
        ok: true,
        taskId: task.id,
        retried: true,
        retryTaskId,
        retryDispatched,
        retryDispatchError,
        retryDispatchSkipped: retryDispatchPlan.skipped,
        attempt: retryTask.attempt,
        failureReason: reason,
      };
    }

    return { ok: true, taskId: task.id, retried: false, failureReason: reason };
  }

  function handleContinueProject(projectId, request = {}) {
    const project = projects.get(projectId);
    if (!project) return { ok: false, error: 'project_not_found' };
    const board = boards.get(projectId);
    if (!board) return { ok: false, error: 'project_not_found' };

    return handleContinueProjectCore({
      project,
      board,
      agents: getProjectAgentProfiles(project),
      request,
      dispatchProjectTasks: options => handleRequestDispatch(projectId, project.poAgent, options),
      recoverSubmission: (taskId, result, fromAgent, meta) => handleRecoverSubmission(projectId, taskId, result, fromAgent, meta),
      emitEvent: (type, data) => eventLog.emit(type, data),
    });
  }

  function handleResolveProjectIntervention(projectId, request = {}, runtime = {}) {
    const project = projects.get(projectId);
    if (!project) return { ok: false, error: 'project_not_found', outcome: 'not_advanced', projectChanged: false, humanActionRequired: false };
    const board = boards.get(projectId);
    if (!board) return { ok: false, error: 'project_not_found', outcome: 'not_advanced', projectChanged: false, humanActionRequired: false };

    return resolveProjectIntervention({
      project,
      board,
      agents: getProjectAgentProfiles(project),
      request,
      writeArtifact: runtime.writeArtifact,
      recoverSubmission: (taskId, result, fromAgent, meta) => handleRecoverSubmission(projectId, taskId, result, fromAgent, meta),
      sendReviewSubmission: runtime.sendReviewSubmission || (bridge && project.poAgent ? (({ taskId, payload }) => {
        bridge.send({
          type: 'intent',
          kind: 'review_submission',
          taskId,
          toParticipantId: project.poAgent,
          payload,
        });
      }) : null),
      emitEvent: (type, data) => eventLog.emit(type, data),
    });
  }

  /**
   * PO 提交项目交付物（但不关闭项目！只有 Human 能关闭）
   * 前置条件：所有任务必须已完成
   */
  function handleDeliver(projectId, deliverable, fromAgent, options = {}) {
    const project = projects.get(projectId);
    if (!project || project.poAgent !== fromAgent) return { ok: false, error: 'not_po' };

    // Idempotent: a delivered project is not re-delivered.
    if (project.status === 'delivered') {
      return { ok: true, alreadyDelivered: true, deliveredAt: project.deliveredAt };
    }

    // Gate: all tasks must be done
    const board = boards.get(projectId);
    if (board && !board.isAllDone()) {
      return { ok: false, error: 'tasks_not_all_done' };
    }

    // Gate: delivery package must be valid before we mark the project delivered.
    if (typeof options.validateDelivery === 'function') {
      const validation = options.validateDelivery();
      if (!validation || validation.ok === false) {
        return { ok: false, error: validation?.error || 'delivery_package_invalid' };
      }
    }

    project.deliverable = deliverable;
    project.deliveredAt = Date.now();
    project.status = 'delivered';

    eventLog.emit('project.delivered', {
      projectId, projectName: project.name, by: fromAgent, deliverable,
    });
    return { ok: true };
  }

  // ─── Worker actions ────────────────────────────────────────────────

  function handleAcceptTask(projectId, taskId, workerAgent, runId) {
    const board = boards.get(projectId);
    if (!board) return { ok: false, error: 'project_not_found' };

    const task = board.getTask(taskId);
    if (!task) return { ok: false, error: 'task_not_found' };
    const runCheck = board.validateRun(task.id, runId, workerAgent);
    if (!runCheck.ok) return runCheck;
    if (task.status === 'accepted') {
      return { ok: true, alreadyAccepted: true, taskId: task.id };
    }
    const result = board.transition(task.id, 'accepted', { assignedRuntimeInstance: task.assignedRuntimeInstance || null });
    if (result.ok) {
      if (task.assignedRuntimeInstance && typeof runtimeInstanceAllocator?.markInstanceWorking === 'function') {
        runtimeInstanceAllocator.markInstanceWorking(task.assignedRuntimeInstance, { taskId: task.id });
      }
      eventLog.emit('task.accepted', { projectId, taskId: task.id, taskTitle: task?.title, agent: task.assignedAgent, runtimeInstance: task.assignedRuntimeInstance || null });
      const project = projects.get(projectId);
      if (bridge && project) {
        bridge.send({
          type: 'intent', kind: 'task_accepted',
          taskId: task.id, toParticipantId: project.poAgent,
          payload: { agent: task.assignedAgent, runtimeInstance: task.assignedRuntimeInstance || null, projectId, runId },
        });
      }
    }
    return result;
  }

  function handleProgress(projectId, taskId, stage, workerAgent, runId, telemetry = null) {
    const board = boards.get(projectId);
    if (!board) return { ok: false, error: 'project_not_found' };

    const task = board.getTask(taskId);
    if (!task) return { ok: false, error: 'task_not_found' };
    const runCheck = board.validateRun(task.id, runId, workerAgent);
    if (!runCheck.ok) return runCheck;
    let result = { ok: true, taskId: task.id };
    if (stage === 'started') {
      if (task.status === 'in_progress') {
        result = { ok: true, alreadyInProgress: true, taskId: task.id };
        if (telemetry) board.updateRunTelemetry(task.id, telemetry);
      } else {
        result = board.transition(task.id, 'in_progress', telemetry ? { runTelemetry: telemetry } : {});
      }
    } else if (telemetry) {
      result = board.updateRunTelemetry(task.id, telemetry);
    }
    if (!result.ok) return result;
    if (task.assignedRuntimeInstance && typeof runtimeInstanceAllocator?.markInstanceWorking === 'function') {
      runtimeInstanceAllocator.markInstanceWorking(task.assignedRuntimeInstance, { taskId: task.id });
    }
    eventLog.emit('task.progress', { projectId, taskId: task.id, taskTitle: task?.title, stage, agent: task.assignedAgent, runtimeInstance: task.assignedRuntimeInstance || null });

    const project = projects.get(projectId);
    if (bridge && project) {
      bridge.send({
        type: 'intent', kind: 'progress_update',
        taskId: task.id, toParticipantId: project.poAgent,
        payload: { stage, agent: task.assignedAgent, runtimeInstance: task.assignedRuntimeInstance || null, projectId, runId },
      });
    }
    return result;
  }

  function handleWorkerFailure(projectId, taskId, workerAgent, runId, failureReason, errorMessage) {
    const board = boards.get(projectId);
    if (!board) return { ok: false, error: 'project_not_found' };

    const task = board.getTask(taskId);
    if (!task) return { ok: false, error: 'task_not_found' };
    const runCheck = board.validateRun(task.id, runId, workerAgent);
    if (!runCheck.ok) return runCheck;

    if (
      TASK_LEVEL_WORKER_FAILURE_CLASSES.has(failureReason) &&
      task.assignedRuntimeInstance &&
      typeof runtimeInstanceAllocator?.markInstanceIdle === 'function'
    ) {
      runtimeInstanceAllocator.markInstanceIdle(task.assignedRuntimeInstance);
    }

    const failed = handleTaskFail(projectId, task.id, failureReason, errorMessage);
    if (task.assignedRuntimeInstance && typeof runtimeInstanceAllocator?.markInstanceFailed === 'function') {
      if (!TASK_LEVEL_WORKER_FAILURE_CLASSES.has(failureReason)) {
        runtimeInstanceAllocator.markInstanceFailed(task.assignedRuntimeInstance, failureReason || errorMessage || 'task_failed');
      }
    }
    return failed;
  }

  function handleSubmitResult(projectId, taskId, result, workerAgent, runId) {
    const board = boards.get(projectId);
    if (!board) return { ok: false, error: 'project_not_found' };

    const task = board.getTask(taskId);
    if (!task) return { ok: false, error: 'task_not_found' };
    if (task.status === 'submitted') {
      const existing = JSON.stringify(task.result || {});
      const incoming = JSON.stringify(result || {});
      if (existing === incoming) return { ok: true, alreadySubmitted: true, taskId: task.id };
      return { ok: false, error: 'duplicate_submit_conflict' };
    }
    const runCheck = board.validateRun(task.id, runId, workerAgent);
    if (!runCheck.ok) return runCheck;

    const normalizedResult = normalizeSubmissionResultForContract(task, result);
    const deliverableValidation = validateSubmittedDeliverables(task, normalizedResult);
    if (!deliverableValidation.ok) {
      task.rejectedSubmissions = Array.isArray(task.rejectedSubmissions) ? task.rejectedSubmissions : [];
      task.rejectedSubmissions.push({
        at: Date.now(),
        fromAgent: task.assignedAgent || workerAgent,
        runtimeInstance: task.assignedRuntimeInstance || null,
        runId,
        failureClass: deliverableValidation.failureClass,
        errors: deliverableValidation.errors,
        missing: deliverableValidation.missing,
        result: normalizedResult,
      });
      const failed = board.transition(task.id, 'failed', {
        failureReason: deliverableValidation.failureClass,
        failureClass: deliverableValidation.failureClass,
      });
      if (task.assignedRuntimeInstance && typeof runtimeInstanceAllocator?.markInstanceIdle === 'function') {
        runtimeInstanceAllocator.markInstanceIdle(task.assignedRuntimeInstance);
      }
      eventLog.emit('task.submission_rejected', {
        projectId,
        taskId: task.id,
        taskTitle: task.title,
        agent: task.assignedAgent || workerAgent,
        runtimeInstance: task.assignedRuntimeInstance || null,
        failureClass: deliverableValidation.failureClass,
        errors: deliverableValidation.errors,
        missing: deliverableValidation.missing,
      });
      return {
        ok: false,
        error: 'deliverable_contract_failed',
        failureClass: deliverableValidation.failureClass,
        errors: deliverableValidation.errors,
        missing: deliverableValidation.missing,
        transition: failed,
      };
    }

    const transResult = board.transition(task.id, 'submitted', { result: normalizedResult, runId });
    if (!transResult.ok) return transResult;
    if (task.assignedRuntimeInstance && typeof runtimeInstanceAllocator?.markInstanceIdle === 'function') {
      runtimeInstanceAllocator.markInstanceIdle(task.assignedRuntimeInstance);
    }

    eventLog.emit('task.submitted', {
      projectId, taskId: task.id, taskTitle: task?.title, agent: task.assignedAgent || workerAgent, runtimeInstance: task.assignedRuntimeInstance || null,
      output: normalizedResult,  // includes artifacts list
    });

    const project = projects.get(projectId);
    if (bridge && project) {
      bridge.send({
        type: 'intent', kind: 'result_submitted',
        taskId: task.id, toParticipantId: project.poAgent,
        payload: { result: normalizedResult, agent: task.assignedAgent || workerAgent, runtimeInstance: task.assignedRuntimeInstance || null, projectId, runId },
      });
    }
    return { ok: true };
  }

  function validateSubmittedDeliverables(task, result = {}) {
    const requirements = inferTaskRequirements(task);
    const hardOutputs = (requirements.requiredOutputs || []).filter(output => output.enforcement === 'hard');
    if (hardOutputs.length === 0) return { ok: true, errors: [], missing: [], failureClass: null };
    return validateDeliverableContract({
      requiredOutputs: hardOutputs,
      artifacts: [
        ...(Array.isArray(result.artifacts) ? result.artifacts : []),
        ...(Array.isArray(result.artifactManifest) ? result.artifactManifest : []),
      ],
      workspacePath: result.workspacePath || result.workFolder || '',
    });
  }

  function normalizeSubmissionResultForContract(task, result = {}) {
    if (!result || typeof result !== 'object') return result;
    const requirements = inferTaskRequirements(task);
    const hasHardOutputs = (requirements.requiredOutputs || []).some(output => output.enforcement === 'hard');
    if (!task.evidenceContract && !hasHardOutputs) return result;

    const contract = task.executionContract || {};
    if (contract.requireMeaningfulSummary === false) return result;

    const min = Number(contract.minSummaryChars ?? 50);
    const summary = getResultSummary(result);
    if (summary.length >= min && !isPlaceholderSubmissionSummary(summary)) return result;

    const artifactNames = getResultArtifactNames(result);
    if (artifactNames.length === 0) return result;

    const taskLabel = task.title || task.id || '当前任务';
    const artifactLabel = artifactNames.join('、');
    const normalizedSummary = `提交任务“${taskLabel}”的产物 ${artifactLabel}，作为主要可审核输出。请 PO 按验收标准、证据要求和文件正文继续审核，不以内联摘要替代完整交付物。`;
    return {
      ...result,
      summary: normalizedSummary,
    };
  }

  function getResultSummary(result = {}) {
    const value = result.summary ?? result.text ?? result.output ?? result.content ?? '';
    return typeof value === 'string' ? value.trim() : JSON.stringify(value || '').trim();
  }

  function getResultArtifactNames(result = {}) {
    return [
      ...(Array.isArray(result.artifacts) ? result.artifacts : []),
      ...(Array.isArray(result.artifactManifest) ? result.artifactManifest : []),
    ].map(artifact => {
      if (typeof artifact === 'string') return artifact;
      return artifact?.filename || artifact?.name || artifact?.relativePath || artifact?.path || artifact?.url || '';
    }).filter(Boolean);
  }

  function isPlaceholderSubmissionSummary(value = '') {
    return /^(done|ok|complete|completed|完成|已完成|已修复|模型没有返回内容。?)$/i.test(String(value || '').trim());
  }

  function handleRecoverSubmission(projectId, taskId, result, fromAgent, meta = {}) {
    const board = boards.get(projectId);
    if (!board) return { ok: false, error: 'project_not_found' };
    const task = board.getTask(taskId);
    if (!task) return { ok: false, error: 'task_not_found' };
    const normalizedResult = normalizeSubmissionResultForContract(task, result);
    const recovered = board.recoverSubmission(task.id, normalizedResult, { recoveredBy: fromAgent, fromAgent, ...meta });
    if (!recovered.ok) return recovered;
    eventLog.emit('task.submitted', {
      projectId, taskId: task.id, taskTitle: task.title, agent: fromAgent,
      output: normalizedResult, recovered: true,
    });
    const project = projects.get(projectId);
    if (bridge && project) {
      bridge.send({
        type: 'intent', kind: 'result_submitted',
        taskId: task.id, toParticipantId: project.poAgent,
        payload: { result: normalizedResult, agent: fromAgent, projectId, runId: meta.runId || normalizedResult?.runId },
      });
    }
    return recovered;
  }

  function handleResetTaskForRecovery(projectId, taskId, reason = 'lease_expired') {
    const board = boards.get(projectId);
    if (!board) return { ok: false, error: 'project_not_found' };
    const task = board.getTask(taskId);
    if (!task) return { ok: false, error: 'task_not_found' };
    const result = board.resetStaleRun(task.id, reason);
    if (result.ok) {
      eventLog.emit('task.recovery_reset', {
        projectId,
        taskId: task.id,
        taskTitle: task.title,
        reason,
      });
    }
    return result;
  }

  function handleResumeTaskForRecovery(projectId, taskId, { leaseTimeoutMs = 600_000 } = {}) {
    const board = boards.get(projectId);
    if (!board) return { ok: false, error: 'project_not_found' };
    const task = board.getTask(taskId);
    if (!task) return { ok: false, error: 'task_not_found' };
    const result = board.refreshLeaseForResume(task.id, { leaseTimeoutMs });
    if (result.ok) {
      eventLog.emit('task.recovery_resumed', {
        projectId,
        taskId: task.id,
        taskTitle: task.title,
      });
    }
    return result;
  }

  function handleSuspendActiveRuns(now = Date.now()) {
    let suspended = 0;
    for (const [projectId, board] of boards) {
      const project = projects.get(projectId);
      if (project && project.status !== 'active') continue;
      for (const task of board.getAllTasks()) {
        if (!['dispatched', 'accepted', 'in_progress'].includes(task.status)) continue;
        const result = board.markRunSuspended(task.id, now);
        if (result.ok) suspended++;
      }
    }
    persistState();
    return { ok: true, suspended };
  }

  function handleResumeSuspendedRuns({ sleptMs = 0, leaseTimeoutMs = 600_000 } = {}) {
    let resumed = 0;
    for (const board of boards.values()) {
      for (const task of board.getAllTasks()) {
        if (!task.suspendedAt) continue;
        const result = board.refreshLeaseForResume(task.id, { leaseTimeoutMs });
        if (result.ok) resumed++;
      }
    }
    persistState();
    return { ok: true, resumed, sleptMs };
  }

  // ─── Plan-Do methods ────────────────────────────────────────────────

  /**
   * PO 提交结构化 Plan
   */
  function handleSubmitPlan(projectId, plan, fromAgent) {
    const project = projects.get(projectId);
    if (!project) return { ok: false, error: 'project_not_found' };
    if (project.poAgent !== fromAgent) return { ok: false, error: 'not_po' };

    // Guard: reject if plan already exists (use revise instead)
    if (project.plan) {
      return { ok: false, error: 'plan_already_exists' };
    }

    project.plan = { ...plan, version: 1, createdAt: Date.now(), revisions: [] };
    project.status = 'planning';

    eventLog.emit('plan.submitted', { projectId, version: 1, phaseCount: (plan.phases || []).length });
    return { ok: true, plan: project.plan };
  }

  /**
   * PO 修订 Plan（新增/删除/修改 items）
   */
  function handleRevisePlan(projectId, revision, fromAgent) {
    const project = projects.get(projectId);
    if (!project) return { ok: false, error: 'project_not_found' };
    if (project.poAgent !== fromAgent) return { ok: false, error: 'not_po' };
    if (!project.plan) return { ok: false, error: 'no_plan' };

    const board = boards.get(projectId);
    const newVersion = project.plan.version + 1;

    // Apply changes
    for (const change of (revision.changes || [])) {
      if (change.type === 'add' && change.item) {
        // Add new item to specified phase
        const phase = project.plan.phases.find(p => p.id === change.phaseId);
        if (phase) {
          phase.items.push(change.item);
          // Also create task on the board
          const prepared = prepareTasksForBoard(project, [{
            id: change.item.id,
            title: change.item.title,
            brief: change.item.brief,
            assignedAgent: change.item.assignedAgent || null,
            dependencies: change.item.dependencies || [],
            phaseId: change.phaseId,
            planItemId: change.item.id,
            acceptanceCriteria: change.item.acceptanceCriteria || '',
          }]);
          if (!prepared.ok) return prepared;
          const added = board.addTasksChecked(prepared.tasks);
          if (!added.ok) return added;
        }
      } else if (change.type === 'drop' && change.itemId) {
        // Drop item from plan + cancel task
        for (const phase of project.plan.phases) {
          const idx = phase.items.findIndex(i => i.id === change.itemId);
          if (idx >= 0) {
            phase.items[idx].status = 'dropped';
            break;
          }
        }
        const task = board.getTask(change.itemId);
        if (task) board.transition(task.id, 'cancelled');
      } else if (change.type === 'modify' && change.itemId) {
        // Modify item field
        for (const phase of project.plan.phases) {
          const item = phase.items.find(i => i.id === change.itemId);
          if (item && change.field) {
            item[change.field] = change.newValue;
            break;
          }
        }
      }
    }

    project.plan.version = newVersion;
    project.plan.revisions.push({ version: newVersion, ts: Date.now(), reason: revision.reason, changes: revision.changes });

    eventLog.emit('plan.revised', { projectId, version: newVersion, reason: revision.reason });
    return { ok: true, plan: project.plan, version: newVersion };
  }

  /**
   * PO 质量验收任务
   */
  function handleQualityReview(projectId, taskId, review, fromAgent) {
    const project = projects.get(projectId);
    if (!project) return { ok: false, error: 'project_not_found' };
    if (project.poAgent !== fromAgent) return { ok: false, error: 'not_po' };

    const board = boards.get(projectId);
    const task = board.getTask(taskId);
    if (!task) return { ok: false, error: 'task_not_found' };

    // Guard: skip if already reviewed and task is not re-submitted after rework
    if (task.reviewResult && task.status !== 'submitted') {
      return { ok: true, alreadyReviewed: true };
    }

    // Store review result on task
    const reviewResult = {
      passed: review.passed,
      feedback: review.feedback || '',
      failureClass: review.failureClass || null,
      reviewedAt: Date.now(),
    };
    task.reviewResult = reviewResult;
    task.qualityReviewHistory = Array.isArray(task.qualityReviewHistory) ? task.qualityReviewHistory : [];
    task.qualityReviewHistory.push(reviewResult);

    if (review.passed) {
      if (task.evidenceContract && task.result) {
        const validation = validateTaskResultAgainstContract(task, task.result);
        if (!validation.ok && validation.failureClass !== 'quality_evidence_missing') {
          return handleQualityFailure(task, {
            ...review,
            passed: false,
            feedback: [review.feedback, ...validation.errors].filter(Boolean).join('\n'),
            failureClass: validation.failureClass,
          });
        }
      }
      // If already done (e.g. self-completed PO task), just update plan item
      if (task.status === 'done') {
        updatePlanItemCompleted(project, task);
        eventLog.emit('task.quality_reviewed', { projectId, taskId, passed: true, feedback: review.feedback });
        return { ok: true, effectivePassed: true };
      }
      const result = board.transition(task.id, 'done');
      if (result.ok) {
        updatePlanItemCompleted(project, task);
        eventLog.emit('task.quality_reviewed', { projectId, taskId: task.id, passed: true, feedback: review.feedback });
        maybeCompleteCompositeParent(projectId, task);
        maybeCompleteRetryParent(projectId, task);
      }
      return { ...result, effectivePassed: Boolean(result.ok) };
    }
    return handleQualityFailure(task, review);

    function handleQualityFailure(failedTask, failedReview) {
      const decision = superviseTaskFailure(failedTask, {
        source: 'quality_review',
        failureClass: failedReview.failureClass || 'quality_content_failed',
        feedback: failedReview.feedback || '',
      });
      const effectiveDecision = decision;
      failedTask.qualityFailureCount = effectiveDecision.qualityFailureCount;
      failedTask.lastFailureClass = effectiveDecision.failureClass;

      eventLog.emit('task.quality_reviewed', {
        projectId,
        taskId: failedTask.id,
        passed: false,
        feedback: failedReview.feedback,
        failureClass: effectiveDecision.failureClass,
        action: effectiveDecision.action,
      });

      if (effectiveDecision.action === 'block') {
        const blocked = board.blockTask(failedTask.id, effectiveDecision);
        if (blocked.ok) {
          eventLog.emit('task.blocked', {
            projectId,
            taskId: failedTask.id,
            taskTitle: failedTask.title,
            blockKind: effectiveDecision.blockKind,
            failureClass: effectiveDecision.failureClass,
            reason: effectiveDecision.blockedReason,
            nextActions: effectiveDecision.nextActions,
          });
        }
        return {
          ok: blocked.ok,
          effectivePassed: false,
          blocked: true,
          failureClass: effectiveDecision.failureClass,
          nextActions: effectiveDecision.nextActions,
          feedback: failedReview.feedback,
        };
      }

      const result = board.transition(failedTask.id, 'pending', {
        failureReason: failedReview.feedback,
        failureClass: effectiveDecision.failureClass,
        qualityFailureCount: effectiveDecision.qualityFailureCount,
      });
      const dispatch = result.ok && project.status === 'active'
        ? handleRequestDispatch(projectId, project.poAgent)
        : { ok: false, dispatched: [], error: project.status === 'active' ? 'transition_failed' : 'project_not_active' };
      return {
        ok: result.ok,
        effectivePassed: false,
        rework: true,
        dispatched: dispatch.ok ? dispatch.dispatched : [],
        dispatch,
        feedback: failedReview.feedback,
        nextActions: effectiveDecision.nextActions,
      };
    }
  }

  // ─── Query ─────────────────────────────────────────────────────────

  function getProject(id) { return projects.get(id); }
  function getBoard(projectId) { return boards.get(projectId); }
  function getEventLog() { return eventLog; }
  function listProjects() { return [...projects.values()]; }
  function getDispatchPlan(projectId) { return buildDispatchPlan(projectId); }
  function getProjectHealth(projectId) {
    const project = projects.get(projectId);
    const board = boards.get(projectId);
    if (!project || !board) return null;
    return deriveProjectHealth({
      project,
      tasks: board.getAllTasks(),
      dispatchPlan: buildDispatchPlan(projectId),
    });
  }
  function getProjectIntervention(projectId) {
    const project = projects.get(projectId);
    const board = boards.get(projectId);
    if (!project || !board) return null;
    const dispatchPlan = buildDispatchPlan(projectId);
    const taskIntervention = deriveProjectIntervention({
      project,
      tasks: board.getAllTasks(),
      agents: getProjectAgentProfiles(project),
      dispatchPlan,
    });
    // Task-board intervention always takes priority. Only when there is no
    // actionable task intervention do we fall back to a resumable dynamic
    // (script_generated) workflow so the conversational "让小K帮忙" entry can
    // drive its recovery.
    if (taskIntervention && taskIntervention.required) return taskIntervention;
    const scriptIntervention = deriveScriptWorkflowIntervention(projectId);
    if (scriptIntervention) return scriptIntervention;
    return taskIntervention;
  }
  function createWorkflowProposal(projectId, workflowId, { requestedBy = 'human', policy = null, taskId = null, now = Date.now() } = {}) {
    const project = projects.get(projectId);
    const board = boards.get(projectId);
    if (!project || !board) return { ok: false, error: 'project_not_found' };
    const sourceTask = resolveWorkflowSourceTask(board, taskId);
    if (!sourceTask.ok) return sourceTask;

    const workerAgent = (Array.isArray(project.members) && project.members[0]) || 'xiaok-worker';
    const reviewerAgent = project.poAgent || 'xiaok-po';
    let spec;
    let source = 'builtin';
    if (workflowId === PROJECT_DIAGNOSE_WORKFLOW_ID) {
      spec = createProjectDiagnoseWorkflowSpec({ project });
    } else if (workflowId === AGENT_REVIEW_SMOKE_WORKFLOW_ID) {
      spec = createAgentReviewSmokeWorkflowSpec({ project, task: sourceTask.task, workerAgent, reviewerAgent });
      source = 'builtin-smoke';
    } else if (workflowId === PO_GENERATED_PROJECT_WORKFLOW_ID) {
      spec = createPoGeneratedProjectWorkflowSpec({
        project,
        tasks: board.getAllTasks(),
        workerAgent,
        reviewerAgent,
      });
      source = 'po_generated_project';
    } else if (workflowId === PO_GENERATED_TASK_WORKFLOW_ID) {
      if (!sourceTask.task) return { ok: false, error: 'workflow_task_required' };
      spec = createPoGeneratedTaskWorkflowSpec({
        project,
        task: sourceTask.task,
        workerAgent: sourceTask.task.assignedAgent || workerAgent,
        reviewerAgent,
      });
      source = 'po_generated';
    } else {
      return { ok: false, error: 'workflow_template_not_found' };
    }
    const proposalSourceTask = workflowId === PO_GENERATED_PROJECT_WORKFLOW_ID ? null : sourceTask.task;

    const validation = validateWorkflowSpec(spec, {
      policy: policy || defaultWorkflowPolicyFor(spec),
      capabilities: WORKFLOW_AGENT_CAPABILITIES,
    });
    if (!validation.ok) return validation;
    const budgetGate = buildWorkflowBudgetGate(spec, policy || defaultWorkflowPolicyFor(spec));

    const workflowProposal = {
      id: `wfp-${projectId}-${workflowId}-${now}`,
      projectId,
      workflowId,
      strategy: 'workflow',
      source,
      scope: spec.scope,
      sourceTask: proposalSourceTask ? formatWorkflowSourceTask(proposalSourceTask) : null,
      title: spec.name,
      description: spec.description,
      goal: spec.description,
      status: 'pending',
      requestedBy,
      createdAt: now,
      updatedAt: now,
      specHash: hashWorkflowSpec(spec),
      spec,
      phases: spec.phases.map(phase => ({
        id: phase.id,
        title: phase.title,
        nodes: phase.nodes.map(node => ({ id: node.id, title: node.title, kind: node.kind, required: node.required, dependsOn: node.dependsOn || [] })),
      })),
      budgets: spec.budgets,
      budgetGate,
      permissions: spec.permissions,
      outputContract: spec.outputContract,
      acceptanceRubric: spec.acceptanceRubric,
      assumptions: spec.assumptions || [],
      approval: {
        required: true,
        status: 'pending',
        budget: spec.budgets,
        approvedBy: null,
        decidedAt: null,
      },
    };
    workflowProposals.set(workflowProposal.id, workflowProposal);
    eventLog.emit('workflow.proposal.created', {
      projectId,
      workflowProposalId: workflowProposal.id,
      workflowId,
      requestedBy,
    });
    return { ok: true, workflowProposal, dispatches: [] };
  }

  function cancelWorkflowProposal(workflowProposalId, { reason = 'human_cancelled', now = Date.now() } = {}) {
    const proposal = workflowProposals.get(workflowProposalId);
    if (!proposal) return { ok: false, error: 'workflow_proposal_not_found' };
    if (proposal.approval?.status !== 'pending') return { ok: false, error: 'workflow_proposal_not_pending' };
    const cancelled = {
      ...proposal,
      status: 'cancelled',
      updatedAt: now,
      approval: {
        ...proposal.approval,
        status: 'rejected',
        decidedAt: now,
        rejectionReason: reason,
      },
    };
    workflowProposals.set(cancelled.id, cancelled);
    eventLog.emit('workflow.proposal.cancelled', {
      projectId: cancelled.projectId,
      workflowProposalId,
      workflowId: cancelled.workflowId,
      reason,
    });
    return { ok: true, workflowProposal: cancelled };
  }

  function createScriptWorkflowProposal(projectId, preview, { requestedBy = 'human', now = Date.now(), scriptSource = null } = {}) {
    const project = projects.get(projectId);
    const board = boards.get(projectId);
    if (!project || !board) return { ok: false, error: 'project_not_found' };

    const validation = validateScriptWorkflowPreview(projectId, preview);
    if (!validation.ok) return validation;
    const normalized = validation.preview;

    let persistedScriptSource = null;
    if (scriptSource != null) {
      const sourceValidation = validateScriptSource(scriptSource, normalized.scriptHash);
      if (!sourceValidation.ok) return sourceValidation;
      persistedScriptSource = sourceValidation.scriptSource;
    }

    const workflowProposal = {
      id: `wfp-${projectId}-${normalized.workflowId}-${now}`,
      projectId,
      workflowId: normalized.workflowId,
      strategy: 'workflow',
      source: 'script_generated',
      scope: normalized.scope,
      sourceTask: null,
      title: normalized.title,
      description: normalized.description,
      goal: normalized.description,
      status: 'pending',
      requestedBy,
      createdAt: now,
      updatedAt: now,
      scriptHash: normalized.scriptHash,
      scriptSource: persistedScriptSource,
      scriptPreview: normalized,
      scriptMeta: normalized.meta,
      scriptAnalysis: normalized.analysis,
      phases: normalized.phases.map(phase => ({
        id: phase.id,
        title: phase.title,
        detail: phase.detail || null,
        nodes: [],
      })),
      budgets: null,
      budgetGate: null,
      permissions: null,
      outputContract: null,
      acceptanceRubric: null,
      assumptions: [],
      approval: {
        required: true,
        status: 'pending',
        budget: null,
        approvedBy: null,
        decidedAt: null,
      },
    };
    workflowProposals.set(workflowProposal.id, workflowProposal);
    eventLog.emit('workflow.proposal.created', {
      projectId,
      workflowProposalId: workflowProposal.id,
      workflowId: normalized.workflowId,
      source: 'script_generated',
      requestedBy,
    });
    return { ok: true, workflowProposal, dispatches: [] };
  }

  function startWorkflowRunFromProposal(workflowProposalId, {
    approvedBy = 'human',
    now = Date.now(),
    projectId = null,
    workflowId = null,
    taskId = null,
    policy = null,
  } = {}) {
    const proposal = workflowProposals.get(workflowProposalId);
    if (!proposal) return { ok: false, error: 'workflow_proposal_not_found' };
    if (proposal.approval?.status !== 'pending') return { ok: false, error: 'workflow_proposal_not_pending' };
    if (projectId && proposal.projectId !== projectId) {
      return { ok: false, error: 'workflow_proposal_project_mismatch' };
    }
    if (workflowId && proposal.workflowId !== workflowId) {
      return { ok: false, error: 'workflow_proposal_workflow_mismatch' };
    }
    if (taskId && proposal.scope?.taskId && proposal.scope.taskId !== taskId) {
      return { ok: false, error: 'workflow_proposal_task_mismatch' };
    }
    const project = projects.get(proposal.projectId);
    const board = boards.get(proposal.projectId);
    if (!project || !board) return { ok: false, error: 'project_not_found' };
    const sourceTask = resolveWorkflowSourceTask(board, proposal.scope?.taskId || taskId || null);
    if (!sourceTask.ok) return sourceTask;

    const hardBudget = validateWorkflowSpec(proposal.spec, {
      policy: policy || proposal.budgetGate?.hardLimits || defaultWorkflowPolicyFor(proposal.spec),
      capabilities: WORKFLOW_AGENT_CAPABILITIES,
    });
    if (!hardBudget.ok) return hardBudget;

    const approvedProposal = {
      ...proposal,
      status: 'approved',
      updatedAt: now,
      approval: {
        ...proposal.approval,
        status: 'approved',
        approvedBy,
        decidedAt: now,
      },
    };
    workflowProposals.set(approvedProposal.id, approvedProposal);

    if (proposal.workflowId === PROJECT_DIAGNOSE_WORKFLOW_ID) {
      const result = startProjectDiagnoseWorkflow(proposal.projectId, { requestedBy: approvedBy, now });
      if (!result.ok) return result;
      const workflowRun = applyProposalMetadataToRun(result.workflowRun, approvedProposal, { now });
      workflowRuns.set(workflowRun.id, workflowRun);
      return { ok: true, workflowRun, workflowProposal: approvedProposal, dispatches: [] };
    }

    if (proposal.workflowId === AGENT_REVIEW_SMOKE_WORKFLOW_ID) {
      const workerAgent = (Array.isArray(project.members) && project.members[0]) || 'xiaok-worker';
      let workflowRun = createAgentReviewSmokeWorkflowRun({
        project,
        tasks: board.getAllTasks(),
        task: sourceTask.task,
        workerAgent,
        reviewerAgent: project.poAgent || 'xiaok-po',
        requestedBy: approvedBy,
        now,
      });
      workflowRun = applyProposalMetadataToRun(workflowRun, approvedProposal, { now });
      const dispatched = dispatchWorkflowNode(workflowRun, 'worker-diagnose-project', {
        assignedAgent: workerAgent,
        now,
      });
      workflowRun = dispatched.workflowRun;
      workflowRuns.set(workflowRun.id, workflowRun);
      eventLog.emit('workflow.run.started', {
        projectId: proposal.projectId,
        workflowRunId: workflowRun.id,
        workflowId: workflowRun.workflowId,
        requestedBy: approvedBy,
        workflowProposalId,
      });
      emitWorkflowDispatchEvents(proposal.projectId, dispatched.dispatches);
      return { ok: true, workflowRun, workflowProposal: approvedProposal, dispatches: dispatched.dispatches };
    }

    if (proposal.workflowId === PO_GENERATED_PROJECT_WORKFLOW_ID) {
      const workerAgent = (Array.isArray(project.members) && project.members[0]) || 'xiaok-worker';
      let workflowRun = createPoGeneratedProjectWorkflowRun({
        project,
        tasks: board.getAllTasks(),
        workerAgent,
        reviewerAgent: project.poAgent || 'xiaok-po',
        requestedBy: approvedBy,
        now,
      });
      workflowRun = applyProposalMetadataToRun(workflowRun, approvedProposal, { now });
      const dispatched = dispatchWorkflowNode(workflowRun, PROJECT_WORKFLOW_DELIVERABLE_NODE_ID, {
        assignedAgent: workerAgent,
        now,
      });
      workflowRun = dispatched.workflowRun;
      workflowRuns.set(workflowRun.id, workflowRun);
      eventLog.emit('workflow.run.started', {
        projectId: proposal.projectId,
        workflowRunId: workflowRun.id,
        workflowId: workflowRun.workflowId,
        requestedBy: approvedBy,
        workflowProposalId,
      });
      emitWorkflowDispatchEvents(proposal.projectId, dispatched.dispatches);
      return { ok: true, workflowRun, workflowProposal: approvedProposal, dispatches: dispatched.dispatches };
    }

    if (proposal.workflowId === PO_GENERATED_TASK_WORKFLOW_ID) {
      if (!sourceTask.task) return { ok: false, error: 'workflow_task_required' };
      const workerAgent = sourceTask.task.assignedAgent || (Array.isArray(project.members) && project.members[0]) || 'xiaok-worker';
      let workflowRun = createPoGeneratedTaskWorkflowRun({
        project,
        task: sourceTask.task,
        tasks: board.getAllTasks(),
        workerAgent,
        reviewerAgent: project.poAgent || 'xiaok-po',
        requestedBy: approvedBy,
        now,
      });
      workflowRun = applyProposalMetadataToRun(workflowRun, approvedProposal, { now });
      const dispatched = dispatchWorkflowNode(workflowRun, TASK_WORKFLOW_DELIVERABLE_NODE_ID, {
        assignedAgent: workerAgent,
        now,
      });
      workflowRun = dispatched.workflowRun;
      workflowRuns.set(workflowRun.id, workflowRun);
      eventLog.emit('workflow.run.started', {
        projectId: proposal.projectId,
        taskId: sourceTask.task.id,
        workflowRunId: workflowRun.id,
        workflowId: workflowRun.workflowId,
        requestedBy: approvedBy,
        workflowProposalId,
      });
      emitWorkflowDispatchEvents(proposal.projectId, dispatched.dispatches);
      return { ok: true, workflowRun, workflowProposal: approvedProposal, dispatches: dispatched.dispatches };
    }

    return { ok: false, error: 'workflow_template_not_found' };
  }

  function startScriptWorkflowRunFromProposal(workflowProposalId, {
    approvedBy = 'human',
    now = Date.now(),
    projectId = null,
  } = {}) {
    const proposal = workflowProposals.get(workflowProposalId);
    if (!proposal) return { ok: false, error: 'workflow_proposal_not_found' };
    if (proposal.source !== 'script_generated') return { ok: false, error: 'workflow_proposal_not_script_generated' };
    if (proposal.approval?.status !== 'pending') return { ok: false, error: 'workflow_proposal_not_pending' };
    if (projectId && proposal.projectId !== projectId) return { ok: false, error: 'workflow_proposal_project_mismatch' };
    const project = projects.get(proposal.projectId);
    const board = boards.get(proposal.projectId);
    if (!project || !board) return { ok: false, error: 'project_not_found' };

    const approvedProposal = {
      ...proposal,
      status: 'approved',
      updatedAt: now,
      approval: {
        ...proposal.approval,
        status: 'approved',
        approvedBy,
        decidedAt: now,
      },
    };
    workflowProposals.set(approvedProposal.id, approvedProposal);

    let workflowRun = createWorkflowRun({
      id: `wf-${proposal.projectId}-${proposal.workflowId}-${now}`,
      projectId: proposal.projectId,
      workflowId: proposal.workflowId,
      title: proposal.title,
      source: 'script_generated',
      requestedBy: approvedBy,
      scope: proposal.scope,
      approval: { required: false },
      phases: [
        { id: 'script-runtime', title: '动态工作流编排' },
        ...proposal.phases.map(phase => ({ id: phase.id, title: phase.title })),
      ],
      nodes: [{
        id: 'script-runtime',
        phaseId: 'script-runtime',
        title: '动态工作流编排',
        kind: 'script_runtime',
        assignedAgent: 'desktop-workflow-runtime',
        input: {
          workflowId: proposal.workflowId,
          scriptHash: proposal.scriptHash,
          preview: proposal.scriptPreview,
        },
      }],
      now,
    });
    workflowRun = {
      ...workflowRun,
      workflowProposalId: approvedProposal.id,
      scriptHash: approvedProposal.scriptHash,
      scriptSource: approvedProposal.scriptSource ?? null,
      scriptPreview: approvedProposal.scriptPreview,
      scriptMeta: approvedProposal.scriptMeta,
      scriptAnalysis: approvedProposal.scriptAnalysis,
    };
    const runtimeDispatch = dispatchWorkflowNode(workflowRun, 'script-runtime', {
      assignedAgent: 'desktop-workflow-runtime',
      now,
    });
    workflowRun = runtimeDispatch.workflowRun;
    workflowRuns.set(workflowRun.id, workflowRun);
    eventLog.emit('workflow.run.started', {
      projectId: proposal.projectId,
      workflowRunId: workflowRun.id,
      workflowId: workflowRun.workflowId,
      workflowProposalId,
      source: 'script_generated',
      requestedBy: approvedBy,
    });
    return { ok: true, workflowRun, workflowProposal: approvedProposal, dispatches: [] };
  }

  function beginWorkflowScriptParallelGroup(workflowRunId, {
    phaseTitle,
    label,
    primitiveId = null,
    kind = 'parallel',
    totalCount = 0,
    limit = 1,
    failurePolicy = 'required_all',
    quorum = null,
    now = Date.now(),
  } = {}) {
    const workflowRun = workflowRuns.get(workflowRunId);
    if (!workflowRun) return { ok: false, error: 'workflow_run_not_found' };
    if (workflowRun.source !== 'script_generated') return { ok: false, error: 'workflow_run_not_script_generated' };
    if (['completed', 'failed', 'cancelled'].includes(workflowRun.status)) return { ok: false, error: 'workflow_run_terminal' };
    if (!readWorkflowString(phaseTitle)) return { ok: false, error: 'workflow_script_phase_required' };

    const normalizedKind = ['parallel', 'pipeline'].includes(kind) ? kind : 'parallel';
    const normalizedFailurePolicy = ['required_all', 'collect_errors', 'fail_fast', 'quorum'].includes(failurePolicy)
      ? failurePolicy
      : 'required_all';
    const phaseState = ensureScriptWorkflowPhase(workflowRun, phaseTitle);
    const phase = phaseState.phase;
    const groupId = allocateScriptParallelGroupId(workflowRun);
    const parallelGroup = {
      id: groupId,
      workflowRunId,
      phaseId: phase.id,
      primitiveId: readWorkflowString(primitiveId) || groupId,
      kind: normalizedKind,
      label: readWorkflowString(label) || (normalizedKind === 'pipeline' ? '动态管线' : '并行分组'),
      status: 'running',
      limit: Math.max(1, Number(limit || 1)),
      totalCount: Math.max(0, Number(totalCount || 0)),
      completedCount: 0,
      failedCount: 0,
      cancelledCount: 0,
      requiredFailedCount: 0,
      failurePolicy: normalizedFailurePolicy,
      quorum: Number.isFinite(Number(quorum)) ? Number(quorum) : null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    };
    const nextRun = {
      ...workflowRun,
      updatedAt: now,
      phases: phaseState.phases,
      parallelGroups: [...(workflowRun.parallelGroups || []), parallelGroup],
      scriptCheckpoints: [
        ...(workflowRun.scriptCheckpoints || []),
        createScriptCheckpoint(workflowRun, {
          primitiveType: normalizedKind,
          primitiveId: parallelGroup.primitiveId,
          phaseId: phase.id,
          parallelGroupId: groupId,
          status: 'waiting',
          input: {
            label: parallelGroup.label,
            totalCount: parallelGroup.totalCount,
            limit: parallelGroup.limit,
            failurePolicy: parallelGroup.failurePolicy,
          },
          now,
        }),
      ],
      scriptState: {
        ...(workflowRun.scriptState || {}),
        parallelGroupCount: Number(workflowRun.scriptState?.parallelGroupCount || 0) + 1,
        lastParallelGroupCreatedAt: now,
      },
    };
    const refreshed = refreshWorkflowRunState(nextRun);
    workflowRuns.set(refreshed.id, refreshed);
    eventLog.emit('workflow.script.parallel_group.created', {
      projectId: refreshed.projectId,
      workflowRunId,
      workflowId: refreshed.workflowId,
      parallelGroupId: groupId,
      phaseId: phase.id,
      kind: normalizedKind,
      failurePolicy: normalizedFailurePolicy,
    });
    return {
      ok: true,
      workflowRun: refreshed,
      parallelGroup: refreshed.parallelGroups.find(group => group.id === groupId) || parallelGroup,
    };
  }

  function dispatchWorkflowScriptAgentNode(workflowRunId, {
    phaseTitle,
    label,
    prompt,
    assignedAgent = null,
    options = null,
    parallelGroupId = null,
    fanoutItemKey = null,
    fanoutItemLabel = null,
    pipelineStageIndex = null,
    required = true,
    outputSchema = null,
    evidenceRequired = false,
    dependsOn = [],
    now = Date.now(),
  } = {}) {
    const workflowRun = workflowRuns.get(workflowRunId);
    if (!workflowRun) return { ok: false, error: 'workflow_run_not_found' };
    if (workflowRun.source !== 'script_generated') return { ok: false, error: 'workflow_run_not_script_generated' };
    if (['completed', 'failed', 'cancelled'].includes(workflowRun.status)) return { ok: false, error: 'workflow_run_terminal' };
    if (!readWorkflowString(phaseTitle)) return { ok: false, error: 'workflow_script_phase_required' };
    if (!readWorkflowString(prompt)) return { ok: false, error: 'workflow_script_prompt_required' };
    const normalizedParallelGroupId = readWorkflowString(parallelGroupId);
    if (normalizedParallelGroupId && !(workflowRun.parallelGroups || []).some(group => group.id === normalizedParallelGroupId)) {
      return { ok: false, error: 'workflow_parallel_group_not_found', parallelGroupId: normalizedParallelGroupId };
    }

    const project = projects.get(workflowRun.projectId);
    const workerAgent = assignedAgent || (Array.isArray(project?.members) && project.members[0]) || 'xiaok-worker';
    const phaseState = ensureScriptWorkflowPhase(workflowRun, phaseTitle);
    const phase = phaseState.phase;
    const nodeId = allocateScriptAgentNodeId(workflowRun);
    const title = readWorkflowString(label) || `动态任务 ${nodeId.replace(/^script-agent-/, '')}`;
    const resolvedDepsOn = Array.isArray(dependsOn) ? dependsOn : [];
    const allDepsCompleted = resolvedDepsOn.length > 0
      ? resolvedDepsOn.every(depId => {
          const dep = workflowRun.nodes.find(n => n.id === depId);
          return dep && dep.status === 'completed';
        })
      : true;
    const node = {
      id: nodeId,
      phaseId: phase.id,
      title,
      status: resolvedDepsOn.length === 0 || allDepsCompleted ? 'ready' : 'pending',
      kind: 'agent_task',
      dependsOn: resolvedDepsOn,
      assignedAgent: workerAgent,
      attempt: 0,
      input: {
        prompt: readWorkflowString(prompt),
        label: title,
        options: options && typeof options === 'object' && !Array.isArray(options) ? JSON.parse(JSON.stringify(options)) : null,
        script: {
          workflowId: workflowRun.workflowId,
          workflowRunId,
          scriptHash: workflowRun.scriptHash || null,
          phaseId: phase.id,
          phaseTitle: phase.title,
          nodeId,
        },
      },
      output: null,
      reviewDecision: null,
      runtime: null,
      cache: null,
      producerAgent: null,
      error: null,
      startedAt: null,
      completedAt: null,
      parallelGroupId: normalizedParallelGroupId || null,
      fanoutItemKey: readWorkflowString(fanoutItemKey),
      fanoutItemLabel: readWorkflowString(fanoutItemLabel),
      pipelineStageIndex: Number.isFinite(Number(pipelineStageIndex)) ? Number(pipelineStageIndex) : null,
      required: required !== false,
      outputSchema: outputSchema && typeof outputSchema === 'object' && !Array.isArray(outputSchema)
        ? JSON.parse(JSON.stringify(outputSchema))
        : null,
      evidenceRequired: evidenceRequired === true,
    };

    const withNode = {
      ...workflowRun,
      updatedAt: now,
      phases: phaseState.phases.map(item => item.id === phase.id
        ? { ...item, nodeIds: [...new Set([...(item.nodeIds || []), nodeId])] }
        : item),
      nodes: [...workflowRun.nodes, node],
      scriptCheckpoints: [
        ...(workflowRun.scriptCheckpoints || []),
        createScriptCheckpoint(workflowRun, {
          primitiveType: 'agent',
          primitiveId: nodeId,
          phaseId: phase.id,
          parallelGroupId: normalizedParallelGroupId || null,
          status: 'waiting',
          input: node.input,
          outputRefs: [nodeId],
          now,
        }),
      ],
      scriptState: {
        ...(workflowRun.scriptState || {}),
        dynamicNodeCount: Number(workflowRun.scriptState?.dynamicNodeCount || 0) + 1,
        lastNodeCreatedAt: now,
      },
    };
    // Only dispatch immediately if node is ready (no pending dependencies)
    if (node.status === 'ready') {
      const dispatched = dispatchWorkflowNode(withNode, nodeId, {
        assignedAgent: workerAgent,
        input: node.input,
        now,
      });
      workflowRuns.set(dispatched.workflowRun.id, dispatched.workflowRun);
      eventLog.emit('workflow.script.node.created', {
        projectId: dispatched.workflowRun.projectId,
        workflowRunId,
        workflowId: dispatched.workflowRun.workflowId,
        nodeId,
        phaseId: phase.id,
        phaseTitle: phase.title,
        assignedAgent: workerAgent,
      });
      emitWorkflowDispatchEvents(dispatched.workflowRun.projectId, dispatched.dispatches);
      return { ok: true, workflowRun: dispatched.workflowRun, nodeId, dispatches: dispatched.dispatches };
    }
    // Node is pending (has unmet dependsOn) — persist but don't dispatch yet
    workflowRuns.set(withNode.id, withNode);
    eventLog.emit('workflow.script.node.created', {
      projectId: withNode.projectId,
      workflowRunId,
      workflowId: withNode.workflowId,
      nodeId,
      phaseId: phase.id,
      phaseTitle: phase.title,
      assignedAgent: workerAgent,
    });
    return { ok: true, workflowRun: withNode, nodeId, dispatches: [] };
  }

  function retryWorkflowScriptAgentNode(workflowRunId, { nodeId, assignedAgent = null, now = Date.now() } = {}) {
    const workflowRun = workflowRuns.get(workflowRunId);
    if (!workflowRun) return { ok: false, error: 'workflow_run_not_found' };
    if (workflowRun.source !== 'script_generated') return { ok: false, error: 'workflow_run_not_script_generated' };
    if (['completed', 'failed', 'cancelled'].includes(workflowRun.status)) return { ok: false, error: 'workflow_run_terminal' };
    const node = workflowRun.nodes.find(item => item.id === nodeId);
    if (!node) return { ok: false, error: 'workflow_node_not_found' };
    if (node.kind !== 'agent_task') return { ok: false, error: 'workflow_node_not_agent_task' };
    if (!['blocked', 'failed'].includes(node.status)) return { ok: false, error: 'workflow_node_not_retryable' };

    const resetRun = refreshWorkflowRunState({
      ...workflowRun,
      status: 'running',
      completedAt: null,
      updatedAt: now,
      nodes: workflowRun.nodes.map(item => item.id === nodeId
        ? {
            ...item,
            status: 'ready',
            error: null,
            output: null,
            reviewDecision: null,
            runtime: null,
            cache: null,
            producerAgent: null,
            completedAt: null,
          }
        : item),
    });
    const retryAgent = assignedAgent || node.assignedAgent || null;
    const dispatched = dispatchWorkflowNode(resetRun, nodeId, {
      assignedAgent: retryAgent,
      input: node.input,
      now,
    });
    workflowRuns.set(dispatched.workflowRun.id, dispatched.workflowRun);
    eventLog.emit('workflow.script.node.retry_dispatched', {
      projectId: dispatched.workflowRun.projectId,
      workflowRunId,
      workflowId: dispatched.workflowRun.workflowId,
      nodeId,
      assignedAgent: retryAgent,
      attempt: dispatched.dispatches[0]?.attempt || null,
    });
    emitWorkflowDispatchEvents(dispatched.workflowRun.projectId, dispatched.dispatches);
    return { ok: true, workflowRun: dispatched.workflowRun, nodeId, dispatches: dispatched.dispatches };
  }

  function completeScriptWorkflowRun(workflowRunId, { result = null, terminal = null, now = Date.now() } = {}) {
    const workflowRun = workflowRuns.get(workflowRunId);
    if (!workflowRun) return { ok: false, error: 'workflow_run_not_found' };
    if (workflowRun.source !== 'script_generated') return { ok: false, error: 'workflow_run_not_script_generated' };
    if (['completed', 'failed', 'cancelled'].includes(workflowRun.status)) return { ok: false, error: 'workflow_run_terminal' };

    const incomplete = workflowRun.nodes.filter(node => node.kind === 'agent_task' && node.status !== 'completed');
    if (incomplete.length > 0) {
      return {
        ok: false,
        error: 'workflow_script_nodes_incomplete',
        incompleteNodes: incomplete.map(node => ({ id: node.id, status: node.status, title: node.title })),
      };
    }
    const runtimeNode = workflowRun.nodes.find(node => node.id === 'script-runtime');
    if (!runtimeNode) return { ok: false, error: 'workflow_script_runtime_node_missing' };

    const workflowResult = result && typeof result === 'object' && !Array.isArray(result)
      ? sanitizeWorkflowNodeOutput(result)
      : sanitizeWorkflowNodeOutput({ value: result });
    const completed = applyWorkflowEvent(workflowRun, {
      type: 'node_completed',
      nodeId: runtimeNode.id,
      output: {
        ...workflowResult,
        producedAt: now,
        producerAgent: 'desktop-workflow-runtime',
      },
      fromAgent: 'desktop-workflow-runtime',
    }, { now });
    let withResult = {
      ...completed,
      scriptResult: JSON.parse(JSON.stringify(result ?? null)),
      scriptState: {
        ...(completed.scriptState || {}),
        completedAt: now,
      },
    };
    const terminalDecision = normalizeWorkflowScriptTerminalDecision(terminal);
    if (terminalDecision && terminalDecision.status !== 'passed') {
      withResult = {
        ...withResult,
        status: 'blocked',
        completedAt: null,
        gateDecision: terminalDecision,
        summary: {
          ...(withResult.summary || {}),
          primaryMessage: terminalDecision.reason || 'Workflow blocked',
          blockingFailures: [
            ...((withResult.summary?.blockingFailures || [])),
            {
              nodeId: runtimeNode.id,
              title: runtimeNode.title,
              status: 'blocked',
              reason: terminalDecision.reason || terminalDecision.status,
            },
          ],
        },
      };
      workflowRuns.set(withResult.id, withResult);
      eventLog.emit('workflow.run.blocked', {
        projectId: withResult.projectId,
        workflowRunId,
        workflowId: withResult.workflowId,
        status: terminalDecision.status,
        source: 'script_generated',
      });
      return { ok: true, workflowRun: withResult, dispatches: [], projectDelivery: null };
    }
    withResult = {
      ...withResult,
      gateDecision: terminalDecision || withResult.gateDecision || {
        status: 'passed',
        reason: 'Dynamic workflow script completed',
        evidenceRefs: readWorkflowStringArray(workflowResult.evidenceRefs),
      },
    };
    const { projectDelivery: _staleProjectDelivery, ...workflowRunWithoutStaleDelivery } = withResult;
    withResult = refreshWorkflowRunState({
      ...workflowRunWithoutStaleDelivery,
      status: 'completed',
      completedAt: now,
    });
    const projectFinalization = maybeDeliverScriptWorkflowProjectResult(withResult, { now });
    withResult = projectFinalization.workflowRun;
    workflowRuns.set(withResult.id, withResult);
    eventLog.emit('workflow.run.completed', {
      projectId: withResult.projectId,
      workflowRunId,
      workflowId: withResult.workflowId,
      status: withResult.status,
      source: 'script_generated',
      projectDeliveryStatus: projectFinalization.delivery?.ok ? 'delivered' : (projectFinalization.delivery?.error || null),
    });
    return { ok: true, workflowRun: withResult, dispatches: [], projectDelivery: projectFinalization.delivery };
  }

  function startProjectDiagnoseWorkflow(projectId, { requestedBy = 'human', now = Date.now() } = {}) {
    const project = projects.get(projectId);
    const board = boards.get(projectId);
    if (!project || !board) return { ok: false, error: 'project_not_found' };

    const dispatchPlan = buildDispatchPlan(projectId);
    const workflowRun = createProjectDiagnoseWorkflowRun({
      project,
      tasks: board.getAllTasks(),
      projectHealth: deriveProjectHealth({
        project,
        tasks: board.getAllTasks(),
        dispatchPlan,
      }),
      dispatchPlan,
      requestedBy,
      now,
    });
    workflowRuns.set(workflowRun.id, workflowRun);
    eventLog.emit('workflow.run.completed', {
      projectId,
      workflowRunId: workflowRun.id,
      workflowId: workflowRun.workflowId,
      status: workflowRun.status,
      requestedBy,
      recommendedAction: workflowRun.diagnosis?.recommendedActions?.[0]?.id || null,
    });
    return { ok: true, workflowRun };
  }
  function startAgentReviewSmokeWorkflow(projectId, { requestedBy = 'human', now = Date.now() } = {}) {
    const project = projects.get(projectId);
    const board = boards.get(projectId);
    if (!project || !board) return { ok: false, error: 'project_not_found' };

    const workerAgent = (Array.isArray(project.members) && project.members[0]) || 'xiaok-worker';
    const reviewerAgent = project.poAgent || 'xiaok-po';
    let workflowRun = createAgentReviewSmokeWorkflowRun({
      project,
      tasks: board.getAllTasks(),
      workerAgent,
      reviewerAgent,
      requestedBy,
      now,
    });

    const dispatched = dispatchWorkflowNode(workflowRun, 'worker-diagnose-project', {
      assignedAgent: workerAgent,
      now,
    });
    workflowRun = dispatched.workflowRun;
    workflowRuns.set(workflowRun.id, workflowRun);
    eventLog.emit('workflow.run.started', {
      projectId,
      workflowRunId: workflowRun.id,
      workflowId: workflowRun.workflowId,
      requestedBy,
    });
    emitWorkflowDispatchEvents(projectId, dispatched.dispatches);
    return { ok: true, workflowRun, dispatches: dispatched.dispatches };
  }
  function handleWorkflowNodeResult({ workflowRunId, nodeId, attempt, handoffId, fromAgent, output, now = Date.now() } = {}) {
    const checked = validateWorkflowNodeHandoff({ workflowRunId, nodeId, attempt, handoffId });
    if (!checked.ok) return checked;
    const sanitizedOutput = sanitizeWorkflowNodeOutput(output && typeof output === 'object' ? output : { value: output });

    let workflowRun = applyWorkflowEvent(checked.workflowRun, {
      type: 'node_completed',
      nodeId,
      output: {
        ...sanitizedOutput,
        producerAgent: fromAgent || checked.node.assignedAgent || null,
        producedAt: now,
      },
      fromAgent,
    }, { now });

    const reviewer = workflowRun.nodes.find(node => node.id === 'reviewer-adversarial-check');
    let dispatches = [];
    if (reviewer?.status === 'ready') {
      const dependencyOutput = getFirstDependencyOutput(workflowRun, reviewer);
      const dispatched = dispatchWorkflowNode(workflowRun, reviewer.id, {
        assignedAgent: reviewer.assignedAgent || 'xiaok-po',
        input: {
          workerOutput: dependencyOutput,
        },
        now,
      });
      workflowRun = dispatched.workflowRun;
      dispatches = dispatched.dispatches;
    }

    workflowRuns.set(workflowRun.id, workflowRun);
    eventLog.emit('workflow.node.output_received', {
      projectId: workflowRun.projectId,
      workflowRunId,
      nodeId,
      fromAgent: fromAgent || null,
    });
    emitWorkflowDispatchEvents(workflowRun.projectId, dispatches);
    return { ok: true, workflowRun, dispatches };
  }
  function handleWorkflowNodeReview({ workflowRunId, nodeId, attempt, handoffId, fromAgent, reviewDecision, output = null, now = Date.now() } = {}) {
    const checked = validateWorkflowNodeHandoff({ workflowRunId, nodeId, attempt, handoffId });
    if (!checked.ok) return checked;

    const decisionValidation = validateWorkflowReviewDecision(reviewDecision);
    if (!decisionValidation.ok) {
      let blocked = applyWorkflowEvent(checked.workflowRun, {
        type: 'node_blocked',
        nodeId,
        reason: 'malformed_review_decision',
      }, { now });
      blocked = {
        ...blocked,
        gateDecision: {
          status: 'blocked',
          reason: decisionValidation.error,
          evidenceRefs: [],
        },
      };
      blocked.summary = { ...blocked.summary, primaryMessage: 'Review gate blocked' };
      workflowRuns.set(blocked.id, blocked);
      eventLog.emit('workflow.node.reviewed', {
        projectId: blocked.projectId,
        workflowRunId,
        nodeId,
        fromAgent: fromAgent || null,
        decision: 'blocked',
        error: decisionValidation.error,
      });
      return { ok: true, workflowRun: blocked, dispatches: [] };
    }
    const sanitizedDecision = decisionValidation.decision;

    let workflowRun = applyWorkflowEvent(checked.workflowRun, {
      type: 'node_reviewed',
      nodeId,
      reviewDecision: sanitizedDecision,
      output: sanitizeWorkflowNodeOutput(output),
      fromAgent,
    }, { now });
    workflowRun = applyWorkflowEvent(workflowRun, {
      type: 'gate_completed',
      nodeId: 'reduce-review-gate',
      decision: sanitizedDecision,
    }, { now });
    const taskFinalization = maybeSubmitTaskWorkflowDeliverable(workflowRun, { now });
    workflowRun = taskFinalization.workflowRun;
    const projectFinalization = maybeDeliverProjectWorkflowDeliverable(workflowRun, { now });
    workflowRun = projectFinalization.workflowRun;
    workflowRuns.set(workflowRun.id, workflowRun);
    eventLog.emit('workflow.run.gate_completed', {
      projectId: workflowRun.projectId,
      workflowRunId,
      status: workflowRun.status,
      decision: sanitizedDecision.status,
      taskSubmissionStatus: taskFinalization.submission?.ok ? 'submitted' : (taskFinalization.submission?.error || null),
      projectDeliveryStatus: projectFinalization.delivery?.ok ? 'delivered' : (projectFinalization.delivery?.error || null),
    });
    return { ok: true, workflowRun, dispatches: [] };
  }
  function handleWorkflowRuntimeUnavailable({ workflowRunId, nodeId, attempt, handoffId, reason = 'runtime_unavailable', now = Date.now() } = {}) {
    const checked = validateWorkflowNodeHandoff({ workflowRunId, nodeId, attempt, handoffId, allowRunningOnly: false });
    if (!checked.ok) return checked;
    const workflowRun = applyWorkflowEvent(checked.workflowRun, {
      type: 'node_blocked',
      nodeId,
      reason,
    }, { now });
    workflowRuns.set(workflowRun.id, workflowRun);
    eventLog.emit('workflow.node.blocked', {
      projectId: workflowRun.projectId,
      workflowRunId,
      nodeId,
      reason,
    });
    return { ok: true, workflowRun, dispatches: [] };
  }
  function cancelWorkflowRun(workflowRunId, { reason = 'human_cancelled', now = Date.now() } = {}) {
    const workflowRun = workflowRuns.get(workflowRunId);
    if (!workflowRun) return { ok: false, error: 'workflow_run_not_found' };
    const cancelled = applyWorkflowEvent(workflowRun, { type: 'cancelled', reason }, { now });
    workflowRuns.set(cancelled.id, cancelled);
    const taskReset = maybeReleaseCancelledTaskWorkflow(cancelled, { reason, now });
    eventLog.emit('workflow.run.cancelled', {
      projectId: cancelled.projectId,
      workflowRunId,
      reason,
      taskResetStatus: taskReset?.ok ? 'pending' : (taskReset?.error || null),
    });
    return { ok: true, workflowRun: cancelled, taskReset };
  }

  function isScriptWorkflowRunResumable(workflowRun) {
    if (!workflowRun || workflowRun.source !== 'script_generated') return false;
    if (workflowRun.status === 'running') return true;
    if (workflowRun.status !== 'blocked') return false;
    return workflowRun.recovery?.nextAction === 'resume_workflow';
  }

  function listResumableScriptWorkflowRuns(projectId = null) {
    return [...workflowRuns.values()]
      .filter(run => isScriptWorkflowRunResumable(run))
      .filter(run => (projectId ? run.projectId === projectId : true))
      .filter(run => typeof run.scriptSource === 'string' && run.scriptSource.length > 0)
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .map(run => ({
        projectId: run.projectId,
        workflowRunId: run.id,
        workflowId: run.workflowId,
        scriptHash: run.scriptHash || null,
        status: run.status,
        scriptSource: run.scriptSource,
        createdAt: run.createdAt || 0,
      }));
  }

  function deriveScriptWorkflowIntervention(projectId) {
    const resumable = listResumableScriptWorkflowRuns(projectId);
    const candidate = resumable[0];
    if (!candidate) return null;
    return {
      required: true,
      severity: 'action_required',
      kind: 'script_workflow',
      projectId,
      workflowRunId: candidate.workflowRunId,
      workflowId: candidate.workflowId,
      scriptHash: candidate.scriptHash,
      primaryAction: {
        id: 'resume_dynamic_workflow',
        strategy: 'resume_workflow',
        toolName: 'run_dynamic_workflow_script',
        params: { projectId, resumeWorkflowRunId: candidate.workflowRunId },
      },
    };
  }

  function recoverInterruptedTaskWorkflows({ reason = 'workflow_runtime_interrupted', now = Date.now() } = {}) {
    const recovered = [];
    const skipped = [];
    const resumableScriptRuns = [];
    for (const workflowRun of workflowRuns.values()) {
      if (!workflowRun) continue;
      // Dynamic (script_generated) runs have no task lease; never cancel them.
      // Collect resumable ones so the desktop runtime can rebuild their jobs.
      if (workflowRun.source === 'script_generated') {
        if (isScriptWorkflowRunResumable(workflowRun)) {
          resumableScriptRuns.push({
            projectId: workflowRun.projectId,
            workflowRunId: workflowRun.id,
            workflowId: workflowRun.workflowId,
            scriptHash: workflowRun.scriptHash || null,
            status: workflowRun.status,
            hasScriptSource: typeof workflowRun.scriptSource === 'string' && workflowRun.scriptSource.length > 0,
          });
        }
        continue;
      }
      if (workflowRun.workflowId !== PO_GENERATED_TASK_WORKFLOW_ID) continue;
      if (workflowRun.status !== 'running') continue;
      const cancelled = applyWorkflowEvent(workflowRun, { type: 'cancelled', reason }, { now });
      const taskReset = maybeReleaseCancelledTaskWorkflow(cancelled, { reason, now });
      workflowRuns.set(cancelled.id, cancelled);
      if (taskReset?.ok) {
        recovered.push({
          projectId: cancelled.projectId,
          workflowRunId: cancelled.id,
          taskId: cancelled.scope?.taskId || null,
          taskResetStatus: 'pending',
        });
        eventLog.emit('workflow.run.cancelled', {
          projectId: cancelled.projectId,
          workflowRunId: cancelled.id,
          reason,
          taskResetStatus: 'pending',
        });
      } else {
        skipped.push({
          projectId: cancelled.projectId,
          workflowRunId: cancelled.id,
          taskId: cancelled.scope?.taskId || null,
          reason: taskReset?.error || 'task_reset_not_needed',
        });
      }
    }
    return { ok: true, recovered, skipped, resumableScriptRuns };
  }

  function maybeReleaseCancelledTaskWorkflow(workflowRun, { reason = 'workflow_cancelled' } = {}) {
    if (!workflowRun || workflowRun.workflowId !== PO_GENERATED_TASK_WORKFLOW_ID) return null;
    const taskId = workflowRun.scope?.taskId;
    if (!taskId) return null;
    const board = boards.get(workflowRun.projectId);
    if (!board) return { ok: false, error: 'task_board_not_found' };
    const task = board.getTask(taskId);
    if (!task) return { ok: false, error: 'source_task_not_found' };
    const expectedRunId = `workflow-${workflowRun.id}`;
    if (task.activeRunId !== expectedRunId) {
      return { ok: false, error: 'source_task_run_mismatch', activeRunId: task.activeRunId || null, expectedRunId };
    }
    if (!['dispatched', 'accepted', 'in_progress'].includes(task.status)) {
      return { ok: false, error: `source_task_not_active:${task.status}` };
    }
    return board.transition(task.id, 'pending', {
      failureReason: reason,
      assignedExecutor: null,
    });
  }

  function handleWorkflowProgressBatch(workflowRunId, batch, { now = Date.now() } = {}) {
    const workflowRun = workflowRuns.get(workflowRunId);
    if (!workflowRun) return { ok: false, error: 'workflow_run_not_found' };
    if (!batch || typeof batch !== 'object') return { ok: false, error: 'workflow_progress_batch_required' };
    if (batch.workflowRunId !== workflowRunId) return { ok: false, error: 'workflow_progress_run_mismatch' };
    if (batch.projectId !== workflowRun.projectId) return { ok: false, error: 'workflow_progress_project_mismatch' };

    const applied = applyWorkflowProgressBatch({
      workflowRunId: workflowRun.id,
      nodes: workflowRun.nodes,
      progressState: workflowRun.progressState || null,
    }, batch);
    if (!applied.ok) return applied;
    if (applied.duplicate) return { ok: true, duplicate: true, workflowRun };

    const updated = {
      ...workflowRun,
      nodes: applied.snapshot.nodes,
      progressState: applied.snapshot.progressState,
      updatedAt: now,
    };
    workflowRuns.set(updated.id, updated);
    eventLog.emit('workflow.progress.batch', {
      projectId: updated.projectId,
      workflowRunId: updated.id,
      fromParticipantId: batch.fromParticipantId,
      sequence: batch.sequence,
      eventCount: Array.isArray(batch.events) ? batch.events.length : 0,
      lastMaterialProgress: updated.progressState?.lastMaterialProgress || null,
    });
    return { ok: true, workflowRun: updated };
  }

  function listProjectWorkflowRuns(projectId) {
    return [...workflowRuns.values()]
      .filter(run => run.projectId === projectId)
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }
  function findActiveProjectExecutionWorkflow(projectId) {
    return [...workflowRuns.values()]
      .filter(run => (
        run.projectId === projectId &&
        run.workflowId === PO_GENERATED_PROJECT_WORKFLOW_ID &&
        ['awaiting_approval', 'running'].includes(run.status)
      ))
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0] || null;
  }
  function getWorkflowRun(workflowRunId) {
    return workflowRuns.get(workflowRunId) || null;
  }
  function dispatchWorkflowNode(workflowRun, nodeId, { assignedAgent, input = null, now = Date.now() } = {}) {
    const node = workflowRun.nodes.find(item => item.id === nodeId);
    if (!node || !['ready', 'pending'].includes(node.status)) return { workflowRun, dispatches: [] };
    const attempt = (node.attempt || 0) + 1;
    const handoffId = `wfhd-${workflowRun.id}-${nodeId}-${attempt}`;
    const nodeInput = enrichWorkflowNodeInput(workflowRun, input || node.input || null, { nodeId });
    const next = applyWorkflowEvent(workflowRun, {
      type: 'node_dispatched',
      nodeId,
      assignedAgent: assignedAgent || node.assignedAgent || null,
      attempt,
      handoffId,
      input: nodeInput,
    }, { now });
    const updatedNode = next.nodes.find(item => item.id === nodeId);
    return {
      workflowRun: next,
      dispatches: [{
        workflowRunId: next.id,
        workflowId: next.workflowId,
        projectId: next.projectId,
        nodeId,
        nodeTitle: updatedNode?.title || nodeId,
        nodeKind: updatedNode?.kind || node.kind,
        targetParticipantId: updatedNode?.assignedAgent || assignedAgent || null,
        attempt,
        handoffId,
        input: nodeInput,
      }],
    };
  }
  const INLINE_MAX_CHARS = 2000;
  const MAX_PER_NODE_COMPACT_CHARS = 4000;
  const MAX_TOTAL_UPSTREAM_CHARS = 10000;
  const COMPACT_EXCLUDE_KEYS = new Set(['summary', 'artifacts', 'artifactManifest', 'producerAgent', 'producedAt', 'upstreamOutputs']);
  const MIN_USEFUL_SUMMARY_LENGTH = 10;

  function compactNodeOutput(node) {
    try {
      const output = node?.output;
      if (!output || typeof output !== 'object' || Array.isArray(output)) return null;

      const compact = { nodeId: node.id, nodeTitle: node.title || node.id };

      if (typeof output.summary === 'string' && output.summary.trim().length >= MIN_USEFUL_SUMMARY_LENGTH) {
        compact.summary = output.summary;
      }

      const paths = [];
      if (Array.isArray(output.artifacts)) {
        for (const a of output.artifacts) {
          const p = a?.path || a?.relativePath;
          if (p) paths.push(p);
        }
      }
      if (Array.isArray(output.artifactManifest)) {
        for (const a of output.artifactManifest) {
          const p = a?.path || a?.relativePath;
          if (p) paths.push(p);
        }
      }
      const uniquePaths = [...new Set(paths)];
      if (uniquePaths.length > 0) compact.artifactPaths = uniquePaths;

      let inlineChars = 0;
      for (const [key, val] of Object.entries(output)) {
        if (COMPACT_EXCLUDE_KEYS.has(key)) continue;
        if (inlineChars >= MAX_PER_NODE_COMPACT_CHARS) break;
        try {
          const serialized = JSON.stringify(val);
          if (serialized === undefined) continue;
          if (serialized.length > INLINE_MAX_CHARS) continue;
          if (inlineChars + serialized.length > MAX_PER_NODE_COMPACT_CHARS) break;
          compact[key] = val;
          inlineChars += serialized.length;
        } catch { continue; }
      }

      if (!compact.summary && !compact.artifactPaths && inlineChars === 0) return null;
      return compact;
    } catch { return null; }
  }

  function enrichWorkflowNodeInput(workflowRun, input = null, { nodeId = null } = {}) {
    const base = input && typeof input === 'object' && !Array.isArray(input) ? { ...input } : { value: input };

    let upstreamOutputs = null;
    try {
      if (nodeId) {
        const node = workflowRun.nodes.find(n => n.id === nodeId);
        const deps = node?.dependsOn;
        if (Array.isArray(deps) && deps.length > 0) {
          const sortedDeps = deps.length > 3 ? [...deps].sort() : deps;
          const collected = {};
          let totalChars = 0;
          for (const depId of sortedDeps) {
            const depNode = workflowRun.nodes.find(n => n.id === depId);
            if (!depNode || depNode.status !== 'completed' || !depNode.output) continue;
            const compact = compactNodeOutput(depNode);
            if (!compact) continue;
            try {
              const size = JSON.stringify(compact).length;
              if (totalChars + size > MAX_TOTAL_UPSTREAM_CHARS) {
                collected[depId] = {
                  nodeId: depNode.id,
                  nodeTitle: depNode.title || depNode.id,
                  summary: typeof depNode.output.summary === 'string' ? depNode.output.summary : null,
                  artifactPaths: compact.artifactPaths || null,
                  _truncated: true,
                };
              } else {
                collected[depId] = compact;
                totalChars += size;
              }
            } catch {
              collected[depId] = { nodeId: depNode.id, nodeTitle: depNode.title || depNode.id, _truncated: true };
            }
          }
          if (Object.keys(collected).length > 0) upstreamOutputs = collected;
        }
      }
    } catch { upstreamOutputs = null; }

    return {
      ...base,
      workflowRunId: workflowRun.id,
      workflowRun: {
        id: workflowRun.id,
        workflowId: workflowRun.workflowId,
        projectId: workflowRun.projectId,
        taskId: workflowRun.scope?.taskId || null,
      },
      sourceTask: base.sourceTask || workflowRun.sourceTask || null,
      ...(upstreamOutputs ? { upstreamOutputs } : {}),
    };
  }
  function validateWorkflowNodeHandoff({ workflowRunId, nodeId, attempt, handoffId, allowRunningOnly = true } = {}) {
    const workflowRun = workflowRuns.get(workflowRunId);
    if (!workflowRun) return { ok: false, error: 'workflow_run_not_found' };
    if (['completed', 'failed', 'cancelled'].includes(workflowRun.status)) return { ok: false, error: 'workflow_run_terminal' };
    const node = workflowRun.nodes.find(item => item.id === nodeId);
    if (!node) return { ok: false, error: 'workflow_node_not_found' };
    if (allowRunningOnly && node.status !== 'running') return { ok: false, error: 'workflow_node_not_running' };
    if (Number(node.attempt || 0) !== Number(attempt || 0)) return { ok: false, error: 'workflow_attempt_mismatch' };
    if ((node.runtime?.handoffId || null) !== (handoffId || null)) return { ok: false, error: 'workflow_handoff_mismatch' };
    return { ok: true, workflowRun, node };
  }
  function validateWorkflowReviewDecision(decision) {
    const result = validateWorkflowGateDecision(decision);
    if (!result.ok) {
      const error = result.error.replace(/^gate_/, 'review_');
      return { ...result, error };
    }
    return { ok: true, decision: sanitizeWorkflowGateDecision(decision) };
  }
  function applyProposalMetadataToRun(workflowRun, proposal, { now = Date.now() } = {}) {
    return {
      ...workflowRun,
      workflowProposalId: proposal.id,
      specHash: proposal.specHash,
      spec: proposal.spec,
      scope: proposal.scope,
      sourceTask: proposal.sourceTask,
      budgets: proposal.budgets,
      budgetGate: proposal.budgetGate,
      permissions: proposal.permissions,
      outputContract: proposal.outputContract,
      acceptanceRubric: proposal.acceptanceRubric,
      assumptions: proposal.assumptions || [],
      approval: {
        required: true,
        status: 'approved',
        budget: proposal.budgets,
        approvedBy: proposal.approval?.approvedBy || null,
        decidedAt: proposal.approval?.decidedAt || now,
      },
      updatedAt: now,
    };
  }
  const MAX_SCRIPT_SOURCE_BYTES = 20_000;
  function validateScriptSource(scriptSource, expectedHash) {
    if (typeof scriptSource !== 'string' || !scriptSource.trim()) {
      return { ok: false, error: 'workflow_script_source_required' };
    }
    let normalized;
    try {
      normalized = normalizeWorkflowScriptSource(scriptSource);
    } catch (error) {
      return { ok: false, error: error?.code || 'workflow_script_source_invalid' };
    }
    const byteLength = Buffer.byteLength(normalized, 'utf8');
    if (byteLength > MAX_SCRIPT_SOURCE_BYTES) {
      return { ok: false, error: 'workflow_script_source_size_exceeded', limit: MAX_SCRIPT_SOURCE_BYTES, actual: byteLength };
    }
    const actualHash = hashWorkflowScriptSource(normalized);
    if (expectedHash && actualHash !== expectedHash) {
      return { ok: false, error: 'workflow_script_source_hash_mismatch', expected: expectedHash, actual: actualHash };
    }
    return { ok: true, scriptSource: normalized, scriptHash: actualHash };
  }
  function validateScriptWorkflowPreview(projectId, preview) {
    if (!preview || typeof preview !== 'object' || Array.isArray(preview)) return { ok: false, error: 'workflow_script_preview_required' };
    if (preview.ok !== true) return { ok: false, error: 'workflow_script_preview_invalid' };
    if (preview.source !== 'script_generated') return { ok: false, error: 'workflow_script_preview_source_invalid' };
    if (preview.strategy !== 'workflow') return { ok: false, error: 'workflow_script_preview_strategy_invalid' };
    if (preview.projectId !== projectId) return { ok: false, error: 'workflow_script_preview_project_mismatch' };
    if (preview.script || preview.body || preview.sourceCode) return { ok: false, error: 'workflow_script_source_not_allowed' };

    const workflowId = readWorkflowString(preview.workflowId);
    if (!workflowId) return { ok: false, error: 'workflow_id_required' };
    const title = readWorkflowString(preview.title || preview.description);
    if (!title) return { ok: false, error: 'title_required' };
    const description = readWorkflowString(preview.description || preview.title);
    if (!description) return { ok: false, error: 'description_required' };
    const scriptHash = readWorkflowString(preview.scriptHash);
    if (!scriptHash) return { ok: false, error: 'workflow_script_hash_required' };

    const phases = Array.isArray(preview.phases) ? preview.phases : [];
    if (phases.length === 0) return { ok: false, error: 'workflow_script_phases_required' };
    const normalizedPhases = [];
    const phaseIds = new Set();
    for (let index = 0; index < phases.length; index += 1) {
      const phase = phases[index];
      const id = readWorkflowString(phase?.id || `phase-${index + 1}`);
      const phaseTitle = readWorkflowString(phase?.title);
      if (!id) return { ok: false, error: 'workflow_script_phase_id_required' };
      if (phaseIds.has(id)) return { ok: false, error: 'workflow_script_duplicate_phase_id', phaseId: id };
      if (!phaseTitle) return { ok: false, error: 'workflow_script_phase_title_required' };
      phaseIds.add(id);
      normalizedPhases.push({
        id,
        title: phaseTitle,
        detail: readWorkflowString(phase?.detail) || null,
      });
    }

    return {
      ok: true,
      preview: {
        ok: true,
        workflowId,
        source: 'script_generated',
        strategy: 'workflow',
        status: preview.status || 'pending_confirmation',
        projectId,
        scope: preview.scope && typeof preview.scope === 'object' && !Array.isArray(preview.scope)
          ? JSON.parse(JSON.stringify(preview.scope))
          : { projectId },
        requestedBy: readWorkflowString(preview.requestedBy) || 'human',
        createdAt: Number(preview.createdAt || Date.now()),
        title,
        description,
        meta: preview.meta && typeof preview.meta === 'object' && !Array.isArray(preview.meta) ? JSON.parse(JSON.stringify(preview.meta)) : null,
        phases: normalizedPhases,
        scriptHash,
        analysis: preview.analysis && typeof preview.analysis === 'object' && !Array.isArray(preview.analysis)
          ? JSON.parse(JSON.stringify(preview.analysis))
          : null,
      },
    };
  }
  function ensureScriptWorkflowPhase(workflowRun, phaseTitle) {
    const normalizedTitle = readWorkflowString(phaseTitle);
    const existing = workflowRun.phases.find(phase => phase.title === normalizedTitle || phase.id === normalizedTitle);
    if (existing) return { phase: existing, phases: workflowRun.phases };
    const idBase = normalizedTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'phase';
    const existingIds = new Set(workflowRun.phases.map(phase => phase.id));
    let index = workflowRun.phases.length + 1;
    let id = `script-${idBase}`;
    while (existingIds.has(id)) {
      index += 1;
      id = `script-${idBase}-${index}`;
    }
    const phase = { id, title: normalizedTitle, status: 'pending', nodeIds: [] };
    return { phase, phases: [...workflowRun.phases, phase] };
  }
  function allocateScriptAgentNodeId(workflowRun) {
    const existing = new Set(workflowRun.nodes.map(node => node.id));
    let index = workflowRun.nodes.filter(node => String(node.id || '').startsWith('script-agent-')).length + 1;
    let nodeId = `script-agent-${index}`;
    while (existing.has(nodeId)) {
      index += 1;
      nodeId = `script-agent-${index}`;
    }
    return nodeId;
  }

  function allocateScriptParallelGroupId(workflowRun) {
    const existing = new Set((workflowRun.parallelGroups || []).map(group => group.id));
    let index = (workflowRun.parallelGroups || []).filter(group => String(group.id || '').startsWith('script-parallel-')).length + 1;
    let groupId = `script-parallel-${index}`;
    while (existing.has(groupId)) {
      index += 1;
      groupId = `script-parallel-${index}`;
    }
    return groupId;
  }

  function allocateScriptCheckpointId(workflowRun) {
    const existing = new Set((workflowRun.scriptCheckpoints || []).map(checkpoint => checkpoint.id));
    let index = (workflowRun.scriptCheckpoints || []).filter(checkpoint => String(checkpoint.id || '').startsWith('script-checkpoint-')).length + 1;
    let checkpointId = `script-checkpoint-${index}`;
    while (existing.has(checkpointId)) {
      index += 1;
      checkpointId = `script-checkpoint-${index}`;
    }
    return checkpointId;
  }

  function createScriptCheckpoint(workflowRun, {
    primitiveType,
    primitiveId,
    phaseId = null,
    parallelGroupId = null,
    status = 'waiting',
    input = null,
    outputRefs = [],
    now = Date.now(),
  } = {}) {
    return {
      id: allocateScriptCheckpointId(workflowRun),
      workflowRunId: workflowRun.id,
      scriptHash: workflowRun.scriptHash || null,
      primitiveType,
      primitiveId: readWorkflowString(primitiveId) || primitiveType,
      phaseId,
      parallelGroupId,
      status,
      inputHash: createHash('sha256').update(JSON.stringify(input ?? null)).digest('hex'),
      outputRefs: Array.isArray(outputRefs) ? outputRefs.map(String).filter(Boolean) : [],
      createdAt: now,
      updatedAt: now,
    };
  }
  function defaultWorkflowPolicyFor(spec) {
    return {
      maxNodes: Math.max(1, flattenSpecNodeCount(spec)),
      maxParallelism: Math.max(1, Number(spec.budgets?.maxParallelism || 1)),
      maxAgents: Math.max(0, Number(spec.budgets?.maxAgents || 0)),
      maxMinutes: Math.max(1, Number(spec.budgets?.maxMinutes || 1)),
      maxTokens: Math.max(0, Number(spec.budgets?.maxTokens || 0)),
    };
  }
  function flattenSpecNodeCount(spec) {
    return (spec.phases || []).reduce((count, phase) => count + (Array.isArray(phase.nodes) ? phase.nodes.length : 0), 0);
  }
  function hashWorkflowSpec(spec) {
    return createHash('sha256').update(JSON.stringify(spec)).digest('hex');
  }
  function buildWorkflowBudgetGate(spec, policy) {
    return {
      status: 'passed',
      hardLimits: {
        maxNodes: Number(policy?.maxNodes || flattenSpecNodeCount(spec)),
        maxParallelism: Number(policy?.maxParallelism || spec.budgets?.maxParallelism || 1),
        maxAgents: Number(policy?.maxAgents || spec.budgets?.maxAgents || 0),
        maxMinutes: Number(policy?.maxMinutes || spec.budgets?.maxMinutes || 0),
        maxTokens: Number(policy?.maxTokens || spec.budgets?.maxTokens || 0),
      },
      estimate: {
        riskLevel: inferWorkflowBudgetRisk(spec),
        reason: '估算只用于风险提示；KSwarm 在启动和 dispatch 前执行 hard limits。',
      },
    };
  }
  function inferWorkflowBudgetRisk(spec) {
    const agents = Number(spec.budgets?.maxAgents || 0);
    const tokens = Number(spec.budgets?.maxTokens || 0);
    if (agents >= 8 || tokens >= 50_000) return 'high';
    if (agents >= 2 || tokens >= 10_000) return 'medium';
    return 'low';
  }
  function resolveWorkflowSourceTask(board, taskId) {
    if (!taskId) return { ok: true, task: null };
    const task = board.getTask(taskId);
    if (!task) return { ok: false, error: 'task_not_found', taskId };
    return { ok: true, task };
  }
  function formatWorkflowSourceTask(task = {}) {
    const sourceTask = {
      id: task.id,
      title: task.title || '',
      status: task.status || '',
      assignedAgent: task.assignedAgent || null,
    };
    assignWorkflowField(sourceTask, 'failureReason', readWorkflowString(task.failureReason));
    assignWorkflowField(sourceTask, 'lastFailureClass', readWorkflowString(task.lastFailureClass));
    if (Number(task.qualityFailureCount || 0) > 0) sourceTask.qualityFailureCount = Number(task.qualityFailureCount);
    assignWorkflowField(sourceTask, 'repairInstruction', buildWorkflowRepairInstruction(task));
    if (task.reviewResult?.passed === false) {
      sourceTask.reviewResult = {
        passed: false,
        feedback: task.reviewResult.feedback || '',
        failureClass: task.reviewResult.failureClass || null,
        reviewedAt: task.reviewResult.reviewedAt || null,
      };
    }
    return sourceTask;
  }
  function buildWorkflowRepairInstruction(task = {}) {
    const explicit = readWorkflowString(task.repairInstruction);
    if (explicit) return explicit;
    const failureReason = readWorkflowString(task.failureReason);
    if (failureReason) return failureReason;
    return task.reviewResult?.passed === false ? readWorkflowString(task.reviewResult.feedback) : '';
  }
  function assignWorkflowField(target, key, value) {
    if (value === null || value === undefined || value === '') return;
    target[key] = value;
  }

  function normalizeWorkflowScriptTerminalDecision(terminal) {
    if (!terminal || typeof terminal !== 'object' || Array.isArray(terminal)) return null;
    const status = readWorkflowString(terminal.status);
    if (!status || status === 'finished' || status === 'passed') return { status: 'passed', reason: readWorkflowString(terminal.reason), evidenceRefs: readWorkflowStringArray(terminal.evidenceRefs) };
    const gateStatus = status === 'blocked' || status === 'needs_replanning' || status === 'needs_rubric_clarification'
      ? status
      : 'blocked';
    return {
      status: gateStatus,
      reason: readWorkflowString(terminal.reason) || gateStatus,
      evidenceRefs: readWorkflowStringArray(terminal.evidenceRefs),
    };
  }

  function getFirstDependencyOutput(workflowRun, node) {
    const dependencyId = Array.isArray(node.dependsOn) ? node.dependsOn[0] : null;
    if (!dependencyId) return null;
    return workflowRun.nodes.find(item => item.id === dependencyId)?.output || null;
  }
  function maybeSubmitTaskWorkflowDeliverable(workflowRun, { now = Date.now() } = {}) {
    if (
      workflowRun.workflowId !== PO_GENERATED_TASK_WORKFLOW_ID ||
      workflowRun.status !== 'completed' ||
      workflowRun.gateDecision?.status !== 'passed' ||
      !workflowRun.scope?.taskId
    ) {
      return { workflowRun, submission: null };
    }

    const board = boards.get(workflowRun.projectId);
    const task = board?.getTask(workflowRun.scope.taskId);
    if (!board || !task) {
      return {
        workflowRun: markWorkflowTaskSubmissionBlocked(workflowRun, 'task_not_found', { now }),
        submission: { ok: false, error: 'task_not_found' },
      };
    }
    if (task.status === 'submitted' || task.status === 'done') {
      return {
        workflowRun: {
          ...workflowRun,
          taskSubmission: {
            status: 'already_submitted',
            taskId: task.id,
            submittedAt: task.updatedAt || now,
            runId: `workflow-${workflowRun.id}`,
          },
        },
        submission: { ok: true, alreadySubmitted: true },
      };
    }

    const producerNode = workflowRun.nodes.find(item => item.id === TASK_WORKFLOW_DELIVERABLE_NODE_ID)
      || workflowRun.nodes.find(item => item.kind === 'agent_task' && item.status === 'completed');
    if (!producerNode?.output) {
      return {
        workflowRun: markWorkflowTaskSubmissionBlocked(workflowRun, 'worker_deliverable_missing', { now }),
        submission: { ok: false, error: 'worker_deliverable_missing' },
      };
    }

    const workerAgent = task.assignedAgent || producerNode.producerAgent || producerNode.assignedAgent || null;
    const runId = `workflow-${workflowRun.id}`;
    const result = buildWorkflowTaskSubmissionResult({ workflowRun, task, producerNode });
    const readyForSubmission = ensureWorkflowTaskSubmissionState(workflowRun.projectId, task, workerAgent, runId);
    if (!readyForSubmission.ok) {
      return {
        workflowRun: markWorkflowTaskSubmissionBlocked(workflowRun, readyForSubmission.error || 'task_submission_state_failed', { now }),
        submission: readyForSubmission,
      };
    }
    const submission = handleSubmitResult(workflowRun.projectId, task.id, result, workerAgent, runId);
    if (!submission.ok) {
      eventLog.emit('task.workflow_submission_failed', {
        projectId: workflowRun.projectId,
        taskId: task.id,
        workflowRunId: workflowRun.id,
        error: submission.error || 'task_submission_failed',
        failureClass: submission.failureClass || null,
      });
      return {
        workflowRun: markWorkflowTaskSubmissionBlocked(workflowRun, submission.error || 'task_submission_failed', { now }),
        submission,
      };
    }

    return {
      workflowRun: {
        ...workflowRun,
        taskSubmission: {
          status: 'submitted',
          taskId: task.id,
          submittedAt: now,
          runId,
        },
      },
      submission,
    };
  }
  function maybeDeliverProjectWorkflowDeliverable(workflowRun, { now = Date.now() } = {}) {
    if (
      workflowRun.workflowId !== PO_GENERATED_PROJECT_WORKFLOW_ID ||
      workflowRun.status !== 'completed' ||
      workflowRun.gateDecision?.status !== 'passed'
    ) {
      return { workflowRun, delivery: null };
    }

    const project = projects.get(workflowRun.projectId);
    const board = boards.get(workflowRun.projectId);
    if (!project || !board) {
      return {
        workflowRun: markWorkflowProjectDeliveryBlocked(workflowRun, 'project_not_found', { now }),
        delivery: { ok: false, error: 'project_not_found' },
      };
    }

    const producerNode = workflowRun.nodes.find(item => item.id === PROJECT_WORKFLOW_DELIVERABLE_NODE_ID)
      || workflowRun.nodes.find(item => item.kind === 'agent_task' && item.status === 'completed');
    if (!producerNode?.output) {
      return {
        workflowRun: markWorkflowProjectDeliveryBlocked(workflowRun, 'worker_deliverable_missing', { now }),
        delivery: { ok: false, error: 'worker_deliverable_missing' },
      };
    }

    const deliverable = buildWorkflowProjectDeliverable({ workflowRun, producerNode });
    if (deliverable.artifacts.length === 0) {
      return {
        workflowRun: markWorkflowProjectDeliveryBlocked(workflowRun, 'worker_deliverable_missing', { now }),
        delivery: { ok: false, error: 'worker_deliverable_missing' },
      };
    }

    const artifactValidation = validateWorkflowProjectArtifacts({ project, board, deliverable });
    if (!artifactValidation.ok) {
      return {
        workflowRun: markWorkflowProjectDeliveryBlocked(workflowRun, artifactValidation.error || 'worker_artifact_invalid', { now, details: artifactValidation }),
        delivery: artifactValidation,
      };
    }

    if (!board.isAllDone()) {
      return {
        workflowRun: markWorkflowProjectDeliveryBlocked(workflowRun, 'tasks_not_all_done', { now }),
        delivery: { ok: false, error: 'tasks_not_all_done' },
      };
    }

    const taskCompletion = markProjectTasksDoneByWorkflow({ project, board, workflowRun, deliverable, producerNode, now });
    if (!taskCompletion.ok) {
      return {
        workflowRun: markWorkflowProjectDeliveryBlocked(workflowRun, taskCompletion.error || 'task_completion_failed', { now }),
        delivery: taskCompletion,
      };
    }

    const delivery = handleDeliver(workflowRun.projectId, deliverable, project.poAgent);
    if (!delivery.ok) {
      return {
        workflowRun: markWorkflowProjectDeliveryBlocked(workflowRun, delivery.error || 'project_delivery_failed', { now }),
        delivery,
      };
    }

    return {
      workflowRun: {
        ...workflowRun,
        projectDelivery: {
          status: 'delivered',
          deliveredAt: now,
          projectId: workflowRun.projectId,
          workflowRunId: workflowRun.id,
          taskCount: taskCompletion.completedTaskIds.length,
        },
      },
      delivery,
    };
  }

  function maybeDeliverScriptWorkflowProjectResult(workflowRun, { now = Date.now() } = {}) {
    if (
      workflowRun.source !== 'script_generated' ||
      workflowRun.status !== 'completed' ||
      workflowRun.scope?.taskId
    ) {
      return { workflowRun, delivery: null };
    }

    const project = projects.get(workflowRun.projectId);
    const board = boards.get(workflowRun.projectId);
    if (!project || !board || project.status === 'closed') return { workflowRun, delivery: null };

    if (
      project.status === 'delivered' &&
      project.deliverable?.provenance?.workflowRunId === workflowRun.id
    ) {
      return {
        workflowRun: {
          ...workflowRun,
          projectDelivery: workflowRun.projectDelivery || {
            status: 'delivered',
            deliveredAt: project.deliveredAt || now,
            projectId: workflowRun.projectId,
            workflowRunId: workflowRun.id,
            taskCount: board.getAllTasks().filter(task => task.status === 'done').length,
          },
        },
        delivery: { ok: true, alreadyDelivered: true },
      };
    }

    const producerNode = selectScriptWorkflowProjectDeliverableProducer(workflowRun);
    if (!producerNode?.output) return { workflowRun, delivery: null };

    const deliverable = buildWorkflowProjectDeliverable({
      workflowRun,
      producerNode,
      runtimeSource: 'kswarm-script-workflow',
    });
    if (deliverable.artifacts.length === 0) return { workflowRun, delivery: null };

    const artifactValidation = validateWorkflowProjectArtifacts({ project, board, deliverable });
    if (!artifactValidation.ok) {
      return {
        workflowRun: markWorkflowProjectDeliveryBlocked(workflowRun, artifactValidation.error || 'worker_artifact_invalid', { now, details: artifactValidation }),
        delivery: artifactValidation,
      };
    }

    const taskCompletion = markProjectTasksDoneByWorkflow({
      project,
      board,
      workflowRun,
      deliverable,
      producerNode,
      now,
      runtimeSource: 'kswarm-script-workflow',
      completedBy: 'script_workflow',
      reviewFeedback: '动态 workflow 已完成并生成项目交付物。',
      executionReasonCode: 'script_workflow_completed',
    });
    if (!taskCompletion.ok) {
      return {
        workflowRun: markWorkflowProjectDeliveryBlocked(workflowRun, taskCompletion.error || 'task_completion_failed', { now }),
        delivery: taskCompletion,
      };
    }

    const delivery = handleDeliver(workflowRun.projectId, deliverable, project.poAgent);
    if (!delivery.ok) {
      return {
        workflowRun: markWorkflowProjectDeliveryBlocked(workflowRun, delivery.error || 'project_delivery_failed', { now }),
        delivery,
      };
    }

    project.status = 'closed';
    project.closedAt = now;
    project.closedBy = 'script_workflow';
    eventLog.emit('project.closed', { projectId: workflowRun.projectId, projectName: project.name, summary: 'Script workflow delivered and auto-closed' });

    return {
      workflowRun: {
        ...workflowRun,
        projectDelivery: {
          status: 'delivered',
          deliveredAt: now,
          projectId: workflowRun.projectId,
          workflowRunId: workflowRun.id,
          taskCount: taskCompletion.completedTaskIds.length,
        },
      },
      delivery,
    };
  }

  function reconcileRecoveredScriptWorkflowProjectDeliveries({ now = Date.now() } = {}) {
    const delivered = [];
    const blocked = [];
    for (const workflowRun of workflowRuns.values()) {
      const result = maybeDeliverScriptWorkflowProjectResult(workflowRun, { now });
      if (result.workflowRun !== workflowRun) {
        workflowRuns.set(result.workflowRun.id, result.workflowRun);
      }
      if (result.delivery?.ok) {
        delivered.push({ projectId: workflowRun.projectId, workflowRunId: workflowRun.id });
      } else if (result.delivery?.error) {
        blocked.push({ projectId: workflowRun.projectId, workflowRunId: workflowRun.id, error: result.delivery.error });
      }
    }
    return { ok: true, delivered, blocked };
  }

  function selectScriptWorkflowProjectDeliverableProducer(workflowRun) {
    const runtimeNode = workflowRun.nodes.find(item => item.id === 'script-runtime' && item.output);
    if (runtimeNode && collectWorkflowOutputArtifacts(runtimeNode.output).length > 0) return runtimeNode;
    return [...workflowRun.nodes]
      .reverse()
      .find(item => item.kind === 'agent_task' && item.status === 'completed' && item.output && collectWorkflowOutputArtifacts(item.output).length > 0)
      || runtimeNode
      || [...workflowRun.nodes].reverse().find(item => item.kind === 'agent_task' && item.status === 'completed' && item.output);
  }

  function buildWorkflowProjectDeliverable({ workflowRun, producerNode, runtimeSource = 'kswarm-project-workflow' }) {
    const output = producerNode.output && typeof producerNode.output === 'object' ? producerNode.output : {};
    const summary = readWorkflowString(output.summary)
      || readWorkflowString(output.text)
      || '项目级工作流已生成最终交付物。';
    const workFolder = readWorkflowString(output.workFolder) || readWorkflowString(output.workspacePath);
    const artifactManifest = Array.isArray(output.artifactManifest) ? output.artifactManifest : [];
    const artifacts = collectWorkflowOutputArtifacts(output);
    const evidenceRefs = mergeWorkflowArtifactEvidenceRefs(output.evidenceRefs, artifacts);
    return {
      summary,
      artifacts,
      ...(artifactManifest.length > 0 ? { artifactManifest } : {}),
      ...(workFolder ? { workFolder, workspacePath: workFolder } : {}),
      evidenceRefs,
      provenance: {
        runtimeSource,
        workflowRunId: workflowRun.id,
        workflowId: workflowRun.workflowId,
        producerNodeId: producerNode.id,
        producingAgent: producerNode.producerAgent || producerNode.assignedAgent || null,
      },
    };
  }

  function collectWorkflowOutputArtifacts(output = {}) {
    const collected = [];
    const seen = new Set();
    function addArtifact(artifact) {
      const normalized = normalizeWorkflowArtifactRecord(artifact);
      const path = readWorkflowArtifactPath(normalized);
      if (!path || seen.has(path)) return;
      if (isSystemPlanArtifactPath(path)) return;
      seen.add(path);
      collected.push(normalized);
    }

    for (const artifact of Array.isArray(output.artifacts) ? output.artifacts : []) addArtifact(artifact);
    for (const artifact of Array.isArray(output.artifactManifest) ? output.artifactManifest : []) addArtifact(artifact);
    for (const ref of readWorkflowStringArray(output.evidenceRefs)) {
      const artifactPath = extractWorkflowArtifactPathFromText(ref);
      if (artifactPath) addArtifact({ path: artifactPath });
    }
    return collected;
  }

  function normalizeWorkflowArtifactRecord(artifact) {
    if (typeof artifact === 'string') {
      return {
        path: artifact,
        label: basename(artifact.replace(/^artifact:/, '')),
        kind: inferWorkflowArtifactKind(artifact),
      };
    }
    if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) return {};
    const path = readWorkflowArtifactPath(artifact);
    return {
      ...JSON.parse(JSON.stringify(artifact)),
      ...(path && !artifact.path ? { path } : {}),
      label: artifact.label || artifact.title || artifact.filename || artifact.name || (path ? basename(path) : undefined),
      kind: artifact.kind || inferWorkflowArtifactKind(path),
    };
  }

  function extractWorkflowArtifactPathFromText(value) {
    const text = readWorkflowString(value);
    if (!text) return '';
    const normalized = text.replace(/^artifact:/, '');
    const relativeMatch = normalized.match(/(?:^|[\s"'（(])(?:artifact:)?((?:\.\/)?artifacts\/[^\s,，;；:：)）\]】]+)/);
    if (relativeMatch?.[1]) return relativeMatch[1].replace(/^\.\//, '');
    const absoluteMatch = normalized.match(/((?:\/[^\s,，;；:：)）\]】]+)+\/artifacts\/[^\s,，;；:：)）\]】]+)/);
    return absoluteMatch?.[1] || '';
  }

  function isSystemPlanArtifactPath(path) {
    const name = basename(String(path || '').replace(/^artifact:/, ''));
    return /^plan-v\d+\.md$/i.test(name);
  }

  function inferWorkflowArtifactKind(path) {
    const lower = String(path || '').toLowerCase();
    if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown';
    if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'html';
    if (lower.endsWith('.pdf')) return 'pdf';
    if (lower.endsWith('.json')) return 'json';
    return 'file';
  }
  function validateWorkflowProjectArtifacts({ project, board, deliverable } = {}) {
    const artifacts = Array.isArray(deliverable?.artifacts) ? deliverable.artifacts : [];
    if (artifacts.length === 0) return { ok: false, error: 'worker_deliverable_missing' };

    const workspacePath = readWorkflowString(deliverable?.workFolder)
      || readWorkflowString(deliverable?.workspacePath)
      || readWorkflowString(project?.workFolder)
      || readWorkflowString(project?.workspacePath);
    const workspaceRealPath = safeWorkflowRealPath(workspacePath);
    if (!workspaceRealPath) return { ok: false, error: 'worker_artifact_invalid' };

    const workspaceArtifacts = [];
    for (const artifact of artifacts) {
      const checked = validateWorkflowProjectArtifactPath(artifact, { workspaceRealPath });
      if (checked.ok) {
        workspaceArtifacts.push(artifact);
      }
    }
    if (workspaceArtifacts.length === 0) return { ok: false, error: 'worker_artifact_invalid' };
    const outputValidation = validateWorkflowProjectRequiredOutputs({ board, deliverable, workspacePath: workspaceRealPath });
    if (!outputValidation.ok) return outputValidation;
    return { ok: true };
  }
  function validateWorkflowProjectRequiredOutputs({ board, deliverable, workspacePath = '' } = {}) {
    const requiredOutputs = collectWorkflowTerminalRequiredOutputs(board);
    if (requiredOutputs.length === 0) return { ok: true };
    const result = validateDeliverableContract({
      requiredOutputs,
      artifacts: [
        ...(Array.isArray(deliverable?.artifacts) ? deliverable.artifacts : []),
        ...(Array.isArray(deliverable?.artifactManifest) ? deliverable.artifactManifest : []),
      ],
      workspacePath,
    });
    if (result.ok) return { ok: true };
    return {
      ok: false,
      error: 'worker_required_output_missing',
      failureClass: result.failureClass,
      errors: result.errors,
      missing: result.missing,
    };
  }
  function collectWorkflowTerminalRequiredOutputs(board) {
    if (!board || typeof board.getAllTasks !== 'function') return [];
    const tasks = board.getAllTasks().filter(task => task.status !== 'cancelled');
    if (tasks.length === 0) return [];
    const referenced = new Set();
    for (const task of tasks) {
      for (const depRef of Array.isArray(task.dependencies) ? task.dependencies : []) {
        const value = String(depRef || '').trim();
        if (value) referenced.add(value);
      }
    }
    const terminalTasks = tasks.filter(task => !isWorkflowTaskReferencedByDependency(task, referenced));
    const outputs = [];
    for (const task of terminalTasks.length > 0 ? terminalTasks : tasks) {
      const requirements = inferTaskRequirements(task);
      for (const output of requirements.requiredOutputs || []) {
        if (output.enforcement === 'hard') outputs.push(output);
      }
    }
    return outputs;
  }
  function isWorkflowTaskReferencedByDependency(task, referenced) {
    const candidates = [
      task.id,
      task.localTaskId,
      task.planItemId,
      task.title,
    ].map(value => String(value || '').trim()).filter(Boolean);
    return candidates.some(value => referenced.has(value));
  }
  function validateWorkflowProjectArtifactPath(artifact, { workspaceRealPath = null } = {}) {
    if (!workspaceRealPath) return { ok: false, error: 'worker_artifact_invalid' };
    const artifactPath = readWorkflowArtifactPath(artifact);
    if (!artifactPath || artifactPath.includes('\0')) return { ok: false, error: 'worker_artifact_invalid' };
    const normalized = artifactPath.replace(/^artifact:/, '').replace(/\\/g, '/');
    let candidate;
    if (isAbsolute(normalized)) {
      candidate = resolve(normalized);
    } else {
      candidate = resolve(workspaceRealPath, normalized);
    }

    const realPath = safeWorkflowRealPath(candidate);
    if (!realPath) return { ok: false, error: 'worker_artifact_invalid' };
    if (!isWorkflowPathInside(workspaceRealPath, realPath)) return { ok: false, error: 'worker_artifact_invalid' };
    if (!isReadableWorkflowArtifact(realPath)) return { ok: false, error: 'worker_artifact_invalid' };
    return { ok: true, path: realPath };
  }
  function readWorkflowArtifactPath(artifact) {
    if (typeof artifact === 'string') return artifact.trim();
    if (!artifact || typeof artifact !== 'object') return '';
    return readWorkflowString(artifact.path)
      || readWorkflowString(artifact.relativePath)
      || readWorkflowString(artifact.artifactPath)
      || readWorkflowString(artifact.filename)
      || readWorkflowString(artifact.name);
  }
  function mergeWorkflowArtifactEvidenceRefs(rawEvidenceRefs, artifacts = []) {
    const refs = new Set(readWorkflowStringArray(rawEvidenceRefs));
    for (const artifact of artifacts) {
      const artifactPath = readWorkflowArtifactPath(artifact);
      if (artifactPath) refs.add(`artifact:${artifactPath}`);
    }
    return [...refs];
  }
  function safeWorkflowRealPath(value) {
    if (!value || typeof value !== 'string') return null;
    try {
      return realpathSync(value);
    } catch {
      return null;
    }
  }
  function isWorkflowPathInside(root, target) {
    const rel = relative(root, target);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  }
  function isReadableWorkflowArtifact(path) {
    if (!path || !existsSync(path)) return false;
    try {
      return readFileSync(path).length > 0;
    } catch {
      return false;
    }
  }
  function markProjectTasksDoneByWorkflow({
    project,
    board,
    workflowRun,
    deliverable,
    producerNode,
    now = Date.now(),
    runtimeSource = 'kswarm-project-workflow',
    completedBy = 'project_workflow',
    reviewFeedback = '项目级 workflow gate 已通过。',
    executionReasonCode = 'project_workflow_preferred',
  } = {}) {
    const completedTaskIds = [];
    for (const task of board.getAllTasks()) {
      if (task.status === 'cancelled') continue;
      const oldStatus = task.status;
      task.status = 'done';
      task.result = {
        summary: `项目级工作流已覆盖完成任务：${task.title || task.id}`,
        projectDeliverableSummary: deliverable.summary,
        artifacts: deliverable.artifacts,
        evidenceRefs: deliverable.evidenceRefs,
        provenance: {
          runtimeSource,
          workflowRunId: workflowRun.id,
          workflowId: workflowRun.workflowId,
          producerNodeId: producerNode.id,
          producingAgent: producerNode.producerAgent || producerNode.assignedAgent || task.assignedAgent || null,
        },
      };
      task.completedBy = completedBy;
      task.completedByWorkflowRunId = workflowRun.id;
      task.completedAt = now;
      task.updatedAt = now;
      task.activeRunId = null;
      task.runLease = null;
      task.runTelemetry = null;
      task.assignedExecutor = null;
      task.failureReason = null;
      task.lastFailureClass = null;
      task.blockedAt = null;
      task.blockedReason = null;
      task.blockKind = null;
      task.nextActions = [];
      task.recoveryStatus = null;
      task.recoveryReason = null;
      task.reviewResult = {
        passed: true,
        feedback: reviewFeedback,
        reviewedAt: now,
      };
      task.execution = {
        strategy: 'workflow',
        modeSource: 'project_default',
        reasonCode: executionReasonCode,
        workflowRunId: workflowRun.id,
        selectedAt: workflowRun.startedAt || workflowRun.createdAt || now,
      };
      updatePlanItemCompleted(project, task);
      completedTaskIds.push(task.id);
      if (oldStatus !== 'done') {
        eventLog.emit('task.done', {
          projectId: workflowRun.projectId,
          taskId: task.id,
          taskTitle: task.title,
          confirmedBy: completedBy,
          workflowRunId: workflowRun.id,
        });
      }
    }
    return { ok: true, completedTaskIds };
  }
  function markWorkflowProjectDeliveryBlocked(workflowRun, reason, { now = Date.now(), details = null } = {}) {
    const deliveryDetails = details && typeof details === 'object'
      ? {
          ...(details.error ? { error: details.error } : {}),
          ...(details.failureClass ? { failureClass: details.failureClass } : {}),
          ...(Array.isArray(details.errors) ? { errors: details.errors } : {}),
          ...(Array.isArray(details.missing) ? { missing: details.missing } : {}),
        }
      : {};
    return {
      ...workflowRun,
      status: 'blocked',
      completedAt: now,
      gateDecision: {
        status: 'blocked',
        reason: `project_delivery_failed:${reason}`,
        evidenceRefs: workflowRun.gateDecision?.evidenceRefs || [],
      },
      projectDelivery: {
        status: 'failed',
        projectId: workflowRun.projectId,
        failedAt: now,
        reason,
        ...deliveryDetails,
      },
      summary: {
        ...(workflowRun.summary || {}),
        primaryMessage: 'Project workflow delivery blocked',
      },
    };
  }
  function buildWorkflowTaskSubmissionResult({ workflowRun, task, producerNode }) {
    const output = producerNode.output && typeof producerNode.output === 'object' ? producerNode.output : {};
    const summary = readWorkflowString(output.summary)
      || readWorkflowString(output.text)
      || `工作流完成任务：${task.title || task.id}`;
    const workFolder = readWorkflowString(output.workFolder) || readWorkflowString(output.workspacePath);
    const artifactManifest = Array.isArray(output.artifactManifest) ? output.artifactManifest : [];
    return {
      summary,
      artifacts: Array.isArray(output.artifacts) ? output.artifacts : [],
      ...(artifactManifest.length > 0 ? { artifactManifest } : {}),
      ...(workFolder ? { workFolder, workspacePath: workFolder } : {}),
      evidenceRefs: readWorkflowStringArray(output.evidenceRefs),
      provenance: {
        runtimeSource: 'kswarm-workflow',
        workflowRunId: workflowRun.id,
        workflowId: workflowRun.workflowId,
        producerNodeId: producerNode.id,
        producingAgent: producerNode.producerAgent || producerNode.assignedAgent || task.assignedAgent || null,
      },
    };
  }
  function ensureWorkflowTaskSubmissionState(projectId, task, workerAgent, runId) {
    let current = boards.get(projectId)?.getTask(task.id);
    if (!current) return { ok: false, error: 'task_not_found' };
    if (current.status === 'submitted' || current.status === 'done') return { ok: true };
    if (current.status === 'dispatched') {
      const accepted = handleAcceptTask(projectId, current.id, workerAgent, runId);
      if (!accepted.ok && !accepted.alreadyAccepted) return accepted;
      current = boards.get(projectId)?.getTask(task.id);
    }
    if (current?.status === 'accepted') {
      const progressed = handleProgress(projectId, current.id, 'started', workerAgent, runId);
      if (!progressed.ok && !progressed.alreadyInProgress) return progressed;
      current = boards.get(projectId)?.getTask(task.id);
    }
    if (current?.status !== 'in_progress' && current?.status !== 'submitted') {
      return { ok: false, error: `cannot_submit_workflow_task_from_status:${current?.status || 'missing'}` };
    }
    return { ok: true };
  }
  function markWorkflowTaskSubmissionBlocked(workflowRun, reason, { now = Date.now() } = {}) {
    return {
      ...workflowRun,
      status: 'blocked',
      completedAt: now,
      gateDecision: {
        status: 'blocked',
        reason: `task_submission_failed:${reason}`,
        evidenceRefs: workflowRun.gateDecision?.evidenceRefs || [],
      },
      taskSubmission: {
        status: 'failed',
        taskId: workflowRun.scope?.taskId || null,
        failedAt: now,
        reason,
      },
      summary: {
        ...(workflowRun.summary || {}),
        primaryMessage: 'Task workflow submission blocked',
      },
    };
  }
  function readWorkflowString(value) {
    return typeof value === 'string' ? value.trim() : '';
  }
  function readWorkflowStringArray(value) {
    return Array.isArray(value) ? value.map(item => readWorkflowString(item)).filter(Boolean) : [];
  }
  function emitWorkflowDispatchEvents(projectId, dispatches = []) {
    for (const dispatch of dispatches) {
      eventLog.emit('workflow.node.dispatched', {
        projectId,
        workflowRunId: dispatch.workflowRunId,
        workflowId: dispatch.workflowId,
        nodeId: dispatch.nodeId,
        targetParticipantId: dispatch.targetParticipantId,
        attempt: dispatch.attempt,
        handoffId: dispatch.handoffId,
      });
    }
  }
  function getHumanActions(projectId) {
    if (projectId) return humanActions.filter(a => a.projectId === projectId);
    return [...humanActions];
  }

  // Wrap mutation methods to auto-persist state
  const mutations = {
    createProject,
    updateProjectExecutionMode,
    handleApprove,
    handleRetryPlan,
    handleHumanAddTasks,
    handleCloseProject,
    deleteProject,
    handleCreateTasks,
    handleAssignTask,
    handleReassignTask,
    handleRequestDispatch,
    handleMarkDone,
    handleRework,
    handleDeliver,
    handleSubmitPlan,
    handleRevisePlan,
    handleQualityReview,
    handleAcceptTask,
    handleProgress,
    handleWorkerFailure,
    handleSubmitResult,
    handleRecoverSubmission,
    handleResetTaskForRecovery,
    handleResumeTaskForRecovery,
    handleSuspendActiveRuns,
    handleResumeSuspendedRuns,
    handleTaskFail,
    handleContinueProject,
    handleResolveProjectIntervention,
    createWorkflowProposal,
    cancelWorkflowProposal,
    createScriptWorkflowProposal,
    startWorkflowRunFromProposal,
    startScriptWorkflowRunFromProposal,
    beginWorkflowScriptParallelGroup,
    dispatchWorkflowScriptAgentNode,
    retryWorkflowScriptAgentNode,
    completeScriptWorkflowRun,
    startProjectDiagnoseWorkflow,
    startAgentReviewSmokeWorkflow,
    handleWorkflowNodeResult,
    handleWorkflowNodeReview,
    handleWorkflowRuntimeUnavailable,
    handleWorkflowProgressBatch,
    cancelWorkflowRun,
    recoverInterruptedTaskWorkflows,
  };

  const persisted = {};
  for (const [name, fn] of Object.entries(mutations)) {
    persisted[name] = (...args) => {
      const result = fn(...args);
      persistState();
      return result;
    };
  }

  return {
    ...persisted,
    getProject,
    getBoard,
    getEventLog,
    listProjects,
    findReusableProjectForCreateRequest,
    getDispatchPlan,
    getProjectHealth,
    getProjectIntervention,
    listResumableScriptWorkflowRuns,
    deriveScriptWorkflowIntervention,
    createWorkflowProposal: persisted.createWorkflowProposal,
    cancelWorkflowProposal: persisted.cancelWorkflowProposal,
    createScriptWorkflowProposal: persisted.createScriptWorkflowProposal,
    startWorkflowRunFromProposal: persisted.startWorkflowRunFromProposal,
    startScriptWorkflowRunFromProposal: persisted.startScriptWorkflowRunFromProposal,
    beginWorkflowScriptParallelGroup: persisted.beginWorkflowScriptParallelGroup,
    dispatchWorkflowScriptAgentNode: persisted.dispatchWorkflowScriptAgentNode,
    retryWorkflowScriptAgentNode: persisted.retryWorkflowScriptAgentNode,
    completeScriptWorkflowRun: persisted.completeScriptWorkflowRun,
    startProjectDiagnoseWorkflow: persisted.startProjectDiagnoseWorkflow,
    startAgentReviewSmokeWorkflow: persisted.startAgentReviewSmokeWorkflow,
    handleWorkflowNodeResult: persisted.handleWorkflowNodeResult,
    handleWorkflowNodeReview: persisted.handleWorkflowNodeReview,
    handleWorkflowRuntimeUnavailable: persisted.handleWorkflowRuntimeUnavailable,
    handleWorkflowProgressBatch: persisted.handleWorkflowProgressBatch,
    cancelWorkflowRun: persisted.cancelWorkflowRun,
    recoverInterruptedTaskWorkflows: persisted.recoverInterruptedTaskWorkflows,
    listProjectWorkflowRuns,
    getWorkflowRun,
    getHumanActions,
    persistState,
  };
}
