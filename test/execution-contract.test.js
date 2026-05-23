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
