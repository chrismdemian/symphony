import { describe, expect, it, vi } from 'vitest';

import { createTaskNotesMirrorQueue } from '../../src/state/task-notes-mirror-queue.js';
import type { MirrorTaskNotesInput, MirrorTaskNotesResult } from '../../src/state/task-notes-mirror.js';

describe('createTaskNotesMirrorQueue', () => {
  it('serializes writes for the same task in submission order', async () => {
    const order: number[] = [];
    let resolveFirst: (() => void) | undefined;
    const firstStarted = new Promise<void>((r) => (resolveFirst = r));
    const firstHeld = new Promise<void>((r) => setTimeout(r, 25));
    const writer = vi.fn(async (input: MirrorTaskNotesInput): Promise<MirrorTaskNotesResult> => {
      const noteAt = input.notes[0]?.at ?? '';
      const num = Number(noteAt);
      order.push(num);
      if (num === 1) {
        resolveFirst?.();
        await firstHeld;
      }
      return { path: `/tmp/${input.taskId}/notes.md`, written: true };
    });
    const q = createTaskNotesMirrorQueue(writer);

    // Three submissions for the same task, fast-fire.
    const p1 = q.enqueue({
      projectPath: '/p',
      taskId: 'tk-a',
      notes: [{ at: '1', text: 'one' }],
    });
    const p2 = q.enqueue({
      projectPath: '/p',
      taskId: 'tk-a',
      notes: [{ at: '2', text: 'two' }],
    });
    const p3 = q.enqueue({
      projectPath: '/p',
      taskId: 'tk-a',
      notes: [{ at: '3', text: 'three' }],
    });

    await firstStarted;
    // Second writer must NOT have been invoked yet — the first is still
    // holding. Sanity-check the serializer is actually serializing.
    expect(order).toEqual([1]);

    await Promise.all([p1, p2, p3]);
    expect(order).toEqual([1, 2, 3]);
  });

  it('parallelizes writes across different task ids', async () => {
    const enteredAt: Record<string, number> = {};
    const writer = vi.fn(async (input: MirrorTaskNotesInput): Promise<MirrorTaskNotesResult> => {
      enteredAt[input.taskId] = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { path: null, written: true };
    });
    const q = createTaskNotesMirrorQueue(writer);
    const t0 = Date.now();
    const pa = q.enqueue({ projectPath: '/p', taskId: 'tk-a', notes: [] });
    const pb = q.enqueue({ projectPath: '/p', taskId: 'tk-b', notes: [] });
    await Promise.all([pa, pb]);
    // Both writers entered within a couple milliseconds of each other.
    const skew = Math.abs((enteredAt['tk-a'] ?? 0) - (enteredAt['tk-b'] ?? 0));
    expect(skew).toBeLessThan(15);
    // Total wall-clock should be ~one writer's worth, not two — but
    // skip a hard assertion on that (vitest sched + CI variance). The
    // skew check above is the load-bearing assertion.
    expect(Date.now() - t0).toBeLessThan(80);
  });

  it('continues the chain even when a prior write rejects', async () => {
    let attempt = 0;
    const writer = vi.fn(
      async (_input: MirrorTaskNotesInput): Promise<MirrorTaskNotesResult> => {
        attempt += 1;
        if (attempt === 1) throw new Error('first failed');
        return { path: '/tmp/x.md', written: true };
      },
    );
    const q = createTaskNotesMirrorQueue(writer);
    const p1 = q.enqueue({ projectPath: '/p', taskId: 'tk-a', notes: [] });
    const p2 = q.enqueue({ projectPath: '/p', taskId: 'tk-a', notes: [] });
    await expect(p1).rejects.toThrow('first failed');
    await expect(p2).resolves.toEqual({ path: '/tmp/x.md', written: true });
  });

  it('different project paths for same task id are separate chains', async () => {
    const seen: string[] = [];
    const writer = vi.fn(async (input: MirrorTaskNotesInput): Promise<MirrorTaskNotesResult> => {
      seen.push(`${input.projectPath}::${input.taskId}`);
      return { path: null, written: true };
    });
    const q = createTaskNotesMirrorQueue(writer);
    await Promise.all([
      q.enqueue({ projectPath: '/p1', taskId: 'tk-a', notes: [] }),
      q.enqueue({ projectPath: '/p2', taskId: 'tk-a', notes: [] }),
    ]);
    expect(seen.length).toBe(2);
  });

  it('size() shrinks back to zero after the tail resolves', async () => {
    const writer = vi.fn(async (): Promise<MirrorTaskNotesResult> => ({ path: null, written: true }));
    const q = createTaskNotesMirrorQueue(writer);
    expect(q.size()).toBe(0);
    const p = q.enqueue({ projectPath: '/p', taskId: 'tk-a', notes: [] });
    expect(q.size()).toBe(1);
    await p;
    // Let the .finally micro-task run.
    await new Promise((resolve) => setImmediate(resolve));
    expect(q.size()).toBe(0);
  });

  it('null projectPath enqueues normally', async () => {
    const writer = vi.fn(async (input: MirrorTaskNotesInput): Promise<MirrorTaskNotesResult> => ({
      path: null,
      written: false,
      skipReason: input.projectPath === null ? 'no-project-path' : 'write-failed',
    }));
    const q = createTaskNotesMirrorQueue(writer);
    const res = await q.enqueue({ projectPath: null, taskId: 'tk-a', notes: [] });
    expect(res.skipReason).toBe('no-project-path');
  });
});
