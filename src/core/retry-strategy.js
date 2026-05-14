/**
 * Retry strategy for task failures — aligned with multica's failure classification.
 *
 * Determines whether a failed task should be auto-retried based on:
 * - The failure reason (agent_error, timeout, runtime_offline are retryable)
 * - The current attempt count vs max attempts
 * - The failure history pattern
 */

const RETRYABLE_FAILURES = new Set(['agent_error', 'timeout', 'runtime_offline', 'runtime_recovery']);

/**
 * @param {{ attempt: number, maxAttempts?: number, failureReason?: string }} task
 */
export function shouldAutoRetry(task) {
  const attempts = task.attempt || 1;
  const max = task.maxAttempts || 2;
  if (attempts >= max) return false;
  if (!task.failureReason) return false;
  return RETRYABLE_FAILURES.has(task.failureReason);
}

/**
 * @param {{ id: string, instructions?: string, brief?: string, title: string, phase?: number, phaseId?: string, assignedAgent?: string, attempt: number, failureReason?: string, model?: string }} parentTask
 * @returns {object}
 */
export function createRetryTask(parentTask) {
  return {
    id: `${parentTask.id}-retry-${parentTask.attempt || 1}`,
    title: parentTask.title,
    brief: parentTask.brief || '',
    instructions: parentTask.instructions || '',
    phase: parentTask.phase || 0,
    phaseId: parentTask.phaseId,
    assignedAgent: parentTask.assignedAgent || null,
    // Inherit model from parent so retry uses same provider
    model: parentTask.model,
    dependencies: [],
    // Track lineage
    parentTaskId: parentTask.id,
    attempt: (parentTask.attempt || 1) + 1,
    maxAttempts: parentTask.maxAttempts || 2,
    failureReason: parentTask.failureReason || null,
  };
}

/**
 * Classify a failure based on error context.
 * @param {string} errorMessage
 * @returns {string}
 */
export function classifyFailure(errorMessage) {
  const msg = (errorMessage || '').toLowerCase();
  if (msg.includes('timeout') || msg.includes('timed out')) return 'timeout';
  if (msg.includes('runtime') || msg.includes('offline') || msg.includes('disconnect')) return 'runtime_offline';
  if (msg.includes('rate limit') || msg.includes('quota') || msg.includes('429')) return 'rate_limit';
  if (msg.includes('model') || msg.includes('invalid model')) return 'model_error';
  if (msg.includes('permission') || msg.includes('auth') || msg.includes('unauthorized')) return 'auth_error';
  // Default: generic agent error
  return 'agent_error';
}
