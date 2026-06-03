/**
 * Phase 7A production scenario — see 7a.md.
 *
 * Boots the real orchestrator server with the plugin host active + the real
 * echo subprocess, connects a Maestro-equivalent MCP Client, calls a
 * namespaced plugin tool through the full dispatch path, and asserts the
 * audit log recorded the call (non-defeatable audit before dispatch).
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

const here = path.dirname(fileURLToPath(import.meta.url));
const PLUGINS_ROOT = path.join(here, '..', 'fixtures', 'plugins');

let tmp: string;
let db: SymphonyDatabase;
let handle: OrchestratorServerHandle | undefined;
let client: Client | undefined;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'sym-7a-scn-'));
  saved[SYMPHONY_PLUGINS_DIR_ENV] = process.env[SYMPHONY_PLUGINS_DIR_ENV];
  saved[SYMPHONY_CONFIG_FILE_ENV] = process.env[SYMPHONY_CONFIG_FILE_ENV];
  process.env[SYMPHONY_PLUGINS_DIR_ENV] = PLUGINS_ROOT;
  const configFile = path.join(tmp, 'config.json');
  writeFileSync(configFile, JSON.stringify({ schemaVersion: 1, pluginsEnabled: true }), 'utf8');
  process.env[SYMPHONY_CONFIG_FILE_ENV] = configFile;

  db = SymphonyDatabase.open({ filePath: path.join(tmp, 'symphony.db') });
  new SqlitePluginStore(db.db).upsert({
    id: 'echo',
    name: 'Echo',
    version: '1.0.0',
    source: PLUGINS_ROOT,
    enabled: true,
    now: '2026-06-02T00:00:00.000Z',
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

describe('7A scenario — plugin tool callable end-to-end with audit', () => {
  it('lists + calls a namespaced plugin tool through the server and audits it', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    handle = await startOrchestratorServer({
      transport: serverTransport,
      initialMode: 'act',
      defaultProjectPath: tmp,
      database: db,
      plugins: { enabled: true },
      rpc: { enabled: false },
    });
    expect(handle.pluginHost).toBeDefined();

    client = new Client({ name: 'maestro-equivalent', version: '0.0.0' });
    await client.connect(clientTransport);

    // 2. Discovery via real MCP listTools.
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).toContain('echo__ping');
    expect(names).toContain('echo__echo');

    // 3. Maestro-equivalent calls through the full dispatch path.
    const pong = await client.callTool({ name: 'echo__ping', arguments: {} }, CallToolResultSchema);
    expect((pong.content as Array<{ text?: string }>)[0]?.text).toBe('pong');

    const echoed = await client.callTool(
      { name: 'echo__echo', arguments: { text: 'symphony' } },
      CallToolResultSchema,
    );
    expect((echoed.content as Array<{ text?: string }>)[0]?.text).toBe('echo: symphony');

    // 4. Non-defeatable audit: tool_called rows for both plugin tools.
    const rows = handle.auditStore.list({ limit: 1000 });
    const calledTools = rows
      .filter((r) => r.kind === 'tool_called')
      .map((r) => r.toolName);
    expect(calledTools).toContain('echo__ping');
    expect(calledTools).toContain('echo__echo');
  }, 20_000);
});
