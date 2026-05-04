import { useCallback, useEffect, useRef, useState } from 'react';
import type { QuestionSnapshot } from '../../state/question-registry.js';
import type { TuiRpc } from '../runtime/rpc.js';

/**
 * Phase 3F.3 — poll the answered question history.
 *
 * Sibling to `useQuestions` (`useQuestions.ts:30-78`); same `inFlightRef`
 * pattern, same fixed-cadence polling, but filters for `answered: true`.
 * Polls only while the history popup is open (`enabled: true`); otherwise
 * does nothing — answered questions never need background refresh.
 *
 * Sorted newest answered first (most recent at the top), since users
 * typically want "what did I JUST answer" rather than the full archive.
 */
export interface UseAnsweredQuestionsResult {
  readonly questions: readonly QuestionSnapshot[];
  readonly count: number;
  readonly loading: boolean;
  readonly error: Error | null;
  refresh(): void;
}

export interface UseAnsweredQuestionsOptions {
  readonly enabled?: boolean;
  readonly pollIntervalMs?: number;
}

const EMPTY: readonly QuestionSnapshot[] = Object.freeze([]);

function sortHistory(list: readonly QuestionSnapshot[]): QuestionSnapshot[] {
  // Newest answered first. `answeredAt` is set on the server when the
  // user submits; ISO timestamps sort lexicographically.
  const out = [...list];
  out.sort((a, b) => {
    const at = a.answeredAt ?? '';
    const bt = b.answeredAt ?? '';
    if (at > bt) return -1;
    if (at < bt) return 1;
    return 0;
  });
  return out;
}

export function useAnsweredQuestions(
  rpc: TuiRpc,
  options?: UseAnsweredQuestionsOptions,
): UseAnsweredQuestionsResult {
  const enabled = options?.enabled ?? true;
  const pollIntervalMs = options?.pollIntervalMs ?? 2000;
  const [questions, setQuestions] = useState<readonly QuestionSnapshot[]>(EMPTY);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<Error | null>(null);
  const [tick, setTick] = useState<number>(0);
  const inFlightRef = useRef(false);

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    if (!enabled) return;
    if (inFlightRef.current) return;
    let cancelled = false;
    inFlightRef.current = true;
    setLoading(true);
    rpc.call.questions
      .list({ answered: true })
      .then((list) => {
        if (cancelled) return;
        setQuestions(sortHistory(list));
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => {
        inFlightRef.current = false;
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [rpc, tick, enabled]);

  useEffect(() => {
    if (!enabled || pollIntervalMs <= 0) return;
    const handle = setInterval(() => setTick((n) => n + 1), pollIntervalMs);
    return () => {
      clearInterval(handle);
    };
  }, [pollIntervalMs, enabled]);

  return {
    questions,
    count: questions.length,
    loading,
    error,
    refresh,
  };
}
