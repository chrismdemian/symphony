import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SymphonyDatabase } from '../../src/state/db.js';
import { SqliteAuditStore } from '../../src/state/sqlite-audit-store.js';
import type {
  AuditAppendInput,
  AuditKind,
} from '../../src/state/audit-store.js';

function appendN(
  store: SqliteAuditStore,
  n: number,
  overrides: (i: number) => Partial<AuditAppendInput> = () => ({}),
): void {
  for (let i = 0; i < n; i += 1) {
    const base: AuditAppendInput = {
      ts: new Date(1_700_000_000_000 + i * 1000).toISOString(),
      kind: 'worker_spawned',
      headline: `spawn ${i}`,
    };
    store.append({ ...base, ...overrides(i) });
  }
}

describe('SqliteAuditStore', () => {
  let svc: SymphonyDatabase;
  let store: SqliteAuditStore;

  beforeEach(() => {
    svc = SymphonyDatabase.open({ filePath: ':memory:' });
    store = new SqliteAuditStore(svc.db);
  });

  afterEach(() => {
    svc.close();
  });

  it('append → roundtrip returns assigned id + full entry', () => {
    const entry = store.append({
      ts: '2026-05-14T12:00:00.000Z',
      kind: 'worker_spawned',
      headline: 'spawn Violin in MathScrabble',
      projectId: 'p1',
      workerId: 'w-abc',
      taskId: 'tk-xyz',
      payload: { role: 'implementer' },
    });
    expect(entry.id).toBeGreaterThan(0);
    expect(entry.kind).toBe('worker_spawned');
    expect(entry.severity).toBe('info');
    expect(entry.projectId).toBe('p1');
    expect(entry.workerId).toBe('w-abc');
    expect(entry.payload).toEqual({ role: 'implementer' });
    const listed = store.list({ limit: 5 });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(entry.id);
    expect(listed[0]?.payload).toEqual({ role: 'implementer' });
  });

  it('defaults: severity=info, payload={}, all refs null when omitted', () => {
    const entry = store.append({
      ts: '2026-05-14T12:00:00.000Z',
      kind: 'error',
      headline: 'something failed',
    });
    expect(entry.severity).toBe('info');
    expect(entry.payload).toEqual({});
    expect(entry.projectId).toBeNull();
    expect(entry.workerId).toBeNull();
    expect(entry.taskId).toBeNull();
    expect(entry.toolName).toBeNull();
  });

  it('list returns rows ordered by ts DESC (newest first)', () => {
    appendN(store, 5);
    const rows = store.list({});
    expect(rows).toHaveLength(5);
    expect(rows[0]?.headline).toBe('spawn 4');
    expect(rows[4]?.headline).toBe('spawn 0');
  });

  it('list respects limit + offset', () => {
    appendN(store, 10);
    const page1 = store.list({ limit: 3, offset: 0 });
    const page2 = store.list({ limit: 3, offset: 3 });
    expect(page1.map((r) => r.headline)).toEqual(['spawn 9', 'spawn 8', 'spawn 7']);
    expect(page2.map((r) => r.headline)).toEqual(['spawn 6', 'spawn 5', 'spawn 4']);
  });

  it('list default limit is 200 (capped at 1000)', () => {
    appendN(store, 250);
    expect(store.list({}).length).toBe(200);
    expect(store.list({ limit: 5000 }).length).toBe(250); // capped to 1000, only 250 rows exist
    expect(store.list({ limit: 1001 }).length).toBe(250);
  });

  it('filter by projectId', () => {
    store.append({ ts: 't1', kind: 'worker_spawned', headline: 'a', projectId: 'p1' });
    store.append({ ts: 't2', kind: 'worker_spawned', headline: 'b', projectId: 'p2' });
    store.append({ ts: 't3', kind: 'worker_spawned', headline: 'c', projectId: 'p1' });
    const p1 = store.list({ projectId: 'p1' });
    expect(p1.map((r) => r.headline).sort()).toEqual(['a', 'c']);
  });

  it('filter by single kind', () => {
    store.append({ ts: 't1', kind: 'worker_spawned', headline: 'spawn' });
    store.append({ ts: 't2', kind: 'merge_performed', headline: 'merged' });
    store.append({ ts: 't3', kind: 'worker_spawned', headline: 'spawn2' });
    const merges = store.list({ kinds: ['merge_performed'] });
    expect(merges).toHaveLength(1);
    expect(merges[0]?.headline).toBe('merged');
  });

  it('filter by multiple kinds (IN clause)', () => {
    const kinds: AuditKind[] = ['worker_spawned', 'merge_performed', 'tool_called'];
    kinds.forEach((k, i) =>
      store.append({ ts: `t${i}`, kind: k, headline: k }),
    );
    store.append({ ts: 't9', kind: 'error', headline: 'noise' });
    const filtered = store.list({ kinds: ['worker_spawned', 'merge_performed'] });
    expect(filtered.map((r) => r.kind).sort()).toEqual([
      'merge_performed',
      'worker_spawned',
    ]);
  });

  it('filter by severity', () => {
    store.append({ ts: 't1', kind: 'tool_called', severity: 'info', headline: 'a' });
    store.append({ ts: 't2', kind: 'tool_denied', severity: 'warn', headline: 'b' });
    store.append({ ts: 't3', kind: 'tool_error', severity: 'error', headline: 'c' });
    expect(store.list({ severity: 'error' }).map((r) => r.headline)).toEqual(['c']);
    expect(store.list({ severity: 'warn' }).map((r) => r.headline)).toEqual(['b']);
  });

  it('filter by workerId', () => {
    store.append({ ts: 't1', kind: 'worker_spawned', headline: 'a', workerId: 'w1' });
    store.append({ ts: 't2', kind: 'worker_completed', headline: 'b', workerId: 'w2' });
    store.append({ ts: 't3', kind: 'worker_failed', headline: 'c', workerId: 'w1' });
    const w1 = store.list({ workerId: 'w1' });
    expect(w1.map((r) => r.headline).sort()).toEqual(['a', 'c']);
  });

  it('filter by time window (sinceTs + untilTs inclusive)', () => {
    const ts = (i: number): string =>
      new Date(1_700_000_000_000 + i * 1000).toISOString();
    for (let i = 0; i < 10; i += 1) {
      store.append({ ts: ts(i), kind: 'worker_spawned', headline: `e${i}` });
    }
    const win = store.list({ sinceTs: ts(3), untilTs: ts(7) });
    expect(win.map((r) => r.headline)).toEqual(['e7', 'e6', 'e5', 'e4', 'e3']);
  });

  it('filter combinations stack with AND', () => {
    store.append({ ts: 't1', kind: 'tool_called', severity: 'info', projectId: 'p1', headline: 'a' });
    store.append({ ts: 't2', kind: 'tool_denied', severity: 'warn', projectId: 'p1', headline: 'b' });
    store.append({ ts: 't3', kind: 'tool_called', severity: 'info', projectId: 'p2', headline: 'c' });
    const filtered = store.list({
      projectId: 'p1',
      kinds: ['tool_called', 'tool_denied'],
      severity: 'info',
    });
    expect(filtered.map((r) => r.headline)).toEqual(['a']);
  });

  it('count respects filter', () => {
    appendN(store, 5, (i) => ({ projectId: i < 3 ? 'p1' : 'p2' }));
    expect(store.count({})).toBe(5);
    expect(store.count({ projectId: 'p1' })).toBe(3);
    expect(store.count({ projectId: 'p2' })).toBe(2);
  });

  it('bounded retention trigger evicts oldest row at 10k+1', () => {
    // Use raw INSERT for speed (10k rows). We bypass the public API to keep
    // the test fast; the trigger fires on every INSERT regardless of source.
    const insert = svc.db.prepare(
      `INSERT INTO audit_log (ts, kind, severity, headline, payload)
       VALUES (?, 'worker_spawned', 'info', ?, '{}')`,
    );
    const txn = svc.db.transaction(() => {
      for (let i = 0; i < 10_000; i += 1) {
        insert.run(new Date(1_700_000_000_000 + i).toISOString(), `r${i}`);
      }
    });
    txn();
    expect(store.count({})).toBe(10_000);
    // First row exists.
    const first = svc.db
      .prepare('SELECT id FROM audit_log ORDER BY id ASC LIMIT 1')
      .get() as { id: number };
    expect(first.id).toBe(1);
    // 10,001st insert triggers the cap delete.
    store.append({ ts: 't10001', kind: 'error', headline: 'overflow' });
    expect(store.count({})).toBe(10_000);
    // Row id=1 should be gone now.
    const stillFirst = svc.db
      .prepare('SELECT id FROM audit_log ORDER BY id ASC LIMIT 1')
      .get() as { id: number };
    expect(stillFirst.id).toBeGreaterThan(1);
  });

  it('decodePayload handles corrupt JSON gracefully', () => {
    // Direct INSERT with bad JSON in payload column.
    svc.db
      .prepare(
        `INSERT INTO audit_log (ts, kind, severity, headline, payload)
         VALUES ('t1', 'worker_spawned', 'info', 'broken', 'not-valid-json')`,
      )
      .run();
    const rows = store.list({});
    expect(rows).toHaveLength(1);
    expect(rows[0]?.headline).toBe('broken');
    expect(rows[0]?.payload).toEqual({});
  });

  it('unknown kind in DB falls back to "error" on read', () => {
    svc.db
      .prepare(
        `INSERT INTO audit_log (ts, kind, severity, headline, payload)
         VALUES ('t1', 'never_heard_of_it', 'info', 'h', '{}')`,
      )
      .run();
    const rows = store.list({});
    expect(rows[0]?.kind).toBe('error');
  });

  it('severity CHECK constraint rejects invalid values at INSERT', () => {
    expect(() =>
      svc.db
        .prepare(
          `INSERT INTO audit_log (ts, kind, severity, headline, payload)
           VALUES ('t1', 'worker_spawned', 'bogus', 'h', '{}')`,
        )
        .run(),
    ).toThrow();
  });

  it('empty kinds array means no kind filter (returns all)', () => {
    appendN(store, 3);
    expect(store.list({ kinds: [] }).length).toBe(3);
  });
});
