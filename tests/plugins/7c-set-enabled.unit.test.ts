/**
 * Phase 7C — `setPluginEnabled` shared enable/disable core (used by both
 * the CLI runners and the RPC `plugins.setEnabled` procedure).
 *
 * Enable validates the on-disk manifest (missing / invalid / api-
 * incompatible all refuse); disable never validates. Not-found is its own
 * refusal reason. Temp-FILE-free: a `:memory:` DB + a temp home for the
 * `~/.symphony/plugins/<id>/` tree.
 */
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SymphonyDatabase } from '../../src/state/db.js';
import { SqlitePluginStore } from '../../src/plugins/store.js';
import { installPlugin, setPluginEnabled } from '../../src/plugins/install.js';
import { pluginManifestPath } from '../../src/plugins/paths.js';

let tmpRoot: string;
let home: string;
let svc: ReturnType<typeof SymphonyDatabase.open>;
let store: SqlitePluginStore;

const NOW = '2026-06-03T00:00:00.000Z';

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: 'echo',
    name: 'Echo',
    version: '1.0.0',
    author: 'me',
    description: 'echoes',
    entrypoint: { command: 'node', args: ['server.js'] },
    ...overrides,
  };
}

function writeSource(dir: string, m: Record<string, unknown>): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(m), 'utf8');
  return dir;
}

async function install(m: Record<string, unknown> = manifest()): Promise<void> {
  const src = writeSource(path.join(tmpRoot, `src-${String(m['id'])}`), m);
  const r = await installPlugin({ source: src, store, now: NOW, home });
  if (!r.ok) throw new Error(`install fixture failed: ${r.reason} ${r.message ?? ''}`);
}

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'sym-7c-enable-'));
  home = path.join(tmpRoot, 'home');
  mkdirSync(home, { recursive: true });
  svc = SymphonyDatabase.open({ filePath: ':memory:' });
  store = new SqlitePluginStore(svc.db);
});

afterEach(() => {
  svc.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('setPluginEnabled (7C shared core)', () => {
  it('enables an installed plugin with a valid manifest', async () => {
    await install();
    const r = await setPluginEnabled({ id: 'echo', enabled: true, store, now: NOW, home });
    expect(r.ok).toBe(true);
    expect(r.enabled).toBe(true);
    expect(store.get('echo')?.enabled).toBe(true);
  });

  it('disables a plugin without validating its manifest', async () => {
    await install();
    await setPluginEnabled({ id: 'echo', enabled: true, store, now: NOW, home });
    // Corrupt the on-disk manifest — disable must STILL succeed.
    writeFileSync(pluginManifestPath('echo', home), 'not json at all', 'utf8');
    const r = await setPluginEnabled({ id: 'echo', enabled: false, store, now: NOW, home });
    expect(r.ok).toBe(true);
    expect(r.enabled).toBe(false);
    expect(store.get('echo')?.enabled).toBe(false);
  });

  it('refuses an unknown plugin with reason not-found', async () => {
    const r = await setPluginEnabled({ id: 'ghost', enabled: true, store, now: NOW, home });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('not-found');
  });

  it('refuses to enable when the on-disk manifest is missing/invalid', async () => {
    await install();
    writeFileSync(pluginManifestPath('echo', home), '{ broken', 'utf8');
    const r = await setPluginEnabled({ id: 'echo', enabled: true, store, now: NOW, home });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('manifest-invalid');
    // The DB flag must NOT have flipped.
    expect(store.get('echo')?.enabled).toBe(false);
  });

  it('refuses to enable an api-incompatible manifest', async () => {
    await install();
    // Rewrite the on-disk manifest to require a future plugin-api major.
    writeFileSync(
      pluginManifestPath('echo', home),
      JSON.stringify(manifest({ requiresPluginApi: '^2.0.0' })),
      'utf8',
    );
    const r = await setPluginEnabled({ id: 'echo', enabled: true, store, now: NOW, home });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('api-incompatible');
    expect(store.get('echo')?.enabled).toBe(false);
  });
});
