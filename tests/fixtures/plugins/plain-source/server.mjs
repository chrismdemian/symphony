// Phase 9C.3 — real MCP stdio server fixture for the Plain ISSUE-SOURCE plugin.
//
//   - `fetch_open_issues` : returns a canned `{ issues: [...] }` — one open
//                           (routable to project `ENG`), one already terminal
//                           (DONE; ingest skips it), and one MALFORMED (the
//                           adapter drops it). Honors `limit`.
//   - `write_back_status` : records each call so the test can observe that a
//                           terminal task transition fanned out to the plugin.
//   - `get_writeback_log` : a plain tool (registered as a proxy) the test calls
//                           to read the writeback log.
//
// Raw McpServer (no @symphony/plugin-sdk) keeps the fixture build-free. The real
// Plain port (GraphQL I/O + mapping + the internal-note writeback) is unit-tested
// directly against the example package. The canned `projectValue: 'ENG'` routes
// to the test's registered project (the real port emits null — Plain has no
// project concept).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer(
  { name: 'plain-source-fixture', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

const writebackLog = [];

const ISSUES = [
  {
    externalId: 'th-1',
    title: 'Refund request',
    url: 'https://app.plain.com/workspace/ws1/thread/th-1',
    state: 'TODO',
    isTerminal: false,
    body: 'customer wants a refund',
    assignee: null,
    labels: ['billing'],
    projectValue: 'ENG',
    priority: 3,
    updatedAt: '2026-06-01T00:00:00Z',
  },
  {
    externalId: 'th-2',
    title: 'Already resolved',
    url: null,
    state: 'DONE',
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
    description: 'Canned Plain threads (issue-source contract).',
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
      structuredContent: { written: true, code: 'written', value: 'noted + done' },
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
