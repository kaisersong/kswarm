import { z } from 'zod';
export const startSchema = {
    projectId: z.string().describe('KSwarm project ID'),
    proposalId: z.string().describe('Workflow proposal ID to start'),
    approvedBy: z.string().default('mcp-client').describe('Who approved the workflow'),
};
const schema = z.object(startSchema);
export async function handleStart(httpClient, args) {
    const res = await httpClient.startRun(args.projectId, args.proposalId, args.approvedBy);
    return JSON.stringify(res, null, 2);
}
//# sourceMappingURL=start.js.map