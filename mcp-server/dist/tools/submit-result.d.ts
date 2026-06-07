import { z } from 'zod';
import type { KSwarmHttpClient } from '../client/http-client.js';
export declare const submitResultSchema: {
    projectId: z.ZodString;
    workflowRunId: z.ZodString;
    nodeId: z.ZodString;
    output: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    fromAgent: z.ZodOptional<z.ZodString>;
    attempt: z.ZodOptional<z.ZodNumber>;
    handoffId: z.ZodOptional<z.ZodString>;
};
declare const schema: z.ZodObject<{
    projectId: z.ZodString;
    workflowRunId: z.ZodString;
    nodeId: z.ZodString;
    output: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    fromAgent: z.ZodOptional<z.ZodString>;
    attempt: z.ZodOptional<z.ZodNumber>;
    handoffId: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    workflowRunId: string;
    projectId: string;
    nodeId: string;
    output: Record<string, unknown>;
    fromAgent?: string | undefined;
    attempt?: number | undefined;
    handoffId?: string | undefined;
}, {
    workflowRunId: string;
    projectId: string;
    nodeId: string;
    output: Record<string, unknown>;
    fromAgent?: string | undefined;
    attempt?: number | undefined;
    handoffId?: string | undefined;
}>;
export declare function handleSubmitResult(httpClient: KSwarmHttpClient, args: z.infer<typeof schema>): Promise<string>;
export {};
