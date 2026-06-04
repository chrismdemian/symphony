import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  startOrchestratorServer,
  type OrchestratorServerHandle,
} from '../../src/orchestrator/index.js';
import { SymphonyDatabase } from '../../src/state/db.js';
import { ObsidianConnector } from '../../src/integrations/obsidian.js';
import { defaultObsidianConfig } from '../../src/integrations/obsidian-config.js';
import { createVaultFs } from '../../src/integrations/obsidian-vault.js';
import { ObsidianVaultWatcher } from '../../src/integrations/obsidian-watcher.js';
import { MemoryExternalLinkStore } from '../../src/state/external-link-store.js';
import { ProjectRegistry } from '../../src/projects/registry.js';
import { TaskRegistry } from '../../src/state/task-registry.js';
import type { ProjectRecord } from '../../src/projects/types.js';

/**
 * Phase 8B integration — a REAL Obsidian connector over a REAL temp vault
 * (the "API" is the filesystem, so no fake is needed). Proves: sync_obsidian
 * creates tasks + links idempotently and skips done; a terminal task
 * transition flips the checkbox in the source markdown; and the live chokidar
 * watcher ingests a newly-added task line.
 */

function makeVault(): string {
  return mkdtempSync(path.join(tmpdir(), 'symphony-obs-vault-'));
}

function realConnector(vaultRoot: string, now?: () => number): ObsidianConnector {
  const config = defaultObsidianConfig(vaultRoot);
  const vault = createVaultFs(vaultRoot, { exclude: config.exclude });
  return new ObsidianConnector({ vault, config, ...(now !== undefined ? { now } : {}) });
}

interface Harness {
  client: Client;
  server: OrchestratorServerHandle;
  db: SymphonyDatabase;
  vault: string;
}

async function setup(vaultRoot: string, now?: () => number): Promise<Harness> {
  const db = SymphonyDatabase.open({ filePath: ':memory:' });
  const connector = realConnector(vaultRoot, now);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = await startOrchestratorServer({
    transport: serverTransport,
    initialMode: 'act',
    // sync_obsidian declares external-visible → autonomy tier >= 2.
    initialTier: 2,
    database: db,
    projects: { main: path.join(vaultRoot, '_proj_main'), other: path.join(vaultRoot, '_proj_other') },
    obsidianConnector: connector,
  });
  const client = new Client({ name: '8b-integration', version: '0.0.0' });
  await client.connect(clientTransport);
  return { client, server, db, vault: vaultRoot };
}

async function flush(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await Promise.resolve();
}

describe('Phase 8B — Obsidian sync (integration)', () => {
  let h: Harness | null = null;
  const dirs: string[] = [];
  afterEach(async () => {
    if (h) {
      await h.client.close().catch(() => {});
      await h.server.close().catch(() => {});
      h.db.close();
      h = null;
    }
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('sync_obsidian creates a task + link per open line, idempotently, skipping done', async () => {
    const vault = makeVault();
    dirs.push(vault);
    writeFileSync(
      path.join(vault, 'tasks.md'),
      ['---', 'project: main', '---', '- [ ] First task ⏫', '- [x] Done already', '- [/] Second task'].join(
        '\n',
      ),
      'utf8',
    );
    writeFileSync(
      path.join(vault, 'other.md'),
      ['---', 'project: other', '---', '- [ ] Third task'].join('\n'),
      'utf8',
    );
    h = await setup(vault);

    const res = await h.client.callTool({ name: 'sync_obsidian', arguments: {} });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as {
      createdCount: number;
      skippedDone: number;
      created: string[];
    };
    expect(sc.createdCount).toBe(3);
    expect(sc.skippedDone).toBe(1);
    expect(h.server.taskStore.size()).toBe(3);

    // Re-sync is a no-op (idempotent via external-link dedup).
    const res2 = await h.client.callTool({ name: 'sync_obsidian', arguments: {} });
    const sc2 = res2.structuredContent as { createdCount: number; skippedExisting: number };
    expect(sc2.createdCount).toBe(0);
    expect(sc2.skippedExisting).toBe(3);
    expect(h.server.taskStore.size()).toBe(3);
  });

  it('flips the checkbox in the source markdown on task completion', async () => {
    const vault = makeVault();
    dirs.push(vault);
    const file = path.join(vault, 'todo.md');
    writeFileSync(
      file,
      ['---', 'project: main', '---', '- [ ] Closeable task', '- [ ] Other task'].join('\n'),
      'utf8',
    );
    h = await setup(vault, () => Date.parse('2026-06-10T09:00:00Z'));

    const res = await h.client.callTool({ name: 'sync_obsidian', arguments: {} });
    const created = (res.structuredContent as { created: string[] }).created;
    // The first created task corresponds to "Closeable task".
    const taskId = created[0]!;

    h.server.taskStore.update(taskId, { status: 'in_progress' });
    h.server.taskStore.update(taskId, { status: 'completed' });
    await flush();
    // Writeback is fire-and-forget; give the per-file write a moment.
    await new Promise((r) => setTimeout(r, 50));

    const after = readFileSync(file, 'utf8');
    expect(after).toContain('- [x] Closeable task ✅ 2026-06-10');
    expect(after).toContain('- [ ] Other task'); // untouched
  });

  it('the live watcher ingests a newly-added task line', async () => {
    const vault = makeVault();
    dirs.push(vault);
    const projectStore = new ProjectRegistry();
    const proj: ProjectRecord = {
      id: 'proj-1',
      name: 'main',
      path: path.join(vault, '_proj'),
      createdAt: new Date(0).toISOString(),
    };
    projectStore.register(proj);
    const taskStore = new TaskRegistry({ projectStore });
    const externalLinkStore = new MemoryExternalLinkStore();
    const connector = realConnector(vault);
    let ready = false;
    const watcher = new ObsidianVaultWatcher({
      connector,
      taskStore,
      projectStore,
      externalLinkStore,
      resolveProjectPath: () => proj.path,
      vaultRoot: vault,
      exclude: [],
      debounceMs: 100,
      onReady: () => {
        ready = true;
      },
    });
    watcher.start();
    try {
      // Wait for chokidar's initial scan; `ignoreInitial` would swallow a file
      // written before `ready`.
      const readyDeadline = Date.now() + 10000;
      while (!ready && Date.now() < readyDeadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(ready).toBe(true);

      // Write a new note with an open task AFTER ready.
      writeFileSync(
        path.join(vault, 'inbox.md'),
        ['---', 'project: main', '---', '- [ ] Watcher-caught task'].join('\n'),
        'utf8',
      );
      // Poll for the ingest (real chokidar + debounce + fs timing).
      const deadline = Date.now() + 10000;
      while (taskStore.size() === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(taskStore.size()).toBe(1);
      const [task] = taskStore.list();
      expect(task?.description).toBe('Watcher-caught task');
    } finally {
      await watcher.stop();
    }
  }, 25000);
});
