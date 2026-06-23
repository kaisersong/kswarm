/**
 * KSwarm — workflow upstream output handoff tests
 *
 * Run: node test/workflow-upstream-output.test.js
 */

import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHub } from '../src/core/hub.js';
import { sanitizeWorkflowNodeOutput } from '../src/core/workflow-spec.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function makeTempDir(suffix) {
  const dir = join(tmpdir(), `kswarm-upstream-${suffix}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function createActiveProject(hub, id = 'proj-upstream') {
  hub.createProject({ id, name: 'Test', goal: 'test upstream', members: ['worker-1'] });
  hub.handleHumanAddTasks(id, [{ title: 'placeholder', description: 'x' }]);
  hub.handleApprove(id);
}

function makePreview(projectId = 'proj-upstream') {
  return {
    ok: true,
    workflowId: 'upstream_test_workflow',
    source: 'script_generated',
    strategy: 'workflow',
    status: 'pending_confirmation',
    projectId,
    scope: { projectId },
    requestedBy: 'human',
    createdAt: 1780000000000,
    title: 'Upstream Test Workflow',
    description: 'Test upstream output handoff.',
    meta: {
      name: 'upstream_test',
      description: 'Test upstream output handoff.',
      phases: [{ title: 'Research' }, { title: 'Compile' }],
    },
    phases: [
      { id: 'phase-1', title: 'Research', detail: null },
      { id: 'phase-2', title: 'Compile', detail: null },
    ],
    scriptHash: 'upstream-test-hash-001',
    analysis: {
      agentCallCount: 2,
      phaseCallCount: 2,
      parallelCallCount: 0,
      pipelineCallCount: 0,
      requestUserInputCallCount: 0,
      runtimePhaseTitles: ['Research', 'Compile'],
    },
  };
}

function setupScriptWorkflow(hub, projectId = 'proj-upstream') {
  createActiveProject(hub, projectId);
  const proposal = hub.createScriptWorkflowProposal(projectId, makePreview(projectId), {
    requestedBy: 'human', now: 1780000000100,
  });
  if (!proposal.ok) throw new Error(`createScriptWorkflowProposal failed: ${proposal.error}`);
  const started = hub.startScriptWorkflowRunFromProposal(proposal.workflowProposal.id, {
    approvedBy: 'human', now: 1780000000200,
  });
  if (!started.ok) throw new Error(`startScriptWorkflowRunFromProposal failed: ${started.error}`);
  return started.workflowRun;
}

// ═══════════════════════════════════════════════════════════════
// Core: upstream output injection
// ═══════════════════════════════════════════════════════════════

test('script node with dependsOn gets upstreamOutputs from completed dependency', () => {
  const dir = makeTempDir('deps');
  try {
    const hub = createHub({ eventLogDir: join(dir, 'events'), silent: true });
    const run = setupScriptWorkflow(hub);

    // Create research node (no deps)
    const research = hub.dispatchWorkflowScriptAgentNode(run.id, {
      phaseTitle: 'Research', label: 'Research AI', prompt: 'Research AI safety', now: 1780000000300,
    });
    assert.ok(research.ok);

    // Complete research with output
    hub.handleWorkflowNodeResult({
      workflowRunId: run.id, nodeId: research.nodeId, attempt: 1,
      handoffId: research.dispatches[0]?.handoffId || `wfhd-${run.id}-${research.nodeId}-1`,
      fromAgent: 'worker-1',
      output: { summary: 'Found 3 key insights about AI safety regulations.', artifacts: [{ path: 'artifacts/research.md' }] },
      now: 1780000000400,
    });

    // Create compile node depending on research
    const compile = hub.dispatchWorkflowScriptAgentNode(run.id, {
      phaseTitle: 'Compile', label: 'Compile Report', prompt: 'Compile findings into report',
      dependsOn: [research.nodeId], now: 1780000000500,
    });
    assert.ok(compile.ok);

    // compile node should be pending (waiting for research to complete — but it already is)
    // After refreshReadiness it should be ready and dispatched
    const dispatch = compile.dispatches[0];
    assert.ok(dispatch, 'should dispatch immediately since dependency is completed');
    assert.ok(dispatch.input.upstreamOutputs, 'should have upstreamOutputs');
    assert.ok(dispatch.input.upstreamOutputs[research.nodeId], 'should reference research node');
    assert.equal(dispatch.input.upstreamOutputs[research.nodeId].summary, 'Found 3 key insights about AI safety regulations.');
    assert.deepEqual(dispatch.input.upstreamOutputs[research.nodeId].artifactPaths, ['artifacts/research.md']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('no dependsOn → no upstreamOutputs field', () => {
  const dir = makeTempDir('nodeps');
  try {
    const hub = createHub({ eventLogDir: join(dir, 'events'), silent: true });
    const run = setupScriptWorkflow(hub);

    const result = hub.dispatchWorkflowScriptAgentNode(run.id, {
      phaseTitle: 'Solo', label: 'Solo Task', prompt: 'Do something alone', now: 1780000000300,
    });
    assert.ok(result.ok);
    const dispatch = result.dispatches[0];
    assert.equal(dispatch.input.upstreamOutputs, undefined, 'no deps → no upstreamOutputs');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('short summary (< 10 chars) excluded from compact output', () => {
  const dir = makeTempDir('shortsummary');
  try {
    const hub = createHub({ eventLogDir: join(dir, 'events'), silent: true });
    const run = setupScriptWorkflow(hub);

    const a = hub.dispatchWorkflowScriptAgentNode(run.id, {
      phaseTitle: 'Step1', label: 'A', prompt: 'Do A', now: 1780000000300,
    });
    hub.handleWorkflowNodeResult({
      workflowRunId: run.id, nodeId: a.nodeId, attempt: 1,
      handoffId: a.dispatches[0]?.handoffId || `wfhd-${run.id}-${a.nodeId}-1`,
      fromAgent: 'worker-1',
      output: { summary: 'Done.', artifacts: [{ path: 'out.md' }] },
      now: 1780000000400,
    });

    const b = hub.dispatchWorkflowScriptAgentNode(run.id, {
      phaseTitle: 'Step2', label: 'B', prompt: 'Do B', dependsOn: [a.nodeId], now: 1780000000500,
    });
    const upstream = b.dispatches[0]?.input?.upstreamOutputs?.[a.nodeId];
    assert.ok(upstream, 'should still have entry (has artifactPaths)');
    assert.equal(upstream.summary, undefined, 'short summary excluded');
    assert.deepEqual(upstream.artifactPaths, ['out.md']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('empty summary + no artifacts → node skipped from upstreamOutputs', () => {
  const dir = makeTempDir('emptysummary');
  try {
    const hub = createHub({ eventLogDir: join(dir, 'events'), silent: true });
    const run = setupScriptWorkflow(hub);

    const a = hub.dispatchWorkflowScriptAgentNode(run.id, {
      phaseTitle: 'Step1', label: 'A', prompt: 'Do A', now: 1780000000300,
    });
    hub.handleWorkflowNodeResult({
      workflowRunId: run.id, nodeId: a.nodeId, attempt: 1,
      handoffId: a.dispatches[0]?.handoffId || `wfhd-${run.id}-${a.nodeId}-1`,
      fromAgent: 'worker-1',
      output: { summary: '' },
      now: 1780000000400,
    });

    const b = hub.dispatchWorkflowScriptAgentNode(run.id, {
      phaseTitle: 'Step2', label: 'B', prompt: 'Do B', dependsOn: [a.nodeId], now: 1780000000500,
    });
    const dispatch = b.dispatches[0];
    assert.equal(dispatch?.input?.upstreamOutputs, undefined, 'useless output not injected');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ═══════════════════════════════════════════════════════════════
// Sanitize
// ═══════════════════════════════════════════════════════════════

test('sanitizeWorkflowNodeOutput removes upstreamOutputs', () => {
  const output = { summary: 'ok', upstreamOutputs: { a: { summary: 'leaked' } }, customField: 42 };
  const sanitized = sanitizeWorkflowNodeOutput(output);
  assert.equal(sanitized.upstreamOutputs, undefined);
  assert.equal(sanitized.customField, 42);
  assert.ok(sanitized.rejectedMutations.includes('upstreamOutputs'));
});

// ═══════════════════════════════════════════════════════════════
// Persistence: node.input should not contain upstreamOutputs
// ═══════════════════════════════════════════════════════════════

test('persisted node.input does not contain upstreamOutputs', () => {
  const dir = makeTempDir('persist');
  try {
    const hub = createHub({ eventLogDir: join(dir, 'events'), silent: true });
    const run = setupScriptWorkflow(hub);

    const a = hub.dispatchWorkflowScriptAgentNode(run.id, {
      phaseTitle: 'Step1', label: 'A', prompt: 'Do A', now: 1780000000300,
    });
    hub.handleWorkflowNodeResult({
      workflowRunId: run.id, nodeId: a.nodeId, attempt: 1,
      handoffId: a.dispatches[0]?.handoffId || `wfhd-${run.id}-${a.nodeId}-1`,
      fromAgent: 'worker-1',
      output: { summary: 'Research completed with detailed analysis of the problem.' },
      now: 1780000000400,
    });

    const b = hub.dispatchWorkflowScriptAgentNode(run.id, {
      phaseTitle: 'Step2', label: 'B', prompt: 'Compile', dependsOn: [a.nodeId], now: 1780000000500,
    });
    assert.ok(b.dispatches[0]?.input?.upstreamOutputs, 'dispatch should have upstreamOutputs');

    // Check persisted state
    const finalRun = hub.getWorkflowRun(run.id);
    const nodeB = finalRun.nodes.find(n => n.id === b.nodeId);
    assert.equal(nodeB?.input?.upstreamOutputs, undefined, 'persisted node.input stripped');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ═══════════════════════════════════════════════════════════════
// dispatchWorkflowScriptAgentNode dependsOn parameter
// ═══════════════════════════════════════════════════════════════

test('dispatchWorkflowScriptAgentNode without dependsOn → node dispatched immediately', () => {
  const dir = makeTempDir('compat');
  try {
    const hub = createHub({ eventLogDir: join(dir, 'events'), silent: true });
    const run = setupScriptWorkflow(hub);

    const result = hub.dispatchWorkflowScriptAgentNode(run.id, {
      phaseTitle: 'Solo', label: 'Task', prompt: 'Do it', now: 1780000000300,
    });
    assert.ok(result.ok);
    assert.equal(result.dispatches.length, 1, 'immediately dispatched');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('dispatchWorkflowScriptAgentNode with dependsOn on incomplete node → pending, not dispatched', () => {
  const dir = makeTempDir('pending');
  try {
    const hub = createHub({ eventLogDir: join(dir, 'events'), silent: true });
    const run = setupScriptWorkflow(hub);

    const a = hub.dispatchWorkflowScriptAgentNode(run.id, {
      phaseTitle: 'Step1', label: 'A', prompt: 'Do A', now: 1780000000300,
    });

    // Create B depending on A (which is running, not completed)
    const b = hub.dispatchWorkflowScriptAgentNode(run.id, {
      phaseTitle: 'Step2', label: 'B', prompt: 'Do B', dependsOn: [a.nodeId], now: 1780000000400,
    });
    assert.ok(b.ok);
    assert.equal(b.dispatches.length, 0, 'not dispatched yet — dependency not completed');

    const updatedRun = hub.getWorkflowRun(run.id);
    const nodeB = updatedRun.nodes.find(n => n.id === b.nodeId);
    assert.equal(nodeB.status, 'pending');
    assert.deepEqual(nodeB.dependsOn, [a.nodeId]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ═══════════════════════════════════════════════════════════════
// Run all
// ═══════════════════════════════════════════════════════════════

let passed = 0;
let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`✗ ${name}`);
    console.error(err.message || err);
    failed++;
  }
}
console.log(`\n${passed}/${passed + failed} workflow upstream output tests passed`);
if (failed > 0) process.exit(1);
