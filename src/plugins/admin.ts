import {
  installPlugin,
  listPlugins,
  removePlugin,
  setPluginEnabled,
  type ListedPlugin,
  type RemovePluginResult,
  type SetEnabledResult,
} from './install.js';
import { resolveRemoteSource, type RemoteRunner } from './remote.js';
import type { PluginStore } from './store.js';

/**
 * Phase 7C — `PluginAdmin` is the thin facade the RPC router (`plugins`
 * namespace, `src/rpc/router-impl.ts`) calls so the TUI can manage plugins
 * over the wire. It binds a `PluginStore` + home dir + clock + remote
 * runners once, then exposes the four operations the TUI surface needs:
 * list, enable/disable, install, remove.
 *
 * Topology note (the reason this exists): the TUI talks to the bootstrap
 * RPC server (Process B); the plugin HOST runs in Maestro's MCP child
 * (Process C). They share the same SQLite DB + `~/.symphony/plugins/` on
 * disk, so list/setEnabled/install/remove here are pure DB + filesystem
 * mutations on Process B's side. The host picks up `enabled` changes and
 * new installs on its next start — there is no live hot-reload (matching
 * the CLI's "applies on next Symphony start" semantics).
 *
 * Security: `install` is ALWAYS `--ignore-scripts` (resolveRemoteSource's
 * locked default). The loud `--allow-scripts` opt-in stays CLI-only — the
 * TUI never runs untrusted plugin lifecycle scripts.
 */

/** Unified install result for the wire — flattens manifest fields. */
export interface AdminInstallResult {
  readonly ok: boolean;
  /** `InstallRefusal | RemoteRefusalReason` when `ok` is false. */
  readonly reason?: string;
  readonly message?: string;
  readonly id?: string;
  readonly name?: string;
  readonly version?: string;
  /** True when the id already existed (re-install / upgrade). */
  readonly reinstall?: boolean;
}

export interface PluginAdmin {
  list(): Promise<ListedPlugin[]>;
  setEnabled(id: string, enabled: boolean): Promise<SetEnabledResult>;
  /** Always ignore-scripts; the `--allow-scripts` opt-in is CLI-only. */
  install(source: string): Promise<AdminInstallResult>;
  remove(id: string): Promise<RemovePluginResult>;
}

export interface CreatePluginAdminOptions {
  readonly store: PluginStore;
  readonly home?: string;
  /** ISO timestamp provider; defaults to `new Date().toISOString()`. */
  readonly now?: () => string;
  /** DI seams (tests) — default to real npm/git spawn inside resolveRemoteSource. */
  readonly runNpm?: RemoteRunner;
  readonly runGit?: RemoteRunner;
  readonly tmpRoot?: string;
}

export function createPluginAdmin(opts: CreatePluginAdminOptions): PluginAdmin {
  const home = opts.home;
  const nowFn = opts.now ?? ((): string => new Date().toISOString());

  return {
    async list(): Promise<ListedPlugin[]> {
      return listPlugins({ store: opts.store, ...(home !== undefined ? { home } : {}) });
    },

    async setEnabled(id: string, enabled: boolean): Promise<SetEnabledResult> {
      return setPluginEnabled({
        id,
        enabled,
        store: opts.store,
        now: nowFn(),
        ...(home !== undefined ? { home } : {}),
      });
    },

    async install(source: string): Promise<AdminInstallResult> {
      // Always ignore-scripts (allowScripts omitted → resolveRemoteSource's
      // locked default). npm/git sources resolve into a temp dir; local
      // paths pass through.
      const resolved = await resolveRemoteSource({
        source,
        ...(opts.runNpm !== undefined ? { runNpm: opts.runNpm } : {}),
        ...(opts.runGit !== undefined ? { runGit: opts.runGit } : {}),
        ...(opts.tmpRoot !== undefined ? { tmpRoot: opts.tmpRoot } : {}),
      });
      try {
        if (!resolved.ok) {
          return { ok: false, reason: resolved.reason, message: resolved.message };
        }
        const result = await installPlugin({
          source: resolved.dir,
          sourceLabel: resolved.label,
          store: opts.store,
          now: nowFn(),
          ...(home !== undefined ? { home } : {}),
        });
        if (!result.ok) {
          return {
            ok: false,
            ...(result.reason !== undefined ? { reason: result.reason } : {}),
            ...(result.message !== undefined ? { message: result.message } : {}),
          };
        }
        const m = result.manifest;
        return {
          ok: true,
          ...(m !== undefined ? { id: m.id, name: m.name, version: m.version } : {}),
          ...(result.reinstall !== undefined ? { reinstall: result.reinstall } : {}),
          ...(result.message !== undefined ? { message: result.message } : {}),
        };
      } finally {
        await resolved.cleanup();
      }
    },

    async remove(id: string): Promise<RemovePluginResult> {
      return removePlugin({ id, store: opts.store, ...(home !== undefined ? { home } : {}) });
    },
  };
}
