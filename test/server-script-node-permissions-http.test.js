/**
 * Script workflow node permissions — real HTTP chain.
 *
 * The other permissions tests are either source-string matches or unit tests of
 * a pure module. Neither proves the field survives the actual request path, so
 * this one runs a real server on a temporary port and HOME and drives the whole
 * chain: HTTP body -> hub -> node.input -> dispatch -> the prompt auto-worker
 * hands to the runner CLI.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { composeNodePrompt } from '../src/core/workflow-node-permissions.js';

let total = 0;
let passed = 0;
let failed = 0;
const failures = [];

const MUTATION_TOKEN = 'test-mutation-token';

function assert(cond, msg) {
  total++;
  if (cond) {
    passed++;
    console.log(`    ✓ ${msg}`);
  } else {
    failed++;
    failures.push(msg);
    console.log(`    ✗ FAIL: ${msg}`);
  }
}

async function getFreePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitForServer(baseUrl, child) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10_000) {
    if (child.exitCode !== null) throw new Error(`server exited early: ${child.exitCode}`);
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return;
    } catch {
      // keep polling
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('server did not start');
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    new Promise(resolve => setTimeout(resolve, 1500)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function postJson(baseUrl, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-kswarm-mutation-token': MUTATION_TOKEN,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  return { res, data };
}

function makeKualityForgePreview(projectId) {
  return {
    ok: true,
    workflowId: 'kualityforge_quality_gate',
    source: 'script_generated',
    strategy: 'workflow',
    status: 'pending_confirmation',
    projectId,
    scope: { projectId, qualityRunId: 'release-1', artifactRoot: 'docs/quality/release-1' },
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

console.log('\n╔═══════════════════════════════════════════════════╗');
console.log('║   KSwarm — Script Node Permissions over HTTP      ║');
console.log('╚═══════════════════════════════════════════════════╝');

const tempHome = mkdtempSync(join(tmpdir(), 'kswarm-node-permissions-'));
const port = await getFreePort();
const baseUrl = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['src/server/index.js'], {
  cwd: new URL('..', import.meta.url),
  env: {
    ...process.env,
    HOME: tempHome,
    KSWARM_PORT: String(port),
    BROKER_URL: 'http://127.0.0.1:9',
    KSWARM_DESKTOP_MUTATION_TOKEN: MUTATION_TOKEN,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const logs = [];
child.stdout.on('data', chunk => logs.push(String(chunk)));
child.stderr.on('data', chunk => logs.push(String(chunk)));

try {
  await waitForServer(baseUrl, child);

  const created = await postJson(baseUrl, '/projects', {
    name: 'KualityForge permissions chain',
    goal: 'Prove node permissions survive the HTTP request path',
    poAgent: 'xiaok-po',
    members: ['codex:gpt-5', 'claude:sonnet'],
    autoStartPlanning: false,
  });
  assert(created.res.status < 400, `project create succeeds (got ${created.res.status})`);
  const projectId = created.data?.project?.id || created.data?.id;
  assert(Boolean(projectId), 'project create returns an id');

  const tasks = await postJson(baseUrl, `/projects/${projectId}/tasks/human`, {
    tasks: [{ title: '执行质量门禁', assignedAgent: 'codex:gpt-5' }],
  });
  assert(tasks.data?.ok === true, 'human tasks added');

  // No project approval here: /approve needs live planning agents, and the
  // script workflow dispatch path under test does not depend on it. Project
  // lifecycle is covered by the hub-level contract tests.

  const proposal = await postJson(baseUrl, `/projects/${projectId}/workflows/script-generated/proposal`, {
    preview: makeKualityForgePreview(projectId),
    requestedBy: 'codex',
  });
  assert(proposal.data?.ok === true, 'script workflow proposal created');
  const proposalId = proposal.data?.workflowProposal?.id;

  const started = await postJson(baseUrl, `/projects/${projectId}/workflows/script-generated/runs`, {
    proposalId,
    approvedBy: 'human',
  });
  assert(started.data?.ok === true, 'script workflow run started');
  const runId = started.data?.workflowRun?.id;

  const group = await postJson(baseUrl, `/projects/${projectId}/workflows/${runId}/script/parallel-groups`, {
    phaseTitle: 'Parallel Review',
    label: 'KualityForge reviewer fan-out',
    primitiveId: 'reviewer-fanout',
    totalCount: 1,
    limit: 1,
    failurePolicy: 'required_all',
  });
  assert(group.data?.ok === true, 'parallel group opened');
  const parallelGroupId = group.data?.parallelGroup?.id;

  // The payload shape KualityForge's createKswarmReviewerNodeInput emits. Its
  // own suite guards that shape; this asserts KSwarm does not drop it.
  const node = await postJson(baseUrl, `/projects/${projectId}/workflows/${runId}/script/nodes`, {
    phaseTitle: 'Parallel Review',
    label: 'Review: codex:gpt-5',
    prompt: 'Review the frozen changeset and write your findings.',
    assignedAgent: 'codex:gpt-5',
    parallelGroupId,
    options: { runnerId: 'codex:gpt-5', artifactRoot: 'docs/quality/release-1' },
    permissions: {
      allowShell: true,
      allowWrite: false,
      allowNetwork: false,
      allowRenderer: false,
      deniedCommands: ['git diff'],
    },
  });
  assert(node.res.status === 201, `script node dispatch returns 201 (got ${node.res.status})`);

  const nodeId = node.data?.nodeId;
  const persisted = node.data?.workflowRun?.nodes?.find(entry => entry.id === nodeId);
  assert(
    persisted?.input?.permissions?.deniedCommands?.includes('git diff'),
    'permissions.deniedCommands survives the HTTP body whitelist into node.input',
  );
  assert(persisted?.input?.permissions?.allowShell === true, 'boolean permissions survive into node.input');

  const dispatchInput = node.data?.dispatches?.[0]?.input;
  assert(
    dispatchInput?.permissions?.deniedCommands?.includes('git diff'),
    'permissions reach the dispatch handed to the runner',
  );

  // Final link: the exact string auto-worker passes to the agent CLI.
  const { prompt } = composeNodePrompt(dispatchInput);
  assert(prompt.includes('Review the frozen changeset'), 'runner prompt keeps the node instructions');
  for (const command of dispatchInput.permissions.deniedCommands) {
    assert(prompt.includes(command), `runner prompt carries denied command: ${command}`);
  }

  // Negative control: a node that declares no permissions must not grow a
  // denied-command section, otherwise the assertions above prove nothing.
  const plainNode = await postJson(baseUrl, `/projects/${projectId}/workflows/${runId}/script/nodes`, {
    phaseTitle: 'Parallel Review',
    label: 'Review: claude:sonnet',
    prompt: 'Review the frozen changeset without a permissions declaration.',
    assignedAgent: 'claude:sonnet',
    options: { runnerId: 'claude:sonnet' },
  });
  assert(plainNode.res.status === 201, `permissionless node dispatch returns 201 (got ${plainNode.res.status})`);
  const plainInput = plainNode.data?.dispatches?.[0]?.input;
  assert(plainInput?.permissions === null, 'a node without permissions normalizes to null');
  assert(!composeNodePrompt(plainInput).prompt.includes('git diff'), 'permissionless prompt gains no denial section');
} catch (err) {
  failed++;
  failures.push(err.message || String(err));
  console.error(err);
  console.error(logs.join('').slice(-4000));
} finally {
  await stopServer(child);
  rmSync(tempHome, { recursive: true, force: true });
}

console.log(`\n${passed}/${total} script node permissions HTTP tests passed`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
