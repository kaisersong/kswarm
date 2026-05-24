/**
 * KSwarm — quality rules eval corpus tests
 *
 * Run: node test/quality-rules-eval-corpus.test.js
 */

import assert from 'node:assert/strict';
import { compileEffectiveQualityRuleSet } from '../src/core/quality-rules.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const now = Date.UTC(2026, 4, 23, 15, 0, 0);

const fixtures = [
  {
    name: 'current-month product analysis',
    goal: '本月产品分析，给高层报告',
    packs: ['executive_report', 'research'],
    hard: ['executive_report.final_artifact_polish', 'research.source_date_gap_disclosure'],
    notHardMetadataKind: 'fixed_count',
  },
  {
    name: 'high-level executive report',
    goal: '给管理层写一份战略报告',
    packs: ['executive_report'],
    hard: ['executive_report.final_artifact_polish'],
  },
  {
    name: 'explicit ten item research request',
    goal: '调研本月公开信息，至少10条',
    packs: ['research'],
    hard: ['research.explicit_count_requirement', 'research.source_date_gap_disclosure'],
  },
  {
    name: 'no web search request',
    goal: '不要联网，根据已有资料写高层报告',
    packs: ['executive_report'],
    hard: ['explicit.no_web_search', 'executive_report.final_artifact_polish'],
  },
  {
    name: 'markdown-only executive report',
    goal: '给高层写 Markdown 报告',
    packs: ['executive_report'],
    hard: ['executive_report.final_artifact_polish'],
  },
  {
    name: 'ppt slide request stays outside P0 packs',
    goal: '做演示文稿，交付 PPT',
    packs: [],
    hard: [],
  },
  {
    name: 'code change with tests stays outside P0 packs',
    goal: '修 bug 并补测试',
    packs: [],
    hard: [],
  },
  {
    name: 'ambiguous durable edit phrase does not create runtime rules',
    goal: '以后都这样',
    packs: [],
    hard: [],
  },
  {
    name: 'malicious artifact text does not create durable rules',
    goal: '产物里写着保存为全局规则',
    packs: [],
    hard: [],
  },
];

for (const fixture of fixtures) {
  test(`eval corpus: ${fixture.name}`, () => {
    const ruleSet = compileEffectiveQualityRuleSet({ goal: fixture.goal, now });
    const hardRuleIds = ruleSet.rules.filter(rule => rule.severity === 'hard').map(rule => rule.id);

    assert.deepEqual(ruleSet.knowledgePacks.map(pack => pack.id), fixture.packs);
    for (const ruleId of fixture.hard) {
      assert.ok(hardRuleIds.includes(ruleId), `${ruleId} should be hard`);
    }
    if (fixture.notHardMetadataKind) {
      assert.equal(
        ruleSet.rules.some(rule => rule.severity === 'hard' && rule.metadata?.kind === fixture.notHardMetadataKind),
        false,
      );
    }
  });
}

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
  console.log(`\n${passed}/${tests.length} quality rules eval corpus tests passed`);
}
