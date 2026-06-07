import type { Config } from '../config.js';
import type { WorkflowRun, WorkflowProposal, ParallelGroup } from '../types.js';
export declare class KSwarmHttpClient {
    private config;
    private baseUrl;
    constructor(config: Config);
    healthCheck(): Promise<boolean>;
    propose(projectId: string, body: {
        workflowId: string;
        title: string;
        description: string;
        phases: Array<{
            id: string;
            title: string;
            detail?: string;
        }>;
        scriptHash: string;
        scope?: Record<string, unknown>;
        requestedBy?: string;
    }): Promise<{
        ok: boolean;
        workflowProposal?: WorkflowProposal;
        error?: string;
    }>;
    startRun(projectId: string, proposalId: string, approvedBy?: string): Promise<{
        ok: boolean;
        workflowRun?: WorkflowRun;
        error?: string;
    }>;
    createParallelGroup(projectId: string, workflowRunId: string, body: {
        phaseTitle: string;
        label?: string;
        kind?: string;
        totalCount?: number;
        limit?: number;
        failurePolicy?: string;
        quorum?: number;
    }): Promise<{
        ok: boolean;
        parallelGroup?: ParallelGroup;
        workflowRun?: WorkflowRun;
        error?: string;
    }>;
    createNode(projectId: string, workflowRunId: string, body: {
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
    }): Promise<{
        ok: boolean;
        nodeId?: string;
        workflowRun?: WorkflowRun;
        dispatches?: unknown[];
        error?: string;
    }>;
    submitResult(projectId: string, workflowRunId: string, nodeId: string, body: {
        output: Record<string, unknown>;
        fromAgent?: string;
        attempt?: number;
        handoffId?: string;
    }): Promise<{
        ok: boolean;
        workflowRun?: WorkflowRun;
        error?: string;
    }>;
    complete(projectId: string, workflowRunId: string, body?: {
        result?: Record<string, unknown>;
        terminal?: {
            status: string;
            reason?: string;
        };
    }): Promise<{
        ok: boolean;
        workflowRun?: WorkflowRun;
        error?: string;
    }>;
    getStatus(projectId: string, workflowRunId: string): Promise<{
        ok: boolean;
        workflowRun?: WorkflowRun;
        error?: string;
    }>;
    cancel(projectId: string, workflowRunId: string, reason?: string): Promise<{
        ok: boolean;
        error?: string;
    }>;
    private get;
    private post;
    private fetchWithTimeout;
    private parseResponse;
}
