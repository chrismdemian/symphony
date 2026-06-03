/**
 * Phase 7A — installPlugin / removePlugin / listPlugins against a real
 * temp filesystem + in-memory SQLite store.
 */
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SymphonyDatabase } from '../../src/state/db.js';
import { SqlitePluginStore } from '../../src/plugins/store.js';
import { installPlugin, listPlugins, removePlugin } from '../../src/plugins/install.js';
import { pluginDir } from '../../src/plugins/paths.js';

let tmpRoot: string;
let home: string;
let db: SymphonyDatabase;
let store: SqlitePluginStore;

const NOW = '2026-06-02T00:00:00.000Z';

function writePluginSource(dir: string, manifest: Record<string, unknown>): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(manifest, null, 2), 'utf8');
  writeFileSync(path.join(dir, 'server.js'), 'process.stdin.resume();', 'utf8');
  return dir;
}

function baseManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'sym-plugin-test-'));
  home = path.join(tmpRoot, 'home');
  mkdirSync(home, { recursive: true });
  db = SymphonyDatabase.open({ filePath: ':memory:' });
  store = new SqlitePluginStore(db.db);
});

afterEach(() => {
  db.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('installPlugin', () => {
  it('installs from a directory, copies files, registers disabled', async () => {
    const src = writePluginSource(path.join(tmpRoot, 'src-echo'), baseManifest());
    const result = await installPlugin({ source: src, store, now: NOW, home });
    expect(result.ok).toBe(true);
    expect(result.manifest?.id).toBe('echo');
    const installed = pluginDir('echo', home);
    expect(existsSync(path.join(installed, 'plugin.json'))).toBe(true);
    expect(existsSync(path.join(installed, 'server.js'))).toBe(true);
    const rec = store.get('echo');
    expect(rec?.enabled).toBe(false);
    expect(rec?.version).toBe('1.0.0');
  });

  it('installs from a direct plugin.json path', async () => {
    const src = writePluginSource(path.join(tmpRoot, 'src2'), baseManifest({ id: 'p2' }));
    const result = await installPlugin({
      source: path.join(src, 'plugin.json'),
      store,
      now: NOW,
      home,
    });
    expect(result.ok).toBe(true);
    expect(store.get('p2')).toBeDefined();
  });

  it('reinstall preserves the enabled flag', async () => {
    const src = writePluginSource(path.join(tmpRoot, 'src-echo'), baseManifest());
    await installPlugin({ source: src, store, now: NOW, home });
    store.setEnabled('echo', true, NOW);
    const src2 = writePluginSource(
      path.join(tmpRoot, 'src-echo-2'),
      baseManifest({ version: '2.0.0' }),
    );
    const result = await installPlugin({ source: src2, store, now: NOW, home });
    expect(result.ok).toBe(true);
    expect(result.reinstall).toBe(true);
    expect(store.get('echo')?.enabled).toBe(true);
    expect(store.get('echo')?.version).toBe('2.0.0');
  });

  it('refuses a missing source', async () => {
    const result = await installPlugin({
      source: path.join(tmpRoot, 'nope'),
      store,
      now: NOW,
      home,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('source-not-found');
  });

  it('refuses a directory without plugin.json', async () => {
    const dir = path.join(tmpRoot, 'empty');
    mkdirSync(dir, { recursive: true });
    const result = await installPlugin({ source: dir, store, now: NOW, home });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('manifest-missing');
  });

  it('refuses an invalid manifest', async () => {
    const src = writePluginSource(path.join(tmpRoot, 'bad'), baseManifest({ id: 'BAD UPPER' }));
    const result = await installPlugin({ source: src, store, now: NOW, home });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('manifest-invalid');
  });

  it('refuses an api-incompatible manifest before copying', async () => {
    const src = writePluginSource(
      path.join(tmpRoot, 'fut'),
      baseManifest({ id: 'future', requiresPluginApi: '^9.0.0' }),
    );
    const result = await installPlugin({ source: src, store, now: NOW, home });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('api-incompatible');
    expect(existsSync(pluginDir('future', home))).toBe(false);
  });
});

describe('removePlugin', () => {
  it('removes the dir and the row', async () => {
    const src = writePluginSource(path.join(tmpRoot, 'src-echo'), baseManifest());
    await installPlugin({ source: src, store, now: NOW, home });
    const result = await removePlugin({ id: 'echo', store, home });
    expect(result.ok).toBe(true);
    expect(result.removedDir).toBe(true);
    expect(result.removedRow).toBe(true);
    expect(existsSync(pluginDir('echo', home))).toBe(false);
    expect(store.get('echo')).toBeUndefined();
  });

  it('returns not-found for an unknown id', async () => {
    const result = await removePlugin({ id: 'ghost', store, home });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('not-found');
  });

  it('rejects an unsafe id', async () => {
    const result = await removePlugin({ id: '../escape', store, home });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('invalid-id');
  });
});

describe('listPlugins', () => {
  it('enriches records with manifest data', async () => {
    const src = writePluginSource(
      path.join(tmpRoot, 'src-echo'),
      baseManifest({ permissions: ['task:read'], capabilityFlags: ['irreversible'] }),
    );
    await installPlugin({ source: src, store, now: NOW, home });
    const listed = await listPlugins({ store, home });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.manifest?.permissions).toEqual(['task:read']);
    expect(listed[0]?.manifest?.capabilityFlags).toEqual(['irreversible']);
    expect(listed[0]?.manifestError).toBeUndefined();
  });

  it('flags a row whose dir/manifest is gone', async () => {
    store.upsert({ id: 'orphan', name: 'O', version: '1', source: 's', now: NOW });
    const listed = await listPlugins({ store, home });
    expect(listed[0]?.manifestError).toBeDefined();
  });
});
