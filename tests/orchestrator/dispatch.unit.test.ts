import { describe, expect, it } from 'vitest';
import { CapabilityEvaluator, DEFAULT_DISPATCH_CONTEXT } from '../../src/orchestrator/capabilities.js';
import { wrapToolHandler } from '../../src/orchestrator/dispatch.js';
import { AgentSafetyGuard } from '../../src/orchestrator/safety.js';
import type { DispatchContext } from '../../src/orchestrator/types.js';

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function baseCtx(overrides: Partial<DispatchContext> = {}): DispatchContext {
  return { ...DEFAULT_DISPATCH_CONTEXT, ...overrides };
}

describe('wrapToolHandler structuredContent budget (2A.2 M3 fix)', () => {
  it('charges structuredContent against the safety budget alongside text content', async () => {
    const safety = new AgentSafetyGuard();
    const handler = wrapToolHandler({
      name: 'big',
      scope: 'act',
      capabilities: [],
      safety,
      capabilityEvaluator: new CapabilityEvaluator(),
      getContext: () => baseCtx({ mode: 'act' }),
      handler: () => ({
        content: [{ type: 'text' as const, text: 'tiny' }],
        structuredContent: { blob: 'x'.repeat(20_000) },
      }),
    });
    const before = safety.getStats().estimatedTokens;
    await handler({});
    const after = safety.getStats().estimatedTokens;
    // `estimateTokens` is chars/4; 20_000 chars of payload → ~5_000 tokens minimum.
    expect(after - before).toBeGreaterThan(3_000);
  });

  it('still skips budget accounting for isError responses regardless of structuredContent size', async () => {
    const safety = new AgentSafetyGuard();
    const handler = wrapToolHandler({
      name: 'denied',
      scope: 'plan',
      capabilities: [],
      safety,
      capabilityEvaluator: new CapabilityEvaluator(),
      getContext: () => baseCtx({ mode: 'act' }),
      handler: () => ({
        content: [{ type: 'text' as const, text: 'irrelevant' }],
        structuredContent: { huge: 'x'.repeat(50_000) },
      }),
    });
    const before = safety.getStats().estimatedTokens;
    await handler({});
    const after = safety.getStats().estimatedTokens;
    expect(after).toBe(before);
  });
});

describe('wrapToolHandler', () => {
  it('invokes the handler on the happy path and returns its result', async () => {
    const handler = wrapToolHandler({
      name: 'echo',
      scope: 'both',
      capabilities: [],
      handler: async (args: { x: string }) => ok(`got ${args.x}`),
      safety: new AgentSafetyGuard(),
      capabilityEvaluator: new CapabilityEvaluator(),
      getContext: () => baseCtx(),
    });
    const result = await handler({ x: 'hi' });
    expect(result.isError).toBeFalsy();
    expect(result.content[0]).toEqual({ type: 'text', text: 'got hi' });
  });

  it('returns isError when tool scope conflicts with mode', async () => {
    const handler = wrapToolHandler({
      name: 'propose_plan',
      scope: 'plan',
      capabilities: [],
      handler: async () => ok('plan body'),
      safety: new AgentSafetyGuard(),
      capabilityEvaluator: new CapabilityEvaluator(),
      getContext: () => baseCtx({ mode: 'act' }),
    });
    const result = await handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/not available in act mode/);
  });

  it('returns isError when capabilities evaluator denies', async () => {
    const handler = wrapToolHandler({
      name: 'edit_file',
      scope: 'act',
      capabilities: ['writes-source'],
      handler: async () => ok('edited'),
      safety: new AgentSafetyGuard(),
      capabilityEvaluator: new CapabilityEvaluator(),
      getContext: () => baseCtx({ mode: 'act', tier: 3 }),
    });
    const result = await handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/delegator/i);
  });

  it('returns isError when safety guard rejects loop', async () => {
    const safety = new AgentSafetyGuard();
    const handler = wrapToolHandler({
      name: 'think',
      scope: 'both',
      capabilities: [],
      handler: async () => ok('thought'),
      safety,
      capabilityEvaluator: new CapabilityEvaluator(),
      getContext: () => baseCtx(),
    });
    for (let i = 0; i < 3; i += 1) {
      await handler({ ledger: 'same' });
    }
    const result = await handler({ ledger: 'same' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/stuck/i);
  });

  it('returns isError when safety guard rejects tool-cap', async () => {
    const safety = new AgentSafetyGuard({ maxToolCalls: 2 });
    const handler = wrapToolHandler({
      name: 'think',
      scope: 'both',
      capabilities: [],
      handler: async () => ok('thought'),
      safety,
      capabilityEvaluator: new CapabilityEvaluator(),
      getContext: () => baseCtx(),
    });
    await handler({ i: 1 });
    await handler({ i: 2 });
    const result = await handler({ i: 3 });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/simpler/i);
  });

  it('converts unexpected thrown Error into isError text', async () => {
    const handler = wrapToolHandler({
      name: 'crash',
      scope: 'both',
      capabilities: [],
      handler: async () => {
        throw new Error('boom');
      },
      safety: new AgentSafetyGuard(),
      capabilityEvaluator: new CapabilityEvaluator(),
      getContext: () => baseCtx(),
    });
    const result = await handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/boom/);
  });

  it('does NOT charge the safety budget for isError responses', async () => {
    const safety = new AgentSafetyGuard({ maxContextTokens: 1000 });
    const handler = wrapToolHandler({
      name: 'deny',
      scope: 'plan',
      capabilities: [],
      handler: async () => ok('should not reach'),
      safety,
      capabilityEvaluator: new CapabilityEvaluator(),
      getContext: () => baseCtx({ mode: 'act' }),
    });
    const before = safety.getStats().estimatedTokens;
    const result = await handler({});
    expect(result.isError).toBe(true);
    expect(safety.getStats().estimatedTokens).toBe(before);
  });

  it('propagates an AbortSignal into the DispatchContext', async () => {
    const controller = new AbortController();
    let observed: AbortSignal | undefined;
    const handler = wrapToolHandler({
      name: 'obs',
      scope: 'both',
      capabilities: [],
      handler: async (_args, ctx) => {
        observed = ctx.signal;
        return ok('seen');
      },
      safety: new AgentSafetyGuard(),
      capabilityEvaluator: new CapabilityEvaluator(),
      getContext: () => baseCtx(),
    });
    await handler({}, controller.signal);
    expect(observed).toBe(controller.signal);
  });

  it('records response tokens against the safety budget', async () => {
    const safety = new AgentSafetyGuard({ maxContextTokens: 100 });
    const handler = wrapToolHandler({
      name: 'big',
      scope: 'both',
      capabilities: [],
      handler: async () => ok('x'.repeat(80)),
      safety,
      capabilityEvaluator: new CapabilityEvaluator(),
      getContext: () => baseCtx(),
    });
    await handler({});
    expect(safety.getStats().estimatedTokens).toBe(20);
  });

  it('getContext is called fresh for each dispatch', async () => {
    let mode: 'plan' | 'act' = 'plan';
    const handler = wrapToolHandler({
      name: 'propose_plan',
      scope: 'plan',
      capabilities: [],
      handler: async () => ok('plan'),
      safety: new AgentSafetyGuard(),
      capabilityEvaluator: new CapabilityEvaluator(),
      getContext: () => baseCtx({ mode }),
    });
    expect((await handler({})).isError).toBeFalsy();
    mode = 'act';
    expect((await handler({})).isError).toBe(true);
  });
});
