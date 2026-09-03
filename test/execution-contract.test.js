/**
 * KSwarm — execution/evidence contract tests
 *
 * Run: node test/execution-contract.test.js
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  enrichTaskWithExecutionContract,
  inferExecutionContract,
  validateTaskResultAgainstContract,
} from '../src/core/execution-contract.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// design §5.1.1：task.executionGateSchemaVersion=2 时 enrichTaskWithExecutionContract
// 必须透传给 inferEvidenceContract，产出 external_source_v2（此前完全没有
// 这条链路，auto-worker.js 永远只会拿到 v1 evidence contract）。
test('enrichTaskWithExecutionContract 透传 task.executionGateSchemaVersion=2，产出 external_source_v2 evidence contract', () => {
  const task = enrichTaskWithExecutionContract({
    id: 'research-task',
    title: '收集2026年AI行业最新发布信息',
    brief: '搜索官方公告、新闻稿，整理带来源链接的清单。',
    acceptanceCriteria: '每条信息有来源链接。',
    executionGateSchemaVersion: 2,
  });
  assert.equal(task.evidenceContract?.kind, 'external_source_v2');
  assert.equal(task.evidenceContract?.version, 2);
});

test('enrichTaskWithExecutionContract 不带 executionGateSchemaVersion 时保持默认 v1（不引入回归）', () => {
  const task = enrichTaskWithExecutionContract({
    id: 'research-task-v1',
    title: '收集2026年AI行业最新发布信息',
    brief: '搜索官方公告、新闻稿，整理带来源链接的清单。',
    acceptanceCriteria: '每条信息有来源链接。',
  });
  assert.equal(task.evidenceContract?.kind, 'external_source_v1');
});

test('review tasks receive a structured evidence contract', () => {
  const task = enrichTaskWithExecutionContract({
    id: 'review-slides',
    title: '对技术大会演讲报告做质量评审',
    brief: '检查报告是否满足演讲目标并给出修改建议',
    assignedAgent: 'reviewer',
  });

  assert.equal(task.evidenceContract.kind, 'review_iteration_v1');
  assert.equal(task.executionContract.minSummaryChars, 50);
  assert.ok(task.evidenceContract.requiredArtifacts.includes('review-evidence.json'));
  assert.ok(task.evidenceContract.requiredFields.includes('verdict'));
  assert.ok(task.evidenceContract.requiredFields.includes('findings'));
});

// design §5.1.1（FIXED）：persistedReviewLike / shouldDiscardPersistedReviewEvidenceContract
// 之前硬编码只认 evidenceContract.kind === 'review_iteration_v1'；现在通过
// contract-kind-registry 的 family 判断，一个已持久化的 review_iteration_v2
// 契约也必须被识别为 review-like，不能因为版本号不同就被误判为需要重新推断。
test('a persisted review_iteration_v2 evidence contract is still recognized as review-like', () => {
  const task = inferExecutionContract({
    id: 'v2-review-task',
    title: 'A generic task title with no review keywords',
    brief: 'A generic brief',
    evidenceContract: {
      version: 2,
      kind: 'review_iteration_v2',
      requiredArtifacts: ['review-evidence-v2.json'],
      requiredFields: ['verdict', 'findings', 'subjectArtifacts'],
    },
  });

  assert.equal(task.evidenceContract.kind, 'review_iteration_v2', 'the persisted v2 contract must be preserved, not overwritten by v1 inference');
});

test('review_iteration_v2 rejects a payload satisfying v1 evidence shape as unsupported', () => {
  const task = enrichTaskWithExecutionContract({
    id: 'v2-review-task',
    title: 'Review generated report',
    evidenceContract: {
      version: 2,
      kind: 'review_iteration_v2',
      requiredArtifacts: ['review-evidence.json'],
      requiredFields: ['verdict', 'findings'],
    },
  });

  const result = validateTaskResultAgainstContract(task, {
    summary: 'The review checked narrative structure, evidence quality, audience fit, and implementation details.',
    artifacts: [{ name: 'review-evidence.json', path: 'review-evidence.json' }],
    reviewEvidence: {
      verdict: 'pass',
      findings: [{ severity: 'minor', message: 'A complete v1-shaped finding.' }],
    },
  });

  // design §5.1.1 之后的精确演进：review_iteration_v2 现在是 supported:true
  // （gate-evidence-acceptor.js 提供了真实 v2 validator），所以拒绝原因从
  // "整个 kind 不支持"变为"v2 要求的 gateEvidenceArtifactId 缺失"——v1-shaped
  // inline reviewEvidence 依然不能满足 v2（§3.2 步骤 5 的核心要求），只是
  // 拒绝理由更精确，不再是笼统的 unsupported。
  assert.equal(result.ok, false);
  assert.ok(result.missing.includes('gateEvidenceArtifactId'), JSON.stringify(result));
  assert.ok(
    !result.errors.some(e => e.includes('review evidence field')),
    'v1-shaped inline reviewEvidence 的字段内容不应该被当作满足 v2 required fields 的证据（§3.2 步骤 5：inline evidence 永不满足 v2）',
  );
});

// design §3.2 步骤 5：inline evidence 只可作为 v1 旧项目的非 gate 展示信息；
// v2 validation 只认 task result 显式声明的唯一 gateEvidenceArtifactId，不接受
// inline reviewEvidence/evidence/qualityEvidence 满足 required fields。
// 上面这个测试证明了 v1-shaped inline payload 仍被拒绝；这里补一个区分度测试：
// 正确声明了 gateEvidenceArtifactId 的 v2 payload 必须能通过这一层浅层结构校验
// （深层 hash/schema 校验是 gate-evidence-acceptor.js:acceptTaskGateEvidence 的
// 职责，这一层只检查"是否声明了唯一 ID"，不重新实现一份深度校验）。
test('review_iteration_v2 with an explicit gateEvidenceArtifactId passes the shallow structural check (deep hash/schema validation belongs to acceptTaskGateEvidence)', () => {
  const task = enrichTaskWithExecutionContract({
    id: 'v2-review-task',
    title: 'Review generated report',
    evidenceContract: {
      version: 2,
      kind: 'review_iteration_v2',
      requiredArtifacts: ['review-evidence-v2.json'],
      requiredFields: ['verdict', 'findings', 'subjectArtifacts'],
    },
  });

  const result = validateTaskResultAgainstContract(task, {
    summary: 'The review checked narrative structure, evidence quality, audience fit, and implementation details thoroughly.',
    gateEvidenceArtifactId: 'gate-ev-1',
  });

  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test('review_iteration_v2 without gateEvidenceArtifactId still fails the shallow structural check', () => {
  const task = enrichTaskWithExecutionContract({
    id: 'v2-review-task',
    title: 'Review generated report',
    evidenceContract: {
      version: 2,
      kind: 'review_iteration_v2',
      requiredArtifacts: ['review-evidence-v2.json'],
      requiredFields: ['verdict', 'findings', 'subjectArtifacts'],
    },
  });

  const result = validateTaskResultAgainstContract(task, {
    summary: 'The review checked narrative structure, evidence quality, audience fit, and implementation details thoroughly.',
  });

  assert.equal(result.ok, false);
  assert.ok(result.missing.includes('gateEvidenceArtifactId'));
});

test('revision tasks mentioning review feedback are not treated as review tasks', () => {
  const task = enrichTaskWithExecutionContract({
    id: 'final-report',
    title: '修订并生成最终HTML报告',
    brief: '根据对抗性评审建议，修改报告初稿并重新使用 report renderer 生成最终HTML报告。',
    acceptanceCriteria: '交付最终HTML报告和修改说明（Markdown）。最终报告无逻辑矛盾，格式正确。',
    assignedAgent: 'worker',
  });

  assert.notEqual(task.evidenceContract?.kind, 'review_iteration_v1');
  assert.deepEqual(task.evidenceContract?.requiredArtifacts, undefined);
});

test('stale persisted review evidence contract is discarded for final revision deliverables', () => {
  const task = enrichTaskWithExecutionContract({
    id: 'final-report',
    title: '修订并生成最终HTML报告',
    brief: '根据对抗性评审建议，修改报告初稿。重新使用 report renderer 生成最终HTML报告，同时提供修改说明文档。',
    acceptanceCriteria: '交付最终HTML报告（report renderer生成）和修改说明（Markdown）。修改说明列出每条评审意见的处理情况。',
    assignedAgent: 'worker',
    evidenceContract: {
      version: 1,
      kind: 'review_iteration_v1',
      requiredArtifacts: ['review-evidence.json'],
      requiredFields: ['verdict', 'findings'],
    },
  });

  assert.notEqual(task.evidenceContract?.kind, 'review_iteration_v1');

  const result = validateTaskResultAgainstContract(task, {
    summary: '已经根据对抗性评审完成最终报告修订，并重新生成 HTML 报告，同时附带可追踪的修改说明，供最终质量检查和交付使用。',
    artifacts: [
      { filename: 'report-kingdee-may-2026.html', path: 'artifacts/report-kingdee-may-2026.html', mimeType: 'text/html' },
      { filename: 'revision-log-v2.0.md', path: 'artifacts/revision-log-v2.0.md', mimeType: 'text/markdown' },
    ],
  });

  assert.equal(result.ok, true);
});

test('plain deliverable tasks still reject empty or placeholder results', () => {
  const contract = inferExecutionContract({
    id: 'draft-report',
    title: '生成技术大会演讲报告初稿',
    brief: '输出可直接审阅的报告',
  });

  const empty = validateTaskResultAgainstContract(contract.task, { summary: 'done', artifacts: [] });
  assert.equal(empty.ok, false);
  assert.equal(empty.failureClass, 'quality_evidence_missing');
  assert.ok(empty.errors.some(e => e.includes('summary')));
});

test('review evidence must include verdict and findings before acceptance', () => {
  const task = enrichTaskWithExecutionContract({
    id: 'review-slides',
    title: '质量评审：技术大会演讲报告',
    assignedAgent: 'reviewer',
  });

  const missing = validateTaskResultAgainstContract(task, {
    summary: '完成评审，整体还可以。',
    artifacts: [{ name: 'notes.md', path: 'notes.md' }],
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.failureClass, 'quality_evidence_missing');
  assert.ok(missing.errors.some(e => e.includes('review-evidence.json')));
  assert.ok(missing.errors.some(e => e.includes('verdict')));

  const valid = validateTaskResultAgainstContract(task, {
    summary: '完成质量评审，已覆盖结构、事实、受众匹配、可执行修改意见和最终判断，确认产物具备进入下一阶段的依据。',
    artifacts: [{ name: 'review-evidence.json', path: 'review-evidence.json' }],
    reviewEvidence: {
      verdict: 'pass',
      findings: [
        { severity: 'minor', message: '标题页需要更明确的技术主题。' },
      ],
    },
  });
  assert.equal(valid.ok, true);
});

test('contract validation accepts artifact manifests with filename or relativePath', () => {
  const task = enrichTaskWithExecutionContract({
    id: 'review-report',
    title: 'Review generated report',
    assignedAgent: 'reviewer',
  });

  const result = validateTaskResultAgainstContract(task, {
    summary: 'The review checked narrative structure, evidence quality, audience fit, and implementation details.',
    artifacts: [{ filename: 'review-evidence.json', relativePath: 'qa/review-evidence.json' }],
    evidence: {
      verdict: 'needs_changes',
      findings: [{ severity: 'major', message: 'Need stronger opening.' }],
    },
  });

  assert.equal(result.ok, true);
});

test('review evidence contract reads verdict and findings from review-evidence artifact in workspace', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kswarm-review-evidence-'));
  try {
    mkdirSync(join(dir, 'artifacts'), { recursive: true });
    writeFileSync(join(dir, 'artifacts', 'review-evidence.json'), JSON.stringify({
      verdict: 'pass',
      findings: [
        { severity: 'minor', message: '来源覆盖完整，后续报告阶段可直接引用。' },
      ],
    }), 'utf-8');

    const task = enrichTaskWithExecutionContract({
      id: 'review-source-evidence',
      title: '验证信息准确性与完整性',
      assignedAgent: 'reviewer',
      evidenceContract: {
        kind: 'review_iteration_v1',
        requiredArtifacts: ['review-evidence.json'],
        requiredFields: ['verdict', 'findings'],
      },
    });

    const result = validateTaskResultAgainstContract(task, {
      summary: '完成信息准确性与完整性验证，核对了关键产品动态、发布日期、来源链接、竞品对照、后续报告可引用边界和风险提示依据。',
      artifacts: [{
        filename: 'review-evidence.json',
        relativePath: 'artifacts/review-evidence.json',
        mimeType: 'application/json',
      }],
    }, { workspacePath: dir });

    assert.equal(result.ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('review evidence contract ignores review-evidence artifacts outside workspace', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kswarm-review-evidence-safe-'));
  const outside = mkdtempSync(join(tmpdir(), 'kswarm-review-evidence-outside-'));
  try {
    writeFileSync(join(outside, 'review-evidence.json'), JSON.stringify({
      verdict: 'pass',
      findings: [{ severity: 'minor', message: 'This file is outside the workspace.' }],
    }), 'utf-8');

    const task = enrichTaskWithExecutionContract({
      id: 'review-source-evidence',
      title: '验证信息准确性与完整性',
      assignedAgent: 'reviewer',
      evidenceContract: {
        kind: 'review_iteration_v1',
        requiredArtifacts: ['review-evidence.json'],
        requiredFields: ['verdict', 'findings'],
      },
    });

    const result = validateTaskResultAgainstContract(task, {
      summary: '完成信息准确性与完整性验证，核对了关键产品动态、发布日期、来源链接、竞品对照、后续报告可引用边界和风险提示依据。',
      artifacts: [{
        filename: 'review-evidence.json',
        path: join(outside, 'review-evidence.json'),
        mimeType: 'application/json',
      }],
    }, { workspacePath: dir });

    assert.equal(result.ok, false);
    assert.ok(result.errors.some(e => e.includes('verdict')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('explicit pptx tasks reject markdown-only submissions before review', () => {
  const task = enrichTaskWithExecutionContract({
    id: 'talk-deck',
    title: '技术大会演讲报告',
    brief: '最终交付物必须是 PPTX 文件（.pptx），不是 Markdown 文档。',
    assignedAgent: 'worker',
  });

  const result = validateTaskResultAgainstContract(task, {
    summary: '已经完成技术大会演讲报告内容，包含主题、结构、章节摘要、讲稿要点、受众分析、时间安排、演示节奏和后续建议，可以用于准备演讲材料。',
    artifacts: [{ filename: 'talk-deck-report.md', path: 'artifacts/talk-deck-report.md', mimeType: 'text/markdown' }],
  });

  assert.equal(result.ok, false);
  assert.equal(result.failureClass, 'artifact_type_mismatch');
  assert.ok(result.errors.some(e => e.includes('missing required output: pptx')));
});

test('report_html tasks validate artifact manifests relative to result workFolder', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kswarm-execution-contract-'));
  try {
    mkdirSync(join(dir, 'artifacts'), { recursive: true });
    const body = '金蝶本月产品分析报告 '.repeat(40);
    writeFileSync(join(dir, 'artifacts', 'kingdee-report.html'), `<!doctype html>
<html><body><main data-template="kai-report-creator"><h1>金蝶本月产品分析报告</h1><p>${body}</p></main></body></html>`, 'utf-8');

    const task = enrichTaskWithExecutionContract({
      id: 'render-report',
      title: '使用report renderer生成HTML报告',
      brief: '输出最终 HTML 报告',
      assignedAgent: 'worker',
    });

    const result = validateTaskResultAgainstContract(task, {
      summary: '已经生成面向研发高层阅读的金蝶本月产品分析 HTML 报告，包含标题、正文、结构化章节和可打开的 HTML 文件。',
      workFolder: dir,
      artifacts: [{
        filename: 'kingdee-report.html',
        relativePath: 'artifacts/kingdee-report.html',
        mimeType: 'text/html',
      }],
    });

    assert.equal(result.ok, true);
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
  console.log(`\n${passed}/${tests.length} execution contract tests passed`);
}
