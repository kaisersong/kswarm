import { z } from 'zod';
export const submitResultSchema = {
    projectId: z.string().describe('KSwarm project ID'),
    workflowRunId: z.string().describe('Workflow run ID'),
    nodeId: z.string().describe('Node ID to submit result for'),
    output: z.record(z.unknown()).describe('The node output/result payload'),
    fromAgent: z.string().optional().describe('Agent that produced the result'),
    attempt: z.number().int().optional().describe('Attempt number'),
    handoffId: z.string().optional().describe('Handoff ID'),
};
const schema = z.object(submitResultSchema);
export async function handleSubmitResult(httpClient, args) {
    const { projectId, workflowRunId, nodeId, ...body } = args;
    const res = await httpClient.submitResult(projectId, workflowRunId, nodeId, body);
    return JSON.stringify(res, null, 2);
}
//# sourceMappingURL=submit-result.js.map