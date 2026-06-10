/**
 * Phase 9B production scenario — see 9b.md.
 *
 * Boots the real orchestrator server with the plugin host active + the real
 * notion-source AND obsidian-source subprocesses, connects a Maestro-
 * equivalent MCP client, and drives BOTH issue-source bridges through the FULL
 * server wiring (coexistence discovery, the plugin-writeback-refs fan-out, the
 * host issue-source deps):
 *   - `sync_notion` / `sync_obsidian` are served by the plugins; the in-tree
 *     connectors YIELD (exactly one of each tool — coexistence gate held)
 *   - the issue-source internal tools are hidden; `<id>__get_writeback_log` is
 *     a normal proxy
 *   - calling each `sync_<source>` fetches via the subprocess + creates a task
 *   - completing each task fans terminal-status writeback to its plugin
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
  tmp = mkdtempSync(path.join(os.tmpdir(), 'sym-9b-scn-'));
  saved[SYMPHONY_PLUGINS_DIR_ENV] = process.env[SYMPHONY_PLUGINS_DIR_ENV];
  saved[SYMPHONY_CONFIG_FILE_ENV] = process.env[SYMPHONY_CONFIG_FILE_ENV];
  process.env[SYMPHONY_PLUGINS_DIR_ENV] = PLUGINS_ROOT;
  const configFile = path.join(tmp, 'config.json');
  writeFileSync(configFile, JSON.stringify({ schemaVersion: 1, pluginsEnabled: true }), 'utf8');
  process.env[SYMPHONY_CONFIG_FILE_ENV] = configFile;

  db = SymphonyDatabase.open({ filePath: path.join(tmp, 'symphony.db') });
  const store = new SqlitePluginStore(db.db);
  for (const id of ['notion-source', 'obsidian-source']) {
    store.upsert({ id, name: id, version: '1.0.0', source: PLUGINS_ROOT, enabled: true, now: '2026-06-09T00:00:00.000Z' });
  }
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

async function syncAndComplete(c: Client, source: string, externalId: string): Promise<void> {
  const syncRes = await c.callTool({ name: `sync_${source}`, arguments: { project: tmp } }, CallToolResultSchema);
  const sc = syncRes.structuredContent as { createdCount: number; created: string[]; skippedDone: number };
  expect(sc.createdCount).toBe(1);
  expect(sc.skippedDone).toBe(1);
  const taskId = sc.created[0]!;

  await c.callTool({ name: 'update_task', arguments: { task_id: taskId, status: 'in_progress' } }, CallToolResultSchema);
  await c.callTool({ name: 'update_task', arguments: { task_id: taskId, status: 'completed' } }, CallToolResultSchema);
  await new Promise((r) => setTimeout(r, 500)); // writeback is fire-and-forget

  const logRes = await c.callTool({ name: `${source}-source__get_writeback_log`, arguments: {} }, CallToolResultSchema);
  const calls = (logRes.structuredContent as { calls: Array<{ externalId: string; status: string }> }).calls;
  expect(calls).toEqual([{ externalId, status: 'completed' }]);
}

describe('9B scenario — notion + obsidian issue-source plugins end-to-end', () => {
  it('serves sync_notion + sync_obsidian, in-tree yields, ingests, and writes back on completion', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    handle = await startOrchestratorServer({
      transport: serverTransport,
      initialMode: 'act',
      initialTier: 2, // requires-secrets-read / external-visible floor on sync_<source>
      defaultProjectPath: tmp,
      database: db,
      plugins: { enabled: true },
      notion: { enabled: true }, // in-tree activation — must YIELD to the plugin
      obsidian: { enabled: true }, // in-tree activation — must YIELD (connector + watcher)
      rpc: { enabled: false },
    });
    expect(handle.pluginHost).toBeDefined();

    client = new Client({ name: 'maestro-equivalent', version: '0.0.0' });
    await client.connect(clientTransport);

    const names = (await client.listTools()).tools.map((t) => t.name);
    // Both plugin sync tools present; internal tools hidden.
    expect(names).toContain('sync_notion');
    expect(names).toContain('sync_obsidian');
    expect(names).toContain('notion-source__get_writeback_log');
    expect(names).toContain('obsidian-source__get_writeback_log');
    expect(names).not.toContain('notion-source__fetch_open_issues');
    expect(names).not.toContain('obsidian-source__write_back_status');
    // Coexistence gate held — exactly one of each (no in-tree duplicate).
    expect(names.filter((n) => n === 'sync_notion')).toHaveLength(1);
    expect(names.filter((n) => n === 'sync_obsidian')).toHaveLength(1);

    await syncAndComplete(client, 'notion', 'page-open-1');
    await syncAndComplete(client, 'obsidian', 'notes/todo.md#h:abc123');
  }, 40_000);
});
