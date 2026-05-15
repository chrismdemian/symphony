import { describe, expect, it } from 'vitest';
import { createSymphonyRouter } from '../../src/rpc/router-impl.js';
import { ProjectRegistry } from '../../src/projects/registry.js';
import { TaskRegistry } from '../../src/state/task-registry.js';
import { QuestionRegistry } from '../../src/state/question-registry.js';
import { WaveRegistry } from '../../src/orchestrator/research-wave-registry.js';
import { WorkerRegistry } from '../../src/orchestrator/worker-registry.js';
import { ModeController } from '../../src/orchestrator/mode.js';
import { SymphonyDatabase } from '../../src/state/db.js';
import { SqliteAuditStore } from '../../src/state/sqlite-audit-store.js';

/**
 * Phase 3R — `audit.list` / `audit.count` thin RPC pass-through. The
 * filter coercion drops unknown kinds / severities (a stale TUI must
 * not hard-fail), validates types, and forwards to the store.
 */

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

describe('audit.list / audit.count (3R)', () => {
  it('returns [] / 0 when no auditStore is wired (legacy rigs)', () => {
    const router = createSymphonyRouter(makeBaseDeps());
    expect(router.audit.list()).toEqual([]);
    expect(router.audit.count()).toBe(0);
  });

  it('passes through to the store unfiltered', () => {
    const svc = SymphonyDatabase.open({ filePath: ':memory:' });
    try {
      const auditStore = new SqliteAuditStore(svc.db);
      auditStore.append({ ts: 't1', kind: 'worker_spawned', headline: 'a' });
      auditStore.append({ ts: 't2', kind: 'merge_performed', headline: 'b' });
      const router = createSymphonyRouter({ ...makeBaseDeps(), auditStore });
      expect(router.audit.list().length).toBe(2);
      expect(router.audit.count()).toBe(2);
    } finally {
      svc.close();
    }
  });

  it('filters by kinds, dropping unknown kind strings', () => {
    const svc = SymphonyDatabase.open({ filePath: ':memory:' });
    try {
      const auditStore = new SqliteAuditStore(svc.db);
      auditStore.append({ ts: 't1', kind: 'worker_spawned', headline: 'a' });
      auditStore.append({ ts: 't2', kind: 'merge_performed', headline: 'b' });
      const router = createSymphonyRouter({ ...makeBaseDeps(), auditStore });
      const out = router.audit.list({
        kinds: ['merge_performed', 'totally_made_up_kind'],
      });
      expect(out.map((r) => r.kind)).toEqual(['merge_performed']);
    } finally {
      svc.close();
    }
  });

  it('drops an unknown severity rather than erroring', () => {
    const svc = SymphonyDatabase.open({ filePath: ':memory:' });
    try {
      const auditStore = new SqliteAuditStore(svc.db);
      auditStore.append({ ts: 't1', kind: 'tool_called', severity: 'info', headline: 'a' });
      auditStore.append({ ts: 't2', kind: 'tool_error', severity: 'error', headline: 'b' });
      const router = createSymphonyRouter({ ...makeBaseDeps(), auditStore });
      // 'bogus' is dropped → no severity filter → all rows returned.
      expect(router.audit.list({ severity: 'bogus' }).length).toBe(2);
      expect(router.audit.list({ severity: 'error' }).length).toBe(1);
    } finally {
      svc.close();
    }
  });

  it('forwards projectId / workerId / time-window / pagination', () => {
    const svc = SymphonyDatabase.open({ filePath: ':memory:' });
    try {
      const auditStore = new SqliteAuditStore(svc.db);
      for (let i = 0; i < 6; i += 1) {
        auditStore.append({
          ts: new Date(1_700_000_000_000 + i * 1000).toISOString(),
          kind: 'worker_completed',
          headline: `e${i}`,
          projectId: i < 3 ? 'p1' : 'p2',
          workerId: `w${i}`,
        });
      }
      const router = createSymphonyRouter({ ...makeBaseDeps(), auditStore });
      expect(router.audit.list({ projectId: 'p1' }).length).toBe(3);
      expect(router.audit.list({ workerId: 'w4' }).length).toBe(1);
      expect(router.audit.count({ projectId: 'p2' })).toBe(3);
      const limited = router.audit.list({ limit: 2 });
      expect(limited.length).toBe(2);
      const page2 = router.audit.list({ limit: 2, offset: 2 });
      expect(page2.length).toBe(2);
      expect(page2[0]?.headline).not.toBe(limited[0]?.headline);
    } finally {
      svc.close();
    }
  });

  it('ignores non-finite limit / offset junk', () => {
    const svc = SymphonyDatabase.open({ filePath: ':memory:' });
    try {
      const auditStore = new SqliteAuditStore(svc.db);
      auditStore.append({ ts: 't1', kind: 'worker_spawned', headline: 'a' });
      const router = createSymphonyRouter({ ...makeBaseDeps(), auditStore });
      // NaN limit/offset must not throw — store applies its own defaults.
      expect(
        router.audit.list({ limit: Number.NaN, offset: Number.POSITIVE_INFINITY }).length,
      ).toBe(1);
    } finally {
      svc.close();
    }
  });

  it('m3: garbage sinceTs / untilTs is dropped (not forwarded to SQL)', () => {
    const svc = SymphonyDatabase.open({ filePath: ':memory:' });
    try {
      const auditStore = new SqliteAuditStore(svc.db);
      auditStore.append({
        ts: '2026-05-14T12:00:00.000Z',
        kind: 'worker_spawned',
        headline: 'a',
      });
      const router = createSymphonyRouter({ ...makeBaseDeps(), auditStore });
      // "banana" >= lexicographic would wrongly filter; m3 drops it →
      // the row still returns.
      expect(router.audit.list({ sinceTs: 'banana' }).length).toBe(1);
      expect(router.audit.list({ untilTs: 'not-a-date' }).length).toBe(1);
      // A real ISO bound still filters correctly.
      expect(
        router.audit.list({ sinceTs: '2027-01-01T00:00:00.000Z' }).length,
      ).toBe(0);
    } finally {
      svc.close();
    }
  });

  it('empty kinds array is treated as no kind filter', () => {
    const svc = SymphonyDatabase.open({ filePath: ':memory:' });
    try {
      const auditStore = new SqliteAuditStore(svc.db);
      auditStore.append({ ts: 't1', kind: 'worker_spawned', headline: 'a' });
      auditStore.append({ ts: 't2', kind: 'tool_called', headline: 'b' });
      const router = createSymphonyRouter({ ...makeBaseDeps(), auditStore });
      expect(router.audit.list({ kinds: [] }).length).toBe(2);
    } finally {
      svc.close();
    }
  });
});
