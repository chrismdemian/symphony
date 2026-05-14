import { describe, expect, it } from 'vitest';
import { CapabilityEvaluator, DEFAULT_DISPATCH_CONTEXT } from '../../src/orchestrator/capabilities.js';
import type { CapabilityFlag, DispatchContext } from '../../src/orchestrator/types.js';

function ctx(overrides: Partial<DispatchContext> = {}): DispatchContext {
  return { ...DEFAULT_DISPATCH_CONTEXT, ...overrides };
}

describe('CapabilityEvaluator', () => {
  const evaluator = new CapabilityEvaluator();

  it('allows a no-flag tool in any mode and tier', () => {
    expect(evaluator.evaluate([], ctx()).allow).toBe(true);
    expect(evaluator.evaluate([], ctx({ mode: 'act', tier: 1 })).allow).toBe(true);
    expect(evaluator.evaluate([], ctx({ mode: 'act', tier: 3 })).allow).toBe(true);
  });

  it('rejects writes-source unconditionally (delegator-never-edits-source)', () => {
    const flags: CapabilityFlag[] = ['writes-source'];
    for (const mode of ['plan', 'act'] as const) {
      for (const tier of [1, 2, 3] as const) {
        const result = evaluator.evaluate(flags, ctx({ mode, tier }));
        expect(result.allow).toBe(false);
        expect(result.reason).toMatch(/delegator/i);
      }
    }
  });

  it('rejects host-browser-control in plan mode', () => {
    const result = evaluator.evaluate(['requires-host-browser-control'], ctx({ mode: 'plan', tier: 3 }));
    expect(result.allow).toBe(false);
    expect(result.reason).toMatch(/act mode/i);
  });

  it('rejects host-browser-control below tier 3', () => {
    const result = evaluator.evaluate(['requires-host-browser-control'], ctx({ mode: 'act', tier: 2 }));
    expect(result.allow).toBe(false);
    expect(result.reason).toMatch(/tier 3/i);
  });

  it('rejects host-browser-control in away mode', () => {
    const result = evaluator.evaluate(
      ['requires-host-browser-control'],
      ctx({ mode: 'act', tier: 3, awayMode: true }),
    );
    expect(result.allow).toBe(false);
    expect(result.reason).toMatch(/away mode/i);
  });

  it('rejects host-browser-control in automation context', () => {
    const result = evaluator.evaluate(
      ['requires-host-browser-control'],
      ctx({ mode: 'act', tier: 3, automationContext: true }),
    );
    expect(result.allow).toBe(false);
    expect(result.reason).toMatch(/automation/i);
  });

  it('allows host-browser-control only when act + tier 3 + !away + !automation', () => {
    const result = evaluator.evaluate(['requires-host-browser-control'], ctx({ mode: 'act', tier: 3 }));
    expect(result.allow).toBe(true);
  });

  it('rejects irreversible below tier 3', () => {
    expect(evaluator.evaluate(['irreversible'], ctx({ tier: 1 })).allow).toBe(false);
    expect(evaluator.evaluate(['irreversible'], ctx({ tier: 2 })).allow).toBe(false);
    expect(evaluator.evaluate(['irreversible'], ctx({ tier: 3 })).allow).toBe(true);
  });

  it('rejects external-visible below tier 2', () => {
    expect(evaluator.evaluate(['external-visible'], ctx({ tier: 1 })).allow).toBe(false);
    expect(evaluator.evaluate(['external-visible'], ctx({ tier: 2 })).allow).toBe(true);
    expect(evaluator.evaluate(['external-visible'], ctx({ tier: 3 })).allow).toBe(true);
  });

  // Phase 3S — new tier-floor checks.

  it('rejects requires-secrets-read below tier 2 (3S)', () => {
    const e = new CapabilityEvaluator();
    expect(e.evaluate(['requires-secrets-read'], ctx({ tier: 1 })).allow).toBe(false);
    expect(e.evaluate(['requires-secrets-read'], ctx({ tier: 2 })).allow).toBe(true);
    expect(e.evaluate(['requires-secrets-read'], ctx({ tier: 3 })).allow).toBe(true);
  });

  it('rejects requires-network-egress-uncontrolled below tier 2 (3S)', () => {
    const e = new CapabilityEvaluator();
    expect(
      e.evaluate(['requires-network-egress-uncontrolled'], ctx({ tier: 1 })).allow,
    ).toBe(false);
    expect(
      e.evaluate(['requires-network-egress-uncontrolled'], ctx({ tier: 2 })).allow,
    ).toBe(true);
    expect(
      e.evaluate(['requires-network-egress-uncontrolled'], ctx({ tier: 3 })).allow,
    ).toBe(true);
  });

  // Phase 3S — first-use notice.

  it('emits first-use notice on first secrets-read at tier 2 (3S)', () => {
    const e = new CapabilityEvaluator();
    const first = e.evaluate(['requires-secrets-read'], ctx({ tier: 2 }), 'secrets_get');
    expect(first.allow).toBe(true);
    expect(first.notice).toEqual({
      kind: 'first-use',
      tool: 'secrets_get',
      flag: 'requires-secrets-read',
    });
  });

  it('skips notice on repeat secrets-read for the same tool (3S)', () => {
    const e = new CapabilityEvaluator();
    e.evaluate(['requires-secrets-read'], ctx({ tier: 2 }), 'secrets_get');
    const second = e.evaluate(['requires-secrets-read'], ctx({ tier: 2 }), 'secrets_get');
    expect(second.allow).toBe(true);
    expect(second.notice).toBeUndefined();
  });

  it('emits notice per (tool) pair independently (3S)', () => {
    const e = new CapabilityEvaluator();
    const a = e.evaluate(['requires-secrets-read'], ctx({ tier: 2 }), 'secrets_get');
    const b = e.evaluate(['requires-secrets-read'], ctx({ tier: 2 }), 'secrets_put');
    expect(a.notice?.tool).toBe('secrets_get');
    expect(b.notice?.tool).toBe('secrets_put');
  });

  it('does not emit notice at tier 3 (3S — confirm tier is its own signal)', () => {
    const e = new CapabilityEvaluator();
    const result = e.evaluate(['requires-secrets-read'], ctx({ tier: 3 }), 'secrets_get');
    expect(result.allow).toBe(true);
    expect(result.notice).toBeUndefined();
  });

  it('does not emit notice at tier 1 (3S — denied before notice path)', () => {
    const e = new CapabilityEvaluator();
    const result = e.evaluate(['requires-secrets-read'], ctx({ tier: 1 }), 'secrets_get');
    expect(result.allow).toBe(false);
    expect(result.notice).toBeUndefined();
  });

  it('does not emit notice for network-egress-uncontrolled (3S — no first-use for this flag)', () => {
    const e = new CapabilityEvaluator();
    const result = e.evaluate(
      ['requires-network-egress-uncontrolled'],
      ctx({ tier: 2 }),
      'fetch_url',
    );
    expect(result.allow).toBe(true);
    expect(result.notice).toBeUndefined();
  });

  it('skips notice when toolName is omitted (3S — preserves 2A.1 evaluator-only callers)', () => {
    const e = new CapabilityEvaluator();
    const result = e.evaluate(['requires-secrets-read'], ctx({ tier: 2 }));
    expect(result.allow).toBe(true);
    expect(result.notice).toBeUndefined();
  });

  it('resetFirstUseTracker re-arms first-use emission (3S)', () => {
    const e = new CapabilityEvaluator();
    e.evaluate(['requires-secrets-read'], ctx({ tier: 2 }), 'secrets_get');
    const afterReset = e.evaluate(['requires-secrets-read'], ctx({ tier: 2 }), 'secrets_get');
    expect(afterReset.notice).toBeUndefined();
    e.resetFirstUseTracker();
    const refired = e.evaluate(['requires-secrets-read'], ctx({ tier: 2 }), 'secrets_get');
    expect(refired.notice?.tool).toBe('secrets_get');
  });
});
