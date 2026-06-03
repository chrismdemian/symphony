/**
 * Phase 7A — proxy tool capability enforcement. Builds a proxy registration
 * from a plugin manifest and runs it through the REAL `wrapToolHandler` +
 * `CapabilityEvaluator` to prove the translated capability flags gate the
 * call by tier (the non-defeatable enforcement the PLAN mandates).
 */
import { describe, expect, it, vi } from 'vitest';

import { buildProxyToolRegistration, proxyToolName } from '../../src/plugins/proxy-tool.js';
import { parsePluginManifest } from '../../src/plugins/manifest.js';
import { wrapToolHandler } from '../../src/orchestrator/dispatch.js';
import { CapabilityEvaluator } from '../../src/orchestrator/capabilities.js';
import { AgentSafetyGuard } from '../../src/orchestrator/safety.js';
import type { DispatchContext } from '../../src/orchestrator/types.js';

function manifest(flags: string[]): ReturnType<typeof parsePluginManifest> {
  return parsePluginManifest({
    schemaVersion: 1,
    id: 'p',
    name: 'P',
    version: '1.0.0',
    author: 'me',
    description: 'd',
    entrypoint: { command: 'node', args: ['s.js'] },
    capabilityFlags: flags,
    toolScope: 'act',
  });
}

function ctx(tier: 1 | 2 | 3): DispatchContext {
  return { mode: 'act', tier, awayMode: false, automationContext: false };
}

describe('proxy tool registration', () => {
  it('namespaces the tool name', () => {
    expect(proxyToolName('notion', 'search')).toBe('notion__search');
  });

  it('produces an MCP/Anthropic-charset-valid name (no ":" — regression lock)', () => {
    // Anthropic API tool names match ^[a-zA-Z0-9_-]+$ — a ":" would be
    // rejected by Maestro's own Claude client.
    expect(proxyToolName('my-plugin', 'do_thing')).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('carries translated capability flags + scope', () => {
    const reg = buildProxyToolRegistration({
      pluginId: 'p',
      manifest: manifest(['irreversible', 'requires:network-egress']),
      descriptor: { name: 'do', inputSchema: { type: 'object', properties: {} } },
      callTool: async () => ({ content: [], isError: false }),
    });
    expect(reg.name).toBe('p__do');
    expect(reg.scope).toBe('act');
    expect(reg.capabilities).toEqual(['irreversible', 'requires-network-egress-uncontrolled']);
  });

  it('an irreversible plugin tool is denied below tier 3 and allowed at tier 3', async () => {
    const callTool = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: 'did it' }],
      isError: false,
    }));
    const reg = buildProxyToolRegistration({
      pluginId: 'p',
      manifest: manifest(['irreversible']),
      descriptor: { name: 'destroy', inputSchema: { type: 'object', properties: {} } },
      callTool,
    });

    let context = ctx(1);
    const wrapped = wrapToolHandler({
      name: reg.name,
      scope: reg.scope,
      capabilities: reg.capabilities ?? [],
      handler: reg.handler,
      safety: new AgentSafetyGuard(),
      capabilityEvaluator: new CapabilityEvaluator(),
      getContext: () => context,
    });

    // Tier 1 → denied by capability policy; plugin never called.
    const denied = await wrapped({});
    expect(denied.isError).toBe(true);
    expect(denied.content[0]?.text).toMatch(/capability policy/i);
    expect(callTool).not.toHaveBeenCalled();

    // Tier 3 → allowed; forwards to the plugin.
    context = ctx(3);
    const allowed = await wrapped({});
    expect(allowed.isError).toBeFalsy();
    expect(allowed.content[0]?.text).toBe('did it');
    expect(callTool).toHaveBeenCalledOnce();
  });

  it('maps an isError plugin result through to the proxy', async () => {
    const reg = buildProxyToolRegistration({
      pluginId: 'p',
      manifest: manifest([]),
      descriptor: { name: 'fail', inputSchema: { type: 'object', properties: {} } },
      callTool: async () => ({
        content: [{ type: 'text' as const, text: 'boom' }],
        isError: true,
      }),
    });
    const result = await reg.handler({}, ctx(2));
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe('boom');
  });
});
