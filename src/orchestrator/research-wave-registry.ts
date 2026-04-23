import { randomBytes } from 'node:crypto';

/**
 * Research-wave registry — tracks fan-out research launches.
 *
 * A "wave" is N researcher-role workers spawned in parallel on a shared
 * topic (optionally with a per-worker sub-topic from `agenda`). The
 * registry records the association so Maestro can later address "the
 * liquid-glass research wave" instead of juggling N worker ids.
 *
 * Aggregation — fusing the N outputs into one report — is deferred to
 * Phase 4 (needs researcher role prompts + a reducer). 2A.4a ships the
 * spawn-only primitive; 2A.4b adds the audit/finalize pipeline; Phase 4
 * adds the reducer that reads each worker's `get_worker_output` and
 * merges citations.
 *
 * Phase 2B swap-seam: same interface, SQLite-backed impl.
 */
export interface WaveRecord {
  readonly id: string;
  readonly topic: string;
  readonly workerIds: readonly string[];
  readonly projectId?: string;
  readonly startedAt: string;
  finishedAt?: string;
}

export interface WaveSnapshot {
  readonly id: string;
  readonly topic: string;
  readonly workerIds: readonly string[];
  readonly projectId?: string;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly size: number;
}

export interface EnqueueWaveInput {
  readonly topic: string;
  readonly workerIds: readonly string[];
  readonly projectId?: string;
}

export interface WaveListFilter {
  readonly projectId?: string;
  readonly finished?: boolean;
}

export interface WaveStore {
  list(filter?: WaveListFilter): WaveRecord[];
  get(id: string): WaveRecord | undefined;
  enqueue(input: EnqueueWaveInput): WaveRecord;
  markFinished(id: string): WaveRecord;
  snapshot(id: string): WaveSnapshot | undefined;
  snapshots(filter?: WaveListFilter): WaveSnapshot[];
  size(): number;
}

export class UnknownWaveError extends Error {
  readonly waveId: string;
  constructor(waveId: string) {
    super(`WaveRegistry: unknown wave '${waveId}'`);
    this.name = 'UnknownWaveError';
    this.waveId = waveId;
  }
}

export interface WaveRegistryOptions {
  readonly now?: () => number;
  readonly idGenerator?: () => string;
}

function defaultIdGenerator(): string {
  return `wave-${randomBytes(4).toString('hex')}`;
}

export class WaveRegistry implements WaveStore {
  private readonly records = new Map<string, WaveRecord>();
  private readonly now: () => number;
  private readonly genId: () => string;

  constructor(opts: WaveRegistryOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.genId = opts.idGenerator ?? defaultIdGenerator;
  }

  list(filter: WaveListFilter = {}): WaveRecord[] {
    const records = Array.from(this.records.values());
    return records.filter((r) => {
      if (filter.projectId !== undefined && r.projectId !== filter.projectId) return false;
      if (filter.finished === true && r.finishedAt === undefined) return false;
      if (filter.finished === false && r.finishedAt !== undefined) return false;
      return true;
    });
  }

  get(id: string): WaveRecord | undefined {
    return this.records.get(id);
  }

  enqueue(input: EnqueueWaveInput): WaveRecord {
    const topic = input.topic?.trim();
    if (!topic) {
      throw new Error('WaveRegistry.enqueue: topic is required');
    }
    if (input.workerIds.length === 0) {
      throw new Error('WaveRegistry.enqueue: at least one workerId is required');
    }
    const dedup = new Set(input.workerIds);
    if (dedup.size !== input.workerIds.length) {
      throw new Error('WaveRegistry.enqueue: workerIds contain duplicates');
    }
    const id = this.freshId();
    const iso = new Date(this.now()).toISOString();
    const record: WaveRecord = {
      id,
      topic,
      workerIds: [...input.workerIds],
      startedAt: iso,
      ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
    };
    this.records.set(id, record);
    return record;
  }

  markFinished(id: string): WaveRecord {
    const record = this.records.get(id);
    if (!record) throw new UnknownWaveError(id);
    if (record.finishedAt === undefined) {
      record.finishedAt = new Date(this.now()).toISOString();
    }
    return record;
  }

  snapshot(id: string): WaveSnapshot | undefined {
    const r = this.records.get(id);
    return r ? toWaveSnapshot(r) : undefined;
  }

  snapshots(filter: WaveListFilter = {}): WaveSnapshot[] {
    return this.list(filter).map(toWaveSnapshot);
  }

  size(): number {
    return this.records.size;
  }

  private freshId(): string {
    for (let i = 0; i < 8; i += 1) {
      const candidate = this.genId();
      if (!this.records.has(candidate)) return candidate;
    }
    throw new Error('WaveRegistry.enqueue: id generator produced 8 collisions in a row');
  }
}

export function toWaveSnapshot(r: WaveRecord): WaveSnapshot {
  const base = {
    id: r.id,
    topic: r.topic,
    workerIds: r.workerIds.slice(),
    startedAt: r.startedAt,
    size: r.workerIds.length,
  } as const;
  return {
    ...base,
    ...(r.projectId !== undefined ? { projectId: r.projectId } : {}),
    ...(r.finishedAt !== undefined ? { finishedAt: r.finishedAt } : {}),
  };
}
