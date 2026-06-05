/**
 * Dynamic workflow script source normalize/hash tests.
 *
 * R1 (highest risk): kswarm (pure node) and desktop (TS contract) each have
 * their own normalize/hash implementation. They MUST stay byte-for-byte
 * identical or resume hash matching breaks forever. These shared vectors are
 * duplicated verbatim in the desktop contract test to lock both sides together.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  normalizeWorkflowScript,
  hashWorkflowScript,
  normalizeAndHashWorkflowScript,
} from '../src/core/workflow-script-source.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// SHARED VECTORS — keep identical in
// xiaok-cli/desktop/tests/main/workflow-script-contract-source.test.ts
const SHARED_VECTORS = [
  {
    label: 'plain script',
    input: 'export const meta = { name: "demo" };\nphase("scan");',
    normalized: 'export const meta = { name: "demo" };\nphase("scan");',
  },
  {
    label: 'leading/trailing whitespace trimmed',
    input: '\n\n  export const meta = { name: "demo" };  \n\n',
    normalized: 'export const meta = { name: "demo" };',
  },
  {
    label: 'js fenced block stripped',
    input: '```js\nexport const meta = { name: "demo" };\nphase("scan");\n```',
    normalized: 'export const meta = { name: "demo" };\nphase("scan");',
  },
  {
    label: 'javascript fenced block stripped',
    input: '```javascript\nexport const meta = { name: "demo" };\n```',
    normalized: 'export const meta = { name: "demo" };',
  },
  {
    label: 'bare fenced block stripped',
    input: '```\nexport const meta = { name: "demo" };\n```',
    normalized: 'export const meta = { name: "demo" };',
  },
];

test('normalizeWorkflowScript matches shared vectors', () => {
  for (const vector of SHARED_VECTORS) {
    assert.equal(normalizeWorkflowScript(vector.input), vector.normalized, vector.label);
  }
});

test('hashWorkflowScript equals sha256 of normalized source for shared vectors', () => {
  for (const vector of SHARED_VECTORS) {
    const expected = createHash('sha256').update(vector.normalized).digest('hex');
    assert.equal(hashWorkflowScript(vector.normalized), expected, vector.label);
  }
});

test('normalizeAndHashWorkflowScript returns normalized source plus its hash', () => {
  for (const vector of SHARED_VECTORS) {
    const result = normalizeAndHashWorkflowScript(vector.input);
    assert.equal(result.source, vector.normalized, vector.label);
    assert.equal(result.scriptHash, hashWorkflowScript(vector.normalized), vector.label);
  }
});

test('fenced and unfenced equivalents hash identically', () => {
  const fenced = '```js\nexport const meta = { name: "demo" };\nphase("scan");\n```';
  const unfenced = 'export const meta = { name: "demo" };\nphase("scan");';
  assert.equal(
    normalizeAndHashWorkflowScript(fenced).scriptHash,
    normalizeAndHashWorkflowScript(unfenced).scriptHash,
  );
});

test('non-string input throws workflow_script_required', () => {
  assert.throws(() => normalizeWorkflowScript(null), err => err.code === 'workflow_script_required');
  assert.throws(() => normalizeWorkflowScript(42), err => err.code === 'workflow_script_required');
});

let passed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    passed += 1;
    console.log(`\u2713 ${name}`);
  } catch (error) {
    console.error(`\u2717 ${name}`);
    console.error(error);
    process.exitCode = 1;
  }
}
console.log(`\n${passed}/${tests.length} workflow script source tests passed`);
