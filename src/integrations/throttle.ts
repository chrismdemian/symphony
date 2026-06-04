/**
 * Serialized request throttle — shared by every integration connector.
 *
 * Extracted from the Notion connector (Phase 8A) so Linear / GitHub / the
 * later 8C connectors share one rate limiter. Chains every call so the
 * `fn()`s run one-at-a-time (never overlapping) with at least `minGapMs`
 * between request starts. A rejected call does NOT break the chain — the next
 * call still runs. Both the inter-request wait AND the request body are part
 * of the serialized chain, so fire-and-forget callers (e.g. the writeback hook
 * firing on N simultaneous task completions) can't issue overlapping HTTP
 * requests. (8A audit-M1.)
 */
export class RequestThrottle {
  private last = 0;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly minGapMs: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = defaultSleep,
  ) {}

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.chain.then(async () => {
      const elapsed = this.now() - this.last;
      const wait = this.minGapMs - elapsed;
      if (wait > 0) await this.sleep(wait);
      this.last = this.now();
      return fn();
    });
    // The NEXT call's gate waits for THIS call's fn() to settle (so calls
    // never overlap). Swallow the outcome here so one rejection doesn't
    // poison the chain — the caller still observes it via `result`.
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // Don't keep the event loop alive solely for a throttle gap.
    if (typeof timer.unref === 'function') timer.unref();
  });
}
