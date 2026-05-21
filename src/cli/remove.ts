/**
 * Phase 5B — `symphony remove <name>` subcommand.
 *
 * Unregisters a project from the persistent SQLite DB. Runs offline (no
 * orchestrator required); refuses if `symphony start` holds a write lock.
 *
 * Active-children protection: refuses when ANY worker is in
 * `spawning`/`running` OR ANY task is in `pending`/`in_progress`. The
 * `--force` flag bypasses the check and lets the SQL FK cascade do its
 * thing: `tasks` rows delete (`ON DELETE CASCADE`), `workers.project_id`
 * flips to NULL (`ON DELETE SET NULL` — preserves audit history).
 *
 * Worktree filesystem is NOT touched here — `symphony reset` owns that.
 */
import { existsSync } from 'node:fs';
import Database from 'better-sqlite3';

import { SymphonyDatabase } from '../state/db.js';
import { resolveDatabasePath } from '../state/path.js';
import { SqliteProjectStore } from '../state/sqlite-project-store.js';

export interface RunRemoveOptions {
  readonly nameOrId: string;
  readonly force?: boolean;
  readonly stdout?: NodeJS.WritableStream;
  readonly stderr?: NodeJS.WritableStream;
  readonly dbFilePath?: string;
}

export type RemoveRefusalReason =
  | 'server-running'
  | 'db-probe-failed'
  | 'not-found'
  | 'has-active-children';

export interface RunRemoveResult {
  readonly ok: boolean;
  readonly reason?: RemoveRefusalReason;
  readonly removed?: { readonly name: string; readonly path: string };
  readonly activeWorkers?: number;
  readonly pendingTasks?: number;
}

/**
 * Probe whether another writer holds the DB lock. Mirrors `runReset:74-134`.
 * Returns the refusal reason on busy/error, or null on clean.
 */
function probeServerRunning(dbFilePath: string): RemoveRefusalReason | null {
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

export async function runRemove(opts: RunRemoveOptions): Promise<RunRemoveResult> {
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;
  const dbFilePath = opts.dbFilePath ?? resolveDatabasePath();
  const force = opts.force === true;

  const log = (line: string): void => {
    stderr.write(`[symphony remove] ${line}\n`);
  };

  // ── 1. No DB → nothing to remove ─────────────────────────────────────
  if (!existsSync(dbFilePath)) {
    log(`no projects registered (DB not found at ${dbFilePath})`);
    return { ok: false, reason: 'not-found' };
  }

  // ── 2. Server-running pre-flight ─────────────────────────────────────
  const probeReason = probeServerRunning(dbFilePath);
  if (probeReason !== null) {
    if (probeReason === 'server-running') {
      stderr.write(
        'Symphony appears to be running. Stop `symphony start` first, then run `symphony remove`.\n',
      );
    } else {
      log(`pre-flight DB probe failed at ${dbFilePath}`);
    }
    return { ok: false, reason: probeReason };
  }

  // ── 3. Open DB + look up the project ─────────────────────────────────
  let symDb: SymphonyDatabase;
  try {
    symDb = SymphonyDatabase.open({ filePath: dbFilePath });
  } catch (err) {
    log(
      `could not open DB at ${dbFilePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { ok: false, reason: 'db-probe-failed' };
  }
  try {
    const store = new SqliteProjectStore(symDb.db);
    const record = store.get(opts.nameOrId);
    if (!record) {
      log(`no project registered as '${opts.nameOrId}'`);
      return { ok: false, reason: 'not-found' };
    }

    // ── 4. Active-children check + delete inside ONE transaction ───────
    // Wrap the SELECT-counts AND the DELETE in a single SQLite txn so
    // the counts can't drift between read and delete under any concurrent
    // writer. Server-running probe (step 2) protects against Symphony's
    // own writer; this transaction is belt-and-suspenders against any
    // non-Symphony writer that landed in the gap (audit-m1).
    let activeWorkers = 0;
    let pendingTasks = 0;
    let deleted = false;
    const txn = symDb.db.transaction(() => {
      activeWorkers = countActiveWorkers(symDb, record.id);
      pendingTasks = countPendingTasks(symDb, record.id);
      if (!force && (activeWorkers > 0 || pendingTasks > 0)) {
        return; // refusal — leave `deleted = false`
      }
      store.delete(record.id);
      deleted = true;
    });
    txn();

    if (!deleted) {
      const parts: string[] = [];
      if (activeWorkers > 0) {
        parts.push(`${activeWorkers} active worker${activeWorkers === 1 ? '' : 's'}`);
      }
      if (pendingTasks > 0) {
        parts.push(`${pendingTasks} pending task${pendingTasks === 1 ? '' : 's'}`);
      }
      log(
        `'${record.name}' has ${parts.join(' and ')}. Stop / finalize them first, or re-run with \`--force\` to remove anyway.`,
      );
      return {
        ok: false,
        reason: 'has-active-children',
        activeWorkers,
        pendingTasks,
      };
    }

    const summary =
      activeWorkers > 0 || pendingTasks > 0
        ? ` (--force: dropped ${activeWorkers} active worker${activeWorkers === 1 ? '' : 's'} link${activeWorkers === 1 ? '' : 's'} and ${pendingTasks} pending task${pendingTasks === 1 ? '' : 's'})`
        : '';
    stdout.write(
      `Removed '${record.name}' (${record.path}).${summary} ` +
        'Run `symphony reset` to clean up worktrees on disk.\n',
    );

    return {
      ok: true,
      removed: { name: record.name, path: record.path },
      activeWorkers,
      pendingTasks,
    };
  } finally {
    symDb.close();
  }
}

function countActiveWorkers(symDb: SymphonyDatabase, projectId: string): number {
  const row = symDb.db
    .prepare(
      `SELECT COUNT(*) AS c FROM workers
        WHERE project_id = ?
          AND status IN ('spawning', 'running')`,
    )
    .get(projectId) as { c: number };
  return row.c;
}

function countPendingTasks(symDb: SymphonyDatabase, projectId: string): number {
  const row = symDb.db
    .prepare(
      `SELECT COUNT(*) AS c FROM tasks
        WHERE project_id = ?
          AND status IN ('pending', 'in_progress')`,
    )
    .get(projectId) as { c: number };
  return row.c;
}
