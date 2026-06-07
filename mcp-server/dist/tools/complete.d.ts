import { z } from 'zod';
import type { KSwarmHttpClient } from '../client/http-client.js';
export declare const completeSchema: {
    projectId: z.ZodString;
    workflowRunId: z.ZodString;
    result: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    terminal: z.ZodOptional<z.ZodObject<{
        status: z.ZodEnum<["passed", "blocked", "needs_rework"]>;
        reason: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        status: "blocked" | "passed" | "needs_rework";
        reason?: string | undefined;
    }, {
        status: "blocked" | "passed" | "needs_rework";
        reason?: string | undefined;
    }>>;
};
declare const schema: z.ZodObject<{
    projectId: z.ZodString;
    workflowRunId: z.ZodString;
    result: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    terminal: z.ZodOptional<z.ZodObject<{
        status: z.ZodEnum<["passed", "blocked", "needs_rework"]>;
        reason: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        status: "blocked" | "passed" | "needs_rework";
        reason?: string | undefined;
    }, {
        status: "blocked" | "passed" | "needs_rework";
        reason?: string | undefined;
    }>>;
}, "strip", z.ZodTypeAny, {
    workflowRunId: string;
    projectId: string;
    result?: Record<string, unknown> | undefined;
    terminal?: {
        status: "blocked" | "passed" | "needs_rework";
        reason?: string | undefined;
    } | undefined;
}, {
    workflowRunId: string;
    projectId: string;
    result?: Record<string, unknown> | undefined;
    terminal?: {
        status: "blocked" | "passed" | "needs_rework";
        reason?: string | undefined;
    } | undefined;
}>;
export declare function handleComplete(httpClient: KSwarmHttpClient, args: z.infer<typeof schema>): Promise<string>;
export {};
