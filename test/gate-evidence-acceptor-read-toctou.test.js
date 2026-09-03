/**
 * KSwarm — readContainedArtifact 必须检测 read-before/read-after stat 漂移
 * （design §8.1.1 / §10.5：TOCTOU 文件竞态保护）
 *
 * 设计依据：mydocs/xiaok-cli/design/2026-08-31-collaboration-room-evidence-first-execution-and-gate-design.md v8
 *   §8.1.1 —— "pre-approval hydration 读取候选时校验 open file 的
 *   read-before/read-after stat，一旦 inode/size/mtime 变化即 conflict"
 *   §10.5 —— "批准时文件竞态：hydration 期间 stat 变化则 conflict"
 *
 * 现状核实（2026-09-02）：readContainedArtifact 当前只做一次
 * existsSync → realpathSync → readFileSync，没有任何 read-before/read-after
 * stat 比对——如果文件内容在 open 之后、read 完成之前被替换（例如
 * mkdtempSync 场景下用 rename 原子替换目标文件），当前实现无法检测到这个
 * TOCTOU 窗口，只会读到"某个时刻"的内容而不报告冲突。
 *
 * Run: node test/gate-evidence-acceptor-read-toctou.test.js
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readContainedArtifact } from '../src/core/gate-evidence-acceptor.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('正常场景：文件在读取期间未变化，readContainedArtifact 正常返回内容', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kswarm-toctou-'));
  try {
    writeFileSync(join(dir, 'a.json'), 'stable-content');
    const result = readContainedArtifact(dir, 'a.json');
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.content.toString('utf-8'), 'stable-content');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('TOCTOU：readContainedArtifact 必须暴露可供 caller 做 read-before/read-after 比对的 stat 信息', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kswarm-toctou-'));
  try {
    writeFileSync(join(dir, 'a.json'), 'original-content');
    const result = readContainedArtifact(dir, 'a.json');
    assert.equal(result.ok, true, JSON.stringify(result));
    // design §8.1.1 明确要求 read-before/read-after stat（inode/size/mtime）
    // 比对；readContainedArtifact 必须把读取时刻的 stat 暴露出来，否则
    // caller（hydrateGateFacts / approveFinalDeliverable 的 pre-approval
    // hydration）无法在两次独立调用之间做漂移检测。
    assert.ok(result.stat, 'readContainedArtifact 必须返回 stat 信息供上层做 TOCTOU 检测');
    assert.equal(typeof result.stat.size, 'number');
    assert.equal(typeof result.stat.mtimeMs, 'number');
    assert.equal(typeof result.stat.ino, 'number');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('TOCTOU：两次连续读取之间文件被原子替换（rename）时，stat 的 ino/mtime/size 必须能反映出内容已变化', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kswarm-toctou-'));
  try {
    writeFileSync(join(dir, 'a.json'), 'original-content');
    const before = readContainedArtifact(dir, 'a.json');
    assert.equal(before.ok, true);

    // 模拟批准流程期间，文件被原子替换为不同内容（真实攻击/竞态场景）。
    const tmpFile = join(dir, 'a.json.tmp');
    writeFileSync(tmpFile, 'replaced-content-that-is-much-longer-than-original');
    renameSync(tmpFile, join(dir, 'a.json'));

    const after = readContainedArtifact(dir, 'a.json');
    assert.equal(after.ok, true);
    assert.notEqual(after.content.toString('utf-8'), before.content.toString('utf-8'), '替换后的内容必须与之前不同');
    // size 或 mtime 至少一项必须能反映出变化，供 caller 判定 conflict。
    const changed = after.stat.size !== before.stat.size || after.stat.mtimeMs !== before.stat.mtimeMs;
    assert.ok(changed, 'stat 信息必须能反映出文件已经被替换');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
console.log(`\n${passed}/${tests.length} readContainedArtifact TOCTOU tests passed\n`);
if (failed > 0) process.exit(1);
