/**
 * Phase 3H.3 — Notifications dispatcher policy engine.
 *
 * This is the brain that decides WHEN to fire a toast — the platform-
 * specific spawn happens in `spawn-toast.ts` (injectable for tests).
 *
 * Policy: restraint by default. Per Chris's stated preference and
 * PLAN.md:74 ("never dribble per-worker updates"):
 *
 *   - `failed` / `crashed` / `timeout`  → fire individually (failures
 *                                         are user-blocking signal)
 *   - `completed`                       → DO NOT fire individually;
 *                                         count toward the all-done
 *                                         rollup
 *   - `killed`                          → no-op (user-initiated; not
 *                                         a notification-worthy event)
 *   - `ask_user` (urgency 'blocking')   → fire individually (user-
 *                                         blocking by definition)
 *
 * After each worker exit, if `totalRunning === 0` AND the running
 * tally has at least one terminal worker, emit ONE all-done summary
 * ("3 completed, 1 failed") and reset the tally. The "all-done"
 * notification is the only place individual completed workers
 * contribute signal.
 *
 * Away Mode (top-level config flag, future Phase 3M will add a
 * dedicated keybind): while on, suppress every individual fire AND
 * skip the all-done emit. The tally still accumulates so a single
 * digest fires on the true→false transition (the TUI's App.tsx
 * detects the edge and calls `notifications.flushAwayDigest()` over
 * RPC).
 *
 * Suppression matrix (hard short-circuit before any state mutation):
 *   - `!config.notifications.enabled`  — feature disabled
 *   - `!isTTY()`                       — non-TTY parent (CI, headless)
 *   - `isCI()`                         — explicit CI env
 *
 * Errors thrown by `spawnToast` are swallowed (caller `.catch`s, and
 * each path inside the dispatcher uses `void p.catch(...)` defensively).
 *
 * Reads config FRESH per call: 1 sync FS read on rare events
 * (worker-exit ≈ 1/min). Caching invites stale-flag bugs after
 * `setConfig`, and a watcher would be more code than the read it
 * replaces.
 */

import type { WorkerRecord } from '../orchestrator/worker-registry.js';
import type { QuestionRecord } from '../state/question-registry.js';
import type { WorkerStatus } from '../workers/types.js';
import type {
  DispatcherDeps,
  DispatcherHandle,
  FlushAwayDigestResult,
  ToastInput,
} from './types.js';

const BODY_MAX_CHARS = 120;

interface Tally {
  completed: number;
  failed: number;
  questions: number;
}

function emptyTally(): Tally {
  return { completed: 0, failed: 0, questions: 0 };
}

function tallyHasEntries(t: Tally): boolean {
  return t.completed > 0 || t.failed > 0 || t.questions > 0;
}

function pluralize(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

/**
 * Build the human-readable body for an all-done / digest emit. Omits
 * zero-count parts so a clean run reads "3 completed" rather than
 * "3 completed, 0 failed, 0 questions".
 */
export function formatTallyBody(t: Tally): string {
  const parts: string[] = [];
  if (t.completed > 0) parts.push(pluralize(t.completed, 'completed', 'completed'));
  if (t.failed > 0) parts.push(pluralize(t.failed, 'failed', 'failed'));
  if (t.questions > 0) parts.push(pluralize(t.questions, 'question', 'questions'));
  return parts.join(', ');
}

/** Truncate a body string to the spec's 120-char cap, with an ellipsis. */
export function truncateBody(input: string): string {
  if (input.length <= BODY_MAX_CHARS) return input;
  return `${input.slice(0, BODY_MAX_CHARS - 1)}…`;
}

/**
 * Map a worker terminal status to the human verb used in the toast
 * body. `killed` is filtered out by the caller (no-op); other terminal
 * statuses get their own verb. Non-terminal statuses should never
 * reach this map.
 */
function statusVerb(status: WorkerStatus): 'failed' | 'crashed' | 'timed out' | 'completed' | null {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'crashed':
      return 'crashed';
    case 'timeout':
      return 'timed out';
    default:
      return null;
  }
}

/**
 * Construct a notifications dispatcher. Returns a `DispatcherHandle`
 * the orchestrator wires into the worker lifecycle and question store.
 */
export function createNotificationDispatcher(deps: DispatcherDeps): DispatcherHandle {
  const isTTY = deps.isTTY ?? ((): boolean => process.stdout.isTTY === true);
  const isCI = deps.isCI ?? ((): boolean => Boolean(process.env.CI));
  const onError = deps.onError ?? ((): void => undefined);

  let tally: Tally = emptyTally();
  // Phase 3H.3 audit M2: short-circuit dispatcher entry points
  // post-shutdown. `close()` invokes `dispatcher.shutdown()` BEFORE
  // `workerLifecycle.shutdown()`, but the latter then kills running
  // workers — those workers' wireExit chains fire onWorkerStatusChange
  // which would re-enter `onWorkerExit` and potentially spawn orphan
  // toast processes after the orchestrator is otherwise tearing down.
  // SIGTERM-classified workers exit as `'killed'` (silent path), but a
  // worker that fails/crashes during the kill window would fall
  // through. The disposed flag catches that.
  let disposed = false;

  /**
   * Read config fresh and return a single decision object. Returns
   * `null` for hard-suppression (enabled=false / non-TTY / CI) — caller
   * must skip all state mutations in that case.
   */
  async function probe(): Promise<{ enabled: true; awayMode: boolean } | null> {
    let result;
    try {
      result = await deps.loadConfig();
    } catch (err) {
      // Config read failure is itself a no-op — fail closed (don't
      // notify). Surfaced via onError so test cases can assert it.
      onError(err instanceof Error ? err : new Error(String(err)));
      return null;
    }
    if (!result.config.notifications.enabled) return null;
    if (!isTTY()) return null;
    if (isCI()) return null;
    return { enabled: true, awayMode: result.config.awayMode };
  }

  function fire(toast: ToastInput): void {
    void deps
      .spawnToast({ ...toast, body: truncateBody(toast.body) })
      .catch((err: unknown) => {
        onError(err instanceof Error ? err : new Error(String(err)));
      });
  }

  function workerToast(record: WorkerRecord, verb: string): ToastInput {
    const projectName = deps.getProjectName(record.projectId ?? null);
    // Body uses `featureIntent` (the user-facing label per PLAN.md
    // rule #3 — "route by feature-intent, not worker-ID"). The TUI
    // owns the instrument-name allocation; instruments are not
    // server-side state, so they don't appear in toast bodies.
    const intent = record.featureIntent || record.taskDescription || record.id;
    return {
      title: `Symphony · ${projectName}`,
      body: `${verb}: ${intent}`,
    };
  }

  function questionToast(record: QuestionRecord): ToastInput {
    const projectName = deps.getProjectName(record.projectId ?? null);
    return {
      title: `Symphony · ${projectName}`,
      body: `needs input: ${record.question}`,
    };
  }

  function allDoneToast(snapshot: Tally): ToastInput {
    return {
      title: 'Symphony · all done',
      body: formatTallyBody(snapshot),
    };
  }

  function digestToast(snapshot: Tally): ToastInput {
    return {
      title: 'Symphony · digest',
      body: formatTallyBody(snapshot),
    };
  }

  function tryHandleWorkerExit(record: WorkerRecord, totalRunning: number): Promise<void> {
    return probe().then((decision) => {
      if (decision === null) return;
      const verb = statusVerb(record.status);
      if (verb === null) return; // 'killed' or non-terminal — silent

      // Update the running tally — both for all-done and for awayMode
      // digest. Failures and completions both contribute.
      if (verb === 'completed') {
        tally.completed += 1;
      } else {
        tally.failed += 1;
      }

      if (decision.awayMode) {
        // Buffered: do NOT fire individual, do NOT emit all-done.
        // The flush procedure drains tally on the true→false edge.
        return;
      }

      // Failures fire immediately; completions only contribute to the
      // all-done rollup.
      if (verb !== 'completed') {
        fire(workerToast(record, verb));
      }

      // All-done emit: only when the running count truly hit zero AND
      // we have something to report. The condition `tally has entries`
      // guards against a stray totalRunning=0 with no recent terminal
      // activity (which would be a no-op anyway, but the guard makes
      // intent explicit).
      if (totalRunning === 0 && tallyHasEntries(tally)) {
        const snapshot = { ...tally };
        tally = emptyTally();
        fire(allDoneToast(snapshot));
      }
    });
  }

  function tryHandleQuestion(record: QuestionRecord): Promise<void> {
    return probe().then((decision) => {
      if (decision === null) return;
      if (record.urgency !== 'blocking') return;
      tally.questions += 1;
      if (decision.awayMode) return;
      fire(questionToast(record));
    });
  }

  return {
    onWorkerExit(record, totalRunning): void {
      if (disposed) return;
      // Fire-and-forget: the lifecycle's wireExit must NOT await this
      // (its caller is the worker's exit promise chain). Errors here
      // are surfaced through the deps.onError sink.
      void tryHandleWorkerExit(record, totalRunning).catch((err: unknown) => {
        onError(err instanceof Error ? err : new Error(String(err)));
      });
    },

    onQuestion(record): void {
      if (disposed) return;
      void tryHandleQuestion(record).catch((err: unknown) => {
        onError(err instanceof Error ? err : new Error(String(err)));
      });
    },

    async flushAwayDigest(): Promise<FlushAwayDigestResult> {
      if (disposed) return { digest: null };
      // Snapshot + reset BEFORE awaiting the spawn so concurrent
      // `onWorkerExit` calls during the spawn don't race with the
      // counter reset.
      if (!tallyHasEntries(tally)) return { digest: null };
      const snapshot = { ...tally };
      tally = emptyTally();
      const body = formatTallyBody(snapshot);
      try {
        await deps.spawnToast({
          ...digestToast(snapshot),
          body: truncateBody(body),
        });
      } catch (err) {
        onError(err instanceof Error ? err : new Error(String(err)));
      }
      // Phase 3M — return the formatted body so the TUI can render an
      // in-chat "While you were away: …" system row. The toast above
      // serves the OS-level notification (often unseen if the user is
      // away from the terminal); the in-chat row is the on-return
      // summary they actually see.
      return { digest: body };
    },

    async shutdown(): Promise<void> {
      if (disposed) return;
      disposed = true;
      // Best-effort final flush. If awayMode was on at shutdown, the
      // user gets one digest before the orchestrator goes away.
      // Suppression-gated: a probe failure just returns silently.
      const decision = await probe();
      if (decision === null) {
        // Reset tally regardless — shutdown means we're losing state.
        tally = emptyTally();
        return;
      }
      if (tallyHasEntries(tally)) {
        const snapshot = { ...tally };
        tally = emptyTally();
        try {
          await deps.spawnToast({
            ...(decision.awayMode ? digestToast(snapshot) : allDoneToast(snapshot)),
            body: truncateBody(formatTallyBody(snapshot)),
          });
        } catch (err) {
          onError(err instanceof Error ? err : new Error(String(err)));
        }
      }
    },
  };
}
