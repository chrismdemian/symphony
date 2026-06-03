/**
 * Phase 7A — SqlitePluginStore unit tests. Opens an in-memory SymphonyDatabase
 * (which runs migration 0012) so the migration + schema-contract entry are
 * exercised end-to-end alongside the store.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SymphonyDatabase } from '../../src/state/db.js';
import { SqlitePluginStore } from '../../src/plugins/store.js';

let db: SymphonyDatabase;
let store: SqlitePluginStore;

beforeEach(() => {
  db = SymphonyDatabase.open({ filePath: ':memory:' });
  store = new SqlitePluginStore(db.db);
});

afterEach(() => {
  db.close();
});

const T0 = '2026-06-02T00:00:00.000Z';
const T1 = '2026-06-02T01:00:00.000Z';

describe('SqlitePluginStore', () => {
  it('inserts a disabled plugin by default and reads it back', () => {
    const rec = store.upsert({
      id: 'notion',
      name: 'Notion',
      version: '0.1.0',
      source: '/path/to/notion',
      now: T0,
    });
    expect(rec.enabled).toBe(false);
    expect(rec.installedAt).toBe(T0);
    expect(store.get('notion')?.name).toBe('Notion');
    expect(store.list()).toHaveLength(1);
    expect(store.listEnabled()).toHaveLength(0);
  });

  it('re-install preserves installedAt + enabled, refreshes version', () => {
    store.upsert({ id: 'notion', name: 'Notion', version: '0.1.0', source: 's', now: T0 });
    store.setEnabled('notion', true, T0);
    const re = store.upsert({
      id: 'notion',
      name: 'Notion v2',
      version: '0.2.0',
      source: 's2',
      now: T1,
    });
    expect(re.installedAt).toBe(T0); // preserved
    expect(re.updatedAt).toBe(T1); // refreshed
    expect(re.version).toBe('0.2.0');
    expect(re.name).toBe('Notion v2');
    expect(re.enabled).toBe(true); // preserved across reinstall
  });

  it('setEnabled flips the flag and lands in listEnabled', () => {
    store.upsert({ id: 'a', name: 'A', version: '1', source: 's', now: T0 });
    expect(store.setEnabled('a', true, T1)).toBe(true);
    expect(store.get('a')?.enabled).toBe(true);
    expect(store.listEnabled().map((p) => p.id)).toEqual(['a']);
    expect(store.setEnabled('a', false, T1)).toBe(true);
    expect(store.listEnabled()).toHaveLength(0);
  });

  it('setEnabled on a missing id returns false', () => {
    expect(store.setEnabled('ghost', true, T0)).toBe(false);
  });

  it('delete removes the row', () => {
    store.upsert({ id: 'a', name: 'A', version: '1', source: 's', now: T0 });
    expect(store.delete('a')).toBe(true);
    expect(store.get('a')).toBeUndefined();
    expect(store.delete('a')).toBe(false);
  });

  it('list is ordered by id', () => {
    store.upsert({ id: 'zeta', name: 'Z', version: '1', source: 's', now: T0 });
    store.upsert({ id: 'alpha', name: 'A', version: '1', source: 's', now: T0 });
    expect(store.list().map((p) => p.id)).toEqual(['alpha', 'zeta']);
  });

  it('upsert can explicitly enable on first install', () => {
    const rec = store.upsert({
      id: 'a',
      name: 'A',
      version: '1',
      source: 's',
      enabled: true,
      now: T0,
    });
    expect(rec.enabled).toBe(true);
  });
});
