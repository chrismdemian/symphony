import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SymphonyDatabase } from '../../src/state/db.js';
import { SqliteProjectStore } from '../../src/state/sqlite-project-store.js';
import { SqliteQuestionStore } from '../../src/state/sqlite-question-store.js';
import {
  AlreadyAnsweredError,
  UnknownQuestionError,
} from '../../src/state/question-registry.js';

describe('SqliteQuestionStore', () => {
  let svc: SymphonyDatabase;
  let store: SqliteQuestionStore;

  beforeEach(() => {
    svc = SymphonyDatabase.open({ filePath: ':memory:' });
    const projects = new SqliteProjectStore(svc.db);
    projects.register({ id: 'P1', name: 'P1', path: '/tmp/p1', createdAt: '' });
    projects.register({ id: 'P2', name: 'P2', path: '/tmp/p2', createdAt: '' });
    store = new SqliteQuestionStore(svc.db);
  });

  afterEach(() => {
    svc.close();
  });

  it('enqueue persists question, urgency defaults to blocking', () => {
    const q = store.enqueue({ question: 'use opus or sonnet?' });
    expect(q.id).toMatch(/^q-[0-9a-f]{8}$/);
    expect(q.urgency).toBe('blocking');
    expect(q.answered).toBe(false);
  });

  it('enqueue respects explicit advisory urgency', () => {
    const q = store.enqueue({ question: 'pick a favorite color', urgency: 'advisory' });
    expect(q.urgency).toBe('advisory');
  });

  it('enqueue rejects empty question', () => {
    expect(() => store.enqueue({ question: '   ' })).toThrow();
  });

  it('answer sets the answer and timestamp; second answer throws', () => {
    const q = store.enqueue({ question: 'foo?' });
    const answered = store.answer(q.id, 'bar');
    expect(answered.answered).toBe(true);
    expect(answered.answer).toBe('bar');
    expect(answered.answeredAt).toBeDefined();
    expect(() => store.answer(q.id, 'baz')).toThrow(AlreadyAnsweredError);
  });

  it('answer on unknown id throws UnknownQuestionError', () => {
    expect(() => store.answer('nope', 'x')).toThrow(UnknownQuestionError);
  });

  it('list preserves insertion order', () => {
    const a = store.enqueue({ question: 'a?' });
    const b = store.enqueue({ question: 'b?' });
    const c = store.enqueue({ question: 'c?' });
    expect(store.list().map((q) => q.id)).toEqual([a.id, b.id, c.id]);
  });

  it('list filters by answered boolean', () => {
    const a = store.enqueue({ question: 'a?' });
    store.enqueue({ question: 'b?' });
    store.answer(a.id, 'x');
    expect(store.list({ answered: true }).map((q) => q.id)).toEqual([a.id]);
    expect(store.list({ answered: false })).toHaveLength(1);
  });

  it('list filters by urgency and projectId', () => {
    const a = store.enqueue({ question: 'a?', urgency: 'blocking', projectId: 'P1' });
    store.enqueue({ question: 'b?', urgency: 'advisory' });
    store.enqueue({ question: 'c?', urgency: 'blocking', projectId: 'P2' });
    expect(store.list({ urgency: 'blocking' }).map((q) => q.id)).toHaveLength(2);
    expect(store.list({ projectId: 'P1' }).map((q) => q.id)).toEqual([a.id]);
  });

  it('snapshot returns the full record shape', () => {
    const q = store.enqueue({
      question: 'pick one',
      context: 'blah blah',
      projectId: 'P1',
      workerId: 'w1',
      urgency: 'advisory',
    });
    const snap = store.snapshot(q.id)!;
    expect(snap.context).toBe('blah blah');
    expect(snap.workerId).toBe('w1');
  });

  it('persistence across reopen', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const file = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-q-')),
      'symphony.db',
    );
    try {
      const first = SymphonyDatabase.open({ filePath: file });
      const firstStore = new SqliteQuestionStore(first.db);
      const q = firstStore.enqueue({ question: 'persist?' });
      first.close();

      const second = SymphonyDatabase.open({ filePath: file });
      try {
        const secondStore = new SqliteQuestionStore(second.db);
        const after = secondStore.get(q.id)!;
        expect(after.question).toBe('persist?');
      } finally {
        second.close();
      }
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });

  it('size() matches the number of enqueued questions', () => {
    expect(store.size()).toBe(0);
    store.enqueue({ question: 'a?' });
    store.enqueue({ question: 'b?' });
    expect(store.size()).toBe(2);
  });
});
