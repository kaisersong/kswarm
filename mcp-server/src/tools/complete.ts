import { z } from 'zod';
import type { KSwarmHttpClient } from '../client/http-client.js';

export const completeSchema = {
  projectId: z.string().describe('KSwarm project ID'),
  workflowRunId: z.string().describe('Workflow run ID'),
  result: z.record(z.unknown()).optional().describe('Final workflow output'),
  terminal: z.object({
    status: z.enum(['passed', 'blocked', 'needs_rework']).describe('Gate decision status'),
    reason: z.string().optional().describe('Reason for the decision'),
  }).optional().describe('Gate decision for the workflow'),
};

const schema = z.object(completeSchema);

export async function handleComplete(httpClient: KSwarmHttpClient, args: z.infer<typeof schema>) {
  const { projectId, workflowRunId, ...body } = args;
  const res = await httpClient.complete(projectId, workflowRunId, body);
  return JSON.stringify(res, null, 2);
}
