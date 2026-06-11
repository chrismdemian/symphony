/**
 * Phase 9D production scenario — see 9d.md.
 *
 * Boots the real orchestrator server with the plugin host active + a real
 * `requires:host-browser-control` fixture plugin (mirroring the
 * chrome-devtools-mcp example's envelope), connects a Maestro-equivalent MCP
 * Client, and proves the EXACT-Tier-3 gate is enforced end-to-end through the
 * real dispatch path:
 *   - the proxy tool is registered (discovery works regardless of tier),
 *   - at Tier 2 the call is DENIED (host-browser-control requires Tier 3) with
 *     a non-defeatable `tool_denied` audit row,
 *   - at Tier 3 (act, present, non-automation) the call is ALLOWED and audited
 *     `tool_called`.
 *
 * The away-mode / automation-context / plan-mode denials are covered by the
 * 9D unit test against the real CapabilityEvaluator — this scenario proves the
 * wiring, not every branch.
 */
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';

import { startOrchestratorServer, type OrchestratorServerHandle } from '../../src/orchestrator/server.js';
import { SymphonyDatabase } from '../../src/state/db.js';
import { SqlitePluginStore } from '../../src/plugins/store.js';
import { SYMPHONY_PLUGINS_DIR_ENV } from '../../src/plugins/paths.js';
import { SYMPHONY_CONFIG_FILE_ENV } from '../../src/utils/config.js';
import type { AutonomyTier } from '../../src/orchestrator/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PLUGINS_ROOT = path.join(here, '..', 'fixtures', 'plugins');
const PLUGIN_ID = 'chrome-devtools-skeleton';
const TOOL = `${PLUGIN_ID}__navigate_page`;

let tmp: string;
let db: SymphonyDatabase;
let handle: OrchestratorServerHandle | undefined;
let client: Client | undefined;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'sym-9d-scn-'));
  saved[SYMPHONY_PLUGINS_DIR_ENV] = process.env[SYMPHONY_PLUGINS_DIR_ENV];
  saved[SYMPHONY_CONFIG_FILE_ENV] = process.env[SYMPHONY_CONFIG_FILE_ENV];
  process.env[SYMPHONY_PLUGINS_DIR_ENV] = PLUGINS_ROOT;
  const configFile = path.join(tmp, 'config.json');
  writeFileSync(configFile, JSON.stringify({ schemaVersion: 1, pluginsEnabled: true }), 'utf8');
  process.env[SYMPHONY_CONFIG_FILE_ENV] = configFile;

  db = SymphonyDatabase.open({ filePath: path.join(tmp, 'symphony.db') });
  new SqlitePluginStore(db.db).upsert({
    id: PLUGIN_ID,
    name: 'Chrome DevTools skeleton fixture',
    version: '1.0.0',
    source: PLUGINS_ROOT,
    enabled: true,
    now: '2026-06-11T00:00:00.000Z',
  });
});

afterEach(async () => {
  if (client !== undefined) await client.close().catch(() => {});
  client = undefined;
  if (handle !== undefined) await handle.close();
  handle = undefined;
  db.close();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tmp, { recursive: true, force: true });
});

async function boot(tier: AutonomyTier): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  handle = await startOrchestratorServer({
    transport: serverTransport,
    initialMode: 'act',
    initialTier: tier,
    defaultProjectPath: tmp,
    database: db,
    plugins: { enabled: true },
    rpc: { enabled: false },
  });
  expect(handle.pluginHost).toBeDefined();
  const c = new Client({ name: 'maestro-equivalent', version: '0.0.0' });
  await c.connect(clientTransport);
  return c;
}

describe('9D scenario — host-browser-control plugin gated at EXACT Tier 3', () => {
  it('registers the proxy but DENIES it at Tier 2 (audited tool_denied)', async () => {
    client = await boot(2);

    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain(TOOL); // discovery is tier-independent

    const res = await client.callTool(
      { name: TOOL, arguments: { url: 'https://example.com' } },
      CallToolResultSchema,
    );
    expect(res.isError).toBe(true);
    const text = (res.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('');
    expect(text).toMatch(/tier 3/i);

    const denied = handle!.auditStore
      .list({ limit: 1000 })
      .filter((r) => r.kind === 'tool_denied')
      .map((r) => r.toolName);
    expect(denied).toContain(TOOL);
  }, 20_000);

  it('ALLOWS it at Tier 3 (act, present, non-automation) and audits tool_called', async () => {
    client = await boot(3);

    const res = await client.callTool(
      { name: TOOL, arguments: { url: 'https://example.com' } },
      CallToolResultSchema,
    );
    expect(res.isError ?? false).toBe(false);
    expect((res.structuredContent as { implemented?: boolean })?.implemented).toBe(false);

    const called = handle!.auditStore
      .list({ limit: 1000 })
      .filter((r) => r.kind === 'tool_called')
      .map((r) => r.toolName);
    expect(called).toContain(TOOL);
  }, 20_000);
});
