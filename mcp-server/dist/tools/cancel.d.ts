import { z } from 'zod';
import type { KSwarmHttpClient } from '../client/http-client.js';
export declare const cancelSchema: {
    projectId: z.ZodString;
    workflowRunId: z.ZodString;
    reason: z.ZodDefault<z.ZodString>;
};
declare const schema: z.ZodObject<{
    projectId: z.ZodString;
    workflowRunId: z.ZodString;
    reason: z.ZodDefault<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    workflowRunId: string;
    projectId: string;
    reason: string;
}, {
    workflowRunId: string;
    projectId: string;
    reason?: string | undefined;
}>;
export declare function handleCancel(httpClient: KSwarmHttpClient, args: z.infer<typeof schema>): Promise<string>;
export {};
