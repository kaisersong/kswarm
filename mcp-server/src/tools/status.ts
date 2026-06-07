import { z } from 'zod';
import type { KSwarmHttpClient } from '../client/http-client.js';

export const statusSchema = {
  projectId: z.string().describe('KSwarm project ID'),
  workflowRunId: z.string().describe('Workflow run ID'),
};

const schema = z.object(statusSchema);

export async function handleStatus(httpClient: KSwarmHttpClient, args: z.infer<typeof schema>) {
  const res = await httpClient.getStatus(args.projectId, args.workflowRunId);
  return JSON.stringify(res, null, 2);
}
