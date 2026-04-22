import { describe, expect, it } from 'vitest';
import { ProjectLockRegistry } from '../../src/worktree/locks.js';

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (err: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('ProjectLockRegistry', () => {
  it('serializes operations on the same project path', async () => {
    const locks = new ProjectLockRegistry();
    const order: string[] = [];
    const d1 = deferred<void>();
    const d2 = deferred<void>();

    const p1 = locks.withLock('/repo', async () => {
      order.push('start1');
      await d1.promise;
      order.push('end1');
    });

    const p2 = locks.withLock('/repo', async () => {
      order.push('start2');
      await d2.promise;
      order.push('end2');
    });

    await new Promise((r) => setImmediate(r));
    expect(order).toEqual(['start1']);

    d1.resolve();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(order).toEqual(['start1', 'end1', 'start2']);

    d2.resolve();
    await Promise.all([p1, p2]);
    expect(order).toEqual(['start1', 'end1', 'start2', 'end2']);
  });

  it('does not block different project paths', async () => {
    const locks = new ProjectLockRegistry();
    const order: string[] = [];
    const d1 = deferred<void>();
    const d2 = deferred<void>();

    const p1 = locks.withLock('/repo-a', async () => {
      order.push('a-start');
      await d1.promise;
      order.push('a-end');
    });
    const p2 = locks.withLock('/repo-b', async () => {
      order.push('b-start');
      await d2.promise;
      order.push('b-end');
    });

    await new Promise((r) => setImmediate(r));
    expect(order).toEqual(['a-start', 'b-start']);

    d2.resolve();
    d1.resolve();
    await Promise.all([p1, p2]);
    expect(order).toContain('a-end');
    expect(order).toContain('b-end');
  });

  it('continues serving subsequent holders after a failure', async () => {
    const locks = new ProjectLockRegistry();
    const ran: string[] = [];

    const failing = locks
      .withLock('/repo', async () => {
        ran.push('first');
        throw new Error('boom');
      })
      .catch(() => undefined);

    const ok = locks.withLock('/repo', async () => {
      ran.push('second');
      return 'done';
    });

    await failing;
    await expect(ok).resolves.toBe('done');
    expect(ran).toEqual(['first', 'second']);
  });

  it('cleans up the tail entry once idle', async () => {
    const locks = new ProjectLockRegistry();
    await locks.withLock('/repo', async () => 1);
    await new Promise((r) => setImmediate(r));
    expect(locks.size()).toBe(0);
  });
});
