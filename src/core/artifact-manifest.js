import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const MIME_TYPES = {
  '.html': 'text/html',
  '.htm': 'text/html',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

export function buildArtifactManifest(projectWorkspace, refs = [], defaults = {}) {
  const artifactsRoot = join(projectWorkspace, 'artifacts');
  return refs.map(ref => buildSingleArtifactManifest(artifactsRoot, ref, defaults));
}

export function buildSingleArtifactManifest(artifactsRoot, ref, defaults = {}) {
  const resolved = resolveArtifactFile(artifactsRoot, ref);
  const stat = statSync(resolved.realPath);
  if (!stat.isFile()) throw new Error(`artifact_missing: ${resolved.input}`);

  const content = readFileSync(resolved.realPath);
  const ext = extname(resolved.filename).toLowerCase();
  const relativePath = `artifacts/${resolved.relativeFromArtifacts}`;
  const projectId = defaults.projectId || objectValue(ref, 'projectId');
  const taskId = defaults.taskId || objectValue(ref, 'taskId');
  const role = defaults.role || objectValue(ref, 'role') || 'primary';
  const producedBy = defaults.producedBy || objectValue(ref, 'producedBy') || undefined;

  const manifest = {
    artifactId: defaults.artifactId || objectValue(ref, 'artifactId') || stableArtifactId(projectId, taskId, relativePath, content),
    filename: resolved.filename,
    path: relativePath,
    relativePath,
    mimeType: objectValue(ref, 'mimeType') || MIME_TYPES[ext] || 'application/octet-stream',
    size: stat.size,
    sha256: createHash('sha256').update(content).digest('hex'),
    generatedAt: stat.mtimeMs,
    role,
  };
  if (projectId) manifest.projectId = projectId;
  if (taskId) manifest.taskId = taskId;
  if (producedBy) manifest.producedBy = producedBy;
  if (objectValue(ref, 'summary')) manifest.summary = objectValue(ref, 'summary');
  if (projectId) manifest.url = `/projects/${projectId}/artifacts/${encodeArtifactPath(resolved.relativeFromArtifacts)}`;
  return manifest;
}

export function resolveArtifactFile(artifactsRoot, ref) {
  const input = artifactPathInput(ref);
  if (!input) throw new Error('artifact_missing: empty_path');
  if (input.includes('\0')) throw new Error(`artifact_path_escape: ${input}`);
  if (!existsSync(artifactsRoot)) throw new Error(`artifact_missing: artifacts_dir`);

  const rootRealPath = realpathSync(artifactsRoot);
  const normalized = input.replace(/\\/g, '/');
  const relativeInput = normalized.startsWith('artifacts/')
    ? normalized.slice('artifacts/'.length)
    : normalized;
  const candidate = isAbsolute(normalized)
    ? resolve(normalized)
    : resolve(rootRealPath, relativeInput);

  if (!isPathInside(rootRealPath, candidate)) {
    throw new Error(`artifact_path_escape: ${input}`);
  }

  let realPath;
  try {
    realPath = realpathSync(candidate);
  } catch {
    throw new Error(`artifact_missing: ${input}`);
  }
  if (!isPathInside(rootRealPath, realPath)) {
    throw new Error(`artifact_path_escape: ${input}`);
  }

  const relativeFromArtifacts = relative(rootRealPath, realPath).split(sep).join('/');
  return {
    input,
    realPath,
    filename: basename(realPath),
    relativeFromArtifacts,
  };
}

export function selectReviewArtifacts({
  submittedArtifacts = [],
  availableArtifacts = [],
  taskId = '',
  taskLocalId = '',
  taskTitle = '',
} = {}) {
  const submitted = normalizeArtifactList(submittedArtifacts);
  const available = normalizeArtifactList(availableArtifacts);
  const submittedKeys = new Set(submitted.flatMap(artifactKeys).filter(Boolean));

  if (submittedKeys.size > 0) {
    const selected = [];
    for (const submittedArtifact of submitted) {
      const keys = new Set(artifactKeys(submittedArtifact));
      const availableMatch = available.find(artifact => artifactKeys(artifact).some(key => keys.has(key)));
      selected.push({
        ...(availableMatch || submittedArtifact),
        selectionReason: 'submitted_manifest',
      });
    }
    return dedupeArtifacts(selected);
  }

  const legacyNeedles = [
    String(taskId || ''),
    String(taskLocalId || ''),
    String(taskTitle || '').replace(/\s+/g, '-'),
  ].filter(Boolean);
  return available
    .filter(artifact => {
      const filename = String(artifact.filename || '');
      return legacyNeedles.some(needle => filename.includes(needle));
    })
    .map(artifact => ({
      ...artifact,
      source: 'imported_legacy',
      selectionReason: 'legacy_filename_match',
    }));
}

function artifactPathInput(ref) {
  if (typeof ref === 'string') return ref.trim();
  if (!ref || typeof ref !== 'object') return '';
  return String(ref.artifactPath || ref.relativePath || ref.path || ref.filename || '').trim();
}

function objectValue(ref, key) {
  return ref && typeof ref === 'object' ? ref[key] : undefined;
}

function normalizeArtifactList(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map(item => (typeof item === 'string' ? { filename: item } : item))
    .filter(item => item && typeof item === 'object');
}

function artifactKeys(artifact) {
  const rawValues = [
    artifact.filename,
    artifact.name,
    artifact.relativePath,
    artifact.path,
    artifact.url,
  ].filter(Boolean).map(value => String(value));
  const keys = new Set();
  for (const value of rawValues) {
    const noQuery = value.split(/[?#]/, 1)[0] || '';
    keys.add(noQuery);
    keys.add(basename(noQuery));
    if (noQuery.startsWith('artifacts/')) keys.add(noQuery.slice('artifacts/'.length));
  }
  return [...keys].filter(Boolean);
}

function dedupeArtifacts(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const key = artifactKeys(item)[0] || JSON.stringify(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function isPathInside(root, target) {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function stableArtifactId(projectId, taskId, relativePath, content) {
  return createHash('sha256')
    .update([projectId || '', taskId || '', relativePath, createHash('sha256').update(content).digest('hex')].join('\0'))
    .digest('hex')
    .slice(0, 16);
}

function encodeArtifactPath(path) {
  return String(path).split('/').map(encodeURIComponent).join('/');
}
