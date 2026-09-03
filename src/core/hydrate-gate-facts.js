/**
 * KSwarm — hydrateGateFacts（design §8.1.1，唯一 gate 读盘与派生事实 I/O owner）
 *
 * 设计依据：mydocs/xiaok-cli/design/2026-08-31-collaboration-room-evidence-first-execution-and-gate-design.md v8
 *   §8.1.1 Hydration 与纯判定边界
 *
 * hydrateGateFacts 是 gate 读盘与派生事实的唯一 I/O owner：做 canonical ID 解析、
 * realpath containment、真实文件读取、service SHA-256、schema 解析、
 * manifest/lifecycle version 校验，并从磁盘证据派生 GateEvaluation facts。
 * 它不做"是否解锁/是否批准"的业务决策——那是 §8.2 三个纯函数 evaluator 的职责，
 * 它们只接受本函数产出的 HydratedGateFactsV1，绝不读盘、绝不复算 hash。
 *
 * 不存在、越界、hash/schema 不符以结构化 blocked fact（containmentPassed=false）
 * 返回，不终止整个 hydration；只有 expectedLifecycleVersion 不匹配（CAS 冲突）
 * 或 project/canonicalArtifacts 结构本身缺失时才整体拒绝。
 */

import { readContainedArtifact } from './gate-evidence-acceptor.js';
import { getCanonicalArtifact } from './canonical-artifact-registry.js';
import { createHash } from 'node:crypto';

const HYDRATED_GATE_FACTS_SCHEMA_VERSION = 'hydrated-gate-facts-v1';

/**
 * @param {Object} params
 * @param {Object} params.project 必须已有 lifecycleVersion / canonicalArtifacts / manifestRevision
 * @param {string[]} params.requiredArtifactIds
 * @param {number} params.expectedLifecycleVersion
 * @param {string} params.artifactsDir 与 canonicalArtifacts 中 relativePath 配对的根目录
 * @returns {{ ok: boolean, facts?: Object, error?: string }}
 */
export function hydrateGateFacts({ project, requiredArtifactIds = [], expectedLifecycleVersion, artifactsDir } = {}) {
  if (!project || typeof project !== 'object') {
    return { ok: false, error: 'project_required' };
  }
  if (!project.canonicalArtifacts || typeof project.canonicalArtifacts !== 'object') {
    return { ok: false, error: 'canonical_artifacts_not_initialized' };
  }

  const currentLifecycleVersion = Number(project.lifecycleVersion || 0);
  if (Number(expectedLifecycleVersion) !== currentLifecycleVersion) {
    return { ok: false, error: 'lifecycle_version_conflict', currentLifecycleVersion };
  }

  const requiredIds = Array.isArray(requiredArtifactIds) ? requiredArtifactIds : [];
  const currentArtifacts = requiredIds.map(artifactId => hydrateSingleArtifact(project, artifactId, artifactsDir));

  const derivedGateEvaluations = deriveFreshGateEvaluations(project, currentArtifacts);

  const facts = {
    schemaVersion: HYDRATED_GATE_FACTS_SCHEMA_VERSION,
    projectId: project.id || null,
    projectLifecycleVersion: currentLifecycleVersion,
    hydratedAt: new Date().toISOString(),
    manifestRevision: Number(project.manifestRevision || 0),
    currentArtifacts,
    derivedGateEvaluations,
    // deterministicCheckResults：本轮尚未接入 checks-v2.js 磁盘证据的批量解析
    // （只有 gate-evidence-acceptor.js 单条 acceptTaskGateEvidence 调用时才会
    // 解析出 ChecksV2 关联的 evaluation；批量 hydration 场景下的 ChecksV2 聚合
    // 留待接入 evaluatePreApprovalPrerequisites 真实需要它时再实现，避免在没有
    // 真实 caller 之前先造一份无法验证正确性的聚合逻辑）。
    deterministicCheckResults: [],
  };

  return { ok: true, facts };
}

function hydrateSingleArtifact(project, artifactId, artifactsDir) {
  const canonical = getCanonicalArtifact(project, artifactId);
  const base = { artifactId, canonicalRelativePath: null, serviceSha256: null, manifestSha256: null, containmentPassed: false };

  if (!canonical) return base;

  base.canonicalRelativePath = canonical.relativePath;
  base.manifestSha256 = canonical.sha256;

  const readResult = readContainedArtifact(artifactsDir, canonical.relativePath);
  if (!readResult.ok) return base;
  // design §8.1.1/§10.5：read-before/read-after stat 在单次读取内部已经检测
  // 到文件在读取期间被替换（真实 TOCTOU 窗口）；这种情况下即使 hash 碰巧算出
  // 来了，读到的内容也不可信，必须整体按 containment 失败处理（不能只信任
  // "恰好算出的" serviceSha256）。
  if (readResult.statChangedDuringRead) return base;

  const serviceSha256 = createHash('sha256').update(readResult.content).digest('hex');
  base.serviceSha256 = serviceSha256;
  base.containmentPassed = serviceSha256 === canonical.sha256;
  return base;
}

/**
 * 从 project.gateEvaluations 中筛选与本次 hydration 的 currentArtifacts "fresh"
 * 对齐的 GateEvaluationV1：sourceRunId 必须与该 artifact 在 canonicalArtifacts
 * 中登记的 runId 一致（防止陈旧 run 产出的 evaluation 被当作当前证据）。
 * containmentPassed=false 的 artifact 不参与派生（它本身已经不可信）。
 */
/**
 * 从 project.gateEvaluations 中筛选与本次 hydration 的 currentArtifacts
 * "fresh"对齐的 GateEvaluationV1：evaluation.subjectArtifacts 里每个
 * 声明的 artifactId 当前 canonical 记录的 sha256，必须与 evaluation 记录的
 * subjectArtifacts sha256 完全一致——如果 artifact 内容已经变化（被
 * remediation 覆盖出新版本，或原地被篡改），canonical 当前 sha256 会与
 * evaluation 记录的旧 sha256 不同，旧 evaluation 天然被排除，不需要额外
 * 记录状态。containmentPassed=false 的 artifact 不参与派生（它本身已经
 * 不可信）。
 *
 * 现状核实与修复（2026-09-02，design §14.4 端到端场景驱动发现）：此前的
 * 实现比较的是 "evaluation.sourceRunId === 该 artifact 当前 canonical 记录
 * 的 runId"——这个判定只在"同一个 task 既产出 artifact 又对自己的产出做
 * gate 判定"（self-check）时恰好成立，但设计文档反复强调的核心场景是
 * "独立 reviewer/verifier 核验另一个 producer 任务产出的 artifact"：
 * verifier 自己的 sourceRunId 和 producer 产出 artifact 的 runId 是两个
 * 完全不同的 run，永远不会相等——这会让所有真实的独立核验场景的
 * evaluation 永远被判定为"不 fresh"，无法用于批准，是一个真实的逻辑缺陷。
 * 此前测试（hydrate-gate-facts.test.js）恰好只覆盖了 self-check 场景（
 * canonical artifact 的 taskId 与 evaluation 的 sourceTaskId 相同），从未
 * 覆盖独立 reviewer 场景，因此这个缺陷此前从未被测试暴露。改为比较 hash
 * 而不是 runId 后，self-check 场景依然成立（sha256 不变则仍是 fresh），
 * 独立 reviewer 场景也能正确工作。
 */
function deriveFreshGateEvaluations(project, currentArtifacts) {
  const evaluationsByTaskId = project.gateEvaluations && typeof project.gateEvaluations === 'object'
    ? project.gateEvaluations
    : {};
  const currentShaByArtifactId = new Map();
  for (const artifact of currentArtifacts) {
    if (!artifact.containmentPassed) continue;
    currentShaByArtifactId.set(artifact.artifactId, artifact.serviceSha256);
  }

  const result = [];
  for (const evaluations of Object.values(evaluationsByTaskId)) {
    if (!Array.isArray(evaluations)) continue;
    for (const evaluation of evaluations) {
      const subjectArtifacts = Array.isArray(evaluation?.subjectArtifacts) ? evaluation.subjectArtifacts : [];
      const isFresh = subjectArtifacts.length > 0 && subjectArtifacts.every(subject => {
        const currentSha = currentShaByArtifactId.get(subject?.artifactId);
        return currentSha !== undefined && currentSha === subject?.sha256;
      });
      if (isFresh) result.push(evaluation);
    }
  }
  return result;
}
