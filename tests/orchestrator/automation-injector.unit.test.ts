import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AutomationInjector,
  formatAutomationPrompt,
  type InjectorMaestro,
  type InjectorRpc,
} from '../../src/orchestrator/maestro/automation-injector.js';
import { MaestroTurnInFlightError } from '../../src/orchestrator/maestro/process.js';
import type { PendingRun } from '../../src/state/automation-store.js';

/**
 * Phase 8D.1 — `AutomationInjector` delivery loop: pull → idle-gate →
 * deliver → complete, with busy-retry, dedup, and automation-context flips.
 * Fakes the Maestro event stream + the RPC client.
 */

const flush = async (n = 4): Promise<void> => {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r));
};

type MaestroEv = { type: 'idle'; payload: unknown } | { type: 'error'; reason: string };

function makeChannel() {
  const queue: MaestroEv[] = [];
  let waiter: ((r: IteratorResult<MaestroEv>) => void) | null = null;
  let closed = false;
  return {
    push(ev: MaestroEv): void {
      if (waiter) {
        const w = waiter;
        waiter = null;
        w({ value: ev, done: false });
      } else {
        queue.push(ev);
      }
    },
    close(): void {
      closed = true;
      if (waiter) {
        const w = waiter;
        waiter = null;
        w({ value: undefined as unknown as MaestroEv, done: true });
      }
    },
    iterator(): AsyncIterableIterator<MaestroEv> {
      return {
        [Symbol.asyncIterator]() {
          return this;
        },
        next(): Promise<IteratorResult<MaestroEv>> {
          if (queue.length > 0) return Promise.resolve({ value: queue.shift()!, done: false });
          if (closed) return Promise.resolve({ value: undefined as unknown as MaestroEv, done: true });
          return new Promise((res) => {
            waiter = res;
          });
        },
      };
    },
  };
}

function run(id: number, name = `auto-${id}`): PendingRun {
  return { runLogId: id, automationId: `a${id}`, automationName: name, prompt: `do ${id}`, projectId: null };
}

interface Rig {
  injector: AutomationInjector;
  channel: ReturnType<typeof makeChannel>;
  sendUserMessage: ReturnType<typeof vi.fn>;
  takePending: ReturnType<typeof vi.fn>;
  completeRun: ReturnType<typeof vi.fn>;
  setAutomationContext: ReturnType<typeof vi.fn>;
  /** Drives `sendUserMessage` to throw busy on the next call. */
  busyOnce: { value: boolean };
  /** When set, completeRun awaits this before resolving (audit C1 test). */
  completeGate: { promise: Promise<void> | null };
}

function makeRig(initialPending: PendingRun[]): Rig {
  const channel = makeChannel();
  const busyOnce = { value: false };
  const completeGate: { promise: Promise<void> | null } = { promise: null };
  const sendUserMessage = vi.fn((_text: string) => {
    if (busyOnce.value) {
      busyOnce.value = false;
      throw new MaestroTurnInFlightError();
    }
  });
  // Model the store's `'running'` set: takePending returns only runs not yet
  // completed, so a completed run can't be re-pulled.
  const running = new Set(initialPending.map((p) => p.runLogId));
  const takePending = vi.fn(async (): Promise<readonly PendingRun[]> => {
    return initialPending.filter((p) => running.has(p.runLogId));
  });
  const completeRun = vi.fn(async (args: { runLogId: number }) => {
    if (completeGate.promise !== null) await completeGate.promise;
    running.delete(args.runLogId);
    return { completed: true };
  });
  const setAutomationContext = vi.fn(async (args: { active: boolean }) => ({ active: args.active }));
  const rpc: InjectorRpc = {
    call: {
      automations: { takePending, completeRun },
      runtime: { setAutomationContext },
    },
    subscribe: async () => ({ unsubscribe: async () => {} }),
  };
  const injector = new AutomationInjector({
    // The injector only reads `event.type`; the fake's payload shape is
    // irrelevant at runtime, so cast past the HookPayload requirement.
    maestro: { sendUserMessage, events: () => channel.iterator() } as unknown as InjectorMaestro,
    rpc,
    safetyPollMs: 1_000_000, // never auto-fires in the test window
  });
  return {
    injector,
    channel,
    sendUserMessage,
    takePending,
    completeRun,
    setAutomationContext,
    busyOnce,
    completeGate,
  };
}

describe('AutomationInjector', () => {
  let rig: Rig;

  beforeEach(() => {
    rig = makeRig([run(1)]);
  });

  it('delivers a pending run to Maestro and flips the automation context', async () => {
    rig.injector.start();
    await flush();
    expect(rig.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(rig.sendUserMessage).toHaveBeenCalledWith(formatAutomationPrompt(run(1)));
    expect(rig.setAutomationContext).toHaveBeenCalledWith({ active: true });
    await rig.injector.stop();
  });

  it('completes the run + clears the context when Maestro goes idle', async () => {
    rig.injector.start();
    await flush();
    rig.channel.push({ type: 'idle', payload: {} });
    await flush();
    expect(rig.completeRun).toHaveBeenCalledWith({ runLogId: 1, status: 'success' });
    expect(rig.setAutomationContext).toHaveBeenLastCalledWith({ active: false });
    await rig.injector.stop();
  });

  it('marks failure when Maestro errors mid-run', async () => {
    rig.injector.start();
    await flush();
    rig.channel.push({ type: 'error', reason: 'boom' });
    await flush();
    expect(rig.completeRun).toHaveBeenCalledWith({ runLogId: 1, status: 'failure' });
    await rig.injector.stop();
  });

  it('queues while Maestro is busy and delivers on the next idle', async () => {
    rig.busyOnce.value = true; // first sendUserMessage throws TurnInFlight
    rig.injector.start();
    await flush();
    // Busy: nothing delivered yet (the throw is caught), context rolled back.
    expect(rig.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(rig.setAutomationContext).toHaveBeenLastCalledWith({ active: false });
    // Maestro finishes its user turn → idle → retry succeeds.
    rig.channel.push({ type: 'idle', payload: {} });
    await flush();
    expect(rig.sendUserMessage).toHaveBeenCalledTimes(2);
    await rig.injector.stop();
  });

  it('dedups: a re-poll of the same still-pending run does not double-deliver', async () => {
    rig.injector.start();
    await flush();
    expect(rig.sendUserMessage).toHaveBeenCalledTimes(1);
    // A second poll returns the SAME run (still 'running' until completeRun).
    await rig.injector.poll();
    await flush();
    expect(rig.sendUserMessage).toHaveBeenCalledTimes(1); // not re-delivered
    await rig.injector.stop();
  });

  it('does not double-deliver when a poll fires during the completeRun await (audit C1)', async () => {
    // Block completeRun so the run is still server-side 'running' while a
    // concurrent poll (wake hint / safety timer) sneaks in.
    let release!: () => void;
    rig.completeGate.promise = new Promise<void>((r) => {
      release = r;
    });

    rig.injector.start();
    await flush();
    expect(rig.sendUserMessage).toHaveBeenCalledTimes(1);

    // Maestro idles → finishActive begins + suspends in the gated completeRun.
    rig.channel.push({ type: 'idle', payload: {} });
    await flush();
    expect(rig.completeRun).toHaveBeenCalledTimes(1);

    // A poll fires WHILE completeRun is in flight. The run is still 'running'
    // (gate not released) — the injector must NOT re-deliver it.
    await rig.injector.poll();
    await flush();
    expect(rig.sendUserMessage).toHaveBeenCalledTimes(1); // still 1 — no double-fire

    // Release completion; subsequent polls find nothing pending.
    release();
    await flush();
    await rig.injector.poll();
    await flush();
    expect(rig.sendUserMessage).toHaveBeenCalledTimes(1);
    await rig.injector.stop();
  });
});
