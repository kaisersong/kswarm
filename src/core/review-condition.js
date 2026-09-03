/**
 * KSwarm — ReviewCondition / condition ledger（design §3.4）
 *
 * 设计依据：mydocs/xiaok-cli/design/2026-08-31-collaboration-room-evidence-first-execution-and-gate-design.md v8
 *   §3.4 ReviewCondition：条件清单
 *
 * `review-evidence.json.findings` 是条件的真实输入，不依赖尚未实现的
 * ReviewForge runtime。本模块提供确定性导入（findings → ReviewConditionV1）
 * 和状态转换的纯函数集合。不做磁盘 I/O、不做持久化——持久化集合命名已在
 * 设计文档 §10.1 冻结为 `reviewConditions`，接线到 hub.js 的具体存储由后续
 * Phase 1/2 持久化接线提交完成，本模块只负责数据结构和状态机规则本身。
 */

export const REVIEW_CONDITION_SCHEMA_VERSION = 'review-condition-v1';
export const CONDITION_SEVERITIES = Object.freeze(['critical', 'high', 'medium', 'low']);
export const CONDITION_STATUSES = Object.freeze(['open', 'evidence_submitted', 'resolved', 'superseded']);
export const CONDITION_INVALIDATION_RULES = Object.freeze(['artifact_hash_changed', 'source_changed', 'manual']);
export const CONDITION_OWNER_KINDS = Object.freeze(['task', 'user']);
export const CONDITION_REQUEST_SOURCES = Object.freeze(['user', 'agent', 'scheduler', 'system_reconciler']);

/**
 * @typedef {Object} ReviewConditionV1
 * @property {'review-condition-v1'} schemaVersion
 * @property {string} conditionId
 * @property {string} projectId
 * @property {string} sourceTaskId
 * @property {string} sourceReviewRunId
 * @property {string} findingId
 * @property {true} blocking
 * @property {'critical'|'high'|'medium'|'low'} severity
 * @property {{kind: 'task'|'user', id: string}} owner
 * @property {Array<{kind: 'artifact'|'check'|'room_message', description: string}>} requiredEvidence
 * @property {'artifact_hash_changed'|'source_changed'|'manual'} invalidationRule
 * @property {'open'|'evidence_submitted'|'resolved'|'superseded'} status
 * @property {{verifiedBy: string, evidenceRefs: string[], verifiedAt: string}} [resolution]
 */

function stableConditionId(projectId, sourceTaskId, sourceReviewRunId, findingId) {
  // 纯字符串拼接，不引入 crypto 依赖；conditionId 的稳定性只要求同一
  // (project, task, run, finding) 四元组产生同一 ID，供幂等导入去重。
  return `cond-${[projectId, sourceTaskId, sourceReviewRunId, findingId].join(':')}`;
}

/**
 * §3.4：reviewer 提出条件，但不能自行将自己提出的条件标记 resolved。
 * 这里只做数据构造，owner/severity 校验在 buildReviewConditionFromFinding
 * 内部完成；"reviewer 不能自证 resolved" 这条规则由 resolveReviewCondition
 * 的 verifiedBy !== sourceTaskId producer 校验强制（见下方）。
 *
 * §3.2 同一原则的延伸：finding 来自 review-evidence.json，是 Agent 提交的
 * 未信任文件内容。finding.reviewer / finding.agent 等字段可能被伪造，绝不能
 * 用来确定条件的真实发起者身份。originatingReviewerIdentity 必须由 caller
 * （service 层，从可信 requestContext/participant 身份解析）显式传入；
 * finding 对象里任何形状类似的字段都被忽略，不参与身份判定。
 */
export function buildReviewConditionFromFinding({
  projectId,
  sourceTaskId,
  sourceReviewRunId,
  originatingReviewerIdentity = null,
  allowUserOwner = false,
  finding,
} = {}) {
  if (!projectId) throw new Error('projectId_required');
  if (!sourceTaskId) throw new Error('sourceTaskId_required');
  if (!sourceReviewRunId) throw new Error('sourceReviewRunId_required');
  if (!finding?.id) throw new Error('finding_id_required');
  if (finding.blocking !== true) {
    // §3.4：只导入 blocking findings；non-blocking findings 不产生条件。
    return null;
  }
  const severity = CONDITION_SEVERITIES.includes(finding.severity) ? finding.severity : 'medium';
  const invalidationRule = CONDITION_INVALIDATION_RULES.includes(finding.invalidationRule)
    ? finding.invalidationRule
    : 'manual';
  const claimedOwner = normalizeConditionOwner(finding.owner);
  const owner = claimedOwner?.kind === 'user' && allowUserOwner !== true
    ? { kind: 'task', id: sourceTaskId }
    : (claimedOwner || { kind: 'task', id: sourceTaskId });
  const requiredEvidence = Array.isArray(finding.requiredEvidence)
    ? finding.requiredEvidence
      .filter(item => item && ['artifact', 'check', 'room_message'].includes(item.kind))
      .map(item => ({ kind: item.kind, description: String(item.description || '') }))
    : [];
  const normalizedReviewerIdentity = typeof originatingReviewerIdentity === 'string'
    ? originatingReviewerIdentity.trim()
    : '';
  if (!normalizedReviewerIdentity) throw new Error('originating_reviewer_identity_required');

  return {
    schemaVersion: REVIEW_CONDITION_SCHEMA_VERSION,
    conditionId: stableConditionId(projectId, sourceTaskId, sourceReviewRunId, finding.id),
    projectId,
    sourceTaskId,
    sourceReviewRunId,
    findingId: finding.id,
    blocking: true,
    severity,
    originatingReviewerIdentity: normalizedReviewerIdentity,
    owner,
    requiredEvidence,
    invalidationRule,
    status: 'open',
  };
}

function normalizeConditionOwner(rawOwner) {
  if (!rawOwner || typeof rawOwner !== 'object') return null;
  if (!CONDITION_OWNER_KINDS.includes(rawOwner.kind) || !rawOwner.id) return null;
  return { kind: rawOwner.kind, id: String(rawOwner.id) };
}

/**
 * §3.4：Agent 只能提交 evidence；KSwarm reducer 只在独立验证或系统确定性检查
 * 通过后转为 resolved。本函数只做 open -> evidence_submitted 的状态转换，
 * 不代表最终解决，也不做独立性校验（独立性校验属于 resolveReviewCondition）。
 */
function normalizeRequestSource(requestSource) {
  return CONDITION_REQUEST_SOURCES.includes(requestSource) ? requestSource : null;
}

function normalizeEvidenceRefs(evidenceRefs) {
  if (!Array.isArray(evidenceRefs) || evidenceRefs.length === 0) return null;
  const normalized = [];
  for (const ref of evidenceRefs) {
    if (typeof ref !== 'string' || !ref.trim()) return null;
    normalized.push(ref.trim());
  }
  return [...new Set(normalized)].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
}

export function submitConditionEvidence(condition, { evidenceRefs = [], requestSource } = {}) {
  if (!condition) return { ok: false, error: 'condition_required' };
  if (!normalizeRequestSource(requestSource)) return { ok: false, error: 'invalid_request_source' };
  const normalizedEvidenceRefs = normalizeEvidenceRefs(evidenceRefs);
  if (!normalizedEvidenceRefs) return { ok: false, error: 'evidence_refs_required' };
  if (condition.status !== 'open') {
    return { ok: false, error: `invalid_condition_status: ${condition.status}` };
  }
  return {
    ok: true,
    condition: {
      ...condition,
      status: 'evidence_submitted',
      pendingEvidenceRefs: normalizedEvidenceRefs,
      pendingEvidenceRequestSource: requestSource,
    },
  };
}

/**
 * §3.4：user-owned 条件只能由用户动作满足；reviewer 提出条件不能自行标记 resolved
 * （verifiedBy 不能等于 condition 的 owner.id，也不能等于 sourceTaskId 本身，
 * 除非 owner.kind === 'user' 且 verifiedBy 确实来自一个用户身份——这条由
 * caller 的 requestSource 校验保证，本函数只负责结构层面的自证拒绝）。
 */
export function resolveReviewCondition(condition, {
  verifiedBy,
  evidenceRefs = [],
  requestSource,
  now = Date.now(),
} = {}) {
  if (!condition) return { ok: false, error: 'condition_required' };
  const normalizedSource = normalizeRequestSource(requestSource);
  if (!normalizedSource) return { ok: false, error: 'invalid_request_source' };
  const normalizedEvidenceRefs = normalizeEvidenceRefs(evidenceRefs);
  if (!normalizedEvidenceRefs) return { ok: false, error: 'evidence_refs_required' };
  const normalizedVerifiedBy = typeof verifiedBy === 'string' ? verifiedBy.trim() : '';
  if (!normalizedVerifiedBy) return { ok: false, error: 'verifiedBy_required' };
  const originatingReviewerIdentity = typeof condition.originatingReviewerIdentity === 'string'
    ? condition.originatingReviewerIdentity.trim()
    : '';
  if (!originatingReviewerIdentity) return { ok: false, error: 'originating_reviewer_identity_required' };
  if (condition.status === 'resolved') {
    const resolution = condition.resolution || {};
    const exactReplay = resolution.verifiedBy === normalizedVerifiedBy
      && resolution.requestSource === normalizedSource
      && JSON.stringify(resolution.evidenceRefs) === JSON.stringify(normalizedEvidenceRefs);
    return exactReplay
      ? { ok: true, condition, alreadyResolved: true }
      : { ok: false, error: 'idempotency_conflict' };
  }
  if (condition.status === 'superseded') {
    return { ok: false, error: 'condition_superseded_cannot_resolve' };
  }

  if (normalizedVerifiedBy === originatingReviewerIdentity) {
    return { ok: false, error: 'condition_self_resolution_forbidden' };
  }

  if (condition.owner.kind === 'user' && normalizedSource !== 'user') {
    return { ok: false, error: 'user_owned_condition_requires_user_action' };
  }
  if (condition.owner.kind === 'task' && normalizedSource === 'agent' && normalizedVerifiedBy === condition.owner.id) {
    return { ok: false, error: 'condition_self_resolution_forbidden' };
  }

  return {
    ok: true,
    condition: {
      ...condition,
      status: 'resolved',
      resolution: {
        verifiedBy: normalizedVerifiedBy,
        requestSource: normalizedSource,
        evidenceRefs: normalizedEvidenceRefs,
        verifiedAt: new Date(now).toISOString(),
      },
    },
  };
}

/**
 * §3.4：artifact hash 变化时，指向旧版本的 resolved condition 自动 superseded，
 * 并产生新一轮验证需要。open/evidence_submitted 状态的条件不受此规则影响
 * （它们本来就还没有被信任的结论，不需要"失效"）。
 */
export function supersedeConditionsForChangedArtifact(conditions = [], { changedArtifactId, changedSha256 } = {}) {
  return conditions.map(condition => {
    if (condition.status !== 'resolved') return condition;
    const boundArtifactId = condition.resolution?.evidenceRefs?.find(ref => ref.includes(changedArtifactId));
    if (!boundArtifactId) return condition;
    return {
      ...condition,
      status: 'superseded',
      supersededReason: 'artifact_hash_changed',
      supersededArtifactId: changedArtifactId,
      supersededSha256: changedSha256,
    };
  });
}

/**
 * §3.2 权威关系冻结表 / §8.2：blocking condition 不为零时，相关 GateEvaluation
 * 不得为 passed。这是一个纯粹的计数谓词，供 gate-evaluator.js 消费，不在这里
 * 重复实现 evaluateDependencySatisfaction 的逻辑。
 */
export function countOpenBlockingConditions(conditions = []) {
  return conditions.filter(c => c.blocking === true && (c.status === 'open' || c.status === 'evidence_submitted')).length;
}
