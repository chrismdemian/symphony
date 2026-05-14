/**
 * Phase 3Q — `symphony reset` subcommand.
 *
 * Wipes per-session state: worktrees + SQLite DB + Maestro session jsonl.
 * Preserves user preferences (config, voice vocab, skills, audit log).
 *
 * Flow:
 *   1. Pre-flight — refuse if another writer holds the DB (BEGIN IMMEDIATE
 *      probe; SQLITE_BUSY means `symphony start` is running).
 *   2. Confirmation — readline prompt requires the literal string `reset`
 *      (lowercase). Anything else aborts. `--force` skips this.
 *   3. List projects from `projects` table.
 *   4. For each: `WorktreeManager.removeAllForProject(projectPath)`.
 *   5. Close DB.
 *   6. Delete `symphony.db` + `.db-wal` + `.db-shm`.
 *   7. Delete Maestro session jsonl
 *      (`~/.claude/projects/<encoded-maestro-cwd>/<MAESTRO_SESSION_UUID>.jsonl`).
 *   8. Print summary.
 */
import { createInterface } from 'node:readline';
import { promises as fsp, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { resolveDatabasePath } from '../state/path.js';
import { symphonyDataDir } from '../utils/config.js';
import { WorktreeManager } from '../worktree/manager.js';
import { MAESTRO_SESSION_UUID } from '../orchestrator/maestro/session.js';
import { encodeCwdForClaudeProjects } from '../workers/session.js';

const MAESTRO_SUBDIR = 'maestro';

export interface RunResetOptions {
  readonly stdin?: NodeJS.ReadableStream;
  readonly stdout?: NodeJS.WritableStream;
  readonly stderr?: NodeJS.WritableStream;
  /** Override `os.homedir()`. For tests. */
  readonly home?: string;
  /** Skip the typed-confirmation prompt. For scripted / CI use. */
  readonly force?: boolean;
  /** Override the DB file path. Defaults to `resolveDatabasePath()`. For tests. */
  readonly dbFilePath?: string;
  /** Override the WorktreeManager. For tests. */
  readonly worktreeManager?: WorktreeManager;
}

export type ResetRefusalReason = 'server-running' | 'cancelled';

export interface RunResetResult {
  readonly ok: boolean;
  readonly reason?: ResetRefusalReason;
  /** Worktree paths that `git worktree remove` succeeded on. */
  readonly removed: readonly string[];
  /** Worktree paths that failed removal, with the error message. */
  readonly skipped: ReadonlyArray<{ readonly path: string; readonly reason: string }>;
  /** Files actually deleted (db files + maestro session jsonl). */
  readonly deletedFiles: readonly string[];
}

const CONFIRM_PHRASE = 'reset';

export async function runReset(options: RunResetOptions = {}): Promise<RunResetResult> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const home = options.home ?? os.homedir();
  const dbFilePath = options.dbFilePath ?? resolveDatabasePath();
  const worktreeManager = options.worktreeManager ?? new WorktreeManager({ runProjectPrep: false });

  const log = (line: string): void => {
    stderr.write(`[symphony reset] ${line}\n`);
  };

  // ── 1. Server-running pre-flight check ──────────────────────────────
  // If the DB doesn't exist yet, there's nothing to reset on the DB
  // side — but the user might have orphan worktrees if a half-prior-run
  // crashed before the migration. We still proceed; project list comes
  // back empty, the worktree sweep is a no-op per project.
  const dbExists = existsSync(dbFilePath);
  let projectPaths: readonly string[] = [];
  if (dbExists) {
    // Open a raw connection (no migrations / no schema validation). For
    // reset we only need to read `projects.path` — schema breakage
    // shouldn't block reset.
    let probe: Database.Database;
    try {
      probe = new Database(dbFilePath);
      // Short busy timeout: we want to fail fast if a writer is active,
      // not retry for 5 seconds.
      probe.pragma('busy_timeout = 250');
    } catch (err) {
      log(`failed to open DB at ${dbFilePath}: ${err instanceof Error ? err.message : String(err)}`);
      return { ok: false, reason: 'server-running', removed: [], skipped: [], deletedFiles: [] };
    }
    try {
      // BEGIN IMMEDIATE acquires the reserved lock. If another writer is
      // active, this fails with SQLITE_BUSY. WAL readers don't block this
      // probe — only writers do.
      probe.exec('BEGIN IMMEDIATE');
      probe.exec('ROLLBACK');
    } catch (err) {
      probe.close();
      const message = err instanceof Error ? err.message : String(err);
      if (/busy|locked/i.test(message)) {
        stderr.write(
          'Symphony appears to be running. Stop `symphony start` first, then run `symphony reset`.\n',
        );
        return { ok: false, reason: 'server-running', removed: [], skipped: [], deletedFiles: [] };
      }
      // Some other DB error — don't proceed.
      log(`pre-flight lock probe failed: ${message}`);
      return { ok: false, reason: 'server-running', removed: [], skipped: [], deletedFiles: [] };
    }
    // Read project paths. Defensive against schema variance: if the
    // table is missing or shape is off, we treat as zero projects (the
    // db files still get deleted, so any orphan rows go with them).
    try {
      const rows = probe.prepare('SELECT path FROM projects').all() as Array<{ path: unknown }>;
      projectPaths = rows
        .map((r) => (typeof r.path === 'string' ? r.path : null))
        .filter((p): p is string => p !== null && p.length > 0);
    } catch (err) {
      log(`could not read projects table (treating as empty): ${err instanceof Error ? err.message : String(err)}`);
    }
    probe.close();
  }

  // ── 2. Confirmation prompt ──────────────────────────────────────────
  if (options.force !== true) {
    stdout.write(
      `This will WIPE all Symphony workers, tasks, questions, and worktrees.\n` +
        `Projects table will be cleared. User config (~/.symphony/config.json,\n` +
        `voice vocab, settings) is preserved.\n\n` +
        `Type '${CONFIRM_PHRASE}' (lowercase) to confirm: `,
    );
    const answer = await readSingleLine(stdin);
    if (answer !== CONFIRM_PHRASE) {
      stdout.write('Aborted.\n');
      return { ok: false, reason: 'cancelled', removed: [], skipped: [], deletedFiles: [] };
    }
  }

  // ── 3. Worktree sweep ───────────────────────────────────────────────
  const removed: string[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  for (const projectPath of projectPaths) {
    if (!existsSync(projectPath)) {
      // Project directory is gone (user deleted it manually). Nothing
      // to sweep; the DB rows will go with the file delete in step 4.
      log(`project '${projectPath}' no longer exists on disk — skipping worktree sweep`);
      continue;
    }
    try {
      const result = await worktreeManager.removeAllForProject(projectPath);
      removed.push(...result.removed);
      skipped.push(...result.skipped);
    } catch (err) {
      // Whole-project sweep failed (e.g., `git worktree list` itself
      // failed). Record and continue — the user can see what's left.
      skipped.push({
        path: projectPath,
        reason: `removeAllForProject failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // ── 4. Delete DB sidecars (db + wal + shm) ──────────────────────────
  const deletedFiles: string[] = [];
  for (const f of [dbFilePath, `${dbFilePath}-wal`, `${dbFilePath}-shm`]) {
    if (existsSync(f)) {
      await fsp.rm(f, { force: true });
      deletedFiles.push(f);
    }
  }

  // ── 5. Delete Maestro session jsonl ─────────────────────────────────
  // Reset means the next `symphony start` boots Maestro with a clean
  // conversation history. Without this, Maestro's resumed session would
  // reference workers/tasks that no longer exist.
  const maestroCwd = path.resolve(path.join(symphonyDataDir(home), MAESTRO_SUBDIR));
  const encoded = encodeCwdForClaudeProjects(maestroCwd);
  const sessionFile = path.join(home, '.claude', 'projects', encoded, `${MAESTRO_SESSION_UUID}.jsonl`);
  if (existsSync(sessionFile)) {
    await fsp.rm(sessionFile, { force: true });
    deletedFiles.push(sessionFile);
  }

  // ── 6. Summary ──────────────────────────────────────────────────────
  const projectCount = projectPaths.length;
  const skippedSummary = skipped.length === 0 ? '' : ` Skipped ${skipped.length} (see log).`;
  stdout.write(
    `Reset complete. Removed ${removed.length} worktree${removed.length === 1 ? '' : 's'} ` +
      `across ${projectCount} project${projectCount === 1 ? '' : 's'}.${skippedSummary} ` +
      `Run \`symphony start\` to begin fresh.\n`,
  );
  if (skipped.length > 0) {
    for (const s of skipped) {
      stderr.write(`[symphony reset] skipped ${s.path}: ${s.reason}\n`);
    }
  }

  return { ok: true, removed, skipped, deletedFiles };
}

/**
 * Read a single line from `stdin` without keeping the listener registered
 * after the user hits Enter. `readline.createInterface` is what we want;
 * close it immediately after the first `'line'` so subsequent input on
 * `stdin` (CI fixtures piping multi-line content) doesn't leak past us.
 */
function readSingleLine(stdin: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: stdin, terminal: false });
    let settled = false;
    const settle = (value: string): void => {
      if (settled) return;
      settled = true;
      rl.off('line', onLine);
      rl.off('close', onClose);
      resolve(value);
      // Close AFTER resolving so 'close' firing synchronously below
      // can't race the line handler's intended value (Node's readline
      // emits 'close' immediately on `rl.close()`).
      rl.close();
    };
    const onLine = (line: string): void => {
      settle(line.trim());
    };
    const onClose = (): void => {
      // Treat stdin EOF as empty input — cancellation.
      settle('');
    };
    rl.on('line', onLine);
    rl.once('close', onClose);
  });
}
