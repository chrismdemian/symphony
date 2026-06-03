import path from 'node:path';

import { symphonyDataDir } from '../utils/config.js';

/**
 * Phase 7A — plugin framework paths.
 *
 * Installed plugins live in a central store under `~/.symphony/plugins/<id>/`.
 * Each plugin directory contains a `plugin.json` manifest (see `manifest.ts`)
 * plus whatever the plugin author shipped (entrypoint script, deps, etc.).
 *
 * The env override mirrors `SYMPHONY_SKILLS_DIR` / `SYMPHONY_CONFIG_FILE` /
 * `SYMPHONY_DB_FILE` so tests + CI isolate without touching the real `~`.
 */

export const SYMPHONY_PLUGINS_DIR_ENV = 'SYMPHONY_PLUGINS_DIR' as const;

/** The single canonical manifest filename inside a plugin dir. */
export const PLUGIN_MANIFEST = 'plugin.json' as const;

/** Central persistent plugin store — `~/.symphony/plugins`. */
export function pluginsDir(home?: string): string {
  const override = process.env[SYMPHONY_PLUGINS_DIR_ENV]?.trim();
  if (override !== undefined && override.length > 0) {
    return path.resolve(override);
  }
  return path.join(symphonyDataDir(home), 'plugins');
}

/** Absolute directory for a single installed plugin, after id validation. */
export function pluginDir(id: string, home?: string): string {
  return path.join(pluginsDir(home), assertSafePluginId(id));
}

/** Absolute path to a plugin's `plugin.json`, after id validation. */
export function pluginManifestPath(id: string, home?: string): string {
  return path.join(pluginDir(id, home), PLUGIN_MANIFEST);
}

export class PluginIdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginIdError';
  }
}

/**
 * Reject ids that could escape the store via path traversal or absolute
 * paths. The id is interpolated into the central plugin dir AND becomes
 * the MCP tool-namespace prefix (`<id>:<tool>`), so this is a hard
 * security boundary, not cosmetic. Mirrors `assertSafeSkillId`
 * (`src/skills/paths.ts`) but lowercase-only + bounded length so the
 * namespace prefix stays portable across filesystems and predictable in
 * the tool list.
 */
export function assertSafePluginId(id: string): string {
  const trimmed = id.trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(trimmed) || trimmed.includes('\0')) {
    throw new PluginIdError(
      `unsafe plugin id '${id}' — must match ^[a-z0-9][a-z0-9_-]{0,63}$ ` +
        '(lowercase, no separators, no leading dot or traversal).',
    );
  }
  // Audit m1 — `__` is the `<id>__<tool>` proxy-tool namespace separator,
  // so a `__` inside an id makes `a__b` + tool `c` collide with id `a` +
  // tool `b__c`. Forbid it to keep the namespace unambiguous (the host
  // would otherwise silently drop the later plugin's colliding tool).
  if (trimmed.includes('__')) {
    throw new PluginIdError(
      `unsafe plugin id '${id}' — must not contain '__' (reserved as the tool-namespace separator).`,
    );
  }
  return trimmed;
}
