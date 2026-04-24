import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Database } from 'better-sqlite3';

/**
 * Hash-keyed migration runner — hand-ported from emdash
 * `DatabaseService.ts:953-1085`, without the Drizzle dependency.
 *
 * Why hash, not timestamp: a migration merged late on a feature branch
 * may have an earlier `created_at` than the latest applied migration.
 * Drizzle's default runner skips it forever. Hash-keyed tracking applies
 * any unapplied file, period.
 *
 * One file = one transaction. We do NOT split statements on
 * `-- > statement-breakpoint` — we rely on `db.exec()` applying the full
 * file atomically inside an outer `BEGIN/COMMIT`.
 */

const TRACKING_TABLE = '__symphony_migrations';

export interface MigrationFile {
  readonly filename: string;
  readonly sql: string;
  readonly hash: string;
}

export interface MigrationSummary {
  readonly appliedCount: number;
  readonly totalMigrations: number;
}

export class MigrationError extends Error {
  readonly filename: string;
  constructor(filename: string, cause: unknown) {
    super(`Migration '${filename}' failed: ${(cause as Error).message ?? String(cause)}`);
    this.name = 'MigrationError';
    this.filename = filename;
    if (cause instanceof Error && cause.stack) this.stack = cause.stack;
  }
}

/**
 * Read `*.sql` files in `dir`, sorted lexically, returning their hashed
 * contents.
 */
export function readMigrationFiles(dir: string): MigrationFile[] {
  if (!fs.existsSync(dir)) {
    throw new Error(`Migrations directory not found: ${dir}`);
  }
  const entries = fs.readdirSync(dir).filter((f) => f.endsWith('.sql'));
  entries.sort();
  return entries.map((filename) => {
    const sql = fs.readFileSync(path.join(dir, filename), 'utf8');
    const hash = createHash('sha256').update(sql).digest('hex');
    return { filename, sql, hash };
  });
}

/**
 * Apply any unapplied migration files from `migrationsDir`.
 *
 * Foreign keys are disabled for the duration of the run and re-enabled
 * in a finally block, matching emdash's handling of legacy DBs with
 * orphan data (see Known Gotcha in CLAUDE.md).
 */
export function applyMigrations(db: Database, migrationsDir: string): MigrationSummary {
  const migrations = readMigrationFiles(migrationsDir);

  // The tracking table itself must exist before we can lock-and-read.
  // `CREATE TABLE IF NOT EXISTS` serializes through SQLite's write lock
  // on its own — no risk of partial creation.
  db.exec(
    `CREATE TABLE IF NOT EXISTS ${TRACKING_TABLE} (
       hash       TEXT PRIMARY KEY,
       filename   TEXT NOT NULL,
       applied_at TEXT NOT NULL
     );`,
  );

  const fkWasOn = (db.pragma('foreign_keys', { simple: true }) as number) === 1;
  if (fkWasOn) db.pragma('foreign_keys = OFF');

  let appliedCount = 0;
  try {
    // Wrap the WHOLE applied-set read + apply-all sequence in ONE
    // EXCLUSIVE transaction. Two processes opening the same DB with
    // zero migrations applied would otherwise both read `applied=∅`,
    // both attempt `CREATE TABLE projects`, and the second one crashes
    // with `table already exists` (audit C1). `busy_timeout` only
    // serializes the txn START — not the read-then-write race.
    const insertTracker = db.prepare(
      `INSERT INTO ${TRACKING_TABLE} (hash, filename, applied_at) VALUES (?, ?, ?)`,
    );
    const runAll = db.transaction(() => {
      const applied = new Set(
        (db.prepare(`SELECT hash FROM ${TRACKING_TABLE}`).all() as {
          hash: string;
        }[]).map((r) => r.hash),
      );
      for (const migration of migrations) {
        if (applied.has(migration.hash)) continue;
        try {
          db.exec(migration.sql);
          insertTracker.run(migration.hash, migration.filename, new Date().toISOString());
        } catch (cause) {
          throw new MigrationError(migration.filename, cause);
        }
        appliedCount += 1;
      }
    });
    // `.exclusive()` promotes `BEGIN` → `BEGIN EXCLUSIVE`: second process
    // waits behind the first via `busy_timeout`, THEN re-reads the
    // applied set inside the lock. Loser sees the winner's inserts and
    // skips them.
    runAll.exclusive();
  } finally {
    try {
      if (fkWasOn) db.pragma('foreign_keys = ON');
    } catch {
      // If restoring FKs fails (e.g., db already closed by a caller
      // reacting to MigrationError), don't mask the original error.
    }
  }

  return { appliedCount, totalMigrations: migrations.length };
}
