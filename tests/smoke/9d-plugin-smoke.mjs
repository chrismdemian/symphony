// Phase 9D real-bundle smoke — spawns the ACTUAL built browser skeleton plugins
// (packages/examples/{browserbase,chrome-devtools-mcp}/dist/index.js) as real
// MCP stdio subprocesses and drives them through a real MCP client.
//
// These are NON-FUNCTIONAL skeletons: the smoke proves the bundled deps work at
// runtime (the SDK + MCP SDK + zod self-contained via tsup noExternal), that
// `.serve()` connects, that the documented tool surface is exposed, and that
// every handler returns the `{ implemented: false }` skeleton marker. No
// config.json is needed (the handlers never read it).
//
// Run: pnpm smoke:9d   (build the examples first: pnpm build:packages)
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const BROWSERBASE_DIST = path.join(repoRoot, 'packages/examples/browserbase/dist/index.js');
const CDP_DIST = path.join(repoRoot, 'packages/examples/chrome-devtools-mcp/dist/index.js');

let failures = 0;
function ok(name, cond) {
  if (cond) {
    process.stdout.write(`  ok   ${name}\n`);
  } else {
    failures += 1;
    process.stdout.write(`  FAIL ${name}\n`);
  }
}
async function connect(distPath) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [distPath],
    cwd: repoRoot,
    stderr: 'inherit',
  });
  const client = new Client({ name: 'smoke', version: '0.0.0' });
  await client.connect(transport);
  return client;
}
function structured(res) {
  return res.structuredContent ?? {};
}

async function smokeOne(label, distPath, expectedTools, callTool) {
  process.stdout.write(`${label} bundle:\n`);
  if (!existsSync(distPath)) {
    ok('built (run pnpm build:packages first)', false);
    return;
  }
  const client = await connect(distPath);
  try {
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    ok(`exposes the documented tool surface (${expectedTools.join(', ')})`, expectedTools.every((n) => names.includes(n)));

    const res = await client.callTool({ name: callTool.name, arguments: callTool.args });
    const sc = structured(res);
    ok(`${callTool.name} returns the skeleton marker (implemented:false)`, sc.implemented === false);
    ok(`${callTool.name} echoes its tool name in structuredContent`, sc.tool === callTool.name);
    const text = (res.content ?? []).map((c) => c.text ?? '').join('');
    ok(`${callTool.name} text says SKELETON`, /SKELETON \(Phase 9D\)/.test(text));
  } finally {
    await client.close().catch(() => {});
  }
}

await smokeOne(
  'browserbase',
  BROWSERBASE_DIST,
  ['create_session', 'navigate', 'act', 'extract', 'screenshot', 'close_session'],
  { name: 'navigate', args: { url: 'https://example.com' } },
);

await smokeOne(
  'chrome-devtools-mcp',
  CDP_DIST,
  ['list_pages', 'navigate_page', 'click', 'fill', 'take_screenshot', 'evaluate_script'],
  { name: 'navigate_page', args: { url: 'https://example.com' } },
);

process.stdout.write(failures === 0 ? '\n9D smoke PASS\n' : `\n9D smoke FAIL (${failures})\n`);
process.exit(failures === 0 ? 0 : 1);
