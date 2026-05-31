import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import type {
  VoiceController,
  VoiceMode,
  VoiceSnapshot,
  VoiceStatus,
} from '../../voice/voice-controller.js';

/**
 * Phase 6E.1 — `useVoice` hook (React-side router for the summon path).
 *
 * Subscribes to the `VoiceController` via React 19's
 * `useSyncExternalStore(controller.subscribe, controller.getSnapshot)`
 * (NOT polling, NOT an EventEmitter→React bridge — the controller's
 * snapshot identity is stable between real transitions so the store
 * doesn't loop). When `controller` is null (voice disabled / non-TTY),
 * returns a frozen inert snapshot so the hook is a no-op.
 *
 * On mount it registers the real routing callbacks via
 * `controller.setSendToMaestro(...)` / `controller.setInjectToInput(...)`
 * (the controller is constructed in the launcher BEFORE the React tree
 * mounts — late-bind, mirroring the 2B.2 `setOnEvent` pattern):
 *   - sendToMaestro → `sendUserMessage(text)`. On
 *     `{ ok: false, reason: 'turn_in_flight' }` it FALLS BACK to
 *     injectToInput + a toast ("Maestro busy — transcript in the input
 *     bar") so the transcript is never lost.
 *   - injectToInput → bumps an `injected: { text, nonce }` state, which
 *     ChatPanel → InputBar consume via a nonce-guarded effect.
 *
 * NO awayMode — 6E.1 decouples Away Mode from summon mode (a 5-second
 * dictation isn't "away"). The auto-Away trigger, if any, lands in 6E.2.
 */

const INERT_SNAPSHOT: VoiceSnapshot = Object.freeze({
  status: 'off' as VoiceStatus,
  mode: 'summon' as VoiceMode,
  isListening: false,
});

export interface UseVoiceInput {
  /** The launcher-owned controller, or null when voice is disabled / non-TTY. */
  readonly controller: VoiceController | null;
  /** Maestro send seam — `useMaestroData().sendUserMessage`. */
  readonly sendUserMessage: (
    text: string,
  ) => { ok: true } | { ok: false; reason: string };
  /** Toast sink — `useToast().showToast`. */
  readonly showToast: (
    message: string,
    options?: { tone?: 'info' | 'success' | 'warning' | 'error'; ttlMs?: number },
  ) => void;
}

export interface UseVoiceResult {
  readonly status: VoiceStatus;
  readonly mode: VoiceMode;
  readonly isListening: boolean;
  /** Toggle the summon session (Ctrl+G). No-op when voice is unavailable. */
  readonly toggle: () => void;
  /** Nonce-guarded transcript injection for the input bar (review mode). */
  readonly injected: { readonly text: string; readonly nonce: number } | undefined;
  /** False when no controller is wired (voice disabled / non-TTY). */
  readonly available: boolean;
  /** Last error from the controller, if any (surfaced in the status chip). */
  readonly lastError: string | undefined;
}

export function useVoice(input: UseVoiceInput): UseVoiceResult {
  const { controller, sendUserMessage, showToast } = input;

  // Subscribe to the external store. When `controller` is null, both
  // subscribe + getSnapshot are stable no-ops that yield the frozen inert
  // snapshot — the hook is a clean no-op with no listeners attached.
  const subscribe = useCallback(
    (listener: () => void): (() => void) => {
      if (controller === null) return () => undefined;
      return controller.subscribe(listener);
    },
    [controller],
  );
  const getSnapshot = useCallback(
    (): VoiceSnapshot => (controller === null ? INERT_SNAPSHOT : controller.getSnapshot()),
    [controller],
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const [injected, setInjected] = useState<
    { readonly text: string; readonly nonce: number } | undefined
  >(undefined);
  const nonceRef = useRef(0);

  // unmountedRef guards the async-routed setState (matches the
  // useWorkers / useAnswerQuestion pattern). Reset on mount, set on unmount.
  const unmountedRef = useRef(false);
  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
    };
  }, []);

  // Inject a transcript into the input bar (review path + turn-in-flight
  // fallback). Bumps the nonce so InputBar's guarded effect appends exactly
  // once.
  const injectToInput = useCallback((text: string): void => {
    if (unmountedRef.current) return;
    nonceRef.current += 1;
    setInjected({ text, nonce: nonceRef.current });
  }, []);

  // Late-bind the routing callbacks onto the controller after mount. The
  // controller is constructed in the launcher process before the React
  // tree mounts (2B.2 setOnEvent precedent), so registration must happen
  // here rather than at construction.
  useEffect(() => {
    if (controller === null) return;
    controller.setInjectToInput(injectToInput);
    controller.setSendToMaestro((text) => {
      const result = sendUserMessage(text);
      if (result.ok) return result;
      if (result.reason === 'turn_in_flight') {
        // Don't lose the transcript — drop it into the input bar + toast.
        injectToInput(text);
        showToast('Maestro busy — transcript in the input bar.', {
          tone: 'warning',
          ttlMs: 4_000,
        });
      }
      return result;
    });
  }, [controller, sendUserMessage, showToast, injectToInput]);

  // Surface the controller's error state as a toast on the transition INTO
  // `error` (m2). The toast carries the controller's `lastError` — which
  // `formatBridgeFailure` has already enriched with an actionable hint
  // (e.g. "run `symphony voice install`" for a missing/broken venv) — so
  // the user knows the cause, not just that voice broke. Fires once per
  // transition (prevStatusRef gate), not every render while in error.
  const prevStatusRef = useRef<VoiceStatus>(snapshot.status);
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = snapshot.status;
    if (snapshot.status === 'error' && prev !== 'error') {
      const reason = snapshot.lastError ?? 'unknown error';
      showToast(`Voice error: ${reason}`, { tone: 'error', ttlMs: 6_000 });
    }
  }, [snapshot.status, snapshot.lastError, showToast]);

  const toggle = useCallback(() => {
    controller?.toggle();
  }, [controller]);

  return {
    status: snapshot.status,
    mode: snapshot.mode,
    isListening: snapshot.isListening,
    toggle,
    injected,
    available: controller !== null,
    lastError: snapshot.lastError,
  };
}
