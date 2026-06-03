import type { ToolRegistration } from '../orchestrator/registry.js';
import { jsonSchemaToZodRawShape } from './json-schema-to-zod.js';
import { translateCapabilityFlags } from './permissions.js';
import type { PluginManifest } from './manifest.js';
import type { PluginCallResult, PluginToolDescriptor } from './client.js';

/**
 * Phase 7A — build a Symphony `ToolRegistration` that proxies a single
 * plugin tool.
 *
 * The proxy carries the plugin's TRANSLATED capability flags (so the
 * existing `CapabilityEvaluator` gates it by tier/away/automation) and the
 * manifest's `toolScope`. The handler forwards the call to the plugin
 * subprocess via the supplied `callTool` closure and maps the MCP result
 * back into Symphony's `ToolHandlerReturn`. Because registration happens
 * in Symphony's own `ToolRegistry`, every Maestro→plugin call routes
 * through `wrapToolHandler` — scope check, capability policy, safety
 * budget, and the non-defeatable audit row — before a byte reaches the
 * plugin process.
 */

export interface BuildProxyToolInput {
  readonly pluginId: string;
  readonly manifest: PluginManifest;
  readonly descriptor: PluginToolDescriptor;
  /** Forwarder bound to the owning PluginClient. */
  readonly callTool: (toolName: string, args: Record<string, unknown>) => Promise<PluginCallResult>;
}

/**
 * The `<plugin-id>__<tool-name>` namespace separator.
 *
 * Double-underscore, NOT the `:` the PLAN sketched — Anthropic API tool
 * names (which Claude Code derives from MCP tool names) match only
 * `[A-Za-z0-9_-]`, so `:` would be rejected by Maestro's own client.
 * `__` is the same convention Claude Code uses for MCP tools
 * (`mcp__server__tool`): API-safe and visually distinct. The plugin id
 * charset excludes `.`/`:` but allows single `_`/`-`, so `__` stays the
 * least-ambiguous available separator.
 */
export const PLUGIN_TOOL_SEPARATOR = '__' as const;

export function proxyToolName(pluginId: string, toolName: string): string {
  return `${pluginId}${PLUGIN_TOOL_SEPARATOR}${toolName}`;
}

export function buildProxyToolRegistration(
  input: BuildProxyToolInput,
): ToolRegistration<Record<string, never>> {
  const { pluginId, manifest, descriptor, callTool } = input;
  const name = proxyToolName(pluginId, descriptor.name);
  const capabilities = translateCapabilityFlags(manifest.capabilityFlags);
  const inputSchema = jsonSchemaToZodRawShape(descriptor.inputSchema);

  return {
    name,
    description:
      descriptor.description ?? `Plugin '${pluginId}' tool '${descriptor.name}'.`,
    scope: manifest.toolScope,
    capabilities,
    // `inputSchema` is a Record<string, ZodTypeAny>, assignable to the
    // generic shape; cast keeps the registration typed as no-static-shape.
    inputSchema: inputSchema as unknown as Record<string, never>,
    handler: async (args) => {
      const result = await callTool(descriptor.name, (args ?? {}) as Record<string, unknown>);
      return {
        content: result.content,
        ...(result.structuredContent !== undefined
          ? { structuredContent: result.structuredContent }
          : {}),
        ...(result.isError ? { isError: true } : {}),
      };
    },
  };
}
