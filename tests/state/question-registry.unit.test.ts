import { describe, expect, it } from 'vitest';
import {
  AlreadyAnsweredError,
  QuestionRegistry,
  UnknownQuestionError,
  toQuestionSnapshot,
} from '../../src/state/question-registry.js';

function fixedIdGenerator(seed: string[]): () => string {
  let i = 0;
  return () => {
    const next = seed[i];
    i += 1;
    if (next === undefined) throw new Error('seed exhausted');
    return next;
  };
}

function fixedClock(start: number): { now: () => number; tick: (ms?: number) => void } {
  let t = start;
  return {
    now: () => t,
    tick: (ms = 1) => {
      t += ms;
    },
  };
}

describe('QuestionRegistry.enqueue', () => {
  it('assigns a fresh id and default urgency=blocking', () => {
    const r = new QuestionRegistry({ idGenerator: fixedIdGenerator(['q-a']) });
    const q = r.enqueue({ question: 'Which library?' });
    expect(q.id).toBe('q-a');
    expect(q.urgency).toBe('blocking');
    expect(q.answered).toBe(false);
    expect(q.askedAt).toMatch(/^\d{4}-\d{2}-\d{2}/);
  });

  it('honors explicit advisory urgency + context + projectId + workerId', () => {
    const r = new QuestionRegistry({ idGenerator: fixedIdGenerator(['q-b']) });
    const q = r.enqueue({
      question: 'Naming?',
      context: 'see src/foo.ts:42',
      projectId: 'alpha',
      workerId: 'wk-1234',
      urgency: 'advisory',
    });
    expect(q).toMatchObject({
      urgency: 'advisory',
      context: 'see src/foo.ts:42',
      projectId: 'alpha',
      workerId: 'wk-1234',
    });
  });

  it('rejects blank questions', () => {
    const r = new QuestionRegistry();
    expect(() => r.enqueue({ question: '   ' })).toThrow(/required/);
    expect(() => r.enqueue({ question: '' })).toThrow(/required/);
  });

  it('trims whitespace from the question text', () => {
    const r = new QuestionRegistry({ idGenerator: fixedIdGenerator(['q-c']) });
    const q = r.enqueue({ question: '  ship it?  ' });
    expect(q.question).toBe('ship it?');
  });

  it('retries on id-generator collision', () => {
    const gen = fixedIdGenerator(['q-dup', 'q-dup', 'q-unique']);
    const r = new QuestionRegistry({ idGenerator: gen });
    r.enqueue({ question: 'first' });
    const second = r.enqueue({ question: 'second' });
    expect(second.id).toBe('q-unique');
  });

  it('throws after 8 consecutive id collisions', () => {
    const seed = Array.from({ length: 10 }, () => 'q-stuck');
    const r = new QuestionRegistry({ idGenerator: fixedIdGenerator(seed) });
    r.enqueue({ question: 'first' });
    expect(() => r.enqueue({ question: 'second' })).toThrow(/collisions/);
  });
});

describe('QuestionRegistry.answer', () => {
  it('records answer + answeredAt, flips answered=true', () => {
    const clock = fixedClock(Date.UTC(2026, 3, 23, 10, 0, 0));
    const r = new QuestionRegistry({
      idGenerator: fixedIdGenerator(['q-1']),
      now: clock.now,
    });
    const q = r.enqueue({ question: 'which?' });
    clock.tick(5_000);
    const answered = r.answer(q.id, 'option B');
    expect(answered.answered).toBe(true);
    expect(answered.answer).toBe('option B');
    expect(answered.answeredAt).toBeDefined();
    expect(new Date(answered.answeredAt!).getTime()).toBeGreaterThan(
      new Date(q.askedAt).getTime(),
    );
  });

  it('rejects unknown question id', () => {
    const r = new QuestionRegistry();
    expect(() => r.answer('q-nope', 'x')).toThrow(UnknownQuestionError);
  });

  it('rejects re-answering an already-answered question', () => {
    const r = new QuestionRegistry({ idGenerator: fixedIdGenerator(['q-1']) });
    const q = r.enqueue({ question: 'x?' });
    r.answer(q.id, 'first');
    expect(() => r.answer(q.id, 'second')).toThrow(AlreadyAnsweredError);
  });
});

describe('QuestionRegistry.list / snapshots', () => {
  it('filters by answered + project + urgency', () => {
    const r = new QuestionRegistry({
      idGenerator: fixedIdGenerator(['q-1', 'q-2', 'q-3', 'q-4']),
    });
    r.enqueue({ question: 'a', projectId: 'p1', urgency: 'blocking' });
    const b = r.enqueue({ question: 'b', projectId: 'p1', urgency: 'advisory' });
    r.enqueue({ question: 'c', projectId: 'p2', urgency: 'blocking' });
    r.answer(b.id, 'ok');

    expect(r.list({ answered: false }).length).toBe(2);
    expect(r.list({ answered: true }).length).toBe(1);
    expect(r.list({ projectId: 'p1' }).length).toBe(2);
    expect(r.list({ projectId: 'p2', urgency: 'blocking' }).length).toBe(1);
  });

  it('snapshot and snapshots are value copies (no internal ref leak)', () => {
    const r = new QuestionRegistry({ idGenerator: fixedIdGenerator(['q-a']) });
    const q = r.enqueue({ question: 'x' });
    const snap = r.snapshot(q.id);
    expect(snap).toBeDefined();
    // mutating live record doesn't mutate snapshot
    r.answer(q.id, 'y');
    expect(snap?.answered).toBe(false);
  });

  it('toQuestionSnapshot omits undefined optionals', () => {
    const r = new QuestionRegistry({ idGenerator: fixedIdGenerator(['q-a']) });
    const q = r.enqueue({ question: 'x' });
    const snap = toQuestionSnapshot(q);
    expect(Object.keys(snap).sort()).toEqual([
      'answered',
      'askedAt',
      'id',
      'question',
      'urgency',
    ]);
  });
});

describe('QuestionRegistry.size / get', () => {
  it('size reflects enqueued count; get returns undefined for missing', () => {
    const r = new QuestionRegistry({ idGenerator: fixedIdGenerator(['q-a', 'q-b']) });
    expect(r.size()).toBe(0);
    r.enqueue({ question: 'a' });
    r.enqueue({ question: 'b' });
    expect(r.size()).toBe(2);
    expect(r.get('q-nope')).toBeUndefined();
    expect(r.get('q-a')?.question).toBe('a');
  });
});
