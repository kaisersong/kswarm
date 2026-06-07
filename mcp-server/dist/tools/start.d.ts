import { z } from 'zod';
import type { KSwarmHttpClient } from '../client/http-client.js';
export declare const startSchema: {
    projectId: z.ZodString;
    proposalId: z.ZodString;
    approvedBy: z.ZodDefault<z.ZodString>;
};
declare const schema: z.ZodObject<{
    projectId: z.ZodString;
    proposalId: z.ZodString;
    approvedBy: z.ZodDefault<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    projectId: string;
    proposalId: string;
    approvedBy: string;
}, {
    projectId: string;
    proposalId: string;
    approvedBy?: string | undefined;
}>;
export declare function handleStart(httpClient: KSwarmHttpClient, args: z.infer<typeof schema>): Promise<string>;
export {};
