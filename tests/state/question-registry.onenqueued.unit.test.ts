import { describe, it, expect, vi } from 'vitest';
import { QuestionRegistry } from '../../src/state/question-registry.js';

/**
 * Phase 3H.3 — `onQuestionEnqueued` hook seam.
 *
 * Verifies the in-memory QuestionRegistry fires the callback post-insert
 * (so the dispatcher sees the canonical record), and that consumer
 * errors do NOT poison the enqueue path. Mirrors the pattern in the
 * sqlite-question-store sibling test.
 */

describe('QuestionRegistry — onQuestionEnqueued', () => {
  it('fires the callback post-insert with the canonical record', () => {
    const cb = vi.fn();
    const reg = new QuestionRegistry({ onQuestionEnqueued: cb });
    const out = reg.enqueue({ question: 'Pick a port?' });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(out);
  });

  it('callback runs AFTER the records map is updated (record is queryable inside the callback)', () => {
    const reg = new QuestionRegistry({
      onQuestionEnqueued: (record) => {
        // From inside the callback, get(id) must already return the record.
        const fetched = reg.get(record.id);
        expect(fetched).toBeDefined();
        expect(fetched?.id).toBe(record.id);
      },
    });
    reg.enqueue({ question: 'Anyone home?' });
  });

  it('a throwing consumer does not poison enqueue', () => {
    const reg = new QuestionRegistry({
      onQuestionEnqueued: () => {
        throw new Error('consumer is broken');
      },
    });
    const out = reg.enqueue({ question: 'still works?' });
    expect(out.id).toMatch(/^q-/);
    // And subsequent enqueues continue to fire (the throw didn't unset the hook).
    expect(() => reg.enqueue({ question: 'twice' })).not.toThrow();
  });

  it('NO callback fires when the input is invalid (empty question)', () => {
    const cb = vi.fn();
    const reg = new QuestionRegistry({ onQuestionEnqueued: cb });
    expect(() => reg.enqueue({ question: '' })).toThrow();
    expect(cb).not.toHaveBeenCalled();
  });

  it('answer() does NOT fire onQuestionEnqueued (only enqueue does)', () => {
    const cb = vi.fn();
    const reg = new QuestionRegistry({ onQuestionEnqueued: cb });
    const q = reg.enqueue({ question: 'before answer' });
    cb.mockReset();
    reg.answer(q.id, 'yes');
    expect(cb).not.toHaveBeenCalled();
  });
});
