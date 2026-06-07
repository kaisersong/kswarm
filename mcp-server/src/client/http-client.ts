import type { Config } from '../config.js';
import type { WorkflowRun, WorkflowProposal, ParallelGroup } from '../types.js';

const REQUEST_TIMEOUT_MS = 30_000;

function enc(segment: string): string {
  return encodeURIComponent(segment);
}

export class KSwarmHttpClient {
  private baseUrl: string;

  constructor(private config: Config) {
    this.baseUrl = config.kswarmUrl;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await this.fetchWithTimeout(`${this.baseUrl}/health`);
      return res.ok;
    } catch {
      return false;
    }
  }

  async propose(projectId: string, body: {
    workflowId: string;
    title: string;
    description: string;
    phases: Array<{ id: string; title: string; detail?: string }>;
    scriptHash: string;
    scope?: Record<string, unknown>;
    requestedBy?: string;
  }): Promise<{ ok: boolean; workflowProposal?: WorkflowProposal; error?: string }> {
    const preview = {
      ok: true,
      source: 'script_generated',
      strategy: 'workflow',
      projectId,
      ...body,
    };
    return this.post(`/projects/${enc(projectId)}/workflows/script-generated/proposal`, preview);
  }

  async startRun(projectId: string, proposalId: string, approvedBy = 'mcp-client'): Promise<{ ok: boolean; workflowRun?: WorkflowRun; error?: string }> {
    return this.post(`/projects/${enc(projectId)}/workflows/script-generated/runs`, { proposalId, approvedBy });
  }

  async createParallelGroup(projectId: string, workflowRunId: string, body: {
    phaseTitle: string;
    label?: string;
    kind?: string;
    totalCount?: number;
    limit?: number;
    failurePolicy?: string;
    quorum?: number;
  }): Promise<{ ok: boolean; parallelGroup?: ParallelGroup; workflowRun?: WorkflowRun; error?: string }> {
    return this.post(`/projects/${enc(projectId)}/workflows/${enc(workflowRunId)}/script/parallel-groups`, body);
  }

  async createNode(projectId: string, workflowRunId: string, body: {
    phaseTitle: string;
    label?: string;
    prompt: string;
    assignedAgent?: string;
    parallelGroupId?: string;
    fanoutItemKey?: string;
    required?: boolean;
    options?: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
    evidenceRequired?: boolean;
  }): Promise<{ ok: boolean; nodeId?: string; workflowRun?: WorkflowRun; dispatches?: unknown[]; error?: string }> {
    return this.post(`/projects/${enc(projectId)}/workflows/${enc(workflowRunId)}/script/nodes`, body);
  }

  async submitResult(projectId: string, workflowRunId: string, nodeId: string, body: {
    output: Record<string, unknown>;
    fromAgent?: string;
    attempt?: number;
    handoffId?: string;
  }): Promise<{ ok: boolean; workflowRun?: WorkflowRun; error?: string }> {
    return this.post(`/projects/${enc(projectId)}/workflows/${enc(workflowRunId)}/script/nodes/${enc(nodeId)}/result`, body);
  }

  async complete(projectId: string, workflowRunId: string, body?: {
    result?: Record<string, unknown>;
    terminal?: { status: string; reason?: string };
  }): Promise<{ ok: boolean; workflowRun?: WorkflowRun; error?: string }> {
    return this.post(`/projects/${enc(projectId)}/workflows/${enc(workflowRunId)}/script/complete`, body || {});
  }

  async getStatus(projectId: string, workflowRunId: string): Promise<{ ok: boolean; workflowRun?: WorkflowRun; error?: string }> {
    return this.get(`/projects/${enc(projectId)}/workflows/${enc(workflowRunId)}`);
  }

  async cancel(projectId: string, workflowRunId: string, reason = 'mcp_client_cancelled'): Promise<{ ok: boolean; error?: string }> {
    return this.post(`/projects/${enc(projectId)}/workflows/${enc(workflowRunId)}/cancel`, { reason });
  }

  private async get<T>(path: string): Promise<T> {
    const res = await this.fetchWithTimeout(`${this.baseUrl}${path}`);
    return this.parseResponse<T>(res);
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await this.fetchWithTimeout(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return this.parseResponse<T>(res);
  }

  private async fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  private async parseResponse<T>(res: Response): Promise<T> {
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`kswarm API error (${res.status}): ${text.slice(0, 200)}`);
    }
    if (!res.ok) {
      const err = parsed as { error?: string };
      if (err?.error) {
        return parsed as T;
      }
      throw new Error(`kswarm API error (${res.status}): ${text.slice(0, 200)}`);
    }
    return parsed as T;
  }
}
