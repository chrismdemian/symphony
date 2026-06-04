import { describe, expect, it } from 'vitest';
import { RequestThrottle } from '../../src/integrations/throttle.js';

/**
 * Phase 8C — the shared throttle (extracted from the Notion connector). Verifies
 * the 8A audit-M1 invariants: calls never overlap, the inter-request gap is
 * honored, and a rejected call doesn't poison the chain.
 */
describe('RequestThrottle', () => {
  it('serializes calls — the next fn() starts only after the prior settles', async () => {
    const events: string[] = [];
    const sleep = (): Promise<void> => Promise.resolve();
    const t = new RequestThrottle(0, () => 0, sleep);

    const slow = t.run(async () => {
      events.push('a-start');
      await new Promise((r) => setImmediate(r));
      events.push('a-end');
      return 'a';
    });
    const fast = t.run(async () => {
      events.push('b-start');
      return 'b';
    });
    expect(await Promise.all([slow, fast])).toEqual(['a', 'b']);
    // b only starts after a fully ends (serialized, never overlapping).
    expect(events).toEqual(['a-start', 'a-end', 'b-start']);
  });

  it('enforces the minimum gap between request starts', async () => {
    // Start the clock past the gap so the first call (elapsed >= gap) doesn't wait.
    let clock = 1000;
    const waits: number[] = [];
    const sleep = (ms: number): Promise<void> => {
      waits.push(ms);
      clock += ms;
      return Promise.resolve();
    };
    const t = new RequestThrottle(100, () => clock, sleep);
    await t.run(async () => 1); // first call: elapsed huge → no wait
    await t.run(async () => 2); // immediately after → must wait the full gap
    expect(waits).toEqual([100]);
  });

  it('a rejected call does not poison the chain', async () => {
    const t = new RequestThrottle(0, () => 0, () => Promise.resolve());
    await expect(t.run(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    // The next call still runs.
    expect(await t.run(async () => 'ok')).toBe('ok');
  });
});
