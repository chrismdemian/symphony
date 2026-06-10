// Phase 9C.2 — real MCP stdio server fixture for the GitLab ISSUE-SOURCE plugin.
//
//   - `fetch_open_issues` : returns a canned `{ issues: [...] }` — one open
//                           (routable to project `ENG`), one already terminal
//                           (ingest skips it), and one MALFORMED (the adapter
//                           drops it). Honors `limit`.
//   - `write_back_status` : records each call so the test can observe that a
//                           terminal task transition fanned out to the plugin.
//   - `get_writeback_log` : a plain tool (registered as a proxy) the test calls
//                           to read the writeback log.
//
// Raw McpServer (no @symphony/plugin-sdk) keeps the fixture build-free. The real
// GitLab port (REST I/O + mapping) is unit-tested directly against the example
// package.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer(
  { name: 'gitlab-source-fixture', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

const writebackLog = [];

const ISSUES = [
  {
    externalId: 'acme/widgets#1',
    title: 'Implement the widget',
    url: 'https://gitlab.com/acme/widgets/-/issues/1',
    state: 'opened',
    isTerminal: false,
    body: 'the body',
    assignee: 'Ada',
    labels: ['priority::high'],
    projectValue: 'ENG',
    priority: 2,
    updatedAt: '2026-06-01T00:00:00Z',
  },
  {
    externalId: 'acme/widgets#2',
    title: 'Already shipped',
    url: null,
    state: 'closed',
    isTerminal: true,
    body: null,
    assignee: null,
    labels: [],
    projectValue: 'ENG',
    priority: 0,
    updatedAt: null,
  },
  // Malformed (no externalId / isTerminal) — the adapter must drop it.
  { title: 'garbage', whoops: true },
];

server.registerTool(
  'fetch_open_issues',
  {
    description: 'Canned GitLab issues (issue-source contract).',
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
      structuredContent: { written: true, code: 'written', value: 'noted + closed' },
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
