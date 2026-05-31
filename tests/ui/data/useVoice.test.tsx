import React, { act } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { Text } from 'ink';

import { useVoice, type UseVoiceResult } from '../../../src/ui/data/useVoice.js';
import type {
  VoiceController,
  VoiceSnapshot,
  SendToMaestroFn,
  InjectToInputFn,
} from '../../../src/voice/voice-controller.js';

/**
 * Phase 6E.1 — useVoice routing tests.
 *
 * Mounts the hook in a probe component via `ink-testing-library` (the
 * 3E `useAnswerQuestion` test pattern — a `Probe` that captures the
 * hook result through a ref, plus a `setImmediate` flush to let React
 * commit). A FAKE controller captures the late-bound routing callbacks
 * (`setSendToMaestro` / `setInjectToInput`) so the test drives them
 * directly and asserts the hook's routing decisions.
 */

class FakeController {
  snapshot: VoiceSnapshot = { status: 'off', mode: 'summon', isListening: false };
  private listeners = new Set<() => void>();
  sendFn: SendToMaestroFn | undefined;
  injectFn: InjectToInputFn | undefined;
  toggleCalls = 0;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = (): VoiceSnapshot => this.snapshot;
  setSendToMaestro(fn: SendToMaestroFn): void {
    this.sendFn = fn;
  }
  setInjectToInput(fn: InjectToInputFn): void {
    this.injectFn = fn;
  }
  toggle(): void {
    this.toggleCalls += 1;
  }

  /** Mutate the snapshot + notify (mirrors the real controller's publish). */
  emit(next: VoiceSnapshot): void {
    this.snapshot = next;
    for (const l of this.listeners) l();
  }
}

interface ProbeApi {
  current: UseVoiceResult | null;
}

function Probe(props: {
  controller: VoiceController | null;
  sendUserMessage: (text: string) => { ok: true } | { ok: false; reason: string };
  showToast: (m: string, o?: unknown) => void;
  apiRef: ProbeApi;
}): React.JSX.Element {
  const r = useVoice({
    controller: props.controller,
    sendUserMessage: props.sendUserMessage,
    showToast: props.showToast as never,
  });
  props.apiRef.current = r;
  return <Text>status={r.status}</Text>;
}

async function flush(): Promise<void> {
  await new Promise((r) => setImmediate(r));
}

/**
 * Run a state-mutating callback inside React's `act()` so the resulting
 * `setState` commit flushes synchronously. Without this, the `setInjected`
 * commit inside `injectToInput` lands on a non-deterministic later tick
 * under the suite's parallel scheduler — the `act()` warning the harness
 * prints otherwise IS that race. Mirrors the React 19 testing contract.
 */
async function inAct(fn: () => void): Promise<void> {
  await act(async () => {
    fn();
    await flush();
  });
}

describe('useVoice routing', () => {
  it('returns inert no-op state when controller is null', async () => {
    const send = vi.fn(() => ({ ok: true as const }));
    const toast = vi.fn();
    const apiRef: ProbeApi = { current: null };
    render(<Probe controller={null} sendUserMessage={send} showToast={toast} apiRef={apiRef} />);
    await flush();
    expect(apiRef.current?.available).toBe(false);
    expect(apiRef.current?.status).toBe('off');
    expect(apiRef.current?.isListening).toBe(false);
    // toggle is a clean no-op (no controller to call).
    apiRef.current?.toggle();
  });

  it('reflects controller snapshot via useSyncExternalStore', async () => {
    const fake = new FakeController();
    const send = vi.fn(() => ({ ok: true as const }));
    const toast = vi.fn();
    const apiRef: ProbeApi = { current: null };
    render(
      <Probe
        controller={fake as unknown as VoiceController}
        sendUserMessage={send}
        showToast={toast}
        apiRef={apiRef}
      />,
    );
    await flush();
    expect(apiRef.current?.available).toBe(true);
    expect(apiRef.current?.status).toBe('off');
    await inAct(() => fake.emit({ status: 'listening', mode: 'summon', isListening: true }));
    expect(apiRef.current?.status).toBe('listening');
    expect(apiRef.current?.isListening).toBe(true);
  });

  it('autoSend send path: sendToMaestro routes to sendUserMessage', async () => {
    const fake = new FakeController();
    const send = vi.fn(() => ({ ok: true as const }));
    const toast = vi.fn();
    const apiRef: ProbeApi = { current: null };
    render(
      <Probe
        controller={fake as unknown as VoiceController}
        sendUserMessage={send}
        showToast={toast}
        apiRef={apiRef}
      />,
    );
    await flush();
    // The hook registered the routing callback on mount.
    expect(fake.sendFn).toBeDefined();
    const result = fake.sendFn!('book the flight');
    expect(send).toHaveBeenCalledWith('book the flight');
    expect(result).toEqual({ ok: true });
    expect(toast).not.toHaveBeenCalled();
  });

  it('turn_in_flight → inject fallback + toast', async () => {
    const fake = new FakeController();
    const send = vi.fn(() => ({ ok: false as const, reason: 'turn_in_flight' }));
    const toast = vi.fn();
    const apiRef: ProbeApi = { current: null };
    render(
      <Probe
        controller={fake as unknown as VoiceController}
        sendUserMessage={send}
        showToast={toast}
        apiRef={apiRef}
      />,
    );
    await flush();
    let result: { ok: true } | { ok: false; reason: string } | undefined;
    // `sendFn` routes synchronously AND fires `setInjected` (React state);
    // `act()` flushes the commit deterministically.
    await inAct(() => {
      result = fake.sendFn!('deploy to prod');
    });
    expect(send).toHaveBeenCalledWith('deploy to prod');
    expect(result).toEqual({ ok: false, reason: 'turn_in_flight' });
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast.mock.calls[0]?.[0]).toMatch(/Maestro busy/i);
    // Fallback (M3d): the SAME text landed in the input bar via a REAL
    // nonce bump (nonce > 0 proves injectToInput actually fired, not a
    // stale default value), so the transcript is never lost.
    expect(apiRef.current?.injected?.text).toBe('deploy to prod');
    expect(apiRef.current?.injected?.nonce).toBeGreaterThan(0);
  });

  it('review path: injectToInput bumps the injected nonce', async () => {
    const fake = new FakeController();
    const send = vi.fn(() => ({ ok: true as const }));
    const toast = vi.fn();
    const apiRef: ProbeApi = { current: null };
    render(
      <Probe
        controller={fake as unknown as VoiceController}
        sendUserMessage={send}
        showToast={toast}
        apiRef={apiRef}
      />,
    );
    await flush();
    expect(apiRef.current?.injected).toBeUndefined();
    await inAct(() => fake.injectFn!('first transcript'));
    const n1 = apiRef.current?.injected?.nonce ?? 0;
    expect(apiRef.current?.injected?.text).toBe('first transcript');
    expect(n1).toBeGreaterThan(0);
    await inAct(() => fake.injectFn!('second transcript'));
    expect(apiRef.current?.injected?.text).toBe('second transcript');
    expect(apiRef.current?.injected?.nonce).toBeGreaterThan(n1);
  });

  it('toggle delegates to controller.toggle', async () => {
    const fake = new FakeController();
    const send = vi.fn(() => ({ ok: true as const }));
    const toast = vi.fn();
    const apiRef: ProbeApi = { current: null };
    render(
      <Probe
        controller={fake as unknown as VoiceController}
        sendUserMessage={send}
        showToast={toast}
        apiRef={apiRef}
      />,
    );
    await flush();
    apiRef.current?.toggle();
    expect(fake.toggleCalls).toBe(1);
  });

  it('m2: surfaces lastError as a toast on the transition into error', async () => {
    const fake = new FakeController();
    const send = vi.fn(() => ({ ok: true as const }));
    const toast = vi.fn();
    const apiRef: ProbeApi = { current: null };
    render(
      <Probe
        controller={fake as unknown as VoiceController}
        sendUserMessage={send}
        showToast={toast}
        apiRef={apiRef}
      />,
    );
    await flush();
    expect(toast).not.toHaveBeenCalled();

    await inAct(() =>
      fake.emit({
        status: 'error',
        mode: 'summon',
        isListening: false,
        lastError: 'ready-timeout: bridge did not emit ready — run `symphony voice install`',
      }),
    );
    expect(apiRef.current?.lastError).toMatch(/symphony voice install/);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast.mock.calls[0]?.[0]).toMatch(/Voice error/i);
    expect(toast.mock.calls[0]?.[0]).toMatch(/symphony voice install/);
    expect(toast.mock.calls[0]?.[1]).toMatchObject({ tone: 'error' });

    // A subsequent non-error snapshot does NOT re-toast; returning to error
    // later fires exactly one more (transition-gated, not per-render).
    await inAct(() => fake.emit({ status: 'off', mode: 'summon', isListening: false }));
    expect(toast).toHaveBeenCalledTimes(1);
    await inAct(() =>
      fake.emit({
        status: 'error',
        mode: 'summon',
        isListening: false,
        lastError: 'spawn-failed: boom — run `symphony voice install`',
      }),
    );
    expect(toast).toHaveBeenCalledTimes(2);
  });
});
