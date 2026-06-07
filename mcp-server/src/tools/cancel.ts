import { z } from 'zod';
import type { KSwarmHttpClient } from '../client/http-client.js';

export const cancelSchema = {
  projectId: z.string().describe('KSwarm project ID'),
  workflowRunId: z.string().describe('Workflow run ID'),
  reason: z.string().default('mcp_client_cancelled').describe('Cancellation reason'),
};

const schema = z.object(cancelSchema);

export async function handleCancel(httpClient: KSwarmHttpClient, args: z.infer<typeof schema>) {
  const res = await httpClient.cancel(args.projectId, args.workflowRunId, args.reason);
  return JSON.stringify(res, null, 2);
}
