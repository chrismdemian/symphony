// Phase 9B — real MCP stdio server fixture for the Obsidian ISSUE-SOURCE plugin.
//
//   - `fetch_open_issues` : returns a canned `{ issues: [...] }` — one open
//                           (routable to project `acme/widgets`), one terminal
//                           (ingest skips it), one MALFORMED (adapter drops it).
//   - `write_back_status` : records each call (the test observes the writeback).
//   - `get_writeback_log` : a plain proxy tool the test calls to read the log.
//
// The manifest declares `pollIntervalMs`, so the host schedules a poll loop
// that calls `fetch_open_issues` and ingests — this fixture lets the
// integration test exercise that path (with a fast interval override). Raw
// McpServer keeps the fixture build-free; the real port (vault scan + parser +
// checkbox writeback) is in packages/examples/obsidian-source.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer(
  { name: 'obsidian-source-fixture', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

const writebackLog = [];

const ISSUES = [
  {
    externalId: 'notes/todo.md#h:abc123',
    title: 'Wire the vault poll',
    url: 'obsidian://open?vault=v&file=notes/todo',
    state: ' ',
    isTerminal: false,
    body: null,
    assignee: null,
    labels: [],
    projectValue: 'acme/widgets',
    priority: 0,
    updatedAt: null,
  },
  {
    externalId: 'notes/todo.md#h:done456',
    title: 'Already checked off',
    url: null,
    state: 'x',
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
    description: 'Canned Obsidian tasks (issue-source contract).',
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
      structuredContent: { written: true, code: 'written', value: 'x' },
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
