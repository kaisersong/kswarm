/**
 * KSwarm — deriveRiskFloor / deriveReviewRequirement（design §4）
 *
 * 设计依据：mydocs/xiaok-cli/design/2026-08-31-collaboration-room-evidence-first-execution-and-gate-design.md v8
 *   §4.1 风险档位
 *   §4.2 独立性约束
 *
 * deriveRiskFloor 是确定性纯函数：给出 low/normal/high 三档中的一个保守下界，
 * planner 只能提高，不能降低。floor 的输入优先使用结构化
 * requestedOutput.kind/audience、execution/evidence contract 和 artifact media
 * type；关键词只作保守加分，不能是唯一信号（本模块的关键词匹配仅用于命中
 * high 档时的加分项，未命中不产生任何降级效果）。
 *
 * 这是本轮"有限、确定性的本地函数"，不实现完整的语义分类系统——已知残余：
 * 若用户和 planner 都未声明外部事实/公开发布且措辞未命中，本函数可能只能判
 * normal，这是设计文档明确承认的局限，不能靠夸大分类准确率消除。
 */

const HIGH_RISK_KEYWORDS = /财务|法律|安全|security|legal|financial|compliance|合规|审计|audit|发布|release|公开发布|public\s*release/i;
const EXTERNAL_FACT_CHECK_KEYWORDS = /事实核查|fact.?check|核实|verify\s+the\s+facts/i;

export const RISK_LEVELS = Object.freeze(['low', 'normal', 'high']);

function riskRank(level) {
  return RISK_LEVELS.indexOf(level);
}

export function maxRiskLevel(...levels) {
  const valid = levels.filter(level => RISK_LEVELS.includes(level));
  if (valid.length === 0) return 'low';
  return valid.reduce((max, level) => (riskRank(level) > riskRank(max) ? level : max), 'low');
}

/**
 * @param {Object} params
 * @param {Object} [params.plan]
 * @param {Array} [params.executionContracts] 已推断的 execution/evidence contract 列表
 * @param {{kind?: string, audience?: string}} [params.requestedOutput]
 * @returns {'low'|'normal'|'high'}
 */
export function deriveRiskFloor({ plan = null, executionContracts = [], requestedOutput = {} } = {}) {
  const contracts = Array.isArray(executionContracts) ? executionContracts : [];

  // 1. 命中 external_source_v2/v1、事实核查、公开发布、财务/法律/医疗/安全、
  //    release/security gate → high。
  const hasExternalSourceContract = contracts.some(c => c?.kind === 'external_source_v1' || c?.kind === 'external_source_v2');
  const audienceText = String(requestedOutput?.audience || '').toLowerCase();
  const kindText = String(requestedOutput?.kind || '').toLowerCase();
  const planText = collectPlanText(plan);
  const combinedText = `${audienceText}\n${kindText}\n${planText}`;

  const isPublicRelease = /public|external|公开|发布/i.test(audienceText) || /release|发布/i.test(kindText);
  const hitsHighRiskKeyword = HIGH_RISK_KEYWORDS.test(combinedText);
  const hitsFactCheckKeyword = EXTERNAL_FACT_CHECK_KEYWORDS.test(combinedText);

  if (hasExternalSourceContract && (hitsFactCheckKeyword || isPublicRelease)) return 'high';
  if (isPublicRelease && hitsHighRiskKeyword) return 'high';
  if (hitsFactCheckKeyword) return 'high';
  if (hitsHighRiskKeyword && (isPublicRelease || hasExternalSourceContract)) return 'high';

  // 2. 有用户交付物但不命中 high -> normal。
  const hasUserFacingDeliverable = Boolean(requestedOutput?.kind) || Boolean(plan?.phases?.length);
  if (hasUserFacingDeliverable) return 'normal';

  // 3. 明确的内部可逆草稿且无外部来源 -> low。
  return 'low';
}

function collectPlanText(plan) {
  if (!plan || typeof plan !== 'object') return '';
  const parts = [plan.analysis, plan.goal, plan.name];
  for (const phase of plan.phases || []) {
    parts.push(phase.name);
    for (const item of phase.items || []) {
      parts.push(item.title, item.brief, item.acceptanceCriteria);
    }
  }
  return parts.filter(Boolean).join('\n');
}

/**
 * §4.1：最终 riskProfile = max(deterministicFloor, plannerProposal, userSelection)。
 * 用户可以撤销 planner 额外抬高的档位，但不能降到 deterministic floor 以下。
 * high 的用户最终批准不可取消（该约束在 approveFinalDeliverable 层强制，本函数
 * 只负责档位计算本身）。
 */
export function resolveEffectiveRiskProfile({ deterministicFloor, plannerProposal = null, userSelection = null }) {
  if (!RISK_LEVELS.includes(deterministicFloor)) throw new Error(`invalid_deterministic_floor: ${deterministicFloor}`);
  const candidates = [deterministicFloor];
  if (plannerProposal && RISK_LEVELS.includes(plannerProposal)) candidates.push(plannerProposal);
  if (userSelection && RISK_LEVELS.includes(userSelection)) candidates.push(userSelection);
  // 用户可以撤销 planner 抬高的档位，但不能低于 deterministic floor：
  // 若用户显式选择了一个低于 planner 提案但仍 >= floor 的档位，应采用用户选择。
  if (userSelection && RISK_LEVELS.includes(userSelection) && riskRank(userSelection) >= riskRank(deterministicFloor)) {
    return userSelection;
  }
  return maxRiskLevel(...candidates);
}

/**
 * §4.1：是否允许免人工 review 不是 planner/Agent 的自由字段。
 * high 必须独立 review + 确定性检查；normal 必须独立 review 或契约明确列出的
 * 等价确定性检查；low 只有同时满足以下四项确定性条件才可免 review：
 *   1. 无外部来源（!hasExternalSourceContract）
 *   2. 无公开或用户最终交付物（!isPublicRelease && !hasUserFacingDeliverable）
 *   3. 操作可逆（reversible === true，显式声明，缺失视为不可逆）
 *   4. 确定性 policy 明确 allowReviewExemption=true
 * 任一输入缺失均按 normal 处理；Agent 不能声明或降低 exemption。
 */
export function deriveReviewRequirement({
  riskProfile,
  executionContracts = [],
  requestedOutput = {},
  reversible = false,
  policyAllowsReviewExemption = false,
} = {}) {
  if (!RISK_LEVELS.includes(riskProfile)) {
    return { requiresIndependentReview: true, requiresDeterministicCheck: true, allowExemption: false, reasonCode: 'invalid_risk_profile_defaults_to_normal' };
  }

  if (riskProfile === 'high') {
    return { requiresIndependentReview: true, requiresDeterministicCheck: true, allowExemption: false, reasonCode: 'high_risk_mandatory' };
  }

  if (riskProfile === 'normal') {
    return { requiresIndependentReview: true, requiresDeterministicCheck: false, allowExemption: false, reasonCode: 'normal_risk_review_or_deterministic_check' };
  }

  // riskProfile === 'low'
  const contracts = Array.isArray(executionContracts) ? executionContracts : [];
  const hasExternalSourceContract = contracts.some(c => c?.kind === 'external_source_v1' || c?.kind === 'external_source_v2');
  const audienceText = String(requestedOutput?.audience || '').toLowerCase();
  const isPublicRelease = /public|external|公开|发布/i.test(audienceText);
  const hasUserFacingDeliverable = Boolean(requestedOutput?.kind);

  const exemptionEligible = (
    !hasExternalSourceContract &&
    !isPublicRelease &&
    !hasUserFacingDeliverable &&
    reversible === true &&
    policyAllowsReviewExemption === true
  );

  if (exemptionEligible) {
    return { requiresIndependentReview: false, requiresDeterministicCheck: false, allowExemption: true, reasonCode: 'low_risk_exemption_conditions_met' };
  }
  return { requiresIndependentReview: true, requiresDeterministicCheck: false, allowExemption: false, reasonCode: 'low_risk_exemption_conditions_not_met' };
}
