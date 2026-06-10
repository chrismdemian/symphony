// Phase 9B — real MCP stdio server fixture for the Notion ISSUE-SOURCE plugin.
//
//   - `fetch_open_issues` : returns a canned `{ issues: [...] }` — one open
//                           (routable to project `acme/widgets`), one already
//                           terminal (ingest skips it), and one MALFORMED
//                           (the adapter drops it). Honors `limit`.
//   - `write_back_status` : records each call so the test can observe that a
//                           terminal task transition fanned out to the plugin.
//   - `get_writeback_log` : a plain tool (registered as a proxy) the test
//                           calls to read the writeback log.
//
// Raw McpServer (no @symphony/plugin-sdk) keeps the fixture build-free; the
// real port is in packages/examples/notion-source (unit-tested separately).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer(
  { name: 'notion-source-fixture', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

const writebackLog = [];

const ISSUES = [
  {
    externalId: 'page-open-1',
    title: 'Ship the Notion sync',
    url: 'https://notion.so/page-open-1',
    state: 'In progress',
    isTerminal: false,
    body: null,
    assignee: null,
    labels: [],
    projectValue: 'acme/widgets',
    priority: 2,
    updatedAt: '2026-06-01T00:00:00Z',
  },
  {
    externalId: 'page-done-2',
    title: 'Already done',
    url: null,
    state: 'Done',
    isTerminal: true,
    body: null,
    assignee: null,
    labels: [],
    projectValue: 'acme/widgets',
    priority: 0,
    updatedAt: null,
  },
  // Malformed (no externalId / isTerminal) — the adapter must drop it.
  { title: 'garbage', whoops: true },
];

server.registerTool(
  'fetch_open_issues',
  {
    description: 'Canned Notion pages (issue-source contract).',
    inputSchema: { limit: z.number().int().optional() },
  },
  async ({ limit }) => {
    const issues = typeof limit === 'number' ? ISSUES.slice(0, limit) : ISSUES;
    return { content: [{ type: 'text', text: `ok ${issues.length}` }], structuredContent: { issues } };
  },
);

server.registerTool(
  'write_back_status',
  {
    description: 'Record a terminal-status writeback call.',
    inputSchema: { externalId: z.string(), status: z.string() },
  },
  async ({ externalId, status }) => {
    writebackLog.push({ externalId, status });
    return {
      content: [{ type: 'text', text: 'written' }],
      structuredContent: { written: true, code: 'written', value: 'Done' },
    };
  },
);

server.registerTool(
  'get_writeback_log',
  { description: 'Observe writeback calls (test).', inputSchema: {} },
  async () => ({
    content: [{ type: 'text', text: JSON.stringify(writebackLog) }],
    structuredContent: { calls: writebackLog },
  }),
);

await server.connect(new StdioServerTransport());
