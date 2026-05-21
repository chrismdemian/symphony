/**
 * Phase 5B — `symphony add <path>` subcommand.
 *
 * Registers a project against the persistent SQLite DB. Runs offline (no
 * orchestrator required); refuses if `symphony start` holds a write lock.
 *
 * Name resolution priority:
 *   1. `--name <name>` CLI override
 *   2. `<projectPath>/.symphony.json` → `project.name`
 *   3. `<projectPath>/package.json` → `name`
 *   4. `path.basename(resolvedPath)`
 *
 * Each candidate is normalized via `toProjectIdSlug` (lowercase, kebab,
 * trimmed). The first non-empty post-normalization wins. Empty after all
 * four → refuse `name-resolution-failed`.
 *
 * `.symphony.json` `project` overlay fields (Phase 5A) are persisted on
 * `add` — `qualityPipeline`, `defaultAutonomyTier`, `previewCommand`, etc.
 *
 * Collision semantics:
 *   - same name + same path → idempotent success (`name-collision`, ok=true)
 *   - same name + different path → refuse `name-collision`
 *   - different name + same path → refuse `path-collision`
 *
 * Worktree filesystem is NOT touched here — `symphony reset` owns that.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

import { DuplicateProjectError, toProjectSnapshot } from '../projects/registry.js';
import type { ProjectConfigInput, ProjectRecord, ProjectSnapshot } from '../projects/types.js';
import { SymphonyDatabase } from '../state/db.js';
import { resolveDatabasePath } from '../state/path.js';
import { SqliteProjectStore } from '../state/sqlite-project-store.js';
import { readProjectConfig } from '../worktree/symphony-config.js';

export interface RunAddOptions {
  readonly projectPath: string;
  readonly nameOverride?: string;
  readonly stdout?: NodeJS.WritableStream;
  readonly stderr?: NodeJS.WritableStream;
  readonly dbFilePath?: string;
}

export type AddRefusalReason =
  | 'server-running'
  | 'db-probe-failed'
  | 'path-not-found'
  | 'not-a-git-repo'
  | 'name-collision'
  | 'path-collision'
  | 'name-resolution-failed';

export interface RunAddResult {
  readonly ok: boolean;
  readonly reason?: AddRefusalReason;
  readonly project?: ProjectSnapshot;
  readonly warnings: readonly string[];
  /** True when the project was already registered with the same name+path. */
  readonly idempotent?: boolean;
}

const SLUG_MAX_LEN = 60;

/**
 * Normalize a free-text name into a CLI-safe slug.
 * Returns `''` when input collapses to empty after normalization.
 */
export function toProjectIdSlug(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX_LEN)
    .replace(/-+$/g, '');
}

function readPackageJsonName(projectPath: string): string | null {
  const pkgPath = path.join(projectPath, 'package.json');
  if (!existsSync(pkgPath)) return null;
  try {
    const raw = readFileSync(pkgPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const name = (parsed as Record<string, unknown>).name;
    return typeof name === 'string' && name.trim().length > 0 ? name.trim() : null;
  } catch {
    return null;
  }
}

function isGitRepo(resolvedPath: string): boolean {
  // `.git/` is a directory in normal repos and a file (gitfile) inside
  // linked worktrees. `existsSync` returns true for both — we want to
  // accept both so users can `symphony add` a worktree directly.
  return existsSync(path.join(resolvedPath, '.git'));
}

/**
 * Probe whether another writer holds the DB lock. Mirrors `runReset:74-134`.
 * Returns the refusal reason on busy/error, or null on clean.
 */
function probeServerRunning(dbFilePath: string): AddRefusalReason | null {
  if (!existsSync(dbFilePath)) return null;
  let probe: Database.Database;
  try {
    probe = new Database(dbFilePath);
    probe.pragma('busy_timeout = 250');
  } catch {
    return 'db-probe-failed';
  }
  try {
    probe.exec('BEGIN IMMEDIATE');
    probe.exec('ROLLBACK');
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/busy|locked/i.test(message)) return 'server-running';
    return 'db-probe-failed';
  } finally {
    probe.close();
  }
}

export async function runAdd(opts: RunAddOptions): Promise<RunAddResult> {
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;
  const dbFilePath = opts.dbFilePath ?? resolveDatabasePath();

  const log = (line: string): void => {
    stderr.write(`[symphony add] ${line}\n`);
  };

  // ── 1. Resolve + validate the path ───────────────────────────────────
  // `path.resolve` does NOT expand `~`. Users must type a real path; we
  // don't second-guess shell expansion.
  if (opts.projectPath.startsWith('~')) {
    log(
      `\`~\` is not expanded by the CLI. Use an absolute path or rely on your shell to expand.`,
    );
  }
  const resolved = path.resolve(opts.projectPath);
  let stat;
  try {
    stat = statSync(resolved);
  } catch {
    log(`path not found: ${resolved}`);
    return { ok: false, reason: 'path-not-found', warnings: [] };
  }
  if (!stat.isDirectory()) {
    log(`not a directory: ${resolved}`);
    return { ok: false, reason: 'path-not-found', warnings: [] };
  }

  // ── 2. Git repo check ────────────────────────────────────────────────
  if (!isGitRepo(resolved)) {
    log(`${resolved} is not a git repository. Run \`git init\` first.`);
    return { ok: false, reason: 'not-a-git-repo', warnings: [] };
  }

  // ── 3. Read `.symphony.json` overlay (also yields declaredName) ──────
  const cfg = readProjectConfig(resolved);
  const warnings = cfg.warnings;
  for (const w of warnings) {
    stderr.write(`[symphony add] warning: ${w}\n`);
  }

  // ── 4. Resolve name ──────────────────────────────────────────────────
  // When the user passed `--name`, that is the ONLY candidate. The user
  // explicitly opted out of auto-detection by typing it; silently falling
  // back to package.json or basename when the slug normalizes empty would
  // register the project under a name the user never typed (audit-M1).
  let resolvedName: string | null = null;
  let resolvedNameSource: string | null = null;
  if (opts.nameOverride !== undefined) {
    const slug = toProjectIdSlug(opts.nameOverride);
    if (slug.length > 0) {
      resolvedName = slug;
      resolvedNameSource = '--name';
    } else {
      log(
        `--name '${opts.nameOverride}' normalizes to an empty slug. Pass a name containing letters or digits.`,
      );
      return { ok: false, reason: 'name-resolution-failed', warnings };
    }
  } else {
    const candidates: ReadonlyArray<{ source: string; raw: string | null }> = [
      { source: '.symphony.json project.name', raw: cfg.declaredName ?? null },
      { source: 'package.json name', raw: readPackageJsonName(resolved) },
      { source: 'directory basename', raw: path.basename(resolved) },
    ];
    for (const c of candidates) {
      if (!c.raw) continue;
      const slug = toProjectIdSlug(c.raw);
      if (slug.length > 0) {
        resolvedName = slug;
        resolvedNameSource = c.source;
        break;
      }
    }
    if (!resolvedName) {
      log(
        `could not derive a project name from .symphony.json, package.json, or directory basename. Pass \`--name <slug>\` explicitly.`,
      );
      return { ok: false, reason: 'name-resolution-failed', warnings };
    }
  }

  // ── 5. Server-running pre-flight ─────────────────────────────────────
  const probeReason = probeServerRunning(dbFilePath);
  if (probeReason !== null) {
    if (probeReason === 'server-running') {
      stderr.write(
        'Symphony appears to be running. Stop `symphony start` first, then run `symphony add`.\n',
      );
    } else {
      log(`pre-flight DB probe failed at ${dbFilePath}`);
    }
    return { ok: false, reason: probeReason, warnings };
  }

  // ── 6. Open DB (applies migrations) + register ───────────────────────
  let symDb: SymphonyDatabase;
  try {
    symDb = SymphonyDatabase.open({ filePath: dbFilePath });
  } catch (err) {
    log(
      `could not open DB at ${dbFilePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { ok: false, reason: 'db-probe-failed', warnings };
  }
  try {
    const store = new SqliteProjectStore(symDb.db);

    const overlay: Partial<ProjectConfigInput> = cfg.overlay ?? {};
    const record: ProjectRecord = {
      id: resolvedName,
      name: resolvedName,
      path: resolved,
      createdAt: new Date().toISOString(),
      ...overlay,
    };

    let registered: ProjectRecord;
    try {
      registered = store.register(record);
    } catch (err) {
      if (err instanceof DuplicateProjectError) {
        // Distinguish name-collision (same name, ANY path) from path-collision
        // (different name, same path). Idempotent success only when name AND
        // path both match an existing row.
        const byName = store.get(resolvedName);
        const byPath = store.list().find((r) => r.path === resolved);
        if (byName && byName.path === resolved) {
          stdout.write(
            `'${resolvedName}' is already registered at ${resolved}. Nothing to do.\n`,
          );
          return {
            ok: true,
            project: toProjectSnapshot(byName),
            warnings,
            idempotent: true,
          };
        }
        if (byPath) {
          log(
            `${resolved} is already registered under name '${byPath.name}'. Run \`symphony remove ${byPath.name}\` first, or pass \`--name ${byPath.name}\` to be explicit.`,
          );
          return { ok: false, reason: 'path-collision', warnings };
        }
        log(
          `name '${resolvedName}' is already registered (different path). Pass \`--name <slug>\` to choose a different name.`,
        );
        return { ok: false, reason: 'name-collision', warnings };
      }
      throw err;
    }

    const sourceTag = resolvedNameSource ? ` (from ${resolvedNameSource})` : '';
    stdout.write(`Registered '${registered.name}'${sourceTag} at ${registered.path}.\n`);
    return {
      ok: true,
      project: toProjectSnapshot(registered),
      warnings,
    };
  } finally {
    symDb.close();
  }
}
