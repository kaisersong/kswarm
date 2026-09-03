/**
 * KSwarm — checks-v2.js unit tests
 *
 * 设计依据：design §5.2 确定性检查
 *
 * Run: node test/checks-v2.test.js
 */

import assert from 'node:assert/strict';
import { buildChecksV2, validateChecksV2Shape, CHECK_KINDS, CHECK_VERDICTS } from '../src/core/checks-v2.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function validCheck(overrides = {}) {
  return {
    id: 'check-1',
    kind: 'sha256',
    subjectArtifactId: 'artifact-1',
    boundSha256: 'abc123',
    verdict: 'passed',
    reasonCode: 'hash_matched',
    ...overrides,
  };
}

test('buildChecksV2 constructs a valid record with the frozen schema shape', () => {
  const record = buildChecksV2({
    taskId: 'task-1',
    runId: 'run-1',
    subjectArtifacts: [{ artifactId: 'a1', sha256: 'hash1' }],
    checks: [validCheck()],
  });
  assert.equal(record.schemaVersion, 'checks-v2');
  assert.equal(record.taskId, 'task-1');
  assert.equal(record.runId, 'run-1');
  assert.deepEqual(record.subjectArtifacts, [{ artifactId: 'a1', sha256: 'hash1' }]);
  assert.equal(record.checks.length, 1);
  assert.ok(record.createdAt);
});

test('buildChecksV2 requires taskId and runId', () => {
  assert.throws(() => buildChecksV2({ runId: 'r1', subjectArtifacts: [{ artifactId: 'a', sha256: 'h' }] }), /taskId_required/);
  assert.throws(() => buildChecksV2({ taskId: 't1', subjectArtifacts: [{ artifactId: 'a', sha256: 'h' }] }), /runId_required/);
});

test('buildChecksV2 requires at least one subjectArtifact with artifactId and sha256', () => {
  assert.throws(() => buildChecksV2({ taskId: 't1', runId: 'r1', subjectArtifacts: [] }), /subjectArtifacts_required/);
  assert.throws(() => buildChecksV2({ taskId: 't1', runId: 'r1', subjectArtifacts: [{ artifactId: 'a1' }] }), /subjectArtifacts_entry_invalid/);
});

test('buildChecksV2 rejects an unknown check kind', () => {
  assert.throws(
    () => buildChecksV2({
      taskId: 't1', runId: 'r1',
      subjectArtifacts: [{ artifactId: 'a1', sha256: 'h1' }],
      checks: [validCheck({ kind: 'made_up_kind' })],
    }),
    /check_kind_invalid/,
  );
});

test('buildChecksV2 rejects an unknown verdict', () => {
  assert.throws(
    () => buildChecksV2({
      taskId: 't1', runId: 'r1',
      subjectArtifacts: [{ artifactId: 'a1', sha256: 'h1' }],
      checks: [validCheck({ verdict: 'ok' })],
    }),
    /check_verdict_invalid/,
  );
});

test('CHECK_KINDS and CHECK_VERDICTS match the frozen design §5.2 enumerations', () => {
  assert.deepEqual([...CHECK_KINDS], ['sha256', 'forbidden_text', 'link_structure', 'media_parse', 'manifest_coverage']);
  assert.deepEqual([...CHECK_VERDICTS], ['passed', 'blocked', 'waiting_for_evidence']);
});

test('validateChecksV2Shape accepts a well-formed record', () => {
  const record = buildChecksV2({
    taskId: 't1', runId: 'r1',
    subjectArtifacts: [{ artifactId: 'a1', sha256: 'h1' }],
    checks: [validCheck()],
  });
  const result = validateChecksV2Shape(record);
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test('validateChecksV2Shape fails closed on a non-object', () => {
  assert.equal(validateChecksV2Shape(null).ok, false);
  assert.equal(validateChecksV2Shape('not an object').ok, false);
  assert.equal(validateChecksV2Shape([1, 2, 3]).ok, false);
});

test('validateChecksV2Shape fails closed on a mismatched schemaVersion (e.g. a v1 record)', () => {
  const result = validateChecksV2Shape({ schemaVersion: 'checks-v1', taskId: 't1', runId: 'r1', subjectArtifacts: [{ artifactId: 'a', sha256: 'h' }], checks: [] });
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes('schemaVersion_mismatch'));
});

test('validateChecksV2Shape fails closed when checks contains a malformed entry', () => {
  const result = validateChecksV2Shape({
    schemaVersion: 'checks-v2',
    taskId: 't1',
    runId: 'r1',
    subjectArtifacts: [{ artifactId: 'a1', sha256: 'h1' }],
    checks: [{ id: 'c1', kind: 'sha256' /* missing subjectArtifactId, boundSha256, verdict, reasonCode */ }],
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.startsWith('checks_entry_invalid')));
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
console.log(`\n${passed}/${tests.length} checks-v2 tests passed`);
if (passed !== tests.length) process.exitCode = 1;
