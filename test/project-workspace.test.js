/**
 * KSwarm project workspace tests
 *
 * Run: node test/project-workspace.test.js
 */

import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getProjectWorkspace, initProjectWorkspace, resolveWorkspacePath, setProjectWorkspace } from '../src/server/project-workspace.js';

const root = join(tmpdir(), `kswarm-workspace-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const projectsDir = join(root, 'projects');

try {
  const workspaces = new Map();
  const customPath = join(root, 'new-workspace', 'nested');

  const ws = initProjectWorkspace(workspaces, projectsDir, 'proj-custom', customPath);

  assert.equal(ws.path, customPath);
  assert.equal(ws.custom, true);
  assert.equal(ws.artifacts, join(customPath, 'artifacts'));
  assert.equal(existsSync(join(customPath, 'artifacts')), true);
  assert.deepEqual(workspaces.get('proj-custom'), ws);
  assert.equal(
    resolveWorkspacePath('~/customer-work', '/Users/tester'),
    join('/Users/tester', 'customer-work')
  );

  const defaultWs = initProjectWorkspace(workspaces, projectsDir, 'proj-default');
  assert.equal(defaultWs.path, join(projectsDir, 'proj-default'));
  assert.equal(defaultWs.custom, false);
  assert.equal(existsSync(join(projectsDir, 'proj-default', 'artifacts')), true);

  const persistedPath = join(root, 'persisted-workspace');
  const restored = getProjectWorkspace(workspaces, projectsDir, 'proj-restored', persistedPath);
  assert.equal(restored.path, persistedPath);
  assert.equal(restored.custom, true);
  assert.equal(existsSync(join(persistedPath, 'artifacts')), true);

  const replacementPath = join(root, 'replacement-workspace');
  const replaced = setProjectWorkspace(workspaces, 'proj-restored', replacementPath);
  assert.equal(replaced.path, replacementPath);
  assert.equal(replaced.custom, true);
  assert.deepEqual(workspaces.get('proj-restored'), replaced);

  console.log('5/5 project workspace tests passed');
} finally {
  rmSync(root, { recursive: true, force: true });
}
