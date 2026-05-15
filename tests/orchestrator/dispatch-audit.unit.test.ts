import { describe, expect, it, vi } from 'vitest';
import {
  CapabilityEvaluator,
  DEFAULT_DISPATCH_CONTEXT,
} from '../../src/orchestrator/capabilities.js';
import {
  wrapToolHandler,
  type ToolAuditRecord,
} from '../../src/orchestrator/dispatch.js';
import { AgentSafetyGuard } from '../../src/orchestrator/safety.js';
import type { DispatchContext } from '../../src/orchestrator/types.js';

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}
function baseCtx(overrides: Partial<DispatchContext> = {}): DispatchContext {
  return { ...DEFAULT_DISPATCH_CONTEXT, ...overrides };
}

describe('wrapToolHandler — Phase 3R auditSink', () => {
  it('emits one ok record per successful dispatch', async () => {
    const audit = vi.fn();
    const handler = wrapToolHandler({
      name: 'echo',
      scope: 'both',
      capabilities: [],
      handler: () => ok('ok'),
      safety: new AgentSafetyGuard(),
      capabilityEvaluator: new CapabilityEvaluator(),
      getContext: () => baseCtx({ mode: 'act', tier: 2 }),
      auditSink: audit,
    });
    await handler({ x: 1 });
    expect(audit).toHaveBeenCalledTimes(1);
    const record = audit.mock.calls[0]?.[0] as ToolAuditRecord;
    expect(record.name).toBe('echo');
    expect(record.scope).toBe('both');
    expect(record.outcome).toBe('ok');
    expect(record.tier).toBe(2);
    expect(record.mode).toBe('act');
    expect(record.args).toEqual({ x: 1 });
    expect(record.reason).toBeUndefined();
  });

  it('emits denied on scope/mode mismatch', async () => {
    const audit = vi.fn();
    const handler = wrapToolHandler({
      name: 'propose_plan',
      scope: 'plan',
      capabilities: [],
      handler: () => ok('plan'),
      safety: new AgentSafetyGuard(),
      capabilityEvaluator: new CapabilityEvaluator(),
      getContext: () => baseCtx({ mode: 'act' }),
      auditSink: audit,
    });
    await handler({});
    expect(audit).toHaveBeenCalledTimes(1);
    const record = audit.mock.calls[0]?.[0] as ToolAuditRecord;
    expect(record.outcome).toBe('denied');
    expect(record.reason).toMatch(/not available in act mode/);
  });

  it('emits denied on capability policy reject', async () => {
    const audit = vi.fn();
    const handler = wrapToolHandler({
      name: 'edit_file',
      scope: 'act',
      capabilities: ['writes-source'],
      handler: () => ok('edited'),
      safety: new AgentSafetyGuard(),
      capabilityEvaluator: new CapabilityEvaluator(),
      // tier 1 → 'writes-source' is denied (needs tier ≥ 2 per evaluator)
      getContext: () => baseCtx({ mode: 'act', tier: 1 }),
      auditSink: audit,
    });
    await handler({});
    expect(audit).toHaveBeenCalledTimes(1);
    const record = audit.mock.calls[0]?.[0] as ToolAuditRecord;
    expect(record.outcome).toBe('denied');
    expect(record.reason).toMatch(/capability policy/);
  });

  it('emits denied on interruptPending ACT-scope block', async () => {
    const audit = vi.fn();
    const handler = wrapToolHandler({
      name: 'spawn_worker',
      scope: 'act',
      capabilities: [],
      handler: () => ok('spawned'),
      safety: new AgentSafetyGuard(),
      capabilityEvaluator: new CapabilityEvaluator(),
      getContext: () => baseCtx({ mode: 'act', interruptPending: true }),
      auditSink: audit,
    });
    await handler({});
    expect(audit).toHaveBeenCalledTimes(1);
    const record = audit.mock.calls[0]?.[0] as ToolAuditRecord;
    expect(record.outcome).toBe('denied');
    expect(record.reason).toMatch(/interrupt pending/);
  });

  it('emits error when handler throws', async () => {
    const audit = vi.fn();
    const handler = wrapToolHandler({
      name: 'broken',
      scope: 'both',
      capabilities: [],
      handler: () => {
        throw new Error('handler boom');
      },
      safety: new AgentSafetyGuard(),
      capabilityEvaluator: new CapabilityEvaluator(),
      getContext: () => baseCtx(),
      auditSink: audit,
    });
    await handler({});
    expect(audit).toHaveBeenCalledTimes(1);
    const record = audit.mock.calls[0]?.[0] as ToolAuditRecord;
    expect(record.outcome).toBe('error');
    expect(record.reason).toMatch(/handler boom/);
  });

  it('emits error when handler returns isError result', async () => {
    const audit = vi.fn();
    const handler = wrapToolHandler({
      name: 'soft_fail',
      scope: 'both',
      capabilities: [],
      handler: () => ({
        content: [{ type: 'text' as const, text: 'nope' }],
        isError: true,
      }),
      safety: new AgentSafetyGuard(),
      capabilityEvaluator: new CapabilityEvaluator(),
      getContext: () => baseCtx(),
      auditSink: audit,
    });
    await handler({});
    expect(audit).toHaveBeenCalledTimes(1);
    expect((audit.mock.calls[0]?.[0] as ToolAuditRecord).outcome).toBe('error');
  });

  it('audit sink failure does not break dispatch', async () => {
    const audit = vi.fn(() => {
      throw new Error('sink boom');
    });
    const handler = wrapToolHandler({
      name: 'echo',
      scope: 'both',
      capabilities: [],
      handler: () => ok('still works'),
      safety: new AgentSafetyGuard(),
      capabilityEvaluator: new CapabilityEvaluator(),
      getContext: () => baseCtx(),
      auditSink: audit,
    });
    const result = await handler({});
    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text).toBe('still works');
  });

  it('audit record carries the args verbatim (sanitization is sink-side)', async () => {
    const audit = vi.fn();
    const handler = wrapToolHandler({
      name: 'with_args',
      scope: 'both',
      capabilities: [],
      handler: () => ok('ok'),
      safety: new AgentSafetyGuard(),
      capabilityEvaluator: new CapabilityEvaluator(),
      getContext: () => baseCtx(),
      auditSink: audit,
    });
    const args = { secret: 'sk_test_a1b2c3d4', nested: { id: 'tk-xyz' } };
    await handler(args);
    const record = audit.mock.calls[0]?.[0] as ToolAuditRecord;
    expect(record.args).toEqual(args);
  });

  it('no auditSink option → no calls, no errors', async () => {
    const handler = wrapToolHandler({
      name: 'noaudit',
      scope: 'both',
      capabilities: [],
      handler: () => ok('ok'),
      safety: new AgentSafetyGuard(),
      capabilityEvaluator: new CapabilityEvaluator(),
      getContext: () => baseCtx(),
    });
    const result = await handler({});
    expect(result.isError).toBeFalsy();
  });
});
