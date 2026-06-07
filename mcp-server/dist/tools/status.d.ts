import { z } from 'zod';
import type { KSwarmHttpClient } from '../client/http-client.js';
export declare const statusSchema: {
    projectId: z.ZodString;
    workflowRunId: z.ZodString;
};
declare const schema: z.ZodObject<{
    projectId: z.ZodString;
    workflowRunId: z.ZodString;
}, "strip", z.ZodTypeAny, {
    workflowRunId: string;
    projectId: string;
}, {
    workflowRunId: string;
    projectId: string;
}>;
export declare function handleStatus(httpClient: KSwarmHttpClient, args: z.infer<typeof schema>): Promise<string>;
export {};
