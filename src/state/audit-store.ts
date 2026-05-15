/**
 * Phase 3R — Audit log store contract.
 *
 * The `AuditStore` interface lets the higher-level AuditLogger
 * (`src/audit/logger.ts`) target an in-memory fake (tests) or the
 * `SqliteAuditStore` (production) without divergence. Records are
 * append-only; no update/delete is exposed beyond the bounded-retention
 * trigger fired by SQLite itself.
 */

export const AUDIT_KINDS = [
  // Worker lifecycle (mirrors workers.status terminal set + spawn)
  'worker_spawned',
  'worker_completed',
  'worker_failed',
  'worker_crashed',
  'worker_timeout',
  'worker_killed',
  'worker_interrupted',
  // Question lifecycle
  'question_asked',
  'question_answered',
  // Auto-merge events (mirrors 3O.1 AutoMergeKind)
  'merge_performed',
  'merge_declined',
  'merge_failed',
  'merge_ready',
  // Mode/config changes (3S autonomyTier, 3M awayMode, 3H model mode)
  'tier_changed',
  'model_mode_changed',
  'away_mode_changed',
  // Tool dispatch (capability shim hook — Phase 7 prep)
  'tool_called',
  'tool_denied',
  'tool_error',
  // Catch-all for dispatcher onError sinks
  'error',
] as const;

export type AuditKind = (typeof AUDIT_KINDS)[number];

export const AUDIT_SEVERITIES = ['info', 'warn', 'error'] as const;
export type AuditSeverity = (typeof AUDIT_SEVERITIES)[number];

export interface AuditEntry {
  readonly id: number;
  readonly ts: string;
  readonly kind: AuditKind;
  readonly severity: AuditSeverity;
  readonly projectId: string | null;
  readonly workerId: string | null;
  readonly taskId: string | null;
  readonly toolName: string | null;
  readonly headline: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * Input shape for `append()`. Mirrors `AuditEntry` minus the
 * store-assigned `id`. Defaults: `severity='info'`, `payload={}`,
 * all nullable refs default to `null`. `ts` is caller-supplied so
 * tests can use deterministic timestamps.
 */
export interface AuditAppendInput {
  readonly ts: string;
  readonly kind: AuditKind;
  readonly severity?: AuditSeverity;
  readonly projectId?: string | null;
  readonly workerId?: string | null;
  readonly taskId?: string | null;
  readonly toolName?: string | null;
  readonly headline: string;
  readonly payload?: Readonly<Record<string, unknown>>;
}

export interface AuditListFilter {
  readonly projectId?: string;
  readonly kinds?: readonly AuditKind[];
  readonly severity?: AuditSeverity;
  readonly workerId?: string;
  /** Inclusive lower bound on `ts` (ISO 8601). */
  readonly sinceTs?: string;
  /** Inclusive upper bound on `ts` (ISO 8601). */
  readonly untilTs?: string;
  /** Default 200; capped at 1000 by the implementation. */
  readonly limit?: number;
  /** Skip the first N rows after the filter sort. Default 0. */
  readonly offset?: number;
}

export interface AuditStore {
  append(input: AuditAppendInput): AuditEntry;
  list(filter?: AuditListFilter): AuditEntry[];
  count(filter?: AuditListFilter): number;
}

export const AUDIT_LIST_DEFAULT_LIMIT = 200;
export const AUDIT_LIST_MAX_LIMIT = 1000;
