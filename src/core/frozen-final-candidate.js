/**
 * KSwarm — freezeFinalCandidateArtifact（design §8.1.1 / §10.5）
 *
 * 设计依据：mydocs/xiaok-cli/design/2026-08-31-collaboration-room-evidence-first-execution-and-gate-design.md v8
 *   §8.1.1 —— "把同一 bytes 原子写入 project 内 write-once、content-addressed
 *   的 frozen candidate（临时文件 → fsync → rename → reopen rehash），为其
 *   注册新的 canonical artifact version。FinalDeliverable、checks、snapshot
 *   和 approval 全部绑定 frozen artifact ID/hash，不再绑定可变工作文件路径。
 *   工作文件之后变化只能产生新 candidate/version，不能改变已批准 bytes。"
 *
 * 本模块只负责"读取源文件字节 → 原子写入 content-addressed frozen 副本 →
 * reopen 重新计算 hash 校验一致性"这一步 I/O，不做业务判定（是否可以批准是
 * evaluatePreApprovalPrerequisites 的职责，本模块产出的 frozen artifact 信息
 * 是它的输入之一）。frozen 文件按 sha256 命名，天然 write-once + 幂等：同一内容
 * 的重复调用会命中已存在文件，不重写、不报错。
 */

import {
  existsSync,
  mkdirSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  renameSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { isAbsolute, join, relative, resolve } from 'node:path';

const FROZEN_DIR_NAME = 'frozen';

/**
 * @param {Object} params
 * @param {string} params.workspaceRoot 项目工作区根目录（frozen/ 目录会创建在它内部）
 * @param {string} params.sourcePath 待冻结的工作文件绝对路径（必须落在 workspaceRoot 内）
 * @param {string} [params.projectId]
 * @param {string} [params.deliverableId]
 * @returns {{ ok: boolean, frozen?: { sha256: string, absolutePath: string, relativePath: string, size: number }, error?: string }}
 */
export function freezeFinalCandidateArtifact({ workspaceRoot, sourcePath, projectId = null, deliverableId = null } = {}) {
  if (!workspaceRoot || typeof workspaceRoot !== 'string') {
    return { ok: false, error: 'workspace_root_required' };
  }
  if (!sourcePath || typeof sourcePath !== 'string') {
    return { ok: false, error: 'source_path_required' };
  }

  let workspaceRealPath;
  try {
    workspaceRealPath = realpathSync(resolve(workspaceRoot));
  } catch {
    return { ok: false, error: 'workspace_root_missing' };
  }

  const resolvedSource = isAbsolute(sourcePath) ? resolve(sourcePath) : resolve(workspaceRealPath, sourcePath);
  if (!existsSync(resolvedSource)) {
    return { ok: false, error: 'source_artifact_missing' };
  }

  let sourceRealPath;
  try {
    sourceRealPath = realpathSync(resolvedSource);
  } catch {
    return { ok: false, error: 'source_artifact_missing' };
  }

  const relOfSource = relative(workspaceRealPath, sourceRealPath);
  if (!relOfSource || relOfSource.startsWith('..') || isAbsolute(relOfSource)) {
    return { ok: false, error: 'source_path_escape' };
  }

  let stat;
  try {
    stat = statSync(sourceRealPath);
  } catch {
    return { ok: false, error: 'source_artifact_missing' };
  }
  if (!stat.isFile()) {
    return { ok: false, error: 'source_not_a_file' };
  }

  let bytes;
  try {
    bytes = readFileSync(sourceRealPath);
  } catch {
    return { ok: false, error: 'source_read_failed' };
  }

  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const frozenDir = join(workspaceRealPath, FROZEN_DIR_NAME);
  try {
    mkdirSync(frozenDir, { recursive: true });
  } catch {
    return { ok: false, error: 'frozen_dir_create_failed' };
  }

  const frozenFileName = `${sha256}.bin`;
  const frozenAbsolutePath = join(frozenDir, frozenFileName);

  // write-once + 幂等：如果 content-addressed 目标已经存在，说明这份 bytes
  // 之前已经被冻结过（可能是同一次批准重试，也可能是巧合的内容重复），
  // 直接 reopen rehash 校验一次，不重复写入（避免不必要的 fsync I/O，也避免
  // 覆盖掉可能正被其它并发读者打开的既有 frozen 文件）。
  if (existsSync(frozenAbsolutePath)) {
    const verify = reopenAndRehash(frozenAbsolutePath, sha256);
    if (!verify.ok) return verify;
    return buildResult({ workspaceRealPath, frozenAbsolutePath, sha256, size: stat.size });
  }

  // 原子写入：临时文件（同目录，避免跨文件系统 rename 退化为拷贝）→ fsync
  // （确保内容真正落盘，不止是页缓存）→ rename（POSIX 保证同目录内 rename
  // 是原子操作，不会出现"写了一半就被读到"的中间态）。
  const tmpFileName = `.tmp-${sha256}-${randomBytes(6).toString('hex')}`;
  const tmpPath = join(frozenDir, tmpFileName);
  let fd;
  try {
    fd = openSync(tmpPath, 'wx');
    writeSync(fd, bytes);
    fsyncSync(fd);
  } catch (err) {
    try { if (fd !== undefined) closeSync(fd); } catch { /* best effort */ }
    try { unlinkSync(tmpPath); } catch { /* best effort */ }
    return { ok: false, error: 'frozen_write_failed', detail: String(err?.message || err) };
  }
  try {
    closeSync(fd);
  } catch { /* already closed on error path above */ }

  try {
    renameSync(tmpPath, frozenAbsolutePath);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch { /* best effort */ }
    // 并发场景下，另一个调用者可能已经在我们 rename 之前完成了同样内容的
    // 写入（同一 sha256 文件名）；这不是失败，是 write-once 语义下的正常
    // 竞态结果，reopen rehash 校验通过即可。
    if (existsSync(frozenAbsolutePath)) {
      const verify = reopenAndRehash(frozenAbsolutePath, sha256);
      if (verify.ok) return buildResult({ workspaceRealPath, frozenAbsolutePath, sha256, size: stat.size });
    }
    return { ok: false, error: 'frozen_rename_failed', detail: String(err?.message || err) };
  }

  // reopen rehash：rename 完成后重新打开文件、重新计算 hash，确保落盘内容
  // 确实等于我们期望写入的 bytes（防止极端情况下的静默 I/O 损坏）。
  const verify = reopenAndRehash(frozenAbsolutePath, sha256);
  if (!verify.ok) return verify;

  return buildResult({ workspaceRealPath, frozenAbsolutePath, sha256, size: stat.size, projectId, deliverableId });
}

function reopenAndRehash(absolutePath, expectedSha256) {
  let content;
  try {
    content = readFileSync(absolutePath);
  } catch (err) {
    return { ok: false, error: 'frozen_reopen_failed', detail: String(err?.message || err) };
  }
  const actualSha256 = createHash('sha256').update(content).digest('hex');
  if (actualSha256 !== expectedSha256) {
    return { ok: false, error: 'frozen_rehash_mismatch', expectedSha256, actualSha256 };
  }
  return { ok: true };
}

function buildResult({ workspaceRealPath, frozenAbsolutePath, sha256, size }) {
  return {
    ok: true,
    frozen: {
      sha256,
      absolutePath: frozenAbsolutePath,
      relativePath: relative(workspaceRealPath, frozenAbsolutePath),
      size,
    },
  };
}
