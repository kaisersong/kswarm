import { createHash } from 'node:crypto';
import type { KSwarmHttpClient } from '../client/http-client.js';
import type { KSwarmWsClient } from '../client/ws-client.js';
import type { Config } from '../config.js';
import type { WorkflowRun, FailurePolicy } from '../types.js';
import { waitForCompletion } from './wait-for-completion.js';

export interface ReviewInput {
  projectId: string;
  target: {
    files?: string[];
    diff?: string;
    scope?: string;
    context?: string;
  };
  dimensions: string[];
  agents?: number;
  assignedAgents?: string[];
  failurePolicy?: FailurePolicy;
  quorum?: number;
  timeoutMs?: number;
}

export interface ReviewResult {
  workflowRunId: string;
  status: 'completed' | 'failed' | 'cancelled' | 'timeout';
  duration_ms: number;
  reviews: Array<{
    nodeId: string;
    agent: string;
    dimension: string;
    status: string;
    output: Record<string, unknown> | null;
  }>;
  summary: {
    total: number;
    completed: number;
    failed: number;
    blocked: number;
    consensusReached: boolean;
  };
}

export async function runReview(
  httpClient: KSwarmHttpClient,
  wsClient: KSwarmWsClient,
  config: Config,
  input: ReviewInput,
): Promise<ReviewResult> {
  const startTime = Date.now();
  const timeoutMs = input.timeoutMs ?? config.timeoutMs;
  const agentCount = input.agents ?? input.dimensions.length;
  const failurePolicy = input.failurePolicy ?? 'required_all';
  const assignedAgents = input.assignedAgents?.length ? input.assignedAgents : undefined;

  const workflowId = `mcp-review-${Date.now()}`;
  const scriptHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');

  const healthy = await httpClient.healthCheck();
  if (!healthy) {
    throw new Error(`kswarm is not reachable at ${config.kswarmUrl}. Ensure kswarm is running.`);
  }

  const proposalRes = await httpClient.propose(input.projectId, {
    workflowId,
    title: `MCP Multi-Agent Review (${input.dimensions.join(', ')})`,
    description: `Parallel review with ${agentCount} agents across dimensions: ${input.dimensions.join(', ')}`,
    phases: [{ id: 'review-phase', title: 'Parallel Review' }],
    scriptHash,
    requestedBy: 'mcp-client',
  });

  if (!proposalRes.ok || !proposalRes.workflowProposal) {
    throw new Error(`Failed to propose workflow: ${proposalRes.error || 'unknown error'}`);
  }

  const runRes = await httpClient.startRun(input.projectId, proposalRes.workflowProposal.id);
  if (!runRes.ok || !runRes.workflowRun) {
    throw new Error(`Failed to start workflow run: ${runRes.error || 'unknown error'}`);
  }

  const workflowRunId = runRes.workflowRun.id;

  const pgRes = await httpClient.createParallelGroup(input.projectId, workflowRunId, {
    phaseTitle: 'Parallel Review',
    label: 'Review Agents',
    kind: 'parallel',
    totalCount: agentCount,
    limit: agentCount,
    failurePolicy,
    quorum: input.quorum,
  });

  if (!pgRes.ok || !pgRes.parallelGroup) {
    throw new Error(`Failed to create parallel group: ${pgRes.error || 'unknown error'}`);
  }

  const parallelGroupId = pgRes.parallelGroup.id;
  const targetDescription = buildTargetDescription(input.target);

  for (let i = 0; i < agentCount; i++) {
    const dimension = input.dimensions[i % input.dimensions.length];
    const prompt = buildReviewPrompt(dimension, targetDescription, input.target.context);
    const agent = assignedAgents?.[i % assignedAgents.length];

    const nodeRes = await httpClient.createNode(input.projectId, workflowRunId, {
      phaseTitle: 'Parallel Review',
      label: `${dimension} Review`,
      prompt,
      assignedAgent: agent,
      parallelGroupId,
      required: true,
      evidenceRequired: true,
      outputSchema: {
        type: 'object',
        required: ['summary', 'reviewDecision'],
        properties: {
          summary: { type: 'string' },
          reviewDecision: {
            type: 'object',
            required: ['status', 'reason'],
            properties: {
              status: { type: 'string', enum: ['passed', 'needs_rework', 'blocked'] },
              reason: { type: 'string' },
            },
          },
          findings: { type: 'array', items: { type: 'object' } },
          evidenceRefs: { type: 'array', items: { type: 'string' } },
        },
      },
    });

    if (!nodeRes.ok) {
      throw new Error(`Failed to create review node for dimension "${dimension}": ${nodeRes.error || 'unknown error'}`);
    }
  }

  const finalRun = await waitForCompletion(httpClient, wsClient, config, {
    projectId: input.projectId,
    workflowRunId,
    timeoutMs,
  });

  const isTimeout = finalRun.status === 'cancelled' &&
    (finalRun as unknown as Record<string, unknown>).cancelReason === 'mcp_timeout';

  if (!isTimeout && !(['completed', 'failed', 'blocked', 'cancelled'].includes(finalRun.status))) {
    try {
      const allCompleted = finalRun.nodes
        .filter(n => n.kind === 'agent_task')
        .every(n => n.status === 'completed');
      await httpClient.complete(input.projectId, workflowRunId, {
        result: { summary: `Review completed. ${allCompleted ? 'All reviewers passed.' : 'Some reviewers failed or blocked.'}` },
        terminal: { status: allCompleted ? 'passed' : 'blocked' },
      });
    } catch {}
  }

  return buildReviewResult(workflowRunId, finalRun, input.dimensions, startTime, timeoutMs);
}

function buildTargetDescription(target: ReviewInput['target']): string {
  const parts: string[] = [];
  if (target.files?.length) parts.push(`Files: ${target.files.join(', ')}`);
  if (target.diff) parts.push(`Diff:\n${target.diff}`);
  if (target.scope) parts.push(`Scope: ${target.scope}`);
  return parts.join('\n\n');
}

function buildReviewPrompt(dimension: string, targetDescription: string, context?: string): string {
  let prompt = `You are a code reviewer. Review the following target for the dimension: **${dimension}**.

## Target
${targetDescription}`;

  if (context) {
    prompt += `\n\n## Additional Context\n${context}`;
  }

  prompt += `\n\n## Instructions
- Focus specifically on the "${dimension}" dimension.
- Provide a structured response with:
  - summary: A brief overall assessment
  - reviewDecision: { status: "passed" | "needs_rework" | "blocked", reason: "..." }
  - findings: Array of specific issues found (if any)
  - evidenceRefs: References to specific code locations`;

  return prompt;
}

function buildReviewResult(
  workflowRunId: string,
  run: WorkflowRun,
  dimensions: string[],
  startTime: number,
  timeoutMs: number,
): ReviewResult {
  const reviews = run.nodes
    .filter(n => n.kind === 'agent_task')
    .map((n, i) => ({
      nodeId: n.id,
      agent: n.assignedAgent || 'unknown',
      dimension: dimensions[i % dimensions.length],
      status: n.status,
      output: n.output || null,
    }));

  const completed = reviews.filter(r => r.status === 'completed').length;
  const failed = reviews.filter(r => r.status === 'failed').length;
  const blocked = reviews.filter(r => r.status === 'blocked').length;
  const elapsed = Date.now() - startTime;

  let status: ReviewResult['status'];
  if (run.status === 'completed' || (run.status === 'running' && completed === reviews.length)) {
    status = 'completed';
  } else if (run.status === 'cancelled' && elapsed >= timeoutMs * 0.95) {
    status = 'timeout';
  } else if (run.status === 'cancelled') {
    status = 'cancelled';
  } else {
    status = 'failed';
  }

  return {
    workflowRunId,
    status,
    duration_ms: elapsed,
    reviews,
    summary: {
      total: reviews.length,
      completed,
      failed,
      blocked,
      consensusReached: completed === reviews.length,
    },
  };
}
