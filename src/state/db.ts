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
    for (const col of ['id', 'name', 'path', 'lint_command', 'verify_command'])
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
    ])
      requireColumn('workers', col);
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
