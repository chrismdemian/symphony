/**
 * Phase 7C — `plugins.list` / `plugins.setEnabled` / `plugins.install` /
 * `plugins.remove` RPC procedures. Backed by a real `SqlitePluginStore` +
 * `createPluginAdmin` over a temp home (install uses a LOCAL plugin source
 * dir so the test is network-free — resolveRemoteSource passes local paths
 * straight through).
 */
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
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

let tmpRoot: string;
let home: string;
let svc: ReturnType<typeof SymphonyDatabase.open>;
let store: SqlitePluginStore;

function makeBaseDeps() {
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

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: 'echo',
    name: 'Echo',
    version: '1.2.3',
    author: 'me',
    description: 'echoes',
    entrypoint: { command: 'node', args: ['server.js'] },
    capabilityFlags: ['irreversible'],
    permissions: ['task:read'],
    ...overrides,
  };
}

function writeSource(dir: string, m: Record<string, unknown>): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(m), 'utf8');
  return dir;
}

function makeRouter() {
  const admin = createPluginAdmin({ store, home, now: () => '2026-06-03T00:00:00.000Z' });
  return createSymphonyRouter({ ...makeBaseDeps(), pluginAdmin: admin });
}

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'sym-7c-rpc-'));
  home = path.join(tmpRoot, 'home');
  mkdirSync(home, { recursive: true });
  svc = SymphonyDatabase.open({ filePath: ':memory:' });
  store = new SqlitePluginStore(svc.db);
});

afterEach(() => {
  svc.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('plugins RPC namespace (7C)', () => {
  it('list returns [] when no pluginAdmin is wired', async () => {
    const router = createSymphonyRouter(makeBaseDeps());
    await expect(router.plugins.list()).resolves.toEqual([]);
  });

  it('mutators throw bad_args when no pluginAdmin is wired', async () => {
    const router = createSymphonyRouter(makeBaseDeps());
    await expect(router.plugins.setEnabled({ id: 'echo', enabled: true })).rejects.toThrow(
      /not available/,
    );
    await expect(router.plugins.install({ source: '/x' })).rejects.toThrow(/not available/);
    await expect(router.plugins.remove({ id: 'echo' })).rejects.toThrow(/not available/);
  });

  it('install (local source) → list → setEnabled → remove round-trip', async () => {
    const router = makeRouter();
    const src = writeSource(path.join(tmpRoot, 'src'), manifest());

    const installed = await router.plugins.install({ source: src });
    expect(installed).toEqual({ id: 'echo', name: 'Echo', version: '1.2.3', reinstall: false });

    const listed = await router.plugins.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe('echo');
    expect(listed[0]?.enabled).toBe(false); // default-deny
    expect(listed[0]?.capabilityFlags).toContain('irreversible');
    expect(listed[0]?.permissions).toContain('task:read');

    const en = await router.plugins.setEnabled({ id: 'echo', enabled: true });
    expect(en).toEqual({ id: 'echo', enabled: true });
    expect((await router.plugins.list())[0]?.enabled).toBe(true);

    const removed = await router.plugins.remove({ id: 'echo' });
    expect(removed.id).toBe('echo');
    expect(removed.removedRow).toBe(true);
    await expect(router.plugins.list()).resolves.toEqual([]);
  });

  it('setEnabled on an unknown plugin rejects (not_found)', async () => {
    const router = makeRouter();
    await expect(router.plugins.setEnabled({ id: 'ghost', enabled: true })).rejects.toThrow(
      /not installed/,
    );
  });

  it('remove on an unknown plugin rejects (not_found)', async () => {
    const router = makeRouter();
    await expect(router.plugins.remove({ id: 'ghost' })).rejects.toThrow(/not installed/);
  });

  it('rejects an unsafe plugin id at the boundary', async () => {
    const router = makeRouter();
    await expect(router.plugins.setEnabled({ id: '../evil', enabled: true })).rejects.toThrow(
      /unsafe plugin id/,
    );
    await expect(router.plugins.remove({ id: 'A B C' })).rejects.toThrow(/unsafe plugin id/);
  });

  it('rejects a non-boolean enabled flag', async () => {
    const router = makeRouter();
    await expect(
      router.plugins.setEnabled({ id: 'echo', enabled: 'yes' as unknown as boolean }),
    ).rejects.toThrow(/must be a boolean/);
  });

  it('install rejects an empty / oversized source', async () => {
    const router = makeRouter();
    await expect(router.plugins.install({ source: '' })).rejects.toThrow(/non-empty string/);
    await expect(router.plugins.install({ source: 'x'.repeat(3000) })).rejects.toThrow(/cap/);
  });

  it('install surfaces an invalid-manifest refusal as bad_args', async () => {
    const router = makeRouter();
    const src = writeSource(path.join(tmpRoot, 'bad'), manifest({ id: 'BAD-UPPER' }));
    await expect(router.plugins.install({ source: src })).rejects.toThrow();
  });

  it('list surfaces a manifestError for an orphaned install', async () => {
    const router = makeRouter();
    const src = writeSource(path.join(tmpRoot, 'src2'), manifest());
    await router.plugins.install({ source: src });
    // Nuke the installed manifest on disk (leave the DB row) → orphaned.
    rmSync(path.join(home, '.symphony', 'plugins', 'echo', 'plugin.json'), { force: true });
    const listed = await router.plugins.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.manifestError).toBeDefined();
  });
});
