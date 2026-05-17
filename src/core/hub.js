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
import { createEventLog } from './event-log.js';
import { createPersistence } from './persistence.js';
import * as retryStrategy from './retry-strategy.js';
import { expandCompositeTasks } from './composite-task-expander.js';
import { getActiveTasksAcrossBoards, planDispatch } from './dispatch-policy.js';
import { superviseTaskFailure } from './failure-supervisor.js';
import { deriveProjectHealth } from './project-health.js';
import { validateTaskResultAgainstContract } from './execution-contract.js';

export function createHub({ bridge, eventLogDir, silent = false, dataDir } = {}) {
  const projects = new Map();
  const boards = new Map();
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
    return planDispatch({
      projectId,
      tasks: board.getAllTasks(),
      allActiveTasks: getActiveTasksAcrossBoards(boards),
    });
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

  // ─── Project lifecycle ─────────────────────────────────────────────

  function createProject({ id, name, goal, requirements, poAgent, members = [], enableSummary }) {
    const project = {
      id,
      name,
      goal,
      requirements: requirements || '',
      poAgent,
      members,
      status: 'created',  // created → planning → active → closed
      createdAt: Date.now(),
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

    if (bridge) {
      bridge.send({
        type: 'intent', kind: 'assign_po',
        projectId: id, toParticipantId: poAgent,
        payload: { name, goal },
      });
    }

    eventLog.emit('po.assigned', { projectId: id, agent: poAgent });
    return project;
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

    // Reset plan so PO can create a new one
    project.plan = null;
    project.planArtifact = null;
    if (project.status === 'planning') project.status = 'created';

    bridge.send({
      type: 'intent', kind: 'assign_po',
      projectId: project.id, toParticipantId: project.poAgent,
      payload: { name: project.name, goal: project.goal },
    });

    eventLog.emit('plan.retry', { projectId, po: project.poAgent });
    return { ok: true };
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

  function handleRequestDispatch(projectId, fromAgent) {
    const project = projects.get(projectId);
    if (!project) return { ok: false, error: 'project_not_found' };
    if (project.status !== 'active') return { ok: false, error: 'project_not_active' };
    if (project.poAgent !== fromAgent) return { ok: false, error: 'not_po' };

    const board = boards.get(projectId);
    const dispatchPlan = buildDispatchPlan(projectId);
    const dispatched = [];

    for (const task of dispatchPlan.dispatchedTasks) {
      const result = board.transition(task.id, 'dispatched');
      if (!result.ok) continue;

      if (bridge) {
        bridge.requestTask({
          taskId: task.id, title: task.title, brief: task.brief,
          projectId,
          localTaskId: task.localTaskId,
          runId: result.runId,
          attempt: task.attempt || 1,
          projectName: project.name, targetParticipantId: task.assignedAgent,
        });
      }

      eventLog.emit('task.dispatched', {
        projectId, taskId: task.id, taskTitle: task.title, target: task.assignedAgent,
      });
      dispatched.push(task.id);
    }

    return {
      ok: true,
      dispatched,
      skipped: dispatchPlan.skipped,
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
    const result = board.transition(task.id, 'failed', { failureReason: reason });
    if (!result.ok) return result;

    eventLog.emit('task.failed', {
      projectId, taskId: task.id, taskTitle: task.title, failureReason: reason,
      errorMessage: errorMessage || '',
    });

    // Decide: auto-retry or not
    const shouldRetry = shouldAutoRetry(task);
    if (!silent) console.log('[Retry] task:', JSON.stringify({ id: task.id, attempt: task.attempt, maxAttempts: task.maxAttempts, failureReason: task.failureReason, shouldRetry }));
    if (shouldRetry) {
      const retryTask = createRetryTask(task);
      const added = board.addTasksChecked([retryTask]);
      if (!added.ok) return added;

      // Auto-assign to same agent
      if (retryTask.assignedAgent) {
        board.transition(retryTask.id, 'dispatched', { assignedAgent: retryTask.assignedAgent });
      }

      eventLog.emit('task.retry', {
        projectId,
        originalTaskId: task.id,
        retryTaskId: added.taskIds[0],
        attempt: retryTask.attempt,
        failureReason: reason,
        assignedAgent: retryTask.assignedAgent,
      });

      return { ok: true, taskId: task.id, retried: true, retryTaskId: added.taskIds[0], attempt: retryTask.attempt, failureReason: reason };
    }

    return { ok: true, taskId: task.id, retried: false, failureReason: reason };
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
    if (task.status === 'accepted' && task.assignedAgent === workerAgent) {
      return { ok: true, alreadyAccepted: true, taskId: task.id };
    }
    const result = board.transition(task.id, 'accepted', { assignedAgent: workerAgent });
    if (result.ok) {
      eventLog.emit('task.accepted', { projectId, taskId: task.id, taskTitle: task?.title, agent: workerAgent });
      const project = projects.get(projectId);
      if (bridge && project) {
        bridge.send({
          type: 'intent', kind: 'task_accepted',
          taskId: task.id, toParticipantId: project.poAgent,
          payload: { agent: workerAgent, projectId, runId },
        });
      }
    }
    return result;
  }

  function handleProgress(projectId, taskId, stage, workerAgent, runId) {
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
      } else {
        result = board.transition(task.id, 'in_progress');
      }
    }
    if (!result.ok) return result;
    eventLog.emit('task.progress', { projectId, taskId: task.id, taskTitle: task?.title, stage, agent: workerAgent });

    const project = projects.get(projectId);
    if (bridge && project) {
      bridge.send({
        type: 'intent', kind: 'progress_update',
        taskId: task.id, toParticipantId: project.poAgent,
        payload: { stage, agent: workerAgent, projectId, runId },
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

    return handleTaskFail(projectId, task.id, failureReason, errorMessage);
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
    const transResult = board.transition(task.id, 'submitted', { result, runId });
    if (!transResult.ok) return transResult;

    eventLog.emit('task.submitted', {
      projectId, taskId: task.id, taskTitle: task?.title, agent: workerAgent,
      output: result,  // includes artifacts list
    });

    const project = projects.get(projectId);
    if (bridge && project) {
      bridge.send({
        type: 'intent', kind: 'result_submitted',
        taskId: task.id, toParticipantId: project.poAgent,
        payload: { result, agent: workerAgent, projectId, runId },
      });
    }
    return { ok: true };
  }

  function handleRecoverSubmission(projectId, taskId, result, fromAgent, meta = {}) {
    const board = boards.get(projectId);
    if (!board) return { ok: false, error: 'project_not_found' };
    const task = board.getTask(taskId);
    if (!task) return { ok: false, error: 'task_not_found' };
    const recovered = board.recoverSubmission(task.id, result, { recoveredBy: fromAgent, fromAgent, ...meta });
    if (!recovered.ok) return recovered;
    eventLog.emit('task.submitted', {
      projectId, taskId: task.id, taskTitle: task.title, agent: fromAgent,
      output: result, recovered: true,
    });
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
        return { ok: true };
      }
      const result = board.transition(task.id, 'done');
      if (result.ok) {
        updatePlanItemCompleted(project, task);
        eventLog.emit('task.quality_reviewed', { projectId, taskId: task.id, passed: true, feedback: review.feedback });
        maybeCompleteCompositeParent(projectId, task);
      }
      return result;
    }
    return handleQualityFailure(task, review);

    function handleQualityFailure(failedTask, failedReview) {
      const decision = superviseTaskFailure(failedTask, {
        source: 'quality_review',
        failureClass: failedReview.failureClass || 'quality_content_failed',
        feedback: failedReview.feedback || '',
      });
      failedTask.qualityFailureCount = decision.qualityFailureCount;
      failedTask.lastFailureClass = decision.failureClass;

      eventLog.emit('task.quality_reviewed', {
        projectId,
        taskId: failedTask.id,
        passed: false,
        feedback: failedReview.feedback,
        failureClass: decision.failureClass,
        action: decision.action,
      });

      if (decision.action === 'block') {
        const blocked = board.blockTask(failedTask.id, decision);
        if (blocked.ok) {
          eventLog.emit('task.blocked', {
            projectId,
            taskId: failedTask.id,
            taskTitle: failedTask.title,
            blockKind: decision.blockKind,
            failureClass: decision.failureClass,
            reason: decision.blockedReason,
            nextActions: decision.nextActions,
          });
        }
        return {
          ok: blocked.ok,
          blocked: true,
          failureClass: decision.failureClass,
          nextActions: decision.nextActions,
        };
      }

      const result = board.transition(failedTask.id, 'in_progress', {
        failureReason: failedReview.feedback,
        failureClass: decision.failureClass,
        qualityFailureCount: decision.qualityFailureCount,
      });
      if (result.ok && bridge && failedTask.assignedAgent) {
        bridge.send({
          type: 'intent', kind: 'rework',
          taskId: failedTask.id, toParticipantId: failedTask.assignedAgent,
          payload: { reason: failedReview.feedback, projectId, nextActions: decision.nextActions },
        });
      }
      return {
        ok: result.ok,
        rework: true,
        feedback: failedReview.feedback,
        nextActions: decision.nextActions,
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
    getHumanActions,
    persistState,
  };
}
