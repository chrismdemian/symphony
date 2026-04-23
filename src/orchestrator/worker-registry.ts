import type { StreamEvent, Worker, WorkerExitInfo, WorkerStatus } from '../workers/types.js';
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

/**
 * In-memory authoritative state for workers managed by the orchestrator.
 * Phase 2B will back this with SQLite; until then, records live only for
 * the orchestrator's lifetime. Integration tests rely on the record
 * surviving `shutdown()` NOT being a goal — shutdown clears state.
 */
export class WorkerRegistry {
  private readonly records = new Map<string, WorkerRecord>();

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
    record.completedAt = new Date(now()).toISOString();
    if (exitInfo.sessionId !== undefined) record.sessionId = exitInfo.sessionId;
  }

  updateSessionId(id: string, sessionId: string): void {
    const record = this.records.get(id);
    if (!record) return;
    record.sessionId = sessionId;
  }

  updateStatus(id: string, status: WorkerStatus): void {
    const record = this.records.get(id);
    if (!record) return;
    record.status = status;
  }

  /**
   * Remove a record. Does NOT kill the worker — caller is responsible for
   * that. Safe to call on unknown ids (no-op).
   */
  remove(id: string): void {
    const record = this.records.get(id);
    if (!record) return;
    record.detach();
    this.records.delete(id);
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
  }
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
    ...(r.exitInfo !== undefined
      ? {
          exitCode: r.exitInfo.exitCode,
          exitSignal: r.exitInfo.signal,
        }
      : {}),
  };
}
