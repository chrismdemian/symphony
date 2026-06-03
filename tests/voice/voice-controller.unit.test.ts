import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';

import { VoiceController } from '../../src/voice/voice-controller.js';
import type { VoiceSnapshot } from '../../src/voice/voice-controller.js';
import { VoiceBridgeError, type VoiceBridge } from '../../src/voice/bridge.js';
import type { VoiceBridgeEvent } from '../../src/voice/types.js';

/**
 * Phase 6E.1 — VoiceController unit tests (summon path).
 *
 * Drives a FAKE bridge via the `bridgeFactory` seam — no Python, no
 * SQLite, no audio. The fake mirrors the real bridge's EventEmitter
 * surface (`on`/`once`/`off`/`removeAllListeners` inherited) plus the
 * three methods the controller touches: `start`, `stop`, `getStderrTail`.
 */

/**
 * Plain (NOT `vi.fn`) fake bridge. `tests/setup.ts` runs
 * `vi.restoreAllMocks()` in a global `afterEach`, which would strip the
 * implementation off any `vi.fn(async ...)` bound to a class field —
 * intermittently neutering `start`/`stop` across the suite. Hand-rolled
 * counters sidestep that entirely.
 */
class FakeBridge extends EventEmitter {
  started = false;
  startCalls = 0;
  startResolve: (() => void) | undefined;
  stopCalls = 0;
  startOpts: unknown;
  private readonly readyValue: Extract<VoiceBridgeEvent, { type: 'ready' }> = {
    type: 'ready',
    backend: 'sounddevice',
    sampleRate: 16000,
    vadThreshold: 0.5,
    vadMinSpeechMs: 100,
    vadMinSilenceMs: 400,
  };
  /** When true, `start()` rejects (spawn / ready failure). */
  failStart = false;
  /** When set, `start()` parks until `releaseStart()` is called (race tests). */
  deferStart = false;

  async start(opts: unknown): Promise<Extract<VoiceBridgeEvent, { type: 'ready' }>> {
    this.startCalls += 1;
    this.startOpts = opts;
    if (this.failStart) {
      // Real VoiceBridgeError so the controller's `instanceof` formatting
      // path (`${code}: ${message}`) fires exactly as in production.
      throw new VoiceBridgeError('ready-timeout', 'fake ready timeout');
    }
    if (this.deferStart) {
      await new Promise<void>((resolve) => {
        this.startResolve = resolve;
      });
    }
    this.started = true;
    return this.readyValue;
  }

  releaseStart(): void {
    this.startResolve?.();
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
  }

  /** Phase 6E.3 — capture runtime commands (`set_threshold` etc.). */
  sentCommands: Array<{ readonly cmd: string; readonly value?: number }> = [];
  /** When true, `send()` rejects (dead/closed stdin) — best-effort path. */
  failSend = false;
  async send(command: { readonly cmd: string; readonly value?: number }): Promise<void> {
    if (this.failSend) throw new VoiceBridgeError('stdin-closed', 'fake stdin closed');
    this.sentCommands.push(command);
  }

  getStderrTail(): string {
    return '';
  }

  /** Emit an event as the real bridge would (`event` fan-out channel). */
  emitEvent(e: VoiceBridgeEvent): void {
    this.emit('event', e);
  }

  /** Simulate an unexpected child exit. */
  emitExit(): void {
    this.emit('exit', { exitCode: 1, signal: null });
  }
}

/**
 * Drain the microtask queue + one macrotask hop. The controller's
 * `startSession` chains several awaits (the `bridge.start` promise →
 * `transition('listening')`), and `stopSession`/`routeFinal` fan more
 * microtasks. A single `setImmediate` is insufficient under vitest's
 * parallel-suite scheduling pressure (3K gotcha: "32 microtask drains +
 * 1 macrotask hop covers the longest state-transition chain").
 */
async function flush(): Promise<void> {
  for (let i = 0; i < 32; i += 1) await Promise.resolve();
  await new Promise((r) => setImmediate(r));
}

/**
 * Poll the controller's status until it reaches `want` (or time out).
 * Used after operations whose terminal state lands across a variable
 * number of awaits — more robust than a fixed `flush()` count under
 * parallel-suite scheduling pressure.
 */
async function waitForStatus(
  controller: VoiceController,
  want: VoiceSnapshot['status'],
): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (controller.getSnapshot().status === want) return;
    await flush();
  }
}

function makeController(opts?: {
  autoSend?: boolean;
}): { controller: VoiceController; bridge: FakeBridge } {
  const bridge = new FakeBridge();
  const controller = new VoiceController({
    autoSend: opts?.autoSend ?? false,
    bridgeFactory: () => bridge as unknown as VoiceBridge,
    homeDir: '/tmp/voice-controller-test-home',
  });
  return { controller, bridge };
}

const FINAL = (text: string): VoiceBridgeEvent => ({
  type: 'final',
  seq: 1,
  text,
  tMs: 1000,
  durationMs: 800,
});

describe('VoiceController (summon)', () => {
  it('starts off; toggle → starting → listening on ready', async () => {
    const { controller, bridge } = makeController();
    expect(controller.getSnapshot().status).toBe('off');
    expect(controller.getSnapshot().mode).toBe('summon');

    controller.toggle();
    // start() is async; before it resolves the status is 'starting'.
    expect(controller.getSnapshot().status).toBe('starting');
    expect(controller.getSnapshot().isListening).toBe(true);

    await flush();
    expect(bridge.startCalls).toBe(1);
    expect(controller.getSnapshot().status).toBe('listening');
    await controller.shutdown();
  });

  it('passes mic + sttEnabled + vocab paths to bridge.start', async () => {
    const { controller, bridge } = makeController();
    controller.toggle();
    await flush();
    const opts = bridge.startOpts as { inputMode: string; sttEnabled: boolean; sttVocabPaths: unknown };
    expect(opts.inputMode).toBe('mic');
    expect(opts.sttEnabled).toBe(true);
    expect(Array.isArray(opts.sttVocabPaths)).toBe(true);
    await controller.shutdown();
  });

  it('review mode: final injects to input bar, stays listening', async () => {
    const { controller, bridge } = makeController({ autoSend: false });
    const inject = vi.fn();
    const send = vi.fn(() => ({ ok: true as const }));
    controller.setInjectToInput(inject);
    controller.setSendToMaestro(send);

    controller.toggle();
    await flush();
    bridge.emitEvent(FINAL('refactor the auth module'));

    expect(inject).toHaveBeenCalledWith('refactor the auth module');
    expect(send).not.toHaveBeenCalled();
    // Session stays open for multi-final dictation.
    expect(controller.getSnapshot().status).toBe('listening');
    expect(bridge.stopCalls).toBe(0);
    await controller.shutdown();
  });

  it('review mode: multiple finals all inject, session stays open', async () => {
    const { controller, bridge } = makeController({ autoSend: false });
    const inject = vi.fn();
    controller.setInjectToInput(inject);
    controller.toggle();
    await flush();
    bridge.emitEvent(FINAL('one'));
    bridge.emitEvent(FINAL('two'));
    bridge.emitEvent(FINAL('three'));
    expect(inject.mock.calls.map((c) => c[0])).toEqual(['one', 'two', 'three']);
    expect(controller.getSnapshot().status).toBe('listening');
    await controller.shutdown();
  });

  it('auto-send: final sends to Maestro then ends the session', async () => {
    const { controller, bridge } = makeController({ autoSend: true });
    const inject = vi.fn();
    const send = vi.fn(() => ({ ok: true as const }));
    controller.setInjectToInput(inject);
    controller.setSendToMaestro(send);

    controller.toggle();
    await flush();
    bridge.emitEvent(FINAL('run the tests'));
    expect(send).toHaveBeenCalledWith('run the tests');
    expect(inject).not.toHaveBeenCalled();

    // Session ends: bridge stopped, status returns to off.
    await waitForStatus(controller, 'off');
    expect(bridge.stopCalls).toBeGreaterThanOrEqual(1);
    expect(controller.getSnapshot().status).toBe('off');
    await controller.shutdown();
  });

  it('empty / whitespace-only final is dropped (no inject, no send)', async () => {
    const { controller, bridge } = makeController({ autoSend: false });
    const inject = vi.fn();
    const send = vi.fn(() => ({ ok: true as const }));
    controller.setInjectToInput(inject);
    controller.setSendToMaestro(send);
    controller.toggle();
    await flush();
    bridge.emitEvent(FINAL('   '));
    bridge.emitEvent({ type: 'final', seq: 2, text: '', tMs: 2000, durationMs: 100 });
    expect(inject).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(controller.getSnapshot().status).toBe('listening');
    await controller.shutdown();
  });

  it('speech_start moves listening → transcribing', async () => {
    const { controller, bridge } = makeController();
    controller.toggle();
    await flush();
    expect(controller.getSnapshot().status).toBe('listening');
    bridge.emitEvent({ type: 'speech_start', tMs: 200 });
    expect(controller.getSnapshot().status).toBe('transcribing');
    await controller.shutdown();
  });

  it('toggle again → stopping → off + bridge.stop called', async () => {
    const { controller, bridge } = makeController();
    controller.toggle();
    await waitForStatus(controller, 'listening');
    expect(controller.getSnapshot().status).toBe('listening');

    controller.toggle();
    // stopSession sets 'stopping' synchronously, then awaits stop().
    expect(controller.getSnapshot().status).toBe('stopping');
    await waitForStatus(controller, 'off');
    expect(bridge.stopCalls).toBe(1);
    expect(controller.getSnapshot().status).toBe('off');
  });

  it('unexpected bridge exit → error state', async () => {
    const { controller, bridge } = makeController();
    controller.toggle();
    await waitForStatus(controller, 'listening');
    expect(controller.getSnapshot().status).toBe('listening');
    bridge.emitExit();
    expect(controller.getSnapshot().status).toBe('error');
    expect(controller.getSnapshot().lastError).toMatch(/exited unexpectedly/);
    await controller.shutdown();
  });

  it('start failure → error state, no leaked handle', async () => {
    const { controller, bridge } = makeController();
    bridge.failStart = true;
    controller.toggle();
    await flush();
    expect(controller.getSnapshot().status).toBe('error');
    expect(controller.getSnapshot().lastError).toMatch(/ready-timeout/);
    // A subsequent toggle retries from error.
    bridge.failStart = false;
    controller.toggle();
    await flush();
    expect(controller.getSnapshot().status).toBe('listening');
    await controller.shutdown();
  });

  it('error event (diagnostic) does NOT tear the session down', async () => {
    const { controller, bridge } = makeController();
    controller.toggle();
    await flush();
    bridge.emitEvent({ type: 'error', code: 'malformed-json', message: 'oops' });
    // Stays listening; lastError surfaced but status unchanged.
    expect(controller.getSnapshot().status).toBe('listening');
    expect(controller.getSnapshot().lastError).toMatch(/malformed-json/);
    await controller.shutdown();
  });

  it('shutdown() calls bridge.stop and goes off (idempotent)', async () => {
    const { controller, bridge } = makeController();
    controller.toggle();
    await waitForStatus(controller, 'listening');
    await controller.shutdown();
    expect(bridge.stopCalls).toBeGreaterThanOrEqual(1);
    expect(controller.getSnapshot().status).toBe('off');
    // Second shutdown is a no-op.
    const calls = bridge.stopCalls;
    await controller.shutdown();
    expect(bridge.stopCalls).toBe(calls);
  });

  it('snapshot identity is stable across no-op events', async () => {
    const { controller, bridge } = makeController();
    controller.toggle();
    await waitForStatus(controller, 'listening');
    const snapA = controller.getSnapshot();
    // speech_end / partial are no-ops in the summon path.
    bridge.emitEvent({ type: 'speech_end', tMs: 100, durationMs: 50 });
    bridge.emitEvent({ type: 'partial', seq: 1, text: 'hi', tMs: 60 });
    const snapB = controller.getSnapshot();
    expect(snapB).toBe(snapA);
    await controller.shutdown();
  });

  it('subscribe fires on real transition, unsubscribe stops it', async () => {
    const { controller } = makeController();
    const listener = vi.fn();
    const unsub = controller.subscribe(listener);
    controller.toggle();
    await flush();
    expect(listener).toHaveBeenCalled();
    const count = listener.mock.calls.length;
    unsub();
    controller.toggle();
    await flush();
    // No further notifications after unsubscribe.
    expect(listener.mock.calls.length).toBe(count);
    await controller.shutdown();
  });

  it('rapid double-toggle while starting is a no-op (no double start)', async () => {
    const { controller, bridge } = makeController();
    bridge.deferStart = true;
    controller.toggle(); // -> starting (parked in start())
    controller.toggle(); // ignored while starting
    expect(controller.getSnapshot().status).toBe('starting');
    bridge.releaseStart();
    await flush();
    expect(bridge.startCalls).toBe(1);
    expect(controller.getSnapshot().status).toBe('listening');
    await controller.shutdown();
  });

  // ---- C2: final racing the late-bind drops the transcript ----------------

  it('review: final BEFORE binding is buffered, then flushed exactly once on bind', async () => {
    const { controller, bridge } = makeController({ autoSend: false });
    // Bind NOTHING yet — simulate a fast `final` racing the useVoice mount
    // effect that late-binds setInjectToInput.
    controller.toggle();
    await flush();
    expect(controller.getSnapshot().status).toBe('listening');

    bridge.emitEvent(FINAL('refactor the auth module'));
    // Nothing bound → must NOT be silently dropped; session stays open.
    expect(controller.getSnapshot().status).toBe('listening');

    const inject = vi.fn();
    controller.setInjectToInput(inject);
    // Binding flushes the buffered final through the SAME routing logic.
    expect(inject).toHaveBeenCalledTimes(1);
    expect(inject).toHaveBeenCalledWith('refactor the auth module');
    // Idempotent: re-binding does not replay (buffer was cleared).
    controller.setInjectToInput(inject);
    expect(inject).toHaveBeenCalledTimes(1);
    await controller.shutdown();
  });

  it('auto-send: final BEFORE binding is buffered, then sent + ends session on bind', async () => {
    const { controller, bridge } = makeController({ autoSend: true });
    controller.toggle();
    await flush();
    expect(controller.getSnapshot().status).toBe('listening');

    bridge.emitEvent(FINAL('run the tests'));
    // Auto-send needs sendToMaestro; not bound yet → buffered, session open.
    expect(controller.getSnapshot().status).toBe('listening');
    expect(bridge.stopCalls).toBe(0);

    const send = vi.fn(() => ({ ok: true as const }));
    controller.setSendToMaestro(send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('run the tests');
    // Auto-send ends the session after routing.
    await waitForStatus(controller, 'off');
    expect(bridge.stopCalls).toBeGreaterThanOrEqual(1);
    await controller.shutdown();
  });

  it('buffered finals are dropped on session end (no leak into next session)', async () => {
    const { controller, bridge } = makeController({ autoSend: false });
    controller.toggle();
    await flush();
    bridge.emitEvent(FINAL('stale utterance'));
    // End the session WITHOUT ever binding the inject callback.
    controller.toggle(); // -> stopping -> off
    await waitForStatus(controller, 'off');

    // New session + bind: the stale final must NOT replay.
    const inject = vi.fn();
    controller.setInjectToInput(inject);
    expect(inject).not.toHaveBeenCalled();
    controller.toggle();
    await waitForStatus(controller, 'listening');
    expect(inject).not.toHaveBeenCalled();
    await controller.shutdown();
  });

  // ---- M1: error is restartable via toggle --------------------------------

  it('error from unexpected exit → toggle restarts the session', async () => {
    const { controller, bridge } = makeController();
    controller.toggle();
    await waitForStatus(controller, 'listening');
    bridge.emitExit();
    expect(controller.getSnapshot().status).toBe('error');

    // A toggle from `error` must re-start (not brick voice for the session).
    controller.toggle();
    expect(controller.getSnapshot().status).toBe('starting');
    await waitForStatus(controller, 'listening');
    expect(controller.getSnapshot().status).toBe('listening');
    await controller.shutdown();
  });

  it('error lastError carries an actionable install hint for ready-timeout', async () => {
    const { controller, bridge } = makeController();
    bridge.failStart = true; // throws VoiceBridgeError('ready-timeout', ...)
    controller.toggle();
    await flush();
    expect(controller.getSnapshot().status).toBe('error');
    expect(controller.getSnapshot().lastError).toMatch(/ready-timeout/);
    expect(controller.getSnapshot().lastError).toMatch(/symphony voice install/);
    await controller.shutdown();
  });

  // ---- M2: shutdown during `starting` must not orphan the bridge ----------

  it('shutdown() while starting tears the bridge down (no orphan child)', async () => {
    const { controller, bridge } = makeController();
    bridge.deferStart = true;
    controller.toggle(); // -> starting, parked inside bridge.start()
    expect(controller.getSnapshot().status).toBe('starting');

    // Dispose while start() is still pending.
    const shutdownPromise = controller.shutdown();
    // The deferred start now resolves AFTER disposal.
    bridge.releaseStart();
    await shutdownPromise;
    await flush();

    // The bridge that resolved post-disposal must have been stopped, and
    // the controller must be off with no lingering handle.
    expect(bridge.stopCalls).toBeGreaterThanOrEqual(1);
    expect(controller.getSnapshot().status).toBe('off');
    // Idempotent second shutdown.
    const calls = bridge.stopCalls;
    await controller.shutdown();
    expect(bridge.stopCalls).toBe(calls);
  });
});

describe('VoiceController threshold setters (6E.3)', () => {
  it('setVadThreshold sends {cmd:set_threshold} to a live bridge', async () => {
    const { controller, bridge } = makeController();
    controller.toggle(); // → listening
    await flush();
    await controller.setVadThreshold(0.7);
    expect(bridge.sentCommands).toContainEqual({ cmd: 'set_threshold', value: 0.7 });
    await controller.shutdown();
  });

  it('setWakeThreshold sends {cmd:set_wake_threshold} — separate knob', async () => {
    const { controller, bridge } = makeController();
    controller.toggle();
    await flush();
    await controller.setWakeThreshold(0.65);
    expect(bridge.sentCommands).toContainEqual({ cmd: 'set_wake_threshold', value: 0.65 });
    // VAD command not sent — distinct knobs (6C audit-M2).
    expect(bridge.sentCommands.some((c) => c.cmd === 'set_threshold')).toBe(false);
    await controller.shutdown();
  });

  it('clamps the value into [0,1] before sending', async () => {
    const { controller, bridge } = makeController();
    controller.toggle();
    await flush();
    await controller.setVadThreshold(2);
    await controller.setVadThreshold(-1);
    expect(bridge.sentCommands).toContainEqual({ cmd: 'set_threshold', value: 1 });
    expect(bridge.sentCommands).toContainEqual({ cmd: 'set_threshold', value: 0 });
    await controller.shutdown();
  });

  it('with no live bridge: no throw, value applies at the next spawn', async () => {
    const bridge = new FakeBridge();
    const controller = new VoiceController({
      bridgeFactory: () => bridge as unknown as VoiceBridge,
      homeDir: '/tmp/voice-controller-test-home',
    });
    // Bridge is OFF (summon mode idle) — set before any session.
    await controller.setVadThreshold(0.8);
    expect(bridge.sentCommands).toHaveLength(0); // nothing sent yet
    // Now start a session — buildStartOptions must carry the stored value.
    controller.toggle();
    await flush();
    const opts = bridge.startOpts as { vadThreshold?: number };
    expect(opts.vadThreshold).toBe(0.8);
    await controller.shutdown();
  });

  it('constructor vadThreshold option is passed to bridge.start (dead-field fix)', async () => {
    const bridge = new FakeBridge();
    const controller = new VoiceController({
      vadThreshold: 0.42,
      bridgeFactory: () => bridge as unknown as VoiceBridge,
      homeDir: '/tmp/voice-controller-test-home',
    });
    controller.toggle();
    await flush();
    const opts = bridge.startOpts as { vadThreshold?: number };
    expect(opts.vadThreshold).toBe(0.42);
    await controller.shutdown();
  });

  it('best-effort: a failing bridge.send never throws out of the setter', async () => {
    const { controller, bridge } = makeController();
    controller.toggle();
    await flush();
    bridge.failSend = true;
    // Must resolve, not reject.
    await expect(controller.setVadThreshold(0.6)).resolves.toBeUndefined();
    await controller.shutdown();
  });

  it('after shutdown the setter is an inert no-op', async () => {
    const { controller, bridge } = makeController();
    controller.toggle();
    await flush();
    await controller.shutdown();
    const before = bridge.sentCommands.length;
    await controller.setVadThreshold(0.9);
    expect(bridge.sentCommands.length).toBe(before);
  });
});
