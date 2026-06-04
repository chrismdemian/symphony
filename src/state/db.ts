import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Database as BetterSqlite3Database } from 'better-sqlite3';
import { applyMigrations, type MigrationSummary } from './migrations.js';
import { resolveDatabasePath, resolveMigrationsPath } from './path.js';
import { DatabaseSchemaMismatchError } from './errors.js';

export interface SymphonyDatabaseOptions {
  /** Override the SQLite file path. Env `SYMPHONY_DB_FILE` wins over this when unset. */
  readonly filePath?: string;
  /** Override the migrations directory. Defaults to bundle-adjacent. */
  readonly migrationsDir?: string;
  /** Override `busy_timeout` ms. Default 5000 — a second `symphony` process waits briefly. */
  readonly busyTimeoutMs?: number;
}

/**
 * Owns the `better-sqlite3` connection + applies migrations + validates
 * the schema contract. Stores take the underlying `BetterSqlite3Database`
 * in their constructors; they do NOT talk to this class directly.
 *
 * Constructor is private — use the static factory `SymphonyDatabase.open`.
 */
export class SymphonyDatabase {
  private constructor(
    public readonly db: BetterSqlite3Database,
    public readonly dbPath: string,
    public readonly migrationSummary: MigrationSummary,
  ) {}

  static open(options: SymphonyDatabaseOptions = {}): SymphonyDatabase {
    const rawPath = options.filePath ?? resolveDatabasePath();
    // `:memory:` is better-sqlite3's in-memory sentinel — don't path-resolve.
    const dbPath = rawPath === ':memory:' ? rawPath : path.resolve(rawPath);
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }

    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma(`busy_timeout = ${options.busyTimeoutMs ?? 5000}`);
    db.pragma('foreign_keys = ON');

    const migrationsDir = options.migrationsDir ?? resolveMigrationsPath();
    let summary: MigrationSummary;
    try {
      summary = applyMigrations(db, migrationsDir);
    } catch (err) {
      db.close();
      throw err;
    }

    try {
      validateSchemaContract(db, dbPath);
    } catch (err) {
      db.close();
      throw err;
    }

    return new SymphonyDatabase(db, dbPath, summary);
  }

  close(): void {
    if (this.db.open) this.db.close();
  }
}

/**
 * Startup contract check — the columns/tables every 2A tool depends on.
 * Throws `DatabaseSchemaMismatchError` so the caller gets an actionable
 * message before the MCP server binds.
 */
export function validateSchemaContract(db: BetterSqlite3Database, dbPath: string): void {
  const missing: string[] = [];

  const requireTable = (table: string): boolean => {
    const row = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(table);
    if (row) return true;
    missing.push(`${table} table`);
    return false;
  };
  const requireColumn = (table: string, column: string): void => {
    const info = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!info.some((row) => row.name === column)) {
      missing.push(`${table}.${column}`);
    }
  };

  // Tables the 2A stores persist into.
  if (requireTable('projects')) {
    for (const col of [
      'id',
      'name',
      'path',
      'lint_command',
      'verify_command',
      'preview_command',
      'preview_timeout_ms',
      // Phase 5A — migration 0009
      'worktree_dir',
      'mcp_config',
      'max_concurrent_workers',
      'quality_pipeline',
      'plan_mode_required',
      'default_autonomy_tier',
      'maestro_warmth',
      'droids_dir',
      'design_inspiration',
    ])
      requireColumn('projects', col);
  }
  if (requireTable('tasks')) {
    for (const col of [
      'id',
      'project_id',
      'status',
      'priority',
      'worker_id',
      'depends_on',
      'notes',
      'archived_at',
      'updated_at',
      'insertion_seq',
    ])
      requireColumn('tasks', col);
  }
  if (requireTable('questions')) {
    for (const col of ['id', 'urgency', 'answered', 'asked_at', 'insertion_seq'])
      requireColumn('questions', col);
  }
  if (requireTable('waves')) {
    for (const col of ['id', 'topic', 'worker_ids', 'started_at', 'insertion_seq'])
      requireColumn('waves', col);
  }
  // Phase 2B.1b — `SqliteWorkerStore` writes through every column below.
  if (requireTable('workers')) {
    for (const col of [
      'id',
      'project_id',
      'task_id',
      'session_id',
      'worktree_path',
      'status',
      'role',
      'feature_intent',
      'task_description',
      'autonomy_tier',
      'depends_on',
      'created_at',
      'completed_at',
      'last_event_at',
      'exit_code',
      'exit_signal',
      'cost_usd',
      'input_tokens',
      'output_tokens',
      'cache_read_tokens',
      'cache_write_tokens',
      'audit_attempts',
    ])
      requireColumn('workers', col);
  }
  // Phase 5E — sagas + saga_members. SqliteSagaStore reads/writes
  // every column below; future migrations that swap-rebuild either
  // table MUST carry these columns forward (mirror 4G.1 / 4G.2 / 5A
  // hazard pattern).
  if (requireTable('sagas')) {
    for (const col of [
      'id',
      'description',
      'status',
      'result',
      'notes',
      'created_at',
      'updated_at',
      'completed_at',
      'insertion_seq',
    ])
      requireColumn('sagas', col);
  }
  if (requireTable('saga_members')) {
    for (const col of ['saga_id', 'task_id', 'project_id', 'status', 'added_at'])
      requireColumn('saga_members', col);
  }
  // Phase 6D.1 — rolling context buffer. SqliteTranscriptStore writes
  // through every column below; future migrations that swap-rebuild the
  // table MUST carry these columns forward (mirror 4G.1 / 4G.2 / 5A
  // hazard pattern).
  if (requireTable('transcript_chunks')) {
    for (const col of [
      'id',
      'session_id',
      'kind',
      'ts',
      't_ms',
      'text',
      'source',
      'span_start_ts',
      'span_end_ts',
      'raw_count',
      'created_at',
    ])
      requireColumn('transcript_chunks', col);
  }
  // Phase 7A — plugin registry. SqlitePluginStore reads/writes every
  // column below; future migrations that swap-rebuild the table MUST
  // carry these columns forward (mirror 4G.1 / 4G.2 / 5A / 6D.1 hazard).
  if (requireTable('plugins')) {
    for (const col of [
      'id',
      'name',
      'version',
      'source',
      'enabled',
      'installed_at',
      'updated_at',
    ])
      requireColumn('plugins', col);
  }
  // Phase 8A — task ↔ external-source links (migration 0013).
  // SqliteExternalLinkStore reads/writes every column below; future
  // migrations that swap-rebuild the table MUST carry them forward
  // (mirror 4G.1 / 4G.2 / 5A / 6D.1 / 7A hazard pattern).
  if (requireTable('task_external_links')) {
    for (const col of [
      'task_id',
      'source',
      'external_id',
      'data_source_id',
      'url',
      'created_at',
    ])
      requireColumn('task_external_links', col);
  }
  // Reserved tables — presence check only (no columns yet exercised).
  requireTable('conversations');
  requireTable('messages');
  requireTable('sessions');
  requireTable('automations');
  requireTable('automation_run_logs');

  if (missing.length > 0) {
    throw new DatabaseSchemaMismatchError(dbPath, missing);
  }
}
