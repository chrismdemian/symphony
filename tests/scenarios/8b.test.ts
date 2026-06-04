import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  startOrchestratorServer,
  type OrchestratorServerHandle,
} from '../../src/orchestrator/index.js';
import { SymphonyDatabase } from '../../src/state/db.js';
import { SqliteExternalLinkStore } from '../../src/state/sqlite-external-link-store.js';
import { ObsidianConnector } from '../../src/integrations/obsidian.js';
import { defaultObsidianConfig } from '../../src/integrations/obsidian-config.js';
import { createVaultFs } from '../../src/integrations/obsidian-vault.js';

/**
 * Phase 8B production scenario — see 8b.md. Real server + temp-FILE SQLite +
 * a REAL Obsidian connector over a REAL temp vault. Adds the
 * persistence-across-fresh-store leg + the on-disk checkbox-flip writeback on
 * top of the :memory: integration test.
 */

interface Harness {
  client: Client;
  server: OrchestratorServerHandle;
  db: SymphonyDatabase;
  tmpRoot: string;
  vault: string;
  todoFile: string;
}

async function setup(): Promise<Harness> {
  const tmpRoot = mkdtempSync(path.join(tmpdir(), 'symphony-8b-'));
  const vault = path.join(tmpRoot, 'vault');
  const dbFile = path.join(tmpRoot, 'symphony.db');
  // Build the vault on disk.
  mkdirSync(vault, { recursive: true });
  const todoFile = path.join(vault, 'todo.md');
  writeFileSync(
    todoFile,
    ['---', 'project: alpha', '---', '- [ ] Closeable alpha task', '- [ ] Second alpha task', '- [x] Already done'].join(
      '\n',
    ),
    'utf8',
  );
  writeFileSync(
    path.join(vault, 'beta.md'),
    ['---', 'project: beta', '---', '- [/] Open beta task'].join('\n'),
    'utf8',
  );

  const db = SymphonyDatabase.open({ filePath: dbFile });
  const config = defaultObsidianConfig(vault);
  const connector = new ObsidianConnector({
    vault: createVaultFs(vault, { exclude: config.exclude }),
    config,
    now: () => Date.parse('2026-06-10T09:00:00Z'),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = await startOrchestratorServer({
    transport: serverTransport,
    initialMode: 'act',
    initialTier: 2, // sync_obsidian is external-visible → tier >= 2
    database: db,
    projects: { alpha: path.join(tmpRoot, 'alpha'), beta: path.join(tmpRoot, 'beta') },
    obsidianConnector: connector,
  });
  const client = new Client({ name: '8b-scenario', version: '0.0.0' });
  await client.connect(clientTransport);
  return { client, server, db, tmpRoot, vault, todoFile };
}

async function flush(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await Promise.resolve();
}

describe('Phase 8B — production scenario (real server, real vault, temp-file SQLite)', () => {
  let h: Harness | null = null;

  beforeEach(async () => {
    h = await setup();
  });

  afterEach(async () => {
    if (!h) return;
    await h.client.close().catch(() => {});
    await h.server.close().catch(() => {});
    h.db.close();
    try {
      rmSync(h.tmpRoot, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      /* windows file-lock retry — best effort */
    }
    h = null;
  });

  it('syncs, dedups, persists links across a fresh store, and flips the checkbox on completion', async () => {
    const cur = h!;

    // (2) create + route + link; skip the done line
    const res = await cur.client.callTool({ name: 'sync_obsidian', arguments: {} });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as {
      createdCount: number;
      skippedDone: number;
      created: string[];
    };
    expect(sc.createdCount).toBe(3); // 2 alpha + 1 beta
    expect(sc.skippedDone).toBe(1);
    expect(cur.server.taskStore.size()).toBe(3);

    // (3) idempotent re-sync
    const res2 = await cur.client.callTool({ name: 'sync_obsidian', arguments: {} });
    const sc2 = res2.structuredContent as { createdCount: number; skippedExisting: number };
    expect(sc2.createdCount).toBe(0);
    expect(sc2.skippedExisting).toBe(3);

    // (5) checkbox writeback on completion. Created order follows the
    // alphabetical file walk (beta.md before todo.md), so select by
    // description rather than assuming an index.
    const closeable = cur.server.taskStore
      .list()
      .find((t) => t.description === 'Closeable alpha task');
    expect(closeable).toBeDefined();
    const taskId = closeable!.id;
    cur.server.taskStore.update(taskId, { status: 'in_progress' });
    cur.server.taskStore.update(taskId, { status: 'completed' });
    await flush();
    await new Promise((r) => setTimeout(r, 60)); // per-file write settles

    const after = readFileSync(cur.todoFile, 'utf8');
    expect(after).toContain('- [x] Closeable alpha task ✅ 2026-06-10');
    expect(after).toContain('- [ ] Second alpha task'); // sibling untouched

    // (4) persistence across a fresh store over the SAME db file
    const fresh = new SqliteExternalLinkStore(cur.db.db);
    expect(fresh.listExternalIds('obsidian').size).toBe(3);
  });
});
