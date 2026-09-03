/**
 * KSwarm — freezeFinalCandidateArtifact（design §8.1.1 / §10.5）
 *
 * 设计依据：mydocs/xiaok-cli/design/2026-08-31-collaboration-room-evidence-first-execution-and-gate-design.md v8
 *   §8.1.1 —— "最终批准还要关闭 filesystem TOCTOU：pre-approval hydration 读取
 *   候选时校验 open file 的 read-before/read-after stat，一旦 inode/size/mtime
 *   变化即 conflict；随后把同一 bytes 原子写入 project 内 write-once、
 *   content-addressed 的 frozen candidate（临时文件 → fsync → rename →
 *   reopen rehash），为其注册新的 canonical artifact version。FinalDeliverable、
 *   checks、snapshot 和 approval 全部绑定 frozen artifact ID/hash，不再绑定
 *   可变工作文件路径。工作文件之后变化只能产生新 candidate/version，不能改变
 *   已批准 bytes。"
 *   §10.5 —— "批准时文件竞态：hydration 期间 stat 变化则 conflict；hydration
 *   后只批准 content-addressed frozen candidate，工作文件后续变化不影响已批准
 *   bytes。"
 *
 * 现状核实（2026-09-02）：全代码库 grep "frozen" 零匹配——这个机制此前完全
 * 不存在。approveFinalDeliverable 当前绑定的始终是原始工作文件路径
 * （finalDeliverable.artifactRef 指向 workspace 内可变路径），approval 完成
 * 之后如果有人修改/覆写那个工作文件，已批准的 FinalDeliverable 引用的路径
 * 会读到不同的内容（虽然 hash 会在 verifyCommittedReviewGateDecision 里被
 * 检测出漂移，但物理文件本身没有被隔离保护）。
 *
 * 本模块实现最小可行的 frozen candidate 写入：原子临时文件 → fsync →
 * rename → reopen rehash，写入 project 专属的 `frozen/` 目录，
 * content-addressed 文件名（sha256），幂等（同 hash 已存在则跳过重写）。
 *
 * Run: node test/frozen-final-candidate.test.js
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { freezeFinalCandidateArtifact } from '../src/core/frozen-final-candidate.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

test('正常场景：给定工作区内一个真实文件，freezeFinalCandidateArtifact 原子写出 content-addressed frozen 副本', () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'kswarm-frozen-'));
  try {
    const workingFilePath = join(workspaceRoot, 'artifacts', 'report.md');
    mkdirSync(join(workspaceRoot, 'artifacts'), { recursive: true });
    const content = Buffer.from('# Final Report\n\nThis is the approved content.', 'utf-8');
    writeFileSync(workingFilePath, content);
    const expectedHash = sha256(content);

    const result = freezeFinalCandidateArtifact({
      workspaceRoot,
      sourcePath: workingFilePath,
      projectId: 'proj-1',
      deliverableId: 'fd-1',
    });

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.frozen.sha256, expectedHash);
    assert.ok(existsSync(result.frozen.absolutePath), 'frozen 文件必须真实落盘');
    const frozenBytes = readFileSync(result.frozen.absolutePath);
    assert.equal(sha256(frozenBytes), expectedHash, 'frozen 文件内容必须与源文件一致（reopen rehash 校验）');
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('write-once：对同一内容重复调用 freezeFinalCandidateArtifact 是幂等的（不重复写入，不报错）', () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'kswarm-frozen-'));
  try {
    const workingFilePath = join(workspaceRoot, 'artifacts', 'report.md');
    mkdirSync(join(workspaceRoot, 'artifacts'), { recursive: true });
    writeFileSync(workingFilePath, 'stable content');

    const first = freezeFinalCandidateArtifact({ workspaceRoot, sourcePath: workingFilePath, projectId: 'proj-1', deliverableId: 'fd-1' });
    const firstMtime = statSync(first.frozen.absolutePath).mtimeMs;
    const second = freezeFinalCandidateArtifact({ workspaceRoot, sourcePath: workingFilePath, projectId: 'proj-1', deliverableId: 'fd-1' });
    assert.equal(second.ok, true);
    assert.equal(second.frozen.sha256, first.frozen.sha256);
    assert.equal(second.frozen.absolutePath, first.frozen.absolutePath, '同一内容必须映射到同一 content-addressed 路径');
    const secondMtime = statSync(second.frozen.absolutePath).mtimeMs;
    assert.equal(secondMtime, firstMtime, '已存在的 frozen 文件不应被重复写入（write-once）');
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('批准后工作文件被修改，不影响已冻结的 frozen 副本内容（这是本机制存在的核心目的）', () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'kswarm-frozen-'));
  try {
    const workingFilePath = join(workspaceRoot, 'artifacts', 'report.md');
    mkdirSync(join(workspaceRoot, 'artifacts'), { recursive: true });
    writeFileSync(workingFilePath, 'original approved content');

    const frozen = freezeFinalCandidateArtifact({ workspaceRoot, sourcePath: workingFilePath, projectId: 'proj-1', deliverableId: 'fd-1' });
    assert.equal(frozen.ok, true);
    const frozenBytesBefore = readFileSync(frozen.frozen.absolutePath);

    // 批准之后，工作文件被后续任务/用户修改（真实场景：同一路径被下一个任务复用）。
    writeFileSync(workingFilePath, 'someone changed the working file after approval');

    const frozenBytesAfter = readFileSync(frozen.frozen.absolutePath);
    assert.deepEqual(frozenBytesAfter, frozenBytesBefore, 'frozen 副本必须不受工作文件后续修改影响');
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('frozen 目录必须落在 workspaceRoot 内（不越界写入）', () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'kswarm-frozen-'));
  try {
    const workingFilePath = join(workspaceRoot, 'artifacts', 'report.md');
    mkdirSync(join(workspaceRoot, 'artifacts'), { recursive: true });
    writeFileSync(workingFilePath, 'content');

    const result = freezeFinalCandidateArtifact({ workspaceRoot, sourcePath: workingFilePath, projectId: 'proj-1', deliverableId: 'fd-1' });
    assert.equal(result.ok, true);
    const relativePathFromRoot = relative(realpathSync(workspaceRoot), result.frozen.absolutePath);
    assert.ok(!relativePathFromRoot.startsWith('..'), 'frozen 文件必须落在 workspaceRoot 内部');
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('源文件不存在时 fail closed', () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'kswarm-frozen-'));
  try {
    const result = freezeFinalCandidateArtifact({
      workspaceRoot,
      sourcePath: join(workspaceRoot, 'artifacts', 'missing.md'),
      projectId: 'proj-1',
      deliverableId: 'fd-1',
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'source_artifact_missing');
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('sourcePath 越界（workspaceRoot 外部）时 fail closed', () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'kswarm-frozen-'));
  const outsideDir = mkdtempSync(join(tmpdir(), 'kswarm-outside-'));
  try {
    const outsideFile = join(outsideDir, 'secret.md');
    writeFileSync(outsideFile, 'not part of this workspace');
    const result = freezeFinalCandidateArtifact({
      workspaceRoot,
      sourcePath: outsideFile,
      projectId: 'proj-1',
      deliverableId: 'fd-1',
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'source_path_escape');
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
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
    if (process.env.DEBUG) console.log(err.stack);
  }
}
console.log(`\n${passed}/${tests.length} freezeFinalCandidateArtifact tests passed\n`);
if (failed > 0) process.exit(1);
