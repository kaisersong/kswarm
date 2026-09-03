/**
 * KSwarm — Contract kind registry（design §5.1.1）
 *
 * 设计依据：mydocs/xiaok-cli/design/2026-08-31-collaboration-room-evidence-first-execution-and-gate-design.md v8
 *   §5.1.1 Contract kind registry 与 fail-closed
 *
 * contract kind 必须按"判定点"和"赋值/默认生成点"分开盘点，不能把赋值点写成 validator。
 * 本模块是唯一的 contract kind → family/validator 映射来源：
 *   - external_source_v1 / external_source_v2 → family 'external_source'
 *   - review_iteration_v1 / review_iteration_v2 → family 'review_iteration'
 *
 * validator/dispatcher 只从 registry 分派；有 kind 但不在 registry 一律
 * unsupported_evidence_contract，不得 success。
 *
 * v2 validator（external_source_v2）已由 search-evidence.js:validateSearchEvidenceV2
 * 实现（真实 fetchPageEvidenceV2 落盘证据 + 显式 claim→source 映射校验）；
 * review_iteration_v2 由 gate-evidence-acceptor.js:acceptTaskGateEvidence 实现
 * （唯一 gateEvidenceArtifactId + canonical manifest + realpath containment +
 * service hash 重算 + schema fail-closed）。两者均已 supported:true。
 */

/**
 * v2 validator（external_source_v2）当前尚未实现完整校验逻辑（snapshot/claim mapping
 * 属于本 Phase 后续提交），先冻结 registry 结构本身，防止未知 kind 被 fail-open。
 * review_iteration_v2 的 v2 validator 已由 gate-evidence-acceptor.js:acceptTaskGateEvidence
 * 实现（唯一 gateEvidenceArtifactId 声明、canonical manifest 解析、realpath containment、
 * service hash 重算比对、schema fail-closed），execution-contract.js 的浅层结构校验
 * （是否声明了 gateEvidenceArtifactId）与之配套，标记为 supported:true。
 */
export const CONTRACT_KIND_REGISTRY = Object.freeze({
  external_source_v1: Object.freeze({ kind: 'external_source_v1', family: 'external_source', supported: true, validator: 'v1' }),
  external_source_v2: Object.freeze({ kind: 'external_source_v2', family: 'external_source', supported: true, validator: 'v2' }),
  review_iteration_v1: Object.freeze({ kind: 'review_iteration_v1', family: 'review_iteration', supported: true, validator: 'v1' }),
  review_iteration_v2: Object.freeze({ kind: 'review_iteration_v2', family: 'review_iteration', supported: true, validator: 'v2' }),
});

/**
 * 查询一个 contract kind 是否在 registry 中登记。
 * 未登记的 kind（包括 'none'、拼写错误、旧版本遗留的非标准值）一律返回 null，
 * caller 必须把这当作 fail-closed 信号（unsupported_evidence_contract），
 * 不能静默当作"无需校验"。
 */
export function lookupContractKind(kind) {
  if (!kind || typeof kind !== 'string') return null;
  return CONTRACT_KIND_REGISTRY[kind] || null;
}

export function isRegisteredContractKind(kind) {
  return lookupContractKind(kind) !== null;
}

export function isContractFamily(kind, family) {
  const entry = lookupContractKind(kind);
  return Boolean(entry && entry.family === family);
}

/**
 * 'none' 是显式的"不需要证据契约"值，不在 registry 里（它不是一个需要 family/validator
 * 分派的证据 kind），必须单独判断，不能被 lookupContractKind 误判为未登记而 fail-closed。
 */
export function isExplicitNoContractKind(kind) {
  return kind === 'none';
}
