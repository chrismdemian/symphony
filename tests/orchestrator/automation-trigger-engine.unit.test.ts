import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AutomationTriggerEngine } from '../../src/orchestrator/automation-trigger-engine.js';
import type { RawTriggerEvent, TriggerSource } from '../../src/orchestrator/automation-trigger-source.js';
import { InMemoryAutomationStore } from '../../src/state/automation-store.js';
import { createAutomationsBroker } from '../../src/orchestrator/automations-broker.js';

/**
 * Phase 8D.2 — the trigger poll engine. Drives `executeTriggerPoll()` directly
 * (no timers) over an in-memory store + a controllable fake source.
 */

function ev(id: string, title = id): RawTriggerEvent {
  return { id, title, url: null, type: 'GitHub issue', labels: [], assignee: null };
}

/** A fake source whose event list is swapped between polls. */
function fakeSource(triggerType: string): {
  source: TriggerSource;
  set: (events: RawTriggerEvent[]) => void;
  calls: () => number;
} {
  let events: RawTriggerEvent[] = [];
  let calls = 0;
  return {
    source: {
      triggerType,
      fetchEvents: async () => {
        calls += 1;
        return events;
      },
    },
    set: (e) => {
      events = e;
    },
    calls: () => calls,
  };
}

let clock = Date.parse('2026-06-08T06:00:00.000Z');

function makeEngine(sources: ReadonlyMap<string, TriggerSource>, extra?: { cap?: number; trimTo?: number }) {
  const store = new InMemoryAutomationStore({ now: () => clock });
  const broker = createAutomationsBroker();
  const published: { runLogId: number; automationId: string }[] = [];
  broker.subscribe((e) => published.push(e));
  const engine = new AutomationTriggerEngine({
    store,
    sources,
    broker,
    now: () => clock,
    ...(extra?.cap !== undefined ? { knownEventCap: extra.cap } : {}),
    ...(extra?.trimTo !== undefined ? { knownEventTrimTo: extra.trimTo } : {}),
  });
  return { store, engine, published };
}

beforeEach(() => {
  clock = Date.parse('2026-06-08T06:00:00.000Z');
});

describe('AutomationTriggerEngine', () => {
  it('first poll SEEDS the known set without firing (pre-existing issues never trigger)', async () => {
    const gh = fakeSource('github_issue');
    gh.set([ev('github:o/r#1'), ev('github:o/r#2')]);
    const { store, engine, published } = makeEngine(new Map([['github_issue', gh.source]]));
    store.create({ name: 't', prompt: 'p', triggerType: 'github_issue' });

    const claimed = await engine.executeTriggerPoll();
    expect(claimed).toEqual([]);
    expect(published).toHaveLength(0);
    expect(store.listPending()).toHaveLength(0);
  });

  it('a NEW event after the seed fires exactly one claim + a wake hint', async () => {
    const gh = fakeSource('github_issue');
    gh.set([ev('github:o/r#1')]);
    const { store, engine, published } = makeEngine(new Map([['github_issue', gh.source]]));
    const auto = store.create({ name: 't', prompt: 'triage', triggerType: 'github_issue' });

    await engine.executeTriggerPoll(); // seed {#1}
    gh.set([ev('github:o/r#2', 'New bug'), ev('github:o/r#1')]); // #2 is new
    const claimed = await engine.executeTriggerPoll();

    expect(claimed).toHaveLength(1);
    expect(published).toEqual([{ runLogId: claimed[0], automationId: auto.id }]);
    const pending = store.listPending();
    expect(pending).toHaveLength(1);
    expect(JSON.parse(pending[0]!.triggerEvent!)).toMatchObject({ id: 'github:o/r#2', title: 'New bug' });
    // The automation is now in-flight — a re-poll claims nothing more.
    expect(await engine.executeTriggerPoll()).toEqual([]);
  });

  it('per-cycle dedup cache: two automations on the same type make ONE source fetch', async () => {
    const gh = fakeSource('github_issue');
    gh.set([ev('github:o/r#1')]);
    const { store, engine } = makeEngine(new Map([['github_issue', gh.source]]));
    store.create({ name: 'a', prompt: 'p', triggerType: 'github_issue' });
    store.create({ name: 'b', prompt: 'p', triggerType: 'github_issue' });

    await engine.executeTriggerPoll();
    expect(gh.calls()).toBe(1); // both automations shared one fetch this cycle
  });

  it('fires at most one event per automation per cycle; the rest fire after completion', async () => {
    const gh = fakeSource('github_issue');
    gh.set([ev('github:o/r#1')]);
    const { store, engine } = makeEngine(new Map([['github_issue', gh.source]]));
    store.create({ name: 't', prompt: 'p', triggerType: 'github_issue' });
    await engine.executeTriggerPoll(); // seed {#1}

    // Two new events appear at once.
    gh.set([ev('github:o/r#3'), ev('github:o/r#2'), ev('github:o/r#1')]);
    const first = await engine.executeTriggerPoll();
    expect(first).toHaveLength(1); // only one claimed (in_flight now)
    const firstPending = store.listPending();
    const firstId = JSON.parse(firstPending[0]!.triggerEvent!).id;

    // Complete the run; the OTHER fresh event fires next cycle (not lost).
    store.completeRun(first[0]!, 'success', '2026-06-08T06:05:00.000Z');
    const second = await engine.executeTriggerPoll();
    expect(second).toHaveLength(1);
    const secondId = JSON.parse(store.listPending()[0]!.triggerEvent!).id;
    expect(secondId).not.toBe(firstId);
    // Both #2 and #3 eventually fired (no event silently dropped).
    expect(new Set([firstId, secondId])).toEqual(new Set(['github:o/r#2', 'github:o/r#3']));
  });

  it('a disabled trigger automation never fires', async () => {
    const gh = fakeSource('github_issue');
    gh.set([ev('github:o/r#1')]);
    const { store, engine } = makeEngine(new Map([['github_issue', gh.source]]));
    store.create({ name: 't', prompt: 'p', triggerType: 'github_issue', enabled: false });
    gh.set([ev('github:o/r#2')]);
    expect(await engine.executeTriggerPoll()).toEqual([]);
    expect(gh.calls()).toBe(0); // not even fetched (excluded from listActiveTriggers)
  });

  it('an automation whose trigger type has no configured source is skipped', async () => {
    const { store, engine } = makeEngine(new Map()); // no sources
    store.create({ name: 't', prompt: 'p', triggerType: 'github_issue' });
    expect(await engine.executeTriggerPoll()).toEqual([]);
  });

  it('the known set is capped and the trim keeps the NEWEST ids', async () => {
    const gh = fakeSource('github_issue');
    // Connectors return newest-first; #7 is newest, #0 is oldest. Seeding 8 with
    // cap 5 / trimTo 2 trims to the 2 NEWEST (#7, #6).
    gh.set(Array.from({ length: 8 }, (_v, i) => ev(`github:o/r#${7 - i}`)));
    const { store, engine } = makeEngine(new Map([['github_issue', gh.source]]), { cap: 5, trimTo: 2 });
    store.create({ name: 't', prompt: 'p', triggerType: 'github_issue' });
    await engine.executeTriggerPoll(); // seed 8 → trimmed to {#6, #7}

    // Re-fetching the newest (#7, #6) → still known → nothing fires.
    gh.set([ev('github:o/r#7'), ev('github:o/r#6')]);
    expect(await engine.executeTriggerPoll()).toEqual([]);
  });

  it('executeTriggerPoll is a no-op after stop()', async () => {
    const gh = fakeSource('github_issue');
    gh.set([ev('github:o/r#1')]);
    const { store, engine } = makeEngine(new Map([['github_issue', gh.source]]));
    store.create({ name: 't', prompt: 'p', triggerType: 'github_issue' });
    await engine.stop();
    expect(await engine.executeTriggerPoll()).toEqual([]);
  });

  it('start() schedules a warm-up poll and is idempotent', async () => {
    vi.useFakeTimers();
    try {
      const gh = fakeSource('github_issue');
      gh.set([ev('github:o/r#1')]);
      const { store, engine } = makeEngine(new Map([['github_issue', gh.source]]));
      store.create({ name: 't', prompt: 'p', triggerType: 'github_issue' });
      engine.start();
      engine.start(); // idempotent — no second timer set
      await vi.advanceTimersByTimeAsync(2_100); // past the 2s warm-up
      expect(gh.calls()).toBeGreaterThanOrEqual(1);
      await engine.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
