import { z } from 'zod';
import type { KSwarmHttpClient } from '../client/http-client.js';
export declare const proposeSchema: {
    projectId: z.ZodString;
    workflowId: z.ZodString;
    title: z.ZodString;
    description: z.ZodString;
    phases: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        title: z.ZodString;
        detail: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        title: string;
        detail?: string | undefined;
    }, {
        id: string;
        title: string;
        detail?: string | undefined;
    }>, "many">;
    scriptHash: z.ZodString;
    scope: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    requestedBy: z.ZodDefault<z.ZodString>;
};
declare const schema: z.ZodObject<{
    projectId: z.ZodString;
    workflowId: z.ZodString;
    title: z.ZodString;
    description: z.ZodString;
    phases: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        title: z.ZodString;
        detail: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        title: string;
        detail?: string | undefined;
    }, {
        id: string;
        title: string;
        detail?: string | undefined;
    }>, "many">;
    scriptHash: z.ZodString;
    scope: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    requestedBy: z.ZodDefault<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    projectId: string;
    title: string;
    description: string;
    phases: {
        id: string;
        title: string;
        detail?: string | undefined;
    }[];
    workflowId: string;
    scriptHash: string;
    requestedBy: string;
    scope?: Record<string, unknown> | undefined;
}, {
    projectId: string;
    title: string;
    description: string;
    phases: {
        id: string;
        title: string;
        detail?: string | undefined;
    }[];
    workflowId: string;
    scriptHash: string;
    scope?: Record<string, unknown> | undefined;
    requestedBy?: string | undefined;
}>;
export declare function handlePropose(httpClient: KSwarmHttpClient, args: z.infer<typeof schema>): Promise<string>;
export {};
