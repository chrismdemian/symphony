/**
 * Phase 7B.3 production scenario — see 7b3.md.
 *
 * Boots the real orchestrator server with the plugin host active + the real
 * `enrich` subprocess, connects a Maestro-equivalent MCP Client, and proves
 * the three host-enrichment deliverables end to end through the full stack:
 *   1. Hidden event-handler tools + the over-permissioned tool are NOT in
 *      Maestro's listTools() toolbelt; the granted tools ARE.
 *   2. Calling the real `create_task` tool fires `onTaskCreated` all the way
 *      through TaskStore.create → server fan-out → plugin handler (observed
 *      via the plugin's get_event_count).
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
  tmp = mkdtempSync(path.join(os.tmpdir(), 'sym-7b3-scn-'));
  saved[SYMPHONY_PLUGINS_DIR_ENV] = process.env[SYMPHONY_PLUGINS_DIR_ENV];
  saved[SYMPHONY_CONFIG_FILE_ENV] = process.env[SYMPHONY_CONFIG_FILE_ENV];
  process.env[SYMPHONY_PLUGINS_DIR_ENV] = PLUGINS_ROOT;
  const configFile = path.join(tmp, 'config.json');
  writeFileSync(configFile, JSON.stringify({ schemaVersion: 1, pluginsEnabled: true }), 'utf8');
  process.env[SYMPHONY_CONFIG_FILE_ENV] = configFile;

  db = SymphonyDatabase.open({ filePath: path.join(tmp, 'symphony.db') });
  // A project the scenario's create_task can target.
  db.db
    .prepare(`INSERT INTO projects (id, name, path, created_at) VALUES (?, ?, ?, ?)`)
    .run('proj1', 'proj1', tmp.replace(/\\/g, '/'), '2026-06-03T00:00:00.000Z');
  new SqlitePluginStore(db.db).upsert({
    id: 'enrich',
    name: 'Enrich',
    version: '1.0.0',
    source: PLUGINS_ROOT,
    enabled: true,
    now: '2026-06-03T00:00:00.000Z',
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

describe('7B.3 scenario — host enrichment end-to-end', () => {
  it('hides handlers/refused tools from the toolbelt and delivers onTaskCreated on create_task', async () => {
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

    // 1. Toolbelt visibility — deliverables 1 + 3.
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('enrich__safe_read'); // granted-permission tool registered
    expect(names).toContain('enrich__get_event_count');
    expect(names).not.toContain('enrich__on_task_created'); // event handler hidden
    expect(names).not.toContain('enrich__on_worker_spawned'); // event handler hidden
    expect(names).not.toContain('enrich__over_reach'); // over-permissioned → refused

    // Baseline: no events delivered yet.
    const before = await client.callTool({ name: 'enrich__get_event_count', arguments: {} }, CallToolResultSchema);
    expect((before.structuredContent as { count: number }).count).toBe(0);

    // 2. Create a task through the real MCP tool → fires onTaskCreated all
    //    the way to the plugin's hidden handler.
    const created = await client.callTool(
      { name: 'create_task', arguments: { project: 'proj1', description: 'scenario task' } },
      CallToolResultSchema,
    );
    expect(created.isError ?? false).toBe(false);

    // Allow the fire-and-forget event to round-trip the subprocess.
    await new Promise((r) => setTimeout(r, 400));
    const after = await client.callTool({ name: 'enrich__get_event_count', arguments: {} }, CallToolResultSchema);
    expect((after.structuredContent as { count: number }).count).toBe(1);
  }, 25_000);
});
