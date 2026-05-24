/**
 * KSwarm — project-management quality knowledge/rules compiler tests
 *
 * Run: node test/quality-rules.test.js
 */

import assert from 'node:assert/strict';
import {
  buildQualityPromptExcerpt,
  compileEffectiveQualityRuleSet,
} from '../src/core/quality-rules.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const now = Date.UTC(2026, 4, 23, 12, 0, 0);

function ruleIds(ruleSet) {
  return ruleSet.rules.map(rule => rule.id);
}

function hardRuleIds(ruleSet) {
  return ruleSet.rules.filter(rule => rule.severity === 'hard').map(rule => rule.id);
}

test('current-month product analysis for executives compiles research and executive-report packs without fixed-count hard gate', () => {
  const ruleSet = compileEffectiveQualityRuleSet({
    goal: '本月产品分析，给高层报告',
    requirements: '',
    now,
  });

  assert.equal(ruleSet.compilerVersion, 'quality-rules@1');
  assert.deepEqual(ruleSet.knowledgePacks.map(pack => pack.id), ['executive_report', 'research']);
  assert.equal(ruleSet.requestSignals.requiresRecentEvidence, true);
  assert.equal(ruleSet.requestSignals.executiveAudience, true);
  assert.equal(ruleSet.requestSignals.explicitCountRequirement, null);

  assert.ok(ruleIds(ruleSet).includes('research.source_date_gap_disclosure'));
  assert.ok(ruleIds(ruleSet).includes('executive_report.final_artifact_polish'));
  assert.equal(
    ruleSet.rules.some(rule => rule.severity === 'hard' && rule.metadata?.kind === 'fixed_count'),
    false,
  );
  assert.equal(JSON.stringify(ruleSet).includes('至少10'), false);
});

test('explicit count language creates a hard explicit-request count rule', () => {
  const ruleSet = compileEffectiveQualityRuleSet({
    goal: '本月产品分析，给高层报告，至少10条公开信息',
    requirements: '',
    now,
  });

  const rule = ruleSet.rules.find(item => item.id === 'research.explicit_count_requirement');
  assert.ok(rule);
  assert.equal(rule.severity, 'hard');
  assert.equal(rule.source, 'explicit:user_request');
  assert.deepEqual(rule.metadata, { kind: 'fixed_count', count: 10, operator: 'at_least' });
  assert.ok(hardRuleIds(ruleSet).includes('research.explicit_count_requirement'));
});

test('soft count preference does not become a hard gate', () => {
  const ruleSet = compileEffectiveQualityRuleSet({
    goal: '本月产品分析，给高层报告，最好有10条公开信息',
    requirements: '',
    now,
  });

  assert.equal(
    ruleSet.rules.some(rule => rule.severity === 'hard' && rule.metadata?.kind === 'fixed_count'),
    false,
  );
  const preference = ruleSet.rules.find(rule => rule.id === 'research.count_preference');
  assert.ok(preference);
  assert.equal(preference.severity, 'soft');
  assert.deepEqual(preference.metadata, { kind: 'count_preference', count: 10 });
});

test('explicit no-web-search request creates a hard no-web-search gate', () => {
  const ruleSet = compileEffectiveQualityRuleSet({
    goal: '不要联网，根据已有资料写高层报告',
    requirements: '',
    now,
  });

  assert.equal(ruleSet.requestSignals.explicitNoWebSearch, true);
  const rule = ruleSet.rules.find(item => item.id === 'explicit.no_web_search');
  assert.ok(rule);
  assert.equal(rule.severity, 'hard');
  assert.equal(rule.source, 'explicit:user_request');
});

test('compiler output is deterministic and prompt excerpts are bounded in rule order', () => {
  const first = compileEffectiveQualityRuleSet({
    goal: '本月产品分析，给高层报告',
    requirements: '',
    now,
  });
  const second = compileEffectiveQualityRuleSet({
    goal: '本月产品分析，给高层报告',
    requirements: '',
    now,
  });

  assert.deepEqual(first, second);
  assert.deepEqual(ruleIds(first), [...ruleIds(first)].sort((a, b) => {
    const severityOrder = severity => severity === 'hard' ? 0 : 1;
    const left = first.rules.find(rule => rule.id === a);
    const right = first.rules.find(rule => rule.id === b);
    const severityDelta = severityOrder(left.severity) - severityOrder(right.severity);
    return severityDelta || a.localeCompare(b);
  }));

  const excerpt = buildQualityPromptExcerpt(first, { role: 'po', budgetChars: 360 });
  assert.equal(excerpt.role, 'po');
  assert.ok(excerpt.text.length <= 360);
  assert.ok(excerpt.text.includes('Effective project-management rules'));
  assert.deepEqual(excerpt.includedRuleIds, ruleIds(first).slice(0, excerpt.includedRuleIds.length));
  assert.equal(excerpt.omittedCount, first.rules.length - excerpt.includedRuleIds.length);
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
  console.log(`\n${passed}/${tests.length} quality rules tests passed`);
}
