import path from 'node:path';
import { promises as fsp } from 'node:fs';

import { SymphonyDatabase } from '../state/db.js';
import { resolveDatabasePath } from '../state/path.js';
import { SqlitePluginStore } from '../plugins/store.js';
import {
  installPlugin,
  listPlugins,
  removePlugin,
  type ListedPlugin,
} from '../plugins/install.js';
import {
  assertPluginApiCompatible,
  parsePluginManifest,
  PluginApiMismatchError,
} from '../plugins/manifest.js';
import { pluginDir, PLUGIN_MANIFEST } from '../plugins/paths.js';

/**
 * Phase 7A — `symphony plugin …` CLI runners.
 *
 * Each runner opens the full SQLite DB (migrations + schema contract),
 * mutates the plugin registry, prints a human line to stderr, and returns
 * an exitCode. `list` additionally supports `--json` to stdout. Changes
 * apply on the next Maestro start — the plugin host loads enabled plugins
 * at orchestrator-server boot (hot-reload is a Phase 7C follow-up).
 */

export interface PluginCliResult {
  readonly exitCode: number;
}

interface BaseOpts {
  readonly dbFilePath?: string;
  readonly home?: string;
  readonly now?: string;
  readonly stdout?: NodeJS.WritableStream;
  readonly stderr?: NodeJS.WritableStream;
}

function writer(stream: NodeJS.WritableStream | undefined, fallback: NodeJS.WritableStream) {
  const s = stream ?? fallback;
  return (line: string): void => {
    s.write(line.endsWith('\n') ? line : `${line}\n`);
  };
}

async function withDb<T>(
  dbFilePath: string | undefined,
  fn: (store: SqlitePluginStore) => Promise<T> | T,
): Promise<T> {
  const db = SymphonyDatabase.open({ filePath: dbFilePath ?? resolveDatabasePath() });
  try {
    // MUST await before the finally closes the DB — a synchronous return of
    // a still-pending promise would run the store ops against a closed
    // connection.
    return await fn(new SqlitePluginStore(db.db));
  } finally {
    db.close();
  }
}

export interface RunPluginInstallOptions extends BaseOpts {
  readonly source: string;
}

export async function runPluginInstall(opts: RunPluginInstallOptions): Promise<PluginCliResult> {
  const err = writer(opts.stderr, process.stderr);
  const now = opts.now ?? new Date().toISOString();
  try {
    return await withDb(opts.dbFilePath, async (store) => {
      const result = await installPlugin({
        source: opts.source,
        store,
        now,
        ...(opts.home !== undefined ? { home: opts.home } : {}),
      });
      if (!result.ok) {
        err(`[symphony plugin] install failed (${result.reason}): ${result.message ?? ''}`);
        return { exitCode: 1 };
      }
      err(`[symphony plugin] ${result.message}`);
      if (result.manifest) {
        // Audit m3 — surface the exact executable the plugin will spawn so
        // the user can vet it before enabling (plugins run arbitrary code;
        // there is no command allowlist by design — install + enable +
        // master switch is the consent boundary).
        const ep = result.manifest.entrypoint;
        err(`[symphony plugin] will spawn: ${ep.command} ${ep.args.join(' ')}`.trimEnd());
      }
      if (result.manifest && result.manifest.capabilityFlags.length > 0) {
        err(
          `[symphony plugin] declares capability flags: ${result.manifest.capabilityFlags.join(', ')}`,
        );
      }
      if (result.manifest && result.manifest.permissions.length > 0) {
        err(`[symphony plugin] requests permissions: ${result.manifest.permissions.join(', ')}`);
      }
      return { exitCode: 0 };
    });
  } catch (e) {
    err(`[symphony plugin] install error: ${e instanceof Error ? e.message : String(e)}`);
    return { exitCode: 1 };
  }
}

export interface RunPluginRemoveOptions extends BaseOpts {
  readonly id: string;
}

export async function runPluginRemove(opts: RunPluginRemoveOptions): Promise<PluginCliResult> {
  const err = writer(opts.stderr, process.stderr);
  try {
    return await withDb(opts.dbFilePath, async (store) => {
      const result = await removePlugin({
        id: opts.id,
        store,
        ...(opts.home !== undefined ? { home: opts.home } : {}),
      });
      if (!result.ok) {
        err(`[symphony plugin] remove failed (${result.reason}): ${result.message ?? ''}`);
        return { exitCode: 1 };
      }
      err(`[symphony plugin] ${result.message}`);
      return { exitCode: 0 };
    });
  } catch (e) {
    err(`[symphony plugin] remove error: ${e instanceof Error ? e.message : String(e)}`);
    return { exitCode: 1 };
  }
}

export interface RunPluginToggleOptions extends BaseOpts {
  readonly id: string;
}

export async function runPluginEnable(opts: RunPluginToggleOptions): Promise<PluginCliResult> {
  const err = writer(opts.stderr, process.stderr);
  const now = opts.now ?? new Date().toISOString();
  try {
    return await withDb(opts.dbFilePath, async (store) => {
      const record = store.get(opts.id);
      if (record === undefined) {
        err(`[symphony plugin] '${opts.id}' is not installed`);
        return { exitCode: 1 };
      }
      // Refuse to enable a plugin whose on-disk manifest is missing,
      // invalid, or api-incompatible — it would just fail at host load.
      try {
        const manifestPath = path.join(pluginDir(opts.id, opts.home), PLUGIN_MANIFEST);
        const raw = await fsp.readFile(manifestPath, 'utf8');
        assertPluginApiCompatible(parsePluginManifest(JSON.parse(raw) as unknown));
      } catch (e) {
        const why =
          e instanceof PluginApiMismatchError
            ? e.message
            : `manifest unreadable/invalid: ${e instanceof Error ? e.message : String(e)}`;
        err(`[symphony plugin] cannot enable '${opts.id}': ${why}`);
        return { exitCode: 1 };
      }
      store.setEnabled(opts.id, true, now);
      err(`[symphony plugin] enabled '${opts.id}' — applies on next Symphony start`);
      return { exitCode: 0 };
    });
  } catch (e) {
    err(`[symphony plugin] enable error: ${e instanceof Error ? e.message : String(e)}`);
    return { exitCode: 1 };
  }
}

export async function runPluginDisable(opts: RunPluginToggleOptions): Promise<PluginCliResult> {
  const err = writer(opts.stderr, process.stderr);
  const now = opts.now ?? new Date().toISOString();
  try {
    return await withDb(opts.dbFilePath, (store) => {
      if (store.get(opts.id) === undefined) {
        err(`[symphony plugin] '${opts.id}' is not installed`);
        return { exitCode: 1 };
      }
      store.setEnabled(opts.id, false, now);
      err(`[symphony plugin] disabled '${opts.id}' — applies on next Symphony start`);
      return { exitCode: 0 };
    });
  } catch (e) {
    err(`[symphony plugin] disable error: ${e instanceof Error ? e.message : String(e)}`);
    return { exitCode: 1 };
  }
}

export interface RunPluginListOptions extends BaseOpts {
  readonly format?: 'table' | 'json';
}

export async function runPluginList(opts: RunPluginListOptions): Promise<PluginCliResult> {
  const out = writer(opts.stdout, process.stdout);
  const err = writer(opts.stderr, process.stderr);
  const json = opts.format === 'json';
  try {
    return await withDb(opts.dbFilePath, async (store) => {
      const listed = await listPlugins({
        store,
        ...(opts.home !== undefined ? { home: opts.home } : {}),
      });
      if (json) {
        out(JSON.stringify(listed.map(toJson), null, 2));
        return { exitCode: 0 };
      }
      if (listed.length === 0) {
        err('[symphony plugin] no plugins installed. Install one with `symphony plugin install <path>`.');
        return { exitCode: 0 };
      }
      for (const p of listed) {
        out(formatRow(p));
      }
      return { exitCode: 0 };
    });
  } catch (e) {
    // Keep `| jq` pipelines safe: emit an empty array on failure paths.
    if (json) out('[]');
    err(`[symphony plugin] list error: ${e instanceof Error ? e.message : String(e)}`);
    return { exitCode: 1 };
  }
}

function toJson(p: ListedPlugin): Record<string, unknown> {
  return {
    id: p.record.id,
    name: p.record.name,
    version: p.record.version,
    enabled: p.record.enabled,
    source: p.record.source,
    installedAt: p.record.installedAt,
    ...(p.manifest !== undefined
      ? {
          permissions: p.manifest.permissions,
          capabilityFlags: p.manifest.capabilityFlags,
          events: p.manifest.events,
          toolScope: p.manifest.toolScope,
        }
      : {}),
    ...(p.manifestError !== undefined ? { manifestError: p.manifestError } : {}),
  };
}

function formatRow(p: ListedPlugin): string {
  const status = p.record.enabled ? 'enabled ' : 'disabled';
  const flags =
    p.manifest && p.manifest.capabilityFlags.length > 0
      ? `  [${p.manifest.capabilityFlags.join(', ')}]`
      : '';
  const broken = p.manifestError !== undefined ? '  (manifest error)' : '';
  return `${status}  ${p.record.id}  ${p.record.version}${flags}${broken}`;
}
