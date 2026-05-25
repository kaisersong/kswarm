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

test('report_html requires an existing html deliverable but leaves renderer quality to PO review', () => withTempDir((dir) => {
  const mdPath = join(dir, 'report.md');
  writeFileSync(mdPath, '# Report\n\ncontent', 'utf-8');
  const genericHtmlPath = join(dir, 'generic.html');
  writeFileSync(genericHtmlPath, '<!DOCTYPE html><html><body>' + '正文'.repeat(240) + '</body></html>', 'utf-8');
  const markerOnlyPath = join(dir, 'marker-only.html');
  writeFileSync(markerOnlyPath, '<!DOCTYPE html><html data-template="kai-report-creator"></html>', 'utf-8');
  const reportPath = join(dir, 'report.html');
  writeFileSync(reportPath, '<!DOCTYPE html><html data-template="kai-report-creator"><body>' + '正文'.repeat(240) + '</body></html>', 'utf-8');

  assert.equal(validateDeliverableContract({
    requiredOutputs: [{ type: 'report_html', enforcement: 'hard' }],
    artifacts: [{ filename: 'report.md', path: mdPath, mimeType: 'text/markdown' }],
  }).ok, false);

  assert.equal(validateDeliverableContract({
    requiredOutputs: [{ type: 'report_html', enforcement: 'hard' }],
    artifacts: [{ filename: 'generic.html', path: genericHtmlPath, mimeType: 'text/html' }],
  }).ok, true);

  assert.equal(validateDeliverableContract({
    requiredOutputs: [{ type: 'report_html', enforcement: 'hard' }],
    artifacts: [{ filename: 'marker-only.html', path: markerOnlyPath, mimeType: 'text/html' }],
  }).ok, true);

  assert.equal(validateDeliverableContract({
    requiredOutputs: [{ type: 'report_html', enforcement: 'hard' }],
    artifacts: [{ filename: 'report.html', path: reportPath, mimeType: 'text/html' }],
  }).ok, true);

  assert.equal(validateDeliverableContract({
    requiredOutputs: [{ type: 'html_report', enforcement: 'hard' }],
    artifacts: [{ filename: 'report.html', path: reportPath, mimeType: 'text/html' }],
  }).ok, true);

  const missing = validateDeliverableContract({
    requiredOutputs: [{ type: 'report_html', enforcement: 'hard' }],
    artifacts: [{ filename: 'missing.html', path: join(dir, 'missing.html'), mimeType: 'text/html' }],
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.failureClass, 'artifact_invalid');
  assert.match(missing.errors.join('\n'), /not readable/i);
}));

test('slide_html requires an existing html deliverable but leaves renderer quality to PO review', () => withTempDir((dir) => {
  const genericHtmlPath = join(dir, 'generic.html');
  writeFileSync(genericHtmlPath, '<!DOCTYPE html><html><body>' + '正文'.repeat(240) + '</body></html>', 'utf-8');
  const markerOnlyPath = join(dir, 'marker-only.html');
  writeFileSync(markerOnlyPath, '<!DOCTYPE html><html data-generator="kai-slide-creator"></html>', 'utf-8');
  const slidePath = join(dir, 'slides.html');
  writeFileSync(slidePath, '<!DOCTYPE html><html data-generator="kai-slide-creator"><body>' + 'Slide'.repeat(240) + '</body></html>', 'utf-8');

  assert.equal(validateDeliverableContract({
    requiredOutputs: [{ type: 'slide_html', enforcement: 'hard' }],
    artifacts: [{ filename: 'generic.html', path: genericHtmlPath, mimeType: 'text/html' }],
  }).ok, true);

  assert.equal(validateDeliverableContract({
    requiredOutputs: [{ type: 'slide_html', enforcement: 'hard' }],
    artifacts: [{ filename: 'marker-only.html', path: markerOnlyPath, mimeType: 'text/html' }],
  }).ok, true);

  assert.equal(validateDeliverableContract({
    requiredOutputs: [{ type: 'slide_html', enforcement: 'hard' }],
    artifacts: [{ filename: 'slides.html', path: slidePath, mimeType: 'text/html' }],
  }).ok, true);

  const missing = validateDeliverableContract({
    requiredOutputs: [{ type: 'slide_html', enforcement: 'hard' }],
    artifacts: [{ filename: 'missing.html', path: join(dir, 'missing.html'), mimeType: 'text/html' }],
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.failureClass, 'artifact_invalid');
  assert.match(missing.errors.join('\n'), /not readable/i);
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
