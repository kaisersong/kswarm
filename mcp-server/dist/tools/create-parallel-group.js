import { z } from 'zod';
export const createParallelGroupSchema = {
    projectId: z.string().describe('KSwarm project ID'),
    workflowRunId: z.string().describe('Workflow run ID'),
    phaseTitle: z.string().describe('Phase title (creates or reuses a phase with this title)'),
    label: z.string().optional().describe('Human-readable group label'),
    kind: z.enum(['parallel', 'pipeline']).default('parallel').describe('Group kind'),
    totalCount: z.number().int().default(0).describe('Expected total items'),
    limit: z.number().int().default(1).describe('Max concurrent items'),
    failurePolicy: z.enum(['required_all', 'collect_errors', 'fail_fast', 'quorum']).default('required_all').describe('How to handle failures'),
    quorum: z.number().int().optional().describe('Minimum successes for quorum policy'),
};
const schema = z.object(createParallelGroupSchema);
export async function handleCreateParallelGroup(httpClient, args) {
    const { projectId, workflowRunId, ...body } = args;
    const res = await httpClient.createParallelGroup(projectId, workflowRunId, body);
    return JSON.stringify(res, null, 2);
}
//# sourceMappingURL=create-parallel-group.js.map