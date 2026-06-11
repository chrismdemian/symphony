// Phase 9D — minimal real MCP stdio server used as a host-browser-control
// fixture. Mirrors the chrome-devtools-mcp example's envelope (the manifest
// declares requires:host-browser-control + irreversible) so the scenario can
// prove the EXACT-Tier-3 gate is enforced end-to-end through the real dispatch
// path. The tool is a non-functional skeleton: it never touches a browser.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer(
  { name: 'chrome-devtools-skeleton', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.registerTool(
  'navigate_page',
  {
    description: 'SKELETON — navigate the pinned tab. No browser is touched.',
    inputSchema: { url: z.string() },
  },
  async ({ url }) => ({
    content: [{ type: 'text', text: `SKELETON: would navigate to ${url}` }],
    structuredContent: { implemented: false, tool: 'navigate_page', url },
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
