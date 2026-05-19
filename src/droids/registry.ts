import { promises as fsp } from 'node:fs';
import path from 'node:path';

import { parseDroidFile } from './parse.js';
import type { DroidDefinition } from './types.js';

/**
 * Phase 4F.1 — project-scoped custom droid discovery.
 *
 * Droids live in `<project>/.symphony/droids/<name>.md`. They are
 * discovered FRESH on every spawn resolution (no cache): the set is
 * tiny, and Chris iterates on droid prompts — an edit must take effect
 * on the next spawn without restarting Symphony (same posture as the
 * skills store + config: read-through, never snapshot).
 *
 * A malformed droid file must NEVER break discovery of the others or
 * crash boot/spawn — it is collected as a warning and skipped. The
 * resolver (Phase 4F.1d, in the spawn path) decides precedence:
 * project droid > bundled droid (Phase 4F.2) > built-in role.
 */

/** Why one droid file was skipped. Surfaced to the USER, never thrown. */
export interface DroidLoadWarning {
  /** Absolute path of the offending file. */
  readonly source: string;
  /** Human-readable reason (the parse/validation error message). */
  readonly message: string;
}

export interface ProjectDroids {
  /** Successfully parsed droids, keyed by validated `name`. */
  readonly droids: ReadonlyMap<string, DroidDefinition>;
  /** Files that failed to parse/validate (skipped, not fatal). */
  readonly warnings: readonly DroidLoadWarning[];
}

/** `<project>/.symphony/droids` — the project-scoped droid directory. */
export function droidsDirFor(projectPath: string): string {
  return path.join(projectPath, '.symphony', 'droids');
}

/**
 * Discover + parse every `*.md` in `<project>/.symphony/droids/`.
 * Missing directory ⇒ empty result (the common case — not a warning).
 * Each file's frontmatter `name` MUST equal its filename stem so
 * `spawn_worker({ role })` is unambiguous.
 */
export async function loadProjectDroids(
  projectPath: string,
): Promise<ProjectDroids> {
  const dir = droidsDirFor(projectPath);
  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { droids: new Map(), warnings: [] };
    }
    // A non-ENOENT readdir failure (permissions, not-a-dir) is a single
    // warning, not a crash — spawning a built-in role must still work.
    return {
      droids: new Map(),
      warnings: [
        {
          source: dir,
          message: `could not read droids directory: ${
            err instanceof Error ? err.message : String(err)
          }`,
        },
      ],
    };
  }

  const droids = new Map<string, DroidDefinition>();
  const warnings: DroidLoadWarning[] = [];

  for (const entry of entries.sort()) {
    if (!entry.toLowerCase().endsWith('.md')) continue;
    const abs = path.join(dir, entry);
    let stat;
    try {
      stat = await fsp.stat(abs);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;

    const stem = entry.slice(0, entry.length - 3);
    let raw: string;
    try {
      raw = await fsp.readFile(abs, 'utf8');
    } catch (err) {
      warnings.push({
        source: abs,
        message: `could not read file: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
      continue;
    }
    try {
      const def = parseDroidFile(raw, abs, { expectedName: stem });
      if (droids.has(def.name)) {
        warnings.push({
          source: abs,
          message: `duplicate droid name '${def.name}' — already defined by ${
            droids.get(def.name)!.source
          }; this file is ignored.`,
        });
        continue;
      }
      droids.set(def.name, def);
    } catch (err) {
      warnings.push({
        source: abs,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { droids, warnings };
}
