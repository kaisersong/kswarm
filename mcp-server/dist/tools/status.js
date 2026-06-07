import { z } from 'zod';
export const statusSchema = {
    projectId: z.string().describe('KSwarm project ID'),
    workflowRunId: z.string().describe('Workflow run ID'),
};
const schema = z.object(statusSchema);
export async function handleStatus(httpClient, args) {
    const res = await httpClient.getStatus(args.projectId, args.workflowRunId);
    return JSON.stringify(res, null, 2);
}
//# sourceMappingURL=status.js.map