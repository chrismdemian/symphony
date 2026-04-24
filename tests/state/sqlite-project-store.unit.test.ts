import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SymphonyDatabase } from '../../src/state/db.js';
import { SqliteProjectStore } from '../../src/state/sqlite-project-store.js';
import { DuplicateProjectError } from '../../src/projects/registry.js';

describe('SqliteProjectStore', () => {
  let svc: SymphonyDatabase;
  let store: SqliteProjectStore;

  beforeEach(() => {
    svc = SymphonyDatabase.open({ filePath: ':memory:' });
    store = new SqliteProjectStore(svc.db);
  });

  afterEach(() => {
    svc.close();
  });

  it('register → get by name or id returns the record', () => {
    const record = store.register({
      id: 'p1',
      name: 'symphony',
      path: process.cwd(),
      createdAt: '',
    });
    expect(record.name).toBe('symphony');
    expect(store.get('p1')).toBeDefined();
    expect(store.get('symphony')).toBeDefined();
  });

  it('register resolves the path to absolute form', () => {
    const record = store.register({
      id: 'p1',
      name: 'symphony',
      path: '.',
      createdAt: '',
    });
    expect(record.path).toBe(process.cwd());
  });

  it('register rejects direct duplicates (name)', () => {
    store.register({ id: 'p1', name: 'symphony', path: process.cwd(), createdAt: '' });
    expect(() =>
      store.register({ id: 'p2', name: 'symphony', path: '/tmp/sym2', createdAt: '' }),
    ).toThrow(DuplicateProjectError);
  });

  it('register rejects cross-namespace collisions — id-as-name (Phase 2A.3 audit M1)', () => {
    store.register({ id: 'alpha', name: 'Alpha Project', path: '/tmp/a', createdAt: '' });
    // New record whose id collides with existing name
    expect(() =>
      store.register({ id: 'Alpha Project', name: 'beta', path: '/tmp/b', createdAt: '' }),
    ).toThrow(DuplicateProjectError);
  });

  it('register rejects cross-namespace collisions — name-as-id (Phase 2A.3 audit M1)', () => {
    store.register({ id: 'alpha', name: 'Alpha Project', path: '/tmp/a', createdAt: '' });
    expect(() =>
      store.register({ id: 'gamma', name: 'alpha', path: '/tmp/g', createdAt: '' }),
    ).toThrow(DuplicateProjectError);
  });

  it('register rejects a duplicate path (SQL UNIQUE constraint)', () => {
    store.register({ id: 'p1', name: 'a', path: '/tmp/shared', createdAt: '' });
    expect(() =>
      store.register({ id: 'p2', name: 'b', path: '/tmp/shared', createdAt: '' }),
    ).toThrow();
  });

  it('register throws when name or path are empty', () => {
    expect(() =>
      store.register({ id: 'p1', name: '', path: '/tmp/a', createdAt: '' }),
    ).toThrow();
    expect(() =>
      store.register({ id: 'p1', name: 'a', path: '', createdAt: '' }),
    ).toThrow();
  });

  it('list({nameContains}) filters case-insensitively by substring', () => {
    store.register({ id: 'a', name: 'Alpha', path: '/tmp/a', createdAt: '' });
    store.register({ id: 'b', name: 'Beta', path: '/tmp/b', createdAt: '' });
    store.register({ id: 'g', name: 'AlphaGamma', path: '/tmp/g', createdAt: '' });
    expect(store.list({ nameContains: 'alpha' }).map((r) => r.name).sort()).toEqual([
      'Alpha',
      'AlphaGamma',
    ]);
  });

  it('persists optional fields (finalize defaults, commands, verify timeout)', () => {
    store.register({
      id: 'p1',
      name: 'symphony',
      path: process.cwd(),
      createdAt: '',
      lintCommand: 'pnpm lint',
      testCommand: 'pnpm test',
      buildCommand: 'pnpm build',
      verifyCommand: 'pnpm verify',
      verifyTimeoutMs: 123_456,
      finalizeDefault: 'push',
      defaultModel: 'opus',
      gitRemote: 'origin',
      gitBranch: 'master',
      baseRef: 'origin/master',
    });
    const snapshot = store.snapshot('symphony')!;
    expect(snapshot.lintCommand).toBe('pnpm lint');
    expect(snapshot.verifyTimeoutMs).toBe(123_456);
    expect(snapshot.finalizeDefault).toBe('push');
    expect(snapshot.baseRef).toBe('origin/master');
  });

  it('survives a close+reopen (persistence round-trip)', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const file = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-proj-')),
      'symphony.db',
    );
    try {
      const first = SymphonyDatabase.open({ filePath: file });
      const firstStore = new SqliteProjectStore(first.db);
      firstStore.register({ id: 'p1', name: 'symphony', path: process.cwd(), createdAt: '' });
      first.close();

      const second = SymphonyDatabase.open({ filePath: file });
      try {
        const secondStore = new SqliteProjectStore(second.db);
        const retrieved = secondStore.get('symphony');
        expect(retrieved).toBeDefined();
        expect(retrieved!.path).toBe(process.cwd());
      } finally {
        second.close();
      }
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });

  it('size() matches the number of registered projects', () => {
    expect(store.size()).toBe(0);
    store.register({ id: 'p1', name: 'a', path: '/tmp/a', createdAt: '' });
    store.register({ id: 'p2', name: 'b', path: '/tmp/b', createdAt: '' });
    expect(store.size()).toBe(2);
  });
});
