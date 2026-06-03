/**
 * Phase 7B.1 production scenario — see research/phase-reviews/7b1.md.
 *
 * The full authoring → distribution → runtime loop for an SDK-built plugin:
 *   1. Stage what the example would ship (plugin.json + dist).
 *   2. Install it via the REAL `installPlugin` path (copy into the store +
 *      register the row) — disabled by default; then enable it.
 *   3. Boot the real orchestrator server with the plugin host active.
 *   4. A Maestro-equivalent MCP Client lists + calls the namespaced
 *      `notifier-example__notifier_status` tool through the full dispatch
 *      path, and the call is recorded in the audit log.
 *
 * Requires `pnpm build:packages` (the example bundles the SDK). Skips with
 * a warning otherwise.
 */
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  copyFileSync,
  existsSync,
  writeFileSync,
} from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';

import { startOrchestratorServer, type OrchestratorServerHandle } from '../../src/orchestrator/server.js';
import { SymphonyDatabase } from '../../src/state/db.js';
import { SqlitePluginStore } from '../../src/plugins/store.js';
import { installPlugin } from '../../src/plugins/install.js';
import { SYMPHONY_PLUGINS_DIR_ENV } from '../../src/plugins/paths.js';
import { SYMPHONY_CONFIG_FILE_ENV } from '../../src/utils/config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLE_DIR = path.resolve(here, '..', '..', 'packages', 'examples', 'notifier');
const EXAMPLE_DIST = path.join(EXAMPLE_DIR, 'dist', 'index.js');
const EXAMPLE_MANIFEST = path.join(EXAMPLE_DIR, 'plugin.json');
const BUILT = existsSync(EXAMPLE_DIST);

let tmp: string;
let db: SymphonyDatabase;
let handle: OrchestratorServerHandle | undefined;
let client: Client | undefined;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'sym-7b1-scn-'));
  saved[SYMPHONY_PLUGINS_DIR_ENV] = process.env[SYMPHONY_PLUGINS_DIR_ENV];
  saved[SYMPHONY_CONFIG_FILE_ENV] = process.env[SYMPHONY_CONFIG_FILE_ENV];
  process.env[SYMPHONY_PLUGINS_DIR_ENV] = path.join(tmp, 'plugins');
  const configFile = path.join(tmp, 'config.json');
  writeFileSync(configFile, JSON.stringify({ schemaVersion: 1, pluginsEnabled: true }), 'utf8');
  process.env[SYMPHONY_CONFIG_FILE_ENV] = configFile;
  db = SymphonyDatabase.open({ filePath: path.join(tmp, 'symphony.db') });
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

describe('7B.1 scenario — install an SDK-built plugin and call it end-to-end', () => {
  it.skipIf(!BUILT)(
    'installs, enables, and calls the notifier tool through the full server with audit',
    async () => {
      // 1. Stage what the example ships (plugin.json + dist).
      const stage = path.join(tmp, 'stage');
      mkdirSync(path.join(stage, 'dist'), { recursive: true });
      copyFileSync(EXAMPLE_MANIFEST, path.join(stage, 'plugin.json'));
      copyFileSync(EXAMPLE_DIST, path.join(stage, 'dist', 'index.js'));

      // 2. Real install path → store row (default-disabled), then enable.
      const store = new SqlitePluginStore(db.db);
      const install = await installPlugin({ source: stage, store, now: '2026-06-03T00:00:00.000Z' });
      expect(install.ok).toBe(true);
      expect(install.manifest?.id).toBe('notifier-example');
      expect(store.get('notifier-example')?.enabled).toBe(false);
      store.setEnabled('notifier-example', true, '2026-06-03T00:00:01.000Z');

      // 3. Boot the full server with the plugin host active.
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

      // 4. Discover + call the namespaced plugin tool through dispatch.
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name)).toContain('notifier-example__notifier_status');

      const res = await client.callTool(
        { name: 'notifier-example__notifier_status', arguments: {} },
        CallToolResultSchema,
      );
      // 7B.3 — the notifier now tracks task + worker events; its empty-state
      // message is "No notifications yet." (it gained worker handlers).
      expect((res.content as Array<{ text?: string }>)[0]?.text).toContain('No notifications yet');

      // 5. Non-defeatable audit recorded the call.
      const called = handle.auditStore
        .list({ limit: 1000 })
        .filter((r) => r.kind === 'tool_called')
        .map((r) => r.toolName);
      expect(called).toContain('notifier-example__notifier_status');
    },
    30_000,
  );

  it.skipIf(BUILT)('skips when the example is not built', () => {
    console.warn('[7b1] notifier example not built — run `pnpm build:packages` first.');
    expect(BUILT).toBe(false);
  });
});
