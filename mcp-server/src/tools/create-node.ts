import { z } from 'zod';
import type { KSwarmHttpClient } from '../client/http-client.js';

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
};

const schema = z.object(createNodeSchema);

export async function handleCreateNode(httpClient: KSwarmHttpClient, args: z.infer<typeof schema>) {
  const { projectId, workflowRunId, ...body } = args;
  const res = await httpClient.createNode(projectId, workflowRunId, body);
  return JSON.stringify(res, null, 2);
}
