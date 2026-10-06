import { listArtifactFilesRecursive } from '../core/artifact-files.js';
import { resolveArtifactPath } from './artifact-path-resolver.js';
import { existsSync, statSync } from 'node:fs';
import { extname, join, sep, relative, isAbsolute, win32 } from 'node:path';

export function createArtifactRecord({
  filename,
  url,
  path,
  previewable,
  mimeType,
  generatedAt = Date.now(),
  size,
}) {
  const time = normalizeTime(generatedAt) ?? Date.now();
  const record = {
    filename,
    url,
    path,
    previewable,
    mimeType,
    createdAt: time,
    updatedAt: time,
    generatedAt: time,
  };
  if (typeof size === 'number') record.size = size;
  return record;
}

export function listArtifactRecords({ artifactsDir, projectId, getPreviewable, mimeTypes }) {
  if (!existsSync(artifactsDir)) return [];
  return listArtifactFilesRecursive(artifactsDir).map(relativePath => {
    const filePath = join(artifactsDir, relativePath);
    const stat = statSync(filePath);
    const ext = extname(relativePath);
    // design §3.5：filename/path 必须保留完整相对嵌套路径（例如
    // "tasks/item-1/run-1/review-evidence.json"），禁止用 basename 把
    // canonical manifest 的 task/run 命名空间再次扁平化；顶层扁平文件的
    // relativePath 本身就等于 basename，行为与既有调用方保持一致。
    return createArtifactRecord({
      filename: relativePath,
      url: `/projects/${projectId}/artifacts/${encodeArtifactRelativePath(relativePath)}`,
      path: filePath,
      previewable: getPreviewable(ext),
      mimeType: mimeTypes[ext] || 'application/octet-stream',
      generatedAt: stat.mtimeMs,
      size: stat.size,
    });
  });
}

/**
 * 递归列出 artifactsDir 下所有文件的相对路径（POSIX 分隔符），包含
 * design §3.5 canonical 嵌套路径 `tasks/<task-id>/<run-id>/*`。
 * 不做 containment 校验——输入是已经受信的本地 artifactsDir 根，遍历只读，
 * 不涉及用户可控路径拼接；写入路径的 containment 由 resolveArtifactPath 负责。
 */

function encodeArtifactRelativePath(relativePath) {
  return relativePath.split('/').map(part => encodeURIComponent(part)).join('/');
}

export function enrichArtifactRecordFromFile({ artifact, artifactsDir, projectId, getPreviewable, mimeTypes }) {
  if (!artifact || typeof artifact !== 'object') return artifact;
  let candidate;
  let encoded = false;
  if (artifact.path || artifact.relativePath) {
    const value = String(artifact.path || artifact.relativePath);
    if (isAbsolute(value)) candidate = relative(artifactsDir, value).split(sep).join('/');
    else if (win32.isAbsolute(value)) return artifact;
    else candidate = value.replace(/\\/g, '/').replace(/^artifacts\//, '');
  } else if (artifact.filename || artifact.name) candidate = String(artifact.filename || artifact.name);
  else if (artifact.url) {
    if (!projectId || !String(artifact.url).startsWith(`/projects/${projectId}/artifacts/`)) return artifact;
    candidate = String(artifact.url).split(/[?#]/, 1)[0].split('/artifacts/')[1];
    encoded = true;
  }
  if (!candidate) return artifact;
  const rawPath = encoded ? candidate : candidate.split('/').map(encodeURIComponent).join('/');
  const resolved = resolveArtifactPath(artifactsDir, rawPath, { allowNested: true });
  if (resolved.error || !existsSync(resolved.filePath)) return artifact;
  const filePath = resolved.filePath;
  const filename = resolved.artifactPath;
  const stat = statSync(filePath);
  if (!stat.isFile()) return artifact;

  const ext = extname(filename);
  const generatedAt = stat.mtimeMs;
  return {
    ...artifact,
    filename,
    path: filePath,
    previewable: artifact.previewable ?? getPreviewable(ext),
    mimeType: artifact.mimeType || mimeTypes[ext] || 'application/octet-stream',
    ...(projectId ? { url: `/projects/${projectId}/artifacts/${encodeArtifactRelativePath(filename)}` } : {}),
    createdAt: generatedAt,
    updatedAt: generatedAt,
    generatedAt,
    size: stat.size,
  };
}

function normalizeTime(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}
