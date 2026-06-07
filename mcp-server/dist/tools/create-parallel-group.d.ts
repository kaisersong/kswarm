import { z } from 'zod';
import type { KSwarmHttpClient } from '../client/http-client.js';
export declare const createParallelGroupSchema: {
    projectId: z.ZodString;
    workflowRunId: z.ZodString;
    phaseTitle: z.ZodString;
    label: z.ZodOptional<z.ZodString>;
    kind: z.ZodDefault<z.ZodEnum<["parallel", "pipeline"]>>;
    totalCount: z.ZodDefault<z.ZodNumber>;
    limit: z.ZodDefault<z.ZodNumber>;
    failurePolicy: z.ZodDefault<z.ZodEnum<["required_all", "collect_errors", "fail_fast", "quorum"]>>;
    quorum: z.ZodOptional<z.ZodNumber>;
};
declare const schema: z.ZodObject<{
    projectId: z.ZodString;
    workflowRunId: z.ZodString;
    phaseTitle: z.ZodString;
    label: z.ZodOptional<z.ZodString>;
    kind: z.ZodDefault<z.ZodEnum<["parallel", "pipeline"]>>;
    totalCount: z.ZodDefault<z.ZodNumber>;
    limit: z.ZodDefault<z.ZodNumber>;
    failurePolicy: z.ZodDefault<z.ZodEnum<["required_all", "collect_errors", "fail_fast", "quorum"]>>;
    quorum: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    workflowRunId: string;
    projectId: string;
    failurePolicy: "required_all" | "collect_errors" | "fail_fast" | "quorum";
    phaseTitle: string;
    kind: "parallel" | "pipeline";
    totalCount: number;
    limit: number;
    quorum?: number | undefined;
    label?: string | undefined;
}, {
    workflowRunId: string;
    projectId: string;
    phaseTitle: string;
    quorum?: number | undefined;
    failurePolicy?: "required_all" | "collect_errors" | "fail_fast" | "quorum" | undefined;
    label?: string | undefined;
    kind?: "parallel" | "pipeline" | undefined;
    totalCount?: number | undefined;
    limit?: number | undefined;
}>;
export declare function handleCreateParallelGroup(httpClient: KSwarmHttpClient, args: z.infer<typeof schema>): Promise<string>;
export {};
