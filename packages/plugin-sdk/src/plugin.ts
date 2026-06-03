import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { PLUGIN_API_VERSION } from './manifest.js';
import type { PluginPermission } from './manifest.js';
import {
  eventToHandlerTool,
  type PluginEventPayloads,
  type TaskCompletedEvent,
  type TaskCreatedEvent,
  type TaskFailedEvent,
  type WorkerCompletedEvent,
  type WorkerSpawnedEvent,
} from './events.js';

/**
 * `@symphony/plugin-sdk` — the `createPlugin(...)` builder.
 *
 * A Symphony plugin is an MCP *server* over stdio. This builder wraps
 * `@modelcontextprotocol/sdk`'s `McpServer` so an author declares tools and
 * typed event handlers, then calls `.serve()` to connect the stdio
 * transport. Symphony's plugin host (the MCP *client*) discovers the tools
 * via `listTools()`, re-registers each as a namespaced proxy behind its
 * capability + audit enforcement, and CALLS the `on_<event>` handler tools
 * when subscribed events fire.
 *
 * Metadata the SDK attaches via MCP `_meta` (the designed passthrough for
 * arbitrary tool metadata, which round-trips through `listTools()`):
 *   - `symphony/eventHandler: true` on every `on_<event>` tool, so the host
 *     can keep it OUT of Maestro's toolbelt (it's a notification sink, not
 *     a callable tool).
 *   - `symphony/permissions: string[]` on a tool, so the host can map the
 *     tool to the manifest permissions it needs (consent ceiling).
 */

/** A ZodRawShape — a record of property name → Zod type. */
export type RawShape = Record<string, z.ZodTypeAny>;

/** Args inferred from a raw shape (object of inferred property types). */
export type InferArgs<TShape extends RawShape> = {
  [K in keyof TShape]: z.infer<TShape[K]>;
};

/** What a tool handler may return. A bare string is wrapped as text. */
export type ToolResult =
  | string
  | {
      content?: Array<{ type: 'text'; text: string }>;
      structuredContent?: Record<string, unknown>;
      isError?: boolean;
      /** Convenience — wrapped into a single text content block. */
      text?: string;
    };

export interface ToolDefinition<TShape extends RawShape = RawShape> {
  readonly name: string;
  readonly description: string;
  /** Zod raw shape for the tool's input. Omit for a no-argument tool. */
  readonly inputSchema?: TShape;
  /**
   * Manifest permissions this tool requires (consent ceiling). MUST be a
   * subset of the plugin's declared manifest `permissions`, else the host
   * refuses to register the tool (fail-closed). Attached via `_meta`.
   */
  readonly permissions?: readonly PluginPermission[];
  readonly handler: (args: InferArgs<TShape>) => ToolResult | Promise<ToolResult>;
}

/** Internal: the `_meta` keys the host reads. */
export const SYMPHONY_META_EVENT_HANDLER = 'symphony/eventHandler' as const;
export const SYMPHONY_META_PERMISSIONS = 'symphony/permissions' as const;

/**
 * Permissive Zod raw shapes for the delivered events. The TS payload types
 * (in `events.ts`) stay precise for the author's handler signature; these
 * runtime shapes are deliberately loose so a host payload that gains a
 * field (or a literal that widens) can never make event delivery fail MCP
 * input validation. The handler receives the parsed args cast to the typed
 * payload.
 *
 * TWO-SITE COUPLING: MCP validates `arguments` through `z.object(shape)`,
 * which STRIPS unknown keys before the handler runs. So a NEW host payload
 * field must be added in BOTH places to reach plugins: the TS type in
 * `events.ts` (compile-time) AND the matching entry here (runtime). The
 * manifest drift-lock test does NOT cover these shapes — they track
 * `src/orchestrator/server.ts`'s `dispatchEvent(...)` payloads.
 */
const EVENT_INPUT_SHAPES: Record<keyof PluginEventPayloads, RawShape> = {
  onTaskCreated: {
    taskId: z.string(),
    projectId: z.string().nullable().optional(),
    description: z.string().optional(),
    status: z.string().optional(),
  },
  onTaskCompleted: {
    taskId: z.string(),
    projectId: z.string().nullable().optional(),
    status: z.string().optional(),
  },
  onTaskFailed: {
    taskId: z.string(),
    projectId: z.string().nullable().optional(),
    status: z.string().optional(),
  },
  onWorkerSpawned: {
    workerId: z.string(),
    role: z.string().optional(),
    featureIntent: z.string().optional(),
    projectId: z.string().nullable().optional(),
    taskId: z.string().nullable().optional(),
  },
  onWorkerCompleted: {
    workerId: z.string(),
    role: z.string().optional(),
    status: z.string().optional(),
    featureIntent: z.string().optional(),
    projectId: z.string().nullable().optional(),
    taskId: z.string().nullable().optional(),
  },
  onVoiceTranscript: {},
  onUserCommand: {},
};

function normalizeResult(result: ToolResult): {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
} {
  if (typeof result === 'string') {
    return { content: [{ type: 'text', text: result }] };
  }
  const content = result.content ?? (result.text !== undefined ? [{ type: 'text' as const, text: result.text }] : []);
  return {
    content,
    ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
    ...(result.isError === true ? { isError: true } : {}),
  };
}

export interface CreatePluginInput {
  readonly id: string;
  readonly name: string;
  readonly version: string;
}

export class PluginBuilder {
  private readonly server: McpServer;
  private readonly registeredEvents = new Set<string>();

  constructor(input: CreatePluginInput) {
    this.server = new McpServer(
      { name: input.id, version: input.version },
      { capabilities: { tools: {} } },
    );
  }

  /** Register a callable tool. Chainable. */
  tool<TShape extends RawShape = Record<string, never>>(def: ToolDefinition<TShape>): this {
    const meta: Record<string, unknown> = {};
    if (def.permissions !== undefined && def.permissions.length > 0) {
      meta[SYMPHONY_META_PERMISSIONS] = [...def.permissions];
    }
    this.server.registerTool(
      def.name,
      {
        description: def.description,
        ...(def.inputSchema !== undefined ? { inputSchema: def.inputSchema } : {}),
        ...(Object.keys(meta).length > 0 ? { _meta: meta } : {}),
      },
      // The SDK callback receives validated args; forward to the user
      // handler and normalize the result into a CallToolResult.
      (async (args: InferArgs<TShape>) => normalizeResult(await def.handler(args))) as never,
    );
    return this;
  }

  /** Subscribe to a delivered event by registering its `on_<event>` handler tool. */
  private onEvent<K extends keyof PluginEventPayloads>(
    event: K,
    handler: (payload: PluginEventPayloads[K]) => void | Promise<void>,
  ): this {
    const toolName = eventToHandlerTool(event);
    if (this.registeredEvents.has(toolName)) {
      throw new Error(`event '${event}' already has a handler registered`);
    }
    this.registeredEvents.add(toolName);
    this.server.registerTool(
      toolName,
      {
        description: `Symphony event handler for '${event}' (not a user-callable tool).`,
        inputSchema: EVENT_INPUT_SHAPES[event],
        _meta: { [SYMPHONY_META_EVENT_HANDLER]: true },
      },
      (async (args: Record<string, unknown>) => {
        await handler(args as unknown as PluginEventPayloads[K]);
        // Best-effort ack; the host fires events fire-and-forget.
        return { content: [{ type: 'text' as const, text: 'ok' }] };
      }) as never,
    );
    return this;
  }

  onTaskCreated(handler: (e: TaskCreatedEvent) => void | Promise<void>): this {
    return this.onEvent('onTaskCreated', handler);
  }
  onTaskCompleted(handler: (e: TaskCompletedEvent) => void | Promise<void>): this {
    return this.onEvent('onTaskCompleted', handler);
  }
  onTaskFailed(handler: (e: TaskFailedEvent) => void | Promise<void>): this {
    return this.onEvent('onTaskFailed', handler);
  }
  onWorkerSpawned(handler: (e: WorkerSpawnedEvent) => void | Promise<void>): this {
    return this.onEvent('onWorkerSpawned', handler);
  }
  onWorkerCompleted(handler: (e: WorkerCompletedEvent) => void | Promise<void>): this {
    return this.onEvent('onWorkerCompleted', handler);
  }

  /** Underlying MCP server (escape hatch for advanced authors / tests). */
  get mcpServer(): McpServer {
    return this.server;
  }

  /**
   * Connect the stdio transport and start serving. Resolves once connected;
   * the process then lives as long as Symphony keeps the subprocess open.
   * Pass a custom transport (e.g. an in-memory pair) for tests.
   */
  async serve(transport?: Parameters<McpServer['connect']>[0]): Promise<void> {
    await this.server.connect(transport ?? new StdioServerTransport());
  }
}

export function createPlugin(input: CreatePluginInput): PluginBuilder {
  return new PluginBuilder(input);
}

export { PLUGIN_API_VERSION };
