/**
 * KSwarm — checks-v2 schema（design §5.2 确定性检查）
 *
 * 设计依据：mydocs/xiaok-cli/design/2026-08-31-collaboration-room-evidence-first-execution-and-gate-design.md v8
 *   §5.2 确定性检查
 *
 * 冻结 checks-v2 顶层结构，避免 parser 再次模糊猜测。这是纯数据构造 + 校验
 * 函数集合，不做任何磁盘 I/O、不做业务判定——是否 gate passed 由
 * gate-evaluator.js 消费 ChecksV2 记录做出，本模块只负责结构正确性。
 */

export const CHECKS_V2_SCHEMA_VERSION = 'checks-v2';

export const CHECK_KINDS = Object.freeze([
  'sha256',
  'forbidden_text',
  'link_structure',
  'media_parse',
  'manifest_coverage',
]);

export const CHECK_VERDICTS = Object.freeze(['passed', 'blocked', 'waiting_for_evidence']);

/**
 * @typedef {Object} ChecksV2Check
 * @property {string} id
 * @property {'sha256'|'forbidden_text'|'link_structure'|'media_parse'|'manifest_coverage'} kind
 * @property {string} subjectArtifactId
 * @property {string} boundSha256
 * @property {'passed'|'blocked'|'waiting_for_evidence'} verdict
 * @property {string} reasonCode
 */

/**
 * @typedef {Object} ChecksV2
 * @property {'checks-v2'} schemaVersion
 * @property {string} taskId
 * @property {string} runId
 * @property {Array<{artifactId: string, sha256: string}>} subjectArtifacts
 * @property {ChecksV2Check[]} checks
 * @property {string} createdAt
 */

/**
 * 构造一个结构合法的 ChecksV2 记录。这是唯一的构造入口，防止 caller 各自拼装
 * 出字段名/类型不一致的对象。所有必填字段缺失时抛错（fail loud at construction
 * time，而不是在后续消费时才发现字段缺失）。
 */
export function buildChecksV2({
  taskId,
  runId,
  subjectArtifacts = [],
  checks = [],
  createdAt = new Date().toISOString(),
} = {}) {
  if (!taskId) throw new Error('taskId_required');
  if (!runId) throw new Error('runId_required');
  if (!Array.isArray(subjectArtifacts) || subjectArtifacts.length === 0) {
    throw new Error('subjectArtifacts_required');
  }
  for (const artifact of subjectArtifacts) {
    if (!artifact?.artifactId || !artifact?.sha256) {
      throw new Error('subjectArtifacts_entry_invalid: each entry requires artifactId and sha256');
    }
  }
  if (!Array.isArray(checks)) throw new Error('checks_must_be_array');
  for (const check of checks) {
    validateChecksV2CheckShape(check);
  }

  return {
    schemaVersion: CHECKS_V2_SCHEMA_VERSION,
    taskId,
    runId,
    subjectArtifacts: subjectArtifacts.map(a => ({ artifactId: a.artifactId, sha256: a.sha256 })),
    checks: checks.map(normalizeChecksV2Check),
    createdAt,
  };
}

function validateChecksV2CheckShape(check) {
  if (!check?.id) throw new Error('check_id_required');
  if (!CHECK_KINDS.includes(check.kind)) throw new Error(`check_kind_invalid: ${check?.kind}`);
  if (!check?.subjectArtifactId) throw new Error('check_subjectArtifactId_required');
  if (!check?.boundSha256) throw new Error('check_boundSha256_required');
  if (!CHECK_VERDICTS.includes(check.verdict)) throw new Error(`check_verdict_invalid: ${check?.verdict}`);
  if (!check?.reasonCode) throw new Error('check_reasonCode_required');
}

function normalizeChecksV2Check(check) {
  return {
    id: check.id,
    kind: check.kind,
    subjectArtifactId: check.subjectArtifactId,
    boundSha256: check.boundSha256,
    verdict: check.verdict,
    reasonCode: check.reasonCode,
  };
}

/**
 * 校验一份任意来源（例如从磁盘 JSON.parse 得到）的对象是否是结构合法的
 * ChecksV2 记录。与 buildChecksV2 不同，这个函数不抛错，返回
 * { ok, errors } —— 用于 gate 解析路径：schema 不合法时 fail closed，
 * 不能把畸形数据当作有效的 checks 记录消费。
 */
export function validateChecksV2Shape(candidate) {
  const errors = [];
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return { ok: false, errors: ['not_an_object'] };
  }
  if (candidate.schemaVersion !== CHECKS_V2_SCHEMA_VERSION) errors.push('schemaVersion_mismatch');
  if (!candidate.taskId) errors.push('taskId_missing');
  if (!candidate.runId) errors.push('runId_missing');
  if (!Array.isArray(candidate.subjectArtifacts) || candidate.subjectArtifacts.length === 0) {
    errors.push('subjectArtifacts_missing_or_empty');
  } else {
    for (const artifact of candidate.subjectArtifacts) {
      if (!artifact?.artifactId || !artifact?.sha256) {
        errors.push('subjectArtifacts_entry_invalid');
        break;
      }
    }
  }
  if (!Array.isArray(candidate.checks)) {
    errors.push('checks_not_array');
  } else {
    for (const check of candidate.checks) {
      try {
        validateChecksV2CheckShape(check);
      } catch (err) {
        errors.push(`checks_entry_invalid: ${err.message}`);
        break;
      }
    }
  }
  return { ok: errors.length === 0, errors };
}
