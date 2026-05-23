import { validateDeliverableContract } from './deliverable-contract.js';
import { inferEvidenceContract } from './evidence-contract.js';
import { inferTaskRequirements } from './task-requirements.js';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';

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
  const titleAndType = `${task.title || ''}\n${task.type || ''}`.toLowerCase();
  if (REVIEW_KEYWORDS.some(keyword => titleAndType.includes(keyword.toLowerCase()))) return true;

  const acceptance = Array.isArray(task.acceptanceCriteria)
    ? task.acceptanceCriteria.join('\n')
    : String(task.acceptanceCriteria || '');
  return /(交付|输出|提交).{0,16}(评审|审核|质量|qa|review|audit).{0,16}(报告|证据|evidence|report)/i.test(acceptance);
}

export function inferExecutionContract(task = {}) {
  const structurallyReviewLike = isReviewLikeTask(task);
  const staleReviewEvidenceContract = shouldDiscardPersistedReviewEvidenceContract(task, structurallyReviewLike);
  const persistedReviewLike = task.evidenceContract?.kind === 'review_iteration_v1' && !staleReviewEvidenceContract;
  const reviewLike = persistedReviewLike || structurallyReviewLike;
  const requirements = inferTaskRequirements(task);
  const executionContract = {
    version: 1,
    minSummaryChars: task.executionContract?.minSummaryChars ?? 50,
    requireMeaningfulSummary: task.executionContract?.requireMeaningfulSummary !== false,
    requireArtifactForEmptySummary: task.executionContract?.requireArtifactForEmptySummary !== false,
    ...(task.executionContract || {}),
  };
  const sourceEvidenceContract = inferEvidenceContract(task);
  const taskEvidenceContract = staleReviewEvidenceContract ? null : (task.evidenceContract || null);

  const evidenceContract = reviewLike
    ? {
        version: 1,
        kind: 'review_iteration_v1',
        requiredArtifacts: ['review-evidence.json'],
        requiredFields: ['verdict', 'findings'],
        ...(task.evidenceContract || {}),
      }
    : (sourceEvidenceContract.required ? sourceEvidenceContract : taskEvidenceContract);

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

function shouldDiscardPersistedReviewEvidenceContract(task = {}, structurallyReviewLike = false) {
  if (structurallyReviewLike) return false;
  if (task.evidenceContract?.kind !== 'review_iteration_v1') return false;

  const text = [
    task.title,
    task.brief,
    task.description,
    task.requirements,
    Array.isArray(task.acceptanceCriteria) ? task.acceptanceCriteria.join('\n') : task.acceptanceCriteria,
  ].filter(Boolean).join('\n');

  return (
    /(修订|修改|定稿|终稿|最终|重新生成|生成|交付|revise|revision|final|deliver|generate)/i.test(text) &&
    /(html|报告|report\s+renderer|\breport\b)/i.test(text) &&
    /(评审建议|评审意见|对抗性评审|review feedback|review comments?)/i.test(text) &&
    !/(评审报告|审核报告|质量报告|review report|audit report|quality report)/i.test(text)
  );
}

export function enrichTaskWithExecutionContract(task = {}) {
  return inferExecutionContract(task).task;
}

export function validateTaskResultAgainstContract(task = {}, result = {}, options = {}) {
  const enriched = enrichTaskWithExecutionContract(task);
  const contract = enriched.executionContract || {};
  const workspacePath = options.workspacePath || result.workspacePath || result.workFolder || '';
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

    const evidence = getReviewEvidence(result, workspacePath);
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
    workspacePath,
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
  return getArtifacts(result)
    .map(getArtifactName)
    .filter(Boolean);
}

function getArtifacts(result = {}) {
  const artifacts = [
    ...(Array.isArray(result.artifacts) ? result.artifacts : []),
    ...(Array.isArray(result.artifactManifest) ? result.artifactManifest : []),
  ];
  return artifacts.filter(Boolean);
}

function getArtifactName(artifact) {
  if (typeof artifact === 'string') return artifact;
  return artifact.name || artifact.filename || artifact.relativePath || artifact.path || artifact.url || '';
}

function getReviewEvidence(result = {}, workspacePath = '') {
  const fileEvidence = readReviewEvidenceArtifact(result, workspacePath);
  const inlineEvidence = firstObject(result.reviewEvidence, result.evidence, result.qualityEvidence);
  return { ...fileEvidence, ...inlineEvidence };
}

function firstObject(...values) {
  return values.find(value => value && typeof value === 'object' && !Array.isArray(value)) || {};
}

function readReviewEvidenceArtifact(result = {}, workspacePath = '') {
  const workspaceRealPath = safeRealPath(workspacePath);
  if (!workspaceRealPath) return {};

  for (const artifact of getArtifacts(result)) {
    const name = getArtifactName(artifact);
    if (!String(name || '').endsWith('review-evidence.json')) continue;
    const artifactPath = resolveArtifactPathInWorkspace(artifact, workspaceRealPath);
    if (!artifactPath || !existsSync(artifactPath)) continue;
    try {
      const parsed = JSON.parse(readFileSync(artifactPath, 'utf-8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      return {};
    }
  }
  return {};
}

function resolveArtifactPathInWorkspace(artifact, workspaceRealPath) {
  const rawPath = typeof artifact === 'string'
    ? artifact
    : (artifact?.path || artifact?.relativePath || artifact?.name || artifact?.filename || '');
  if (!rawPath || typeof rawPath !== 'string' || rawPath.includes('\0')) return null;

  const candidate = isAbsolute(rawPath)
    ? resolve(rawPath)
    : resolve(workspaceRealPath, rawPath);
  const candidateRealPath = safeRealPath(candidate);
  if (!candidateRealPath) return null;
  if (!isPathInside(candidateRealPath, workspaceRealPath)) return null;
  return candidateRealPath;
}

function safeRealPath(value) {
  if (!value || typeof value !== 'string') return null;
  try {
    return realpathSync(value);
  } catch {
    return null;
  }
}

function isPathInside(candidate, root) {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

function hasMeaningfulField(value, field) {
  const fieldValue = value?.[field];
  if (Array.isArray(fieldValue)) return fieldValue.length > 0;
  if (typeof fieldValue === 'string') return fieldValue.trim().length > 0;
  return fieldValue !== undefined && fieldValue !== null;
}
