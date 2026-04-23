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
});
