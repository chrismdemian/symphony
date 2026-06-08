/**
 * Phase 8D.1 — Automation delivery (Process A / launcher).
 *
 * The scheduler (Process B) claims due automations into `'running'` run
 * logs. This injector PULLS those claimed runs (`automations.takePending`)
 * and delivers each to the live Maestro process, then reports the outcome
 * (`automations.completeRun`). Pull-based by design: the
 * `automations.events` wake hint can be dropped on backpressure, so it only
 * triggers an immediate poll; a slow safety-poll is the reliable backstop.
 *
 * Delivery is serialized and idle-gated. `maestro.sendUserMessage` throws
 * `MaestroTurnInFlightError` while Maestro is mid-turn (user typing or a
 * prior automation); the injector catches that and retries on the next idle
 * — the run stays claimed (DB `in_flight`) until it actually fires. While an
 * automation turn is delivering, `runtime.setAutomationContext(true)` flips
 * the dispatch cursor so host-browser-control tools are denied (belt-and-
 * suspenders — same cross-process limitation as `interrupt`).
 */

import type { PendingRun } from '../../state/automation-store.js';
import type { MaestroProcess } from './process.js';

/** The slice of the live Maestro process the injector drives. */
export type InjectorMaestro = Pick<MaestroProcess, 'sendUserMessage' | 'events'>;

/** A live subscription handle (subset of the RPC client's). */
interface InjectorSubscription {
  unsubscribe(): Promise<void>;
}

/** The slice of the RPC client the injector calls. */
export interface InjectorRpc {
  readonly call: {
    readonly automations: {
      takePending(): Promise<readonly PendingRun[]>;
      completeRun(args: {
        runLogId: number;
        status: 'success' | 'failure';
        error?: string;
      }): Promise<{ completed: boolean }>;
    };
    readonly runtime: {
      setAutomationContext(args: { active: boolean }): Promise<{ active: boolean }>;
    };
  };
  subscribe(
    topic: string,
    args: unknown,
    onEvent: (payload: unknown) => void,
  ): Promise<InjectorSubscription>;
}

export interface AutomationInjectorDeps {
  readonly maestro: InjectorMaestro;
  readonly rpc: InjectorRpc;
  /** Safety re-poll interval (ms). Default 60s. The wake hint covers latency. */
  readonly safetyPollMs?: number;
  readonly log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

const DEFAULT_SAFETY_POLL_MS = 60_000;
const AUTOMATIONS_EVENTS_TOPIC = 'automations.events';

/**
 * Format the firing marker so Maestro knows the turn is automation-driven.
 * A TRIGGER run (8D.2) carries the firing event's JSON on `run.triggerEvent`,
 * so the prompt is prepended with event context (`[Automation … triggered by
 * <type>: "<title>"]` + URL). A SCHEDULE run gets the plain scheduled prefix.
 * A malformed trigger-event JSON falls back to the scheduled prefix rather
 * than dropping the turn.
 */
export function formatAutomationPrompt(run: PendingRun): string {
  if (run.triggerEvent !== null) {
    const enriched = enrichTriggeredPrompt(run.triggerEvent, run.automationName, run.prompt);
    if (enriched !== undefined) return enriched;
  }
  return `[Scheduled automation: ${run.automationName}]\n\n${run.prompt}`;
}

interface TriggerEventShape {
  readonly title?: unknown;
  readonly url?: unknown;
  readonly type?: unknown;
  readonly extra?: unknown;
}

/** Prepend event context to a triggered run's base prompt. `undefined` on malformed JSON. */
function enrichTriggeredPrompt(
  eventJson: string,
  automationName: string,
  basePrompt: string,
): string | undefined {
  let parsed: TriggerEventShape;
  try {
    const obj: unknown = JSON.parse(eventJson);
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return undefined;
    parsed = obj as TriggerEventShape;
  } catch {
    return undefined;
  }
  const type =
    typeof parsed.type === 'string' && parsed.type.length > 0 ? parsed.type : 'event';
  const title = typeof parsed.title === 'string' ? parsed.title : '(untitled)';
  const lines: string[] = [
    `[Automation "${automationName}" triggered by ${type}: "${title}"]`,
  ];
  if (typeof parsed.url === 'string' && parsed.url.length > 0) lines.push(`URL: ${parsed.url}`);
  if (typeof parsed.extra === 'string' && parsed.extra.length > 0) lines.push(parsed.extra);
  return `${lines.join('\n')}\n\n${basePrompt}`;
}

export class AutomationInjector {
  private readonly maestro: InjectorMaestro;
  private readonly rpc: InjectorRpc;
  private readonly safetyPollMs: number;
  private readonly log: (level: 'info' | 'warn' | 'error', message: string) => void;

  /** FIFO of runs taken responsibility for, awaiting delivery. */
  private readonly queue: PendingRun[] = [];
  /** Run-log ids already queued/active/completing — dedups poll results. */
  private readonly inFlight = new Set<number>();
  /** The run-log id currently delivered to Maestro (awaiting turn end). */
  private active: number | null = null;
  /** Sync guard against re-entrant delivery across the setContext await. */
  private delivering = false;
  private started = false;
  private disposed = false;
  private safetyTimer: ReturnType<typeof setInterval> | undefined;
  private subscription: InjectorSubscription | undefined;

  constructor(deps: AutomationInjectorDeps) {
    this.maestro = deps.maestro;
    this.rpc = deps.rpc;
    this.safetyPollMs = deps.safetyPollMs ?? DEFAULT_SAFETY_POLL_MS;
    this.log = deps.log ?? (() => undefined);
  }

  /** Begin consuming Maestro events, subscribe to wake hints, poll. Idempotent. */
  start(): void {
    if (this.disposed || this.started) return;
    this.started = true;
    void this.consumeEvents();
    void this.subscribeWake();
    void this.poll();
    this.safetyTimer = setInterval(() => void this.poll(), this.safetyPollMs);
    if (typeof this.safetyTimer.unref === 'function') this.safetyTimer.unref();
  }

  /** Stop. Idempotent. Does NOT complete an in-flight run (the next session reconciles). */
  async stop(): Promise<void> {
    this.disposed = true;
    if (this.safetyTimer !== undefined) {
      clearInterval(this.safetyTimer);
      this.safetyTimer = undefined;
    }
    if (this.subscription !== undefined) {
      await this.subscription.unsubscribe().catch(() => {});
      this.subscription = undefined;
    }
  }

  private async subscribeWake(): Promise<void> {
    try {
      this.subscription = await this.rpc.subscribe(AUTOMATIONS_EVENTS_TOPIC, {}, () => {
        void this.poll();
      });
    } catch {
      // The wake hint is best-effort — the safety poll is the reliable path.
    }
  }

  /** Pull claimed runs, enqueue the new ones, attempt delivery. */
  async poll(): Promise<void> {
    if (this.disposed) return;
    let pending: readonly PendingRun[];
    try {
      pending = await this.rpc.call.automations.takePending();
    } catch (err) {
      this.log('warn', `takePending failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (this.disposed) return;
    for (const run of pending) {
      if (this.inFlight.has(run.runLogId)) continue;
      this.inFlight.add(run.runLogId);
      this.queue.push(run);
    }
    await this.tryDrain();
  }

  /** Deliver the next queued run if Maestro is idle. */
  private async tryDrain(): Promise<void> {
    if (this.disposed || this.active !== null || this.delivering) return;
    const next = this.queue[0];
    if (next === undefined) return;
    this.delivering = true;
    try {
      // Flip the automation-context cursor BEFORE the turn so the capability
      // evaluator denies host-browser-control while it runs.
      await this.rpc.call.runtime.setAutomationContext({ active: true }).catch(() => {});
      if (this.disposed) {
        // Audit m1 — don't strand the cursor `true` if we tore down during
        // the await. Best-effort; the whole server is likely shutting down.
        await this.rpc.call.runtime.setAutomationContext({ active: false }).catch(() => {});
        return;
      }
      try {
        this.maestro.sendUserMessage(formatAutomationPrompt(next));
      } catch {
        // Maestro busy (user typing / prior turn). Back off; the run stays
        // queued + claimed and retries on the next idle/poll.
        await this.rpc.call.runtime.setAutomationContext({ active: false }).catch(() => {});
        return;
      }
      this.queue.shift();
      this.active = next.runLogId;
      this.log('info', `delivered automation "${next.automationName}" (run ${next.runLogId})`);
    } finally {
      this.delivering = false;
    }
  }

  /** Mark the active run finished + clear the automation context. */
  private async finishActive(status: 'success' | 'failure'): Promise<void> {
    const id = this.active;
    if (id === null) return;
    // Audit C1 — hold `active` + `inFlight` across the completeRun await.
    // Releasing them first would let a concurrent poll (wake hint / safety
    // timer) re-deliver the run: `takePending` still reports it 'running'
    // until completeRun lands, and the dedup guard would already be gone.
    // Held this way, a concurrent poll sees `active !== null` (tryDrain
    // no-ops) AND `inFlight.has(id)` (skip re-queue) until completion is
    // durable. finishActive runs only from the sequential event loop, so
    // there is no re-entrant finishActive on the same id.
    try {
      await this.rpc.call.automations.completeRun({ runLogId: id, status });
    } catch (err) {
      this.log('warn', `completeRun(${id}) failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    await this.rpc.call.runtime.setAutomationContext({ active: false }).catch(() => {});
    this.active = null;
    this.inFlight.delete(id);
  }

  /** Watch Maestro turn lifecycle — an idle after delivery completes the run. */
  private async consumeEvents(): Promise<void> {
    try {
      for await (const event of this.maestro.events()) {
        if (this.disposed) break;
        if (event.type === 'idle') {
          if (this.active !== null) await this.finishActive('success');
          await this.tryDrain();
        } else if (event.type === 'error') {
          if (this.active !== null) await this.finishActive('failure');
          // Don't drain on error — Maestro is likely tearing down.
        }
      }
    } catch {
      // Event stream closed (Maestro exited). Shutdown is driven elsewhere.
    }
  }
}
