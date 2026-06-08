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
});
