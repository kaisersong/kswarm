import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';

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
  return readdirSync(artifactsDir).map(filename => {
    const filePath = join(artifactsDir, filename);
    const stat = statSync(filePath);
    const ext = extname(filename);
    return createArtifactRecord({
      filename,
      url: `/projects/${projectId}/artifacts/${filename}`,
      path: filePath,
      previewable: getPreviewable(ext),
      mimeType: mimeTypes[ext] || 'application/octet-stream',
      generatedAt: stat.mtimeMs,
      size: stat.size,
    });
  });
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
