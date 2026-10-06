import { readdirSync } from 'node:fs';
import { join, sep } from 'node:path';

/** Read-only artifact enumeration; directory symlinks cannot introduce cycles or foreign files. */
export function listArtifactFilesRecursive(rootDir, relativeDir = '') {
  const results = [];
  for (const entry of readdirSync(relativeDir ? join(rootDir, relativeDir) : rootDir, { withFileTypes: true })) {
    const path = relativeDir ? join(relativeDir, entry.name) : entry.name;
    if (entry.isDirectory()) results.push(...listArtifactFilesRecursive(rootDir, path));
    else if (entry.isFile()) results.push(path.split(sep).join('/'));
  }
  return results;
}
