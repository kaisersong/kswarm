import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { KSwarmHttpClient } from '../client/http-client.js';
import type { KSwarmWsClient } from '../client/ws-client.js';
import type { Config } from '../config.js';
import { waitForCompletion } from '../orchestrator/wait-for-completion.js';

export const runSchema = {
  projectId: z.string().describe('KSwarm project ID'),
  title: z.string().describe('Workflow title'),
  description: z.string().optional().describe('Workflow description'),
  phases: z.array(z.object({
    title: z.string(),
    nodes: z.array(z.object({
      label: z.string(),
      prompt: z.string(),
      assignedAgent: z.string().optional(),
      parallelGroup: z.string().optional().describe('Group label — nodes with same group run in parallel'),
      required: z.boolean().default(true),
    })),
  })).min(1).describe('Phases and their nodes'),
  failurePolicy: z.enum(['required_all', 'collect_errors', 'fail_fast', 'quorum']).default('required_all'),
  timeoutMs: z.number().int().min(5000).optional().describe('Maximum wait time in milliseconds (default 10min, min 5s)'),
};

const schema = z.object(runSchema);

export async function handleRun(
  httpClient: KSwarmHttpClient,
  wsClient: KSwarmWsClient,
  config: Config,
  args: z.infer<typeof schema>,
) {
  const startTime = Date.now();
  const timeoutMs = args.timeoutMs ?? config.timeoutMs;
  const workflowId = `mcp-run-${Date.now()}`;
  const scriptHash = createHash('sha256').update(JSON.stringify(args)).digest('hex');

  const healthy = await httpClient.healthCheck();
  if (!healthy) {
    throw new Error(`kswarm is not reachable at ${config.kswarmUrl}. Ensure kswarm is running.`);
  }

  const proposalRes = await httpClient.propose(args.projectId, {
    workflowId,
    title: args.title,
    description: args.description || args.title,
    phases: args.phases.map((p, i) => ({ id: `phase-${i}`, title: p.title })),
    scriptHash,
    requestedBy: 'mcp-client',
  });

  if (!proposalRes.ok || !proposalRes.workflowProposal) {
    throw new Error(`Failed to propose workflow: ${proposalRes.error || 'unknown error'}`);
  }

  const runRes = await httpClient.startRun(args.projectId, proposalRes.workflowProposal.id);
  if (!runRes.ok || !runRes.workflowRun) {
    throw new Error(`Failed to start workflow run: ${runRes.error || 'unknown error'}`);
  }

  const workflowRunId = runRes.workflowRun.id;

  for (const phase of args.phases) {
    const groups = new Map<string, string>();

    for (const node of phase.nodes) {
      if (node.parallelGroup && !groups.has(node.parallelGroup)) {
        const nodesInGroup = phase.nodes.filter(n => n.parallelGroup === node.parallelGroup);
        const pgRes = await httpClient.createParallelGroup(args.projectId, workflowRunId, {
          phaseTitle: phase.title,
          label: node.parallelGroup,
          kind: 'parallel',
          totalCount: nodesInGroup.length,
          limit: nodesInGroup.length,
          failurePolicy: args.failurePolicy,
        });
        if (!pgRes.ok || !pgRes.parallelGroup) {
          throw new Error(`Failed to create parallel group "${node.parallelGroup}": ${pgRes.error || 'unknown error'}`);
        }
        groups.set(node.parallelGroup, pgRes.parallelGroup.id);
      }
    }

    for (const node of phase.nodes) {
      const parallelGroupId = node.parallelGroup ? groups.get(node.parallelGroup) : undefined;
      const nodeRes = await httpClient.createNode(args.projectId, workflowRunId, {
        phaseTitle: phase.title,
        label: node.label,
        prompt: node.prompt,
        assignedAgent: node.assignedAgent,
        parallelGroupId,
        required: node.required,
      });
      if (!nodeRes.ok) {
        throw new Error(`Failed to create node "${node.label}": ${nodeRes.error || 'unknown error'}`);
      }
    }
  }

  const finalRun = await waitForCompletion(httpClient, wsClient, config, {
    projectId: args.projectId,
    workflowRunId,
    timeoutMs,
  });

  const agentNodes = finalRun.nodes.filter(n => n.kind === 'agent_task');
  const allCompleted = agentNodes.every(n => n.status === 'completed');
  const elapsed = Date.now() - startTime;
  const wasTimeout = finalRun.status === 'cancelled' && elapsed >= timeoutMs * 0.95;

  if (!wasTimeout && finalRun.status === 'running') {
    try {
      await httpClient.complete(args.projectId, workflowRunId, {
        result: { summary: `Workflow "${args.title}" completed. ${allCompleted ? 'All nodes passed.' : 'Some nodes failed or blocked.'}` },
        terminal: { status: allCompleted ? 'passed' : 'blocked' },
      });
    } catch {}
  }

  const nodes = agentNodes.map(n => ({
    nodeId: n.id,
    label: n.title,
    agent: n.assignedAgent || 'unknown',
    status: n.status,
    output: n.output || null,
  }));

  let status: string;
  if (allCompleted) status = 'completed';
  else if (wasTimeout) status = 'timeout';
  else if (finalRun.status === 'cancelled') status = 'cancelled';
  else status = 'failed';

  return JSON.stringify({
    workflowRunId,
    status,
    duration_ms: elapsed,
    nodes,
  }, null, 2);
}
