import { validateDeliverableContract } from './deliverable-contract.js';
import { inferTaskRequirements } from './task-requirements.js';

const REVIEW_KEYWORDS = [
  'review',
  'quality',
  'qa',
  'audit',
  '评审',
  '审核',
  '质量',
  '检查',
  '验收',
];

const PLACEHOLDER_SUMMARIES = new Set([
  'done',
  'ok',
  'complete',
  'completed',
  '完成',
  '已完成',
]);

export function isReviewLikeTask(task = {}) {
  const text = `${task.title || ''}\n${task.brief || ''}\n${task.description || ''}\n${task.type || ''}`.toLowerCase();
  return REVIEW_KEYWORDS.some(keyword => text.includes(keyword.toLowerCase()));
}

export function inferExecutionContract(task = {}) {
  const reviewLike = task.evidenceContract?.kind === 'review_iteration_v1' || isReviewLikeTask(task);
  const requirements = inferTaskRequirements(task);
  const executionContract = {
    version: 1,
    minSummaryChars: task.executionContract?.minSummaryChars ?? 50,
    requireMeaningfulSummary: task.executionContract?.requireMeaningfulSummary !== false,
    requireArtifactForEmptySummary: task.executionContract?.requireArtifactForEmptySummary !== false,
    ...(task.executionContract || {}),
  };

  const evidenceContract = reviewLike
    ? {
        version: 1,
        kind: 'review_iteration_v1',
        requiredArtifacts: ['review-evidence.json'],
        requiredFields: ['verdict', 'findings'],
        ...(task.evidenceContract || {}),
      }
    : task.evidenceContract || null;

  return {
    ok: true,
    task: {
      ...task,
      ...requirements,
      executionContract,
      evidenceContract,
    },
    executionContract,
    evidenceContract,
  };
}

export function enrichTaskWithExecutionContract(task = {}) {
  return inferExecutionContract(task).task;
}

export function validateTaskResultAgainstContract(task = {}, result = {}, options = {}) {
  const enriched = enrichTaskWithExecutionContract(task);
  const contract = enriched.executionContract || {};
  const errors = [];
  const missing = [];
  const failureClasses = [];

  const summary = getSummary(result);
  if (contract.requireMeaningfulSummary !== false) {
    const min = contract.minSummaryChars ?? 50;
    if (summary.length < min || PLACEHOLDER_SUMMARIES.has(summary.toLowerCase())) {
        errors.push(`summary must contain at least ${min} meaningful characters`);
        missing.push('summary');
        failureClasses.push('quality_evidence_missing');
      }
  }

  if (enriched.evidenceContract?.kind === 'review_iteration_v1') {
    const artifacts = getArtifactNames(result);
    for (const artifactName of enriched.evidenceContract.requiredArtifacts || []) {
      if (!artifacts.some(name => name.endsWith(artifactName) || name === artifactName)) {
        errors.push(`missing required artifact: ${artifactName}`);
        missing.push(artifactName);
        failureClasses.push('quality_evidence_missing');
      }
    }

    const evidence = getReviewEvidence(result);
    for (const field of enriched.evidenceContract.requiredFields || []) {
      if (!hasMeaningfulField(evidence, field)) {
        errors.push(`missing required review evidence field: ${field}`);
        missing.push(field);
        failureClasses.push('quality_evidence_missing');
      }
    }
  }

  const deliverableValidation = validateDeliverableContract({
    requiredOutputs: enriched.requiredOutputs || [],
    artifacts: [
      ...(Array.isArray(result.artifacts) ? result.artifacts : []),
      ...(Array.isArray(result.artifactManifest) ? result.artifactManifest : []),
    ],
    workspacePath: options.workspacePath || result.workspacePath || result.workFolder || '',
  });
  if (!deliverableValidation.ok) {
    errors.push(...deliverableValidation.errors);
    missing.push(...deliverableValidation.missing);
    failureClasses.push(deliverableValidation.failureClass);
  }

  const ok = errors.length === 0;
  return {
    ok,
    errors,
    missing,
    failureClass: ok ? null : firstFailureClass(failureClasses),
  };
}

function firstFailureClass(classes = []) {
  return classes.find(Boolean) || 'quality_evidence_missing';
}

function getSummary(result = {}) {
  const value = result.summary ?? result.text ?? result.output ?? result.content ?? '';
  if (typeof value === 'string') return value.trim();
  return JSON.stringify(value || '').trim();
}

function getArtifactNames(result = {}) {
  const artifacts = [
    ...(Array.isArray(result.artifacts) ? result.artifacts : []),
    ...(Array.isArray(result.artifactManifest) ? result.artifactManifest : []),
  ];
  return artifacts
    .map(artifact => {
      if (typeof artifact === 'string') return artifact;
      return artifact.name || artifact.filename || artifact.relativePath || artifact.path || artifact.url || '';
    })
    .filter(Boolean);
}

function getReviewEvidence(result = {}) {
  return result.reviewEvidence || result.evidence || result.qualityEvidence || {};
}

function hasMeaningfulField(value, field) {
  const fieldValue = value?.[field];
  if (Array.isArray(fieldValue)) return fieldValue.length > 0;
  if (typeof fieldValue === 'string') return fieldValue.trim().length > 0;
  return fieldValue !== undefined && fieldValue !== null;
}
