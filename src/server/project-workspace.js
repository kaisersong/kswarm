import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export function resolveWorkspacePath(path, homeDir = homedir()) {
  if (typeof path !== 'string') return '';
  const trimmed = path.trim();
  if (trimmed === '~') return homeDir;
  if (trimmed.startsWith('~/')) return join(homeDir, trimmed.slice(2));
  return trimmed;
}

export function initProjectWorkspace(workspaces, projectsDir, projectId, customPath) {
  const requestedPath = resolveWorkspacePath(customPath);
  const wsPath = requestedPath || join(projectsDir, projectId);
  const artifactsPath = join(wsPath, 'artifacts');
  mkdirSync(artifactsPath, { recursive: true });

  const ws = { path: wsPath, artifacts: artifactsPath, custom: Boolean(requestedPath) };
  workspaces.set(projectId, ws);
  return ws;
}

export function setProjectWorkspace(workspaces, projectId, newPath) {
  const wsPath = resolveWorkspacePath(newPath);
  if (!wsPath) throw new Error('workspace path required');

  const artifactsPath = join(wsPath, 'artifacts');
  mkdirSync(artifactsPath, { recursive: true });
  const ws = { path: wsPath, artifacts: artifactsPath, custom: true };
  workspaces.set(projectId, ws);
  return ws;
}
