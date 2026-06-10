import path from 'node:path';
import { promises as fsp } from 'node:fs';
import type { z } from 'zod';

import type { ToolRegistration } from '../orchestrator/registry.js';
import { makeSyncIssuesTool } from '../orchestrator/tools/make-sync-issues.js';
import { makeIssueWritebackRef } from '../orchestrator/issue-writeback.js';
import { ingestIssueCandidates } from '../integrations/issue-ingest.js';
import type { ProjectStore } from '../projects/types.js';
import type { ExternalLinkStore } from '../state/external-link-store.js';
import type { TaskSnapshot, TaskStore } from '../state/types.js';
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
import {
  ISSUE_SOURCE_INTERNAL_TOOLS,
  PluginIssueConnectorAdapter,
} from './issue-connector-adapter.js';
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

/**
 * Phase 9A — the host-owned state an issue-source plugin's adapter needs.
 * When present, a plugin declaring `provides.issueSource` is wrapped in a
 * `PluginIssueConnectorAdapter` and wired through the SAME ingest +
 * writeback pipeline the in-tree 8C connectors use: the host registers a
 * `sync_<source>` tool and a terminal-status writeback ref. The host never
 * touches TaskStore/the link table directly — it hands these to the shared
 * `makeSyncIssuesTool` / `makeIssueWritebackRef` factories (single-writer).
 */
export interface PluginIssueSourceDeps {
  readonly taskStore: TaskStore;
  readonly projectStore: ProjectStore;
  readonly externalLinkStore: ExternalLinkStore;
  readonly resolveProjectPath?: (project?: string) => string;
  /** Register a writeback ref into the server's `fanOutTaskStatusChange` list. */
  readonly registerWritebackRef: (ref: (snapshot: TaskSnapshot) => void) => void;
}

export interface PluginHostOptions {
  readonly store: PluginStore;
  readonly registry: PluginToolRegistrar;
  readonly home?: string;
  /** Test seam — injected into each PluginClient so tests fake the transport. */
  readonly clientFactory?: PluginClientFactory;
  /** Diagnostic sink; defaults to a `[symphony:plugins]`-prefixed stderr line. */
  readonly logger?: (line: string) => void;
  /**
   * Phase 9A — wiring for issue-source plugins. Absent in tests / contexts
   * that don't support task sources; an issue-source plugin then loads but
   * its `sync_<source>` tool is not registered (its internal tools stay out
   * of the toolbelt regardless).
   */
  readonly issueSource?: PluginIssueSourceDeps;
  /**
   * Phase 9B — test seam: when set, OVERRIDES every issue-source plugin's
   * manifest `pollIntervalMs` (so an integration test can poll fast without
   * a 5s manifest floor). Unset in production — the host honors each
   * plugin's declared interval.
   */
  readonly issueSourcePollIntervalMs?: number;
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
  /** Phase 9B — `setInterval` handles for issue-source poll loops. */
  private readonly pollTimers: NodeJS.Timeout[] = [];
  /** Phase 9B — sources with an in-flight poll (no overlapping fetches). */
  private readonly pollInFlight = new Set<string>();

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

    // Phase 9A — an issue-source plugin's `fetch_open_issues` /
    // `write_back_status` (etc.) tools are consumed by the adapter, never
    // exposed to Maestro. Detect it once so the loop can skip those names.
    const issueSource = manifest.provides?.issueSource;

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

      // Phase 9A — issue-source internal tools (`fetch_open_issues`,
      // `write_back_status`, …) are called by the `PluginIssueConnectorAdapter`,
      // never by Maestro. Keep them out of the toolbelt (like event handlers);
      // they stay in `rawToolNames` so the adapter's `callTool` reaches them.
      // Maestro sees only the single `sync_<source>` tool wired below.
      if (issueSource !== undefined && ISSUE_SOURCE_INTERNAL_TOOLS.has(descriptor.name)) {
        this.log(
          `plugin '${id}' tool '${descriptor.name}' is an issue-source internal tool — kept out of the toolbelt`,
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

    // Phase 9A — wire an issue-source plugin into the shared connector
    // pipeline: wrap its tools in a `PluginIssueConnectorAdapter`, register
    // the `sync_<source>` MCP tool, and push a terminal-status writeback ref
    // into the server's fan-out. The host never touches TaskStore / the link
    // table directly — `makeSyncIssuesTool` + `makeIssueWritebackRef` own that
    // (single-writer). When `issueSource` deps aren't wired (tests / older
    // contexts), the internal tools were still hidden above; the sync tool is
    // just not registered.
    if (issueSource !== undefined) {
      const deps = this.opts.issueSource;
      if (deps === undefined) {
        this.log(
          `plugin '${id}' declares issue-source '${issueSource.source}' but the host has no ` +
            `issue-source support wired — sync tool not registered`,
        );
      } else {
        // Phase 9B — the host-side poll cadence: the test seam wins, else the
        // manifest's declared interval, else undefined (pull-only source).
        const pollIntervalMs =
          this.opts.issueSourcePollIntervalMs ?? issueSource.pollIntervalMs;
        const adapter = new PluginIssueConnectorAdapter({
          source: issueSource.source,
          client,
          log: (_level, message) => this.log(`[${id}] ${message}`),
          ...(pollIntervalMs !== undefined ? { pollIntervalMs } : {}),
        });
        const syncTool = makeSyncIssuesTool({
          connector: adapter,
          name: `sync_${issueSource.source}`,
          description:
            `Pull open issues from the '${issueSource.source}' plugin source and create one ` +
            `Symphony task per NEW issue (idempotent; issues already terminal in the source are ` +
            `skipped). Symphony owns task status thereafter and pushes terminal statuses back ` +
            `to the source automatically.`,
          taskStore: deps.taskStore,
          projectStore: deps.projectStore,
          externalLinkStore: deps.externalLinkStore,
          ...(deps.resolveProjectPath !== undefined
            ? { resolveProjectPath: deps.resolveProjectPath }
            : {}),
        });
        try {
          this.opts.registry.register(syncTool);
          proxyToolNames.push(syncTool.name);
          deps.registerWritebackRef(
            makeIssueWritebackRef({
              connector: adapter,
              source: issueSource.source,
              externalLinkStore: deps.externalLinkStore,
              log: (_level, message) => this.log(`[${id}] writeback: ${message}`),
            }),
          );
          // Phase 9B — when the plugin declares a poll cadence (a source that
          // can't push from inside the sandbox, e.g. Obsidian's file-watcher),
          // the host periodically pulls `fetch_open_issues` and ingests the
          // result through the SAME pipeline `sync_<source>` uses. Idempotent
          // (dedup via `task_external_links`), so repeated full scans are safe.
          if (pollIntervalMs !== undefined && pollIntervalMs > 0) {
            const timer = setInterval(() => {
              void this.runIssueSourcePoll(adapter, issueSource.source, deps);
            }, pollIntervalMs);
            // Don't let the poll loop keep the process alive on its own.
            timer.unref?.();
            this.pollTimers.push(timer);
            this.log(
              `plugin '${id}' issue-source '${issueSource.source}' polling every ` +
                `${pollIntervalMs}ms`,
            );
          }
          this.log(
            `plugin '${id}' registered issue-source '${issueSource.source}' ` +
              `(sync_${issueSource.source} + writeback)`,
          );
        } catch (err) {
          // A duplicate `sync_<source>` or bad registration is isolated — log
          // + skip; the plugin's other tools still loaded. server.ts gates
          // EVERY in-tree connector against this discovery set, so an in-tree
          // vs plugin collision can't happen; the only residual case is TWO
          // plugins declaring the same source (the second one yields here).
          // Surfaced at stderr parity with a refused tool (visible, not silent).
          const reason = err instanceof Error ? err.message : String(err);
          this.log(`plugin '${id}' issue-source '${issueSource.source}' not registered: ${reason}`);
        }
      }
    }

    this.loaded.set(id, { manifest, client, proxyToolNames, rawToolNames });
    return proxyToolNames.length;
  }

  /**
   * Phase 9B — one poll tick for an issue-source plugin: pull its open issues
   * and ingest them through the shared pipeline. Fire-and-forget: a fetch or
   * ingest failure is logged, never thrown (the timer keeps ticking). Overlap
   * is guarded per-source so a slow fetch can't stack ticks. Quiesces while
   * shutting down.
   */
  private async runIssueSourcePoll(
    adapter: PluginIssueConnectorAdapter,
    source: string,
    deps: PluginIssueSourceDeps,
  ): Promise<void> {
    if (this.shuttingDown) return;
    if (this.pollInFlight.has(source)) return;
    this.pollInFlight.add(source);
    try {
      const candidates = await adapter.fetchOpenIssues();
      if (this.shuttingDown) return;
      ingestIssueCandidates(
        candidates,
        {
          taskStore: deps.taskStore,
          projectStore: deps.projectStore,
          externalLinkStore: deps.externalLinkStore,
          ...(deps.resolveProjectPath !== undefined
            ? { resolveProjectPath: deps.resolveProjectPath }
            : {}),
        },
        source,
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.log(`issue-source '${source}' poll failed: ${reason}`);
    } finally {
      this.pollInFlight.delete(source);
    }
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
    // Phase 9B — stop the issue-source poll loops BEFORE closing clients, so a
    // tick can't fire `fetch_open_issues` at a client mid-teardown.
    for (const timer of this.pollTimers) clearInterval(timer);
    this.pollTimers.length = 0;
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

/**
 * Phase 9A — coexistence discovery. Returns the set of issue-source ids that
 * an ENABLED, parseable plugin declares it provides (`provides.issueSource.source`).
 * The server uses this to YIELD the in-tree connector for that source (no
 * double `sync_<source>` registration, no double writeback) — the plugin
 * "takes over" the source. Read-only (fs manifest reads, no subprocess
 * spawn); a missing / malformed / api-incompatible manifest is skipped (the
 * host's own `loadOne` will skip it too).
 *
 * In-tree stays the DEFAULT: when no plugin provides a source, the set omits
 * it and the in-tree connector constructs as before.
 *
 * Phase 9B — the server computes this in BOTH processes (gated on the
 * `pluginsEnabled` master switch + a DB), not just Maestro's `--plugins` child.
 * The plugin host (+ its poll loop) runs in Process C, but the in-tree Obsidian
 * connector starts a background WATCHER in the bootstrap server (Process B);
 * for an enabled obsidian plugin to FULLY yield, Process B must see this set
 * too and skip the in-tree connector (which also skips the watcher).
 */
export async function collectEnabledPluginIssueSources(opts: {
  readonly store: PluginStore;
  readonly home?: string;
}): Promise<Set<string>> {
  const sources = new Set<string>();
  for (const record of opts.store.listEnabled()) {
    try {
      const dir = pluginDir(record.id, opts.home);
      const raw = await fsp.readFile(path.join(dir, PLUGIN_MANIFEST), 'utf8');
      const manifest = parsePluginManifest(JSON.parse(raw) as unknown);
      assertPluginApiCompatible(manifest);
      const src = manifest.provides?.issueSource?.source;
      if (src !== undefined) sources.add(src);
    } catch {
      // Unreadable / invalid / incompatible manifest — skip. The in-tree
      // connector then stays (safe default); the host's load also skips it.
    }
  }
  return sources;
}

/** The full event vocabulary (re-exported for callers wiring sources). */
export const ALL_PLUGIN_EVENTS: readonly PluginEvent[] = PLUGIN_EVENTS;

/** Namespaced proxy tool name helper (re-export for callers/tests). */
export { proxyToolName };
