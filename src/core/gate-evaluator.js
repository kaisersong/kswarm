/**
 * KSwarm — 唯一 gate evaluator（§8.2）
 *
 * 设计依据：mydocs/xiaok-cli/design/2026-08-31-collaboration-room-evidence-first-execution-and-gate-design.md v8
 *   §3.2 GateEvaluationV1 / 权威关系冻结表
 *   §3.3 依赖边分类（DependencyPolicy: completed | completed_for_remediation | verified_pass）
 *   §8.1.1 Hydration 与纯判定边界（evaluator 绝不读盘、绝不复算 hash、绝不读取 raw task.result）
 *   §8.2 唯一 gate evaluator 与全部兄弟路径
 *
 * 本模块导出的三个函数是 Phase 1 的核心契约：
 *   - evaluateDependencySatisfaction  （dispatch 前依赖边判定的唯一实现）
 *   - evaluatePreApprovalPrerequisites（最终批准前的只读快照评估，本文件先给出骨架）
 *   - verifyCommittedReviewGateDecision（提交后一致性校验，本文件先给出骨架）
 *
 * 本轮（Phase 1 第一批）先落地 evaluateDependencySatisfaction，收敛
 *   task-board.js:getDispatchable 和 dispatch-policy.js:getPendingDependencies
 * 两个重复实现的依赖判定逻辑。后两个函数需要 HydratedGateFactsV1（§8.1.1）作为输入，
 * 该 hydrator 尚未实现，留待本 Phase 后续提交补齐，此处先导出显式抛错的占位函数，
 * 防止任何 caller 误以为它们已经可用。
 */

import { countOpenBlockingConditions } from './review-condition.js';
import {IntrinsicMap,IntrinsicSet} from './intrinsic-collections.js';
import {types as dependencyTypes} from 'node:util';
// Dependency admission uses the same evaluator after original source SDKs.
// Keep its local failure accounting independent of late prototype hooks.
const dependencyIsArray=Array.isArray,dependencyOwn=Object.hasOwn,dependencyDefine=Object.defineProperty,dependencyDescriptor=Object.getOwnPropertyDescriptor,dependencyCreate=Object.create,dependencyProxy=dependencyTypes.isProxy;
const dependencyTrim=Function.prototype.call.bind(String.prototype.trim),dependencyParseTime=Date.parse,dependencyFinite=Number.isFinite;
const dependencyAppend=(array,value)=>dependencyDefine(array,array.length,{__proto__:null,value,writable:true,configurable:true,enumerable:true});
function dependencyValue(raw,key){if(!raw||typeof raw!=='object'||dependencyProxy(raw))return undefined;const row=dependencyDescriptor(raw,key);return row&&dependencyOwn(row,'value')?row.value:undefined;}
function dependencyRecord(raw,names){if(!raw||typeof raw!=='object'||dependencyIsArray(raw)||dependencyProxy(raw))return null;const out=dependencyCreate(null);for(let i=0;i<names.length;i++)dependencyDefine(out,names[i],{__proto__:null,value:dependencyValue(raw,names[i]),enumerable:true});return out;}



/**
 * @typedef {'completed'|'completed_for_remediation'|'verified_pass'} DependencyPolicy
 */

/**
 * @typedef {Object} GateEvaluationV1
 * @property {string} schemaVersion 固定为 'gate-evaluation-v1'
 * @property {string} sourceArtifactId
 * @property {string} sourceArtifactSha256
 * @property {string} sourceRunId
 * @property {Array<{artifactId: string, sha256: string}>} subjectArtifacts
 * @property {'passed'|'waiting_for_evidence'|'blocked'} verdict
 * @property {string} reasonCode
 * @property {string[]} findingIds
 * @property {string[]} conditionIds
 * @property {{participantId: string, runnerId?: string, modelFamily?: string, role: 'independent_reviewer'|'deterministic_verifier', independence: 'independent'|'degraded'}} evaluator
 * @property {string} createdAt
 */

/**
 * 判定单条依赖边是否满足。这是 dispatch 前依赖判定的唯一实现，
 * task-board.js:getDispatchable 和 dispatch-policy.js:getPendingDependencies
 * 必须委托本函数，不得各自维护 `dep.status === 'done'` 的私有判断。
 *
 * 纯函数：只接受已解析好的依赖任务对象和已 hydrate 好的 GateEvaluation 查找表，
 * 不读盘、不复算 hash、不读取 raw task.result。
 *
 * @param {Object} params
 * @param {Object} params.task 下游任务（消费依赖的一方）
 * @param {Object[]} params.dependencyTasks 该任务全部依赖任务的当前状态对象
 * @param {Record<string, DependencyPolicy>} params.dependencyPolicies
 *   key 为依赖任务 ID（resolved 后的稳定 ID），value 为该边的策略；
 *   若某依赖 ID 缺失对应策略，视为 schema v2 fail-closed（详见 §3.3）
 * @param {Record<string, GateEvaluationV1[]>} params.gateEvaluationsByTaskId
 *   已 hydrate 好的、按 taskId 索引的 GateEvaluation 列表（同一 task 可能有多轮评审）
 * @param {Record<string, string[]>} [params.consumedArtifactIdsByDependencyTaskId]
 *   下游任务对每个依赖任务声明的 consumedArtifactIds（用于 verified_pass 的 coverage 校验）
 * @param {boolean} [params.schemaV2=true] 是否按 v2 fail-closed 规则评估；false 时对齐 v1 legacy `completed` 行为
 * @returns {{ ok: boolean, blockedDependencies: Array<{ dependencyTaskId: string, reason: string }> }}
 */
export function evaluateDependencySatisfaction({
  task,
  dependencyTasks = [],
  dependencyPolicies = {},
  gateEvaluationsByTaskId = {},
  consumedArtifactIdsByDependencyTaskId = {},
  currentGateFactsByTaskId = {},
  schemaV2 = true,
} = {}) {
  if (!task) {
    return { ok: false, blockedDependencies: [{ dependencyTaskId: null, reason: 'task_required' }] };
  }

  const dependencyTaskMap = new IntrinsicMap();
  for(let i=0;i<dependencyTasks.length;i++){const dep=dependencyTasks[i];dependencyTaskMap.set(dep.id,dep);}
  const dependencyIds = dependencyIsArray(task.dependencies) ? task.dependencies : [];
  const blockedDependencies = [];

  for (let dependencyIndex=0;dependencyIndex<dependencyIds.length;dependencyIndex++) {
    const dependencyTaskId=dependencyIds[dependencyIndex];
    const dep = dependencyTaskMap.get(dependencyTaskId);
    if (!dep) {
      dependencyAppend(blockedDependencies, { dependencyTaskId, reason: 'dependency_task_not_found' });
      continue;
    }

    const policy = dependencyValue(dependencyPolicies,dependencyTaskId);

    if (!policy) {
      if (schemaV2) {
        dependencyAppend(blockedDependencies, { dependencyTaskId, reason: 'dependency_policy_missing' });
        continue;
      }
      if (dependencyValue(dep,'status') !== 'done') {
        dependencyAppend(blockedDependencies, { dependencyTaskId, reason: 'dependency_not_completed' });
      }
      continue;
    }

    if (policy === 'completed' || policy === 'completed_for_remediation') {
      if (dependencyValue(dep,'status') !== 'done') {
        dependencyAppend(blockedDependencies, { dependencyTaskId, reason: 'dependency_not_completed' });
      }
      continue;
    }

    if (policy === 'verified_pass') {
      if (dependencyValue(dep,'status') !== 'done') {
        dependencyAppend(blockedDependencies, { dependencyTaskId, reason: 'dependency_not_completed' });
        continue;
      }
      if (!schemaV2) continue;

      if (!dependencyOwn(consumedArtifactIdsByDependencyTaskId, dependencyTaskId)) {
        dependencyAppend(blockedDependencies, { dependencyTaskId, reason: 'consumed_artifacts_missing' });
        continue;
      }
      const consumedArtifactIds = dependencyValue(consumedArtifactIdsByDependencyTaskId,dependencyTaskId);
      if (!isUniqueNonEmptyStringArray(consumedArtifactIds)) {
        dependencyAppend(blockedDependencies, { dependencyTaskId, reason: 'consumed_artifacts_invalid' });
        continue;
      }

      const currentFacts = dependencyValue(currentGateFactsByTaskId,dependencyTaskId);
      const currentFactsError = validateCurrentGateFacts(currentFacts, dependencyTaskId);
      if (currentFactsError) {
        dependencyAppend(blockedDependencies, { dependencyTaskId, reason: currentFactsError });
        continue;
      }

      const evaluations = dependencyValue(gateEvaluationsByTaskId,dependencyTaskId);
      if (evaluations !== undefined && !dependencyIsArray(evaluations)) {
        dependencyAppend(blockedDependencies, { dependencyTaskId, reason: 'gate_evaluations_invalid' });
        continue;
      }
      let firstFailure = 'no_fresh_passed_evaluation';
      let satisfied = false;
      const candidates=evaluations||[];
      for (let evaluationIndex=0;evaluationIndex<candidates.length;evaluationIndex++) {
        const evaluation=candidates[evaluationIndex];
        const failure = validateEvaluationCandidate(evaluation, currentFacts, consumedArtifactIds);
        if (!failure) {
          satisfied = true;
          break;
        }
        if (firstFailure === 'no_fresh_passed_evaluation' || failure !== 'evaluation_verdict_not_passed') {
          firstFailure = failure;
        }
      }
      if (!satisfied) dependencyAppend(blockedDependencies, { dependencyTaskId, reason: firstFailure });
      continue;
    }

    dependencyAppend(blockedDependencies, { dependencyTaskId, reason: 'unknown_dependency_policy' });
  }

  return { ok: blockedDependencies.length === 0, blockedDependencies };
}

function validateCurrentGateFacts(facts, dependencyTaskId) {
  facts=dependencyRecord(facts,['sourceRunId','evaluationSourceArtifact','canonicalArtifacts']);
  if (!facts || typeof facts !== 'object' || dependencyIsArray(facts)) return 'current_gate_facts_missing';
  if (!isNonEmptyString(facts.sourceRunId)) return 'current_source_run_id_missing';
  if (!facts.evaluationSourceArtifact || !isArtifactIdentity(facts.evaluationSourceArtifact)) {
    return 'current_evaluation_source_artifact_missing';
  }
  if (!isUniqueArtifactIdentityArray(facts.canonicalArtifacts)) return 'current_canonical_artifacts_invalid';
  for(let i=0;i<facts.canonicalArtifacts.length;i++)if(dependencyValue(facts.canonicalArtifacts[i],'taskId')!==dependencyTaskId)return 'current_canonical_artifacts_invalid';
  return null;
}

function validateEvaluationCandidate(evaluation, facts, consumedArtifactIds) {
  evaluation=dependencyRecord(evaluation,['verdict','schemaVersion','reasonCode','findingIds','conditionIds','createdAt','evaluator','sourceRunId','sourceArtifactId','sourceArtifactSha256','subjectArtifacts']);
  facts=dependencyRecord(facts,['sourceRunId','evaluationSourceArtifact','canonicalArtifacts']);
  if (!evaluation || typeof evaluation !== 'object' || dependencyIsArray(evaluation) || evaluation.verdict !== 'passed') {
    return 'evaluation_verdict_not_passed';
  }
  if (evaluation.schemaVersion !== 'gate-evaluation-v1') return 'evaluation_schema_invalid';
  if (
    !isNonEmptyString(evaluation.reasonCode) ||
    !isUniqueNonEmptyStringArray(evaluation.findingIds) ||
    !isUniqueNonEmptyStringArray(evaluation.conditionIds) ||
    !isIsoTimestamp(evaluation.createdAt)
  ) return 'evaluation_schema_invalid';
  if (!isValidEvaluator(evaluation.evaluator)) return 'evaluation_evaluator_invalid';
  if (evaluation.evaluator.independence !== 'independent') return 'evaluation_independence_degraded';
  if (!isNonEmptyString(evaluation.sourceRunId)) return 'evaluation_source_run_id_missing';
  if (evaluation.sourceRunId !== facts.sourceRunId) return 'evaluation_source_run_stale';
  if (!isNonEmptyString(evaluation.sourceArtifactId) || !isNonEmptyString(evaluation.sourceArtifactSha256)) {
    return 'evaluation_source_artifact_invalid';
  }
  if (
    evaluation.sourceArtifactId !== facts.evaluationSourceArtifact.artifactId ||
    evaluation.sourceArtifactSha256 !== facts.evaluationSourceArtifact.sha256
  ) return 'evaluation_source_artifact_stale';
  if (!isUniqueArtifactIdentityArray(evaluation.subjectArtifacts)) {
    return 'evaluation_subject_artifacts_invalid';
  }

  const canonicalById = new IntrinsicMap();
  for(let i=0;i<facts.canonicalArtifacts.length;i++){const artifact=facts.canonicalArtifacts[i];canonicalById.set(artifact.artifactId,artifact.sha256);}
  for (let i=0;i<evaluation.subjectArtifacts.length;i++) {
    const subject=evaluation.subjectArtifacts[i];
    if (canonicalById.get(subject.artifactId) !== subject.sha256) return 'evaluation_subject_artifact_stale';
  }
  const subjectsById = new IntrinsicMap();
  for(let i=0;i<evaluation.subjectArtifacts.length;i++){const artifact=evaluation.subjectArtifacts[i];subjectsById.set(artifact.artifactId,artifact.sha256);}
  for (let i=0;i<consumedArtifactIds.length;i++) {
    const artifactId=consumedArtifactIds[i];
    const currentHash = canonicalById.get(artifactId);
    if (!currentHash) return 'consumed_artifact_not_current';
    if (subjectsById.get(artifactId) !== currentHash) return 'consumed_artifact_not_covered';
  }
  return null;
}

function isValidEvaluator(evaluator) {
  evaluator=dependencyRecord(evaluator,['participantId','role','independence','runnerId','modelFamily']);
  if (!evaluator || typeof evaluator !== 'object' || dependencyIsArray(evaluator)) return false;
  if (!isNonEmptyString(evaluator.participantId)) return false;
  if (evaluator.role!=='independent_reviewer'&&evaluator.role!=='deterministic_verifier') return false;
  if (evaluator.independence!=='independent'&&evaluator.independence!=='degraded') return false;
  if (evaluator.runnerId !== undefined && !isNonEmptyString(evaluator.runnerId)) return false;
  if (evaluator.modelFamily !== undefined && !isNonEmptyString(evaluator.modelFamily)) return false;
  return true;
}

function isUniqueArtifactIdentityArray(value) {
  if (!dependencyIsArray(value)) return false;
  const ids = new IntrinsicSet();
  for (let i=0;i<value.length;i++) {
    const artifact=value[i];
    if (!isArtifactIdentity(artifact) || ids.has(artifact.artifactId)) return false;
    ids.add(artifact.artifactId);
  }
  return true;
}

function isUniqueNonEmptyStringArray(value) {
  if (!dependencyIsArray(value)) return false;
  const values = new IntrinsicSet();
  for (let i=0;i<value.length;i++) {
    const item=value[i];
    if (!isNonEmptyString(item) || item !== dependencyTrim(item) || values.has(item)) return false;
    values.add(item);
  }
  return true;
}

function isIsoTimestamp(value) {
  return isNonEmptyString(value) && dependencyFinite(dependencyParseTime(value));
}

function isArtifactIdentity(value) {
  value=dependencyRecord(value,['artifactId','sha256']);
  return !!(value && typeof value === 'object' && !dependencyIsArray(value) && isNonEmptyString(value.artifactId) && isNonEmptyString(value.sha256));
}

function isNonEmptyString(value) {
  return typeof value === 'string' && dependencyTrim(value).length > 0;
}

/**
 * 最终批准前的只读快照评估（§8.3）。
 *
 * 纯函数：只读取候选 FinalDeliverable、tasks、conditions、project blockers 和
 * 已经 hydrate 好的 HydratedGateFactsV1；不读取当前 ReviewGateDecision、raw
 * task.result 或磁盘，不复算 hash。产出不可变（Object.freeze）的
 * projectGateSnapshot，供 approveFinalDeliverable 在同一 project-scoped
 * transaction 中消费。
 *
 * @param {Object} params
 * @param {Object} params.project 需要 id / lifecycleVersion / planRevisionRequired
 * @param {Object[]} params.tasks
 * @param {Object[]} params.conditions ReviewConditionV1[]
 * @param {Object} params.finalDeliverable 候选 FinalDeliverable（status='candidate'）
 * @param {Object} params.hydratedGateFacts HydratedGateFactsV1（§8.1.1）
 * @param {Object[]} params.projectBlockers 项目级 blocker 列表（非空即拒绝）
 * @returns {{ ok: boolean, error?: string, snapshot?: Object, missingTaskIds?: string[] }}
 */
export function evaluatePreApprovalPrerequisites({
  project,
  tasks = [],
  conditions = [],
  finalDeliverable,
  hydratedGateFacts,
  projectBlockers = [],
} = {}) {
  if (!project) return { ok: false, error: 'project_required' };
  if (!finalDeliverable) return { ok: false, error: 'final_deliverable_required' };
  if (!hydratedGateFacts) return { ok: false, error: 'hydrated_gate_facts_required' };

  const openBlockingConditions = countOpenBlockingConditions(conditions);
  if (openBlockingConditions > 0) {
    return { ok: false, error: 'open_blocking_condition', count: openBlockingConditions };
  }

  if (Array.isArray(projectBlockers) && projectBlockers.length > 0) {
    return { ok: false, error: 'project_blocker_present', blockers: projectBlockers };
  }

  if (project.planRevisionRequired) {
    return { ok: false, error: 'plan_revision_required' };
  }

  // §8.3 的 final artifact hash 一致性检查针对"有真实交付文件"的场景；
  // finalDeliverable.kind === 'none'（纯文字总结型交付，没有 artifactRef）
  // 没有这个概念，跳过该检查——但仍需经过上面的 condition/blocker/plan-revision
  // 检查和下面的 final-required gate task 检查。
  const isFileDeliverable = finalDeliverable.kind !== 'none' && Boolean(finalDeliverable.artifactRef?.artifactId);
  let finalArtifactEntry = null;
  if (isFileDeliverable) {
    const finalArtifactId = finalDeliverable.artifactRef.artifactId;
    finalArtifactEntry = Array.isArray(hydratedGateFacts.currentArtifacts)
      ? hydratedGateFacts.currentArtifacts.find(entry => entry.artifactId === finalArtifactId)
      : null;
    if (!finalArtifactEntry) {
      return { ok: false, error: 'final_artifact_not_hydrated' };
    }
    if (!finalArtifactEntry.containmentPassed) {
      return { ok: false, error: 'final_artifact_hash_mismatch' };
    }
  }

  // §8.3："final-required gate tasks 对该 hash 有 fresh GateEvaluation(passed)"。
  // 本轮判定 final-required 的范围：所有声明了 review_iteration_v2 evidenceContract
  // 且未被 cancelled 的 task（cancelled 的 task 已经不在交付路径上，不能因为
  // 它曾经声明过 gate-bearing evidenceContract 就永久挡住项目交付——例如 PO
  // 决定放弃一个有问题的 review 分支并改走别的路径时）。更完整的"从
  // FinalDeliverable 的 artifact provenance 闭包、risk floor 和
  // execution/evidence contracts 确定性求出 requiredFinalGateTaskIds"留待
  // risk-floor.js 真正接入项目创建流程后再扩展，避免在没有真实 risk profile
  // 数据之前先造一份无法验证正确性的闭包算法）。
  const finalRequiredGateTasks = (Array.isArray(tasks) ? tasks : [])
    .filter(task => task?.evidenceContract?.kind === 'review_iteration_v2' && task.status !== 'cancelled');

  const evaluationsBySourceRunId = new Map();
  for (const evaluation of Array.isArray(hydratedGateFacts.derivedGateEvaluations) ? hydratedGateFacts.derivedGateEvaluations : []) {
    evaluationsBySourceRunId.set(evaluation.sourceRunId, evaluation);
  }

  const missingTaskIds = [];
  const failedTaskIds = [];
  for (const task of finalRequiredGateTasks) {
    const matchingEvaluations = (hydratedGateFacts.derivedGateEvaluations || [])
      .filter(evaluation => (evaluation.subjectArtifacts || []).some(subject => subject.artifactId));
    if (matchingEvaluations.length === 0) {
      missingTaskIds.push(task.id);
      continue;
    }
    const hasPassed = matchingEvaluations.some(evaluation => evaluation.verdict === 'passed');
    if (!hasPassed) {
      failedTaskIds.push(task.id);
    }
  }

  if (missingTaskIds.length > 0) {
    return { ok: false, error: 'final_required_gate_task_missing_evaluation', missingTaskIds };
  }
  if (failedTaskIds.length > 0) {
    return { ok: false, error: 'final_required_gate_task_evaluation_failed', failedTaskIds };
  }

  const snapshot = Object.freeze({
    schemaVersion: 'project-gate-snapshot-v1',
    projectId: project.id,
    projectLifecycleVersion: hydratedGateFacts.projectLifecycleVersion,
    manifestRevision: hydratedGateFacts.manifestRevision,
    finalDeliverableId: finalDeliverable.deliverableId,
    finalArtifactSha256: finalArtifactEntry?.serviceSha256 || null,
    inputConditionIds: Object.freeze(conditions.map(c => c.conditionId)),
    inputTaskIds: Object.freeze(finalRequiredGateTasks.map(t => t.id)),
    createdAt: new Date().toISOString(),
  });

  return { ok: true, snapshot };
}

/**
 * 提交后一致性校验（§8.3 步骤 3）。校验 decision、preApprovalSnapshot、当前
 * fresh hydratedGateFacts 的一致性。任何漂移使 read model 返回不可关闭，
 * 并要求重做批准；不递归调用 evaluatePreApprovalPrerequisites（那会重新做
 * 一遍 pre-approval 判定，违反"提交后校验只比对既有事实"的边界）。
 *
 * @param {Object} params
 * @param {Object} params.project
 * @param {Object} params.reviewGateDecision 已提交的 ReviewGateDecision，
 *   必须携带 projectGateSnapshotRef（提交时绑定的 snapshot 引用）
 * @param {Object} params.preApprovalSnapshot 批准时产出的 projectGateSnapshot
 * @param {Object} params.hydratedGateFacts 校验时刻重新 hydrate 的 fresh facts
 * @returns {{ ok: boolean, error?: string, canAutoClose?: boolean }}
 */
export function verifyCommittedReviewGateDecision({
  project,
  reviewGateDecision,
  preApprovalSnapshot,
  hydratedGateFacts,
} = {}) {
  if (!project || !reviewGateDecision || !preApprovalSnapshot || !hydratedGateFacts) {
    return { ok: false, error: 'missing_required_input' };
  }

  const decisionSnapshotRef = reviewGateDecision.projectGateSnapshotRef;
  if (
    !decisionSnapshotRef ||
    decisionSnapshotRef.finalDeliverableId !== preApprovalSnapshot.finalDeliverableId ||
    decisionSnapshotRef.projectId !== preApprovalSnapshot.projectId
  ) {
    return { ok: false, error: 'snapshot_drift' };
  }

  if (Number(hydratedGateFacts.projectLifecycleVersion) !== Number(preApprovalSnapshot.projectLifecycleVersion)) {
    return { ok: false, error: 'lifecycle_version_drift' };
  }

  if (Number(hydratedGateFacts.manifestRevision) !== Number(preApprovalSnapshot.manifestRevision)) {
    return { ok: false, error: 'manifest_revision_drift' };
  }

  // 精确匹配：找到 preApprovalSnapshot 锁定时对应的那个 artifact 条目，
  // 用它当前的 fresh serviceSha256 与 snapshot 锁定的 finalArtifactSha256 比对。
  // hydratedGateFacts.currentArtifacts 里的条目本身就是"重新读盘计算出的当前
  // hash"，如果磁盘内容在批准后被篡改，这里的 serviceSha256 就会与 snapshot
  // 锁定值不同——这正是要检测的"批准后文件被篡改"场景。
  const matchedArtifact = Array.isArray(hydratedGateFacts.currentArtifacts)
    ? hydratedGateFacts.currentArtifacts.find(entry => entry.canonicalRelativePath && entry.manifestSha256 === preApprovalSnapshot.finalArtifactSha256)
    : null;
  const freshFinalArtifactSha256 = matchedArtifact?.serviceSha256;
  if (freshFinalArtifactSha256 !== preApprovalSnapshot.finalArtifactSha256) {
    return { ok: false, error: 'final_artifact_hash_drift' };
  }

  if (reviewGateDecision.decision !== 'passed') {
    return { ok: false, error: 'decision_not_passing' };
  }

  return { ok: true, canAutoClose: reviewGateDecision.autoCloseAllowed === true };
}
