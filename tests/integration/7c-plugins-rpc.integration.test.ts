/**
 * Phase 7C — integration: the Plugins RPC surface against a REAL temp-FILE
 * SQLite DB + the REAL bundled `notifier` manifest + real filesystem
 * install, including a fresh-store reload (simulating the cross-process
 * boundary: the bootstrap RPC server and Maestro's plugin host open the
 * same DB file independently). No mocks for the store / install / fs.
 */
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSymphonyRouter } from '../../src/rpc/router-impl.js';
import { ProjectRegistry } from '../../src/projects/registry.js';
import { TaskRegistry } from '../../src/state/task-registry.js';
import { QuestionRegistry } from '../../src/state/question-registry.js';
import { WaveRegistry } from '../../src/orchestrator/research-wave-registry.js';
import { WorkerRegistry } from '../../src/orchestrator/worker-registry.js';
import { ModeController } from '../../src/orchestrator/mode.js';
import { SymphonyDatabase } from '../../src/state/db.js';
import { SqlitePluginStore } from '../../src/plugins/store.js';
import { createPluginAdmin } from '../../src/plugins/admin.js';

const NOTIFIER_MANIFEST = fileURLToPath(
  new URL('../../packages/examples/notifier/plugin.json', import.meta.url),
);

let tmpRoot: string;
let home: string;
let dbFilePath: string;
let srcDir: string;

function baseDeps() {
  const projectStore = new ProjectRegistry();
  const taskStore = new TaskRegistry({ projectStore });
  return {
    projectStore,
    taskStore,
    questionStore: new QuestionRegistry(),
    waveStore: new WaveRegistry(),
    workerRegistry: new WorkerRegistry(),
    modeController: new ModeController({ initial: 'plan' }),
  };
}

/** Open a fresh DB + store + admin + router over the SAME db file. */
function freshRouter() {
  const svc = SymphonyDatabase.open({ filePath: dbFilePath });
  const store = new SqlitePluginStore(svc.db);
  const admin = createPluginAdmin({ store, home, now: () => '2026-06-03T00:00:00.000Z' });
  const router = createSymphonyRouter({ ...baseDeps(), pluginAdmin: admin });
  return { svc, router };
}

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'sym-7c-int-'));
  home = path.join(tmpRoot, 'home');
  mkdirSync(home, { recursive: true });
  dbFilePath = path.join(tmpRoot, 'symphony.db');
  // Stage a real manifest (just the plugin.json — no need to copy the
  // example's node_modules/dist) into a temp source dir.
  srcDir = path.join(tmpRoot, 'src');
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(path.join(srcDir, 'plugin.json'), readFileSync(NOTIFIER_MANIFEST, 'utf8'), 'utf8');
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('Plugins RPC integration (7C)', () => {
  it('installs the real notifier manifest, persists across a fresh store, enables, removes', async () => {
    // --- install (process A) ---
    {
      const { svc, router } = freshRouter();
      try {
        const res = await router.plugins.install({ source: srcDir });
        expect(res.id).toBe('notifier-example');
        expect(res.version).toBe('0.1.0');
        expect(res.reinstall).toBe(false);
        // Real on-disk install landed under the temp home.
        expect(existsSync(path.join(home, '.symphony', 'plugins', 'notifier-example', 'plugin.json'))).toBe(
          true,
        );
      } finally {
        svc.close();
      }
    }

    // --- list + enable from a FRESH store/router over the same DB file ---
    {
      const { svc, router } = freshRouter();
      try {
        const listed = await router.plugins.list();
        expect(listed).toHaveLength(1);
        const row = listed[0]!;
        expect(row.id).toBe('notifier-example');
        expect(row.enabled).toBe(false); // default-deny, persisted
        // Manifest enrichment carries through the real fields.
        expect(row.events).toEqual(
          expect.arrayContaining(['onTaskCreated', 'onTaskCompleted', 'onWorkerSpawned']),
        );
        expect(row.permissions).toEqual(expect.arrayContaining(['notify:send', 'task:read']));
        expect(row.manifestError).toBeUndefined();

        const en = await router.plugins.setEnabled({ id: 'notifier-example', enabled: true });
        expect(en.enabled).toBe(true);
      } finally {
        svc.close();
      }
    }

    // --- the enable persisted; remove it from yet another fresh store ---
    {
      const { svc, router } = freshRouter();
      try {
        expect((await router.plugins.list())[0]?.enabled).toBe(true);
        const removed = await router.plugins.remove({ id: 'notifier-example' });
        expect(removed.removedRow).toBe(true);
        expect(removed.removedDir).toBe(true);
        await expect(router.plugins.list()).resolves.toEqual([]);
        expect(existsSync(path.join(home, '.symphony', 'plugins', 'notifier-example'))).toBe(false);
      } finally {
        svc.close();
      }
    }
  });

  it('refuses to enable a plugin whose on-disk manifest went missing (orphaned)', async () => {
    {
      const { svc, router } = freshRouter();
      try {
        await router.plugins.install({ source: srcDir });
        // Delete the installed manifest → orphaned row.
        rmSync(path.join(home, '.symphony', 'plugins', 'notifier-example', 'plugin.json'), {
          force: true,
        });
      } finally {
        svc.close();
      }
    }
    {
      const { svc, router } = freshRouter();
      try {
        // list still shows the row, flagged with a manifestError.
        const listed = await router.plugins.list();
        expect(listed[0]?.manifestError).toBeDefined();
        // enable refuses (manifest unreadable).
        await expect(
          router.plugins.setEnabled({ id: 'notifier-example', enabled: true }),
        ).rejects.toThrow();
      } finally {
        svc.close();
      }
    }
  });
});
