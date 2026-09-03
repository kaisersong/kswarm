/**
 * Project Manager — Lifecycle and completion detection
 *
 * ⚠️ DEMO-ONLY MODULE（design §8.2 核对结论，2026-09）：
 * 本模块仅被 `src/cli/demo.js`、`test/e2e.test.js`、`test/scenarios.test.js` 引用，
 * 不被 `src/server/index.js` 或 `src/core/hub.js` 消费，不在生产 dispatch/delivery
 * 路径上。真实生产的 project 生命周期、依赖判定和最终交付均由 `src/core/hub.js`
 * （`handleDeliver` / `approveFinalDeliverable` / `evaluateDependencySatisfaction`）
 * 独立实现和维护，不共享本模块的任何状态或逻辑。
 *
 * `checkCompletion` 下面仍保留其原有的、无 gate 校验的 `project.status = 'delivered'`
 * 行为，仅供 demo/legacy 测试路径使用；不得被任何新的生产代码路径调用或复用，
 * 否则会绕开 `evaluateDependencySatisfaction` / `approveFinalDeliverable` 等唯一
 * gate 收敛点，重新引入已被关闭的旁路。
 *
 * Manages:
 * - Project creation with deliverable definition
 * - Task status tracking (synced from broker events)
 * - "Done" detection: all tasks completed + deliverable criteria met
 * - Checkpoint gates at key transitions
 */

import { randomUUID } from 'crypto';
import { decomposeGoal } from '../planner/decompose.js';

export function createProjectManager() {
  const projects = new Map();
  const tasks = new Map(); // taskId -> HubTask

  /**
   * Create a new project with a goal and deliverable definition.
   */
  function createProject({ name, goal, deliverable }) {
    const project = {
      id: randomUUID().slice(0, 10),
      name,
      goal,
      deliverable,
      status: 'setup',
      taskIds: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    projects.set(project.id, project);
    return project;
  }

  /**
   * Plan a project: decompose goal into tasks.
   */
  function planProject(projectId) {
    const project = projects.get(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);

    const decomposed = decomposeGoal({
      projectId,
      goal: project.goal,
      deliverable: project.deliverable,
    });

    for (const task of decomposed) {
      tasks.set(task.id, task);
      project.taskIds.push(task.id);
    }

    project.status = 'planning';
    project.updatedAt = Date.now();
    return decomposed;
  }

  /**
   * Activate project (after human approves plan).
   */
  function activateProject(projectId) {
    const project = projects.get(projectId);
    if (!project) return;
    project.status = 'active';
    project.updatedAt = Date.now();
  }

  /**
   * Get tasks that are ready to be dispatched.
   * (status=pending, all dependencies done)
   *
   * ⚠️ DEMO-ONLY：这是独立于 evaluateDependencySatisfaction 的私有依赖判定，
   * 只适用于本模块的 demo/legacy 数据结构（`t.dependencies` 数组、无
   * DependencyPolicy/GateEvaluation 概念）。不代表生产 dispatch 契约。
   */
  function getReadyTasks(projectId) {
    const project = projects.get(projectId);
    if (!project) return [];

    return project.taskIds
      .map(id => tasks.get(id))
      .filter(t => t && t.status === 'pending')
      .filter(t => t.dependencies.every(depId => {
        const dep = tasks.get(depId);
        return dep && dep.status === 'done';
      }));
  }

  /**
   * Update task status (called when broker events arrive).
   */
  function updateTaskStatus(taskId, status, extra = {}) {
    const task = tasks.get(taskId);
    if (!task) return;
    task.status = status;
    if (extra.assignedAgent) task.assignedAgent = extra.assignedAgent;
    if (extra.result) {
      task.result = extra.result;
      task.completedAt = Date.now();
    }
  }

  /**
   * Check if project is complete.
   *
   * ⚠️ DEMO-ONLY：无 gate 校验的 legacy 行为，仅供本模块自身的 demo/legacy
   * 数据结构使用。生产交付路径必须使用 hub.js:handleDeliver +
   * approveFinalDeliverable，不得复用此函数的 project.status 写入逻辑。
   */
  function checkCompletion(projectId) {
    const project = projects.get(projectId);
    if (!project) return false;

    const allDone = project.taskIds.every(id => {
      const task = tasks.get(id);
      return task && task.status === 'done';
    });

    if (allDone && project.status === 'active') {
      project.status = 'delivered';
      project.updatedAt = Date.now();
      return true;
    }
    return false;
  }

  /**
   * Get project overview stats.
   */
  function getStats(projectId) {
    const project = projects.get(projectId);
    if (!project) return null;

    const projectTasks = project.taskIds.map(id => tasks.get(id)).filter(Boolean);
    return {
      total: projectTasks.length,
      pending: projectTasks.filter(t => t.status === 'pending').length,
      dispatched: projectTasks.filter(t => t.status === 'dispatched').length,
      inProgress: projectTasks.filter(t => ['accepted', 'in_progress'].includes(t.status)).length,
      done: projectTasks.filter(t => t.status === 'done').length,
      failed: projectTasks.filter(t => t.status === 'failed').length,
    };
  }

  return {
    createProject,
    planProject,
    activateProject,
    getReadyTasks,
    updateTaskStatus,
    checkCompletion,
    getStats,
    getProject: (id) => projects.get(id),
    getTask: (id) => tasks.get(id),
    listProjects: () => [...projects.values()],
  };
}
