// Phase 7B.3 — real MCP stdio server fixture exercising host enrichment:
//   - `safe_read`  : declares `symphony/permissions: ['task:read']`, a
//                    subset of the manifest grant → host registers it.
//   - `over_reach` : declares `symphony/permissions: ['task:write']`, NOT
//                    in the manifest → host refuses (fail-closed).
//   - `on_task_created` / `on_worker_spawned` : event handlers marked with
//                    `symphony/eventHandler: true` → host hides them from
//                    the toolbelt but still dispatches events to them.
//   - `get_event_count` : plain tool to observe deliveries.
//
// Emits real `_meta` markers via raw `registerTool` (mirrors what the SDK
// builder attaches) so the integration test verifies the round-trip end to
// end against a genuine subprocess.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer(
  { name: 'enrich-plugin', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

let eventCount = 0;

server.registerTool(
  'safe_read',
  {
    description: 'A tool needing task:read (granted by the manifest).',
    inputSchema: {},
    _meta: { 'symphony/permissions': ['task:read'] },
  },
  async () => ({ content: [{ type: 'text', text: 'ok' }] }),
);

server.registerTool(
  'over_reach',
  {
    description: 'A tool needing task:write (NOT granted) — must be refused.',
    inputSchema: {},
    _meta: { 'symphony/permissions': ['task:write'] },
  },
  async () => ({ content: [{ type: 'text', text: 'should never register' }] }),
);

server.registerTool(
  'on_task_created',
  {
    description: 'Event handler for onTaskCreated.',
    inputSchema: {
      taskId: z.string().optional(),
      projectId: z.string().nullable().optional(),
      description: z.string().optional(),
      status: z.string().optional(),
    },
    _meta: { 'symphony/eventHandler': true },
  },
  async () => {
    eventCount += 1;
    return { content: [{ type: 'text', text: 'created' }] };
  },
);

server.registerTool(
  'on_worker_spawned',
  {
    description: 'Event handler for onWorkerSpawned.',
    inputSchema: {
      workerId: z.string().optional(),
      role: z.string().optional(),
      featureIntent: z.string().optional(),
      projectId: z.string().nullable().optional(),
      taskId: z.string().nullable().optional(),
    },
    _meta: { 'symphony/eventHandler': true },
  },
  async () => {
    eventCount += 1;
    return { content: [{ type: 'text', text: 'spawned' }] };
  },
);

server.registerTool(
  'get_event_count',
  { description: 'Returns how many events were delivered.', inputSchema: {} },
  async () => ({
    content: [{ type: 'text', text: String(eventCount) }],
    structuredContent: { count: eventCount },
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
