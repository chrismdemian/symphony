import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SymphonyDatabase } from '../../src/state/db.js';
import { SqliteProjectStore } from '../../src/state/sqlite-project-store.js';
import { SqliteAutomationStore } from '../../src/state/sqlite-automation-store.js';
import {
  InMemoryAutomationStore,
  MAX_RUNS_PER_AUTOMATION,
  type AutomationStore,
} from '../../src/state/automation-store.js';
import type { AutomationSchedule } from '../../src/orchestrator/automation-schedule.js';

/**
 * Phase 8D.1 — `AutomationStore` contract, run against BOTH impls so they
 * stay behavior-identical (the 8A external-link-store parity discipline).
 */

const DAILY: AutomationSchedule = { type: 'daily', hour: 9, minute: 0 };

interface Harness {
  store: AutomationStore;
  projectId: string | null;
  close: () => void;
}

let clock = 1_000;

function sqliteHarness(): Harness {
  const svc = SymphonyDatabase.open({ filePath: ':memory:' });
  const projects = new SqliteProjectStore(svc.db);
  projects.register({ id: 'p1', name: 'proj', path: process.cwd(), createdAt: '' });
  return {
    store: new SqliteAutomationStore(svc.db, { now: () => clock }),
    projectId: 'p1',
    close: () => svc.close(),
  };
}

function memoryHarness(): Harness {
  return {
    store: new InMemoryAutomationStore({ now: () => clock }),
    projectId: null,
    close: () => undefined,
  };
}

describe.each([
  ['SqliteAutomationStore', sqliteHarness],
  ['InMemoryAutomationStore', memoryHarness],
])('%s', (_name, makeHarness) => {
  let h: Harness;
  beforeEach(() => {
    clock = Date.parse('2026-06-08T06:00:00.000Z');
    h = makeHarness();
  });
  afterEach(() => h.close());

  it('create computes nextRunAt from the schedule + lists in creation order', () => {
    const a = h.store.create({ name: 'first', prompt: 'p1', schedule: DAILY });
    const b = h.store.create({ name: 'second', prompt: 'p2', schedule: DAILY });
    expect(a.nextRunAt).not.toBeNull();
    expect(a.enabled).toBe(true);
    expect(a.inFlight).toBe(false);
    expect(a.runCount).toBe(0);
    const ids = h.store.list().map((r) => r.id);
    expect(ids).toEqual([a.id, b.id]);
  });

  it('listDue returns enabled, not-in-flight, past-due rows only', () => {
    const due = h.store.create({ name: 'due', prompt: 'x', schedule: DAILY });
    h.store.create({ name: 'disabled', prompt: 'x', schedule: DAILY, enabled: false });
    // Force one due now, leave the other in the future.
    h.store.forceDue(due.id, '2026-06-08T06:00:00.000Z');
    const dueList = h.store.listDue('2026-06-08T06:00:01.000Z');
    expect(dueList.map((r) => r.id)).toEqual([due.id]);
  });

  it('claim is atomic: sets in_flight, advances next_run_at, inserts a running log', () => {
    const a = h.store.create({ name: 'a', prompt: 'x', schedule: DAILY });
    h.store.forceDue(a.id, '2026-06-08T06:00:00.000Z');
    const result = h.store.claim(a.id, '2026-06-09T09:00:00.000Z', '2026-06-08T06:00:01.000Z');
    expect(result).toBeDefined();
    const after = h.store.get(a.id)!;
    expect(after.inFlight).toBe(true);
    expect(after.runCount).toBe(1);
    expect(after.nextRunAt).toBe('2026-06-09T09:00:00.000Z');
    // A second claim while in-flight is refused.
    expect(h.store.claim(a.id, '2026-06-10T09:00:00.000Z', '2026-06-08T06:00:02.000Z')).toBeUndefined();
    const pending = h.store.listPending();
    expect(pending.map((p) => p.runLogId)).toEqual([result!.runLogId]);
    expect(pending[0]!.automationName).toBe('a');
    expect(pending[0]!.prompt).toBe('x');
  });

  it('completeRun clears in_flight, stamps last_run_result, and removes from pending', () => {
    const a = h.store.create({ name: 'a', prompt: 'x', schedule: DAILY });
    const claim = h.store.claim(a.id, '2026-06-09T09:00:00.000Z', '2026-06-08T06:00:01.000Z')!;
    const ok = h.store.completeRun(claim.runLogId, 'success', '2026-06-08T06:05:00.000Z');
    expect(ok).toBe(true);
    const after = h.store.get(a.id)!;
    expect(after.inFlight).toBe(false);
    expect(after.lastRunResult).toBe('success');
    expect(after.lastRunAt).toBe('2026-06-08T06:05:00.000Z');
    expect(h.store.listPending()).toHaveLength(0);
    // Idempotent — completing a non-running log returns false.
    expect(h.store.completeRun(claim.runLogId, 'success', '2026-06-08T06:06:00.000Z')).toBe(false);
  });

  it('markOrphansFailed fails every running log + clears in_flight (cold-start reconcile)', () => {
    const a = h.store.create({ name: 'a', prompt: 'x', schedule: DAILY });
    const b = h.store.create({ name: 'b', prompt: 'y', schedule: DAILY });
    h.store.claim(a.id, '2026-06-09T09:00:00.000Z', '2026-06-08T06:00:01.000Z');
    h.store.claim(b.id, '2026-06-09T09:00:00.000Z', '2026-06-08T06:00:02.000Z');
    expect(h.store.listPending()).toHaveLength(2);
    const cleaned = h.store.markOrphansFailed('2026-06-08T07:00:00.000Z');
    expect(cleaned).toBe(2);
    expect(h.store.listPending()).toHaveLength(0);
    expect(h.store.get(a.id)!.inFlight).toBe(false);
    expect(h.store.get(a.id)!.lastRunResult).toBe('failure');
    const logs = h.store.listRunLogs(a.id);
    expect(logs[0]!.status).toBe('failure');
    expect(logs[0]!.finishedAt).toBe('2026-06-08T07:00:00.000Z');
  });

  it('forceDue rejects a disabled automation', () => {
    const a = h.store.create({ name: 'a', prompt: 'x', schedule: DAILY, enabled: false });
    expect(h.store.forceDue(a.id, '2026-06-08T06:00:00.000Z')).toBe(false);
    expect(h.store.forceDue('nope', '2026-06-08T06:00:00.000Z')).toBe(false);
  });

  it('setEnabled + delete behave', () => {
    const a = h.store.create({ name: 'a', prompt: 'x', schedule: DAILY });
    expect(h.store.setEnabled(a.id, false)).toBe(true);
    expect(h.store.get(a.id)!.enabled).toBe(false);
    expect(h.store.setEnabled('nope', true)).toBe(false);
    expect(h.store.delete(a.id)).toBe(true);
    expect(h.store.get(a.id)).toBeUndefined();
    expect(h.store.delete(a.id)).toBe(false);
  });

  it('run-log retention trims to MAX_RUNS_PER_AUTOMATION per automation', () => {
    const a = h.store.create({ name: 'a', prompt: 'x', schedule: DAILY });
    // Claim + complete more than the cap; each claim inserts one run log.
    for (let i = 0; i < MAX_RUNS_PER_AUTOMATION + 5; i += 1) {
      const ts = new Date(Date.parse('2026-06-08T06:00:00.000Z') + i * 1000).toISOString();
      const claim = h.store.claim(a.id, '2026-06-09T09:00:00.000Z', ts)!;
      h.store.completeRun(claim.runLogId, 'success', ts);
    }
    expect(h.store.listRunLogs(a.id).length).toBeLessThanOrEqual(MAX_RUNS_PER_AUTOMATION);
  });
});
