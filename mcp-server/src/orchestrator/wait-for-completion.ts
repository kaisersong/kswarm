import type { KSwarmHttpClient } from '../client/http-client.js';
import type { KSwarmWsClient } from '../client/ws-client.js';
import type { WorkflowRun, WorkflowNode } from '../types.js';
import type { Config } from '../config.js';

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'blocked', 'cancelled']);
const NODE_TERMINAL_STATUSES = new Set(['completed', 'failed', 'blocked', 'cancelled']);

export interface WaitOptions {
  projectId: string;
  workflowRunId: string;
  timeoutMs: number;
}

function allAgentTasksSettled(run: WorkflowRun): boolean {
  const agentNodes = run.nodes.filter(n => n.kind === 'agent_task');
  return agentNodes.length > 0 && agentNodes.every(n => NODE_TERMINAL_STATUSES.has(n.status));
}

function isSettled(run: WorkflowRun): boolean {
  if (TERMINAL_STATUSES.has(run.status)) return true;
  return allAgentTasksSettled(run);
}

export async function waitForCompletion(
  httpClient: KSwarmHttpClient,
  wsClient: KSwarmWsClient,
  config: Config,
  options: WaitOptions,
): Promise<WorkflowRun> {
  const { projectId, workflowRunId, timeoutMs } = options;
  const effectiveTimeout = Math.max(timeoutMs, 5000);

  wsClient.connect();

  return new Promise<WorkflowRun>((resolve, reject) => {
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    let unsubscribe: (() => void) | null = null;
    let settled = false;

    const cleanup = () => {
      if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
      if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null; }
      if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    };

    const settle = (run: WorkflowRun) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(run);
    };

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const schedulePoll = () => {
      if (settled) return;
      pollTimer = setTimeout(async () => {
        if (settled) return;
        try {
          const res = await httpClient.getStatus(projectId, workflowRunId);
          if (settled) return;
          if (res.ok && res.workflowRun && isSettled(res.workflowRun)) {
            settle(res.workflowRun);
            return;
          }
          if (!res.ok && res.error === 'run_not_found') {
            fail(new Error(`Workflow run ${workflowRunId} not found`));
            return;
          }
        } catch {}
        schedulePoll();
      }, config.pollIntervalMs);
    };

    unsubscribe = wsClient.subscribe(workflowRunId, (event) => {
      if (settled) return;
      const run = event.workflowRun as WorkflowRun | undefined;
      if (run && isSettled(run)) {
        settle(run);
      }
    });

    timeoutTimer = setTimeout(async () => {
      if (settled) return;
      try {
        await httpClient.cancel(projectId, workflowRunId, 'mcp_timeout');
      } catch {}
      if (settled) return;
      const res = await httpClient.getStatus(projectId, workflowRunId).catch(() => null);
      if (settled) return;
      if (res?.workflowRun) {
        settle(res.workflowRun);
      } else {
        fail(new Error(`Timeout waiting for workflow ${workflowRunId}`));
      }
    }, effectiveTimeout);

    schedulePoll();
  });
}
