/**
 * Dynamic workflow scriptSource persistence + conversational recovery tests.
 *
 * Covers Part A (persist scriptSource through proposal -> run -> save/load) and
 * Part B (resumable-run listing, script_workflow intervention synthesis, and
 * recoverInterruptedTaskWorkflows never cancelling script_generated runs).
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHub } from '../src/core/hub.js';
import { normalizeAndHashWorkflowScript } from '../src/core/workflow-script-source.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function makeTempDir(label = 'workflow-script-recovery') {
  return mkdtempSync(join(tmpdir(), `kswarm-${label}-`));
}

const SCRIPT_SOURCE = 'export const meta = { name: "dynamic_project_diagnosis" };\nphase("scan");\nphase("summarize");';
const { source: NORMALIZED_SOURCE, scriptHash: SCRIPT_HASH } = normalizeAndHashWorkflowScript(SCRIPT_SOURCE);

function createActiveProject(hub, id = 'proj-script') {
  const project = hub.createProject({
    id,
    name: '动态脚本工作流项目',
    goal: '验证脚本生成的动态 workflow 恢复',
    poAgent: 'xiaok-po',
    members: ['xiaok-worker'],
  });
  const added = hub.handleHumanAddTasks(id, [
    { title: '整理项目现状', assignedAgent: 'xiaok-worker' },
  ]);
  assert.equal(added.ok, true);
  assert.equal(hub.handleApprove(id).ok, true);
  return project;
}

function makePreview(projectId = 'proj-script') {
  return {
    ok: true,
    workflowId: 'dynamic_project_diagnosis',
    source: 'script_generated',
    strategy: 'workflow',
    status: 'pending_confirmation',
    projectId,
    scope: { projectId },
    requestedBy: 'human',
    createdAt: 1780000000000,
    title: '动态项目诊断',
    description: '读取项目状态，动态派发诊断任务并汇总结论。',
    meta: {
      name: 'dynamic_project_diagnosis',
      description: '读取项目状态，动态派发诊断任务并汇总结论。',
      phases: [{ title: '扫描项目状态' }, { title: '汇总结论' }],
    },
    phases: [
      { id: 'phase-1', title: '扫描项目状态', detail: null },
      { id: 'phase-2', title: '汇总结论', detail: null },
    ],
    scriptHash: SCRIPT_HASH,
    analysis: {
      agentCallCount: 2,
      phaseCallCount: 2,
      parallelCallCount: 1,
      pipelineCallCount: 0,
      requestUserInputCallCount: 0,
      runtimePhaseTitles: ['扫描项目状态', '汇总结论'],
    },
  };
}

test('createScriptWorkflowProposal persists normalized scriptSource', () => {
  const dir = makeTempDir('proposal-source');
  try {
    const hub = createHub({ eventLogDir: join(dir, 'events'), silent: true });
    createActiveProject(hub);
    const proposal = hub.createScriptWorkflowProposal('proj-script', makePreview(), {
      requestedBy: 'human',
      scriptSource: SCRIPT_SOURCE,
      now: 1780000000100,
    });
    assert.equal(proposal.ok, true);
    assert.equal(proposal.workflowProposal.scriptSource, NORMALIZED_SOURCE);
    assert.equal(proposal.workflowProposal.scriptHash, SCRIPT_HASH);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('createScriptWorkflowProposal rejects scriptSource whose hash mismatches preview', () => {
  const dir = makeTempDir('proposal-mismatch');
  try {
    const hub = createHub({ eventLogDir: join(dir, 'events'), silent: true });
    createActiveProject(hub);
    const proposal = hub.createScriptWorkflowProposal('proj-script', makePreview(), {
      requestedBy: 'human',
      scriptSource: 'export const meta = { name: "tampered" };\nphase("x");',
      now: 1780000000100,
    });
    assert.equal(proposal.ok, false);
    assert.equal(proposal.error, 'workflow_script_source_hash_mismatch');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('startScriptWorkflowRunFromProposal carries scriptSource onto the run', () => {
  const dir = makeTempDir('run-source');
  try {
    const hub = createHub({ eventLogDir: join(dir, 'events'), silent: true });
    createActiveProject(hub);
    const proposal = hub.createScriptWorkflowProposal('proj-script', makePreview(), {
      requestedBy: 'human',
      scriptSource: SCRIPT_SOURCE,
      now: 1780000000100,
    });
    const started = hub.startScriptWorkflowRunFromProposal(proposal.workflowProposal.id, {
      approvedBy: 'human',
      now: 1780000000200,
    });
    assert.equal(started.ok, true);
    assert.equal(started.workflowRun.scriptSource, NORMALIZED_SOURCE);
    assert.equal(started.workflowRun.scriptHash, SCRIPT_HASH);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('save then load preserves scriptSource on the workflow run', async () => {
  const dir = makeTempDir('persist-source');
  const dataDir = join(dir, 'state.json');
  try {
    const hub = createHub({ eventLogDir: join(dir, 'events'), dataDir, silent: true });
    createActiveProject(hub);
    const proposal = hub.createScriptWorkflowProposal('proj-script', makePreview(), {
      requestedBy: 'human',
      scriptSource: SCRIPT_SOURCE,
      now: 1780000000100,
    });
    const started = hub.startScriptWorkflowRunFromProposal(proposal.workflowProposal.id, {
      approvedBy: 'human',
      now: 1780000000200,
    });
    hub.persistState();
    await new Promise(resolve => setTimeout(resolve, 650));

    const restored = createHub({ eventLogDir: join(dir, 'events2'), dataDir, silent: true });
    const restoredRun = restored.getWorkflowRun(started.workflowRun.id);
    assert.ok(restoredRun);
    assert.equal(restoredRun.scriptSource, NORMALIZED_SOURCE);
    assert.equal(restoredRun.scriptHash, SCRIPT_HASH);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('listResumableScriptWorkflowRuns returns running runs that have scriptSource', () => {
  const dir = makeTempDir('list-resumable');
  try {
    const hub = createHub({ eventLogDir: join(dir, 'events'), silent: true });
    createActiveProject(hub);
    const proposal = hub.createScriptWorkflowProposal('proj-script', makePreview(), {
      requestedBy: 'human',
      scriptSource: SCRIPT_SOURCE,
      now: 1780000000100,
    });
    const started = hub.startScriptWorkflowRunFromProposal(proposal.workflowProposal.id, {
      approvedBy: 'human',
      now: 1780000000200,
    });
    const resumable = hub.listResumableScriptWorkflowRuns('proj-script');
    assert.equal(resumable.length, 1);
    assert.equal(resumable[0].workflowRunId, started.workflowRun.id);
    assert.equal(resumable[0].scriptSource, NORMALIZED_SOURCE);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('deriveScriptWorkflowIntervention synthesises a resume_workflow action', () => {
  const dir = makeTempDir('intervention');
  try {
    const hub = createHub({ eventLogDir: join(dir, 'events'), silent: true });
    createActiveProject(hub);
    const proposal = hub.createScriptWorkflowProposal('proj-script', makePreview(), {
      requestedBy: 'human',
      scriptSource: SCRIPT_SOURCE,
      now: 1780000000100,
    });
    const started = hub.startScriptWorkflowRunFromProposal(proposal.workflowProposal.id, {
      approvedBy: 'human',
      now: 1780000000200,
    });
    const intervention = hub.deriveScriptWorkflowIntervention('proj-script');
    assert.ok(intervention);
    assert.equal(intervention.required, true);
    assert.equal(intervention.kind, 'script_workflow');
    assert.equal(intervention.workflowRunId, started.workflowRun.id);
    assert.equal(intervention.primaryAction.strategy, 'resume_workflow');
    assert.equal(intervention.primaryAction.toolName, 'run_dynamic_workflow_script');
    assert.equal(intervention.primaryAction.params.resumeWorkflowRunId, started.workflowRun.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('getProjectIntervention surfaces script_workflow when there is no task intervention', () => {
  const dir = makeTempDir('intervention-merge');
  try {
    const hub = createHub({ eventLogDir: join(dir, 'events'), silent: true });
    createActiveProject(hub);
    const proposal = hub.createScriptWorkflowProposal('proj-script', makePreview(), {
      requestedBy: 'human',
      scriptSource: SCRIPT_SOURCE,
      now: 1780000000100,
    });
    hub.startScriptWorkflowRunFromProposal(proposal.workflowProposal.id, {
      approvedBy: 'human',
      now: 1780000000200,
    });
    const intervention = hub.getProjectIntervention('proj-script');
    assert.ok(intervention);
    assert.equal(intervention.kind, 'script_workflow');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recoverInterruptedTaskWorkflows never cancels script runs and reports resumable ones', () => {
  const dir = makeTempDir('recover');
  try {
    const hub = createHub({ eventLogDir: join(dir, 'events'), silent: true });
    createActiveProject(hub);
    const proposal = hub.createScriptWorkflowProposal('proj-script', makePreview(), {
      requestedBy: 'human',
      scriptSource: SCRIPT_SOURCE,
      now: 1780000000100,
    });
    const started = hub.startScriptWorkflowRunFromProposal(proposal.workflowProposal.id, {
      approvedBy: 'human',
      now: 1780000000200,
    });
    const result = hub.recoverInterruptedTaskWorkflows({ now: 1780000000300 });
    assert.equal(result.ok, true);
    assert.ok(Array.isArray(result.resumableScriptRuns));
    assert.equal(result.resumableScriptRuns.length, 1);
    assert.equal(result.resumableScriptRuns[0].workflowRunId, started.workflowRun.id);
    assert.equal(result.resumableScriptRuns[0].hasScriptSource, true);
    // The run must remain running (not cancelled).
    assert.equal(hub.getWorkflowRun(started.workflowRun.id).status, 'running');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

let passed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    passed += 1;
    console.log(`\u2713 ${name}`);
  } catch (error) {
    console.error(`\u2717 ${name}`);
    console.error(error);
    process.exitCode = 1;
    break;
  }
}
if (process.exitCode !== 1) console.log(`\n${passed}/${tests.length} workflow script recovery tests passed`);
