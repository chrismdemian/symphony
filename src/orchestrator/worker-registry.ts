import type { StreamEvent, Worker, WorkerExitInfo, WorkerStatus } from '../workers/types.js';
import type { ProjectStore } from '../projects/types.js';
import type { PersistedWorkerRecord, WorkerStore } from '../state/sqlite-worker-store.js';
import { matchesFeatureIntent } from './feature-intent.js';
import type { AutonomyTier, WorkerRole } from './types.js';

/**
 * Max stream events retained per worker for `get_worker_output`.
 * Roughly aligns with emdash's `MAX_LIFECYCLE_LOG_LINES` cap and covers
 * a full typical worker turn without letting one runaway worker balloon
 * the orchestrator's heap. Oldest events drop first.
 */
export const DEFAULT_OUTPUT_BUFFER_CAP = 2000;

export interface WorkerRecord {
  readonly id: string;
  readonly projectPath: string;
  /**
   * Resolved project ID for SQL persistence. `null` for unregistered
   * absolute-path projects (consistent with audit M2 from 2A.4a — don't
   * fabricate IDs for projects the user never registered).
   */
  readonly projectId: string | null;
  /** Optional task association — populated when a tool wires a task to its worker. */
  readonly taskId: string | null;
  readonly worktreePath: string;
  readonly role: WorkerRole;
  readonly featureIntent: string;
  readonly taskDescription: string;
  readonly model?: string;
  readonly autonomyTier: AutonomyTier;
  readonly dependsOn: readonly string[];
  readonly createdAt: string;
  sessionId?: string;
  status: WorkerStatus;
  completedAt?: string;
  exitInfo?: WorkerExitInfo;
  worker: Worker;
  readonly buffer: CircularBuffer<StreamEvent>;
  /**
   * ISO timestamp of the most recent event observed from the worker's
   * stream. Updated by the lifecycle's event tap on every push. Used by
   * `global_status` to answer "where was I?". Undefined until the first
   * event arrives (which happens within ms of a successful spawn).
   */
  lastEventAt?: string;
  /**
   * Cumulative session cost in USD as reported by the most recent
   * `result` event's `total_cost_usd`. Persisted via `markCompleted` so
   * the reserved `workers.cost_usd` SQL column gets populated. Phase 2B.1b m1.
   */
  costUsd?: number;
  /** Unsubscribe callback for the event-tap consumer. Called on remove/shutdown. */
  detach: () => void;
}

export interface WorkerRecordSnapshot {
  readonly id: string;
  readonly projectPath: string;
  readonly worktreePath: string;
  readonly role: WorkerRole;
  readonly featureIntent: string;
  readonly taskDescription: string;
  readonly model?: string;
  readonly autonomyTier: AutonomyTier;
  readonly dependsOn: readonly string[];
  readonly sessionId?: string;
  readonly status: WorkerStatus;
  readonly createdAt: string;
  readonly completedAt?: string;
  readonly lastEventAt?: string;
  readonly costUsd?: number;
  readonly exitCode?: number | null;
  readonly exitSignal?: NodeJS.Signals | null;
}

export class CircularBuffer<T> {
  private readonly items: T[] = [];
  private totalSeen = 0;

  constructor(readonly capacity: number) {
    if (!Number.isFinite(capacity) || capacity <= 0) {
      throw new Error(`CircularBuffer capacity must be a positive integer, got ${capacity}`);
    }
  }

  push(item: T): void {
    this.totalSeen += 1;
    this.items.push(item);
    if (this.items.length > this.capacity) {
      this.items.shift();
    }
  }

  /** Return the last N items, oldest first. `n <= 0` returns []. */
  tail(n: number): T[] {
    if (n <= 0) return [];
    if (n >= this.items.length) return this.items.slice();
    return this.items.slice(this.items.length - n);
  }

  size(): number {
    return this.items.length;
  }

  total(): number {
    return this.totalSeen;
  }

  clear(): void {
    this.items.length = 0;
  }
}

export interface WorkerRegistryListFilter {
  readonly projectPath?: string;
  readonly status?: WorkerStatus | readonly WorkerStatus[];
}

export interface WorkerLookupMatch extends WorkerRecordSnapshot {
  readonly matchedBy: 'id' | 'featureIntent';
}

export interface WorkerRegistryOptions {
  /**
   * Phase 2B.1b — write-through persistence seam. When supplied, every
   * mutation also fires the corresponding store call. The registry stays
   * the authoritative LIVE-state owner (Worker handle + buffer); the
   * store mirrors metadata for crash recovery and historical queries.
   *
   * `clear()` is the one operation that does NOT touch the store —
   * shutdown leaves rows intact so the next process start can mark them
   * `crashed` (or restore them as terminal if shutdown ran cleanly).
   */
  readonly store?: WorkerStore;
}

/**
 * In-memory authoritative state for workers managed by the orchestrator.
 * Optionally write-throughs to a `WorkerStore` for SQL-backed crash
 * recovery (Phase 2B.1b).
 */
export class WorkerRegistry {
  private readonly records = new Map<string, WorkerRecord>();
  private readonly store: WorkerStore | undefined;

  constructor(opts: WorkerRegistryOptions = {}) {
    this.store = opts.store;
  }

  has(id: string): boolean {
    return this.records.has(id);
  }

  get(id: string): WorkerRecord | undefined {
    return this.records.get(id);
  }

  register(record: WorkerRecord): void {
    if (this.records.has(record.id)) {
      throw new Error(`WorkerRegistry: duplicate worker id '${record.id}'`);
    }
    // Store insert FIRST — failure (FK violation, schema mismatch, PK
    // collision) leaves the registry clean rather than orphaned (M3 fix
    // from 2B.1b review). On success the in-memory entry takes over as
    // authoritative live state.
    this.store?.insert(toPersisted(record));
    this.records.set(record.id, record);
  }

  /**
   * Phase 2B.1b — memory-only insert for `recoverFromStore`. The row
   * already exists in SQL (this is the "rehydrate from disk" path);
   * skipping the store insert avoids a duplicate-id throw. Tools find
   * the recovered worker by id; `resume_worker` swaps in a real `Worker`
   * via `replace()`.
   */
  rehydrate(record: WorkerRecord): void {
    if (this.records.has(record.id)) {
      throw new Error(`WorkerRegistry: duplicate worker id '${record.id}'`);
    }
    this.records.set(record.id, record);
  }

  /** Replace an existing record's worker handle + buffer (used by resume_worker). */
  replace(id: string, update: Pick<WorkerRecord, 'worker' | 'buffer' | 'detach'> & { sessionId?: string }): void {
    const existing = this.records.get(id);
    if (!existing) throw new Error(`WorkerRegistry: unknown worker id '${id}'`);
    existing.detach();
    existing.worker = update.worker;
    existing.buffer.clear();
    // buffer ref stays same instance; copy over detach
    existing.detach = update.detach;
    existing.status = 'spawning';
    if (update.sessionId !== undefined) existing.sessionId = update.sessionId;
    existing.completedAt = undefined;
    existing.exitInfo = undefined;
    // Phase 2B-followups M1 (audit) — also clear in-memory `costUsd`. If
    // the resumed run never reaches a `result` event (kill, network drop,
    // crash before turn-complete), the next `markCompleted` would
    // otherwise re-persist the PRIOR run's cumulative cost stamped with
    // the new completedAt, producing a misleading audit trail. Pair with
    // the explicit `costUsd: null` patch below.
    existing.costUsd = undefined;
    // Explicitly clear prior terminal columns in SQL — without this, a
    // crashed worker that gets resumed would carry stale completedAt /
    // exitCode / exitSignal forever, surfacing a misleading audit trail
    // (M1 fix from 2B.1b review).
    this.store?.update(id, {
      status: 'spawning',
      completedAt: null,
      exitCode: null,
      exitSignal: null,
      costUsd: null,
      ...(update.sessionId !== undefined ? { sessionId: update.sessionId } : {}),
    });
  }

  list(filter: WorkerRegistryListFilter = {}): WorkerRecord[] {
    const records = Array.from(this.records.values());
    const statusSet = Array.isArray(filter.status)
      ? new Set(filter.status as readonly WorkerStatus[])
      : typeof filter.status === 'string'
        ? new Set<WorkerStatus>([filter.status])
        : null;
    return records.filter((r) => {
      if (filter.projectPath !== undefined && r.projectPath !== filter.projectPath) return false;
      if (statusSet !== null && !statusSet.has(r.status)) return false;
      return true;
    });
  }

  find(description: string): WorkerLookupMatch[] {
    const trimmed = description.trim();
    if (trimmed.length === 0) return [];
    const results: WorkerLookupMatch[] = [];
    for (const r of this.records.values()) {
      if (r.id.toLowerCase() === trimmed.toLowerCase()) {
        results.push({ ...toSnapshot(r), matchedBy: 'id' });
        continue;
      }
      if (matchesFeatureIntent(r.featureIntent, trimmed)) {
        results.push({ ...toSnapshot(r), matchedBy: 'featureIntent' });
      }
    }
    return results;
  }

  markCompleted(id: string, exitInfo: WorkerExitInfo, now: () => number = Date.now): void {
    const record = this.records.get(id);
    if (!record) return;
    record.status = exitInfo.status;
    record.exitInfo = exitInfo;
    const completedAt = new Date(now()).toISOString();
    record.completedAt = completedAt;
    // Phase 2A.4a m5 — for terminal workers, `lastEventAt` is the
    // timestamp of the final stream event. If a worker exits via SIGKILL
    // without emitting a final event, `lastEventAt` and `completedAt`
    // could be seconds apart. Stamping `lastEventAt = completedAt` makes
    // the "where was I?" semantics unambiguous: terminal records report
    // their exit time as last activity.
    record.lastEventAt = completedAt;
    if (exitInfo.sessionId !== undefined) record.sessionId = exitInfo.sessionId;
    this.store?.update(id, {
      status: exitInfo.status,
      completedAt,
      lastEventAt: completedAt,
      exitCode: exitInfo.exitCode,
      exitSignal: exitInfo.signal,
      ...(exitInfo.sessionId !== undefined ? { sessionId: exitInfo.sessionId } : {}),
      // Phase 2B.1b m1 — persist the cumulative session cost captured by
      // the lifecycle event tap. The reserved `workers.cost_usd` column
      // is finally written. `record.costUsd` may be undefined for workers
      // that never emit a `result` event (early crash) — the patch's
      // `T | null` semantics treat absence as "preserve" so we explicitly
      // pass null in that case to clear stale data on resume.
      costUsd: record.costUsd ?? null,
    });
  }

  /**
   * Phase 2B.1b m1 — capture the cumulative session cost emitted by
   * `result` events so it can be persisted on completion. Idempotent:
   * `total_cost_usd` is cumulative across turns, last value wins.
   */
  updateCostUsd(id: string, costUsd: number): void {
    const record = this.records.get(id);
    if (!record) return;
    if (!Number.isFinite(costUsd) || costUsd < 0) return;
    record.costUsd = costUsd;
  }

  updateSessionId(id: string, sessionId: string): void {
    const record = this.records.get(id);
    if (!record) return;
    record.sessionId = sessionId;
    this.store?.update(id, { sessionId });
  }

  updateStatus(id: string, status: WorkerStatus): void {
    const record = this.records.get(id);
    if (!record) return;
    record.status = status;
    this.store?.update(id, { status });
  }

  /**
   * Stamp the most recent event timestamp. Called by the lifecycle event
   * tap on every push. Stays IN-MEMORY ONLY — per-event SQL writes were
   * a perf cliff for chatty workers (M4 from 2B.1b review). Phase 2B.2
   * can re-introduce with throttling if a use case demands it. Persisted
   * snapshots reflect `lastEventAt` only when the row was inserted; live
   * snapshots are fresh.
   */
  updateLastEventAt(id: string, iso: string): void {
    const record = this.records.get(id);
    if (!record) return;
    record.lastEventAt = iso;
  }

  /**
   * Remove a record. Does NOT kill the worker — caller is responsible for
   * that. Safe to call on unknown ids (no-op). Deletes the SQL row too —
   * `remove` is the explicit "this worker is gone" call. Use `clear()` on
   * shutdown to preserve rows for the next process start.
   */
  remove(id: string): void {
    const record = this.records.get(id);
    if (!record) return;
    record.detach();
    this.records.delete(id);
    this.store?.delete(id);
  }

  snapshot(id: string): WorkerRecordSnapshot | undefined {
    const r = this.records.get(id);
    return r ? toSnapshot(r) : undefined;
  }

  snapshots(filter?: WorkerRegistryListFilter): WorkerRecordSnapshot[] {
    return this.list(filter).map(toSnapshot);
  }

  clear(): void {
    for (const r of this.records.values()) r.detach();
    this.records.clear();
    // NOTE: deliberately does NOT touch the store. Shutdown leaves SQL
    // rows alive so next-startup reconciliation can mark survivors crashed.
  }

  /** Read-only view of the persistence seam (Phase 2B.1b). */
  getStore(): WorkerStore | undefined {
    return this.store;
  }
}

/**
 * Convert a live `WorkerRecord` to the persisted shape. Drops the
 * `Worker` handle, `CircularBuffer`, and `detach` callback — none survive
 * the orchestrator's process boundary.
 */
export function toPersisted(record: WorkerRecord): PersistedWorkerRecord {
  const persisted: PersistedWorkerRecord = {
    id: record.id,
    projectId: record.projectId,
    taskId: record.taskId,
    worktreePath: record.worktreePath,
    role: record.role,
    featureIntent: record.featureIntent,
    taskDescription: record.taskDescription,
    autonomyTier: record.autonomyTier,
    dependsOn: record.dependsOn,
    status: record.status,
    createdAt: record.createdAt,
    ...(record.model !== undefined ? { model: record.model } : {}),
    ...(record.sessionId !== undefined ? { sessionId: record.sessionId } : {}),
    ...(record.completedAt !== undefined ? { completedAt: record.completedAt } : {}),
    ...(record.lastEventAt !== undefined ? { lastEventAt: record.lastEventAt } : {}),
    ...(record.costUsd !== undefined ? { costUsd: record.costUsd } : {}),
    ...(record.exitInfo !== undefined
      ? {
          exitCode: record.exitInfo.exitCode,
          exitSignal: record.exitInfo.signal,
        }
      : {}),
  };
  return persisted;
}

/**
 * Synthesize a `WorkerRecordSnapshot`-shaped row from a persisted record
 * (typically a crashed/completed worker whose live handle is gone). Used
 * by tools that merge live + historical views (`list_workers`,
 * `global_status`).
 */
export function persistedToSnapshot(
  record: PersistedWorkerRecord,
  projectPath: string,
): WorkerRecordSnapshot {
  return {
    id: record.id,
    projectPath,
    worktreePath: record.worktreePath,
    role: record.role,
    featureIntent: record.featureIntent,
    taskDescription: record.taskDescription,
    autonomyTier: record.autonomyTier,
    dependsOn: record.dependsOn,
    status: record.status,
    createdAt: record.createdAt,
    ...(record.model !== undefined ? { model: record.model } : {}),
    ...(record.sessionId !== undefined ? { sessionId: record.sessionId } : {}),
    ...(record.completedAt !== undefined ? { completedAt: record.completedAt } : {}),
    ...(record.lastEventAt !== undefined ? { lastEventAt: record.lastEventAt } : {}),
    ...(record.costUsd !== undefined ? { costUsd: record.costUsd } : {}),
    ...(record.exitCode !== undefined ? { exitCode: record.exitCode } : {}),
    ...(record.exitSignal !== undefined ? { exitSignal: record.exitSignal } : {}),
  };
}

const TERMINAL_STATUSES: ReadonlySet<WorkerStatus> = new Set<WorkerStatus>([
  'completed',
  'failed',
  'killed',
  'timeout',
  'crashed',
]);

export interface MergeLiveAndPersistedOptions {
  readonly projectStore?: ProjectStore;
  readonly projectPath?: string;
  /** Include persisted-only terminal workers (default true). */
  readonly includeTerminal?: boolean;
}

/**
 * Merge live in-memory snapshots with persisted-only rows from the
 * `WorkerStore`. Live wins on id collision (live state is fresher).
 * Persisted-only rows synthesize a snapshot using `projectStore` to
 * resolve `projectId` → path; rows whose project can't be resolved fall
 * back to a sentinel `(unregistered)` path so callers can still address
 * the worktree.
 */
export function mergeLiveAndPersisted(
  registry: WorkerRegistry,
  opts: MergeLiveAndPersistedOptions = {},
): WorkerRecordSnapshot[] {
  const liveAll = registry.snapshots(
    opts.projectPath !== undefined ? { projectPath: opts.projectPath } : {},
  );
  const includeTerminal = opts.includeTerminal ?? true;
  // Symmetric filter: live + persisted both honor `includeTerminal=false`
  // (M2 fix from 2B.1b review — flag was useless when live terminal rows
  // passed through).
  const live = includeTerminal
    ? liveAll
    : liveAll.filter((s) => !TERMINAL_STATUSES.has(s.status));
  const liveIds = new Set(liveAll.map((s) => s.id));
  const store = registry.getStore();
  if (store === undefined) return live;

  const merged = [...live];

  // Build a project-id → path map once. Falls back to the persisted path
  // when the project is unregistered (audit M2 from 2A.4a — never
  // fabricate a project name).
  const idToPath = new Map<string, string>();
  if (opts.projectStore) {
    for (const p of opts.projectStore.list()) idToPath.set(p.id, p.path);
  }

  for (const persisted of store.list()) {
    if (liveIds.has(persisted.id)) continue;
    if (!includeTerminal && TERMINAL_STATUSES.has(persisted.status)) continue;
    const projectPath =
      persisted.projectId !== null
        ? (idToPath.get(persisted.projectId) ?? '(unregistered)')
        : '(unregistered)';
    if (opts.projectPath !== undefined && projectPath !== opts.projectPath) continue;
    merged.push(persistedToSnapshot(persisted, projectPath));
  }
  return merged;
}

export function toSnapshot(r: WorkerRecord): WorkerRecordSnapshot {
  const base = {
    id: r.id,
    projectPath: r.projectPath,
    worktreePath: r.worktreePath,
    role: r.role,
    featureIntent: r.featureIntent,
    taskDescription: r.taskDescription,
    autonomyTier: r.autonomyTier,
    dependsOn: r.dependsOn,
    status: r.status,
    createdAt: r.createdAt,
  } as const;
  return {
    ...base,
    ...(r.model !== undefined ? { model: r.model } : {}),
    ...(r.sessionId !== undefined ? { sessionId: r.sessionId } : {}),
    ...(r.completedAt !== undefined ? { completedAt: r.completedAt } : {}),
    ...(r.lastEventAt !== undefined ? { lastEventAt: r.lastEventAt } : {}),
    ...(r.costUsd !== undefined ? { costUsd: r.costUsd } : {}),
    ...(r.exitInfo !== undefined
      ? {
          exitCode: r.exitInfo.exitCode,
          exitSignal: r.exitInfo.signal,
        }
      : {}),
  };
}
