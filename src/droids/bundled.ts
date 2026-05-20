import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseDroidFile } from './parse.js';
import type { DroidLoadWarning } from './registry.js';
import type { DroidDefinition } from './types.js';

/**
 * Phase 4F.2 — bundled droid loader.
 *
 * Bundled droids ship inside Symphony's `dist/droids/bundled/*.md`
 * (sourced from `src/droids/bundled/`; `tsup.config.ts` copies the
 * subtree alongside `dist/index.js`). They are loaded ONCE at server
 * boot and merged into the spawn-worker handler's resolution map: a
 * project droid SHADOWS a bundled droid of the same name (PLAN.md §4F
 * override rule).
 *
 * Why an in-package read (not an fs install): bundled SKILLS need an fs
 * install because Claude Code natively discovers `~/.claude/commands/`;
 * bundled DROIDS are read by Symphony's own registry, so there is
 * nothing to "publish" outside the package — keeping them in `dist/`
 * avoids the synchronization problem on Symphony version bumps.
 *
 * System-var substitution happens HERE, at load time, BEFORE the
 * DroidDefinition is stored in the map. Spawn-time worker-var
 * substitution (`substituteWorkerVars`) leaves unknown `{snake_case}`
 * tokens literal — if `{design_catalog_dir}` isn't replaced here, it
 * would survive into the worker prompt as a literal placeholder.
 */

const BUNDLED_DIRNAME = 'bundled';

export class BundledDroidsResolveError extends Error {
  constructor(
    message: string,
    public readonly candidates: readonly string[],
  ) {
    super(message);
    this.name = 'BundledDroidsResolveError';
  }
}

export interface ResolveBundledDroidsOptions {
  /** Test seam — skip the candidate walk and use this exact directory. */
  readonly overrideDir?: string;
  /** Test seam — resolve relative to this module URL. */
  readonly moduleUrl?: string;
}

/**
 * Locate `bundled/` next to the loader on disk. Mirrors
 * `resolveMaestroPromptsDir` / `resolveFenceHookScript`: bundled
 * (`dist/index.js` → `here=dist/` → `dist/droids/bundled/`) first, dev
 * (`src/droids/bundled.ts` → `here=src/droids/` → `src/droids/bundled/`)
 * second.
 */
export function resolveBundledDroidsDir(
  options: ResolveBundledDroidsOptions = {},
): string {
  if (options.overrideDir !== undefined) return options.overrideDir;
  const here = path.dirname(
    fileURLToPath(options.moduleUrl ?? import.meta.url),
  );
  const candidates = [
    // bundled: dist/index.js → here=dist/ → dist/droids/bundled/
    path.resolve(here, 'droids', BUNDLED_DIRNAME),
    // dev / vitest source-run: here=src/droids/ → src/droids/bundled/
    path.resolve(here, BUNDLED_DIRNAME),
    // alt bundle layouts
    path.resolve(here, '..', 'droids', BUNDLED_DIRNAME),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isDirectory()) return c;
  }
  throw new BundledDroidsResolveError(
    `Could not locate the bundled droids directory. Tried:\n  - ${candidates.join(
      '\n  - ',
    )}\nRebuild via \`pnpm build\` to populate dist/droids/bundled/.`,
    candidates,
  );
}

export interface LoadBundledDroidsOptions extends ResolveBundledDroidsOptions {
  /**
   * Boot-time system-var substitutions applied to each droid body
   * AFTER parsing. Keys are the bare `snake_case` token; the literal
   * `{token}` (no escaping) is replaced. Example:
   *   `{ design_catalog_dir: '/home/me/.symphony/design-catalog' }`
   * Spawn-time `substituteWorkerVars` leaves unknown tokens literal —
   * if a bundled droid references `{design_catalog_dir}` and we
   * DON'T substitute here, the worker receives the literal placeholder.
   */
  readonly systemVars?: Readonly<Record<string, string>>;
}

export interface BundledDroids {
  /** Map of bundled droid name → fully-resolved definition. */
  readonly droids: ReadonlyMap<string, DroidDefinition>;
  /** Files that failed to parse — surfaced, never thrown (BOOT must not crash). */
  readonly warnings: readonly DroidLoadWarning[];
}

/**
 * Read + parse every `*.md` in the bundled droids dir. Missing dir
 * THROWS (a packaging bug — production must ship the bundle); a
 * malformed individual file is a warning (don't break boot over one
 * bad file).
 */
export async function loadBundledDroids(
  options: LoadBundledDroidsOptions = {},
): Promise<BundledDroids> {
  const dir = resolveBundledDroidsDir(options);
  const entries = await fsp.readdir(dir);
  const droids = new Map<string, DroidDefinition>();
  const warnings: DroidLoadWarning[] = [];
  const sysVars = options.systemVars ?? {};

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
        message: `could not read bundled droid: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
      continue;
    }
    try {
      const parsed = parseDroidFile(raw, abs, { expectedName: stem });
      const def = applySystemVars(parsed, sysVars);
      if (droids.has(def.name)) {
        warnings.push({
          source: abs,
          message: `duplicate bundled droid name '${def.name}' — already defined by ${
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

/**
 * Apply boot-time system-var substitutions to a droid's body. Returns
 * a new DroidDefinition (immutable; the in-map droid is the substituted
 * one). Only the body is substituted — `name`/`model`/tool policy are
 * structural and never templated.
 */
function applySystemVars(
  def: DroidDefinition,
  sysVars: Readonly<Record<string, string>>,
): DroidDefinition {
  let body = def.body;
  for (const [token, value] of Object.entries(sysVars)) {
    body = body.split(`{${token}}`).join(value);
  }
  return { ...def, body };
}
