import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { QuestionSnapshot } from '../../state/question-registry.js';
import type { TuiRpc } from '../runtime/rpc.js';

/**
 * Phase 3E — poll the unanswered question queue.
 *
 * Mirrors `useWorkers.ts` (`src/ui/data/useWorkers.ts:30-78`) including the
 * `inFlightRef` skip (audit M2 from 3C) — a slow RPC under fixed-cadence
 * polling otherwise stacks unbounded `questions.list` requests on the wire.
 *
 * Polling rather than a `questions.events` WS topic: 3E ships the user
 * surface for `ask_user`, and the queue rate is ≤ 1/min in practice. 1 s
 * is invisible. A subscription topic is logged as a follow-up.
 *
 * The hook returns `questions` already sorted: oldest blocking first, then
 * advisory, ties broken by `askedAt`. Counts are derived in the same pass
 * so the StatusBar Q-cell can color by both total and blocking count.
 */
export interface UseQuestionsResult {
  /** All unanswered questions, sorted oldest blocking → oldest advisory. */
  readonly questions: readonly QuestionSnapshot[];
  readonly count: number;
  readonly blockingCount: number;
  readonly loading: boolean;
  readonly error: Error | null;
  refresh(): void;
}

export interface UseQuestionsOptions {
  /** Background poll cadence in ms; <=0 disables. Default 1000. */
  readonly pollIntervalMs?: number;
}

const EMPTY: readonly QuestionSnapshot[] = Object.freeze([]);

function sortQueue(list: readonly QuestionSnapshot[]): QuestionSnapshot[] {
  // Blocking first; within urgency, oldest askedAt first. Stable enough —
  // ISO timestamps sort lexicographically.
  const out = [...list];
  out.sort((a, b) => {
    if (a.urgency !== b.urgency) {
      return a.urgency === 'blocking' ? -1 : 1;
    }
    if (a.askedAt < b.askedAt) return -1;
    if (a.askedAt > b.askedAt) return 1;
    return 0;
  });
  return out;
}

export function useQuestions(
  rpc: TuiRpc,
  options?: UseQuestionsOptions,
): UseQuestionsResult {
  const [questions, setQuestions] = useState<readonly QuestionSnapshot[]>(EMPTY);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<Error | null>(null);
  const [tick, setTick] = useState<number>(0);
  const pollIntervalMs = options?.pollIntervalMs ?? 1000;
  const inFlightRef = useRef(false);

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    if (inFlightRef.current) return;
    let cancelled = false;
    inFlightRef.current = true;
    setLoading(true);
    rpc.call.questions
      .list({ answered: false })
      .then((list) => {
        if (cancelled) return;
        setQuestions(sortQueue(list));
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
  }, [rpc, tick]);

  useEffect(() => {
    if (pollIntervalMs <= 0) return;
    const handle = setInterval(() => setTick((n) => n + 1), pollIntervalMs);
    return () => {
      clearInterval(handle);
    };
  }, [pollIntervalMs]);

  const counts = useMemo(() => {
    let blockingCount = 0;
    for (const q of questions) {
      if (q.urgency === 'blocking') blockingCount += 1;
    }
    return { count: questions.length, blockingCount };
  }, [questions]);

  return {
    questions,
    count: counts.count,
    blockingCount: counts.blockingCount,
    loading,
    error,
    refresh,
  };
}
