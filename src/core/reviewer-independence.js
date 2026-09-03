/**
 * KSwarm — independence constraints for reviewer assignment（design §4.2）
 *
 * 设计依据：mydocs/xiaok-cli/design/2026-08-31-collaboration-room-evidence-first-execution-and-gate-design.md v8
 *   §4.2 独立性约束
 *
 * 高风险 task 的 author、independent reviewer 必须不同 participant；reviewer
 * 不能是被评 artifact 的 producer。runner/model identity 也进入 evaluation：
 * 不同 participant 但共享同一 runner/model family 时标记 independence=degraded，
 * 不得满足 high 风险的 verified_pass。
 *
 * "上游关键证据 producer" 在 review dispatch 时（而不是计划时）判定：从
 * subjectArtifacts 沿 canonical artifact manifest + evidence extension 的
 * claim/source 引用闭包收集 producer IDs；若 reviewer 是该闭包中任一关键
 * claim 的唯一 producer，则拒绝 dispatch。
 */

/**
 * 计划阶段的粗粒度排除：author/PO 不能同时是 reviewer。这是计划阶段唯一允许
 * 做的独立性判断（更细的"是否是关键证据的唯一 producer"必须在 dispatch 时判定，
 * 见 rejectReviewerIfSoleCriticalProducer，避免证据尚未产生时的时序矛盾）。
 */
export function isReviewerExcludedAtPlanningTime({ reviewerId, authorId, poId }) {
  if (!reviewerId) return { excluded: true, reasonCode: 'reviewer_id_required' };
  if (reviewerId === authorId) return { excluded: true, reasonCode: 'reviewer_is_author' };
  if (reviewerId === poId) return { excluded: true, reasonCode: 'reviewer_is_po' };
  return { excluded: false, reasonCode: null };
}

/**
 * runner/model identity 独立性判定：不同 participant 但共享同一
 * runner/model family 时标记 degraded。
 */
export function classifyEvaluatorIndependence({
  reviewerParticipantId,
  producerParticipantId,
  reviewerRunnerId,
  producerRunnerId,
  reviewerModelFamily,
  producerModelFamily,
}) {
  if (reviewerParticipantId === producerParticipantId) {
    return { independence: 'degraded', reasonCode: 'same_participant' };
  }
  if (reviewerRunnerId && producerRunnerId && reviewerRunnerId === producerRunnerId) {
    return { independence: 'degraded', reasonCode: 'same_runner' };
  }
  if (reviewerModelFamily && producerModelFamily && reviewerModelFamily === producerModelFamily) {
    return { independence: 'degraded', reasonCode: 'same_model_family' };
  }
  return { independence: 'independent', reasonCode: null };
}

/**
 * §4.2：在 review dispatch 时（不是计划时）判定 reviewer 是否是关键证据的唯一
 * producer。从 subjectArtifacts 沿 canonical artifact manifest 的
 * producedBy 字段收集 producer 闭包；reviewer 若是该闭包中任一 artifact 的
 * 唯一 producer，则拒绝 dispatch。
 *
 * @param {Object} params
 * @param {string} params.reviewerId
 * @param {Array<{artifactId: string, producedBy: string[]}>} params.subjectArtifacts
 *   每个 subject artifact 及其全部 producer 列表（一个 artifact 理论上可能有
 *   多个贡献者，只有当 reviewer 是唯一 producer 时才判定为不独立）。
 */
export function rejectReviewerIfSoleCriticalProducer({ reviewerId, subjectArtifacts = [] }) {
  if (!reviewerId) return { rejected: true, reasonCode: 'reviewer_id_required' };
  for (const artifact of subjectArtifacts) {
    const producers = Array.isArray(artifact?.producedBy) ? artifact.producedBy.filter(Boolean) : [];
    if (producers.length === 0) continue;
    const isSoleProducer = producers.length === 1 && producers[0] === reviewerId;
    if (isSoleProducer) {
      return { rejected: true, reasonCode: 'reviewer_is_sole_critical_producer', artifactId: artifact.artifactId };
    }
  }
  return { rejected: false, reasonCode: null };
}

/**
 * §4.2：若当前没有合格 reviewer，项目复用现有 waiting_for_capable_agent gate，
 * 附 reasonCode=no_independent_reviewer；不新增重叠 projectGate enum。这是纯
 * 数据构造，不做磁盘/broker I/O。
 */
export function buildNoIndependentReviewerGate() {
  return { gate: 'waiting_for_capable_agent', reasonCode: 'no_independent_reviewer' };
}
