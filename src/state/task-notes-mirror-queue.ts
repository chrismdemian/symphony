/**
 * Phase 5C — per-task mirror serializer.
 *
 * `task-notes-mirror.ts` is pure-async fs work. When Maestro fires
 * several `task_notes(append)` calls back-to-back, each one spawns an
 * unawaited `mirrorTaskNotes(...)` promise — those promises race on
 * the same `tmp+rename` target file, and the last completion wins
 * regardless of which `notes` array it carries. Without ordering, the
 * disk file can lag behind SQL (or worse, reflect an intermediate
 * state).
 *
 * The fix: chain writes per `<projectPath>:<taskId>` key so a second
 * append waits for the first mirror to settle before its own
 * `mkdir → writeFile → rename`. The queue NEVER blocks the SQL write
 * path (`onNotesAppended` callers void the returned promise) — it
 * only orders the disk writes.
 *
 * The chain is unbounded but self-pruning: each enqueued promise's
 * `.finally` removes the slot when it's the current tail. Memory
 * pressure is `O(distinct tasks with appends in last few ms)`,
 * typically O(active workers).
 */
import { mirrorTaskNotes, type MirrorTaskNotesInput, type MirrorTaskNotesResult } from './task-notes-mirror.js';

export interface TaskNotesMirrorQueue {
  enqueue(input: MirrorTaskNotesInput): Promise<MirrorTaskNotesResult>;
  /** Test/inspection seam — exposes the live queue size. */
  size(): number;
}

export function createTaskNotesMirrorQueue(
  writer: (input: MirrorTaskNotesInput) => Promise<MirrorTaskNotesResult> = mirrorTaskNotes,
): TaskNotesMirrorQueue {
  const tails = new Map<string, Promise<MirrorTaskNotesResult>>();

  function keyOf(input: MirrorTaskNotesInput): string {
    return `${input.projectPath ?? ''}::${input.taskId}`;
  }

  function enqueue(input: MirrorTaskNotesInput): Promise<MirrorTaskNotesResult> {
    const key = keyOf(input);
    const prev = tails.get(key) ?? Promise.resolve<MirrorTaskNotesResult>({
      path: null,
      written: false,
      skipReason: 'no-project-path',
    });
    // `.then(() => writer(input))` ignores the prior result (we want
    // ordering, not chaining of result values) and ALWAYS attempts the
    // next write — even if a prior write failed, the current one
    // should still try with the latest notes array.
    const next = prev.then(
      () => writer(input),
      () => writer(input),
    );
    tails.set(key, next);
    // Self-prune: drop the tail slot when this promise resolves AND
    // we're still the head of the chain (a subsequent enqueue may
    // have overwritten us; in that case we leave the newer tail
    // alone). Identity check via `tails.get(key) === next`. The
    // `.catch` swallows the second observation of any rejection —
    // the caller's `await enqueue(...)` is the primary consumer and
    // their `.catch` handles it. Without this, Node fires an
    // unhandled-rejection warning on every failed write.
    next
      .finally(() => {
        if (tails.get(key) === next) tails.delete(key);
      })
      .catch(() => {
        // pruner is a passive observer — never propagate
      });
    return next;
  }

  function size(): number {
    return tails.size;
  }

  return { enqueue, size };
}
