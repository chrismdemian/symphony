// Phase 9B real-bundle smoke — spawns the ACTUAL built example plugins
// (packages/examples/{obsidian,notion}-source/dist/index.js) as real MCP
// stdio subprocesses and drives them through a real MCP client.
//
// This is the ONE place the self-contained bundles run end-to-end — it proves
// the bundled deps work at runtime (gray-matter CJS→ESM interop for obsidian;
// zod + the SDK for both), config.json loading from the install-dir cwd, and
// the fetch/writeback tools against a real temp vault + a mock Notion server.
//
// Run: pnpm smoke:9b   (build the examples first: pnpm build:packages)
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const OBSIDIAN_DIST = path.join(repoRoot, 'packages/examples/obsidian-source/dist/index.js');
const NOTION_DIST = path.join(repoRoot, 'packages/examples/notion-source/dist/index.js');

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

async function smokeObsidian() {
  process.stdout.write('obsidian-source bundle:\n');
  if (!existsSync(OBSIDIAN_DIST)) {
    ok('built (run pnpm build:packages first)', false);
    return;
  }
  const vault = tmpdir('sym-9b-vault-');
  mkdirSync(path.join(vault, 'notes'), { recursive: true });
  const notePath = path.join(vault, 'notes', 'todo.md');
  writeFileSync(notePath, ['---', 'project: demo', '---', '- [ ] Wire it 🔼', '- [x] Done old'].join('\n'), 'utf8');

  const install = tmpdir('sym-9b-obs-install-');
  writeFileSync(
    path.join(install, 'config.json'),
    JSON.stringify({ vaultPath: vault, statusWriteback: { completed: 'x', appendDoneDate: false } }),
    'utf8',
  );

  const client = await connect(OBSIDIAN_DIST, install);
  try {
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    ok('exposes the issue-source tools', ['check_connection', 'fetch_open_issues', 'write_back_status'].every((n) => names.includes(n)));

    const fetched = structured(await client.callTool({ name: 'fetch_open_issues', arguments: {} }));
    const issues = fetched.issues ?? [];
    ok('fetched 2 tasks (gray-matter frontmatter parsed)', issues.length === 2);
    const open = issues.find((i) => i.title === 'Wire it');
    ok('open task mapped (project from frontmatter, priority emoji)', open && open.projectValue === 'demo' && open.priority === 1 && open.isTerminal === false);
    ok('done task flagged terminal', (issues.find((i) => i.title === 'Done old') || {}).isTerminal === true);

    const wb = structured(await client.callTool({ name: 'write_back_status', arguments: { externalId: open.externalId, status: 'completed' } }));
    ok('writeback reported written', wb.written === true && wb.code === 'written');
    const after = readFileSync(notePath, 'utf8');
    ok('checkbox flipped in the real vault file', after.includes('- [x] Wire it') && after.includes('- [x] Done old'));
  } finally {
    await client.close().catch(() => {});
  }
}

async function smokeNotion() {
  process.stdout.write('notion-source bundle:\n');
  if (!existsSync(NOTION_DIST)) {
    ok('built (run pnpm build:packages first)', false);
    return;
  }
  // Mock Notion API.
  const patched = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const u = req.url ?? '';
      res.setHeader('content-type', 'application/json');
      if (u.includes('/v1/databases/')) return res.end(JSON.stringify({ data_sources: [{ id: 'ds1' }] }));
      if (u.includes('/v1/data_sources/') && u.endsWith('/query')) {
        return res.end(JSON.stringify({
          results: [
            { object: 'page', id: 'pg-open', url: 'https://notion.so/pg-open', properties: { Name: { type: 'title', title: [{ plain_text: 'Do it' }] }, Status: { type: 'status', status: { name: 'To do' } } } },
            { object: 'page', id: 'pg-done', properties: { Name: { type: 'title', title: [{ plain_text: 'Was done' }] }, Status: { type: 'status', status: { name: 'Done' } } } },
          ],
          has_more: false,
        }));
      }
      if (u.includes('/v1/data_sources/')) return res.end(JSON.stringify({ properties: { Status: { type: 'status' } } }));
      if (u.includes('/v1/pages/') && req.method === 'PATCH') {
        patched.push({ url: u, body: JSON.parse(body || '{}') });
        return res.end(JSON.stringify({ id: 'pg-open' }));
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const install = tmpdir('sym-9b-notion-install-');
  writeFileSync(
    path.join(install, 'config.json'),
    JSON.stringify({ token: 'secret_smoke', databaseId: 'db1', apiBaseUrl: `http://127.0.0.1:${port}` }),
    'utf8',
  );

  const client = await connect(NOTION_DIST, install);
  try {
    const fetched = structured(await client.callTool({ name: 'fetch_open_issues', arguments: {} }));
    const issues = fetched.issues ?? [];
    ok('fetched 2 pages via the mock API', issues.length === 2);
    ok('To-do page is non-terminal; Done page terminal', (issues.find((i) => i.title === 'Do it') || {}).isTerminal === false && (issues.find((i) => i.title === 'Was done') || {}).isTerminal === true);

    const wb = structured(await client.callTool({ name: 'write_back_status', arguments: { externalId: 'pg-open', status: 'completed' } }));
    ok('writeback reported written', wb.written === true);
    ok('mock received a PATCH with the status body', patched.length === 1 && JSON.stringify(patched[0].body).includes('"Done"'));
  } finally {
    await client.close().catch(() => {});
    server.close();
  }
}

try {
  await smokeObsidian();
  await smokeNotion();
} finally {
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
}

process.stdout.write(failures === 0 ? '\n9B smoke PASS\n' : `\n9B smoke FAIL (${failures})\n`);
process.exit(failures === 0 ? 0 : 1);
