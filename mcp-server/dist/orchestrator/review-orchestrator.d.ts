import type { KSwarmHttpClient } from '../client/http-client.js';
import type { KSwarmWsClient } from '../client/ws-client.js';
import type { Config } from '../config.js';
import type { FailurePolicy } from '../types.js';
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
export declare function runReview(httpClient: KSwarmHttpClient, wsClient: KSwarmWsClient, config: Config, input: ReviewInput): Promise<ReviewResult>;
