import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SymphonyDatabase } from '../../src/state/db.js';
import { SqliteProjectStore } from '../../src/state/sqlite-project-store.js';
import { SqliteWaveStore } from '../../src/state/sqlite-wave-store.js';
import { UnknownWaveError } from '../../src/orchestrator/research-wave-registry.js';

describe('SqliteWaveStore', () => {
  let svc: SymphonyDatabase;
  let store: SqliteWaveStore;

  beforeEach(() => {
    svc = SymphonyDatabase.open({ filePath: ':memory:' });
    const projects = new SqliteProjectStore(svc.db);
    projects.register({ id: 'P1', name: 'P1', path: '/tmp/p1', createdAt: '' });
    projects.register({ id: 'P2', name: 'P2', path: '/tmp/p2', createdAt: '' });
    store = new SqliteWaveStore(svc.db);
  });

  afterEach(() => {
    svc.close();
  });

  it('enqueue persists topic + workerIds, id matches wave-prefix', () => {
    const w = store.enqueue({
      topic: 'rate limits',
      workerIds: ['w1', 'w2', 'w3'],
    });
    expect(w.id).toMatch(/^wave-[0-9a-f]{8}$/);
    expect(w.workerIds).toEqual(['w1', 'w2', 'w3']);
    expect(w.finishedAt).toBeUndefined();
  });

  it('enqueue rejects empty topic', () => {
    expect(() => store.enqueue({ topic: '   ', workerIds: ['w1'] })).toThrow();
  });

  it('enqueue rejects empty workerIds', () => {
    expect(() => store.enqueue({ topic: 't', workerIds: [] })).toThrow();
  });

  it('enqueue rejects duplicate workerIds', () => {
    expect(() => store.enqueue({ topic: 't', workerIds: ['w1', 'w1'] })).toThrow(
      /duplicates/,
    );
  });

  it('markFinished sets finishedAt once, idempotent on second call', () => {
    const w = store.enqueue({ topic: 't', workerIds: ['w1'] });
    const finished = store.markFinished(w.id);
    expect(finished.finishedAt).toBeDefined();
    const again = store.markFinished(w.id);
    expect(again.finishedAt).toBe(finished.finishedAt);
  });

  it('markFinished on unknown id throws', () => {
    expect(() => store.markFinished('nope')).toThrow(UnknownWaveError);
  });

  it('list filters by projectId and finished', () => {
    const a = store.enqueue({ topic: 'a', workerIds: ['w1'], projectId: 'P1' });
    store.enqueue({ topic: 'b', workerIds: ['w2'], projectId: 'P2' });
    const c = store.enqueue({ topic: 'c', workerIds: ['w3'], projectId: 'P1' });
    store.markFinished(a.id);

    expect(store.list({ projectId: 'P1' }).map((r) => r.id).sort()).toEqual(
      [a.id, c.id].sort(),
    );
    expect(store.list({ finished: true }).map((r) => r.id)).toEqual([a.id]);
    expect(store.list({ finished: false }).map((r) => r.id).sort()).toEqual(
      [c.id, store.list()[1]!.id].sort(),
    );
  });

  it('list preserves insertion order', () => {
    const ids = Array.from({ length: 4 }).map((_, i) =>
      store.enqueue({ topic: `t${i}`, workerIds: [`w${i}`] }).id,
    );
    expect(store.list().map((r) => r.id)).toEqual(ids);
  });

  it('snapshot includes wave size (worker count)', () => {
    const w = store.enqueue({ topic: 't', workerIds: ['w1', 'w2', 'w3'] });
    expect(store.snapshot(w.id)!.size).toBe(3);
  });

  it('persistence across reopen', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const file = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-wave-')),
      'symphony.db',
    );
    try {
      const first = SymphonyDatabase.open({ filePath: file });
      const firstStore = new SqliteWaveStore(first.db);
      const w = firstStore.enqueue({ topic: 'persist', workerIds: ['w1', 'w2'] });
      first.close();

      const second = SymphonyDatabase.open({ filePath: file });
      try {
        const secondStore = new SqliteWaveStore(second.db);
        expect(secondStore.get(w.id)!.workerIds).toEqual(['w1', 'w2']);
      } finally {
        second.close();
      }
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });
});
