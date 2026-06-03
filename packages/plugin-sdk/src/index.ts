/**
 * `@symphony/plugin-sdk` — author Symphony plugins with typed tools and
 * event handlers instead of hand-rolling an MCP server.
 *
 * ```ts
 * import { createPlugin } from '@symphony/plugin-sdk';
 *
 * await createPlugin({ id: 'my-plugin', name: 'My Plugin', version: '0.1.0' })
 *   .tool({
 *     name: 'greet',
 *     description: 'Return a greeting.',
 *     inputSchema: { who: z.string() },
 *     handler: ({ who }) => `Hello, ${who}!`,
 *   })
 *   .onTaskCompleted((e) => console.error(`task ${e.taskId} done`))
 *   .serve();
 * ```
 *
 * Pair this with a `plugin.json` manifest (validate it with
 * `validateManifest` / author it with `defineManifest`) describing the
 * spawn recipe + security envelope the Symphony user consents to at install.
 */

export {
  createPlugin,
  PluginBuilder,
  PLUGIN_API_VERSION,
  SYMPHONY_META_EVENT_HANDLER,
  SYMPHONY_META_PERMISSIONS,
  type CreatePluginInput,
  type ToolDefinition,
  type ToolResult,
  type RawShape,
  type InferArgs,
} from './plugin.js';

export {
  validateManifest,
  defineManifest,
  assertSafePluginId,
  PluginManifestError,
  MANIFEST_SCHEMA_VERSION,
  MANIFEST_CAPABILITY_FLAGS,
  PLUGIN_EVENTS,
  FIXED_PERMISSIONS,
  type PluginManifest,
  type DefineManifestInput,
  type ManifestCapabilityFlag,
  type PluginEvent,
  type FixedPermission,
  type PluginPermission,
} from './manifest.js';

export {
  eventToHandlerTool,
  type PluginEventPayloads,
  type TaskCreatedEvent,
  type TaskCompletedEvent,
  type TaskFailedEvent,
  type WorkerSpawnedEvent,
  type WorkerCompletedEvent,
} from './events.js';
