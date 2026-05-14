import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod';
import type { CapabilityEvaluator } from './capabilities.js';
import { wrapToolHandler } from './dispatch.js';
import type { ModeController } from './mode.js';
import type { AgentSafetyGuard } from './safety.js';
import type { CapabilityFlag, CapabilityNotice, DispatchContext, ToolScope } from './types.js';

export interface ToolRegistration<TShape extends z.ZodRawShape> {
  name: string;
  description: string;
  title?: string;
  scope: ToolScope;
  capabilities?: readonly CapabilityFlag[];
  inputSchema?: TShape;
  outputSchema?: z.ZodRawShape;
  annotations?: ToolAnnotations;
  handler: (
    args: TShape extends z.ZodRawShape ? { [K in keyof TShape]: z.infer<TShape[K]> } : Record<string, never>,
    ctx: DispatchContext,
  ) => Promise<ToolHandlerReturn> | ToolHandlerReturn;
}

export interface ToolHandlerReturn {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface ToolRegistryOptions {
  server: McpServer;
  mode: ModeController;
  safety: AgentSafetyGuard;
  capabilityEvaluator: CapabilityEvaluator;
  getContext: () => DispatchContext;
  /**
   * Phase 3S — optional sink for capability-decision notices. Forwarded
   * verbatim to `wrapToolHandler.noticeSink`. The CLI server wires this
   * to a logging fan-out for now; Phase 7 (Chrome DevTools MCP plugin —
   * the first real consumer of `requires-secrets-read`) will swap to a
   * proper TUI toast broker so first-use notices surface immediately.
   * Test rigs can omit it.
   */
  noticeSink?: (notice: CapabilityNotice) => void;
}

interface TrackedTool {
  name: string;
  scope: ToolScope;
  capabilities: readonly CapabilityFlag[];
  handle: RegisteredTool;
}

export class DuplicateToolRegistrationError extends Error {
  readonly toolName: string;
  constructor(name: string) {
    super(`[orchestrator] duplicate tool registration: ${name}`);
    this.name = 'DuplicateToolRegistrationError';
    this.toolName = name;
  }
}

export class ToolRegistry {
  private readonly server: McpServer;
  private readonly mode: ModeController;
  private readonly safety: AgentSafetyGuard;
  private readonly capabilityEvaluator: CapabilityEvaluator;
  private readonly getContext: () => DispatchContext;
  private readonly noticeSink?: (notice: CapabilityNotice) => void;
  private readonly tracked: TrackedTool[] = [];
  private readonly byName = new Map<string, TrackedTool>();
  private readonly offModeChange: () => void;

  constructor(opts: ToolRegistryOptions) {
    this.server = opts.server;
    this.mode = opts.mode;
    this.safety = opts.safety;
    this.capabilityEvaluator = opts.capabilityEvaluator;
    this.getContext = opts.getContext;
    this.noticeSink = opts.noticeSink;
    this.offModeChange = this.mode.onChange(() => this.applyMode());
  }

  register<TShape extends z.ZodRawShape>(reg: ToolRegistration<TShape>): RegisteredTool {
    if (this.byName.has(reg.name)) {
      throw new DuplicateToolRegistrationError(reg.name);
    }
    const capabilities = reg.capabilities ?? [];
    const wrapped = wrapToolHandler({
      name: reg.name,
      scope: reg.scope,
      capabilities,
      safety: this.safety,
      capabilityEvaluator: this.capabilityEvaluator,
      getContext: this.getContext,
      ...(this.noticeSink !== undefined ? { noticeSink: this.noticeSink } : {}),
      handler: (args, ctx) =>
        reg.handler(
          args as TShape extends z.ZodRawShape ? { [K in keyof TShape]: z.infer<TShape[K]> } : Record<string, never>,
          ctx,
        ),
    });

    const serverAny = this.server as unknown as {
      registerTool: (
        name: string,
        config: unknown,
        cb: (args: unknown, extra: { signal?: AbortSignal } | undefined) => Promise<CallToolResult>,
      ) => RegisteredTool;
    };

    const handle = serverAny.registerTool(
      reg.name,
      {
        title: reg.title,
        description: reg.description,
        inputSchema: reg.inputSchema,
        outputSchema: reg.outputSchema,
        annotations: reg.annotations,
      },
      async (args: unknown, extra: { signal?: AbortSignal } | undefined): Promise<CallToolResult> => {
        const result = await wrapped(args as Record<string, unknown>, extra?.signal);
        return result as unknown as CallToolResult;
      },
    );

    const entry: TrackedTool = { name: reg.name, scope: reg.scope, capabilities, handle };
    this.tracked.push(entry);
    this.byName.set(reg.name, entry);
    this.applyMode();
    return handle;
  }

  applyMode(): void {
    const mode = this.mode.mode;
    for (const tool of this.tracked) {
      const shouldEnable = tool.scope === 'both' || tool.scope === mode;
      if (shouldEnable && !tool.handle.enabled) tool.handle.enable();
      else if (!shouldEnable && tool.handle.enabled) tool.handle.disable();
    }
  }

  close(): void {
    this.offModeChange();
  }

  list(): Array<{ name: string; scope: ToolScope; capabilities: readonly CapabilityFlag[]; enabled: boolean }> {
    return this.tracked.map((t) => ({
      name: t.name,
      scope: t.scope,
      capabilities: t.capabilities,
      enabled: t.handle.enabled,
    }));
  }
}
