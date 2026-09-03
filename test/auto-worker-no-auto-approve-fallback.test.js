/**
 * KSwarm — auto-worker.js "no review capability" fallback regression guard
 *
 * 设计依据：design §14.1 test #29 / §4.1
 *   删除/禁用 auto-worker.js 在无 review capability 时自动生成
 *   {passed:true, feedback:'Auto-approved...'} 的兜底。
 *
 * auto-worker.js 是一个不导出任何符号的自执行脚本，无法直接单元测试其内部
 * 函数；本测试改为源码级断言，锁定这条已关闭的旁路字符串不再出现，防止
 * 未来的编辑无意中恢复它。真正的行为验证依赖 auto-worker-contract.test.js
 * 等既有测试覆盖 auto-worker 的其它证据/评审路径。
 *
 * Run: node test/auto-worker-no-auto-approve-fallback.test.js
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(new URL('..', import.meta.url).pathname, 'scripts', 'auto-worker.js'), 'utf-8');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('[FIXED] the "Auto-approved (no review capability)" fallback string no longer exists', () => {
  assert.equal(source.includes('Auto-approved (no review capability)'), false);
});

test('[FIXED] no code path unconditionally sets reviewResult = { passed: true, ... } without an independent reviewer', () => {
  // 之前的旁路是 `reviewResult = { passed: true, feedback: 'Auto-approved...' }`。
  // 现在无 review capability 分支必须产生 passed: false。
  assert.equal(/reviewResult = \{ passed: true, feedback: 'Auto-approved/.test(source), false);
});

test('the no-review-capability fallback now uses the shared no_independent_reviewer reasonCode', () => {
  assert.ok(source.includes('no_independent_reviewer'), 'expected the fallback to reference the no_independent_reviewer reasonCode');
});

test('the source-critical fail-closed branch is still intact (must not have been accidentally removed)', () => {
  assert.ok(source.includes('quality_evidence_missing'), 'the source-critical branch must still fail closed with quality_evidence_missing');
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
console.log(`\n${passed}/${tests.length} auto-worker no-auto-approve fallback regression tests passed`);
if (passed !== tests.length) process.exitCode = 1;
