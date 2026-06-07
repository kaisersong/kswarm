import { z } from 'zod';
import type { KSwarmHttpClient } from '../client/http-client.js';
import type { KSwarmWsClient } from '../client/ws-client.js';
import type { Config } from '../config.js';
export declare const runSchema: {
    projectId: z.ZodString;
    title: z.ZodString;
    description: z.ZodOptional<z.ZodString>;
    phases: z.ZodArray<z.ZodObject<{
        title: z.ZodString;
        nodes: z.ZodArray<z.ZodObject<{
            label: z.ZodString;
            prompt: z.ZodString;
            assignedAgent: z.ZodOptional<z.ZodString>;
            parallelGroup: z.ZodOptional<z.ZodString>;
            required: z.ZodDefault<z.ZodBoolean>;
        }, "strip", z.ZodTypeAny, {
            required: boolean;
            label: string;
            prompt: string;
            assignedAgent?: string | undefined;
            parallelGroup?: string | undefined;
        }, {
            label: string;
            prompt: string;
            required?: boolean | undefined;
            assignedAgent?: string | undefined;
            parallelGroup?: string | undefined;
        }>, "many">;
    }, "strip", z.ZodTypeAny, {
        title: string;
        nodes: {
            required: boolean;
            label: string;
            prompt: string;
            assignedAgent?: string | undefined;
            parallelGroup?: string | undefined;
        }[];
    }, {
        title: string;
        nodes: {
            label: string;
            prompt: string;
            required?: boolean | undefined;
            assignedAgent?: string | undefined;
            parallelGroup?: string | undefined;
        }[];
    }>, "many">;
    failurePolicy: z.ZodDefault<z.ZodEnum<["required_all", "collect_errors", "fail_fast", "quorum"]>>;
    timeoutMs: z.ZodOptional<z.ZodNumber>;
};
declare const schema: z.ZodObject<{
    projectId: z.ZodString;
    title: z.ZodString;
    description: z.ZodOptional<z.ZodString>;
    phases: z.ZodArray<z.ZodObject<{
        title: z.ZodString;
        nodes: z.ZodArray<z.ZodObject<{
            label: z.ZodString;
            prompt: z.ZodString;
            assignedAgent: z.ZodOptional<z.ZodString>;
            parallelGroup: z.ZodOptional<z.ZodString>;
            required: z.ZodDefault<z.ZodBoolean>;
        }, "strip", z.ZodTypeAny, {
            required: boolean;
            label: string;
            prompt: string;
            assignedAgent?: string | undefined;
            parallelGroup?: string | undefined;
        }, {
            label: string;
            prompt: string;
            required?: boolean | undefined;
            assignedAgent?: string | undefined;
            parallelGroup?: string | undefined;
        }>, "many">;
    }, "strip", z.ZodTypeAny, {
        title: string;
        nodes: {
            required: boolean;
            label: string;
            prompt: string;
            assignedAgent?: string | undefined;
            parallelGroup?: string | undefined;
        }[];
    }, {
        title: string;
        nodes: {
            label: string;
            prompt: string;
            required?: boolean | undefined;
            assignedAgent?: string | undefined;
            parallelGroup?: string | undefined;
        }[];
    }>, "many">;
    failurePolicy: z.ZodDefault<z.ZodEnum<["required_all", "collect_errors", "fail_fast", "quorum"]>>;
    timeoutMs: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    projectId: string;
    failurePolicy: "required_all" | "collect_errors" | "fail_fast" | "quorum";
    title: string;
    phases: {
        title: string;
        nodes: {
            required: boolean;
            label: string;
            prompt: string;
            assignedAgent?: string | undefined;
            parallelGroup?: string | undefined;
        }[];
    }[];
    timeoutMs?: number | undefined;
    description?: string | undefined;
}, {
    projectId: string;
    title: string;
    phases: {
        title: string;
        nodes: {
            label: string;
            prompt: string;
            required?: boolean | undefined;
            assignedAgent?: string | undefined;
            parallelGroup?: string | undefined;
        }[];
    }[];
    timeoutMs?: number | undefined;
    failurePolicy?: "required_all" | "collect_errors" | "fail_fast" | "quorum" | undefined;
    description?: string | undefined;
}>;
export declare function handleRun(httpClient: KSwarmHttpClient, wsClient: KSwarmWsClient, config: Config, args: z.infer<typeof schema>): Promise<string>;
export {};
