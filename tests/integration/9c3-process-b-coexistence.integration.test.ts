/**
 * Phase 9C.3 — Process-B coexistence: the in-tree Plain / Sentry connectors must
 * YIELD in the bootstrap server (no `--plugins`) when the corresponding
 * issue-source plugin is enabled. The server.ts gate is source-agnostic
 * (`!pluginIssueSources.has(SOURCE)` for all 9 connectors); this makes the
 * plain/sentry clauses executable + regression-locked.
 *
 * An A/B proof. The in-tree connectors only construct when their on-disk config
 * is present (token in `~/.symphony/integrations/<source>-token`, plus — for
 * Sentry — a `sentry.json` carrying the org + projects it needs to activate;
 * Plain activates on a token alone, like Linear). `tests/setup.ts` sets
 * `SYMPHONY_DISABLE_KEYRING=1` so `readToken` uses the file backend under HOME.
 * We point HOME / USERPROFILE at a temp dir, write the config there, and:
 *   - control (plugin NOT enabled): in-tree constructs → `sync_<source>` present
 *   - yield   (plugin enabled):     in-tree yields     → `sync_<source>` absent
 *     (no plugin host in Process B, so the plugin's tool isn't here either).
 *
 * For Sentry this also proves the `sentry_error` 8D trigger source drops: it is
 * co-gated on the same (now-undefined) connector, so `sync_sentry` absent ⇒ the
 * trigger source was never added either.
 */
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

import {
  startOrchestratorServer,
  type OrchestratorServerHandle,
  type OrchestratorServerOptions,
} from '../../src/orchestrator/server.js';
import { SymphonyDatabase } from '../../src/state/db.js';
import { SqlitePluginStore } from '../../src/plugins/store.js';
import { SYMPHONY_PLUGINS_DIR_ENV } from '../../src/plugins/paths.js';
import { SYMPHONY_CONFIG_FILE_ENV } from '../../src/utils/config.js';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const PLUGINS_ROOT = path.join(here, '..', 'fixtures', 'plugins');

let tmp: string;
let homeDir: string;
let integrationsDir: string;
let db: SymphonyDatabase;
let handle: OrchestratorServerHandle | undefined;
let client: Client | undefined;
const saved: Record<string, string | undefined> = {};

const SOURCES: ReadonlyArray<{
  id: string;
  source: string;
  boot: Partial<OrchestratorServerOptions>;
}> = [
  { id: 'plain-source', source: 'plain', boot: { plain: { enabled: true } } },
  { id: 'sentry-source', source: 'sentry', boot: { sentry: { enabled: true } } },
];

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'sym-9c3-pb-'));
  homeDir = path.join(tmp, 'home');
  integrationsDir = path.join(homeDir, '.symphony', 'integrations');
  mkdirSync(integrationsDir, { recursive: true });

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

/** Write the on-disk token + sidecar so the in-tree connector constructs. */
function configureInTree(source: string): void {
  writeFileSync(path.join(integrationsDir, `${source}-token`), 'tok_xyz', 'utf8');
  if (source === 'sentry') {
    // Sentry needs an org + at least one project to activate.
    writeFileSync(
      path.join(integrationsDir, 'sentry.json'),
      JSON.stringify({ org: 'acme', projects: ['backend'] }),
      'utf8',
    );
  }
  // Plain activates on a token alone (no sidecar required), like Linear.
}

async function bootAndListTools(boot: Partial<OrchestratorServerOptions>): Promise<string[]> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  handle = await startOrchestratorServer({
    transport: serverTransport,
    initialMode: 'act',
    initialTier: 2,
    defaultProjectPath: tmp,
    database: db,
    rpc: { enabled: false },
    ...boot, // in-tree activation (reads the temp-home config)
    // NO `plugins` option — this is the bootstrap (Process B) role.
  });
  client = new Client({ name: 'probe', version: '0.0.0' });
  await client.connect(clientTransport);
  return (await client.listTools()).tools.map((t) => t.name);
}

describe('9C.3 Process-B coexistence — in-tree plain/sentry yield when the plugin is enabled', () => {
  it.each(SOURCES)(
    'control: with NO $source plugin enabled, the in-tree connector registers sync_$source',
    async ({ source, boot }) => {
      configureInTree(source);
      const names = await bootAndListTools(boot);
      expect(names).toContain(`sync_${source}`); // in-tree constructed from the temp-home config
    },
    30_000,
  );

  it.each(SOURCES)(
    'yield: with the $source plugin enabled, the in-tree connector yields',
    async ({ id, source, boot }) => {
      configureInTree(source);
      new SqlitePluginStore(db.db).upsert({
        id,
        name: id,
        version: '1.0.0',
        source: PLUGINS_ROOT,
        enabled: true,
        now: '2026-06-10T00:00:00.000Z',
      });
      const names = await bootAndListTools(boot);
      // In-tree yielded → undefined → no sync_<source> registered. No plugin host
      // in Process B, so the plugin's sync_<source> isn't here either. For Sentry
      // the `sentry_error` 8D trigger source is co-gated on the same connector, so
      // it was never added either.
      expect(names).not.toContain(`sync_${source}`);
    },
    30_000,
  );
});
