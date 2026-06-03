import path from 'node:path';
import { promises as fsp } from 'node:fs';
import type { z } from 'zod';

import type { ToolRegistration } from '../orchestrator/registry.js';
import {
  assertPluginApiCompatible,
  DELIVERED_PLUGIN_EVENTS,
  parsePluginManifest,
  PLUGIN_EVENTS,
  type PluginEvent,
  type PluginManifest,
} from './manifest.js';
import { pluginDir, PLUGIN_MANIFEST } from './paths.js';
import { PluginClient, type PluginClientFactory, type PluginToolDescriptor } from './client.js';
import { buildProxyToolRegistration, proxyToolName } from './proxy-tool.js';
import { SYMPHONY_META_EVENT_HANDLER, SYMPHONY_META_PERMISSIONS } from './meta-keys.js';
import type { PluginStore } from './store.js';

/**
 * Phase 7A — PluginHost: loads enabled plugins, spawns one MCP client per
 * plugin, registers their tools as namespaced proxies in Symphony's
 * `ToolRegistry`, and fans broker-backed events out to subscribed plugins.
 *
 * Lives in Maestro's MCP child process (Process C) — the one place where
 * both tool dispatch AND the worker/task brokers fire. Activation is
 * gated by `startOrchestratorServer({ plugins: { enabled } })`, which only
 * Maestro's MCP child sets (via the `--plugins` arg). The bootstrap RPC
 * server does NOT spawn plugins (no double-spawn).
 *
 * Crash isolation is a hard invariant: a plugin whose manifest is bad,
 * whose process won't start, or that crashes at runtime is skipped/marked
 * and NEVER takes down Symphony or its sibling plugins.
 */

/**
 * Re-export of the delivered-event set (single source of truth in
 * `manifest.ts`). The host sources these from server-side callbacks:
 * `onTaskStatusChange` (completed/failed) + `onTaskCreated` for tasks, and
 * `onWorkerStatusChange` (completed) + `onWorkerSpawned` for workers (the
 * create/spawn hooks landed in Phase 7B.3). Other declared events
 * (`onVoiceTranscript`, `onUserCommand`) are accepted for forward-compat
 * but logged as undelivered.
 */
export const HOST_DELIVERED_EVENTS = DELIVERED_PLUGIN_EVENTS;

/**
 * The minimal slice of `ToolRegistry` the host depends on. The concrete
 * `ToolRegistry` satisfies it; tests pass a capturing fake so a real
 * plugin subprocess can be driven without standing up an `McpServer`.
 */
export interface PluginToolRegistrar {
  register<TShape extends z.ZodRawShape>(reg: ToolRegistration<TShape>): unknown;
}

export interface PluginHostOptions {
  readonly store: PluginStore;
  readonly registry: PluginToolRegistrar;
  readonly home?: string;
  /** Test seam — injected into each PluginClient so tests fake the transport. */
  readonly clientFactory?: PluginClientFactory;
  /** Diagnostic sink; defaults to a `[symphony:plugins]`-prefixed stderr line. */
  readonly logger?: (line: string) => void;
}

export interface LoadedPlugin {
  readonly manifest: PluginManifest;
  readonly client: PluginClient;
  /** Namespaced tool names registered into the ToolRegistry. */
  readonly proxyToolNames: readonly string[];
  /** Raw (un-namespaced) tool names the plugin exposed — for event lookup. */
  readonly rawToolNames: ReadonlySet<string>;
}

export interface PluginHostStartReport {
  readonly loaded: readonly string[];
  readonly failed: ReadonlyArray<{ id: string; reason: string }>;
  readonly registeredToolCount: number;
}

/** camelCase event → the snake_case handler-tool a plugin exposes. */
export function eventToHandlerTool(event: PluginEvent): string {
  return event.replace(/([A-Z])/g, '_$1').toLowerCase();
}

/**
 * Phase 7B.3 — fail-closed per-tool permission check. A tool may declare
 * (via `_meta['symphony/permissions']`) the manifest permissions it needs;
 * those MUST be a subset of the plugin's granted (manifest) permissions.
 *
 * Returns `{ ok: true }` when the tool declares no permissions or all of
 * them are granted. Returns `{ ok: false, reason }` when the `_meta` value
 * is malformed (not a string array) or a declared permission is outside the
 * consent ceiling. Malformed → refuse: a tool advertising an unparseable
 * permission list must not silently register.
 *
 * Matching is exact-string set containment. `net:<host>` wildcard-aware
 * matching (`net:*.notion.com` ⊇ `net:api.notion.com`) is a conservative
 * follow-up; exact match is the fail-closed default.
 */
export function checkToolPermissions(
  granted: ReadonlySet<string>,
  descriptor: PluginToolDescriptor,
): { ok: true } | { ok: false; reason: string } {
  const raw = descriptor.meta?.[SYMPHONY_META_PERMISSIONS];
  if (raw === undefined) return { ok: true };
  if (!Array.isArray(raw) || !raw.every((p): p is string => typeof p === 'string')) {
    return {
      ok: false,
      reason: `malformed '${SYMPHONY_META_PERMISSIONS}' metadata (expected string[])`,
    };
  }
  const missing = raw.filter((p) => !granted.has(p));
  if (missing.length > 0) {
    return {
      ok: false,
      reason:
        `requires permission(s) ${missing.map((p) => `'${p}'`).join(', ')} ` +
        `not in the manifest consent list (fail-closed)`,
    };
  }
  return { ok: true };
}

export class PluginHost {
  private readonly loaded = new Map<string, LoadedPlugin>();
  private readonly log: (line: string) => void;
  private started = false;
  private shuttingDown = false;

  constructor(private readonly opts: PluginHostOptions) {
    this.log =
      opts.logger ??
      ((line: string): void => {
        if (process.stderr.writable) process.stderr.write(`[symphony:plugins] ${line}\n`);
      });
  }

  /**
   * Load every ENABLED plugin: parse its on-disk manifest, refuse
   * incompatible api ranges, spawn its MCP client, and register its tools
   * as namespaced proxies. Each plugin is isolated — a failure is logged
   * and skipped, never fatal.
   */
  async start(): Promise<PluginHostStartReport> {
    if (this.started) {
      return { loaded: [...this.loaded.keys()], failed: [], registeredToolCount: 0 };
    }
    this.started = true;

    const enabled = this.opts.store.listEnabled();
    const failed: Array<{ id: string; reason: string }> = [];
    let registeredToolCount = 0;

    for (const record of enabled) {
      try {
        const count = await this.loadOne(record.id);
        registeredToolCount += count;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        failed.push({ id: record.id, reason });
        this.log(`plugin '${record.id}' failed to load: ${reason}`);
      }
    }

    if (this.loaded.size > 0) {
      this.log(
        `loaded ${this.loaded.size} plugin(s): ${[...this.loaded.keys()].join(', ')} ` +
          `(${registeredToolCount} tool(s))`,
      );
    }
    return { loaded: [...this.loaded.keys()], failed, registeredToolCount };
  }

  private async loadOne(id: string): Promise<number> {
    const dir = pluginDir(id, this.opts.home);
    const raw = await fsp.readFile(path.join(dir, PLUGIN_MANIFEST), 'utf8');
    const manifest = parsePluginManifest(JSON.parse(raw) as unknown);
    assertPluginApiCompatible(manifest);

    // Warn about declared-but-undelivered events (forward-compat manifests).
    for (const ev of manifest.events) {
      if (!HOST_DELIVERED_EVENTS.includes(ev)) {
        this.log(
          `plugin '${id}' subscribes to '${ev}' which is not yet delivered in this build — ignored`,
        );
      }
    }

    const client = new PluginClient({
      id,
      cwd: dir,
      command: manifest.entrypoint.command,
      args: manifest.entrypoint.args,
      ...(this.opts.clientFactory !== undefined ? { factory: this.opts.clientFactory } : {}),
    });

    const descriptors = await client.start();

    // Phase 7B.3 — the manifest's declared permissions are the consent
    // ceiling. Any per-tool permission (via `_meta`) must be a subset.
    const grantedPermissions = new Set<string>(manifest.permissions);

    const proxyToolNames: string[] = [];
    const rawToolNames = new Set<string>();
    for (const descriptor of descriptors) {
      // Always record the raw name — event delivery (`dispatchEvent`) looks
      // up the handler tool here even for hidden / refused tools.
      rawToolNames.add(descriptor.name);

      // Phase 7B.3 (deliverable 1) — an `on_<event>` handler tool is a
      // host-called notification sink, not something Maestro should call.
      // Keep it OUT of the toolbelt: no proxy registration, but it stays in
      // `rawToolNames` so `dispatchEvent` can still reach it.
      if (descriptor.meta?.[SYMPHONY_META_EVENT_HANDLER] === true) {
        this.log(
          `plugin '${id}' tool '${descriptor.name}' is an event handler — kept out of the toolbelt`,
        );
        continue;
      }

      // Phase 7B.3 (deliverable 3) — fail-closed per-tool permission gate.
      // A tool may only be registered if every permission it declares is in
      // the manifest's consent list. Refuse JUST this tool (7A per-tool
      // isolation); the plugin's other valid tools still load.
      const permCheck = checkToolPermissions(grantedPermissions, descriptor);
      if (!permCheck.ok) {
        this.log(`plugin '${id}' tool '${descriptor.name}' refused: ${permCheck.reason}`);
        continue;
      }

      const registration = buildProxyToolRegistration({
        pluginId: id,
        manifest,
        descriptor,
        callTool: (toolName, args) => client.callTool(toolName, args),
      });
      try {
        this.opts.registry.register(registration);
        proxyToolNames.push(registration.name);
      } catch (err) {
        // A duplicate / bad registration for ONE tool shouldn't drop the
        // whole plugin — log and skip just that tool.
        const reason = err instanceof Error ? err.message : String(err);
        this.log(`plugin '${id}' tool '${descriptor.name}' not registered: ${reason}`);
      }
    }

    this.loaded.set(id, { manifest, client, proxyToolNames, rawToolNames });
    return proxyToolNames.length;
  }

  /**
   * Fan a broker-backed event out to every loaded plugin that (a) declared
   * the event in its manifest AND (b) exposes the matching `on_<event>`
   * handler tool. Fire-and-forget: errors are swallowed, the call never
   * blocks or throws — callers are hot paths (worker exit, task status
   * change). Events bypass `wrapToolHandler` (they're host→plugin
   * notifications, not Maestro-initiated tool calls).
   */
  dispatchEvent(event: PluginEvent, payload: Record<string, unknown>): void {
    if (this.shuttingDown) return;
    if (!HOST_DELIVERED_EVENTS.includes(event)) return;
    const handlerTool = eventToHandlerTool(event);
    for (const [id, plugin] of this.loaded) {
      if (!plugin.manifest.events.includes(event)) continue;
      if (!plugin.rawToolNames.has(handlerTool)) continue;
      void plugin.client.callTool(handlerTool, payload).catch((err: unknown) => {
        const reason = err instanceof Error ? err.message : String(err);
        this.log(`plugin '${id}' event '${event}' delivery failed: ${reason}`);
      });
    }
  }

  /** Snapshot of loaded plugins (for tests / introspection). */
  list(): ReadonlyArray<{ id: string; tools: readonly string[]; state: string }> {
    return [...this.loaded.entries()].map(([id, p]) => ({
      id,
      tools: p.proxyToolNames,
      state: p.client.getState(),
    }));
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    await Promise.all(
      [...this.loaded.values()].map((p) =>
        p.client.close().catch(() => {
          // best-effort
        }),
      ),
    );
    this.loaded.clear();
  }
}

/** The full event vocabulary (re-exported for callers wiring sources). */
export const ALL_PLUGIN_EVENTS: readonly PluginEvent[] = PLUGIN_EVENTS;

/** Namespaced proxy tool name helper (re-export for callers/tests). */
export { proxyToolName };
