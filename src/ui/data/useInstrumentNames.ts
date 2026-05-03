import { useMemo, useRef } from 'react';
import type { WorkerRecordSnapshot } from '../../orchestrator/worker-registry.js';
import { allocateInstruments } from './instruments.js';

/**
 * React hook that maps live worker ids → instrument names, keeping
 * assignments stable across re-renders. The cache lives in a `useRef`
 * so identity-changing renders (every poll tick) don't churn the map
 * — `useMemo` is keyed on the SET of ids, not the snapshot array, so
 * pure re-renders with the same ids reuse the cached result.
 */
export function useInstrumentNames(
  workers: readonly WorkerRecordSnapshot[],
): ReadonlyMap<string, string> {
  const previous = useRef<ReadonlyMap<string, string>>(new Map());
  // Sort to make the memo key insensitive to ordering changes (the
  // panel may reorder workers without registering a new set).
  const idsKey = useMemo(
    () =>
      workers
        .map((w) => w.id)
        .slice()
        .sort()
        .join('|'),
    [workers],
  );
  // Memo intentionally keyed on `idsKey` (sorted, joined ids) only —
  // the raw `workers` array reference changes every poll tick even
  // when the id set is unchanged, which would defeat the cache.
  return useMemo(() => {
    const next = allocateInstruments(
      workers.map((w) => w.id),
      previous.current,
    );
    previous.current = next;
    return next;
  }, [idsKey]);
}
