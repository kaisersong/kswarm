/**
 * KSwarm — Artifact evidence extension（design §3.5 Canonical Artifact Manifest）
 *
 * 设计依据：mydocs/xiaok-cli/design/2026-08-31-collaboration-room-evidence-first-execution-and-gate-design.md v8
 *   §3.5 Canonical Artifact Manifest：证据版本与归属
 *
 * 本模块不建第二套 artifact identity —— artifactId/sha256/path/projectId/taskId/producedBy
 * 仍完全由 artifact-manifest.js 的 canonical manifest record 提供。这里只新增：
 *   1. ArtifactEvidenceExtensionV1（外键指向 canonical artifact，附加 evidence 元数据）
 *   2. task/run namespaced path 计算（把新证据写入 artifacts/tasks/<safeTaskId>/<runId>/，
 *      不再默认写根目录 artifacts/search-evidence.json / review-evidence.json）
 *
 * §3.5 约束：safeTaskId / runId 只允许 [A-Za-z0-9._-]，其它字符编码，拒绝 '.'、'..'、
 * Windows reserved names、盘符和路径分隔符。
 */

import { join } from 'node:path';

const WINDOWS_RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

/**
 * 把任意字符串 segment 编码为安全的路径 segment：只保留 [A-Za-z0-9._-]，
 * 其它字符（包括路径分隔符、盘符冒号、NUL）都被百分号编码，杜绝 traversal。
 * 单纯的 '.' 或 '..' 结果、以及 Windows reserved name，会被拒绝并抛错，
 * 而不是静默编码后仍然产生这些危险值。
 */
export function encodePathSegment(rawValue, { label = 'segment' } = {}) {
  const value = String(rawValue ?? '').trim();
  if (!value) throw new Error(`${label}_required`);

  // 驱动字母检测必须在编码之前对原始输入判断：编码会把 ':' 替换成
  // 十六进制转义序列，导致编码后的字符串永远不再包含原始 ':' 字符，
  // 使编码后检测形同虚设。
  if (/^[A-Za-z]:$/.test(value)) {
    throw new Error(`${label}_invalid: drive letter`);
  }

  const encoded = value.replace(/[^A-Za-z0-9._-]/g, (char) => {
    const code = char.codePointAt(0);
    return `_${code.toString(16).padStart(4, '0')}_`;
  });

  if (encoded === '.' || encoded === '..') {
    throw new Error(`${label}_invalid: reserved dot segment`);
  }
  const upper = encoded.toUpperCase().replace(/\.[^.]*$/, '');
  if (WINDOWS_RESERVED_NAMES.has(upper)) {
    throw new Error(`${label}_invalid: windows reserved name`);
  }
  return encoded;
}

/**
 * 计算 task/run namespaced 证据目录：artifacts/tasks/<safeTaskId>/<runId>/
 * 只返回 project-root-relative 的逻辑路径（design §3.5：生产代码只保存
 * project-root-relative path，不向 renderer 或 Room durable event 暴露绝对路径）。
 */
export function buildTaskRunEvidenceDir(taskId, runId) {
  const safeTaskId = encodePathSegment(taskId, { label: 'taskId' });
  const safeRunId = encodePathSegment(runId, { label: 'runId' });
  return join('artifacts', 'tasks', safeTaskId, safeRunId).split('\\').join('/');
}

export function buildTaskRunEvidencePath(taskId, runId, filename) {
  const dir = buildTaskRunEvidenceDir(taskId, runId);
  const safeFilename = String(filename || '').trim();
  if (!safeFilename || safeFilename.includes('/') || safeFilename.includes('\\') || safeFilename.includes('\0')) {
    throw new Error(`filename_invalid: ${filename}`);
  }
  return `${dir}/${safeFilename}`;
}

/**
 * @typedef {Object} ArtifactEvidenceExtensionV1
 * @property {'artifact-evidence-extension-v1'} schemaVersion
 * @property {string} artifactId 外键，指向 canonical artifact-manifest.js 的 manifest record
 * @property {string} runId
 * @property {string} [supersedesArtifactId]
 * @property {string[]} [claimIds]
 * @property {{fetchedAt: string, contentLength?: number, bytesStored: number, truncated: boolean, fetchCompleted: boolean}} [fetch]
 */

/**
 * 构造一个 ArtifactEvidenceExtensionV1 记录。这是纯数据构造函数，不做磁盘 I/O，
 * 不建立第二套 artifact identity —— artifactId 必须是调用方已经从
 * artifact-manifest.js 得到的真实 canonical artifactId。
 */
export function buildArtifactEvidenceExtension({
  artifactId,
  runId,
  supersedesArtifactId = null,
  claimIds = [],
  fetch = null,
} = {}) {
  if (!artifactId) throw new Error('artifactId_required');
  if (!runId) throw new Error('runId_required');
  const extension = {
    schemaVersion: 'artifact-evidence-extension-v1',
    artifactId,
    runId,
  };
  if (supersedesArtifactId) extension.supersedesArtifactId = supersedesArtifactId;
  if (Array.isArray(claimIds) && claimIds.length > 0) extension.claimIds = [...claimIds];
  if (fetch && typeof fetch === 'object') {
    extension.fetch = {
      fetchedAt: fetch.fetchedAt,
      ...(Number.isFinite(fetch.contentLength) ? { contentLength: fetch.contentLength } : {}),
      bytesStored: Number(fetch.bytesStored) || 0,
      truncated: Boolean(fetch.truncated),
      fetchCompleted: Boolean(fetch.fetchCompleted),
    };
  }
  return extension;
}
