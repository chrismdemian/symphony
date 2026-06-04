import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SymphonyDatabase } from '../../src/state/db.js';
import { SqliteProjectStore } from '../../src/state/sqlite-project-store.js';
import { SqliteTaskStore } from '../../src/state/sqlite-task-store.js';
import { SqliteExternalLinkStore } from '../../src/state/sqlite-external-link-store.js';
import {
  MemoryExternalLinkStore,
  type ExternalLinkStore,
} from '../../src/state/external-link-store.js';

/**
 * Phase 8A — `ExternalLinkStore` contract, run against BOTH the SQLite and
 * in-memory impls so they stay behavior-identical (mirrors the task-store
 * parity discipline).
 */

interface Harness {
  store: ExternalLinkStore;
  /** Create a task so FK-bound links have a real row to point at. */
  makeTask: () => string;
  close: () => void;
}

function sqliteHarness(): Harness {
  const svc = SymphonyDatabase.open({ filePath: ':memory:' });
  const projects = new SqliteProjectStore(svc.db);
  projects.register({ id: 'p1', name: 'proj', path: process.cwd(), createdAt: '' });
  const tasks = new SqliteTaskStore(svc.db);
  const store = new SqliteExternalLinkStore(svc.db, { now: () => 1_000 });
  return {
    store,
    makeTask: () => tasks.create({ projectId: 'p1', description: 'd' }).id,
    close: () => svc.close(),
  };
}

function memoryHarness(): Harness {
  let n = 0;
  return {
    store: new MemoryExternalLinkStore({ now: () => 1_000 }),
    makeTask: () => `tk-${(n += 1)}`,
    close: () => undefined,
  };
}

describe.each([
  ['SqliteExternalLinkStore', sqliteHarness],
  ['MemoryExternalLinkStore', memoryHarness],
])('%s', (_name, makeHarness) => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => {
    h.close();
  });

  it('link → getByExternal round-trips all fields', () => {
    const taskId = h.makeTask();
    const link = h.store.link({
      taskId,
      source: 'notion',
      externalId: 'page-1',
      url: 'https://notion.so/page-1',
    });
    expect(link.taskId).toBe(taskId);
    expect(link.source).toBe('notion');
    expect(link.externalId).toBe('page-1');
    expect(link.url).toBe('https://notion.so/page-1');
    expect(link.createdAt).toBe(new Date(1_000).toISOString());

    const fetched = h.store.getByExternal('notion', 'page-1');
    expect(fetched).toEqual(link);
  });

  it('getByExternal returns undefined for an unknown pair', () => {
    expect(h.store.getByExternal('notion', 'nope')).toBeUndefined();
  });

  it('link is idempotent on (source, externalId) — no duplicate, preserves createdAt', () => {
    const taskA = h.makeTask();
    const taskB = h.makeTask();
    h.store.link({ taskId: taskA, source: 'notion', externalId: 'page-1' });
    // Re-link the same page to a different task (rare, but must not dup).
    const second = h.store.link({ taskId: taskB, source: 'notion', externalId: 'page-1' });
    expect(second.taskId).toBe(taskB);
    expect(second.createdAt).toBe(new Date(1_000).toISOString());
    // Only one row for the page.
    expect(h.store.listExternalIds('notion')).toEqual(new Set(['page-1']));
  });

  it('listByTaskId returns every link for a task', () => {
    const taskId = h.makeTask();
    h.store.link({ taskId, source: 'notion', externalId: 'page-1' });
    const links = h.store.listByTaskId(taskId);
    expect(links).toHaveLength(1);
    expect(links[0]?.externalId).toBe('page-1');
  });

  it('listByTaskId returns empty for an unlinked task', () => {
    expect(h.store.listByTaskId('tk-unlinked')).toEqual([]);
  });

  it('listExternalIds is scoped by source', () => {
    const t1 = h.makeTask();
    const t2 = h.makeTask();
    h.store.link({ taskId: t1, source: 'notion', externalId: 'page-1' });
    h.store.link({ taskId: t2, source: 'linear', externalId: 'issue-9' });
    expect(h.store.listExternalIds('notion')).toEqual(new Set(['page-1']));
    expect(h.store.listExternalIds('linear')).toEqual(new Set(['issue-9']));
    expect(h.store.listExternalIds('jira')).toEqual(new Set());
  });
});
