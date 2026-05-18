/**
 * KSwarm — presentation PPTX fallback executor tests
 *
 * Run: node test/presentation-pptx-executor.test.js
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { executePresentationPptxTask, PRESENTATION_PPTX_EXECUTOR_ID, PRESENTATION_PPTX_EXECUTOR_LEGACY_IDS, probePresentationPptxExecutor } from '../src/executors/presentation-pptx-executor.js';
import { createBuiltInLocalExecutorRegistry } from '../src/executors/registry.js';
import { validateDeliverableContract } from '../src/core/deliverable-contract.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('pptx executor reports available without network dependencies', () => {
  const probe = probePresentationPptxExecutor();
  assert.equal(probe.available, true);
  assert.equal(probe.id, PRESENTATION_PPTX_EXECUTOR_ID);
});

test('local executor registry exposes only primary executor ids', async () => {
  const registry = createBuiltInLocalExecutorRegistry();
  const manifests = registry.list();
  assert.equal(manifests.length, 1);
  assert.equal(manifests[0].id, PRESENTATION_PPTX_EXECUTOR_ID);
  assert.equal(registry.has(PRESENTATION_PPTX_EXECUTOR_ID), true);
  assert.equal(registry.has(PRESENTATION_PPTX_EXECUTOR_LEGACY_IDS[0]), true);
});

test('pptx executor creates parseable fallback artifact with provenance', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'kswarm-pptx-'));
  try {
    const result = await executePresentationPptxTask({
      projectId: 'proj',
      task: {
        id: 'deck',
        title: '技术大会演讲报告',
        brief: '生成 16-20 页 PPTX，用于技术大会演讲。',
      },
      workspacePath: workspace,
    });

    assert.equal(result.ok, true);
    assert.equal(result.deliveryMode, 'fallback_executor');
    assert.equal(result.artifacts[0].deliveryMode, 'fallback_executor');
    assert.equal(result.slideCount >= 16 && result.slideCount <= 20, true);
    assert.equal(existsSync(result.artifacts[0].path), true);

    const validation = validateDeliverableContract({
      requiredOutputs: [{ type: 'pptx', enforcement: 'hard' }],
      artifacts: result.artifacts,
    });
    assert.equal(validation.ok, true);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

let passed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
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
  console.log(`\n${passed}/${tests.length} presentation pptx executor tests passed`);
}
