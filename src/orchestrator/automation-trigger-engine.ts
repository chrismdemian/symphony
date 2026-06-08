/**
 * Phase 8D.2 — Automation trigger engine (Process B).
 *
 * The event-driven counterpart to 8D.1's {@link AutomationScheduler}. It polls
 * the configured trigger sources every 10s, detects genuinely-NEW events
 * (diffing against a per-automation in-memory known-id set), and CLAIMS a run
 * for the next new event of each idle automation (at most one per automation
 * per cycle — see the structural-change note below) so the launcher's injector
 * (Process A) delivers an event-enriched prompt to Maestro. Same claim →
 * wake-hint → pull → deliver → completeRun pipeline as the scheduler; only the
 * detection differs.
 *
 * Adapted from emdash `AutomationsService`'s trigger half, with one structural
 * change for Symphony's per-automation `in_flight` model (emdash fires an
 * independent agent per event; Symphony runs one at a time):
 *
 *   - {@link AutomationStore.listActiveTriggers} EXCLUDES in-flight automations.
 *   - A new event is marked "known" ONLY after a successful `claimTrigger`.
 *   - At most ONE event fires per automation per cycle (the claim flips
 *     `in_flight = 1`); the rest stay un-known and fire in later cycles once
 *     the active run completes. No event is silently dropped.
 *
 * The known set is in-memory (per emdash). On a Symphony restart it is empty,
 * so the first poll RE-SEEDS without firing — events that arrived while
 * Symphony was DOWN are treated as pre-existing and won't fire (8D.3
 * reconciliation is about missed schedules, not trigger backfill). A
 * disabled→re-enabled automation keeps its known set (it is merely excluded
 * while disabled), so re-enabling MAY fire events that arrived during the
 * disabled window — documented, refinable in 8D.4.
 */

import type { AutomationStore } from '../state/automation-store.js';
import type { AutomationsBroker } from './automations-broker.js';
import type { RawTriggerEvent, TriggerSource } from './automation-trigger-source.js';

/** Default trigger poll interval — emdash uses 10s (GitHub's recommended X-Poll-Interval). */
export const DEFAULT_TRIGGER_POLL_INTERVAL_MS = 10_000;
/** Short delay before the first poll so connectors finish initializing (emdash 2s). */
export const DEFAULT_TRIGGER_WARMUP_MS = 2_000;
/** Cap the per-automation known-id set; trim to {@link KNOWN_EVENT_TRIM_TO} when exceeded. */
export const KNOWN_EVENT_CAP = 5000;
export const KNOWN_EVENT_TRIM_TO = 2000;

export interface AutomationTriggerEngineDeps {
  readonly store: AutomationStore;
  /** Map of `trigger_type` → source. Built from the active 8C connectors. */
  readonly sources: ReadonlyMap<string, TriggerSource>;
  /** Wake-hint broadcaster (same broker the scheduler publishes to). */
  readonly broker?: AutomationsBroker;
  /** Injected clock (ms). Defaults to Date.now. */
  readonly now?: () => number;
  /** Poll interval. Defaults to {@link DEFAULT_TRIGGER_POLL_INTERVAL_MS}. */
  readonly pollIntervalMs?: number;
  /** First-poll warm-up delay. Defaults to {@link DEFAULT_TRIGGER_WARMUP_MS}. */
  readonly warmupMs?: number;
  /** Known-set cap before trimming (tests). Defaults to {@link KNOWN_EVENT_CAP}. */
  readonly knownEventCap?: number;
  /** Known-set size after a trim (tests). Defaults to {@link KNOWN_EVENT_TRIM_TO}. */
  readonly knownEventTrimTo?: number;
  readonly log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

export class AutomationTriggerEngine {
  private readonly store: AutomationStore;
  private readonly sources: ReadonlyMap<string, TriggerSource>;
  private readonly broker: AutomationsBroker | undefined;
  private readonly now: () => number;
  private readonly pollIntervalMs: number;
  private readonly warmupMs: number;
  private readonly knownEventCap: number;
  private readonly knownEventTrimTo: number;
  private readonly log: (level: 'info' | 'warn' | 'error', message: string) => void;

  /** automationId → set of event ids already acted on (claimed/seeded). */
  private readonly knownEventIds = new Map<string, Set<string>>();
  /** Drop a slow cycle rather than queue it — a 20s-late "new" event is still correct. */
  private triggerTicking = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private warmupTimer: ReturnType<typeof setTimeout> | undefined;
  private currentTick: Promise<void> | undefined;
  private disposed = false;

  constructor(deps: AutomationTriggerEngineDeps) {
    this.store = deps.store;
    this.sources = deps.sources;
    this.broker = deps.broker;
    this.now = deps.now ?? Date.now;
    this.pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_TRIGGER_POLL_INTERVAL_MS;
    this.warmupMs = deps.warmupMs ?? DEFAULT_TRIGGER_WARMUP_MS;
    this.knownEventCap = deps.knownEventCap ?? KNOWN_EVENT_CAP;
    this.knownEventTrimTo = deps.knownEventTrimTo ?? KNOWN_EVENT_TRIM_TO;
    this.log = deps.log ?? (() => undefined);
  }

  /** Begin polling. Idempotent. First poll fires after the warm-up delay. */
  start(): void {
    if (this.disposed || this.timer !== undefined) return;
    this.log('info', `trigger engine started (poll ${this.pollIntervalMs}ms)`);
    this.timer = setInterval(() => void this.tick(), this.pollIntervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    this.warmupTimer = setTimeout(() => void this.tick(), this.warmupMs);
    if (typeof this.warmupTimer.unref === 'function') this.warmupTimer.unref();
  }

  /** Stop polling. Idempotent. Drains an in-flight poll so it finishes cleanly. */
  async stop(): Promise<void> {
    this.disposed = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.warmupTimer !== undefined) {
      clearTimeout(this.warmupTimer);
      this.warmupTimer = undefined;
    }
    if (this.currentTick !== undefined) await this.currentTick.catch(() => {});
  }

  /** Tick wrapper — overlap-guarded, never lets a throw kill the interval. */
  private tick(): Promise<void> {
    if (this.disposed || this.triggerTicking) return Promise.resolve();
    this.triggerTicking = true;
    const run = (async (): Promise<void> => {
      try {
        await this.executeTriggerPoll();
      } catch (err) {
        this.log(
          'warn',
          `trigger poll failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        this.triggerTicking = false;
      }
    })();
    this.currentTick = run.finally(() => {
      this.currentTick = undefined;
    });
    return this.currentTick;
  }

  /**
   * One trigger poll. Fetches each active trigger automation's source (a
   * per-cycle cache coalesces multiple automations on the same `trigger_type`
   * into ONE API call), detects new events, and claims at most one per
   * automation. Returns the run-log ids claimed this cycle (tests).
   */
  async executeTriggerPoll(): Promise<readonly number[]> {
    if (this.disposed) return [];
    const automations = this.store.listActiveTriggers();
    if (automations.length === 0) return [];
    const nowIso = new Date(this.now()).toISOString();
    // Per-cycle fetch cache: N automations watching the same trigger type make
    // ONE source call this cycle (emdash `fetchNewEventsCached`).
    const fetchCache = new Map<string, Promise<readonly RawTriggerEvent[]>>();
    const claimed: number[] = [];

    for (const auto of automations) {
      if (this.disposed) break;
      if (auto.triggerType === null) continue; // defensive — listActiveTriggers guarantees non-null
      const source = this.sources.get(auto.triggerType);
      if (source === undefined) continue; // no connector configured for this type

      const events = await this.fetchCached(source, fetchCache);

      // First poll for this automation: seed the known set WITHOUT firing, so
      // pre-existing open issues never trigger on cold start.
      const existing = this.knownEventIds.get(auto.id);
      if (existing === undefined) {
        // Insert OLDEST-first so the known set's iteration order is chronological
        // (newest at the back), matching the incremental claim path below. The
        // trim drops the front (oldest), so it keeps the newest — the ids most
        // likely to reappear in the next fetch. Connectors return newest-first,
        // so reverse before seeding. (The trim is unreachable here in practice:
        // ISSUE_TRIGGER_FETCH_LIMIT (≤50) << KNOWN_EVENT_CAP (5000); it only
        // fires on the long-run claim path. The reverse keeps the seed honest if
        // the fetch limit is ever raised.)
        const seeded = new Set([...events].reverse().map((e) => e.id));
        this.trimKnown(seeded);
        this.knownEventIds.set(auto.id, seeded);
        this.log(
          'info',
          `seeded ${seeded.size} known event(s) for "${auto.name}" (${auto.triggerType})`,
        );
        continue;
      }

      const fresh = events.filter((e) => !existing.has(e.id));
      if (fresh.length === 0) continue;

      // Claim the first fresh event. The claim flips in_flight=1, so a second
      // claim this cycle would fail the WHERE in_flight=0 guard — fire one,
      // leave the rest un-known to fire in later cycles. Mark known ONLY on a
      // successful claim so a raced/failed claim retries next cycle.
      for (const event of fresh) {
        if (this.disposed) break;
        const result = this.store.claimTrigger(auto.id, JSON.stringify(event), nowIso);
        if (result === undefined) break; // raced — another claimer won; retry next cycle
        existing.add(event.id);
        this.trimKnown(existing);
        claimed.push(result.runLogId);
        this.broker?.publish({ runLogId: result.runLogId, automationId: auto.id });
        this.log(
          'info',
          `triggered "${auto.name}" on ${event.type} "${event.title}" (run ${result.runLogId})`,
        );
        break; // one event per automation per cycle
      }
    }

    return claimed;
  }

  /** Coalesce same-`trigger_type` fetches within one cycle. */
  private fetchCached(
    source: TriggerSource,
    cache: Map<string, Promise<readonly RawTriggerEvent[]>>,
  ): Promise<readonly RawTriggerEvent[]> {
    let p = cache.get(source.triggerType);
    if (p === undefined) {
      // `fetchEvents` is contracted not to throw, but a custom/injected source
      // might. Cache the resilient promise so one bad source costs only its own
      // events this cycle, never the whole poll (audit M-4).
      p = Promise.resolve()
        .then(() => source.fetchEvents())
        .catch((err) => {
          this.log(
            'warn',
            `trigger source ${source.triggerType} threw: ${err instanceof Error ? err.message : String(err)}`,
          );
          return [] as readonly RawTriggerEvent[];
        });
      cache.set(source.triggerType, p);
    }
    return p;
  }

  /** Bound the known set: drop the oldest ids past the cap (insertion order). */
  private trimKnown(known: Set<string>): void {
    if (known.size <= this.knownEventCap) return;
    const entries = Array.from(known);
    const toRemove = entries.slice(0, entries.length - this.knownEventTrimTo);
    for (const id of toRemove) known.delete(id);
  }
}
