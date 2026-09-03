import { z } from 'zod';
const deniedCommandId = z.enum(['git-diff', 'git-stash']);
const deniedCommandLabel = z.enum(['git diff', 'git stash']);
const deniedCommandLabels = {
    'git-diff': 'git diff',
    'git-stash': 'git stash',
};
const boundedTrimmedString = z.string().refine(value => value === value.trim() && value.length >= 1 && value.length <= 64, 'must be trimmed and contain 1..64 characters');
const permissionsSchema = z.object({
    deniedCommandIds: z.array(deniedCommandId).min(1).max(16).optional(),
    deniedCommands: z.array(deniedCommandLabel).min(1).max(16).optional(),
    toolCategories: z.array(boundedTrimmedString).min(1).max(32).optional(),
}).strict().superRefine((permissions, ctx) => {
    if (permissions.deniedCommandIds === undefined &&
        permissions.deniedCommands === undefined &&
        permissions.toolCategories === undefined) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'permissions must declare at least one restriction',
        });
    }
    if (permissions.deniedCommands === undefined)
        return;
    const expected = permissions.deniedCommandIds?.map(id => deniedCommandLabels[id]);
    if (!expected ||
        expected.length !== permissions.deniedCommands.length ||
        expected.some((label, index) => label !== permissions.deniedCommands?.[index])) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['deniedCommands'],
            message: 'deniedCommands must match deniedCommandIds in order',
        });
    }
});
export const createNodeSchema = {
    projectId: z.string().describe('KSwarm project ID'),
    workflowRunId: z.string().describe('Workflow run ID'),
    phaseTitle: z.string().describe('Phase title'),
    label: z.string().optional().describe('Node label'),
    prompt: z.string().describe('Prompt/instructions for the agent'),
    assignedAgent: z.string().optional().describe('Agent ID to assign'),
    parallelGroupId: z.string().optional().describe('Parallel group to add this node to'),
    fanoutItemKey: z.string().optional().describe('Fanout item key for multi-item iteration'),
    required: z.boolean().default(true).describe('Whether this node is required for completion'),
    options: z.record(z.unknown()).optional().describe('Additional options for the agent'),
    permissions: permissionsSchema.optional().describe('Advisory node restrictions using canonical command IDs'),
};
const schema = z.object(createNodeSchema);
export async function handleCreateNode(httpClient, args) {
    const { projectId, workflowRunId, ...body } = args;
    const res = await httpClient.createNode(projectId, workflowRunId, body);
    return JSON.stringify(res, null, 2);
}
//# sourceMappingURL=create-node.js.map