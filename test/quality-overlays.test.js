/**
 * KSwarm — durable quality knowledge overlay tests
 *
 * Run: node test/quality-overlays.test.js
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { compileEffectiveQualityRuleSet } from '../src/core/quality-rules.js';
import {
  applyQualityPatch,
  createQualityOverlayStore,
  validateQualityPatch,
} from '../src/core/quality-overlays.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const now = Date.UTC(2026, 4, 23, 13, 0, 0);

function validPatch(overrides = {}) {
  return {
    patchId: 'qpatch-user-exec-risk',
    initiatedBy: 'user',
    confirmedBy: 'user',
    sourceMessageId: 'msg-1',
    conversationId: 'thread-1',
    trustedInput: true,
    target: 'user_knowledge_overlay',
    affectedPacks: ['executive_report'],
    createdAt: now,
    compilerVersion: 'quality-rules@1',
    operations: [
      {
        op: 'upsert_rule',
        rule: {
          id: 'executive_report.decision_useful_synthesis',
          packId: 'executive_report',
          severity: 'hard',
          appliesTo: ['planning', 'review'],
          description: 'Executive reports must include risk and recommendation synthesis.',
          promptExcerpt: {
            po: 'Treat risk and recommendation synthesis as a hard review gate for executive reports.',
            worker: 'Include risk and recommendation synthesis in the executive report.',
            reviewer: 'Reject executive reports that omit risk and recommendation synthesis.',
          },
        },
      },
    ],
    ...overrides,
  };
}

test('validates durable patches require trusted human confirmation', () => {
  assert.equal(validateQualityPatch(validPatch()).ok, true);

  const untrusted = validateQualityPatch(validPatch({
    patchId: 'qpatch-untrusted',
    initiatedBy: 'agent',
    confirmedBy: null,
    trustedInput: false,
  }));
  assert.equal(untrusted.ok, false);
  assert.deepEqual(untrusted.errors, [
    'initiatedBy must be user',
    'confirmedBy must be user',
    'trustedInput must be true',
  ]);

  const artifactSourced = validateQualityPatch(validPatch({
    patchId: 'qpatch-artifact',
    sourceArtifactId: 'artifact-1',
  }));
  assert.equal(artifactSourced.ok, false);
  assert.ok(artifactSourced.errors.includes('artifact/tool output cannot source durable rules'));
});

test('applies a user overlay without mutating builtin packs and emits conflict report', () => {
  const before = compileEffectiveQualityRuleSet({
    goal: '本月产品分析，给高层报告',
    requirements: '',
    now,
  });
  const state = applyQualityPatch(undefined, validPatch()).state;
  const after = compileEffectiveQualityRuleSet({
    goal: '本月产品分析，给高层报告',
    requirements: '',
    overlays: state.overlays,
    now,
  });

  assert.equal(before.rules.find(rule => rule.id === 'executive_report.decision_useful_synthesis').severity, 'soft');
  assert.equal(after.rules.find(rule => rule.id === 'executive_report.decision_useful_synthesis').severity, 'hard');
  assert.equal(before.rules.find(rule => rule.id === 'executive_report.decision_useful_synthesis').severity, 'soft');
  assert.deepEqual(after.conflicts, [
    {
      type: 'severity_conflict',
      ruleId: 'executive_report.decision_useful_synthesis',
      sources: ['builtin:executive_report@1', 'user:qpatch-user-exec-risk@1'],
      resolution: 'user_override',
      chosenSeverity: 'hard',
      needsConfirmation: false,
    },
  ]);
});

test('user overlays override workspace overlays by default', () => {
  const workspacePatch = validPatch({
    patchId: 'qpatch-workspace-soft',
    target: 'workspace_knowledge_overlay',
    operations: [
      {
        op: 'upsert_rule',
        rule: {
          id: 'executive_report.decision_useful_synthesis',
          packId: 'executive_report',
          severity: 'soft',
          appliesTo: ['planning'],
          description: 'Workspace keeps this as advisory.',
          promptExcerpt: { po: 'Workspace advisory only.' },
        },
      },
    ],
  });
  const userPatch = validPatch();
  const withWorkspace = applyQualityPatch(undefined, workspacePatch).state;
  const withUser = applyQualityPatch(withWorkspace, userPatch).state;
  const ruleSet = compileEffectiveQualityRuleSet({
    goal: '本月产品分析，给高层报告',
    overlays: withUser.overlays,
    now,
  });

  const rule = ruleSet.rules.find(item => item.id === 'executive_report.decision_useful_synthesis');
  assert.equal(rule.severity, 'hard');
  assert.equal(rule.source, 'user:qpatch-user-exec-risk@1');
});

test('file-backed overlay store persists applied patches', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kswarm-quality-overlays-'));
  try {
    const filePath = join(dir, 'quality-overlays.json');
    const store = createQualityOverlayStore(filePath);
    const applied = store.applyPatch(validPatch());
    assert.equal(applied.ok, true);

    const restored = createQualityOverlayStore(filePath);
    assert.deepEqual(restored.listState().patches.map(patch => patch.patchId), ['qpatch-user-exec-risk']);
    assert.equal(restored.listOverlays().length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

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
  console.log(`\n${passed}/${tests.length} quality overlay tests passed`);
}
