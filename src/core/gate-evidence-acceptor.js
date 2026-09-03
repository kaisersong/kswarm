/**
 * KSwarm — acceptTaskGateEvidence（design §9.1 / §3.2 / §3.4 / §4.2 / §5.1.1）
 *
 * 设计依据：mydocs/xiaok-cli/design/2026-08-31-collaboration-room-evidence-first-execution-and-gate-design.md v8
 *   §9.1 KSwarm service —— "acceptTaskGateEvidence(input, requestSource) // 接受 artifact
 *   后确定性解析，不允许直接写 verdict"
 *   §3.2 GateEvaluation —— v2 gate 解析必须：
 *     1. task result 显式声明唯一 gateEvidenceArtifactId
 *     2. canonical artifact manifest 解析精确路径/taskId/runId/producerId/expected hash
 *     3. service 用 realpath containment 校验后读取磁盘 artifact，重新计算 sha256
 *     4. 只有 service hash 与 canonical manifest hash 一致，且 schema 为
 *        review-evidence-v2/checks-v2，才解析 GateEvaluation
 *     5. inline evidence 永不作为 v2 gate 输入
 *     6. 多候选/缺 ID/endsWith 模糊命中/未知 schema 均 fail closed
 *   §3.4 ReviewCondition —— findings 确定性导入为 ReviewConditionV1
 *   §4.2 独立性约束 —— reviewer 与 producer 相同 participant 时 independence=degraded
 *
 * 本模块是 GateEvaluationV1/ReviewConditionV1 磁盘证据的唯一真实构造入口：
 * 此前 review-evidence-v2.json 从未被任何生产代码解析过，本模块补齐"磁盘证据 →
 * 结构化 GateEvaluation/Condition"这一环，供未来 hydrateGateFacts 读取消费。
 * 本模块只做"接受 evidence 后确定性解析"，不写入 project-scoped durable
 * gateEvaluations 集合本身（那是 hub.js caller 的持久化职责）。
 */

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { buildReviewConditionFromFinding } from './review-condition.js';
import { classifyEvaluatorIndependence } from './reviewer-independence.js';

const SUPPORTED_EVIDENCE_SCHEMAS = Object.freeze(['review-evidence-v2', 'checks-v2']);
const VALID_VERDICTS = Object.freeze(['passed', 'waiting_for_evidence', 'blocked']);

export function acceptTaskGateEvidence(input = {}, requestSource) {
  const {
    projectId,
    taskId,
    runId,
    artifactsDir,
    gateEvidenceArtifactId,
    assignedAgent,
    reviewerParticipantId,
    producerParticipantId,
    canonicalArtifactLookup,
  } = input;

  // §9.1：mutation service 方法必须显式接收 requestSource，default deny。
  if (!requestSource || typeof requestSource !== 'object' || !requestSource.kind) {
    return { ok: false, error: 'request_source_required' };
  }

  // §9.1："Agent 只可为自己被分派的 task 提交 evidence artifact"。
  if (requestSource.kind === 'agent') {
    if (!assignedAgent || requestSource.participantId !== assignedAgent) {
      return { ok: false, error: 'not_assigned_agent' };
    }
  } else if (requestSource.kind !== 'user' && requestSource.kind !== 'system_reconciler') {
    return { ok: false, error: 'unsupported_request_source' };
  }

  // §3.2 步骤 1：task result 必须显式声明唯一 gateEvidenceArtifactId。
  if (!gateEvidenceArtifactId || typeof gateEvidenceArtifactId !== 'string') {
    return { ok: false, error: 'gate_evidence_artifact_id_required' };
  }

  if (typeof canonicalArtifactLookup !== 'function') {
    return { ok: false, error: 'canonical_artifact_lookup_required' };
  }

  // §3.2 步骤 2：canonical artifact manifest 解析精确路径/expected hash。
  const canonicalArtifact = canonicalArtifactLookup(gateEvidenceArtifactId);
  if (!canonicalArtifact || !canonicalArtifact.relativePath || !canonicalArtifact.sha256) {
    return { ok: false, error: 'canonical_artifact_not_found' };
  }

  // §3.2 步骤 3：realpath containment 校验后读取磁盘 artifact，重新计算 service hash。
  const readResult = readContainedArtifact(artifactsDir, canonicalArtifact.relativePath);
  if (!readResult.ok) return readResult;

  const serviceHash = createHash('sha256').update(readResult.content).digest('hex');
  // §3.2 步骤 4：只有 service hash 与 canonical manifest hash 一致才继续。
  if (serviceHash !== canonicalArtifact.sha256) {
    return { ok: false, error: 'artifact_hash_mismatch' };
  }

  let parsed;
  try {
    parsed = JSON.parse(readResult.content.toString('utf-8'));
  } catch {
    return { ok: false, error: 'artifact_not_valid_json' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'artifact_not_valid_json' };
  }

  // §3.2 步骤 4/6：schema 必须显式是 review-evidence-v2 或 checks-v2，未知一律 fail closed。
  if (!SUPPORTED_EVIDENCE_SCHEMAS.includes(parsed.schemaVersion)) {
    return { ok: false, error: 'unsupported_evidence_schema' };
  }

  if (!VALID_VERDICTS.includes(parsed.verdict)) {
    return { ok: false, error: 'invalid_verdict' };
  }

  const subjectArtifacts = Array.isArray(parsed.subjectArtifacts) ? parsed.subjectArtifacts : [];

  // §4.2：reviewer 与 producer 相同 participant，或不同 participant 但共享同一
  // runner/model family 时 independence=degraded。复用 reviewer-independence.js
  // 的唯一实现（classifyEvaluatorIndependence），不在本模块维护第二份简化判定
  // 逻辑——此前的实现只判断了 participant 相同这一种情况，遗漏了 runner/model
  // family 场景，是本轮发现并收敛的一处真实兄弟路径重复问题。
  const { independence } = classifyEvaluatorIndependence({
    reviewerParticipantId,
    producerParticipantId,
    reviewerRunnerId: input.reviewerRunnerId,
    producerRunnerId: input.producerRunnerId,
    reviewerModelFamily: input.reviewerModelFamily,
    producerModelFamily: input.producerModelFamily,
  });

  const evaluation = {
    schemaVersion: 'gate-evaluation-v1',
    sourceArtifactId: gateEvidenceArtifactId,
    sourceArtifactSha256: serviceHash,
    sourceRunId: runId || null,
    subjectArtifacts,
    verdict: parsed.verdict,
    reasonCode: parsed.reasonCode || (parsed.verdict === 'passed' ? 'evidence_passed' : 'evidence_not_passed'),
    findingIds: Array.isArray(parsed.findings) ? parsed.findings.map(f => f?.id).filter(Boolean) : [],
    conditionIds: [],
    evaluator: {
      participantId: reviewerParticipantId || assignedAgent || 'unknown',
      role: 'independent_reviewer',
      independence,
    },
    createdAt: new Date().toISOString(),
  };

  // §3.4：findings 中的 blocking finding 确定性导入为 ReviewConditionV1。
  const findings = Array.isArray(parsed.findings) ? parsed.findings : [];
  const conditions = findings
    .filter(finding => finding && finding.blocking === true)
    .map(finding => buildReviewConditionFromFinding({
      projectId,
      sourceTaskId: taskId,
      sourceReviewRunId: runId,
      originatingReviewerIdentity: reviewerParticipantId || requestSource.participantId || null,
      finding,
    }));

  evaluation.conditionIds = conditions.map(c => c.conditionId);

  return { ok: true, evaluation, conditions };
}

/**
 * realpath containment 校验后读取 artifact 原始字节。复用与
 * artifact-path-resolver.js 一致的安全模型（词法校验 + realpath 越界拒绝），
 * 但这里的输入是 canonical manifest 已经给出的相对路径（可信来源），
 * 不是用户可控的原始请求路径，因此只做 containment 校验，不重复完整的
 * segment allowlist（那属于写入路径 resolver 的职责）。
 */
export function readContainedArtifact(artifactsDir, relativePath) {
  if (!artifactsDir) return { ok: false, error: 'artifacts_dir_required' };
  if (typeof relativePath !== 'string' || !relativePath || relativePath.includes('\0')) {
    return { ok: false, error: 'invalid_artifact_path' };
  }
  const normalized = relativePath.replace(/\\/g, '/');
  if (isAbsolute(normalized) || normalized.split('/').some(seg => seg === '..' || seg === '')) {
    return { ok: false, error: 'invalid_artifact_path' };
  }

  let rootRealPath;
  try {
    rootRealPath = realpathSync(resolve(artifactsDir));
  } catch {
    return { ok: false, error: 'artifact_root_missing' };
  }

  const candidate = resolve(rootRealPath, normalized);
  const rel = relative(rootRealPath, candidate);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    return { ok: false, error: 'artifact_path_escape' };
  }

  if (!existsSync(candidate)) {
    return { ok: false, error: 'artifact_missing' };
  }

  let realCandidate;
  try {
    realCandidate = realpathSync(candidate);
  } catch {
    return { ok: false, error: 'artifact_missing' };
  }
  const relOfReal = relative(rootRealPath, realCandidate);
  if (!relOfReal || relOfReal.startsWith('..') || isAbsolute(relOfReal)) {
    return { ok: false, error: 'artifact_path_escape' };
  }

  try {
    // design §8.1.1/§10.5：read-before/read-after stat 比对——先 stat 记录
    // inode/size/mtime，再读取内容，最后再 stat 一次；如果读取过程中文件被
    // 替换（真实 TOCTOU 窗口，例如原子 rename 替换目标文件），beforeStat 与
    // afterStat 的 ino/size/mtimeMs 会不一致，caller 必须据此判定 conflict，
    // 不能信任这次读到的内容。这里只做检测和暴露 stat，不做业务决策
    // （是否 fail closed 是 hydrateGateFacts/approveFinalDeliverable 的职责）。
    const beforeStat = statSync(realCandidate);
    const content = readFileSync(realCandidate);
    const afterStat = statSync(realCandidate);
    const statChangedDuringRead = (
      beforeStat.ino !== afterStat.ino ||
      beforeStat.size !== afterStat.size ||
      beforeStat.mtimeMs !== afterStat.mtimeMs
    );
    return {
      ok: true,
      content,
      stat: { ino: afterStat.ino, size: afterStat.size, mtimeMs: afterStat.mtimeMs },
      statChangedDuringRead,
    };
  } catch {
    return { ok: false, error: 'artifact_read_failed' };
  }
}
