import type {
  QuestionRecord,
  QuestionStore,
} from '../state/question-registry.js';
import type { LoadResult } from '../utils/config.js';
import {
  performMergeAndCleanup,
  parseYesNo,
  resolveDefaultMergeTo,
  type AutoMergeGitOps,
  type PerformMergeSuccess,
  type WorktreeRemover,
} from './auto-merge-helper.js';
import type {
  AutoMergeBroker,
  AutoMergeDispatcherHandle,
  AutoMergeEvent,
} from './auto-merge-types.js';
import type { FinalizeRunResult } from './finalize-runner.js';
import type { FinalizeCallbackContext } from './tools/finalize.js';

/**
 * Phase 3O.1 — Auto-merge dispatcher.
 *
 * Wired between the finalize tool (`FinalizeDeps.onFinalize`) and the
 * question store (`QuestionStoreOptions.onQuestionAnswered`). Behavior
 * branches on `config.autoMerge` read fresh per finalize event:
 *
 *   - `'never'` → emit a `ready` event ("branch left for manual merge").
 *                 No question, no merge call.
 *   - `'auto'`  → invoke `performMergeAndCleanup` immediately. Emit
 *                 `merged` on success (with optional `cleanupWarning`)
 *                 or `failed` on git-ops error. Worktree left intact
 *                 on merge failure.
 *   - `'ask'`   → enqueue a y/n question via `questionStore.enqueue`;
 *                 record `{questionId → ctx}` in `pendingAsks`; emit
 *                 an `asked` event so the chat surfaces a heads-up
 *                 system row immediately. The user's answer (delivered
 *                 via `onQuestionAnswered`) is parsed via `parseYesNo`:
 *                 'y' → merge (same path as 'auto'); 'n' → emit
 *                 `declined`; unclear → emit `declined` with the raw
 *                 answer in `unclearAnswer` (fail-safe: irreversibility
 *                 outweighs UX, and the branch is preserved).
 *
 * Disposed flag (mirror 3H.3 audit M2): short-circuits all entry
 * points post-shutdown so late lifecycle exits during the SIGTERM
 * window can't spawn orphan merge processes. Shutdown awaits in-flight
 * merges before resolving.
 *
 * Maestro-already-merged short-circuit: `ctx.mergeToSpecified === true`
 * (i.e., Maestro called `finalize(merge_to: 'main')` at tier 3) skips
 * the dispatcher entirely — the user already confirmed the merge at
 * tier-3-prompt time.
 */

export interface AutoMergeDispatcherDeps {
  /**
   * Read the on-disk config fresh per finalize event. Returning a
   * `LoadResult` matches the notification dispatcher's shape so server.ts
   * can pass the same `loadConfig` wrapper.
   */
  readonly loadConfig: () => Promise<LoadResult>;
  readonly questionStore: QuestionStore;
  readonly broker: AutoMergeBroker;
  readonly gitOps: AutoMergeGitOps;
  readonly worktreeManager: WorktreeRemover;
  /**
   * Resolve display name for a project path. Mirrors the notification
   * dispatcher's resolver; server.ts wires it through projectStore.
   * Returns the basename (or `'(unknown)'`) when no project is registered.
   */
  readonly getProjectName: (projectPath: string) => string;
  /** Test seam — defaults to `Date.now`. */
  readonly now?: () => number;
  /** Sink for dispatcher errors. Defaults to no-op. */
  readonly onError?: (err: Error) => void;
}

interface PendingAsk {
  readonly workerId: string;
  readonly branch: string;
  readonly projectName: string;
  readonly projectPath: string;
  readonly worktreePath: string;
  readonly mergeTo: string;
}

export function createAutoMergeDispatcher(
  deps: AutoMergeDispatcherDeps,
): AutoMergeDispatcherHandle {
  const now = deps.now ?? Date.now;
  const onError = deps.onError ?? ((): void => undefined);
  let disposed = false;
  /**
   * Per-question context map. Key = questionId; value = the finalize
   * context captured when the question was enqueued. Cleared on
   * answer-routing (success path) and on dispatcher shutdown.
   */
  const pendingAsks = new Map<string, PendingAsk>();
  /**
   * In-flight merge promises — awaited on `shutdown()` so late finalize
   * callbacks (during the SIGTERM kill window) settle before the
   * server tears down further.
   */
  const inflight = new Set<Promise<void>>();

  function isoNow(): string {
    return new Date(now()).toISOString();
  }

  function emit(event: AutoMergeEvent): void {
    try {
      deps.broker.publish(event);
    } catch (err) {
      onError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  function buildAskedHeadline(
    projectName: string,
    branch: string,
    mergeTo: string,
  ): string {
    return `Worker on '${branch}' is ready. Merge into ${mergeTo}? (open question popup with Ctrl+Q · reply y / n)`;
  }

  function buildMergedHeadline(
    projectName: string,
    branch: string,
    mergeTo: string,
    mergeSha: string,
    cleanupWarning?: string,
  ): string {
    const sha7 = mergeSha.slice(0, 7);
    const tail = cleanupWarning !== undefined
      ? ` · cleanup warning: ${cleanupWarning}`
      : '';
    return `Merged '${branch}' into ${mergeTo} (${sha7})${tail}`;
  }

  function buildDeclinedHeadline(
    branch: string,
    unclear?: string,
  ): string {
    if (unclear !== undefined && unclear.length > 0) {
      return `Couldn't parse '${unclear}' as y/n — left '${branch}' for manual review`;
    }
    return `Left '${branch}' for manual review`;
  }

  function buildFailedHeadline(branch: string, mergeTo: string, reason: string): string {
    return `Merge of '${branch}' into ${mergeTo} failed: ${reason} · branch left for review`;
  }

  function buildReadyHeadline(branch: string): string {
    return `Worker on '${branch}' is ready for manual merge`;
  }

  /**
   * Trim a typed git-ops error message to a short reason suitable for
   * a chat system row. Strips repeated whitespace + truncates to 120
   * chars so the row stays readable.
   */
  function shortReason(err: Error): string {
    const msg = `${err.name}: ${err.message}`.replace(/\s+/g, ' ').trim();
    return msg.length > 120 ? `${msg.slice(0, 117)}…` : msg;
  }

  /**
   * Execute the merge + emit success/failure event. Adds the promise
   * to `inflight` so `shutdown()` can await. Errors are swallowed
   * (routed through emit + onError).
   */
  async function doMerge(ctx: PendingAsk): Promise<void> {
    const result = await performMergeAndCleanup(
      {
        worktreePath: ctx.worktreePath,
        repoPath: ctx.projectPath,
        sourceBranch: ctx.branch,
        mergeTo: ctx.mergeTo,
      },
      deps.gitOps,
      deps.worktreeManager,
    );

    if (!result.ok) {
      emit({
        kind: 'failed',
        workerId: ctx.workerId,
        branch: ctx.branch,
        projectName: ctx.projectName,
        mergeTo: ctx.mergeTo,
        headline: buildFailedHeadline(ctx.branch, ctx.mergeTo, shortReason(result.error)),
        reason: shortReason(result.error),
        ts: isoNow(),
      });
      return;
    }

    const merged = result as PerformMergeSuccess;
    const cleanupWarning =
      merged.cleanupError !== undefined
        ? shortReason(merged.cleanupError)
        : undefined;
    emit({
      kind: 'merged',
      workerId: ctx.workerId,
      branch: ctx.branch,
      projectName: ctx.projectName,
      mergeTo: ctx.mergeTo,
      headline: buildMergedHeadline(
        ctx.projectName,
        ctx.branch,
        ctx.mergeTo,
        merged.mergeSha,
        cleanupWarning,
      ),
      mergeSha: merged.mergeSha,
      ...(cleanupWarning !== undefined ? { cleanupWarning } : {}),
      ts: isoNow(),
    });
  }

  /**
   * Track a doMerge promise in `inflight` so `shutdown()` awaits it.
   * Errors inside the chain are caught + routed through onError; the
   * tracked promise itself resolves to void on completion (success or
   * caught failure).
   */
  function trackMerge(ctx: PendingAsk): void {
    const p = doMerge(ctx).catch((err: unknown) => {
      onError(err instanceof Error ? err : new Error(String(err)));
    });
    inflight.add(p);
    void p.finally(() => {
      inflight.delete(p);
    });
  }

  async function tryHandleFinalize(
    result: FinalizeRunResult,
    ctx: FinalizeCallbackContext,
  ): Promise<void> {
    // Entry-only disposed check: shifting to mid-chain checks would race
    // a sync `await shutdown()` after `onFinalize()` because shutdown
    // sets `disposed = true` BEFORE awaiting `inflight` — every awaitable
    // checkpoint inside would short-circuit. We commit once accepted;
    // shutdown awaits the full pipeline via the inflight set.
    if (!result.ok) return; // defensive — finalize tool also gates
    if (ctx.mergeToSpecified) return; // Maestro already merged

    let cfg;
    try {
      cfg = await deps.loadConfig();
    } catch (err) {
      onError(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    const mode = cfg.config.autoMerge;
    const projectName = deps.getProjectName(ctx.projectPath);
    const mergeTo = await resolveDefaultMergeTo(ctx.projectPath).catch(() => 'master');

    if (mode === 'never') {
      emit({
        kind: 'ready',
        workerId: ctx.workerId,
        branch: ctx.branch,
        projectName,
        mergeTo,
        headline: buildReadyHeadline(ctx.branch),
        ts: isoNow(),
      });
      return;
    }

    const merger: PendingAsk = {
      workerId: ctx.workerId,
      branch: ctx.branch,
      projectName,
      projectPath: ctx.projectPath,
      worktreePath: ctx.worktreePath,
      mergeTo,
    };

    if (mode === 'auto') {
      trackMerge(merger);
      return;
    }

    // mode === 'ask'
    try {
      const q = deps.questionStore.enqueue({
        question: `Merge '${ctx.branch}' into ${mergeTo}?`,
        context: `Worker ${ctx.workerId} finished. Reply y or n (case-insensitive).`,
        workerId: ctx.workerId,
        urgency: 'blocking',
      });
      pendingAsks.set(q.id, merger);
      emit({
        kind: 'asked',
        workerId: ctx.workerId,
        branch: ctx.branch,
        projectName,
        mergeTo,
        headline: buildAskedHeadline(projectName, ctx.branch, mergeTo),
        ts: isoNow(),
      });
    } catch (err) {
      onError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  function handleAnswer(record: QuestionRecord): void {
    if (disposed) return;
    const ctx = pendingAsks.get(record.id);
    if (ctx === undefined) return; // not one of ours
    pendingAsks.delete(record.id);

    const answer = record.answer ?? '';
    const parsed = parseYesNo(answer);
    if (parsed === 'yes') {
      trackMerge(ctx);
      return;
    }

    // 'no' OR unclear → declined. Fail-safe: irreversibility wins.
    const unclearAnswer = parsed === null ? answer.trim() : undefined;
    emit({
      kind: 'declined',
      workerId: ctx.workerId,
      branch: ctx.branch,
      projectName: ctx.projectName,
      mergeTo: ctx.mergeTo,
      headline: buildDeclinedHeadline(ctx.branch, unclearAnswer),
      ...(unclearAnswer !== undefined && unclearAnswer.length > 0
        ? { unclearAnswer }
        : {}),
      ts: isoNow(),
    });
  }

  return {
    onFinalize(result, ctx): void {
      if (disposed) return;
      // Track the entire handle-finalize chain in inflight (not just the
      // trackMerge-spawned merge promise) so `shutdown()` properly
      // awaits the config-load + resolve-merge-to + question-enqueue or
      // merge-trigger sequence. Without this, a synchronous
      // `await shutdown()` immediately after `onFinalize()` flips
      // `disposed = true` before tryHandleFinalize advances past its
      // first checkpoint — silently dropping the event.
      const p = tryHandleFinalize(result, ctx).catch((err: unknown) => {
        onError(err instanceof Error ? err : new Error(String(err)));
      });
      inflight.add(p);
      void p.finally(() => {
        inflight.delete(p);
      });
    },
    onQuestionAnswered(record): void {
      handleAnswer(record);
    },
    async shutdown(): Promise<void> {
      if (disposed) return;
      disposed = true;
      pendingAsks.clear();
      // Drain in-flight merges. allSettled because a doMerge throw is
      // already caught upstream (trackMerge wraps in `.catch`) — this
      // is belt-and-suspenders for the void-promise the chain returns.
      await Promise.allSettled(Array.from(inflight));
    },
  };
}
