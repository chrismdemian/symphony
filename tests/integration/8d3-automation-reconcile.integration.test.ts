import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SymphonyDatabase } from '../../src/state/db.js';
import { SqliteAutomationStore } from '../../src/state/sqlite-automation-store.js';
import { AutomationScheduler } from '../../src/orchestrator/automation-scheduler.js';
import {
  AutomationsBrokerImpl,
  type AutomationEvent,
} from '../../src/orchestrator/automations-broker.js';
import type { AutomationSchedule } from '../../src/orchestrator/automation-schedule.js';

/**
 * Phase 8D.3 — catch-up reconciliation against REAL SQLite, across a genuine
 * session boundary (the orphan is written by a "prior session" store, the DB
 * is closed, then a "fresh session" store + scheduler reopen the same file and
 * reconcile). Exercises the actual `claim` / `markOrphansFailed` / `listDue`
 * transactions, not the in-memory oracle.
 */

const HOURLY: AutomationSchedule = { type: 'hourly', minute: 0 };

const T_PRIOR_CLAIM = Date.parse('2026-06-08T05:00:00.000Z');
const T_PRIOR_NEXT = '2026-06-08T06:00:00.000Z'; // advanced by the prior claim
const T_FRESH = Date.parse('2026-06-08T09:00:00.000Z'); // 3h later — orphan overdue

describe('Phase 8D.3 — automation reconcile (integration, real SQLite)', () => {
  let dir: string;
  let dbFile: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), '8d3-int-'));
    dbFile = path.join(dir, 'symphony.db');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reconcile("startup") fails a persisted orphan AND catches it up once', async () => {
    // ---- Prior session: create + claim an automation, then "crash" (close). --
    let automationId: string;
    {
      const svc = SymphonyDatabase.open({ filePath: dbFile });
      const store = new SqliteAutomationStore(svc.db, { now: () => T_PRIOR_CLAIM });
      const a = store.create({ name: 'nightly', prompt: 'run tests', schedule: HOURLY });
      automationId = a.id;
      // Claim it (in_flight=1 + 'running' log), advancing next_run_at to 06:00.
      // The launcher then dies before completeRun → orphan with PAST next_run_at.
      const claimed = store.claim(a.id, T_PRIOR_NEXT, new Date(T_PRIOR_CLAIM).toISOString());
      expect(claimed).toBeDefined();
      expect(store.listPending()).toHaveLength(1);
      expect(store.get(a.id)!.inFlight).toBe(true);
      svc.close();
    }

    // ---- Fresh session: reopen the SAME file, reconcile on a later clock. ----
    const svc = SymphonyDatabase.open({ filePath: dbFile });
    try {
      const store = new SqliteAutomationStore(svc.db, { now: () => T_FRESH });
      // The orphan survived the reopen.
      expect(store.listPending()).toHaveLength(1);
      expect(store.get(automationId)!.inFlight).toBe(true);

      const broker = new AutomationsBrokerImpl();
      const events: AutomationEvent[] = [];
      broker.subscribe((e) => events.push(e));
      const scheduler = new AutomationScheduler({ store, broker, now: () => T_FRESH });

      const cleaned = await scheduler.reconcile('startup');
      expect(cleaned).toBe(1); // orphan failed
      const after = store.get(automationId)!;
      expect(after.inFlight).toBe(true); // re-claimed by catch-up
      // Orphan log → 'failure'; catch-up inserted ONE fresh 'running' log.
      const pending = store.listPending();
      expect(pending).toHaveLength(1);
      // Exactly-once: prior claim (1) + catch-up (1) = 2.
      expect(after.runCount).toBe(2);
      // Resynced to a future boundary (10:00), not a per-missed-period replay.
      expect(Date.parse(after.nextRunAt!)).toBeGreaterThan(T_FRESH);
      // Both run logs persisted: one failure (orphan) + one running (catch-up).
      const logs = store.listRunLogs(automationId);
      expect(logs).toHaveLength(2);
      expect(logs.filter((l) => l.status === 'failure')).toHaveLength(1);
      expect(logs.filter((l) => l.status === 'running')).toHaveLength(1);
      // A wake hint was published for the caught-up run.
      expect(events).toHaveLength(1);
      expect(events[0]!.runLogId).toBe(pending[0]!.runLogId);
    } finally {
      svc.close();
    }
  });

  it('reconcile("resume") preserves a live in-flight run yet catches up a separate due one', async () => {
    let liveId: string;
    let dueId: string;
    {
      const svc = SymphonyDatabase.open({ filePath: dbFile });
      const store = new SqliteAutomationStore(svc.db, { now: () => T_PRIOR_CLAIM });
      const live = store.create({ name: 'live', prompt: 'x', schedule: HOURLY });
      const due = store.create({ name: 'due', prompt: 'y', schedule: HOURLY });
      liveId = live.id;
      dueId = due.id;
      // `live` is mid-run (suspended across sleep): in_flight=1, future next_run_at.
      store.claim(live.id, '2026-06-08T10:00:00.000Z', new Date(T_PRIOR_CLAIM).toISOString());
      // `due` is overdue and NOT in flight: force its next_run_at into the past.
      store.forceDue(due.id, '2026-06-08T06:00:00.000Z');
      svc.close();
    }

    const svc = SymphonyDatabase.open({ filePath: dbFile });
    try {
      const store = new SqliteAutomationStore(svc.db, { now: () => T_FRESH });
      const scheduler = new AutomationScheduler({ store, now: () => T_FRESH });
      const liveNextBefore = store.get(liveId)!.nextRunAt;

      const cleaned = await scheduler.reconcile('resume');
      expect(cleaned).toBe(0); // resume never fails the suspended run
      // The live run's 'running' log is intact + its schedule untouched.
      const live = store.get(liveId)!;
      expect(live.inFlight).toBe(true);
      expect(live.nextRunAt).toBe(liveNextBefore);
      expect(store.listRunLogs(liveId).filter((l) => l.status === 'running')).toHaveLength(1);
      // The separate overdue automation was caught up exactly once.
      const due = store.get(dueId)!;
      expect(due.inFlight).toBe(true);
      expect(due.runCount).toBe(1);
      expect(Date.parse(due.nextRunAt!)).toBeGreaterThan(T_FRESH);
      // Two running logs now pending delivery: the live one + the caught-up one.
      expect(store.listPending()).toHaveLength(2);
    } finally {
      svc.close();
    }
  });
});
