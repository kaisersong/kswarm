import { existsSync, readFileSync } from 'node:fs';
import { extname, isAbsolute, join } from 'node:path';

const OUTPUT_EXTENSIONS = {
  markdown: new Set(['.md', '.markdown']),
  html: new Set(['.html', '.htm']),
  pptx: new Set(['.pptx']),
};

export function validateDeliverableContract({
  requiredOutputs = [],
  artifacts = [],
  workspacePath = '',
} = {}) {
  const errors = [];
  const missing = [];
  const normalizedArtifacts = normalizeArtifacts(artifacts, workspacePath);

  for (const output of normalizeRequiredOutputs(requiredOutputs)) {
    if (output.enforcement === 'soft') continue;
    const candidates = normalizedArtifacts.filter(artifact => artifactMatchesOutput(artifact, output.type));

    if (candidates.length === 0) {
      errors.push(`missing required output: ${output.type}`);
      missing.push(output.type);
      continue;
    }

    if (output.type === 'pptx') {
      const valid = candidates.some(candidate => isLikelyPptxFile(candidate.path));
      if (!valid) {
        errors.push(`pptx artifact invalid: no parseable OOXML presentation package found`);
      }
    }
  }

  const ok = errors.length === 0;
  return {
    ok,
    errors,
    missing,
    failureClass: ok ? null : missing.length > 0 ? 'artifact_type_mismatch' : 'artifact_invalid',
  };
}

export function isLikelyPptxFile(path) {
  if (!path || !existsSync(path)) return false;
  let buffer;
  try {
    buffer = readFileSync(path);
  } catch {
    return false;
  }
  if (buffer.length < 4) return false;
  if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) return false;

  const text = buffer.toString('latin1');
  return text.includes('[Content_Types].xml') && text.includes('ppt/presentation.xml');
}

function normalizeRequiredOutputs(outputs = []) {
  if (!Array.isArray(outputs)) return [];
  return outputs
    .map(output => {
      if (typeof output === 'string') return { type: output, enforcement: 'hard' };
      return {
        type: output?.type || output?.format || output?.kind || '',
        enforcement: output?.enforcement || 'hard',
      };
    })
    .map(output => ({
      type: String(output.type || '').trim().toLowerCase(),
      enforcement: String(output.enforcement || 'hard').trim().toLowerCase(),
    }))
    .filter(output => output.type);
}

function normalizeArtifacts(artifacts = [], workspacePath = '') {
  if (!Array.isArray(artifacts)) return [];
  return artifacts
    .map(artifact => {
      if (typeof artifact === 'string') {
        return { filename: artifact, path: resolveArtifactPath(artifact, workspacePath), mimeType: '' };
      }
      const filename = artifact?.filename || artifact?.name || artifact?.relativePath || artifact?.path || '';
      const path = resolveArtifactPath(artifact?.path || artifact?.relativePath || filename, workspacePath);
      return {
        filename,
        path,
        mimeType: artifact?.mimeType || '',
      };
    })
    .filter(artifact => artifact.filename || artifact.path);
}

function resolveArtifactPath(path, workspacePath) {
  if (!path) return '';
  if (isAbsolute(path)) return path;
  if (!workspacePath) return path;
  return join(workspacePath, path);
}

function artifactMatchesOutput(artifact, type) {
  const ext = extname(artifact.filename || artifact.path || '').toLowerCase();
  const expected = OUTPUT_EXTENSIONS[type];
  if (expected) return expected.has(ext);
  return false;
}
