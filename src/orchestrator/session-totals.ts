/**
 * Phase 3N.2 — pure aggregator for "this session" token + cost totals.
 *
 * "This session" is defined as **workers whose `createdAt` is at or
 * after the orchestrator's boot timestamp**. Crash-recovered workers
 * persisted from a previous session still live in the registry as
 * terminal stubs (`recoverFromStore` rehydrates them as `crashed`); they
 * MUST NOT inflate the running tally. The boot ISO is stamped once in
 * `server.ts` and threaded through `RouterDeps`.
 *
 * Token-total semantics: the status-bar "↑ tokens" number is
 * `inputTokens + outputTokens`. Cache reads/writes are visible in the
 * Phase 3N.3 `/stats` breakdown but excluded from the headline number —
 * they bill at 10% on the API and 0 on Max, so combining them with raw
 * input/output understates the "what's costing me" signal for API users
 * and overstates volume for Max users. Two numbers is one too many for
 * a status bar segment; the input+output sum is the conservative middle.
 *
 * The helper takes a snapshot array (not the registry directly) so
 * tests stay deterministic and the RPC layer can decouple polling from
 * registry-internal data. Pure: no I/O, no clock, no globals.
 */

import type { WorkerRecordSnapshot } from './worker-registry.js';

export interface SessionTotals {
  /** Sum of input + output tokens across in-session workers' cumulative usage. */
  readonly totalTokens: number;
  /** Sum of cumulative cost across in-session workers (USD). */
  readonly totalCostUsd: number;
  /** Number of in-session workers contributing to the totals (any status). */
  readonly workerCount: number;
  /** Sum of cumulative cache-read tokens (visible in `/stats`, not status bar). */
  readonly cacheReadTokens: number;
  /** Sum of cumulative cache-write tokens (visible in `/stats`, not status bar). */
  readonly cacheWriteTokens: number;
}

export const EMPTY_SESSION_TOTALS: SessionTotals = {
  totalTokens: 0,
  totalCostUsd: 0,
  workerCount: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

/**
 * Compute the running session totals from a registry snapshot.
 *
 * `bootIso` is the ISO timestamp stamped at orchestrator startup. A
 * worker's `createdAt` is compared lex-string-wise (Z-suffixed ISO
 * timestamps are lex-monotonic). When undefined, all snapshots count —
 * useful for unit tests that don't care about the recovery filter.
 *
 * `costUsd` and `sessionUsage` are CUMULATIVE per worker (last-wins),
 * so summing across workers is the correct aggregation; we never see
 * double counting within a worker's own turn sequence.
 */
export function computeSessionTotals(
  snapshots: readonly WorkerRecordSnapshot[],
  bootIso?: string,
): SessionTotals {
  let totalTokens = 0;
  let totalCostUsd = 0;
  let workerCount = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  for (const snap of snapshots) {
    if (bootIso !== undefined && snap.createdAt < bootIso) continue;
    workerCount += 1;
    if (snap.costUsd !== undefined && Number.isFinite(snap.costUsd)) {
      totalCostUsd += snap.costUsd;
    }
    const usage = snap.sessionUsage;
    if (usage !== undefined) {
      totalTokens += usage.inputTokens + usage.outputTokens;
      cacheReadTokens += usage.cacheReadTokens;
      cacheWriteTokens += usage.cacheWriteTokens;
    }
  }
  return { totalTokens, totalCostUsd, workerCount, cacheReadTokens, cacheWriteTokens };
}

/**
 * Status-bar token formatter — `1.2K` / `45K` / `1.4M`.
 * Below 1_000 renders the raw count so a single tiny worker reads
 * `↑ 14` rather than `↑ 0K`. Negative or non-finite input returns `'0'`.
 */
export function formatTokenCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0';
  if (n < 1_000) return String(Math.floor(n));
  if (n < 1_000_000) {
    // < 10K → one decimal (`1.2K`); ≥ 10K → no decimal (`14K`).
    //
    // Audit M2 (3N.2): toFixed rounds (e.g., 9999/1000 = 9.999 →
    // toFixed(1) = "10.0"), which crosses the visual 10K decade
    // boundary. Floor-to-one-decimal keeps 9_999 → `9.9K` and 9_949
    // → `9.9K`, only crossing to `10K` when the count actually does.
    if (n < 10_000) {
      const tenths = Math.floor(n / 100);
      const whole = Math.floor(tenths / 10);
      const fraction = tenths % 10;
      return `${whole}.${fraction}K`;
    }
    return `${Math.floor(n / 1_000)}K`;
  }
  if (n < 10_000_000) {
    const hundredths = Math.floor(n / 100_000);
    const whole = Math.floor(hundredths / 10);
    const fraction = hundredths % 10;
    return `${whole}.${fraction}M`;
  }
  return `${Math.floor(n / 1_000_000)}M`;
}

/**
 * Status-bar cost formatter — `$0.0042` (≤4 digits when under $0.01),
 * `$0.42` standard, `$12.34` standard, `$1234` for big multi-day totals.
 * Mirrors `completion-summarizer.ts:218-219`'s precision policy:
 * <$0.01 → 4 decimals, otherwise 2 decimals.
 */
export function formatCostUsd(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '$0.00';
  // Special-case exact 0 — the 4-decimal branch would render `$0.0000`
  // which is visually noisy. Reachable when a worker emits a `result`
  // event with `total_cost_usd: 0` (free-tier turns) while still
  // contributing tokens; the segment stays visible thanks to the
  // non-zero token count, but the cost should read cleanly.
  if (n === 0) return '$0.00';
  // Audit M3 (3N.2): threshold against the 4-decimal-rounded value, not
  // the raw input. Without this, n=0.009999 hits `< 0.01` and renders
  // `$0.0100` (toFixed(4) rounding) — visually weird because the value
  // IS effectively `$0.01`. Rounding first promotes those edge cases
  // into the 2-decimal branch where they read cleanly.
  const rounded4 = Math.round(n * 10_000) / 10_000;
  if (rounded4 < 0.01) return `$${rounded4.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}
