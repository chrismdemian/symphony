/**
 * Phase 9B — Process-B coexistence: the in-tree Obsidian connector AND its
 * background watcher must YIELD in the bootstrap server (no `--plugins`) when
 * an obsidian issue-source plugin is enabled. 9A's gate only fired in Maestro's
 * `--plugins` child (Process C); 9B computes the discovery set in both.
 *
 * This is an A/B proof. The in-tree Obsidian connector only constructs when
 * there's an on-disk `~/.symphony/integrations/obsidian.json` — which it reads
 * from the REAL home (`os.homedir()`, no test seam). So we point HOME /
 * USERPROFILE at a temp dir, write a real obsidian.json + a vault there, and:
 *   - control (plugin NOT enabled): in-tree constructs → `sync_obsidian` present
 *   - yield   (plugin enabled):     in-tree yields     → `sync_obsidian` absent
 * `sync_obsidian` absent proves the connector is `undefined`, which also means
 * the watcher (nested under `if (obsidianConnector !== undefined)`) never started.
 */
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

import { startOrchestratorServer, type OrchestratorServerHandle } from '../../src/orchestrator/server.js';
import { SymphonyDatabase } from '../../src/state/db.js';
import { SqlitePluginStore } from '../../src/plugins/store.js';
import { SYMPHONY_PLUGINS_DIR_ENV } from '../../src/plugins/paths.js';
import { SYMPHONY_CONFIG_FILE_ENV } from '../../src/utils/config.js';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const PLUGINS_ROOT = path.join(here, '..', 'fixtures', 'plugins');

let tmp: string;
let homeDir: string;
let db: SymphonyDatabase;
let handle: OrchestratorServerHandle | undefined;
let client: Client | undefined;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'sym-9b-pb-'));
  homeDir = path.join(tmp, 'home');
  const vault = path.join(tmp, 'vault');
  mkdirSync(path.join(homeDir, '.symphony', 'integrations'), { recursive: true });
  mkdirSync(vault, { recursive: true });
  writeFileSync(path.join(vault, 'todo.md'), '- [ ] A real vault task\n', 'utf8');
  writeFileSync(
    path.join(homeDir, '.symphony', 'integrations', 'obsidian.json'),
    JSON.stringify({ vaultPath: vault, watch: false }),
    'utf8',
  );

  for (const k of ['USERPROFILE', 'HOME', SYMPHONY_PLUGINS_DIR_ENV, SYMPHONY_CONFIG_FILE_ENV]) {
    saved[k] = process.env[k];
  }
  process.env.USERPROFILE = homeDir;
  process.env.HOME = homeDir;
  process.env[SYMPHONY_PLUGINS_DIR_ENV] = PLUGINS_ROOT;
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

async function bootAndListTools(): Promise<string[]> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  handle = await startOrchestratorServer({
    transport: serverTransport,
    initialMode: 'act',
    initialTier: 2,
    defaultProjectPath: tmp,
    database: db,
    obsidian: { enabled: true }, // in-tree activation (reads the temp-home obsidian.json)
    rpc: { enabled: false },
    // NO `plugins` option — this is the bootstrap (Process B) role.
  });
  client = new Client({ name: 'probe', version: '0.0.0' });
  await client.connect(clientTransport);
  return (await client.listTools()).tools.map((t) => t.name);
}

describe('9B Process-B coexistence — in-tree Obsidian yields when the plugin is enabled', () => {
  it('control: with NO obsidian plugin enabled, the in-tree connector registers sync_obsidian', async () => {
    const names = await bootAndListTools();
    expect(names).toContain('sync_obsidian'); // in-tree constructed from the temp-home config
  }, 30_000);

  it('yield: with the obsidian plugin enabled, the in-tree connector (and watcher) yield', async () => {
    new SqlitePluginStore(db.db).upsert({
      id: 'obsidian-source',
      name: 'obsidian-source',
      version: '1.0.0',
      source: PLUGINS_ROOT,
      enabled: true,
      now: '2026-06-09T00:00:00.000Z',
    });
    const names = await bootAndListTools();
    // In-tree yielded → undefined → no sync_obsidian registered (and the watcher,
    // nested under `if (obsidianConnector !== undefined)`, never started). No
    // plugin host in Process B, so the plugin's sync_obsidian isn't here either.
    expect(names).not.toContain('sync_obsidian');
  }, 30_000);
});
