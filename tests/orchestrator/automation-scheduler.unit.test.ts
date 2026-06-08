import { beforeEach, describe, expect, it } from 'vitest';
import { AutomationScheduler } from '../../src/orchestrator/automation-scheduler.js';
import { InMemoryAutomationStore } from '../../src/state/automation-store.js';
import {
  AutomationsBrokerImpl,
  type AutomationEvent,
} from '../../src/orchestrator/automations-broker.js';
import type { AutomationSchedule } from '../../src/orchestrator/automation-schedule.js';

/**
 * Phase 8D.1 — `AutomationScheduler.executeTick` + `reconcile`. Driven with
 * an injected clock + the in-memory store (no timers, no DB).
 */

const HOURLY: AutomationSchedule = { type: 'hourly', minute: 0 };

describe('AutomationScheduler', () => {
  let store: InMemoryAutomationStore;
  let broker: AutomationsBrokerImpl;
  let events: AutomationEvent[];
  let now: number;
  let scheduler: AutomationScheduler;

  beforeEach(() => {
    now = Date.parse('2026-06-08T06:00:00.000Z');
    store = new InMemoryAutomationStore({ now: () => now });
    broker = new AutomationsBrokerImpl();
    events = [];
    broker.subscribe((e) => events.push(e));
    scheduler = new AutomationScheduler({ store, broker, now: () => now });
  });

  it('claims a due automation, advances next_run_at, and publishes a wake hint', async () => {
    const a = store.create({ name: 'nightly', prompt: 'run tests', schedule: HOURLY });
    store.forceDue(a.id, new Date(now).toISOString());
    now += 1000; // advance past due

    const claimed = await scheduler.executeTick();

    expect(claimed).toHaveLength(1);
    const after = store.get(a.id)!;
    expect(after.inFlight).toBe(true);
    expect(after.runCount).toBe(1);
    // next_run_at advanced to a future time (no double-fire same period).
    expect(Date.parse(after.nextRunAt!)).toBeGreaterThan(now);
    // The wake hint was published with the claimed run-log id.
    expect(events).toHaveLength(1);
    expect(events[0]!.runLogId).toBe(claimed[0]);
    expect(events[0]!.automationId).toBe(a.id);
    // The run is pending delivery.
    expect(store.listPending().map((p) => p.runLogId)).toEqual([claimed[0]]);
  });

  it('skips an in-flight automation on the next tick (no overlap)', async () => {
    const a = store.create({ name: 'a', prompt: 'x', schedule: HOURLY });
    store.forceDue(a.id, new Date(now).toISOString());
    now += 1000;
    await scheduler.executeTick(); // claims it (in_flight = 1)
    // Force it due AGAIN while still in flight.
    store.forceDue(a.id, new Date(now).toISOString());
    now += 1000;
    const second = await scheduler.executeTick();
    expect(second).toHaveLength(0); // skipped — already in flight
    expect(store.listPending()).toHaveLength(1);
  });

  it('ignores disabled automations', async () => {
    const a = store.create({ name: 'a', prompt: 'x', schedule: HOURLY, enabled: false });
    store.forceDue(a.id, new Date(now).toISOString()); // no-op (disabled)
    now += 1000;
    expect(await scheduler.executeTick()).toHaveLength(0);
    expect(store.get(a.id)!.inFlight).toBe(false);
  });

  it('reconcile("startup") fails orphaned running runs from a prior session', async () => {
    const a = store.create({ name: 'a', prompt: 'x', schedule: HOURLY });
    store.forceDue(a.id, new Date(now).toISOString());
    now += 1000;
    await scheduler.executeTick();
    expect(store.listPending()).toHaveLength(1);
    // Simulate a fresh session: reconcile cleans the orphan.
    now += 60_000;
    const cleaned = await scheduler.reconcile('startup');
    expect(cleaned).toBe(1);
    expect(store.listPending()).toHaveLength(0);
    expect(store.get(a.id)!.inFlight).toBe(false);
  });

  it('reconcile("resume") does NOT fail running runs (8D.3 owns resume math)', async () => {
    const a = store.create({ name: 'a', prompt: 'x', schedule: HOURLY });
    store.forceDue(a.id, new Date(now).toISOString());
    now += 1000;
    await scheduler.executeTick();
    const cleaned = await scheduler.reconcile('resume');
    expect(cleaned).toBe(0);
    expect(store.listPending()).toHaveLength(1); // untouched
  });

  it('stop() is idempotent and prevents further ticks', async () => {
    await scheduler.stop();
    const a = store.create({ name: 'a', prompt: 'x', schedule: HOURLY });
    store.forceDue(a.id, new Date(now).toISOString());
    now += 1000;
    expect(await scheduler.executeTick()).toHaveLength(0); // disposed
    await scheduler.stop(); // idempotent
  });

  // ---- Phase 8D.3 — catch-up reconciliation -----------------------------

  it('reconcile("startup") fails a prior-session orphan AND catches it up once', async () => {
    // Fresh-session clock well past the orphan's advanced next_run_at.
    now = Date.parse('2026-06-08T09:00:00.000Z');
    store = new InMemoryAutomationStore({ now: () => now });
    broker = new AutomationsBrokerImpl();
    events = [];
    broker.subscribe((e) => events.push(e));
    scheduler = new AutomationScheduler({ store, broker, now: () => now });

    const a = store.create({ name: 'nightly', prompt: 'x', schedule: HOURLY });
    // Simulate the prior session: claimed at 05:00, advanced next_run_at to
    // 06:00, then the launcher died before completeRun — an orphaned 'running'
    // log with a PAST next_run_at (06:00 << 09:00).
    store.claim(a.id, '2026-06-08T06:00:00.000Z', '2026-06-08T05:00:00.000Z');
    expect(store.listPending()).toHaveLength(1);
    expect(store.get(a.id)!.inFlight).toBe(true);

    const cleaned = await scheduler.reconcile('startup');

    expect(cleaned).toBe(1); // the orphan was failed
    const after = store.get(a.id)!;
    expect(after.inFlight).toBe(true); // re-claimed by catch-up
    // The orphan log is now 'failure'; catch-up inserted ONE fresh 'running'.
    const pending = store.listPending();
    expect(pending).toHaveLength(1);
    // Exactly-once: prior claim (1) + catch-up claim (1) = 2.
    expect(after.runCount).toBe(2);
    // Resync to a future boundary (10:00), not a per-missed-period replay.
    expect(Date.parse(after.nextRunAt!)).toBeGreaterThan(now);
    // A wake hint was published for the caught-up run.
    expect(events).toHaveLength(1);
    expect(events[0]!.runLogId).toBe(pending[0]!.runLogId);
  });

  it('reconcile("resume") catches up a genuinely-due automation (no orphan, returns 0)', async () => {
    const a = store.create({ name: 'a', prompt: 'x', schedule: HOURLY });
    store.forceDue(a.id, new Date(now).toISOString()); // due now, not in flight
    now += 1000;

    const cleaned = await scheduler.reconcile('resume');

    expect(cleaned).toBe(0); // resume NEVER fails/cleans
    const after = store.get(a.id)!;
    expect(after.inFlight).toBe(true); // claimed by catch-up
    expect(after.runCount).toBe(1);
    expect(Date.parse(after.nextRunAt!)).toBeGreaterThan(now);
    expect(store.listPending()).toHaveLength(1);
    expect(events).toHaveLength(1);
  });

  it('reconcile("resume") leaves a LIVE in-flight run untouched (suspended ≠ crashed)', async () => {
    const a = store.create({ name: 'a', prompt: 'x', schedule: HOURLY });
    store.forceDue(a.id, new Date(now).toISOString());
    now += 1000;
    await scheduler.executeTick(); // claims it: in_flight=1, next_run_at future
    const nextBefore = store.get(a.id)!.nextRunAt;
    events.length = 0;

    const cleaned = await scheduler.reconcile('resume');

    expect(cleaned).toBe(0);
    expect(store.listPending()).toHaveLength(1); // the live run is untouched
    const after = store.get(a.id)!;
    expect(after.inFlight).toBe(true);
    expect(after.nextRunAt).toBe(nextBefore); // NOT advanced — never re-claimed
    expect(after.runCount).toBe(1);
    expect(events).toHaveLength(0); // no new hint
  });

  it('collapses many missed periods into exactly ONE catch-up run', async () => {
    now = Date.parse('2026-06-08T06:00:00.000Z');
    store = new InMemoryAutomationStore({ now: () => now });
    scheduler = new AutomationScheduler({ store, broker, now: () => now });
    const a = store.create({ name: 'a', prompt: 'x', schedule: HOURLY });
    // next_run_at = 07:00. Jump 5 hours — periods 07..11 all elapsed.
    now = Date.parse('2026-06-08T12:00:00.000Z');

    const claimed = await scheduler.executeTick();

    expect(claimed).toHaveLength(1); // ONE run, not five
    const after = store.get(a.id)!;
    expect(after.runCount).toBe(1);
    expect(Date.parse(after.nextRunAt!)).toBeGreaterThan(now); // 13:00
    expect(store.listPending()).toHaveLength(1);
  });

  it('wake heuristic: no false resume on the first tick, then fires after a clock gap', async () => {
    const logs: string[] = [];
    const sched = new AutomationScheduler({
      store,
      broker,
      now: () => now,
      resumeGapMs: 5000,
      log: (_level, message) => logs.push(message),
    });
    const a = store.create({ name: 'a', prompt: 'x', schedule: HOURLY });
    store.forceDue(a.id, new Date(now).toISOString());
    now += 1000;

    // First observed tick — no prior tick → MUST NOT log a resume.
    await sched.executeTick();
    expect(logs.some((l) => l.startsWith('resume detected'))).toBe(false);
    // Complete the run so the next tick has something due to catch up.
    const firstPending = store.listPending();
    store.completeRun(firstPending[0]!.runLogId, 'success', new Date(now).toISOString());

    // Simulate the host sleeping: a large wall-clock gap before the next tick.
    now += 200_000; // 200s >> 5000ms threshold
    store.forceDue(a.id, new Date(now).toISOString());
    now += 1;

    const claimed = await sched.executeTick();

    expect(claimed).toHaveLength(1);
    const resumeLog = logs.find((l) => l.startsWith('resume detected'));
    expect(resumeLog).toBeDefined();
    expect(resumeLog).toContain('caught up 1 missed schedule');
  });

  it('reconcile is disposed-guarded — no claim against a torn-down store', async () => {
    await scheduler.stop(); // disposed = true
    const a = store.create({ name: 'a', prompt: 'x', schedule: HOURLY });
    store.forceDue(a.id, new Date(now).toISOString());
    now += 1000;

    expect(await scheduler.reconcile('startup')).toBe(0);
    expect(await scheduler.reconcile('resume')).toBe(0);
    expect(store.listPending()).toHaveLength(0); // nothing claimed
    expect(store.get(a.id)!.inFlight).toBe(false);
  });

  it('production cold-start sequence (reconcile then immediate tick) does NOT double-fire', async () => {
    const a = store.create({ name: 'a', prompt: 'x', schedule: HOURLY });
    store.forceDue(a.id, new Date(now).toISOString());
    now += 1000;

    const cleaned = await scheduler.reconcile('startup'); // catches up once
    expect(cleaned).toBe(0);
    expect(store.listPending()).toHaveLength(1);

    // server.ts fires an immediate tick right after reconcile; next_run_at was
    // advanced, so it finds nothing due — no second run for the same window.
    const claimed = await scheduler.executeTick();
    expect(claimed).toHaveLength(0);
    expect(store.listPending()).toHaveLength(1);
    expect(store.get(a.id)!.runCount).toBe(1);
  });
});
