import { z } from 'zod';
export const cancelSchema = {
    projectId: z.string().describe('KSwarm project ID'),
    workflowRunId: z.string().describe('Workflow run ID'),
    reason: z.string().default('mcp_client_cancelled').describe('Cancellation reason'),
};
const schema = z.object(cancelSchema);
export async function handleCancel(httpClient, args) {
    const res = await httpClient.cancel(args.projectId, args.workflowRunId, args.reason);
    return JSON.stringify(res, null, 2);
}
//# sourceMappingURL=cancel.js.map