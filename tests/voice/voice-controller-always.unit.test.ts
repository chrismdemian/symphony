import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  VoiceController,
  type VoiceControllerOptions,
} from '../../src/voice/voice-controller.js';
import { VoiceBridge } from '../../src/voice/bridge.js';
import type { VoiceBridgeEvent } from '../../src/voice/types.js';
import {
  createMemoryTranscriptStore,
  type TranscriptStore,
} from '../../src/state/transcript-store.js';

/**
 * Phase 6E.2 — VoiceController ALWAYS-mode unit tests. A fake bridge +
 * in-memory transcript store drive the always-capture state machine: the
 * bridge self-starts at construction, ambient finals append to the buffer
 * (never routed), and a wake-word / Ctrl+G summon gates the next final to
 * Maestro with a `<voice-context>` block. Covers the design-review
 * race-fixes (summon-timeout vs final-in-flight, tMs gate, setMode
 * teardown, snapshot identity).
 */

class FakeBridge extends EventEmitter {
  startCalls = 0;
  stopCalls = 0;
  startOpts: Array<Record<string, unknown>> = [];
  startErr: Error | undefined;
  stderrTail = '';

  async start(opts: Record<string, unknown>): Promise<{ type: 'ready' }> {
    this.startCalls += 1;
    this.startOpts.push(opts);
    if (this.startErr !== undefined) throw this.startErr;
    return { type: 'ready' } as const;
  }

  async stop(_opts?: unknown): Promise<void> {
    this.stopCalls += 1;
    this.emit('exit', { exitCode: 0, signal: null });
  }

  getStderrTail(): string {
    return this.stderrTail;
  }

  fire(e: VoiceBridgeEvent): void {
    this.emit('event', e);
  }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let active: VoiceController | undefined;

afterEach(async () => {
  if (active !== undefined) {
    await active.shutdown();
    active = undefined;
  }
});

function makeAlways(over: Partial<VoiceControllerOptions> = {}): {
  controller: VoiceController;
  bridge: FakeBridge;
  store: TranscriptStore;
  closeSpy: ReturnType<typeof vi.fn>;
} {
  const bridge = new FakeBridge();
  const store = createMemoryTranscriptStore();
  const closeSpy = vi.fn();
  const controller = new VoiceController({
    mode: 'always',
    summonTimeoutMs: 50,
    bridgeFactory: () => bridge as unknown as VoiceBridge,
    storeFactory: () => ({ store, close: closeSpy }),
    ...over,
  });
  active = controller;
  return { controller, bridge, store, closeSpy };
}

describe('VoiceController (always mode)', () => {
  it('self-starts the bridge at construction → listening + alwaysActive', async () => {
    const { controller, bridge } = makeAlways();
    expect(controller.getSnapshot().status).toBe('starting');
    await tick();
    const snap = controller.getSnapshot();
    expect(snap.status).toBe('listening');
    expect(snap.mode).toBe('always');
    expect(snap.alwaysActive).toBe(true);
    expect(bridge.startCalls).toBe(1);
  });

  it('ambient final appends to the buffer and is NOT routed', async () => {
    const { controller, bridge, store } = makeAlways({ autoSend: true });
    const sent: Array<[string, string | undefined]> = [];
    controller.setSendToMaestro((t, c) => {
      sent.push([t, c]);
      return { ok: true };
    });
    await tick();
    bridge.fire({ type: 'speech_start', tMs: 10 });
    bridge.fire({ type: 'final', seq: 1, text: 'the parser drops tokens', tMs: 20, durationMs: 10 });
    expect(sent).toEqual([]);
    const rows = store.list({ kinds: ['raw'] });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text).toBe('the parser drops tokens');
    expect(rows[0]!.source).toBe('vad');
    expect(controller.getSnapshot().status).toBe('listening');
  });

  it('wake-word arms a summon; the next final routes to Maestro with context', async () => {
    const { controller, bridge, store } = makeAlways({ autoSend: true });
    const sent: Array<[string, string | undefined]> = [];
    controller.setSendToMaestro((t, c) => {
      sent.push([t, c]);
      return { ok: true };
    });
    await tick();
    // Ambient context first.
    bridge.fire({ type: 'speech_start', tMs: 10 });
    bridge.fire({ type: 'final', seq: 1, text: 'the parser drops tokens', tMs: 20, durationMs: 10 });
    // Wake-word arms.
    bridge.fire({ type: 'wake_word', model: 'hey-symphony', score: 0.9, tMs: 25 });
    expect(controller.getSnapshot().summoned).toBe(true);
    // Summon utterance.
    bridge.fire({ type: 'speech_start', tMs: 30 });
    bridge.fire({ type: 'final', seq: 1, text: 'fix it', tMs: 40, durationMs: 10 });
    expect(sent).toEqual([['fix it', 'the parser drops tokens']]);
    // The summon utterance is also persisted (source 'wake').
    const wakeRows = store.list({ kinds: ['raw'] }).filter((r) => r.source === 'wake');
    expect(wakeRows.map((r) => r.text)).toEqual(['fix it']);
    // Disarmed after routing.
    expect(controller.getSnapshot().summoned).toBe(false);
  });

  it('Ctrl+G (toggle) arms a summon when the bridge is live', async () => {
    const { controller, bridge } = makeAlways({ autoSend: true });
    const sent: string[] = [];
    controller.setSendToMaestro((t) => {
      sent.push(t);
      return { ok: true };
    });
    await tick();
    bridge.fire({ type: 'speech_start', tMs: 100 });
    bridge.fire({ type: 'final', seq: 1, text: 'ambient', tMs: 110, durationMs: 10 });
    controller.toggle(); // armedAtMs = lastSeenTMs = 110
    expect(controller.getSnapshot().summoned).toBe(true);
    bridge.fire({ type: 'speech_start', tMs: 120 });
    bridge.fire({ type: 'final', seq: 1, text: 'do the thing', tMs: 130, durationMs: 10 });
    expect(sent).toEqual(['do the thing']);
  });

  it('gate: a final whose tMs < armedAtMs routes ambient, not summon', async () => {
    const { controller, bridge, store } = makeAlways({ autoSend: true });
    const sent: string[] = [];
    controller.setSendToMaestro((t) => {
      sent.push(t);
      return { ok: true };
    });
    await tick();
    bridge.fire({ type: 'wake_word', model: 'hey-symphony', score: 0.9, tMs: 100 });
    // An out-of-order final from a segment that ended BEFORE the arm.
    bridge.fire({ type: 'final', seq: 1, text: 'stale ambient', tMs: 50, durationMs: 10 });
    expect(sent).toEqual([]);
    expect(store.list({ kinds: ['raw'] }).map((r) => r.text)).toContain('stale ambient');
    // Still armed (the stale final didn't consume the summon).
    expect(controller.getSnapshot().summoned).toBe(true);
  });

  it('empty summon final keeps the summon armed', async () => {
    const { controller, bridge } = makeAlways({ autoSend: true });
    controller.setSendToMaestro(() => ({ ok: true }));
    await tick();
    bridge.fire({ type: 'wake_word', model: 'hey-symphony', score: 0.9, tMs: 10 });
    bridge.fire({ type: 'speech_start', tMs: 20 });
    bridge.fire({ type: 'final', seq: 1, text: '   ', tMs: 30, durationMs: 10 });
    expect(controller.getSnapshot().summoned).toBe(true);
  });

  it('summon-timeout disarms when no speech starts + fires a notice', async () => {
    const { controller, bridge } = makeAlways({ autoSend: true });
    const notices: string[] = [];
    controller.setNoticeSink((m) => notices.push(m));
    controller.setSendToMaestro(() => ({ ok: true }));
    await tick();
    controller.toggle(); // arm, summonTimeoutMs = 50
    expect(controller.getSnapshot().summoned).toBe(true);
    await wait(90);
    expect(controller.getSnapshot().summoned).toBe(false);
    expect(notices).toHaveLength(1);
  });

  it('summon survives a slow final that completes AFTER the timeout window', async () => {
    // The worst bug: a 7.5s command whose STT final lands at 8.3s must still
    // route. speech_start cancels the timer; the final routes even past 8s.
    const { controller, bridge } = makeAlways({ autoSend: true });
    const sent: string[] = [];
    controller.setSendToMaestro((t) => {
      sent.push(t);
      return { ok: true };
    });
    await tick();
    bridge.fire({ type: 'wake_word', model: 'hey-symphony', score: 0.9, tMs: 10 });
    bridge.fire({ type: 'speech_start', tMs: 20 }); // cancels the 50ms timer
    await wait(90); // timer would have fired — but it was cancelled
    expect(controller.getSnapshot().summoned).toBe(true);
    bridge.fire({ type: 'final', seq: 1, text: 'delayed command', tMs: 95, durationMs: 70 });
    expect(sent).toEqual(['delayed command']);
  });

  it('review mode summon injects text + carries the context block', async () => {
    const { controller, bridge, store } = makeAlways({ autoSend: false });
    const injected: Array<[string, string | undefined]> = [];
    controller.setInjectToInput((t, c) => injected.push([t, c]));
    await tick();
    bridge.fire({ type: 'speech_start', tMs: 10 });
    bridge.fire({ type: 'final', seq: 1, text: 'context line', tMs: 20, durationMs: 10 });
    bridge.fire({ type: 'wake_word', model: 'hey-symphony', score: 0.9, tMs: 25 });
    bridge.fire({ type: 'final', seq: 1, text: 'reviewed cmd', tMs: 40, durationMs: 10 });
    expect(injected).toEqual([['reviewed cmd', 'context line']]);
    expect(store).toBeDefined();
  });

  it('setMode always→summon tears down the bridge + closes the store', async () => {
    const { controller, bridge, closeSpy } = makeAlways();
    await tick();
    expect(bridge.startCalls).toBe(1);
    await controller.setMode('summon');
    expect(bridge.stopCalls).toBeGreaterThanOrEqual(1);
    expect(closeSpy).toHaveBeenCalledTimes(1);
    const snap = controller.getSnapshot();
    expect(snap.mode).toBe('summon');
    expect(snap.status).toBe('off');
    expect(snap.alwaysActive).toBe(false);
  });

  it('setMode summon→always opens the store + starts the continuous bridge', async () => {
    const bridges: FakeBridge[] = [];
    const store = createMemoryTranscriptStore();
    const closeSpy = vi.fn();
    const controller = new VoiceController({
      mode: 'summon',
      bridgeFactory: () => {
        const b = new FakeBridge();
        bridges.push(b);
        return b as unknown as VoiceBridge;
      },
      storeFactory: () => ({ store, close: closeSpy }),
    });
    active = controller;
    expect(controller.getSnapshot().status).toBe('off'); // summon: no auto-start
    await controller.setMode('always');
    await tick();
    const snap = controller.getSnapshot();
    expect(snap.mode).toBe('always');
    expect(snap.status).toBe('listening');
    expect(snap.alwaysActive).toBe(true);
    expect(bridges.at(-1)!.startCalls).toBe(1);
  });

  it('snapshot identity is stable; flips on a real summon change', async () => {
    const { controller, bridge } = makeAlways({ autoSend: true });
    controller.setSendToMaestro(() => ({ ok: true }));
    await tick();
    const s1 = controller.getSnapshot();
    expect(controller.getSnapshot()).toBe(s1); // stable across reads
    bridge.fire({ type: 'wake_word', model: 'hey-symphony', score: 0.9, tMs: 10 });
    const s2 = controller.getSnapshot();
    expect(s2).not.toBe(s1); // summoned flip → new identity
    expect(s2.summoned).toBe(true);
  });

  it('unexpected bridge exit flips alwaysActive false (App releases away)', async () => {
    const { controller, bridge } = makeAlways();
    await tick();
    expect(controller.getSnapshot().alwaysActive).toBe(true);
    // Simulate a crash: the child exits while we were listening.
    bridge.emit('exit', { exitCode: 1, signal: null });
    const snap = controller.getSnapshot();
    expect(snap.status).toBe('error');
    expect(snap.alwaysActive).toBe(false);
  });
});
