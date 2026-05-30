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
import { dirname, join } from 'node:path';
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
import { createProjectDiagnoseWorkflowRun } from './workflow-builtins.js';
import {
  appendQualityPlanningGuidance,
  buildQualityPromptExcerpt,
  compileEffectiveQualityRuleSet,
} from './quality-rules.js';

const TASK_LEVEL_WORKER_FAILURE_CLASSES = new Set(['model_empty_output', 'quality_evidence_missing', 'source_provider_unavailable']);

export function createHub({ bridge, eventLogDir, silent = false, dataDir, getAgentProfiles = null, getQualityOverlays = null, runtimeInstanceAllocator = null } = {}) {
  const projects = new Map();
  const boards = new Map();
  const workflowRuns = new Map();
  const eventLog = createEventLog({ logDir: eventLogDir, silent });
  const persistence = typeof dataDir === 'string' ? createPersistence(dataDir) : null;

  // Restore state from disk
  if (persistence) {
    const saved = persistence.load();
    if (saved && saved.projects) {
      for (const p of saved.projects) {
        projects.set(p.id, p);
      }
      for (const { projectId, tasks } of (saved.boards || [])) {
        boards.set(projectId, restoreTaskBoard(tasks, projectId));
      }
      for (const run of (saved.workflowRuns || [])) {
        if (run?.id) workflowRuns.set(run.id, run);
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
      humanActions,
    }));
  }

  // Human action log — tracks all human decisions
  const humanActions = [];

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
    return String(value || '').trim();
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

  function createProject({ id, name, goal, requirements, planningGuidance, poAgent, members = [], enableSummary, agentSelection = null, preparationContext = null }) {
    const createdAt = Date.now();
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
      name,
      goal,
      requirements: requirements || '',
      planningGuidance: planningGuidance || '',
      qualityRuleSet,
      qualityPlanningGuidance,
      agentSelection: normalizeAgentSelection({ poAgent, members, agentSelection }),
      preparation: null,
      poAgent,
      members,
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
    projects.set(id, project);
    boards.set(id, createTaskBoard(id));

    eventLog.emit('project.created', { projectId: id, projectName: name, po: poAgent });
    recordHumanAction('create_project', { projectId: id, projectName: name, poAgent });

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

    if (!project.preparation || project.preparation.state === 'ready') {
      sendAssignPo(project, effectivePlanningGuidance);
    }
    return project;
  }

  function normalizeAgentSelection({ poAgent, members = [], agentSelection = null } = {}) {
    return {
      ...(agentSelection && typeof agentSelection === 'object' ? agentSelection : {}),
      poAgent: {
        agentId: agentSelection?.poAgent?.agentId || poAgent,
        source: agentSelection?.poAgent?.source || 'system_migration',
      },
      members: Array.isArray(agentSelection?.members)
        ? agentSelection.members.map(member => ({
            agentId: member?.agentId || member?.id || member,
            source: member?.source || 'system_migration',
          })).filter(member => member.agentId)
        : (Array.isArray(members) ? members : []).map(agentId => ({
            agentId,
            source: 'system_migration',
          })),
    };
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
    const skipped = [...(dispatchPlan.skipped || [])];

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
        projectId, taskId: task.id, taskTitle: task.title, agent: task.assignedAgent, target: assignedRuntimeInstance || task.assignedAgent, runtimeInstance: assignedRuntimeInstance,
      });
      dispatched.push(task.id);
    }

    return {
      ok: true,
      dispatched,
      skipped,
      blocked: dispatchPlan.blocked,
      projectGate: dispatchPlan.projectGate,
    };
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
  function handleDeliver(projectId, deliverable, fromAgent) {
    const project = projects.get(projectId);
    if (!project || project.poAgent !== fromAgent) return { ok: false, error: 'not_po' };

    // Gate: all tasks must be done
    const board = boards.get(projectId);
    if (board && !board.isAllDone()) {
      return { ok: false, error: 'tasks_not_all_done' };
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
        if (!validation.ok) {
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
    return deriveProjectIntervention({
      project,
      tasks: board.getAllTasks(),
      agents: getProjectAgentProfiles(project),
      dispatchPlan,
    });
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
  function listProjectWorkflowRuns(projectId) {
    return [...workflowRuns.values()]
      .filter(run => run.projectId === projectId)
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }
  function getWorkflowRun(workflowRunId) {
    return workflowRuns.get(workflowRunId) || null;
  }
  function getHumanActions(projectId) {
    if (projectId) return humanActions.filter(a => a.projectId === projectId);
    return [...humanActions];
  }

  // Wrap mutation methods to auto-persist state
  const mutations = {
    createProject,
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
    handleTaskFail,
    handleContinueProject,
    handleResolveProjectIntervention,
    startProjectDiagnoseWorkflow,
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
    getDispatchPlan,
    getProjectHealth,
    getProjectIntervention,
    startProjectDiagnoseWorkflow: persisted.startProjectDiagnoseWorkflow,
    listProjectWorkflowRuns,
    getWorkflowRun,
    getHumanActions,
    persistState,
  };
}
