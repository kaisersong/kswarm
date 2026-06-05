/**
 * Retry strategy for task failures — aligned with multica's failure classification.
 *
 * Determines whether a failed task should be auto-retried based on:
 * - A failure taxonomy that separates *transient* runtime faults (worth retrying)
 *   from *deterministic* faults (path/permission/input — retrying cannot help).
 * - The current attempt count vs max attempts.
 * - Whether the task has external side effects (those are never replayed).
 *
 * Ordering note: hub.handleTaskFail runs agent replacement BEFORE consulting
 * shouldAutoRetry, so auto-retry only fires when replacement produced no action
 * (e.g. no candidate / single-agent setup). This avoids double recovery.
 */

// Transient runtime faults: a fresh attempt may succeed without any change.
const TRANSIENT_FAILURES = new Set([
  'agent_error',
  'timeout',
  'runtime_offline',
  'runtime_missing',
  'runtime_unavailable',
  'runtime_recovery',
  'runtime_stalled',
  'runtime_generation_unavailable',
  'source_provider_unavailable',
  'model_empty_output',
  'desktop_runtime_error',
  'broker_unavailable',
  'websocket_open_timeout',
  'handoff_failed',
  'rate_limit',
]);

// Deterministic faults: retrying the same input will fail the same way.
const DETERMINISTIC_FAILURES = new Set([
  'auth_error',
  'permission_denied',
  'invalid_input',
  'model_error',
  'artifact_path_escape',
  'artifact_invalid',
  'artifact_type_mismatch',
  'inline_artifact_forbidden',
]);

const RETRYABLE_FAILURES = TRANSIENT_FAILURES;

const DEFAULT_RETRY_BACKOFF_MS = 2_000;
const MAX_RETRY_BACKOFF_MS = 60_000;

/**
 * Classify a failure class into a retry severity bucket.
 * @param {string} failureClass
 * @returns {'transient'|'deterministic'|'unknown'}
 */
export function classifyFailureSeverity(failureClass) {
  const normalized = String(failureClass || '').trim();
  if (TRANSIENT_FAILURES.has(normalized)) return 'transient';
  if (DETERMINISTIC_FAILURES.has(normalized)) return 'deterministic';
  return 'unknown';
}

/**
 * Backoff before the Nth retry attempt (attempt is the NEW attempt number, i.e.
 * 2 for the first retry). The first retry runs immediately (0ms); subsequent
 * retries grow exponentially and are capped at MAX_RETRY_BACKOFF_MS.
 * @param {number} attempt
 * @param {number} [baseMs]
 * @returns {number}
 */
export function retryBackoffMs(attempt, baseMs = DEFAULT_RETRY_BACKOFF_MS) {
  const steps = (Number(attempt) || 1) - 2;
  if (steps <= 0) return 0;
  const delay = baseMs * Math.pow(2, steps - 1);
  return Math.min(MAX_RETRY_BACKOFF_MS, Math.max(0, delay));
}

/**
 * @param {{ attempt: number, maxAttempts?: number, failureReason?: string, hasExternalSideEffects?: boolean }} task
 */
export function shouldAutoRetry(task) {
  const attempts = task.attempt || 1;
  const max = task.maxAttempts || 2;
  if (attempts >= max) return false;
  if (!task.failureReason) return false;
  // Never replay a task that produced external side effects — a second run
  // could duplicate those effects (sent messages, external writes, etc.).
  if (task.hasExternalSideEffects === true) return false;
  // Only transient runtime faults are safe to auto-retry; deterministic faults
  // (path/permission/input) need human or contract repair, not a blind retry.
  return classifyFailureSeverity(task.failureReason) === 'transient';
}

/**
 * @param {{ id: string, instructions?: string, brief?: string, title: string, phase?: number, phaseId?: string, assignedAgent?: string, attempt: number, failureReason?: string, model?: string, hasExternalSideEffects?: boolean }} parentTask
 * @param {{ now?: number, backoffBaseMs?: number }} [options]
 * @returns {object}
 */
export function createRetryTask(parentTask, options = {}) {
  const dependencyRefs = cloneList(parentTask.dependencyRefs) || cloneList(parentTask.dependencies) || [];
  const attempt = (parentTask.attempt || 1) + 1;
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  return {
    id: `${parentTask.id}-retry-${parentTask.attempt || 1}`,
    title: parentTask.title,
    brief: parentTask.brief || '',
    instructions: parentTask.instructions || '',
    phase: parentTask.phase || 0,
    phaseId: parentTask.phaseId,
    assignedAgent: parentTask.assignedAgent || null,
    requiredOutputs: cloneList(parentTask.requiredOutputs),
    requiredCapabilities: cloneList(parentTask.requiredCapabilities),
    executionContract: cloneObject(parentTask.executionContract),
    evidenceContract: cloneObject(parentTask.evidenceContract),
    // Inherit model from parent so retry uses same provider
    model: parentTask.model,
    dependencies: dependencyRefs,
    dependencyRefs,
    unresolvedDependencies: cloneList(parentTask.unresolvedDependencies) || [],
    parentPlanItemId: parentTask.planItemId || null,
    // Track lineage
    parentTaskId: parentTask.id,
    attempt,
    maxAttempts: parentTask.maxAttempts || 2,
    failureReason: parentTask.failureReason || null,
    // Carry the side-effect marker forward so downstream guards keep holding.
    hasExternalSideEffects: parentTask.hasExternalSideEffects === true,
    // Backoff: dispatchers should not start this retry before retryNotBefore.
    retryNotBefore: now + retryBackoffMs(attempt, options.backoffBaseMs),
  };
}

function cloneList(value) {
  if (!Array.isArray(value)) return value;
  return value.map(item => (item && typeof item === 'object' ? { ...item } : item));
}

function cloneObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value || null;
  return { ...value };
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
  if (msg.includes('permission') || msg.includes('auth') || msg.includes('unauthorized')) return 'auth_error';
  if (msg.includes('model') || msg.includes('invalid model')) return 'model_error';
  // Default: generic agent error
  return 'agent_error';
}

export { RETRYABLE_FAILURES, TRANSIENT_FAILURES, DETERMINISTIC_FAILURES };
