/**
 * Instrument-name allocation for active workers (Phase 3C).
 *
 * Plan rule: each worker gets an orchestral instrument instead of an
 * opaque id. Names are unique across all CURRENTLY-active workers.
 * When a worker drops out (terminal + reaped), its name returns to the
 * pool. Names are NOT persisted — they are a TUI affordance keyed to
 * the live id set, not a stable identifier.
 *
 * Allocation is deterministic so the same input → same map. The pool
 * size is 15 (PLAN.md:1074); beyond that we fall back to `Worker-N`
 * where N is the 1-indexed overflow ordinal. Pool exhaustion in
 * practice means >15 simultaneously-tracked workers — far past
 * Symphony's `max concurrent workers` default of 4.
 */

export const INSTRUMENT_POOL: readonly string[] = [
  'Violin',
  'Cello',
  'Viola',
  'Flute',
  'Oboe',
  'Clarinet',
  'Bassoon',
  'Horn',
  'Trumpet',
  'Harp',
  'Timpani',
  'Piano',
  'Bass',
  'Piccolo',
  'Tuba',
];

/**
 * Assign an instrument name to every id in `workerIds`, preserving names
 * already assigned in `previous` so a stable worker keeps its label
 * across re-renders. New ids fill the lowest free pool slot in id-order.
 *
 * Returns a fresh `Map<string,string>` keyed by id; callers can read
 * `result.get(workerId) ?? <fallback>` safely (fallback never triggers
 * for ids passed in).
 */
export function allocateInstruments(
  workerIds: readonly string[],
  previous: ReadonlyMap<string, string>,
): ReadonlyMap<string, string> {
  const next = new Map<string, string>();
  const taken = new Set<string>();
  const newIds: string[] = [];

  for (const id of workerIds) {
    const kept = previous.get(id);
    if (kept !== undefined) {
      next.set(id, kept);
      taken.add(kept);
    } else {
      newIds.push(id);
    }
  }

  let overflow = 1;
  for (const id of newIds) {
    const slot = INSTRUMENT_POOL.find((name) => !taken.has(name));
    if (slot !== undefined) {
      next.set(id, slot);
      taken.add(slot);
      continue;
    }
    let fallback = `Worker-${overflow}`;
    while (taken.has(fallback)) {
      overflow += 1;
      fallback = `Worker-${overflow}`;
    }
    next.set(id, fallback);
    taken.add(fallback);
    overflow += 1;
  }

  return next;
}
