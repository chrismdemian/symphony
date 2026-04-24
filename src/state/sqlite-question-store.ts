import { randomBytes } from 'node:crypto';
import type { Database, Statement } from 'better-sqlite3';
import {
  AlreadyAnsweredError,
  UnknownQuestionError,
  toQuestionSnapshot,
  type EnqueueQuestionInput,
  type QuestionListFilter,
  type QuestionRecord,
  type QuestionSnapshot,
  type QuestionStore,
  type QuestionUrgency,
} from './question-registry.js';

interface QuestionRow {
  id: string;
  project_id: string | null;
  worker_id: string | null;
  question: string;
  context: string | null;
  urgency: QuestionUrgency;
  asked_at: string;
  answered: 0 | 1;
  answer: string | null;
  answered_at: string | null;
  insertion_seq: number;
}

export interface SqliteQuestionStoreOptions {
  readonly now?: () => number;
  readonly idGenerator?: () => string;
}

function defaultIdGenerator(): string {
  return `q-${randomBytes(4).toString('hex')}`;
}

export class SqliteQuestionStore implements QuestionStore {
  private readonly stmts: {
    insert: Statement;
    getById: Statement;
    listAll: Statement;
    updateAnswer: Statement;
    nextSeq: Statement;
  };
  private readonly now: () => number;
  private readonly genId: () => string;

  constructor(private readonly db: Database, opts: SqliteQuestionStoreOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.genId = opts.idGenerator ?? defaultIdGenerator;
    this.stmts = {
      insert: db.prepare(
        `INSERT INTO questions
           (id, project_id, worker_id, question, context, urgency, asked_at, answered, insertion_seq)
         VALUES
           (@id, @project_id, @worker_id, @question, @context, @urgency, @asked_at, 0, @insertion_seq)`,
      ),
      getById: db.prepare(`SELECT * FROM questions WHERE id = ?`),
      listAll: db.prepare(`SELECT * FROM questions ORDER BY insertion_seq ASC`),
      updateAnswer: db.prepare(
        `UPDATE questions SET answered = 1, answer = @answer, answered_at = @answered_at WHERE id = @id`,
      ),
      nextSeq: db.prepare(
        `SELECT COALESCE(MAX(insertion_seq), 0) + 1 AS next FROM questions`,
      ),
    };
  }

  list(filter: QuestionListFilter = {}): QuestionRecord[] {
    const rows = this.stmts.listAll.all() as QuestionRow[];
    const out: QuestionRecord[] = [];
    for (const row of rows) {
      if (filter.answered !== undefined && (row.answered === 1) !== filter.answered) continue;
      if (filter.projectId !== undefined && row.project_id !== filter.projectId) continue;
      if (filter.urgency !== undefined && row.urgency !== filter.urgency) continue;
      out.push(rowToRecord(row));
    }
    return out;
  }

  get(id: string): QuestionRecord | undefined {
    const row = this.stmts.getById.get(id) as QuestionRow | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  enqueue(input: EnqueueQuestionInput): QuestionRecord {
    const question = input.question?.trim();
    if (!question) throw new Error('SqliteQuestionStore.enqueue: question is required');
    const urgency: QuestionUrgency = input.urgency ?? 'blocking';
    const id = this.freshId();
    const iso = new Date(this.now()).toISOString();
    const seq = (this.stmts.nextSeq.get() as { next: number }).next;
    this.stmts.insert.run({
      id,
      project_id: input.projectId ?? null,
      worker_id: input.workerId ?? null,
      question,
      context: input.context ?? null,
      urgency,
      asked_at: iso,
      insertion_seq: seq,
    });
    const record = this.get(id);
    if (!record) throw new Error('SqliteQuestionStore.enqueue: post-insert row vanished');
    return record;
  }

  answer(id: string, answer: string): QuestionRecord {
    const existing = this.stmts.getById.get(id) as QuestionRow | undefined;
    if (!existing) throw new UnknownQuestionError(id);
    if (existing.answered === 1) throw new AlreadyAnsweredError(id);
    const iso = new Date(this.now()).toISOString();
    this.stmts.updateAnswer.run({ id, answer, answered_at: iso });
    const record = this.get(id);
    if (!record) throw new Error('SqliteQuestionStore.answer: post-update row vanished');
    return record;
  }

  snapshot(id: string): QuestionSnapshot | undefined {
    const r = this.get(id);
    return r ? toQuestionSnapshot(r) : undefined;
  }

  snapshots(filter: QuestionListFilter = {}): QuestionSnapshot[] {
    return this.list(filter).map(toQuestionSnapshot);
  }

  size(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS c FROM questions`).get() as { c: number };
    return row.c;
  }

  private freshId(): string {
    for (let i = 0; i < 8; i += 1) {
      const candidate = this.genId();
      if (!this.stmts.getById.get(candidate)) return candidate;
    }
    throw new Error('SqliteQuestionStore.enqueue: id generator produced 8 collisions in a row');
  }
}

function rowToRecord(row: QuestionRow): QuestionRecord {
  const record: QuestionRecord = {
    id: row.id,
    question: row.question,
    urgency: row.urgency,
    askedAt: row.asked_at,
    answered: row.answered === 1,
    ...(row.context !== null ? { context: row.context } : {}),
    ...(row.project_id !== null ? { projectId: row.project_id } : {}),
    ...(row.worker_id !== null ? { workerId: row.worker_id } : {}),
    ...(row.answer !== null ? { answer: row.answer } : {}),
    ...(row.answered_at !== null ? { answeredAt: row.answered_at } : {}),
  };
  return record;
}
