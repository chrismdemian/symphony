import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { randomBytes } from 'node:crypto';

import {
  assertPluginApiCompatible,
  parsePluginManifest,
  PluginApiMismatchError,
  PluginManifestError,
  type PluginManifest,
} from './manifest.js';
import {
  pluginDir,
  pluginsDir,
  PluginIdError,
  PLUGIN_MANIFEST,
} from './paths.js';
import type { PluginRecord, PluginStore } from './store.js';

/**
 * Phase 7A — install / remove / list installed plugins.
 *
 * Install copies a plugin directory (containing `plugin.json`) into the
 * central store `~/.symphony/plugins/<id>/` and records a row in the
 * plugin registry (default-disabled). The on-disk manifest stays the
 * source of truth for behavior; the DB tracks installed + enabled state.
 *
 * No network sources in 7A — `source` is a local directory or a path to a
 * `plugin.json`. npm / git-url sources are a thin follow-up (resolve to a
 * temp dir, then this same code path).
 */

export type InstallRefusal =
  | 'source-not-found'
  | 'manifest-missing'
  | 'manifest-invalid'
  | 'api-incompatible'
  | 'copy-failed';

export interface InstallPluginInput {
  /** Local plugin directory, or a path to its `plugin.json`. */
  readonly source: string;
  readonly store: PluginStore;
  /** ISO timestamp for the install (no `Date.now()` in core logic). */
  readonly now: string;
  readonly home?: string;
}

export interface InstallPluginResult {
  readonly ok: boolean;
  readonly reason?: InstallRefusal;
  readonly message?: string;
  readonly manifest?: PluginManifest;
  /** True when the id already existed (re-install / upgrade). */
  readonly reinstall?: boolean;
  /** Absolute install directory. */
  readonly installedTo?: string;
}

async function pathKind(p: string): Promise<'file' | 'dir' | 'missing'> {
  try {
    const st = await fsp.stat(p);
    return st.isDirectory() ? 'dir' : 'file';
  } catch {
    return 'missing';
  }
}

/** Resolve the source directory (containing plugin.json) from a flexible source arg. */
async function resolveSourceDir(
  source: string,
): Promise<{ ok: true; dir: string } | { ok: false; reason: InstallRefusal; message: string }> {
  const resolved = path.resolve(source);
  const kind = await pathKind(resolved);
  if (kind === 'missing') {
    return { ok: false, reason: 'source-not-found', message: `source not found: ${resolved}` };
  }
  if (kind === 'file') {
    if (path.basename(resolved) !== PLUGIN_MANIFEST) {
      return {
        ok: false,
        reason: 'manifest-missing',
        message: `expected a directory or a ${PLUGIN_MANIFEST} file, got ${resolved}`,
      };
    }
    return { ok: true, dir: path.dirname(resolved) };
  }
  // directory
  const manifest = path.join(resolved, PLUGIN_MANIFEST);
  if ((await pathKind(manifest)) !== 'file') {
    return {
      ok: false,
      reason: 'manifest-missing',
      message: `no ${PLUGIN_MANIFEST} in ${resolved}`,
    };
  }
  return { ok: true, dir: resolved };
}

export async function installPlugin(input: InstallPluginInput): Promise<InstallPluginResult> {
  const resolvedSource = await resolveSourceDir(input.source);
  if (!resolvedSource.ok) {
    return { ok: false, reason: resolvedSource.reason, message: resolvedSource.message };
  }
  const sourceDir = resolvedSource.dir;

  // Parse + validate the manifest.
  let manifest: PluginManifest;
  try {
    const raw = await fsp.readFile(path.join(sourceDir, PLUGIN_MANIFEST), 'utf8');
    manifest = parsePluginManifest(JSON.parse(raw) as unknown);
  } catch (err) {
    const message =
      err instanceof PluginManifestError || err instanceof PluginIdError
        ? err.message
        : err instanceof SyntaxError
          ? `plugin.json is not valid JSON: ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err);
    return { ok: false, reason: 'manifest-invalid', message };
  }

  // Refuse incompatible plugin-api ranges before touching disk.
  try {
    assertPluginApiCompatible(manifest);
  } catch (err) {
    if (err instanceof PluginApiMismatchError) {
      return { ok: false, reason: 'api-incompatible', message: err.message };
    }
    throw err;
  }

  const finalDir = pluginDir(manifest.id, input.home);
  const existing = input.store.get(manifest.id);
  const reinstall = existing !== undefined || (await pathKind(finalDir)) === 'dir';

  // Guard: installing FROM the store onto itself (e.g. re-running install
  // against the installed copy) — skip the copy, just re-register.
  const sameLocation = path.resolve(sourceDir) === path.resolve(finalDir);

  if (!sameLocation) {
    try {
      await copyIntoStore(sourceDir, finalDir, input.home);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: 'copy-failed', message };
    }
  }

  const record = input.store.upsert({
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    source: path.resolve(input.source),
    now: input.now,
    // enabled defaults to false on first install; preserved on reinstall.
  });

  return {
    ok: true,
    manifest,
    reinstall: reinstall && existing !== undefined,
    installedTo: finalDir,
    message: `installed '${record.id}' (${record.version}) — disabled by default; run \`symphony plugin enable ${record.id}\``,
  };
}

/**
 * Copy `sourceDir` into `finalDir` atomically: stage into a sibling tmp
 * dir under the plugins root, then swap. `fsp.rename` onto a non-empty
 * dir fails, so the existing dir is removed first (mirrors the skills
 * installer's `rm(finalDir) → rename(tmp, finalDir)` pattern).
 */
async function copyIntoStore(sourceDir: string, finalDir: string, home?: string): Promise<void> {
  const root = pluginsDir(home);
  await fsp.mkdir(root, { recursive: true });
  const tmp = path.join(root, `.tmp-${path.basename(finalDir)}-${randomBytes(6).toString('hex')}`);
  try {
    await fsp.cp(sourceDir, tmp, { recursive: true });
    await fsp.rm(finalDir, { recursive: true, force: true });
    await fsp.rename(tmp, finalDir);
  } catch (err) {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

export interface RemovePluginInput {
  readonly id: string;
  readonly store: PluginStore;
  readonly home?: string;
}

export interface RemovePluginResult {
  readonly ok: boolean;
  readonly reason?: 'not-found' | 'unsafe-path' | 'invalid-id';
  readonly message?: string;
  /** True when the DB row was removed. */
  readonly removedRow?: boolean;
  /** True when the on-disk dir was removed. */
  readonly removedDir?: boolean;
}

export async function removePlugin(input: RemovePluginInput): Promise<RemovePluginResult> {
  let dir: string;
  try {
    dir = pluginDir(input.id, input.home);
  } catch (err) {
    if (err instanceof PluginIdError) {
      return { ok: false, reason: 'invalid-id', message: err.message };
    }
    throw err;
  }

  const row = input.store.get(input.id);
  const dirExists = (await pathKind(dir)) === 'dir';
  if (row === undefined && !dirExists) {
    return { ok: false, reason: 'not-found', message: `plugin '${input.id}' is not installed` };
  }

  // Defense in depth: never rm a path outside the plugins root, even
  // though assertSafePluginId already blocks traversal.
  const root = path.resolve(pluginsDir(input.home));
  const resolvedDir = path.resolve(dir);
  if (resolvedDir !== root && !resolvedDir.startsWith(root + path.sep)) {
    return {
      ok: false,
      reason: 'unsafe-path',
      message: `refusing to remove path outside the plugins store: ${resolvedDir}`,
    };
  }

  let removedDir = false;
  if (dirExists) {
    await fsp.rm(resolvedDir, { recursive: true, force: true });
    removedDir = true;
  }
  const removedRow = input.store.delete(input.id);

  return { ok: true, removedRow, removedDir, message: `removed plugin '${input.id}'` };
}

export interface ListedPlugin {
  readonly record: PluginRecord;
  /** Parsed manifest from disk, when present + valid. */
  readonly manifest?: PluginManifest;
  /** Set when the manifest is missing or invalid (orphaned / corrupt install). */
  readonly manifestError?: string;
}

export interface ListPluginsInput {
  readonly store: PluginStore;
  readonly home?: string;
}

/**
 * List installed plugins from the registry, enriching each with its
 * on-disk manifest (or an error note when the dir/manifest is gone). The
 * registry is the authority for "installed"; the manifest read is
 * best-effort context.
 */
export async function listPlugins(input: ListPluginsInput): Promise<ListedPlugin[]> {
  const records = input.store.list();
  const out: ListedPlugin[] = [];
  for (const record of records) {
    const manifestPath = path.join(pluginDir(record.id, input.home), PLUGIN_MANIFEST);
    try {
      const raw = await fsp.readFile(manifestPath, 'utf8');
      const manifest = parsePluginManifest(JSON.parse(raw) as unknown);
      out.push({ record, manifest });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      out.push({ record, manifestError: message });
    }
  }
  return out;
}
