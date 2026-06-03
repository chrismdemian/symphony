/**
 * Phase 7A — plugin host activation wiring in `startOrchestratorServer`.
 *
 * Proves the two-gate default-deny: the host activates ONLY when BOTH
 * `options.plugins.enabled` (Maestro's MCP child) AND the `pluginsEnabled`
 * config master switch are true (plus a persistent DB). Uses the real echo
 * fixture subprocess so the registered proxy tools are genuinely
 * discovered over MCP.
 */
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

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
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'sym-7a-server-'));
  saved[SYMPHONY_PLUGINS_DIR_ENV] = process.env[SYMPHONY_PLUGINS_DIR_ENV];
  saved[SYMPHONY_CONFIG_FILE_ENV] = process.env[SYMPHONY_CONFIG_FILE_ENV];
  process.env[SYMPHONY_PLUGINS_DIR_ENV] = PLUGINS_ROOT;
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
  if (handle !== undefined) await handle.close();
  handle = undefined;
  db.close();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tmp, { recursive: true, force: true });
});

function writeConfig(pluginsEnabled: boolean): void {
  const file = path.join(tmp, 'config.json');
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, pluginsEnabled }), 'utf8');
  process.env[SYMPHONY_CONFIG_FILE_ENV] = file;
}

async function boot(pluginsOption: boolean): Promise<OrchestratorServerHandle> {
  const [, serverTransport] = InMemoryTransport.createLinkedPair();
  return startOrchestratorServer({
    transport: serverTransport,
    initialMode: 'act',
    defaultProjectPath: tmp,
    database: db,
    ...(pluginsOption ? { plugins: { enabled: true } } : {}),
    rpc: { enabled: false },
  });
}

describe('7A plugin host activation', () => {
  it('activates + registers proxy tools when master switch ON and --plugins set', async () => {
    writeConfig(true);
    handle = await boot(true);
    expect(handle.pluginHost).toBeDefined();
    const toolNames = handle.registry.list().map((t) => t.name);
    expect(toolNames).toContain('echo__ping');
    expect(toolNames).toContain('echo__echo');
    // Plugin tools are scope 'both' (echo manifest) → enabled in act mode.
    const ping = handle.registry.list().find((t) => t.name === 'echo__ping');
    expect(ping?.enabled).toBe(true);
  }, 20_000);

  it('does NOT activate when the master switch is OFF (default-deny)', async () => {
    writeConfig(false);
    handle = await boot(true);
    expect(handle.pluginHost).toBeUndefined();
    expect(handle.registry.list().some((t) => t.name.startsWith('echo__'))).toBe(false);
  }, 20_000);

  it('does NOT activate without the --plugins option (bootstrap server)', async () => {
    writeConfig(true);
    handle = await boot(false);
    expect(handle.pluginHost).toBeUndefined();
    expect(handle.registry.list().some((t) => t.name.startsWith('echo__'))).toBe(false);
  }, 20_000);
});
