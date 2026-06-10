// Phase 9A — real MCP stdio server fixture for an ISSUE-SOURCE plugin.
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
// `fetch_open_issues` + `write_back_status` are the issue-source internal
// tools — the host hides them from the toolbelt and the adapter calls them
// directly. Only `sync_github` (host-built) + `github-source__get_writeback_log`
// are registered as Maestro-facing tools. Raw McpServer (no @symphony/plugin-sdk)
// keeps the fixture build-free; `@modelcontextprotocol/sdk` resolves from the
// repo node_modules.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer(
  { name: 'github-source-fixture', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

const writebackLog = [];

const ISSUES = [
  {
    externalId: 'acme/widgets#1',
    title: 'Fix the thing',
    url: 'https://github.com/acme/widgets/issues/1',
    state: 'open',
    isTerminal: false,
    body: 'the body',
    assignee: 'octocat',
    labels: ['urgent'],
    projectValue: 'acme/widgets',
    priority: 3,
    updatedAt: '2026-06-01T00:00:00Z',
  },
  {
    externalId: 'acme/widgets#2',
    title: 'Already closed',
    url: null,
    state: 'closed',
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
    description: 'Canned open issues (issue-source contract).',
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
      structuredContent: { written: true, code: 'written', value: 'commented + closed' },
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
