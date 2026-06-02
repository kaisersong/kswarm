import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHub } from '../src/core/hub.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function makeTempDir(label = 'kualityforge-workflow') {
  return mkdtempSync(join(tmpdir(), `kswarm-${label}-`));
}

function createActiveProject(hub, id = 'proj-kualityforge') {
  const project = hub.createProject({
    id,
    name: 'KualityForge 集成项目',
    goal: '验证 KualityForge dynamic workflow contract',
    poAgent: 'xiaok-po',
    members: ['codex:gpt-5', 'claude:sonnet'],
  });
  const added = hub.handleHumanAddTasks(id, [
    { title: '执行质量门禁', assignedAgent: 'codex:gpt-5' },
  ]);
  assert.equal(added.ok, true);
  assert.equal(hub.handleApprove(id).ok, true);
  return project;
}

function makeKualityForgePreview(projectId = 'proj-kualityforge') {
  return {
    ok: true,
    workflowId: 'kualityforge_quality_gate',
    source: 'script_generated',
    strategy: 'workflow',
    status: 'pending_confirmation',
    projectId,
    scope: {
      projectId,
      qualityRunId: 'release-1',
      artifactRoot: 'docs/quality/release-1',
    },
    requestedBy: 'codex',
    createdAt: 1782000000000,
    title: 'KualityForge Quality Gate',
    description: 'Run context-aware multi-reviewer quality gate for release-1.',
    meta: {
      name: 'kualityforge_quality_gate',
      runId: 'release-1',
      artifactRoot: 'docs/quality/release-1',
      reviewers: ['codex:gpt-5', 'claude:sonnet'],
      phases: [
        { title: 'Freeze Context' },
        { title: 'Parallel Review' },
        { title: 'Synthesis and Decision' },
        { title: 'Fix and Verify' },
        { title: 'Reduce Gate' },
      ],
    },
    phases: [
      { id: 'freeze-context', title: 'Freeze Context', detail: 'Freeze user principles and project context.' },
      { id: 'parallel-review', title: 'Parallel Review', detail: 'Fan out independent reviewer nodes.' },
      { id: 'synthesis-decision', title: 'Synthesis and Decision', detail: 'Synthesize findings and capture human decision.' },
      { id: 'fix-verify', title: 'Fix and Verify', detail: 'Fix approved items and independently verify.' },
      { id: 'reduce-gate', title: 'Reduce Gate', detail: 'Run deterministic gate reducer.' },
    ],
    scriptHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    analysis: {
      agentCallCount: 2,
      phaseCallCount: 5,
      parallelCallCount: 1,
      pipelineCallCount: 0,
      requestUserInputCallCount: 1,
      runtimePhaseTitles: ['Freeze Context', 'Parallel Review', 'Synthesis and Decision', 'Fix and Verify', 'Reduce Gate'],
    },
  };
}

test('KualityForge script preview can create a KSwarm dynamic workflow and reviewer fan-out', () => {
  const dir = makeTempDir('contract');
  try {
    const hub = createHub({ eventLogDir: join(dir, 'events'), silent: true });
    createActiveProject(hub);

    const proposal = hub.createScriptWorkflowProposal('proj-kualityforge', makeKualityForgePreview(), {
      requestedBy: 'codex',
      now: 1782000000100,
    });
    assert.equal(proposal.ok, true);
    assert.equal(proposal.workflowProposal.workflowId, 'kualityforge_quality_gate');
    assert.equal(proposal.workflowProposal.source, 'script_generated');

    const started = hub.startScriptWorkflowRunFromProposal(proposal.workflowProposal.id, {
      approvedBy: 'human',
      now: 1782000000200,
    });
    assert.equal(started.ok, true);
    assert.equal(started.workflowRun.status, 'running');
    assert.equal(started.workflowRun.nodes[0].id, 'script-runtime');

    const group = hub.beginWorkflowScriptParallelGroup(started.workflowRun.id, {
      phaseTitle: 'Parallel Review',
      label: 'KualityForge reviewer fan-out',
      primitiveId: 'reviewer-fanout',
      totalCount: 2,
      limit: 2,
      failurePolicy: 'required_all',
      now: 1782000000300,
    });
    assert.equal(group.ok, true);
    assert.equal(group.parallelGroup.totalCount, 2);

    const reviewer = hub.dispatchWorkflowScriptAgentNode(started.workflowRun.id, {
      phaseTitle: 'Parallel Review',
      label: 'KualityForge review: codex:gpt-5',
      prompt: 'Read context/project-brief.md and write reviews/codex-gpt-5.md with a fenced kualityforge-review JSON block.',
      assignedAgent: 'codex:gpt-5',
      parallelGroupId: group.parallelGroup.id,
      fanoutItemKey: 'reviewer-codex-gpt-5',
      fanoutItemLabel: 'codex:gpt-5',
      required: true,
      evidenceRequired: true,
      options: {
        role: 'reviewer',
        runnerId: 'codex:gpt-5',
        artifactRoot: 'docs/quality/release-1',
        outputArtifact: 'reviews/codex-gpt-5.md',
        contextRequired: ['user_quality_principles', 'project_brief'],
      },
      now: 1782000000400,
    });
    assert.equal(reviewer.ok, true);
    assert.equal(reviewer.dispatches[0].targetParticipantId, 'codex:gpt-5');
    assert.equal(reviewer.dispatches[0].input.options.outputArtifact, 'reviews/codex-gpt-5.md');
    assert.equal(reviewer.workflowRun.nodes.find(node => node.id === reviewer.nodeId).parallelGroupId, group.parallelGroup.id);

    const dispatch = reviewer.dispatches[0];
    assert.ok(dispatch.nodeId);
    assert.equal(typeof dispatch.attempt, 'number');
    assert.ok(dispatch.handoffId);

    const nodeResult = hub.handleWorkflowNodeResult({
      workflowRunId: started.workflowRun.id,
      nodeId: reviewer.nodeId,
      attempt: dispatch.attempt,
      handoffId: dispatch.handoffId,
      fromAgent: 'codex:gpt-5',
      output: {
        summary: 'KualityForge review artifact written: reviews/codex-gpt-5.md',
        runnerId: 'codex:gpt-5',
        artifact: 'reviews/codex-gpt-5.md',
      },
      now: 1782000000500,
    });
    assert.equal(nodeResult.ok, true);
    const completedReviewer = nodeResult.workflowRun.nodes.find(node => node.id === reviewer.nodeId);
    assert.equal(completedReviewer.status, 'completed');

    const updatedGroup = nodeResult.workflowRun.parallelGroups.find(g => g.id === group.parallelGroup.id);
    assert.equal(updatedGroup.completedCount, 1);
    assert.equal(updatedGroup.failedCount, 0);
    assert.equal(updatedGroup.requiredFailedCount, 0);

    const completed = hub.completeScriptWorkflowRun(started.workflowRun.id, {
      terminal: { status: 'passed' },
      now: 1782000000600,
    });
    assert.equal(completed.ok, true);
    assert.equal(completed.workflowRun.status, 'completed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('completeScriptWorkflowRun stays strict: running reviewer node blocks completion as workflow_script_nodes_incomplete', () => {
  const dir = makeTempDir('strict-complete');
  try {
    const hub = createHub({ eventLogDir: join(dir, 'events'), silent: true });
    createActiveProject(hub);

    const proposal = hub.createScriptWorkflowProposal('proj-kualityforge', makeKualityForgePreview(), {
      requestedBy: 'codex',
      now: 1782000000100,
    });
    assert.equal(proposal.ok, true);

    const started = hub.startScriptWorkflowRunFromProposal(proposal.workflowProposal.id, {
      approvedBy: 'human',
      now: 1782000000200,
    });
    assert.equal(started.ok, true);

    const group = hub.beginWorkflowScriptParallelGroup(started.workflowRun.id, {
      phaseTitle: 'Parallel Review',
      label: 'KualityForge reviewer fan-out',
      primitiveId: 'reviewer-fanout',
      totalCount: 1,
      limit: 1,
      failurePolicy: 'required_all',
      now: 1782000000300,
    });
    assert.equal(group.ok, true);

    const reviewer = hub.dispatchWorkflowScriptAgentNode(started.workflowRun.id, {
      phaseTitle: 'Parallel Review',
      label: 'KualityForge review: codex:gpt-5',
      prompt: 'Write reviews/codex-gpt-5.md with a fenced kualityforge-review JSON block.',
      assignedAgent: 'codex:gpt-5',
      parallelGroupId: group.parallelGroup.id,
      fanoutItemKey: 'reviewer-codex-gpt-5',
      fanoutItemLabel: 'codex:gpt-5',
      required: true,
      now: 1782000000400,
    });
    assert.equal(reviewer.ok, true);

    // No node result written back: reviewer node is still running.
    const completed = hub.completeScriptWorkflowRun(started.workflowRun.id, {
      terminal: { status: 'passed' },
      now: 1782000000600,
    });
    assert.equal(completed.ok, false);
    assert.equal(completed.error, 'workflow_script_nodes_incomplete');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

let passed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    passed++;
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(err);
    process.exitCode = 1;
    break;
  }
}
if (process.exitCode !== 1) console.log(`\n${passed}/${tests.length} KualityForge workflow contract tests passed`);
