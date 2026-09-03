/**
 * KSwarm — auto-worker.js workflow 直写路径 containment 回归（design §3.5）
 *
 * 设计依据：mydocs/xiaok-cli/design/2026-08-31-collaboration-room-evidence-first-execution-and-gate-design.md v8
 *   §3.5 Canonical Artifact Manifest —— "放宽 flat filename sanitizer 的安全前置条件是
 *   先落一个共享 root-parameterized resolveArtifactPath owner，并迁移全部读写兄弟路径：
 *   ...auto-worker direct write..."
 *
 * 现状核实（2026-09-02）：`scripts/auto-worker.js` 内有两条独立的 artifact 写入路径：
 *   - 第 2767/2779/2787 行附近（verified artifact harvest）：已正确使用
 *     resolveArtifactPath 做 containment 校验；
 *   - 第 1008-1010 行（workflow node 直写 outputArtifact）：
 *     `const artifactPath = join(artifactRoot, outputArtifact); writeFileSync(artifactPath, ...)`
 *     直接路径拼接，未经过 resolveArtifactPath，没有 containment/symlink escape 校验。
 * 即使 outputArtifact 来源于 workflow node 运行时配置（相对可信），§3.5 要求的是
 * "迁移全部读写兄弟路径"而非条件性迁移；这是本文件要收敛的具体兄弟路径不一致。
 *
 * 本测试采用与 auto-worker-contract.test.js 一致的源码扫描模式（auto-worker.js 顶层
 * main().catch(...) 立即执行副作用，不适合直接 import）。
 *
 * Run: node test/auto-worker-workflow-output-artifact-containment.test.js
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(process.cwd(), 'scripts/auto-worker.js'), 'utf-8');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('workflow node outputArtifact 写入路径必须经过 resolveArtifactPath containment 校验，不能直接 join(artifactRoot, outputArtifact) 后写盘', () => {
  // 定位 outputArtifact 写入语句所在的代码窗口（含前后若干行上下文），
  // 确认这段窗口内出现了 resolveArtifactPath 调用，而不是裸 join + writeFileSync。
  const writeStatementIndex = source.indexOf('writeFileSync(artifactPath, reviewContent');
  assert.ok(writeStatementIndex > -1, '未找到 workflow node outputArtifact 写入语句，源码结构可能已变化，需要重新定位');

  const windowStart = Math.max(0, writeStatementIndex - 400);
  const window = source.slice(windowStart, writeStatementIndex + 100);

  assert.match(
    window,
    /resolveArtifactPath\(/,
    'workflow node outputArtifact 写入前必须调用 resolveArtifactPath 做 containment 校验（当前直接 join(artifactRoot, outputArtifact) 后写盘，可被 outputArtifact 内的 ../ 逃出 artifactRoot）',
  );
});

let passed = 0;
let failed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
  }
}
console.log(`\n${passed}/${tests.length} auto-worker workflow output artifact containment tests passed\n`);
if (failed > 0) process.exit(1);
