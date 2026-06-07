import { z } from 'zod';
import type { KSwarmHttpClient } from '../client/http-client.js';
import type { KSwarmWsClient } from '../client/ws-client.js';
import type { Config } from '../config.js';
export declare const reviewSchema: {
    projectId: z.ZodString;
    target: z.ZodObject<{
        files: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        diff: z.ZodOptional<z.ZodString>;
        scope: z.ZodOptional<z.ZodString>;
        context: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        files?: string[] | undefined;
        diff?: string | undefined;
        scope?: string | undefined;
        context?: string | undefined;
    }, {
        files?: string[] | undefined;
        diff?: string | undefined;
        scope?: string | undefined;
        context?: string | undefined;
    }>;
    dimensions: z.ZodArray<z.ZodString, "many">;
    agents: z.ZodOptional<z.ZodNumber>;
    assignedAgents: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    failurePolicy: z.ZodDefault<z.ZodEnum<["required_all", "collect_errors", "fail_fast", "quorum"]>>;
    quorum: z.ZodOptional<z.ZodNumber>;
    timeoutMs: z.ZodOptional<z.ZodNumber>;
};
declare const schema: z.ZodObject<{
    projectId: z.ZodString;
    target: z.ZodObject<{
        files: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        diff: z.ZodOptional<z.ZodString>;
        scope: z.ZodOptional<z.ZodString>;
        context: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        files?: string[] | undefined;
        diff?: string | undefined;
        scope?: string | undefined;
        context?: string | undefined;
    }, {
        files?: string[] | undefined;
        diff?: string | undefined;
        scope?: string | undefined;
        context?: string | undefined;
    }>;
    dimensions: z.ZodArray<z.ZodString, "many">;
    agents: z.ZodOptional<z.ZodNumber>;
    assignedAgents: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    failurePolicy: z.ZodDefault<z.ZodEnum<["required_all", "collect_errors", "fail_fast", "quorum"]>>;
    quorum: z.ZodOptional<z.ZodNumber>;
    timeoutMs: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    projectId: string;
    target: {
        files?: string[] | undefined;
        diff?: string | undefined;
        scope?: string | undefined;
        context?: string | undefined;
    };
    dimensions: string[];
    failurePolicy: "required_all" | "collect_errors" | "fail_fast" | "quorum";
    quorum?: number | undefined;
    timeoutMs?: number | undefined;
    agents?: number | undefined;
    assignedAgents?: string[] | undefined;
}, {
    projectId: string;
    target: {
        files?: string[] | undefined;
        diff?: string | undefined;
        scope?: string | undefined;
        context?: string | undefined;
    };
    dimensions: string[];
    quorum?: number | undefined;
    timeoutMs?: number | undefined;
    agents?: number | undefined;
    assignedAgents?: string[] | undefined;
    failurePolicy?: "required_all" | "collect_errors" | "fail_fast" | "quorum" | undefined;
}>;
export declare function handleReview(httpClient: KSwarmHttpClient, wsClient: KSwarmWsClient, config: Config, args: z.infer<typeof schema>): Promise<string>;
export {};
