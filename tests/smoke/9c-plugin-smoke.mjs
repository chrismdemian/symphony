// Phase 9C.1 real-bundle smoke — spawns the ACTUAL built example plugins
// (packages/examples/{linear,jira}-source/dist/index.js) as real MCP stdio
// subprocesses and drives them through a real MCP client.
//
// This is the ONE place the self-contained bundles run end-to-end — it proves
// the bundled deps work at runtime (the SDK + MCP SDK + zod), config.json
// loading from the install-dir cwd, and the fetch/writeback tools against mock
// Linear (GraphQL) + Jira (REST) servers.
//
// Run: pnpm smoke:9c   (build the examples first: pnpm build:packages)
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const LINEAR_DIST = path.join(repoRoot, 'packages/examples/linear-source/dist/index.js');
const JIRA_DIST = path.join(repoRoot, 'packages/examples/jira-source/dist/index.js');

let failures = 0;
const tmps = [];
function ok(name, cond) {
  if (cond) {
    process.stdout.write(`  ok   ${name}\n`);
  } else {
    failures += 1;
    process.stdout.write(`  FAIL ${name}\n`);
  }
}
function tmpdir(prefix) {
  const d = mkdtempSync(path.join(os.tmpdir(), prefix));
  tmps.push(d);
  return d;
}
async function connect(distPath, installDir) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [distPath],
    cwd: installDir,
    stderr: 'inherit',
  });
  const client = new Client({ name: 'smoke', version: '0.0.0' });
  await client.connect(transport);
  return client;
}
function structured(res) {
  return res.structuredContent ?? {};
}
function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => resolve(body));
  });
}

async function smokeLinear() {
  process.stdout.write('linear-source bundle:\n');
  if (!existsSync(LINEAR_DIST)) {
    ok('built (run pnpm build:packages first)', false);
    return;
  }
  const OPEN = {
    id: '9a1b2c3d-0001',
    identifier: 'ENG-1',
    title: 'Smoke the widget',
    description: 'b',
    url: 'https://linear.app/acme/issue/ENG-1',
    priority: 1, // urgent → 3
    updatedAt: '2026-06-01T00:00:00Z',
    state: { name: 'In Progress', type: 'started' },
    team: { id: 't1', key: 'ENG', name: 'Engineering' },
    project: { name: 'Widgets' },
    assignee: { displayName: 'Ada' },
  };
  const DONE = { ...OPEN, id: '9a1b2c3d-0002', title: 'Done', state: { name: 'Done', type: 'completed' }, project: null };
  const STATES = [{ id: 's-done', name: 'Done', type: 'completed', position: 0 }];

  const updates = [];
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    const query = String(JSON.parse(body || '{}').query ?? '');
    res.setHeader('content-type', 'application/json');
    if (query.includes('issueUpdate(')) {
      updates.push(JSON.parse(body).variables);
      return res.end(JSON.stringify({ data: { issueUpdate: { success: true } } }));
    }
    if (query.includes('issue(id:')) {
      return res.end(JSON.stringify({ data: { issue: { id: 'x', team: { id: 't1', states: { nodes: STATES } } } } }));
    }
    if (query.includes('issues(first')) {
      return res.end(JSON.stringify({ data: { issues: { nodes: [OPEN, DONE] } } }));
    }
    return res.end(JSON.stringify({ data: {} }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const install = tmpdir('sym-9c-linear-install-');
  writeFileSync(path.join(install, 'config.json'), JSON.stringify({ token: 'lin_smoke', apiUrl: `http://127.0.0.1:${port}` }), 'utf8');

  const client = await connect(LINEAR_DIST, install);
  try {
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    ok('exposes the issue-source tools', ['check_connection', 'fetch_open_issues', 'search_issues', 'write_back_status'].every((n) => names.includes(n)));

    const fetched = structured(await client.callTool({ name: 'fetch_open_issues', arguments: {} }));
    const issues = fetched.issues ?? [];
    ok('fetched 2 issues via the mock GraphQL API', issues.length === 2);
    const open = issues.find((i) => i.externalId === '9a1b2c3d-0001');
    ok('open issue mapped (UUID id, project route, priority inversion, non-terminal)', open && open.projectValue === 'Widgets' && open.priority === 3 && open.isTerminal === false);
    ok('done issue flagged terminal', (issues.find((i) => i.externalId === '9a1b2c3d-0002') || {}).isTerminal === true);

    const wb = structured(await client.callTool({ name: 'write_back_status', arguments: { externalId: '9a1b2c3d-0001', status: 'completed' } }));
    ok('writeback reported written', wb.written === true && wb.code === 'written' && wb.value === 'Done');
    ok('mock received an issueUpdate to the Done state', updates.length === 1 && updates[0].stateId === 's-done');
  } finally {
    await client.close().catch(() => {});
    server.close();
  }
}

async function smokeJira() {
  process.stdout.write('jira-source bundle:\n');
  if (!existsSync(JIRA_DIST)) {
    ok('built (run pnpm build:packages first)', false);
    return;
  }
  const rawIssue = (key, statusCat) => ({
    key,
    fields: {
      summary: `Issue ${key}`,
      description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'body' }] }] },
      updated: '2026-06-01T00:00:00Z',
      project: { key: 'ENG' },
      status: { name: statusCat === 'done' ? 'Done' : 'In Progress', statusCategory: { key: statusCat } },
      assignee: { displayName: 'Ada' },
      priority: { name: 'High' },
      labels: ['backend'],
    },
  });
  const comments = [];
  const transitionsPosted = [];
  const server = http.createServer(async (req, res) => {
    const u = req.url ?? '';
    const method = req.method ?? 'GET';
    const body = await readBody(req);
    res.setHeader('content-type', 'application/json');
    if (u.includes('/search/jql') && method === 'POST') {
      return res.end(JSON.stringify({ issues: [rawIssue('ENG-1', 'indeterminate'), rawIssue('ENG-2', 'done')], isLast: true }));
    }
    if (/\/issue\/[^/]+\/comment$/.test(u) && method === 'POST') {
      comments.push(JSON.parse(body || '{}'));
      return res.end(JSON.stringify({ id: '10001' }));
    }
    if (/\/issue\/[^/]+\/transitions$/.test(u) && method === 'GET') {
      return res.end(JSON.stringify({ transitions: [{ id: 't2', name: 'Done', to: { statusCategory: { key: 'done' } } }] }));
    }
    if (/\/issue\/[^/]+\/transitions$/.test(u) && method === 'POST') {
      transitionsPosted.push(JSON.parse(body || '{}'));
      return res.end('{}');
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const install = tmpdir('sym-9c-jira-install-');
  writeFileSync(
    path.join(install, 'config.json'),
    JSON.stringify({ token: 'jira_smoke', siteUrl: `http://127.0.0.1:${port}`, email: 'you@acme.com' }),
    'utf8',
  );

  const client = await connect(JIRA_DIST, install);
  try {
    const fetched = structured(await client.callTool({ name: 'fetch_open_issues', arguments: {} }));
    const issues = fetched.issues ?? [];
    ok('fetched 2 issues via the mock REST API', issues.length === 2);
    const open = issues.find((i) => i.externalId === 'ENG-1');
    ok('open issue mapped (key id, ADF body flattened, priority, non-terminal)', open && open.projectValue === 'ENG' && open.body === 'body' && open.priority === 2 && open.isTerminal === false);
    ok('done issue flagged terminal', (issues.find((i) => i.externalId === 'ENG-2') || {}).isTerminal === true);

    const wb = structured(await client.callTool({ name: 'write_back_status', arguments: { externalId: 'ENG-1', status: 'completed' } }));
    ok('writeback reported written (commented + transitioned)', wb.written === true && wb.code === 'written');
    ok('mock received an ADF comment', comments.length === 1 && comments[0].body && comments[0].body.type === 'doc');
    ok('mock received a transition to the Done id', transitionsPosted.length === 1 && transitionsPosted[0].transition.id === 't2');
  } finally {
    await client.close().catch(() => {});
    server.close();
  }
}

try {
  await smokeLinear();
  await smokeJira();
} finally {
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
}

process.stdout.write(failures === 0 ? '\n9C smoke PASS\n' : `\n9C smoke FAIL (${failures})\n`);
process.exit(failures === 0 ? 0 : 1);
