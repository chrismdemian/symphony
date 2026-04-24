import { randomBytes } from 'node:crypto';
import type { Database, Statement } from 'better-sqlite3';
import {
  UnknownWaveError,
  toWaveSnapshot,
  type EnqueueWaveInput,
  type WaveListFilter,
  type WaveRecord,
  type WaveSnapshot,
  type WaveStore,
} from '../orchestrator/research-wave-registry.js';
import { CorruptRecordError } from './errors.js';

interface WaveRow {
  id: string;
  topic: string;
  project_id: string | null;
  worker_ids: string;
  started_at: string;
  finished_at: string | null;
  insertion_seq: number;
}

export interface SqliteWaveStoreOptions {
  readonly now?: () => number;
  readonly idGenerator?: () => string;
  /**
   * Phase 2B.1 audit M5 — skip corrupt `worker_ids` JSON rows in list().
   * Default: silent skip. Override to rethrow or log.
   */
  readonly onCorruptRow?: (err: CorruptRecordError) => void;
}

function defaultIdGenerator(): string {
  return `wave-${randomBytes(4).toString('hex')}`;
}

export class SqliteWaveStore implements WaveStore {
  private readonly stmts: {
    insert: Statement;
    getById: Statement;
    listAll: Statement;
    markFinished: Statement;
    nextSeq: Statement;
  };
  private readonly now: () => number;
  private readonly genId: () => string;
  private readonly onCorruptRow: (err: CorruptRecordError) => void;

  constructor(private readonly db: Database, opts: SqliteWaveStoreOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.genId = opts.idGenerator ?? defaultIdGenerator;
    this.onCorruptRow =
      opts.onCorruptRow ??
      ((err) => {
        void err;
      });
    this.stmts = {
      insert: db.prepare(
        `INSERT INTO waves (id, topic, project_id, worker_ids, started_at, insertion_seq)
         VALUES (@id, @topic, @project_id, @worker_ids, @started_at, @insertion_seq)`,
      ),
      getById: db.prepare(`SELECT * FROM waves WHERE id = ?`),
      listAll: db.prepare(`SELECT * FROM waves ORDER BY insertion_seq ASC`),
      markFinished: db.prepare(`UPDATE waves SET finished_at = ? WHERE id = ? AND finished_at IS NULL`),
      nextSeq: db.prepare(`SELECT COALESCE(MAX(insertion_seq), 0) + 1 AS next FROM waves`),
    };
  }

  list(filter: WaveListFilter = {}): WaveRecord[] {
    const rows = this.stmts.listAll.all() as WaveRow[];
    const out: WaveRecord[] = [];
    for (const row of rows) {
      if (filter.projectId !== undefined && row.project_id !== filter.projectId) continue;
      if (filter.finished === true && row.finished_at === null) continue;
      if (filter.finished === false && row.finished_at !== null) continue;
      try {
        out.push(rowToRecord(row));
      } catch (err) {
        if (err instanceof CorruptRecordError) {
          this.onCorruptRow(err);
          continue;
        }
        throw err;
      }
    }
    return out;
  }

  get(id: string): WaveRecord | undefined {
    const row = this.stmts.getById.get(id) as WaveRow | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  enqueue(input: EnqueueWaveInput): WaveRecord {
    const topic = input.topic?.trim();
    if (!topic) throw new Error('SqliteWaveStore.enqueue: topic is required');
    if (input.workerIds.length === 0) {
      throw new Error('SqliteWaveStore.enqueue: at least one workerId is required');
    }
    const dedup = new Set(input.workerIds);
    if (dedup.size !== input.workerIds.length) {
      throw new Error('SqliteWaveStore.enqueue: workerIds contain duplicates');
    }
    const id = this.freshId();
    const iso = new Date(this.now()).toISOString();
    const seq = (this.stmts.nextSeq.get() as { next: number }).next;
    this.stmts.insert.run({
      id,
      topic,
      project_id: input.projectId ?? null,
      worker_ids: JSON.stringify([...input.workerIds]),
      started_at: iso,
      insertion_seq: seq,
    });
    const record = this.get(id);
    if (!record) throw new Error('SqliteWaveStore.enqueue: post-insert row vanished');
    return record;
  }

  markFinished(id: string): WaveRecord {
    const existing = this.stmts.getById.get(id) as WaveRow | undefined;
    if (!existing) throw new UnknownWaveError(id);
    if (existing.finished_at === null) {
      const iso = new Date(this.now()).toISOString();
      this.stmts.markFinished.run(iso, id);
    }
    const record = this.get(id);
    if (!record) throw new Error('SqliteWaveStore.markFinished: post-update row vanished');
    return record;
  }

  snapshot(id: string): WaveSnapshot | undefined {
    const r = this.get(id);
    return r ? toWaveSnapshot(r) : undefined;
  }

  snapshots(filter: WaveListFilter = {}): WaveSnapshot[] {
    return this.list(filter).map(toWaveSnapshot);
  }

  size(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS c FROM waves`).get() as { c: number };
    return row.c;
  }

  private freshId(): string {
    for (let i = 0; i < 8; i += 1) {
      const candidate = this.genId();
      if (!this.stmts.getById.get(candidate)) return candidate;
    }
    throw new Error('SqliteWaveStore.enqueue: id generator produced 8 collisions in a row');
  }
}

function parseWorkerIds(row: WaveRow): string[] {
  try {
    const parsed = JSON.parse(row.worker_ids);
    if (!Array.isArray(parsed)) {
      throw new CorruptRecordError('waves', row.id, 'worker_ids', 'not an array');
    }
    return parsed as string[];
  } catch (err) {
    if (err instanceof CorruptRecordError) throw err;
    throw new CorruptRecordError('waves', row.id, 'worker_ids', (err as Error).message);
  }
}

function rowToRecord(row: WaveRow): WaveRecord {
  const record: WaveRecord = {
    id: row.id,
    topic: row.topic,
    workerIds: parseWorkerIds(row),
    startedAt: row.started_at,
    ...(row.project_id !== null ? { projectId: row.project_id } : {}),
    ...(row.finished_at !== null ? { finishedAt: row.finished_at } : {}),
  };
  return record;
}
