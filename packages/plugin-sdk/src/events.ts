import type { PluginEvent } from './manifest.js';

/**
 * `@symphony/plugin-sdk` — typed event payloads.
 *
 * Symphony's plugin host is the MCP *client*; it cannot push to a plugin
 * (an MCP server). Instead, when a subscribed event fires, the host CALLS
 * the plugin's conventional `on_<event>` tool with the payload as the tool
 * arguments (best-effort, fire-and-forget). The SDK registers those
 * handler tools for you and parses the arguments back into these typed
 * payloads before calling your handler.
 *
 * Every interface here matches BYTE-FOR-BYTE what
 * `src/orchestrator/server.ts` passes to `host.dispatchEvent(...)`. A
 * drift-lock test pins the field set so a host-side payload change can't
 * silently desync the SDK types.
 */

/** camelCase event name → the snake_case handler tool a plugin exposes. */
export function eventToHandlerTool(event: PluginEvent): string {
  return event.replace(/([A-Z])/g, '_$1').toLowerCase();
}

/** Fired when a task transitions to `completed`. */
export interface TaskCompletedEvent {
  readonly taskId: string;
  /** Resolved project id, or null for an unregistered absolute-path project. */
  readonly projectId: string | null;
  readonly status: 'completed';
}

/** Fired when a task transitions to `failed`. */
export interface TaskFailedEvent {
  readonly taskId: string;
  readonly projectId: string | null;
  readonly status: 'failed';
}

/** Fired when a task row is first created (Phase 7B.3). */
export interface TaskCreatedEvent {
  readonly taskId: string;
  readonly projectId: string | null;
  readonly description: string;
  readonly status: string;
}

/** Fired when a worker first reaches `running` (Phase 7B.3). */
export interface WorkerSpawnedEvent {
  readonly workerId: string;
  readonly role: string;
  readonly featureIntent: string;
  readonly projectId: string | null;
  readonly taskId: string | null;
}

/** Fired when a worker transitions to `completed`. */
export interface WorkerCompletedEvent {
  readonly workerId: string;
  readonly role: string;
  readonly status: 'completed';
  readonly featureIntent: string;
  readonly projectId: string | null;
  readonly taskId: string | null;
}

/** Maps each event name to its payload type. */
export interface PluginEventPayloads {
  onTaskCreated: TaskCreatedEvent;
  onTaskCompleted: TaskCompletedEvent;
  onTaskFailed: TaskFailedEvent;
  onWorkerSpawned: WorkerSpawnedEvent;
  onWorkerCompleted: WorkerCompletedEvent;
  // Declared in the manifest vocabulary for forward-compat but not yet
  // delivered by the host (see manifest.ts JSDoc). No payload type until a
  // source exists.
  onVoiceTranscript: Record<string, unknown>;
  onUserCommand: Record<string, unknown>;
}
