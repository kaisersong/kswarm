import { z } from 'zod';
export const proposeSchema = {
    projectId: z.string().describe('KSwarm project ID'),
    workflowId: z.string().describe('Workflow identifier'),
    title: z.string().describe('Workflow title'),
    description: z.string().describe('Workflow description'),
    phases: z.array(z.object({
        id: z.string(),
        title: z.string(),
        detail: z.string().optional(),
    })).min(1).describe('Workflow phases'),
    scriptHash: z.string().describe('SHA-256 hash of the workflow script/spec'),
    scope: z.record(z.unknown()).optional().describe('Optional scope context'),
    requestedBy: z.string().default('mcp-client').describe('Who requested this workflow'),
};
const schema = z.object(proposeSchema);
export async function handlePropose(httpClient, args) {
    const { projectId, ...body } = args;
    const res = await httpClient.propose(projectId, body);
    return JSON.stringify(res, null, 2);
}
//# sourceMappingURL=propose.js.map