// Phase 9C real-bundle smoke — spawns the ACTUAL built example plugins
// (packages/examples/{linear,jira,gitlab,forgejo}-source/dist/index.js) as real
// MCP stdio subprocesses and drives them through a real MCP client.
//
// This is the ONE place the self-contained bundles run end-to-end — it proves
// the bundled deps work at runtime (the SDK + MCP SDK + zod), config.json
// loading from the install-dir cwd, and the fetch/writeback tools against mock
// Linear (GraphQL) + Jira (REST) [9C.1] + GitLab (REST) + Forgejo (REST) [9C.2]
// servers.
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
const GITLAB_DIST = path.join(repoRoot, 'packages/examples/gitlab-source/dist/index.js');
const FORGEJO_DIST = path.join(repoRoot, 'packages/examples/forgejo-source/dist/index.js');

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

async function smokeGitLab() {
  process.stdout.write('gitlab-source bundle:\n');
  if (!existsSync(GITLAB_DIST)) {
    ok('built (run pnpm build:packages first)', false);
    return;
  }
  const glIssue = (iid, state) => ({
    id: 1000 + iid,
    iid,
    title: `Issue ${iid}`,
    description: 'body',
    state,
    web_url: `http://gl/acme/widgets/-/issues/${iid}`,
    updated_at: '2026-06-01T00:00:00Z',
    labels: ['priority::high'],
    assignee: { username: 'ada' },
  });

  const notes = [];
  const closes = [];
  const server = http.createServer(async (req, res) => {
    const u = req.url ?? '';
    const method = req.method ?? 'GET';
    const body = await readBody(req);
    res.setHeader('content-type', 'application/json');
    if (/\/issues\/\d+\/notes$/.test(u) && method === 'POST') {
      notes.push(JSON.parse(body || '{}'));
      return res.end(JSON.stringify({ id: 1 }));
    }
    if (/\/issues\/\d+$/.test(u) && method === 'PUT') {
      closes.push(JSON.parse(body || '{}'));
      return res.end(JSON.stringify({ state: 'closed' }));
    }
    if (u.includes('/issues?') && method === 'GET') {
      return res.end(JSON.stringify([glIssue(1, 'opened'), glIssue(2, 'closed')]));
    }
    if (u.endsWith('/user')) {
      return res.end(JSON.stringify({ username: 'ada' }));
    }
    res.statusCode = 404;
    res.end('[]');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const install = tmpdir('sym-9c-gitlab-install-');
  writeFileSync(
    path.join(install, 'config.json'),
    JSON.stringify({ token: 'glpat_smoke', projects: ['acme/widgets'], siteUrl: `http://127.0.0.1:${port}` }),
    'utf8',
  );

  const client = await connect(GITLAB_DIST, install);
  try {
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    ok('exposes the issue-source tools', ['check_connection', 'fetch_open_issues', 'search_issues', 'write_back_status'].every((n) => names.includes(n)));

    const fetched = structured(await client.callTool({ name: 'fetch_open_issues', arguments: {} }));
    const issues = fetched.issues ?? [];
    ok('fetched 2 issues via the mock REST API', issues.length === 2);
    const open = issues.find((i) => i.externalId === 'acme/widgets#1');
    ok('open issue mapped (group/project#iid id, path route, label priority, non-terminal)', open && open.projectValue === 'acme/widgets' && open.priority === 2 && open.isTerminal === false);
    ok('closed issue flagged terminal', (issues.find((i) => i.externalId === 'acme/widgets#2') || {}).isTerminal === true);

    const wb = structured(await client.callTool({ name: 'write_back_status', arguments: { externalId: 'acme/widgets#1', status: 'completed' } }));
    ok('writeback reported written (noted + closed)', wb.written === true && wb.code === 'written');
    ok('mock received a note', notes.length === 1 && notes[0].body === 'Completed by Symphony.');
    ok('mock received a close (state_event)', closes.length === 1 && closes[0].state_event === 'close');
  } finally {
    await client.close().catch(() => {});
    server.close();
  }
}

async function smokeForgejo() {
  process.stdout.write('forgejo-source bundle:\n');
  if (!existsSync(FORGEJO_DIST)) {
    ok('built (run pnpm build:packages first)', false);
    return;
  }
  const fjIssue = (number, state) => ({
    id: 1000 + number,
    number,
    title: `Issue ${number}`,
    body: 'body',
    state,
    html_url: `http://fj/acme/repo/issues/${number}`,
    updated_at: '2026-06-01T00:00:00Z',
    labels: [{ name: 'priority/high' }],
    assignee: { login: 'ada' },
  });

  const comments = [];
  const closes = [];
  const server = http.createServer(async (req, res) => {
    const u = req.url ?? '';
    const method = req.method ?? 'GET';
    const body = await readBody(req);
    res.setHeader('content-type', 'application/json');
    if (/\/issues\/\d+\/comments$/.test(u) && method === 'POST') {
      comments.push(JSON.parse(body || '{}'));
      return res.end(JSON.stringify({ id: 1 }));
    }
    if (/\/issues\/\d+$/.test(u) && method === 'PATCH') {
      closes.push(JSON.parse(body || '{}'));
      return res.end(JSON.stringify({ state: 'closed' }));
    }
    if (u.includes('/issues?') && method === 'GET') {
      // One real issue + one PR (must be filtered) + one closed issue.
      return res.end(JSON.stringify([fjIssue(1, 'open'), { ...fjIssue(2, 'open'), pull_request: {} }, fjIssue(3, 'closed')]));
    }
    if (u.endsWith('/user')) {
      return res.end(JSON.stringify({ login: 'ada' }));
    }
    res.statusCode = 404;
    res.end('[]');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const install = tmpdir('sym-9c-forgejo-install-');
  writeFileSync(
    path.join(install, 'config.json'),
    JSON.stringify({ token: 'fj_smoke', siteUrl: `http://127.0.0.1:${port}`, repos: ['acme/repo'] }),
    'utf8',
  );

  const client = await connect(FORGEJO_DIST, install);
  try {
    const fetched = structured(await client.callTool({ name: 'fetch_open_issues', arguments: {} }));
    const issues = fetched.issues ?? [];
    ok('fetched 2 issues via the mock REST API (PR filtered out)', issues.length === 2);
    const open = issues.find((i) => i.externalId === 'acme/repo#1');
    ok('open issue mapped (owner/repo#number id, repo route, label priority, non-terminal)', open && open.projectValue === 'acme/repo' && open.priority === 2 && open.isTerminal === false);
    ok('closed issue flagged terminal', (issues.find((i) => i.externalId === 'acme/repo#3') || {}).isTerminal === true);
    ok('pull request excluded', !issues.some((i) => i.externalId === 'acme/repo#2'));

    const wb = structured(await client.callTool({ name: 'write_back_status', arguments: { externalId: 'acme/repo#1', status: 'completed' } }));
    ok('writeback reported written (commented + closed)', wb.written === true && wb.code === 'written');
    ok('mock received a comment', comments.length === 1 && comments[0].body === 'Completed by Symphony.');
    ok('mock received a close (state=closed)', closes.length === 1 && closes[0].state === 'closed');
  } finally {
    await client.close().catch(() => {});
    server.close();
  }
}

try {
  await smokeLinear();
  await smokeJira();
  await smokeGitLab();
  await smokeForgejo();
} finally {
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
}

process.stdout.write(failures === 0 ? '\n9C smoke PASS\n' : `\n9C smoke FAIL (${failures})\n`);
process.exit(failures === 0 ? 0 : 1);
