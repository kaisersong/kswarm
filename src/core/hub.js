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
        boards.set(projectId, restoreTaskBoard(tasks));
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

  // ─── Project lifecycle ─────────────────────────────────────────────

  function createProject({ id, name, goal, requirements, poAgent, members = [] }) {
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
    };
    projects.set(id, project);
    boards.set(id, createTaskBoard());

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
    const ids = board.addTasks(taskList);

    // If project was 'created', move to planning
    if (project.status === 'created') {
      project.status = 'planning';
    }

    eventLog.emit('tasks.added_by_human', {
      projectId,
      count: taskList.length,
      tasks: taskList.map(t => ({ id: t.id, title: t.title, assignedAgent: t.assignedAgent })),
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

  // ─── PO actions ────────────────────────────────────────────────────

  /**
   * PO 提交分解好的任务列表
   */
  function handleCreateTasks(projectId, taskList, fromAgent) {
    const project = projects.get(projectId);
    if (!project) return { ok: false, error: 'project_not_found' };
    if (project.poAgent !== fromAgent) return { ok: false, error: 'not_po' };

    const board = boards.get(projectId);
    const ids = board.addTasks(taskList);

    if (project.status === 'created') project.status = 'planning';
    eventLog.emit('tasks.created', {
      projectId, count: taskList.length, by: fromAgent,
      tasks: taskList.map(t => ({ id: t.id, title: t.title, assignedAgent: t.assignedAgent })),
    });

    return { ok: true, taskIds: ids };
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
    let dispatchable;

    // Phase-aware dispatch: if plan has phases, only dispatch from earliest incomplete phase
    if (project.plan && project.plan.phases && project.plan.phases.length > 0) {
      const phases = project.plan.phases;
      let currentPhase = null;
      for (const phase of phases) {
        const status = board.getPhaseStatus(phase.id);
        if (status.total > 0 && status.done < status.total) {
          currentPhase = phase;
          break;
        }
      }
      dispatchable = currentPhase ? board.getDispatchableInPhase(currentPhase.id) : [];
    } else {
      dispatchable = board.getDispatchable();
    }
    const dispatched = [];

    for (const task of dispatchable) {
      const result = board.transition(task.id, 'dispatched');
      if (!result.ok) continue;

      if (bridge) {
        bridge.requestTask({
          taskId: task.id, title: task.title, brief: task.brief,
          projectName: project.name, targetParticipantId: task.assignedAgent,
        });
      }

      eventLog.emit('task.dispatched', {
        projectId, taskId: task.id, taskTitle: task.title, target: task.assignedAgent,
      });
      dispatched.push(task.id);
    }

    return { ok: true, dispatched };
  }

  /**
   * PO 确认任务完成（审核通过）
   */
  function handleMarkDone(projectId, taskId, fromAgent) {
    const project = projects.get(projectId);
    if (!project || project.poAgent !== fromAgent) return { ok: false, error: 'not_po' };

    const board = boards.get(projectId);
    const task = board.getTask(taskId);
    const result = board.transition(taskId, 'done');
    if (result.ok) {
      eventLog.emit('task.done', {
        projectId, taskId, taskTitle: task?.title, confirmedBy: fromAgent,
      });
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
      eventLog.emit('task.rework', { projectId, taskId, taskTitle: task?.title, reason, by: fromAgent });
      if (bridge && task.assignedAgent) {
        bridge.send({
          type: 'intent', kind: 'rework',
          taskId, toParticipantId: task.assignedAgent,
          payload: { reason },
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
    const result = board.transition(taskId, 'failed', { failureReason: reason });
    if (!result.ok) return result;

    eventLog.emit('task.failed', {
      projectId, taskId, taskTitle: task.title, failureReason: reason,
      errorMessage: errorMessage || '',
    });

    // Decide: auto-retry or not
    const shouldRetry = shouldAutoRetry(task);
    if (!silent) console.log('[Retry] task:', JSON.stringify({ id: task.id, attempt: task.attempt, maxAttempts: task.maxAttempts, failureReason: task.failureReason, shouldRetry }));
    if (shouldRetry) {
      const retryTask = createRetryTask(task);
      board.addTasks([retryTask]);

      // Auto-assign to same agent
      if (retryTask.assignedAgent) {
        board.transition(retryTask.id, 'dispatched', { assignedAgent: retryTask.assignedAgent });
      }

      eventLog.emit('task.retry', {
        projectId,
        originalTaskId: task.id,
        retryTaskId: retryTask.id,
        attempt: retryTask.attempt,
        failureReason: reason,
        assignedAgent: retryTask.assignedAgent,
      });

      return { ok: true, retried: true, retryTaskId: retryTask.id, attempt: retryTask.attempt };
    }

    return { ok: true, retried: false, failureReason: reason };
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

  function handleAcceptTask(projectId, taskId, workerAgent) {
    const board = boards.get(projectId);
    if (!board) return { ok: false, error: 'project_not_found' };

    const task = board.getTask(taskId);
    const result = board.transition(taskId, 'accepted', { assignedAgent: workerAgent });
    if (result.ok) {
      eventLog.emit('task.accepted', { projectId, taskId, taskTitle: task?.title, agent: workerAgent });
      const project = projects.get(projectId);
      if (bridge && project) {
        bridge.send({
          type: 'intent', kind: 'task_accepted',
          taskId, toParticipantId: project.poAgent,
          payload: { agent: workerAgent },
        });
      }
    }
    return result;
  }

  function handleProgress(projectId, taskId, stage, workerAgent) {
    const board = boards.get(projectId);
    if (!board) return { ok: false, error: 'project_not_found' };

    const task = board.getTask(taskId);
    if (stage === 'started') {
      board.transition(taskId, 'in_progress');
    }
    eventLog.emit('task.progress', { projectId, taskId, taskTitle: task?.title, stage, agent: workerAgent });

    const project = projects.get(projectId);
    if (bridge && project) {
      bridge.send({
        type: 'intent', kind: 'progress_update',
        taskId, toParticipantId: project.poAgent,
        payload: { stage, agent: workerAgent },
      });
    }
    return { ok: true };
  }

  function handleSubmitResult(projectId, taskId, result, workerAgent) {
    const board = boards.get(projectId);
    if (!board) return { ok: false, error: 'project_not_found' };

    const task = board.getTask(taskId);
    const transResult = board.transition(taskId, 'submitted', { result });
    if (!transResult.ok) return transResult;

    eventLog.emit('task.submitted', {
      projectId, taskId, taskTitle: task?.title, agent: workerAgent,
      output: result,  // includes artifacts list
    });

    const project = projects.get(projectId);
    if (bridge && project) {
      bridge.send({
        type: 'intent', kind: 'result_submitted',
        taskId, toParticipantId: project.poAgent,
        payload: { result, agent: workerAgent },
      });
    }
    return { ok: true };
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
          board.addTasks([{
            id: change.item.id,
            title: change.item.title,
            brief: change.item.brief,
            assignedAgent: change.item.assignedAgent || null,
            dependencies: change.item.dependencies || [],
            phaseId: change.phaseId,
            planItemId: change.item.id,
            acceptanceCriteria: change.item.acceptanceCriteria || '',
          }]);
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
        board.transition(change.itemId, 'cancelled');
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
    task.reviewResult = { passed: review.passed, feedback: review.feedback || '', reviewedAt: Date.now() };

    if (review.passed) {
      // If already done (e.g. self-completed PO task), just update plan item
      if (task.status === 'done') {
        if (project.plan) {
          for (const phase of project.plan.phases) {
            const item = phase.items.find(i => i.id === task.planItemId || i.title === task.title);
            if (item) { item.status = 'completed'; break; }
          }
        }
        eventLog.emit('task.quality_reviewed', { projectId, taskId, passed: true, feedback: review.feedback });
        return { ok: true };
      }
      const result = board.transition(taskId, 'done');
      if (result.ok) {
        if (project.plan) {
          for (const phase of project.plan.phases) {
            const item = phase.items.find(i => i.id === task.planItemId || i.title === task.title);
            if (item) { item.status = 'completed'; break; }
          }
        }
        eventLog.emit('task.quality_reviewed', { projectId, taskId, passed: true, feedback: review.feedback });
      }
      return result;
    } else {
      // Failed → rework with feedback
      const result = board.transition(taskId, 'in_progress');
      if (result.ok) {
        eventLog.emit('task.quality_reviewed', { projectId, taskId, passed: false, feedback: review.feedback });
        if (bridge && task.assignedAgent) {
          bridge.send({
            type: 'intent', kind: 'rework',
            taskId, toParticipantId: task.assignedAgent,
            payload: { reason: review.feedback },
          });
        }
      }
      return { ok: result.ok, rework: true, feedback: review.feedback };
    }
  }

  // ─── Query ─────────────────────────────────────────────────────────

  function getProject(id) { return projects.get(id); }
  function getBoard(projectId) { return boards.get(projectId); }
  function getEventLog() { return eventLog; }
  function listProjects() { return [...projects.values()]; }
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
    handleSubmitResult,
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
    getHumanActions,
  };
}
