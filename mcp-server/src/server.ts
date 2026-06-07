import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { KSwarmHttpClient } from './client/http-client.js';
import { KSwarmWsClient } from './client/ws-client.js';
import { reviewSchema, handleReview } from './tools/review.js';
import { runSchema, handleRun } from './tools/run.js';
import { proposeSchema, handlePropose } from './tools/propose.js';
import { startSchema, handleStart } from './tools/start.js';
import { createParallelGroupSchema, handleCreateParallelGroup } from './tools/create-parallel-group.js';
import { createNodeSchema, handleCreateNode } from './tools/create-node.js';
import { submitResultSchema, handleSubmitResult } from './tools/submit-result.js';
import { completeSchema, handleComplete } from './tools/complete.js';
import { statusSchema, handleStatus } from './tools/status.js';
import { cancelSchema, handleCancel } from './tools/cancel.js';

const config = loadConfig();
const httpClient = new KSwarmHttpClient(config);
const wsClient = new KSwarmWsClient(config);

const server = new McpServer(
  { name: 'kswarm-workflow', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.tool(
  'workflow/review',
  'Run a multi-agent parallel review. Creates a dynamic workflow with N reviewer agents running in parallel, waits for all to complete, returns aggregated results. Blocks until done (default timeout 10min).',
  reviewSchema,
  async (args) => {
    try {
      const text = await handleReview(httpClient, wsClient, config, args);
      return { content: [{ type: 'text', text }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${(err as Error).message}` }], isError: true };
    }
  },
);

server.tool(
  'workflow/run',
  'Execute an arbitrary dynamic workflow. Define phases with nodes (optionally grouped for parallelism). Blocks until all nodes complete (default timeout 10min).',
  runSchema,
  async (args) => {
    try {
      const text = await handleRun(httpClient, wsClient, config, args);
      return { content: [{ type: 'text', text }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${(err as Error).message}` }], isError: true };
    }
  },
);

server.tool(
  'workflow/propose',
  'Submit a script-generated workflow proposal to kswarm. Returns a proposal ID for use with workflow/start.',
  proposeSchema,
  async (args) => {
    try {
      const text = await handlePropose(httpClient, args);
      return { content: [{ type: 'text', text }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${(err as Error).message}` }], isError: true };
    }
  },
);

server.tool(
  'workflow/start',
  'Start a workflow run from an approved proposal.',
  startSchema,
  async (args) => {
    try {
      const text = await handleStart(httpClient, args);
      return { content: [{ type: 'text', text }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${(err as Error).message}` }], isError: true };
    }
  },
);

server.tool(
  'workflow/create-parallel-group',
  'Create a parallel execution group within a running workflow.',
  createParallelGroupSchema,
  async (args) => {
    try {
      const text = await handleCreateParallelGroup(httpClient, args);
      return { content: [{ type: 'text', text }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${(err as Error).message}` }], isError: true };
    }
  },
);

server.tool(
  'workflow/create-node',
  'Create and dispatch an agent node within a running workflow.',
  createNodeSchema,
  async (args) => {
    try {
      const text = await handleCreateNode(httpClient, args);
      return { content: [{ type: 'text', text }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${(err as Error).message}` }], isError: true };
    }
  },
);

server.tool(
  'workflow/submit-result',
  'Submit a completed node result to a workflow run.',
  submitResultSchema,
  async (args) => {
    try {
      const text = await handleSubmitResult(httpClient, args);
      return { content: [{ type: 'text', text }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${(err as Error).message}` }], isError: true };
    }
  },
);

server.tool(
  'workflow/complete',
  'Mark a workflow run as complete. All agent nodes must have finished.',
  completeSchema,
  async (args) => {
    try {
      const text = await handleComplete(httpClient, args);
      return { content: [{ type: 'text', text }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${(err as Error).message}` }], isError: true };
    }
  },
);

server.tool(
  'workflow/status',
  'Get the current status of a workflow run including all node states.',
  statusSchema,
  async (args) => {
    try {
      const text = await handleStatus(httpClient, args);
      return { content: [{ type: 'text', text }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${(err as Error).message}` }], isError: true };
    }
  },
);

server.tool(
  'workflow/cancel',
  'Cancel a running workflow.',
  cancelSchema,
  async (args) => {
    try {
      const text = await handleCancel(httpClient, args);
      return { content: [{ type: 'text', text }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${(err as Error).message}` }], isError: true };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
