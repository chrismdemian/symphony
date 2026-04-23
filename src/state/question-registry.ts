import { randomBytes } from 'node:crypto';

/**
 * Questions Maestro has queued for the USER.
 *
 * Phase 2A.4a ships an in-memory `QuestionStore`; Phase 2B swaps it for a
 * SQLite-backed implementation behind the same interface (projects/tasks
 * pattern). Tools address the store, not the registry — zero churn when
 * the SQL impl lands.
 *
 * Urgency discriminant:
 * - `'blocking'` — Maestro can't proceed without an answer. Surface
 *   immediately to the USER.
 * - `'advisory'` — nice-to-know, batchable in the TUI. Doesn't halt work.
 *
 * Surfacing is Phase 3's concern. This store only persists the queue.
 */
export type QuestionUrgency = 'blocking' | 'advisory';

export interface QuestionRecord {
  readonly id: string;
  readonly question: string;
  readonly context?: string;
  readonly projectId?: string;
  readonly workerId?: string;
  readonly urgency: QuestionUrgency;
  readonly askedAt: string;
  answered: boolean;
  answer?: string;
  answeredAt?: string;
}

export interface QuestionSnapshot {
  readonly id: string;
  readonly question: string;
  readonly context?: string;
  readonly projectId?: string;
  readonly workerId?: string;
  readonly urgency: QuestionUrgency;
  readonly askedAt: string;
  readonly answered: boolean;
  readonly answer?: string;
  readonly answeredAt?: string;
}

export interface EnqueueQuestionInput {
  readonly question: string;
  readonly context?: string;
  readonly projectId?: string;
  readonly workerId?: string;
  readonly urgency?: QuestionUrgency;
}

export interface QuestionListFilter {
  readonly answered?: boolean;
  readonly projectId?: string;
  readonly urgency?: QuestionUrgency;
}

export interface QuestionStore {
  list(filter?: QuestionListFilter): QuestionRecord[];
  get(id: string): QuestionRecord | undefined;
  enqueue(input: EnqueueQuestionInput): QuestionRecord;
  answer(id: string, answer: string): QuestionRecord;
  snapshot(id: string): QuestionSnapshot | undefined;
  snapshots(filter?: QuestionListFilter): QuestionSnapshot[];
  size(): number;
}

export class UnknownQuestionError extends Error {
  readonly questionId: string;
  constructor(questionId: string) {
    super(`QuestionRegistry: unknown question '${questionId}'`);
    this.name = 'UnknownQuestionError';
    this.questionId = questionId;
  }
}

export class AlreadyAnsweredError extends Error {
  readonly questionId: string;
  constructor(questionId: string) {
    super(`QuestionRegistry: question '${questionId}' is already answered`);
    this.name = 'AlreadyAnsweredError';
    this.questionId = questionId;
  }
}

export interface QuestionRegistryOptions {
  readonly now?: () => number;
  readonly idGenerator?: () => string;
}

function defaultIdGenerator(): string {
  return `q-${randomBytes(4).toString('hex')}`;
}

export class QuestionRegistry implements QuestionStore {
  private readonly records = new Map<string, QuestionRecord>();
  private readonly now: () => number;
  private readonly genId: () => string;

  constructor(opts: QuestionRegistryOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.genId = opts.idGenerator ?? defaultIdGenerator;
  }

  list(filter: QuestionListFilter = {}): QuestionRecord[] {
    const records = Array.from(this.records.values());
    return records.filter((r) => {
      if (filter.answered !== undefined && r.answered !== filter.answered) return false;
      if (filter.projectId !== undefined && r.projectId !== filter.projectId) return false;
      if (filter.urgency !== undefined && r.urgency !== filter.urgency) return false;
      return true;
    });
  }

  get(id: string): QuestionRecord | undefined {
    return this.records.get(id);
  }

  enqueue(input: EnqueueQuestionInput): QuestionRecord {
    const question = input.question?.trim();
    if (!question) {
      throw new Error('QuestionRegistry.enqueue: question is required');
    }
    const urgency: QuestionUrgency = input.urgency ?? 'blocking';
    const id = this.freshId();
    const iso = new Date(this.now()).toISOString();
    const record: QuestionRecord = {
      id,
      question,
      urgency,
      askedAt: iso,
      answered: false,
      ...(input.context !== undefined ? { context: input.context } : {}),
      ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
      ...(input.workerId !== undefined ? { workerId: input.workerId } : {}),
    };
    this.records.set(id, record);
    return record;
  }

  answer(id: string, answer: string): QuestionRecord {
    const record = this.records.get(id);
    if (!record) throw new UnknownQuestionError(id);
    if (record.answered) throw new AlreadyAnsweredError(id);
    const iso = new Date(this.now()).toISOString();
    record.answer = answer;
    record.answered = true;
    record.answeredAt = iso;
    return record;
  }

  snapshot(id: string): QuestionSnapshot | undefined {
    const r = this.records.get(id);
    return r ? toQuestionSnapshot(r) : undefined;
  }

  snapshots(filter: QuestionListFilter = {}): QuestionSnapshot[] {
    return this.list(filter).map(toQuestionSnapshot);
  }

  size(): number {
    return this.records.size;
  }

  private freshId(): string {
    for (let i = 0; i < 8; i += 1) {
      const candidate = this.genId();
      if (!this.records.has(candidate)) return candidate;
    }
    throw new Error('QuestionRegistry.enqueue: id generator produced 8 collisions in a row');
  }
}

export function toQuestionSnapshot(r: QuestionRecord): QuestionSnapshot {
  const base = {
    id: r.id,
    question: r.question,
    urgency: r.urgency,
    askedAt: r.askedAt,
    answered: r.answered,
  } as const;
  return {
    ...base,
    ...(r.context !== undefined ? { context: r.context } : {}),
    ...(r.projectId !== undefined ? { projectId: r.projectId } : {}),
    ...(r.workerId !== undefined ? { workerId: r.workerId } : {}),
    ...(r.answer !== undefined ? { answer: r.answer } : {}),
    ...(r.answeredAt !== undefined ? { answeredAt: r.answeredAt } : {}),
  };
}
