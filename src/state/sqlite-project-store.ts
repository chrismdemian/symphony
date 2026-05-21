import path from 'node:path';
import type { Database, Statement } from 'better-sqlite3';
import type {
  ProjectRecord,
  ProjectRegistryListFilter,
  ProjectSnapshot,
  ProjectStore,
} from '../projects/types.js';
import { DuplicateProjectError, toProjectSnapshot } from '../projects/registry.js';

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
  // Phase 5A — migration 0009
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

export interface SqliteProjectStoreOptions {
  readonly now?: () => number;
}

/**
 * SQLite-backed `ProjectStore` — behavior-identical to
 * `projects/registry.ts:ProjectRegistry`:
 *   - resolves `path.resolve` on insert (Win11 slash normalization)
 *   - rejects direct duplicates AND cross-namespace collisions (id-as-name, name-as-id)
 *   - `list({nameContains})` matches `includes`, case-insensitive
 *
 * The Phase 2A.3 audit M1 rule is enforced with an explicit pre-check plus
 * the `projects.name UNIQUE` + `projects.path UNIQUE` SQL constraints as
 * belt-and-suspenders.
 */
export class SqliteProjectStore implements ProjectStore {
  private readonly stmts: {
    insert: Statement;
    getById: Statement;
    getByName: Statement;
    getByPath: Statement;
    listAll: Statement;
    deleteById: Statement;
  };
  private readonly now: () => number;

  constructor(private readonly db: Database, opts: SqliteProjectStoreOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.stmts = {
      insert: db.prepare(
        `INSERT INTO projects
           (id, name, path, git_remote, git_branch, base_ref, default_model,
            lint_command, test_command, build_command, verify_command,
            verify_timeout_ms, preview_command, preview_timeout_ms,
            finalize_default, created_at,
            worktree_dir, mcp_config, max_concurrent_workers, quality_pipeline,
            plan_mode_required, default_autonomy_tier, maestro_warmth,
            droids_dir, design_inspiration)
         VALUES
           (@id, @name, @path, @git_remote, @git_branch, @base_ref, @default_model,
            @lint_command, @test_command, @build_command, @verify_command,
            @verify_timeout_ms, @preview_command, @preview_timeout_ms,
            @finalize_default, @created_at,
            @worktree_dir, @mcp_config, @max_concurrent_workers, @quality_pipeline,
            @plan_mode_required, @default_autonomy_tier, @maestro_warmth,
            @droids_dir, @design_inspiration)`,
      ),
      getById: db.prepare(`SELECT * FROM projects WHERE id = ?`),
      getByName: db.prepare(`SELECT * FROM projects WHERE name = ?`),
      getByPath: db.prepare(`SELECT * FROM projects WHERE path = ?`),
      listAll: db.prepare(`SELECT * FROM projects ORDER BY created_at ASC`),
      deleteById: db.prepare(`DELETE FROM projects WHERE id = ?`),
    };
  }

  list(filter: ProjectRegistryListFilter = {}): ProjectRecord[] {
    const rows = this.stmts.listAll.all() as ProjectRow[];
    const records = rows.map(rowToRecord);
    if (!filter.nameContains || filter.nameContains.trim().length === 0) return records;
    const needle = filter.nameContains.trim().toLowerCase();
    return records.filter((r) => r.name.toLowerCase().includes(needle));
  }

  get(nameOrId: string): ProjectRecord | undefined {
    if (!nameOrId) return undefined;
    const byId = this.stmts.getById.get(nameOrId) as ProjectRow | undefined;
    if (byId) return rowToRecord(byId);
    const byName = this.stmts.getByName.get(nameOrId) as ProjectRow | undefined;
    if (byName) return rowToRecord(byName);
    return undefined;
  }

  register(record: ProjectRecord): ProjectRecord {
    if (!record.name || !record.name.trim()) {
      throw new Error('SqliteProjectStore.register: name is required');
    }
    if (!record.path || !record.path.trim()) {
      throw new Error('SqliteProjectStore.register: path is required');
    }

    // Cross-namespace collision pre-check (Phase 2A.3 audit M1 parity).
    const byId = this.stmts.getById.get(record.id) as ProjectRow | undefined;
    const byName = this.stmts.getByName.get(record.name) as ProjectRow | undefined;
    const idAsName = this.stmts.getByName.get(record.id) as ProjectRow | undefined;
    const nameAsId = this.stmts.getById.get(record.name) as ProjectRow | undefined;
    if (byId || byName || idAsName || nameAsId) {
      throw new DuplicateProjectError(record.name);
    }

    const resolvedPath = path.resolve(record.path);
    const existingByPath = this.stmts.getByPath.get(resolvedPath) as ProjectRow | undefined;
    if (existingByPath) {
      throw new DuplicateProjectError(record.name);
    }

    const createdAt = record.createdAt || new Date(this.now()).toISOString();
    this.stmts.insert.run({
      id: record.id,
      name: record.name,
      path: resolvedPath,
      git_remote: record.gitRemote ?? null,
      git_branch: record.gitBranch ?? null,
      base_ref: record.baseRef ?? null,
      default_model: record.defaultModel ?? null,
      lint_command: record.lintCommand ?? null,
      test_command: record.testCommand ?? null,
      build_command: record.buildCommand ?? null,
      verify_command: record.verifyCommand ?? null,
      verify_timeout_ms: record.verifyTimeoutMs ?? null,
      preview_command: record.previewCommand ?? null,
      preview_timeout_ms: record.previewTimeoutMs ?? null,
      finalize_default: record.finalizeDefault ?? null,
      created_at: createdAt,
      // Phase 5A
      worktree_dir: record.worktreeDir ?? null,
      mcp_config: record.mcpConfig ?? null,
      max_concurrent_workers: record.maxConcurrentWorkers ?? null,
      quality_pipeline: record.qualityPipeline ?? null,
      plan_mode_required:
        record.planModeRequired === undefined ? null : record.planModeRequired ? 1 : 0,
      default_autonomy_tier: record.defaultAutonomyTier ?? null,
      maestro_warmth: record.maestroWarmth ?? null,
      droids_dir: record.droidsDir ?? null,
      design_inspiration: record.designInspiration ?? null,
    });

    return { ...record, path: resolvedPath, createdAt };
  }

  delete(idOrName: string): boolean {
    const record = this.get(idOrName);
    if (!record) return false;
    const result = this.stmts.deleteById.run(record.id);
    return result.changes > 0;
  }

  snapshot(nameOrId: string): ProjectSnapshot | undefined {
    const r = this.get(nameOrId);
    return r ? toProjectSnapshot(r) : undefined;
  }

  snapshots(filter: ProjectRegistryListFilter = {}): ProjectSnapshot[] {
    return this.list(filter).map(toProjectSnapshot);
  }

  size(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS c FROM projects`).get() as { c: number };
    return row.c;
  }
}

function rowToRecord(row: ProjectRow): ProjectRecord {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    createdAt: row.created_at,
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
    // Phase 5A
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
