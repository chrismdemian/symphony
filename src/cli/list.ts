/**
 * Phase 5B — `symphony list` subcommand.
 *
 * Lists all registered projects from the persistent SQLite DB. Safe to run
 * while `symphony start` is active: opens the DB **read-only** with a raw
 * `better-sqlite3` connection (no migration runner, no schema validator)
 * and SELECTs directly from `projects`. SqliteProjectStore prepares INSERT
 * statements in its constructor which would fail against a read-only
 * handle — so we don't instantiate it here.
 *
 * If the DB file doesn't exist at all (e.g., user runs `symphony list` on
 * a fresh machine), prints a friendly hint.
 */
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import type { ProjectSnapshot } from '../projects/types.js';
import { resolveDatabasePath } from '../state/path.js';
import { loadConfig } from '../utils/config.js';

export interface RunListOptions {
  readonly stdout?: NodeJS.WritableStream;
  readonly stderr?: NodeJS.WritableStream;
  readonly dbFilePath?: string;
  readonly format?: 'table' | 'json';
  /** If true, omit the empty-DB hint line. */
  readonly quiet?: boolean;
  /**
   * Override `os.homedir()` for path-collapsing in the table view. Tests
   * use this; production should rely on the default. Pure presentation —
   * does NOT redirect SQLite reads or migrations.
   */
  readonly home?: string;
}

export interface RunListResult {
  readonly ok: boolean;
  readonly reason?: 'db-open-failed';
  readonly projects: readonly ProjectSnapshot[];
  /**
   * Phase 5D — active project NAME from `~/.symphony/config.json`, or
   * null when no active project is set. Returned so test callers can
   * assert routing intent without re-reading config themselves.
   */
  readonly activeProject?: string | null;
}

interface ProjectRow {
  id: string;
  name: string;
  path: string;
  git_remote: string | null;
  git_branch: string | null;
  base_ref: string | null;
  default_model: string | null;
  lint_command: string | null;
  test_command: string | null;
  build_command: string | null;
  verify_command: string | null;
  verify_timeout_ms: number | null;
  preview_command: string | null;
  preview_timeout_ms: number | null;
  finalize_default: string | null;
  created_at: string;
  worktree_dir: string | null;
  mcp_config: string | null;
  max_concurrent_workers: number | null;
  quality_pipeline: string | null;
  plan_mode_required: number | null;
  default_autonomy_tier: number | null;
  maestro_warmth: number | null;
  droids_dir: string | null;
  design_inspiration: string | null;
}

export async function runList(opts: RunListOptions = {}): Promise<RunListResult> {
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;
  const dbFilePath = opts.dbFilePath ?? resolveDatabasePath();
  const format = opts.format ?? 'table';

  // Phase 5D — surface `config.activeProject` so the table annotates
  // the active row with `(active)` and the JSON view tags it with
  // `"active": true`. loadConfig() never throws (documented contract:
  // ENOENT + parse-failures return defaults + warnings); a wrap is
  // belt-and-suspenders so a regression there can't tank `symphony
  // list` for the rest of the user's projects.
  let activeProject: string | null = null;
  try {
    const cfg = await loadConfig();
    activeProject = cfg.config.activeProject ?? null;
  } catch {
    activeProject = null;
  }

  if (!existsSync(dbFilePath)) {
    if (format === 'json') {
      stdout.write('[]\n');
    } else if (!opts.quiet) {
      stdout.write('No projects registered. Run `symphony add <path>` to register one.\n');
    }
    return { ok: true, projects: [], activeProject };
  }

  // Empty JSON line on any open/read failure so `| jq` pipelines never
  // panic on a missing stdout payload (audit-m2).
  const emitJsonFailureFallback = (): void => {
    if (format === 'json') stdout.write('[]\n');
  };

  let db: Database.Database;
  try {
    db = new Database(dbFilePath, { readonly: true });
  } catch (err) {
    stderr.write(
      `[symphony list] could not open DB at ${dbFilePath}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    emitJsonFailureFallback();
    return { ok: false, reason: 'db-open-failed', projects: [] };
  }

  try {
    let rows: readonly ProjectRow[];
    try {
      rows = db.prepare('SELECT * FROM projects ORDER BY created_at ASC').all() as ProjectRow[];
    } catch (err) {
      stderr.write(
        `[symphony list] projects table not readable: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      emitJsonFailureFallback();
      return { ok: false, reason: 'db-open-failed', projects: [] };
    }
    const snapshots = rows.map(rowToSnapshot);

    if (format === 'json') {
      // Phase 5D — spread `active: true` on the matching row so a JSON
      // consumer can pick the active project without a second config
      // read. Non-active rows omit the field entirely (rather than
      // emitting `active: false`) so the existing JSON shape stays
      // backwards-compatible for callers that don't care.
      const projectsWithActive =
        activeProject !== null
          ? snapshots.map((p) =>
              p.name === activeProject ? { ...p, active: true as const } : p,
            )
          : snapshots;
      stdout.write(`${JSON.stringify(projectsWithActive, null, 2)}\n`);
      return { ok: true, projects: snapshots, activeProject };
    }

    if (snapshots.length === 0) {
      if (!opts.quiet) {
        stdout.write('No projects registered. Run `symphony add <path>` to register one.\n');
      }
      return { ok: true, projects: [], activeProject };
    }

    stdout.write(`${renderTable(snapshots, opts.home, activeProject)}\n`);
    return { ok: true, projects: snapshots, activeProject };
  } finally {
    db.close();
  }
}

function rowToSnapshot(row: ProjectRow): ProjectSnapshot {
  const base = {
    id: row.id,
    name: row.name,
    path: row.path,
    createdAt: row.created_at,
  } as const;
  return {
    ...base,
    ...(row.git_remote !== null ? { gitRemote: row.git_remote } : {}),
    ...(row.git_branch !== null ? { gitBranch: row.git_branch } : {}),
    ...(row.base_ref !== null ? { baseRef: row.base_ref } : {}),
    ...(row.default_model !== null ? { defaultModel: row.default_model } : {}),
    ...(row.lint_command !== null ? { lintCommand: row.lint_command } : {}),
    ...(row.test_command !== null ? { testCommand: row.test_command } : {}),
    ...(row.build_command !== null ? { buildCommand: row.build_command } : {}),
    ...(row.verify_command !== null ? { verifyCommand: row.verify_command } : {}),
    ...(row.verify_timeout_ms !== null ? { verifyTimeoutMs: row.verify_timeout_ms } : {}),
    ...(row.preview_command !== null ? { previewCommand: row.preview_command } : {}),
    ...(row.preview_timeout_ms !== null ? { previewTimeoutMs: row.preview_timeout_ms } : {}),
    ...(row.finalize_default !== null
      ? { finalizeDefault: row.finalize_default as 'push' | 'merge' }
      : {}),
    ...(row.worktree_dir !== null ? { worktreeDir: row.worktree_dir } : {}),
    ...(row.mcp_config !== null ? { mcpConfig: row.mcp_config } : {}),
    ...(row.max_concurrent_workers !== null
      ? { maxConcurrentWorkers: row.max_concurrent_workers }
      : {}),
    ...(row.quality_pipeline !== null
      ? { qualityPipeline: row.quality_pipeline as 'full' | 'simplified' | 'none' }
      : {}),
    ...(row.plan_mode_required !== null
      ? { planModeRequired: row.plan_mode_required === 1 }
      : {}),
    ...(row.default_autonomy_tier !== null
      ? { defaultAutonomyTier: row.default_autonomy_tier as 1 | 2 | 3 }
      : {}),
    ...(row.maestro_warmth !== null ? { maestroWarmth: row.maestro_warmth } : {}),
    ...(row.droids_dir !== null ? { droidsDir: row.droids_dir } : {}),
    ...(row.design_inspiration !== null ? { designInspiration: row.design_inspiration } : {}),
  };
}

interface Column {
  readonly header: string;
  readonly value: (p: ProjectSnapshot) => string;
}

function renderTable(
  snapshots: readonly ProjectSnapshot[],
  homeOverride?: string,
  activeProject?: string | null,
): string {
  const home = homeOverride ?? os.homedir();
  // Normalize Win32 mixed separators on BOTH sides so a `C:/Users/...`
  // row collapses against a `C:\Users\...` home (audit-m6). Pure
  // presentation — the underlying SQL path is unchanged in the result.
  const normalize = (p: string): string => (path.sep === '\\' ? p.replace(/\//g, '\\') : p);
  const collapseHome = (p: string): string => {
    if (!home || home.length === 0) return p;
    const nHome = normalize(home).replace(new RegExp(`\\${path.sep}$`), '');
    const nPath = normalize(p);
    if (nPath === nHome) return '~';
    const prefix = nHome + path.sep;
    if (nPath.startsWith(prefix)) return '~' + path.sep + nPath.slice(prefix.length);
    return p;
  };

  // Phase 5D — annotate the active row in the NAME column. `(active)`
  // suffix is unambiguous and visually unobtrusive; introducing a new
  // ACTIVE column for a single-bit flag is more chrome than signal.
  const nameRender = (p: ProjectSnapshot): string =>
    activeProject !== undefined && activeProject !== null && p.name === activeProject
      ? `${p.name} (active)`
      : p.name;

  const columns: readonly Column[] = [
    { header: 'NAME', value: nameRender },
    { header: 'PATH', value: (p) => collapseHome(p.path) },
    { header: 'MODEL', value: (p) => p.defaultModel ?? '—' },
    { header: 'TIER', value: (p) => (p.defaultAutonomyTier !== undefined ? `T${p.defaultAutonomyTier}` : '—') },
    { header: 'PIPELINE', value: (p) => p.qualityPipeline ?? 'full' },
    { header: 'CREATED', value: (p) => formatCreated(p.createdAt) },
  ];

  const widths = columns.map((col) =>
    Math.max(col.header.length, ...snapshots.map((s) => col.value(s).length)),
  );

  const lines: string[] = [];
  lines.push(columns.map((c, i) => c.header.padEnd(widths[i]!)).join('  '));
  lines.push(widths.map((w) => '─'.repeat(w)).join('  '));
  for (const snap of snapshots) {
    lines.push(columns.map((c, i) => c.value(snap).padEnd(widths[i]!)).join('  '));
  }
  return lines.join('\n');
}

function formatCreated(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(iso);
  return m ? m[1]! : iso;
}
