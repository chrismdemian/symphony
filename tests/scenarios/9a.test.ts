/**
 * Phase 9A production scenario — see 9a.md.
 *
 * Boots the real orchestrator server with the plugin host active + the real
 * `github-source` subprocess, connects a Maestro-equivalent MCP client, and
 * drives the issue-source bridge through the FULL server wiring (coexistence
 * discovery, the plugin-writeback-refs fan-out, the host issue-source deps):
 *   - `sync_github` is served by the plugin; the issue-source internal tools
 *     are hidden; `github-source__get_writeback_log` is a normal proxy
 *   - calling `sync_github` fetches via the subprocess + creates a task
 *   - completing that task fans terminal-status writeback to the plugin
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
  tmp = mkdtempSync(path.join(os.tmpdir(), 'sym-9a-scn-'));
  saved[SYMPHONY_PLUGINS_DIR_ENV] = process.env[SYMPHONY_PLUGINS_DIR_ENV];
  saved[SYMPHONY_CONFIG_FILE_ENV] = process.env[SYMPHONY_CONFIG_FILE_ENV];
  process.env[SYMPHONY_PLUGINS_DIR_ENV] = PLUGINS_ROOT;
  const configFile = path.join(tmp, 'config.json');
  writeFileSync(configFile, JSON.stringify({ schemaVersion: 1, pluginsEnabled: true }), 'utf8');
  process.env[SYMPHONY_CONFIG_FILE_ENV] = configFile;

  db = SymphonyDatabase.open({ filePath: path.join(tmp, 'symphony.db') });
  new SqlitePluginStore(db.db).upsert({
    id: 'github-source',
    name: 'GitHub source fixture',
    version: '1.0.0',
    source: PLUGINS_ROOT,
    enabled: true,
    now: '2026-06-09T00:00:00.000Z',
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

function textOf(res: unknown): string {
  const content = (res as { content?: Array<{ text?: string }> }).content ?? [];
  return content.map((c) => c.text ?? '').join('');
}

describe('9A scenario — issue-source plugin end-to-end through the server', () => {
  it('serves sync_github, hides internal tools, ingests, and writes back on completion', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    handle = await startOrchestratorServer({
      transport: serverTransport,
      initialMode: 'act',
      initialTier: 2, // requires-secrets-read floor on sync_<source>
      defaultProjectPath: tmp,
      database: db,
      plugins: { enabled: true },
      github: { enabled: true }, // in-tree GitHub activation — must YIELD to the plugin (coexistence)
      rpc: { enabled: false },
    });
    expect(handle.pluginHost).toBeDefined();

    client = new Client({ name: 'maestro-equivalent', version: '0.0.0' });
    await client.connect(clientTransport);

    // The plugin's sync_github is the registered tool; internal tools hidden.
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('sync_github');
    expect(names).toContain('github-source__get_writeback_log');
    expect(names).not.toContain('github-source__fetch_open_issues');
    expect(names).not.toContain('github-source__write_back_status');
    // Exactly one sync_github (no in-tree duplicate — coexistence gate held).
    expect(names.filter((n) => n === 'sync_github')).toHaveLength(1);

    // Call sync_github through the full dispatch path. The fixture's open
    // issue routes to the default project (via the absolute default path);
    // the terminal one is skipped, the malformed one dropped by the adapter.
    const syncRes = await client.callTool(
      { name: 'sync_github', arguments: { project: tmp } },
      CallToolResultSchema,
    );
    const sc = syncRes.structuredContent as { createdCount: number; created: string[]; skippedDone: number };
    expect(sc.createdCount).toBe(1);
    expect(sc.skippedDone).toBe(1);
    const taskId = sc.created[0]!;

    // Drive the task to completion via the real update_task MCP tool. The
    // terminal transition fans out through fanOutTaskStatusChange → the
    // plugin's writeback ref → the subprocess `write_back_status`.
    await client.callTool({ name: 'update_task', arguments: { task_id: taskId, status: 'in_progress' } }, CallToolResultSchema);
    await client.callTool({ name: 'update_task', arguments: { task_id: taskId, status: 'completed' } }, CallToolResultSchema);
    await new Promise((r) => setTimeout(r, 500)); // writeback is fire-and-forget

    const logRes = await client.callTool(
      { name: 'github-source__get_writeback_log', arguments: {} },
      CallToolResultSchema,
    );
    const calls = (logRes.structuredContent as { calls: Array<{ externalId: string; status: string }> }).calls;
    expect(calls).toEqual([{ externalId: 'acme/widgets#1', status: 'completed' }]);
    expect(textOf(logRes)).toContain('acme/widgets#1');
  }, 30_000);
});
