import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, join, sep } from 'node:path';

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
function listArtifactFilesRecursive(rootDir, relativeDir = '') {
  const currentDir = relativeDir ? join(rootDir, relativeDir) : rootDir;
  const entries = readdirSync(currentDir, { withFileTypes: true });
  const results = [];
  for (const entry of entries) {
    const entryRelativePath = relativeDir ? join(relativeDir, entry.name) : entry.name;
    if (entry.isDirectory()) {
      results.push(...listArtifactFilesRecursive(rootDir, entryRelativePath));
    } else if (entry.isFile()) {
      results.push(entryRelativePath.split(sep).join('/'));
    }
  }
  return results;
}

function encodeArtifactRelativePath(relativePath) {
  return relativePath.split('/').map(part => encodeURIComponent(part)).join('/');
}

export function enrichArtifactRecordFromFile({ artifact, artifactsDir, getPreviewable, mimeTypes }) {
  if (!artifact || typeof artifact !== 'object') return artifact;
  const filename = artifactFilename(artifact);
  if (!filename) return artifact;
  const filePath = join(artifactsDir, filename);
  if (!existsSync(filePath)) return artifact;

  const stat = statSync(filePath);
  const ext = extname(filename);
  const generatedAt = stat.mtimeMs;
  return {
    ...artifact,
    filename: artifact.filename || filename,
    path: artifact.path || filePath,
    previewable: artifact.previewable ?? getPreviewable(ext),
    mimeType: artifact.mimeType || mimeTypes[ext] || 'application/octet-stream',
    createdAt: artifact.createdAt ?? generatedAt,
    updatedAt: artifact.updatedAt ?? generatedAt,
    generatedAt: artifact.generatedAt ?? generatedAt,
    size: artifact.size ?? stat.size,
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

function artifactFilename(artifact) {
  const value = artifact.filename || artifact.name || artifact.relativePath || artifact.path || artifact.url || '';
  if (!value) return '';
  const withoutQuery = String(value).split(/[?#]/, 1)[0] || '';
  const name = basename(withoutQuery);
  return name === '.' || name === '..' ? '' : name;
}
