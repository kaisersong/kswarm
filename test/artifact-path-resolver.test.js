/**
 * KSwarm — artifact-path-resolver.js unit tests
 *
 * 设计依据：design §3.5 Canonical Artifact Manifest；评审记录第七轮
 *   （legacy global GET artifact 是未消毒 traversal/read 旁路）
 *
 * Run: node test/artifact-path-resolver.test.js
 */

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, sep } from 'node:path';
import { resolveArtifactPath } from '../src/server/artifact-path-resolver.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function setupRoot() {
  const root = mkdtempSync(join(tmpdir(), 'kswarm-artifact-root-'));
  mkdirSync(join(root, 'sub'), { recursive: true });
  writeFileSync(join(root, 'file.txt'), 'hello');
  writeFileSync(join(root, 'sub', 'nested.txt'), 'nested');
  return root;
}

function setupOutsideSecret(root) {
  const outside = mkdtempSync(join(tmpdir(), 'kswarm-outside-'));
  writeFileSync(join(outside, 'secret.txt'), 'top secret');
  return outside;
}

// ── Legitimate paths ──────────────────────────────────────────────

test('resolves a top-level file within the root', () => {
  const root = setupRoot();
  const result = resolveArtifactPath(root, 'file.txt');
  assert.equal(result.error, undefined);
  assert.equal(result.filename, 'file.txt');
  rmSync(root, { recursive: true, force: true });
});

test('resolves a nested file within the root when allowNested=true', () => {
  const root = setupRoot();
  const result = resolveArtifactPath(root, 'sub/nested.txt', { allowNested: true });
  assert.equal(result.error, undefined);
  assert.equal(result.filename, 'nested.txt');
  rmSync(root, { recursive: true, force: true });
});

test('rejects a nested path when allowNested=false (legacy global root)', () => {
  const root = setupRoot();
  const result = resolveArtifactPath(root, 'sub/nested.txt', { allowNested: false });
  assert.equal(result.error, 'invalid_artifact_path');
  rmSync(root, { recursive: true, force: true });
});

// ── Traversal attacks ─────────────────────────────────────────────

test('rejects raw ../ traversal', () => {
  const root = setupRoot();
  const result = resolveArtifactPath(root, '../etc/passwd');
  assert.equal(result.error, 'invalid_artifact_path');
  rmSync(root, { recursive: true, force: true });
});

test('rejects deep ../../ traversal', () => {
  const root = setupRoot();
  const result = resolveArtifactPath(root, '../../../../etc/passwd');
  assert.equal(result.error, 'invalid_artifact_path');
  rmSync(root, { recursive: true, force: true });
});

test('rejects URL-encoded ../ traversal', () => {
  const root = setupRoot();
  const result = resolveArtifactPath(root, '..%2F..%2Fetc%2Fpasswd');
  assert.equal(result.error, 'invalid_artifact_path');
  rmSync(root, { recursive: true, force: true });
});

test('rejects double-encoded traversal payloads by treating them as literal filenames, never escaping root', () => {
  const root = setupRoot();
  // %252e%252e decodes once to %2e%2e/escape.txt — a literal segment containing
  // the string "%2e%2e", not a real ".." — so this must resolve to a path that
  // stays strictly inside the (realpath-resolved) root, never outside it.
  // Compare against realpathSync(root) rather than the raw tmpdir path, since
  // on macOS /var is itself a symlink to /private/var and a naive string
  // comparison against the non-realpath'd root would produce a false positive.
  const result = resolveArtifactPath(root, '%252e%252e%2Fescape.txt');
  if (!result.error) {
    const realRoot = realpathSync(root);
    const realFilePathDir = dirname(result.filePath);
    assert.ok(
      realFilePathDir === realRoot || realFilePathDir.startsWith(`${realRoot}${sep}`) || result.filePath.startsWith(root),
      `resolved path must stay inside root: ${result.filePath}`,
    );
  }
  rmSync(root, { recursive: true, force: true });
});

test('rejects backslash-based traversal', () => {
  const root = setupRoot();
  const result = resolveArtifactPath(root, '..\\..\\etc\\passwd');
  assert.equal(result.error, 'invalid_artifact_path');
  rmSync(root, { recursive: true, force: true });
});

test('rejects a leading slash (absolute path)', () => {
  const root = setupRoot();
  const result = resolveArtifactPath(root, '/etc/passwd');
  assert.equal(result.error, 'invalid_artifact_path');
  rmSync(root, { recursive: true, force: true });
});

test('rejects a Windows drive letter path', () => {
  const root = setupRoot();
  const result = resolveArtifactPath(root, 'C:/Windows/System32/config');
  assert.equal(result.error, 'invalid_artifact_path');
  rmSync(root, { recursive: true, force: true });
});

test('rejects a UNC path', () => {
  const root = setupRoot();
  const result = resolveArtifactPath(root, '//server/share/file.txt');
  assert.equal(result.error, 'invalid_artifact_path');
  rmSync(root, { recursive: true, force: true });
});

test('rejects a bare "." segment', () => {
  const root = setupRoot();
  const result = resolveArtifactPath(root, './file.txt');
  assert.equal(result.error, 'invalid_artifact_path');
  rmSync(root, { recursive: true, force: true });
});

test('rejects NUL byte in path', () => {
  const root = setupRoot();
  const result = resolveArtifactPath(root, 'file.txt\0.png');
  assert.equal(result.error, 'invalid_artifact_path');
  rmSync(root, { recursive: true, force: true });
});

test('rejects empty path', () => {
  const root = setupRoot();
  const result = resolveArtifactPath(root, '');
  assert.equal(result.error, 'invalid_artifact_path');
  rmSync(root, { recursive: true, force: true });
});

// ── Symlink escape ────────────────────────────────────────────────

test('rejects a symlinked parent directory that escapes the root', () => {
  const root = setupRoot();
  const outside = setupOutsideSecret(root);
  symlinkSync(outside, join(root, 'escape-link'));
  const result = resolveArtifactPath(root, 'escape-link/secret.txt');
  assert.equal(result.error, 'artifact_path_escape');
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

test('rejects a symlinked file that escapes the root', () => {
  const root = setupRoot();
  const outside = setupOutsideSecret(root);
  symlinkSync(join(outside, 'secret.txt'), join(root, 'linked-secret.txt'));
  const result = resolveArtifactPath(root, 'linked-secret.txt');
  assert.equal(result.error, 'artifact_path_escape');
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

test('allows a symlink that points to a location still inside the root', () => {
  const root = setupRoot();
  symlinkSync(join(root, 'sub'), join(root, 'sub-link'));
  const result = resolveArtifactPath(root, 'sub-link/nested.txt', { allowNested: true });
  assert.equal(result.error, undefined);
  rmSync(root, { recursive: true, force: true });
});

// ── Missing root ──────────────────────────────────────────────────

test('returns artifact_root_missing when the root directory does not exist', () => {
  const result = resolveArtifactPath('/nonexistent/kswarm-root-xyz', 'file.txt');
  assert.equal(result.error, 'artifact_root_missing');
});

let passed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    passed++;
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(err.message || err);
  }
}
console.log(`\n${passed}/${tests.length} artifact-path-resolver tests passed`);
if (passed !== tests.length) process.exitCode = 1;
