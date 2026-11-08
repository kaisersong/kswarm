import { canonicalizeOutputType } from './output-types.js';

export const PROJECT_EXECUTION_MODES = new Set(['direct', 'auto', 'workflow_preferred']);

export function normalizeProjectExecutionMode(value) {
  const mode = String(value || '').trim();
  return PROJECT_EXECUTION_MODES.has(mode) ? mode : 'direct';
}

export function isValidProjectExecutionMode(value) {
  return PROJECT_EXECUTION_MODES.has(String(value || '').trim());
}

export function selectTaskExecutionStrategy({ project = {}, task = {}, now = Date.now() } = {}) {
  const override = normalizeTaskStrategyOverride(task);
  if (override === 'workflow') {
    return buildSelection('workflow', 'manual_override', 'manual_task_workflow', now);
  }
  if (override === 'direct') {
    return buildSelection('direct', 'manual_override', 'simple_direct', now);
  }

  const mode = normalizeProjectExecutionMode(project.executionMode);
  if (mode === 'direct') {
    return buildSelection('direct', 'project_default', 'project_direct_default', now);
  }

  if (mode === 'workflow_preferred') {
    return buildSelection('direct', 'project_default', 'project_workflow_preferred_project_scope', now);
  }

  const reasonCode = inferWorkflowReasonCode(task);
  // The sealed task workflow only has file tools. Initial managed rendering
  // belongs on the existing capable worker; recovery and explicit quality
  // requests retain their original workflow and all submission gates.
  if (reasonCode === 'delivery_review' && !hasExplicitQualityRequest(task) && needsManagedRenderer(task)) {
    return buildSelection('direct', 'auto_selector', 'managed_renderer_direct', now);
  }
  if (reasonCode) {
    return buildSelection('workflow', 'auto_selector', reasonCode, now);
  }

  return buildSelection('direct', 'auto_selector', 'simple_direct', now);
}

export function buildTaskExecutionMetadata(selection, { workflowRunId = null, selectedAt = Date.now() } = {}) {
  return {
    strategy: selection.strategy,
    modeSource: selection.modeSource,
    reasonCode: selection.reasonCode,
    workflowRunId,
    selectedAt,
  };
}

function buildSelection(strategy, modeSource, reasonCode, selectedAt) {
  return { strategy, modeSource, reasonCode, selectedAt };
}

function normalizeTaskStrategyOverride(task = {}) {
  const raw = task.executionStrategyOverride || task.executionOverride || task.runStrategyOverride;
  const value = String(raw || '').trim();
  if (value === 'workflow' || value === 'direct') return value;
  return null;
}

function inferWorkflowReasonCode(task = {}) {
  if (hasReviewRework(task)) return 'rework_after_review';
  if (hasRetryFailure(task)) return 'retry_after_failure';
  if (isDiagnosableBlockedTask(task)) return 'blocked_or_unclear';
  if (isDeliveryReviewTask(task)) return 'delivery_review';
  if (hasExplicitQualityRequest(task)) return 'quality_requested';
  if (hasMultiSourceEvidence(task)) return 'multi_source_evidence';
  return null;
}

function hasReviewRework(task = {}) {
  return (
    task.reviewResult?.passed === false ||
    Number(task.qualityFailureCount || 0) > 0 ||
    task.lastFailureClass === 'quality_content_failed' ||
    task.lastFailureClass === 'quality_evidence_missing' ||
    String(task.blockKind || '') === 'quality_gate_blocked'
  );
}

function hasRetryFailure(task = {}) {
  return (
    Number(task.runtimeFailureCount || 0) > 0 ||
    Number(task.failureCount || 0) > 0 ||
    Number(task.attempt || 1) > 1 ||
    Boolean(task.failureReason || task.lastFailureClass || task.failedAt)
  );
}

function isDiagnosableBlockedTask(task = {}) {
  return task.status === 'blocked' && Boolean(task.blockedReason || task.blockKind || task.recoveryReason);
}

function isDeliveryReviewTask(task = {}) {
  const text = taskText(task);
  return /最终|交付|交付物|验收|复核|审阅|审核|发布检查|上线检查|release|deliverable|acceptance|final review|review/i.test(text);
}

function hasExplicitQualityRequest(task = {}) {
  if (
    task.qualityGateRequired ||
    task.requiresReview ||
    task.reviewRequired ||
    task.requiresEvidence ||
    task.evidenceRequired ||
    task.adversarialReviewRequired ||
    task.executionContract?.requiresReview ||
    task.executionContract?.requireEvidence
  ) {
    return true;
  }
  const text = taskText(task);
  return /证据链|质量门禁|对抗性|多 reviewer|reviewer|evidence|quality gate|adversarial/i.test(text);
}

function hasMultiSourceEvidence(task = {}) {
  return [
    task.inputRefs,
    task.sourceRefs,
    task.artifactRefs,
    task.evidenceRefs,
    task.dependencies,
    task.dependencyRefs,
  ].some(value => Array.isArray(value) && value.length > 1);
}

function taskText(task = {}) {
  return [
    task.title,
    task.description,
    task.brief,
    task.type,
    task.kind,
    ...(Array.isArray(task.acceptanceCriteria) ? task.acceptanceCriteria : [task.acceptanceCriteria]),
  ].filter(Boolean).join('\n');
}

function needsManagedRenderer(task = {}) {
  const outputs = Array.isArray(task.requiredOutputs) ? task.requiredOutputs : [];
  const explicitOutputs = outputs.filter(output => typeof output === 'string' || !output?.source || output.source === 'task');
  const explicitTypes = explicitOutputs.map(output => canonicalizeOutputType(
    typeof output === 'string' ? output : output?.type || output?.format || output?.kind,
  )).filter(Boolean);
  if (explicitTypes.some(type => type === 'report_html' || type === 'slide_html')) return true;
  if (explicitTypes.length > 0 && explicitTypes.every(type => ['markdown', 'md', 'ir', 'report_ir', 'slide_ir'].includes(type))) return false;

  // Briefs commonly describe downstream HTML. Require an unambiguous current
  // task action in the title rather than inferring it from project context.
  const title = String(task.title || '');
  if (/准备|供后续|下一任务|prepar|for (?:a |the )?(?:later|next|subsequent)/i.test(title)) return false;
  return /(?:report|slide)[-_]renderer|kai-(?:report|slide)-creator/i.test(title)
    && /\bhtml\b/i.test(title)
    && /渲染|生成|输出|\brender\b|\bgenerate\b|\boutput\b/i.test(title);
}
