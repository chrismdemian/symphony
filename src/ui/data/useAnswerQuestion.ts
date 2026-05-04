import { useCallback, useEffect, useRef, useState } from 'react';
import type { TuiRpc } from '../runtime/rpc.js';

/**
 * Phase 3E — submit-side state machine for `questions.answer`.
 *
 * Mirrors `WorkerPanel`'s fire-and-forget kill RPC pattern with the
 * `unmountedRef` guard (audit M1 from 3C) so a resolved promise from a
 * tear-down panel can't `setState` on a dead component.
 *
 * State:
 *   `idle`        — no submit in flight.
 *   `submitting`  — RPC dispatched; waiting for resolution.
 *   `error`       — last submit failed; `error.message` exposed.
 *
 * Successful submit clears state back to `idle`. The hook does NOT clear
 * the queue — the caller pops the popup / advances after `submit()`'s
 * promise resolves.
 */
export type AnswerSubmitState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'submitting'; readonly questionId: string }
  | { readonly kind: 'error'; readonly questionId: string; readonly message: string };

export interface UseAnswerQuestionResult {
  readonly state: AnswerSubmitState;
  /**
   * Dispatch `questions.answer`. Returns a promise that resolves with
   * `{ ok: true }` on success or `{ ok: false; message }` on failure.
   * Caller decides what to do next (advance, dismiss, retry).
   */
  submit(
    questionId: string,
    answer: string,
  ): Promise<{ ok: true } | { ok: false; message: string }>;
  /** Reset to idle. Use to dismiss a stale `error` after the user re-tries. */
  reset(): void;
}

export function useAnswerQuestion(rpc: TuiRpc): UseAnswerQuestionResult {
  const [state, setState] = useState<AnswerSubmitState>({ kind: 'idle' });
  const unmountedRef = useRef(false);

  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
    };
  }, []);

  const reset = useCallback(() => {
    if (unmountedRef.current) return;
    setState({ kind: 'idle' });
  }, []);

  const submit = useCallback(
    async (
      questionId: string,
      answer: string,
    ): Promise<{ ok: true } | { ok: false; message: string }> => {
      if (unmountedRef.current) return { ok: false, message: 'unmounted' };
      setState({ kind: 'submitting', questionId });
      try {
        await rpc.call.questions.answer({ id: questionId, answer });
        if (!unmountedRef.current) setState({ kind: 'idle' });
        return { ok: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!unmountedRef.current) {
          setState({ kind: 'error', questionId, message });
        }
        return { ok: false, message };
      }
    },
    [rpc],
  );

  return { state, submit, reset };
}
