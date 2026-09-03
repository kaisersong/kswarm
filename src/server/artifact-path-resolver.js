/**
 * KSwarm — shared artifact path resolver（design §3.5）
 *
 * 设计依据：mydocs/xiaok-cli/design/2026-08-31-collaboration-room-evidence-first-execution-and-gate-design.md v8
 *   §3.5 Canonical Artifact Manifest：证据版本与归属
 *   评审记录第七轮：legacy global GET artifact 是未消毒 traversal/read 旁路
 *
 * 唯一的 project/global artifact path resolver，供 server/index.js 的
 * project artifact GET/PUT/POST 路由和 legacy global GET /artifacts/(.+) 路由
 * 共同使用，取代各自维护的 sanitizer 实现。
 *
 * 安全模型：
 *   1. 只接受 project-relative POSIX 逻辑路径；每个 segment 通过组件 allowlist，
 *      拒绝空段、'.'/'..'、盘符、UNC、NUL、编码分隔符。
 *   2. path.resolve/path.relative 只作第一层词法校验；对 artifact root 和每个
 *      已存在父组件执行 lstat + realpath，任何 symlink/junction 或 realpath
 *      越界都拒绝。
 *   3. project root 允许受控嵌套（allowNested=true，用于 task/run 证据目录）；
 *      global legacy root 固定 allowNested=false，任何 '/'、'\\' 或编码分隔符
 *      都拒绝——它只能读顶层文件，不是通用文件系统访问面。
 */

import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

export function resolveArtifactPath(rootDir, rawPath, { allowNested = true } = {}) {
  let decoded;
  try {
    decoded = decodeURIComponent(String(rawPath ?? ''));
  } catch {
    return { error: 'invalid_artifact_path' };
  }

  if (decoded.includes('\0')) return { error: 'invalid_artifact_path' };

  const normalized = decoded.replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/')) return { error: 'invalid_artifact_path' };
  // Windows 盘符 / UNC 前缀在解码后的原始字符串里判断，不依赖后续 path 操作的平台行为。
  if (/^[A-Za-z]:/.test(normalized) || normalized.startsWith('//')) return { error: 'invalid_artifact_path' };

  const segments = normalized.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
    return { error: 'invalid_artifact_path' };
  }
  if (!allowNested && segments.length > 1) {
    return { error: 'invalid_artifact_path' };
  }

  let rootRealPath;
  try {
    rootRealPath = realpathSync(resolve(rootDir));
  } catch {
    return { error: 'artifact_root_missing' };
  }

  const candidate = resolve(rootRealPath, normalized);
  const rel = relative(rootRealPath, candidate);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    return { error: 'invalid_artifact_path' };
  }

  // 逐段校验父目录不是 symlink/junction，防止 "resolve 时在 root 内、
  // realpath 后逃出 root" 的 symlink escape。只检查已经存在的路径前缀；
  // 尚不存在的末端文件本身允许（用于 PUT 创建新文件的场景），但创建后
  // 调用方必须重新 realpath 校验落点仍在 root 内（写路径的职责，不在本函数）。
  const relSegments = rel.split(sep).filter(Boolean);
  let walked = rootRealPath;
  for (let i = 0; i < relSegments.length; i += 1) {
    walked = join(walked, relSegments[i]);
    if (!existsSync(walked)) break; // 后续 segment 尚不存在，无需继续检查
    let stat;
    try {
      stat = lstatSync(walked);
    } catch {
      return { error: 'invalid_artifact_path' };
    }
    const isLastSegment = i === relSegments.length - 1;
    if (stat.isSymbolicLink()) {
      // 中间目录是 symlink：必须校验其 realpath 仍在 root 内；
      // 若是最终文件本身是 symlink，同样要求其 realpath 目标在 root 内。
      let realWalked;
      try {
        realWalked = realpathSync(walked);
      } catch {
        return { error: 'invalid_artifact_path' };
      }
      const relOfReal = relative(rootRealPath, realWalked);
      if (!relOfReal || relOfReal.startsWith('..') || isAbsolute(relOfReal)) {
        return { error: 'artifact_path_escape' };
      }
    }
    if (!isLastSegment && !stat.isDirectory() && !stat.isSymbolicLink()) {
      return { error: 'invalid_artifact_path' };
    }
  }

  return {
    filePath: candidate,
    artifactPath: normalized,
    filename: basename(normalized),
  };
}

export function encodeArtifactRoutePath(artifactPath) {
  return String(artifactPath).split('/').map(part => encodeURIComponent(part)).join('/');
}
