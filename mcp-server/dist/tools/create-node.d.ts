import { z } from 'zod';
import type { KSwarmHttpClient } from '../client/http-client.js';
export declare const createNodeSchema: {
    projectId: z.ZodString;
    workflowRunId: z.ZodString;
    phaseTitle: z.ZodString;
    label: z.ZodOptional<z.ZodString>;
    prompt: z.ZodString;
    assignedAgent: z.ZodOptional<z.ZodString>;
    parallelGroupId: z.ZodOptional<z.ZodString>;
    fanoutItemKey: z.ZodOptional<z.ZodString>;
    required: z.ZodDefault<z.ZodBoolean>;
    options: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    permissions: z.ZodOptional<z.ZodEffects<z.ZodObject<{
        deniedCommandIds: z.ZodOptional<z.ZodArray<z.ZodEnum<["git-diff", "git-stash"]>, "many">>;
        deniedCommands: z.ZodOptional<z.ZodArray<z.ZodEnum<["git diff", "git stash"]>, "many">>;
        toolCategories: z.ZodOptional<z.ZodArray<z.ZodEffects<z.ZodString, string, string>, "many">>;
    }, "strict", z.ZodTypeAny, {
        deniedCommandIds?: ("git-diff" | "git-stash")[] | undefined;
        deniedCommands?: ("git diff" | "git stash")[] | undefined;
        toolCategories?: string[] | undefined;
    }, {
        deniedCommandIds?: ("git-diff" | "git-stash")[] | undefined;
        deniedCommands?: ("git diff" | "git stash")[] | undefined;
        toolCategories?: string[] | undefined;
    }>, {
        deniedCommandIds?: ("git-diff" | "git-stash")[] | undefined;
        deniedCommands?: ("git diff" | "git stash")[] | undefined;
        toolCategories?: string[] | undefined;
    }, {
        deniedCommandIds?: ("git-diff" | "git-stash")[] | undefined;
        deniedCommands?: ("git diff" | "git stash")[] | undefined;
        toolCategories?: string[] | undefined;
    }>>;
};
declare const schema: z.ZodObject<{
    projectId: z.ZodString;
    workflowRunId: z.ZodString;
    phaseTitle: z.ZodString;
    label: z.ZodOptional<z.ZodString>;
    prompt: z.ZodString;
    assignedAgent: z.ZodOptional<z.ZodString>;
    parallelGroupId: z.ZodOptional<z.ZodString>;
    fanoutItemKey: z.ZodOptional<z.ZodString>;
    required: z.ZodDefault<z.ZodBoolean>;
    options: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    permissions: z.ZodOptional<z.ZodEffects<z.ZodObject<{
        deniedCommandIds: z.ZodOptional<z.ZodArray<z.ZodEnum<["git-diff", "git-stash"]>, "many">>;
        deniedCommands: z.ZodOptional<z.ZodArray<z.ZodEnum<["git diff", "git stash"]>, "many">>;
        toolCategories: z.ZodOptional<z.ZodArray<z.ZodEffects<z.ZodString, string, string>, "many">>;
    }, "strict", z.ZodTypeAny, {
        deniedCommandIds?: ("git-diff" | "git-stash")[] | undefined;
        deniedCommands?: ("git diff" | "git stash")[] | undefined;
        toolCategories?: string[] | undefined;
    }, {
        deniedCommandIds?: ("git-diff" | "git-stash")[] | undefined;
        deniedCommands?: ("git diff" | "git stash")[] | undefined;
        toolCategories?: string[] | undefined;
    }>, {
        deniedCommandIds?: ("git-diff" | "git-stash")[] | undefined;
        deniedCommands?: ("git diff" | "git stash")[] | undefined;
        toolCategories?: string[] | undefined;
    }, {
        deniedCommandIds?: ("git-diff" | "git-stash")[] | undefined;
        deniedCommands?: ("git diff" | "git stash")[] | undefined;
        toolCategories?: string[] | undefined;
    }>>;
}, "strip", z.ZodTypeAny, {
    workflowRunId: string;
    projectId: string;
    required: boolean;
    prompt: string;
    phaseTitle: string;
    options?: Record<string, unknown> | undefined;
    label?: string | undefined;
    assignedAgent?: string | undefined;
    parallelGroupId?: string | undefined;
    fanoutItemKey?: string | undefined;
    permissions?: {
        deniedCommandIds?: ("git-diff" | "git-stash")[] | undefined;
        deniedCommands?: ("git diff" | "git stash")[] | undefined;
        toolCategories?: string[] | undefined;
    } | undefined;
}, {
    workflowRunId: string;
    projectId: string;
    prompt: string;
    phaseTitle: string;
    required?: boolean | undefined;
    options?: Record<string, unknown> | undefined;
    label?: string | undefined;
    assignedAgent?: string | undefined;
    parallelGroupId?: string | undefined;
    fanoutItemKey?: string | undefined;
    permissions?: {
        deniedCommandIds?: ("git-diff" | "git-stash")[] | undefined;
        deniedCommands?: ("git diff" | "git stash")[] | undefined;
        toolCategories?: string[] | undefined;
    } | undefined;
}>;
export declare function handleCreateNode(httpClient: KSwarmHttpClient, args: z.infer<typeof schema>): Promise<string>;
export {};
