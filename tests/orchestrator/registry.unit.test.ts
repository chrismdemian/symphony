import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CapabilityEvaluator, DEFAULT_DISPATCH_CONTEXT } from '../../src/orchestrator/capabilities.js';
import { ModeController } from '../../src/orchestrator/mode.js';
import { DuplicateToolRegistrationError, ToolRegistry } from '../../src/orchestrator/registry.js';
import { AgentSafetyGuard } from '../../src/orchestrator/safety.js';
import type { DispatchContext, ToolMode } from '../../src/orchestrator/types.js';

interface Harness {
  server: McpServer;
  mode: ModeController;
  registry: ToolRegistry;
  ctx: DispatchContext;
}

function makeHarness(initial: ToolMode = 'plan'): Harness {
  const server = new McpServer({ name: 'test', version: '0.0.0' }, { capabilities: { tools: { listChanged: true } } });
  const mode = new ModeController({ initial });
  const ctx: DispatchContext = { ...DEFAULT_DISPATCH_CONTEXT, mode: initial };
  const registry = new ToolRegistry({
    server,
    mode,
    safety: new AgentSafetyGuard(),
    capabilityEvaluator: new CapabilityEvaluator(),
    getContext: () => ({ ...ctx, mode: mode.mode }),
  });
  return { server, mode, registry, ctx };
}

describe('ToolRegistry', () => {
  it('registers a both-scope tool and it is enabled in any mode', () => {
    const h = makeHarness('plan');
    h.registry.register({
      name: 'think',
      description: 'think',
      scope: 'both',
      inputSchema: { thought: z.string() },
      handler: () => ({ content: [{ type: 'text', text: 'ok' }] }),
    });
    expect(h.registry.list()).toEqual([{ name: 'think', scope: 'both', capabilities: [], enabled: true }]);
    h.mode.setMode('act');
    expect(h.registry.list()[0]?.enabled).toBe(true);
  });

  it('disables a plan-scoped tool when switching to act', () => {
    const h = makeHarness('plan');
    h.registry.register({
      name: 'propose_plan',
      description: 'propose',
      scope: 'plan',
      inputSchema: { plan: z.string() },
      handler: () => ({ content: [{ type: 'text', text: 'plan' }] }),
    });
    expect(h.registry.list()[0]?.enabled).toBe(true);
    h.mode.setMode('act');
    expect(h.registry.list()[0]?.enabled).toBe(false);
  });

  it('enables an act-scoped tool when switching to act', () => {
    const h = makeHarness('plan');
    h.registry.register({
      name: 'spawn_worker',
      description: 'spawn',
      scope: 'act',
      inputSchema: { task: z.string() },
      handler: () => ({ content: [{ type: 'text', text: 'spawned' }] }),
    });
    expect(h.registry.list()[0]?.enabled).toBe(false);
    h.mode.setMode('act');
    expect(h.registry.list()[0]?.enabled).toBe(true);
  });

  it('registering while disabled scope immediately disables the handle', () => {
    const h = makeHarness('act');
    h.registry.register({
      name: 'propose_plan',
      description: 'propose',
      scope: 'plan',
      inputSchema: { plan: z.string() },
      handler: () => ({ content: [{ type: 'text', text: 'plan' }] }),
    });
    expect(h.registry.list()[0]?.enabled).toBe(false);
  });

  it('rejects duplicate tool-name registration with a Symphony-prefixed error', () => {
    const h = makeHarness('plan');
    h.registry.register({
      name: 'think',
      description: 'think',
      scope: 'both',
      inputSchema: { thought: z.string() },
      handler: () => ({ content: [{ type: 'text', text: 'a' }] }),
    });
    try {
      h.registry.register({
        name: 'think',
        description: 'conflict',
        scope: 'both',
        inputSchema: { thought: z.string() },
        handler: () => ({ content: [{ type: 'text', text: 'b' }] }),
      });
      throw new Error('expected duplicate rejection');
    } catch (err) {
      expect(err).toBeInstanceOf(DuplicateToolRegistrationError);
      expect((err as Error).message).toMatch(/\[orchestrator\] duplicate tool registration: think/);
      expect((err as DuplicateToolRegistrationError).toolName).toBe('think');
    }
  });

  it('list() exposes capability flags alongside name/scope/enabled', () => {
    const h = makeHarness('act');
    h.registry.register({
      name: 'danger',
      description: 'danger',
      scope: 'act',
      capabilities: ['external-visible', 'irreversible'],
      inputSchema: { x: z.string() },
      handler: () => ({ content: [{ type: 'text', text: 'x' }] }),
    });
    const entry = h.registry.list()[0];
    expect(entry?.capabilities).toEqual(['external-visible', 'irreversible']);
  });

  it('close() unsubscribes from mode changes', () => {
    const h = makeHarness('plan');
    h.registry.register({
      name: 'propose_plan',
      description: 'propose',
      scope: 'plan',
      inputSchema: { plan: z.string() },
      handler: () => ({ content: [{ type: 'text', text: 'plan' }] }),
    });
    h.registry.close();
    const enabledBefore = h.registry.list()[0]?.enabled;
    h.mode.setMode('act');
    expect(h.registry.list()[0]?.enabled).toBe(enabledBefore);
  });
});
