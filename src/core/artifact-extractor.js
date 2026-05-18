import { basename, extname } from 'node:path';

const ARTIFACT_BLOCK_RE = /(^|\n)(```|~~~)artifact[^\n]*\bpath\s*=\s*["']?([^"'\n]+)["']?[^\n]*\n([\s\S]*?)\n\2[ \t]*(?=\n|$)/g;
const TRAILING_ARTIFACT_BLOCK_RE = /(^|\n)(```|~~~)artifact[^\n]*\bpath\s*=\s*["']?([^"'\n]+)["']?[^\n]*\n([\s\S]*)$/;

const MIME_TYPES = {
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.xml': 'application/xml',
  '.svg': 'image/svg+xml',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.ts': 'text/typescript',
};

export function extractDeclaredArtifacts(content, { taskId = 'task' } = {}) {
  const text = String(content || '');
  const used = new Set();
  const artifacts = [];
  let index = 0;

  const addArtifact = (rawPath, body) => {
    index += 1;
    const filename = dedupeFilename(sanitizeArtifactFilename(rawPath, { taskId, index }), used);
    artifacts.push({
      filename,
      content: String(body || '').trim(),
      previewable: isPreviewableArtifact(filename),
      mimeType: mimeTypeForArtifact(filename),
    });
  };

  const withoutClosedBlocks = text.replace(ARTIFACT_BLOCK_RE, (match, prefix, fence, rawPath, body) => {
    addArtifact(rawPath, body);
    return prefix ? '\n' : '';
  });

  const cleanedContent = withoutClosedBlocks.replace(TRAILING_ARTIFACT_BLOCK_RE, (match, prefix, fence, rawPath, body) => {
    addArtifact(rawPath, body);
    return prefix ? '\n' : '';
  }).replace(/\n{3,}/g, '\n\n').trim();

  return { cleanedContent, artifacts };
}

export function sanitizeArtifactFilename(rawPath, { taskId = 'task', index = 1 } = {}) {
  let name = basename(String(rawPath || '').trim().replace(/^["']|["']$/g, ''));
  name = name.replace(/^\.+/, '');
  name = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_');
  name = name.replace(/\s+/g, '_');
  name = name.replace(/_+/g, '_');
  name = name.slice(0, 160);
  if (!name || name === '_' || name === '.' || name === '..') {
    return `${taskId}-artifact-${index}.md`;
  }
  return name;
}

export function dedupeFilename(filename, used) {
  if (!used.has(filename)) {
    used.add(filename);
    return filename;
  }
  const ext = extname(filename);
  const stem = ext ? filename.slice(0, -ext.length) : filename;
  let counter = 2;
  while (used.has(`${stem}-${counter}${ext}`)) counter += 1;
  const next = `${stem}-${counter}${ext}`;
  used.add(next);
  return next;
}

export function mimeTypeForArtifact(filename) {
  return MIME_TYPES[extname(filename).toLowerCase()] || 'application/octet-stream';
}

export function isPreviewableArtifact(filename) {
  return ['.md', '.markdown', '.txt', '.json', '.csv', '.html', '.htm', '.xml', '.svg', '.css', '.js', '.ts']
    .includes(extname(filename).toLowerCase());
}
