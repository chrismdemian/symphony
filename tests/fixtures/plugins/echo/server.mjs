// Phase 7A — minimal real MCP stdio server used as a plugin fixture.
//
// Runs as `node server.mjs` spawned by Symphony's PluginClient over a real
// StdioClientTransport. State (eventCount) lives in-process so the
// integration test can observe event delivery via a tool call rather than
// a filesystem side effect (the plugin runs with a strict env allowlist
// and a cwd inside the repo fixtures tree — no writable scratch path).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer(
  { name: 'echo-plugin', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

let eventCount = 0;

server.registerTool(
  'ping',
  { description: 'Returns pong.', inputSchema: {} },
  async () => ({ content: [{ type: 'text', text: 'pong' }] }),
);

server.registerTool(
  'echo',
  { description: 'Echoes the input text.', inputSchema: { text: z.string() } },
  async ({ text }) => ({ content: [{ type: 'text', text: `echo: ${text}` }] }),
);

server.registerTool(
  'on_task_completed',
  {
    description: 'Event handler for onTaskCompleted.',
    inputSchema: { taskId: z.string().optional(), status: z.string().optional() },
  },
  async (args) => {
    eventCount += 1;
    return { content: [{ type: 'text', text: `recorded ${JSON.stringify(args)}` }] };
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
