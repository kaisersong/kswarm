/**
 * Dispatcher — Matches tasks to agents via broker
 *
 * Logic:
 * 1. Get ready tasks from project manager
 * 2. Match task.requiredCapabilities to known agent profiles
 * 3. Send request_task through broker bridge
 * 4. Handle accept_task responses
 * 5. If no agent accepts within timeout, try next best match or raise checkpoint
 */

export function createDispatcher({ bridge, projectManager, agentRegistry }) {
  const pendingDispatches = new Map(); // taskId -> { attempts, timeout }

  /**
   * Dispatch all ready tasks for a project.
   */
  function dispatchReady(projectId) {
    const ready = projectManager.getReadyTasks(projectId);
    for (const task of ready) {
      dispatchTask(task);
    }
    return ready.length;
  }

  /**
   * Dispatch a single task to the best-fit agent.
   */
  function dispatchTask(task) {
    const agent = findBestAgent(task.requiredCapabilities);

    const target = agent
      ? { targetParticipantId: agent.participantId, targetAlias: agent.alias }
      : { targetAlias: null }; // Broadcast if no specific match

    bridge.requestTask({
      taskId: task.id,
      title: task.title,
      brief: task.brief,
      projectName: projectManager.getProject(task.projectId)?.name || 'unknown',
      ...target,
    });

    projectManager.updateTaskStatus(task.id, 'dispatched');
    pendingDispatches.set(task.id, { attempts: 1, dispatchedAt: Date.now() });
  }

  /**
   * Find best agent for given capabilities.
   */
  function findBestAgent(requiredCapabilities) {
    const agents = agentRegistry.getAvailable();
    if (agents.length === 0) return null;

    // Score by capability overlap
    const scored = agents.map(agent => {
      const overlap = requiredCapabilities.filter(c => agent.capabilities.includes(c)).length;
      return { agent, score: overlap };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored[0]?.score > 0 ? scored[0].agent : agents[0]; // Fallback to any available
  }

  /**
   * Handle agent accepting a task.
   */
  function handleAccept(taskId, participantId) {
    projectManager.updateTaskStatus(taskId, 'accepted', { assignedAgent: participantId });
    pendingDispatches.delete(taskId);
    agentRegistry.markBusy(participantId);
  }

  /**
   * Handle task progress update.
   */
  function handleProgress(taskId, stage) {
    if (stage === 'started') {
      projectManager.updateTaskStatus(taskId, 'in_progress');
    }
  }

  /**
   * Handle task result submission.
   */
  function handleSubmission(taskId, result) {
    projectManager.updateTaskStatus(taskId, 'done', { result });
    // Release agent
    const task = projectManager.getTask(taskId);
    if (task?.assignedAgent) {
      agentRegistry.markAvailable(task.assignedAgent);
    }
  }

  return {
    dispatchReady,
    dispatchTask,
    handleAccept,
    handleProgress,
    handleSubmission,
  };
}
