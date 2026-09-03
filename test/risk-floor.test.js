/**
 * KSwarm — risk-floor.js unit tests
 *
 * 设计依据：design §4 风险分级与角色隔离
 *
 * Run: node test/risk-floor.test.js
 */

import assert from 'node:assert/strict';
import {
  deriveRiskFloor,
  resolveEffectiveRiskProfile,
  deriveReviewRequirement,
  maxRiskLevel,
} from '../src/core/risk-floor.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('maxRiskLevel returns the highest of the given levels', () => {
  assert.equal(maxRiskLevel('low', 'normal'), 'normal');
  assert.equal(maxRiskLevel('high', 'low'), 'high');
  assert.equal(maxRiskLevel('normal'), 'normal');
  assert.equal(maxRiskLevel(), 'low');
});

test('deriveRiskFloor defaults to low for a purely internal draft with no external source and no user deliverable', () => {
  const floor = deriveRiskFloor({ plan: null, executionContracts: [], requestedOutput: {} });
  assert.equal(floor, 'low');
});

test('deriveRiskFloor is normal when there is a user-facing deliverable kind but no high-risk signal', () => {
  const floor = deriveRiskFloor({ requestedOutput: { kind: 'markdown' } });
  assert.equal(floor, 'normal');
});

test('deriveRiskFloor is high when an external_source contract combines with a public release audience', () => {
  const floor = deriveRiskFloor({
    executionContracts: [{ kind: 'external_source_v1' }],
    requestedOutput: { kind: 'report', audience: 'public' },
  });
  assert.equal(floor, 'high');
});

test('deriveRiskFloor is high on explicit fact-check wording regardless of other signals', () => {
  const floor = deriveRiskFloor({ plan: { analysis: '需要对文中数据做事实核查' } });
  assert.equal(floor, 'high');
});

test('deriveRiskFloor is high for a public release combined with a financial/legal/security keyword', () => {
  const floor = deriveRiskFloor({
    requestedOutput: { kind: 'report', audience: 'public' },
    plan: { analysis: '本报告涉及合规审计结论' },
  });
  assert.equal(floor, 'high');
});

test('deriveRiskFloor does NOT go high on a bare financial/legal keyword alone (keyword is only an add-on signal, not a sole trigger)', () => {
  const floor = deriveRiskFloor({
    plan: { analysis: '内部讨论一下合规流程，不发布不面向外部' },
  });
  assert.notEqual(floor, 'high', 'a bare keyword without external/public signal must not solely trigger high');
});

test('deriveRiskFloor recognizes external_source_v2 the same as v1', () => {
  const floor = deriveRiskFloor({
    executionContracts: [{ kind: 'external_source_v2' }],
    requestedOutput: { audience: 'public' },
  });
  assert.equal(floor, 'high');
});

// design §4.1：最终 riskProfile = max(deterministicFloor, plannerProposal, userSelection)。
test('resolveEffectiveRiskProfile takes the max of floor, planner, and user selection', () => {
  assert.equal(resolveEffectiveRiskProfile({ deterministicFloor: 'low', plannerProposal: 'normal', userSelection: null }), 'normal');
  assert.equal(resolveEffectiveRiskProfile({ deterministicFloor: 'normal', plannerProposal: null, userSelection: 'high' }), 'high');
});

test('resolveEffectiveRiskProfile lets the user revoke a planner-raised level but never below the deterministic floor', () => {
  // planner 提到 high，用户想撤销回到 normal —— floor 是 normal，允许。
  assert.equal(resolveEffectiveRiskProfile({ deterministicFloor: 'normal', plannerProposal: 'high', userSelection: 'normal' }), 'normal');
});

test('[SECURITY] resolveEffectiveRiskProfile never allows dropping below the deterministic floor even via userSelection', () => {
  // floor 是 high（确定性触发），用户选择 low —— 不能生效，仍应是 high。
  const result = resolveEffectiveRiskProfile({ deterministicFloor: 'high', plannerProposal: null, userSelection: 'low' });
  assert.equal(result, 'high');
});

test('resolveEffectiveRiskProfile throws on an invalid deterministicFloor value', () => {
  assert.throws(() => resolveEffectiveRiskProfile({ deterministicFloor: 'not_a_real_level' }), /invalid_deterministic_floor/);
});

// design §4.1：deriveReviewRequirement — high 必须独立 review + 确定性检查。
test('[SECURITY] deriveReviewRequirement mandates independent review and deterministic check for high risk, no exemption possible', () => {
  const req = deriveReviewRequirement({ riskProfile: 'high', policyAllowsReviewExemption: true, reversible: true });
  assert.equal(req.requiresIndependentReview, true);
  assert.equal(req.requiresDeterministicCheck, true);
  assert.equal(req.allowExemption, false, 'high risk must never allow exemption, even if caller tries to force policyAllowsReviewExemption');
});

test('deriveReviewRequirement mandates independent review for normal risk, exemption not allowed', () => {
  const req = deriveReviewRequirement({ riskProfile: 'normal', policyAllowsReviewExemption: true, reversible: true });
  assert.equal(req.requiresIndependentReview, true);
  assert.equal(req.allowExemption, false);
});

// design §4.1：low 只有同时满足四项确定性条件才可免 review。
test('[SECURITY] deriveReviewRequirement denies low-risk exemption when any of the four conditions is missing', () => {
  const base = {
    riskProfile: 'low',
    executionContracts: [],
    requestedOutput: {},
    reversible: true,
    policyAllowsReviewExemption: true,
  };
  // baseline: all four conditions met -> exemption allowed
  assert.equal(deriveReviewRequirement(base).allowExemption, true);

  // condition 1 missing: has external source contract
  assert.equal(deriveReviewRequirement({ ...base, executionContracts: [{ kind: 'external_source_v1' }] }).allowExemption, false);

  // condition 2 missing: has a user-facing deliverable kind
  assert.equal(deriveReviewRequirement({ ...base, requestedOutput: { kind: 'markdown' } }).allowExemption, false);

  // condition 2 missing: public audience
  assert.equal(deriveReviewRequirement({ ...base, requestedOutput: { audience: 'public' } }).allowExemption, false);

  // condition 3 missing: not reversible
  assert.equal(deriveReviewRequirement({ ...base, reversible: false }).allowExemption, false);

  // condition 4 missing: policy does not allow exemption
  assert.equal(deriveReviewRequirement({ ...base, policyAllowsReviewExemption: false }).allowExemption, false);
});

test('deriveReviewRequirement defaults to requiring review (fail closed) on an invalid riskProfile', () => {
  const req = deriveReviewRequirement({ riskProfile: 'not_a_real_level' });
  assert.equal(req.requiresIndependentReview, true);
  assert.equal(req.allowExemption, false);
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
console.log(`\n${passed}/${tests.length} risk-floor tests passed`);
if (passed !== tests.length) process.exitCode = 1;
