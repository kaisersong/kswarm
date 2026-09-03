/**
 * KSwarm — project 级 canonical artifact registry + manifestRevision（design §8.1.1 / §3.5）
 *
 * 设计依据：mydocs/xiaok-cli/design/2026-08-31-collaboration-room-evidence-first-execution-and-gate-design.md v8
 *   §8.1.1 —— HydratedGateFactsV1.manifestRevision，批准入口 CAS 校验的一部分
 *   §3.5 —— "同一 canonical artifact ID 不允许不同 task/run 覆写；artifact record 与
 *   extension 在一次 project-scoped mutation 中原子持久化"
 *
 * 纯函数集合，不做磁盘 I/O（不读盘验证 hash 是否与真实文件一致——那是
 * hydrateGateFacts 的职责）。本模块只维护"project 声称的 canonical artifact
 * 集合 + 版本号"这一层内存中的真相来源，供 hydrateGateFacts 读取后与磁盘
 * 实际内容比对。
 */

/**
 * @typedef {Object} CanonicalArtifactRecord
 * @property {string} artifactId
 * @property {string} relativePath project-root-relative POSIX 路径
 * @property {string} sha256
 * @property {string} [taskId]
 * @property {string} [runId]
 */

/**
 * 批量注册 canonical artifact 记录到 project。整批记录要么全部成功、要么
 * 全部拒绝（fail closed，不部分写入），避免出现"这批提交里一半已经生效、
 * 一半被拒绝"的不一致中间状态。
 *
 * 规则（design §3.5）：
 *   - 完全相同的记录（同 artifactId 同 sha256 同 taskId 同 runId）重复注册是
 *     幂等的，不递增 manifestRevision；
 *   - 同一 artifactId、同一 taskId+runId 但 sha256 变化，视为该 task/run 对
 *     自己产出的证据做了内容更新，允许并递增版本号；
 *   - 同一 artifactId 但 taskId/runId 与已登记的不同，视为跨 task/run 冲突
 *     覆写，拒绝（"同一 canonical artifact ID 不允许不同 task/run 覆写"）；
 *   - 一次成功的批量注册（无论新增/更新几条）只递增一次 manifestRevision，
 *     对应"一次 project-scoped mutation"的原子性语义。
 *
 * @param {Object} project 必须已有 project.canonicalArtifacts（对象）和
 *   project.manifestRevision（数字），caller 负责保证字段存在（本模块不
 *   负责 project 对象的初始化默认值，避免与 hub.js 的 project 构造逻辑产生
 *   第二份初始化规则）。
 * @param {CanonicalArtifactRecord[]} records
 * @returns {{ ok: boolean, manifestRevision?: number, error?: string }}
 */
export function registerCanonicalArtifacts(project, records = []) {
  if (!project || typeof project !== 'object') {
    return { ok: false, error: 'project_required' };
  }
  if (!project.canonicalArtifacts || typeof project.canonicalArtifacts !== 'object') {
    return { ok: false, error: 'canonical_artifacts_not_initialized' };
  }

  const list = Array.isArray(records) ? records : [];
  for (const record of list) {
    if (!isValidRecord(record)) {
      return { ok: false, error: 'invalid_canonical_artifact_record' };
    }
  }

  // 冲突预检：先在不改变 project 状态的前提下判断是否有跨 task/run 覆写，
  // 保证"要么全部生效、要么全部拒绝"。
  for (const record of list) {
    const existing = project.canonicalArtifacts[record.artifactId];
    if (existing && !isSameOwnership(existing, record)) {
      return { ok: false, error: 'canonical_artifact_ownership_conflict', artifactId: record.artifactId };
    }
  }

  let changed = false;
  for (const record of list) {
    const existing = project.canonicalArtifacts[record.artifactId];
    if (existing && existing.sha256 === record.sha256 && existing.relativePath === record.relativePath) {
      continue; // 完全相同，幂等跳过。
    }
    project.canonicalArtifacts[record.artifactId] = {
      artifactId: record.artifactId,
      relativePath: record.relativePath,
      sha256: record.sha256,
      taskId: record.taskId || null,
      runId: record.runId || null,
    };
    changed = true;
  }

  if (changed) {
    project.manifestRevision = Number(project.manifestRevision || 0) + 1;
  }

  return { ok: true, manifestRevision: Number(project.manifestRevision || 0) };
}

export function getCanonicalArtifact(project, artifactId) {
  if (!project?.canonicalArtifacts || typeof artifactId !== 'string') return null;
  return project.canonicalArtifacts[artifactId] || null;
}

export function listCanonicalArtifacts(project) {
  if (!project?.canonicalArtifacts) return [];
  return Object.values(project.canonicalArtifacts);
}

function isValidRecord(record) {
  return Boolean(
    record &&
    typeof record === 'object' &&
    typeof record.artifactId === 'string' && record.artifactId &&
    typeof record.relativePath === 'string' && record.relativePath &&
    typeof record.sha256 === 'string' && record.sha256,
  );
}

function isSameOwnership(existing, incoming) {
  return (existing.taskId || null) === (incoming.taskId || null)
    && (existing.runId || null) === (incoming.runId || null);
}
