import type { KSwarmHttpClient } from '../client/http-client.js';
import type { KSwarmWsClient } from '../client/ws-client.js';
import type { WorkflowRun } from '../types.js';
import type { Config } from '../config.js';
export interface WaitOptions {
    projectId: string;
    workflowRunId: string;
    timeoutMs: number;
}
export declare function waitForCompletion(httpClient: KSwarmHttpClient, wsClient: KSwarmWsClient, config: Config, options: WaitOptions): Promise<WorkflowRun>;
