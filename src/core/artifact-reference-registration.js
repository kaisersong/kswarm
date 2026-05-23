import { statSync } from 'node:fs';
import { buildArtifactManifest } from './artifact-manifest.js';

const ARTIFACT_PATH_RE = /\bartifacts\/([^\s`"'<>，。；、/\\][^\s`"'<>，。；、/\\]{0,180}\.[A-Za-z0-9]{1,12})\b/gu;
const ARTIFACT_TOKEN_RE = /\bartifacts\/([^\s`"'<>，。；、]+)/gu;

export function resolveReferencedArtifactsFromOutput({
  workspacePath = '',
  output = '',
  projectId = '',
  taskId = '',
  runStartedAt = 0,
  contentHeavy = false,
  producedBy = undefined,
} = {}) {
  const text = String(output || '');
  const refs = extractLiteralArtifactRefs(text);

  if (refs.length === 0) {
    const invalidPath = findInvalidArtifactPathMention(text);
    if (invalidPath) {
      return failure('declared_artifact_invalid', 'No safe literal artifacts/<filename> path found in output', {
        referencedArtifacts: [invalidPath],
        shouldUseLegacyWrapper: !contentHeavy,
      });
    }
    return {
      ok: true,
      referencedArtifacts: [],
      artifactManifest: [],
      shouldUseLegacyWrapper: true,
    };
  }

  if (!workspacePath) {
    return failure('declared_artifact_missing', 'Cannot resolve referenced artifacts without workspacePath', {
      referencedArtifacts: refs,
      shouldUseLegacyWrapper: false,
    });
  }

  let manifest;
  try {
    manifest = buildArtifactManifest(workspacePath, refs, {
      projectId,
      taskId,
      role: 'primary',
      producedBy,
    });
  } catch (err) {
    const message = String(err?.message || err);
    const failureClass = /artifact_path_escape|invalid/i.test(message)
      ? 'declared_artifact_invalid'
      : 'declared_artifact_missing';
    return failure(failureClass, message, {
      referencedArtifacts: refs,
      shouldUseLegacyWrapper: false,
    });
  }

  const stale = manifest.find(artifact => {
    const path = artifact.absolutePath || artifact.realPath || artifact.path;
    const statPath = path && path.startsWith('artifacts/') ? null : path;
    const generatedAt = Number(artifact.generatedAt || 0);
    if (generatedAt && runStartedAt && generatedAt + 1 < runStartedAt) return true;
    if (!statPath || !runStartedAt) return false;
    try {
      return statSync(statPath).mtimeMs + 1 < runStartedAt;
    } catch {
      return false;
    }
  });

  if (stale) {
    return failure('declared_artifact_stale', `Referenced artifact predates current run: ${stale.filename}`, {
      referencedArtifacts: refs,
      artifactManifest: manifest,
      shouldUseLegacyWrapper: false,
    });
  }

  return {
    ok: true,
    referencedArtifacts: refs,
    artifactManifest: manifest,
    shouldUseLegacyWrapper: false,
  };
}

export function extractLiteralArtifactRefs(output = '') {
  const refs = [];
  const seen = new Set();
  const text = String(output || '');
  for (const match of text.matchAll(ARTIFACT_PATH_RE)) {
    const filename = String(match[1] || '').trim();
    if (!filename || filename.includes('..') || filename.includes('/') || filename.includes('\\')) continue;
    const ref = `artifacts/${filename}`;
    if (seen.has(ref)) continue;
    seen.add(ref);
    refs.push(ref);
  }
  return refs;
}

function findInvalidArtifactPathMention(output = '') {
  const text = String(output || '');
  for (const match of text.matchAll(ARTIFACT_TOKEN_RE)) {
    const token = String(match[1] || '').trim();
    if (!token) continue;
    if (token.includes('..') || token.includes('/') || token.includes('\\')) return `artifacts/${token}`;
    if (/\.[A-Za-z0-9]{1,12}\b/.test(token)) return `artifacts/${token}`;
  }
  return null;
}

function failure(failureClass, error, extras = {}) {
  return {
    ok: false,
    failureClass,
    error,
    referencedArtifacts: extras.referencedArtifacts || [],
    artifactManifest: extras.artifactManifest || [],
    shouldUseLegacyWrapper: extras.shouldUseLegacyWrapper === true,
  };
}
