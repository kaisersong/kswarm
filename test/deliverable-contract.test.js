/**
 * KSwarm — concrete deliverable validation tests
 *
 * Run: node test/deliverable-contract.test.js
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateDeliverableContract } from '../src/core/deliverable-contract.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'kswarm-deliverable-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('hard pptx requirement rejects markdown-only artifacts', () => withTempDir((dir) => {
  const mdPath = join(dir, 'report.md');
  writeFileSync(mdPath, '# Report\n\ncontent', 'utf-8');

  const validation = validateDeliverableContract({
    requiredOutputs: [{ type: 'pptx', enforcement: 'hard' }],
    artifacts: [{ filename: 'report.md', path: mdPath, mimeType: 'text/markdown' }],
  });

  assert.equal(validation.ok, false);
  assert.equal(validation.failureClass, 'artifact_type_mismatch');
  assert.deepEqual(validation.missing, ['pptx']);
}));

test('hard pptx requirement rejects fake pptx files that are not parseable OOXML packages', () => withTempDir((dir) => {
  const fakePath = join(dir, 'deck.pptx');
  writeFileSync(fakePath, '# Not a real pptx\n', 'utf-8');

  const validation = validateDeliverableContract({
    requiredOutputs: [{ type: 'pptx', enforcement: 'hard' }],
    artifacts: [{ filename: 'deck.pptx', path: fakePath }],
  });

  assert.equal(validation.ok, false);
  assert.equal(validation.failureClass, 'artifact_invalid');
  assert.match(validation.errors.join('\n'), /pptx.*invalid/i);
}));

test('hard pptx requirement accepts a minimal parseable pptx package marker', () => withTempDir((dir) => {
  const pptxPath = join(dir, 'deck.pptx');
  const content = Buffer.concat([
    Buffer.from('PK\u0003\u0004', 'binary'),
    Buffer.from('[Content_Types].xml'),
    Buffer.from('ppt/presentation.xml'),
  ]);
  writeFileSync(pptxPath, content);

  const validation = validateDeliverableContract({
    requiredOutputs: [{ type: 'pptx', enforcement: 'hard' }],
    artifacts: [{ filename: 'deck.pptx', path: pptxPath }],
  });

  assert.equal(validation.ok, true);
}));

test('soft presentation content requirement does not reject markdown artifacts', () => withTempDir((dir) => {
  const mdPath = join(dir, 'slides.md');
  writeFileSync(mdPath, '# Slide 1\n\n- Point', 'utf-8');

  const validation = validateDeliverableContract({
    requiredOutputs: [{ type: 'presentation_content', enforcement: 'soft' }],
    artifacts: [{ filename: 'slides.md', path: mdPath }],
  });

  assert.equal(validation.ok, true);
}));

let passed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    passed++;
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(err);
    process.exitCode = 1;
    break;
  }
}
if (process.exitCode !== 1) {
  console.log(`\n${passed}/${tests.length} deliverable contract tests passed`);
}
