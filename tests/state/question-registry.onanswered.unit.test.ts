import { describe, it, expect, vi } from 'vitest';
import { QuestionRegistry } from '../../src/state/question-registry.js';

/**
 * Phase 3O.1 — `onQuestionAnswered` hook seam.
 *
 * Mirrors `onQuestionEnqueued` in shape: fires post-update with the
 * canonical record, swallows consumer errors, does NOT cross-fire on
 * `enqueue`. The AutoMergeDispatcher subscribes to this hook to route
 * y/n answers to its `pendingAsks` registry.
 */

describe('QuestionRegistry — onQuestionAnswered', () => {
  it('fires the callback post-update with the canonical record', () => {
    const cb = vi.fn();
    const reg = new QuestionRegistry({ onQuestionAnswered: cb });
    const q = reg.enqueue({ question: 'Merge to master?' });
    expect(cb).not.toHaveBeenCalled();
    const updated = reg.answer(q.id, 'y');
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(updated);
    expect(updated.answered).toBe(true);
    expect(updated.answer).toBe('y');
  });

  it('callback runs AFTER the record is mutated (answered=true visible inside callback)', () => {
    let observed: { answered: boolean; answer?: string } | undefined;
    const reg = new QuestionRegistry({
      onQuestionAnswered: (record) => {
        observed = { answered: record.answered, ...(record.answer !== undefined ? { answer: record.answer } : {}) };
      },
    });
    const q = reg.enqueue({ question: 'Merge?' });
    reg.answer(q.id, 'no');
    expect(observed).toEqual({ answered: true, answer: 'no' });
  });

  it('a throwing consumer does not poison answer', () => {
    const reg = new QuestionRegistry({
      onQuestionAnswered: () => {
        throw new Error('consumer is broken');
      },
    });
    const q = reg.enqueue({ question: 'still works?' });
    const updated = reg.answer(q.id, 'y');
    expect(updated.answered).toBe(true);
  });

  it('NO callback fires when answer() rejects (unknown id, already answered)', () => {
    const cb = vi.fn();
    const reg = new QuestionRegistry({ onQuestionAnswered: cb });
    expect(() => reg.answer('q-deadbeef', 'y')).toThrow();
    expect(cb).not.toHaveBeenCalled();

    const q = reg.enqueue({ question: 'first' });
    reg.answer(q.id, 'y');
    cb.mockReset();
    expect(() => reg.answer(q.id, 'y')).toThrow();
    expect(cb).not.toHaveBeenCalled();
  });

  it('enqueue() does NOT fire onQuestionAnswered (only answer does)', () => {
    const cb = vi.fn();
    const reg = new QuestionRegistry({ onQuestionAnswered: cb });
    reg.enqueue({ question: 'never answered' });
    expect(cb).not.toHaveBeenCalled();
  });

  it('coexists with onQuestionEnqueued without interference', () => {
    const onEnq = vi.fn();
    const onAns = vi.fn();
    const reg = new QuestionRegistry({
      onQuestionEnqueued: onEnq,
      onQuestionAnswered: onAns,
    });
    const q = reg.enqueue({ question: 'pair' });
    expect(onEnq).toHaveBeenCalledTimes(1);
    expect(onAns).toHaveBeenCalledTimes(0);
    reg.answer(q.id, 'y');
    expect(onEnq).toHaveBeenCalledTimes(1);
    expect(onAns).toHaveBeenCalledTimes(1);
  });
});
