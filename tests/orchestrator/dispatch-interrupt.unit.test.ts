import { describe, expect, it, vi } from 'vitest';
import { CapabilityEvaluator, DEFAULT_DISPATCH_CONTEXT } from '../../src/orchestrator/capabilities.js';
import { wrapToolHandler } from '../../src/orchestrator/dispatch.js';
import { AgentSafetyGuard } from '../../src/orchestrator/safety.js';
import type { DispatchContext } from '../../src/orchestrator/types.js';

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function ctx(overrides: Partial<DispatchContext> = {}): DispatchContext {
  return { ...DEFAULT_DISPATCH_CONTEXT, ...overrides };
}

/**
 * Phase 3T — dispatch shim short-circuit. While `ctx.interruptPending`
 * is true, ACT-scope tool calls return `isError: true` with a structured
 * message so Maestro's still-streaming turn can't spawn fresh workers
 * between the `runtime.interrupt` RPC and `turn_completed`. Plan-scope
 * + 'both'-scope tools remain available (Maestro still needs to read
 * state while drafting its acknowledgement).
 */
describe('wrapToolHandler — interrupt-pending short-circuit (3T)', () => {
  it('blocks ACT-scope tools when ctx.interruptPending=true', async () => {
    const handlerSpy = vi.fn(() => ok('should-not-run'));
    const handler = wrapToolHandler({
      name: 'spawn_worker',
      scope: 'act',
      capabilities: [],
      handler: handlerSpy,
      safety: new AgentSafetyGuard(),
      capabilityEvaluator: new CapabilityEvaluator(),
      getContext: () => ctx({ mode: 'act', interruptPending: true }),
    });
    const result = await handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('user pivoted'),
    });
    expect(handlerSpy).not.toHaveBeenCalled();
  });

  it('does NOT block plan-scope tools while interrupt pending (Maestro must still read state)', async () => {
    const handlerSpy = vi.fn(() => ok('list ok'));
    const handler = wrapToolHandler({
      name: 'list_workers',
      scope: 'plan',
      capabilities: [],
      handler: handlerSpy,
      safety: new AgentSafetyGuard(),
      capabilityEvaluator: new CapabilityEvaluator(),
      getContext: () => ctx({ mode: 'plan', interruptPending: true }),
    });
    const result = await handler({});
    expect(result.isError).toBeFalsy();
    expect(handlerSpy).toHaveBeenCalled();
  });

  it('does NOT block both-scope tools (status / lookup operations stay live)', async () => {
    const handlerSpy = vi.fn(() => ok('status ok'));
    const handler = wrapToolHandler({
      name: 'global_status',
      scope: 'both',
      capabilities: [],
      handler: handlerSpy,
      safety: new AgentSafetyGuard(),
      capabilityEvaluator: new CapabilityEvaluator(),
      getContext: () => ctx({ mode: 'act', interruptPending: true }),
    });
    const result = await handler({});
    expect(result.isError).toBeFalsy();
    expect(handlerSpy).toHaveBeenCalled();
  });

  it('does NOT block ACT-scope tools when interruptPending=false (normal operation)', async () => {
    const handlerSpy = vi.fn(() => ok('spawn ok'));
    const handler = wrapToolHandler({
      name: 'spawn_worker',
      scope: 'act',
      capabilities: [],
      handler: handlerSpy,
      safety: new AgentSafetyGuard(),
      capabilityEvaluator: new CapabilityEvaluator(),
      getContext: () => ctx({ mode: 'act', interruptPending: false }),
    });
    const result = await handler({});
    expect(result.isError).toBeFalsy();
    expect(handlerSpy).toHaveBeenCalled();
  });

  it('treats undefined interruptPending as false (legacy contexts)', async () => {
    const handlerSpy = vi.fn(() => ok('spawn ok'));
    const handler = wrapToolHandler({
      name: 'spawn_worker',
      scope: 'act',
      capabilities: [],
      handler: handlerSpy,
      safety: new AgentSafetyGuard(),
      capabilityEvaluator: new CapabilityEvaluator(),
      // omit interruptPending entirely
      getContext: () => ctx({ mode: 'act' }),
    });
    const result = await handler({});
    expect(result.isError).toBeFalsy();
    expect(handlerSpy).toHaveBeenCalled();
  });
});
