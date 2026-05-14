import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runReset } from '../../src/cli/reset.js';
import { WorktreeManager } from '../../src/worktree/manager.js';
import { MAESTRO_SESSION_UUID } from '../../src/orchestrator/maestro/session.js';
import { encodeCwdForClaudeProjects } from '../../src/workers/session.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout;
}

async function initRepo(repoPath: string): Promise<void> {
  mkdirSync(repoPath, { recursive: true });
  await git(repoPath, 'init', '--initial-branch=main');
  await git(repoPath, 'config', 'user.email', 'test@example.com');
  await git(repoPath, 'config', 'user.name', 'Symphony Test');
  await git(repoPath, 'config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(repoPath, 'README.md'), '# test\n');
  await git(repoPath, 'add', '.');
  await git(repoPath, 'commit', '-m', 'init');
}

/**
 * Build a minimal SQLite file that looks like Symphony's `symphony.db`
 * for `runReset`'s purposes. We only need the `projects` table with a
 * `path` column — `runReset` doesn't touch any other table.
 */
function seedDb(dbPath: string, projectPaths: readonly string[]): void {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT,
      path TEXT NOT NULL,
      created_at TEXT
    );
  `);
  const insert = db.prepare('INSERT INTO projects (id, name, path, created_at) VALUES (?, ?, ?, ?)');
  for (let i = 0; i < projectPaths.length; i += 1) {
    insert.run(`p${i + 1}`, `proj${i + 1}`, projectPaths[i]!, '2026-05-14T00:00:00.000Z');
  }
  db.close();
}

let sandbox: string;
let home: string;
let dbPath: string;
let repoPath: string;

beforeEach(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), 'symphony-reset-'));
  home = path.join(sandbox, 'home');
  mkdirSync(path.join(home, '.symphony'), { recursive: true });
  dbPath = path.join(home, '.symphony', 'symphony.db');
  repoPath = path.join(sandbox, 'repo');
});

afterEach(() => {
  try {
    rmSync(sandbox, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('runReset (Phase 3Q)', () => {
  it('happy path: removes worktrees + deletes db files', async () => {
    await initRepo(repoPath);
    const manager = new WorktreeManager({ runProjectPrep: false });
    const a = await manager.create({ projectPath: repoPath, workerId: 'w-aaaa' });
    const b = await manager.create({ projectPath: repoPath, workerId: 'w-bbbb' });

    seedDb(dbPath, [repoPath]);
    // Create db-wal + db-shm as artifacts so we can assert they get
    // cleaned up. Real SQLite produces these during WAL mode use; for
    // the test we just need the files to exist.
    writeFileSync(`${dbPath}-wal`, 'wal-content', 'utf8');
    writeFileSync(`${dbPath}-shm`, 'shm-content', 'utf8');

    const stdout = new PassThrough();
    const stderr = new PassThrough();

    const result = await runReset({
      force: true,
      home,
      dbFilePath: dbPath,
      worktreeManager: manager,
      stdout,
      stderr,
    });

    expect(result.ok).toBe(true);
    expect(result.removed.length).toBe(2);
    expect(new Set(result.removed)).toEqual(new Set([a.path, b.path]));
    expect(result.skipped).toEqual([]);

    // DB sidecars all gone after reset.
    expect(existsSync(dbPath)).toBe(false);
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);
    // We don't assert which actor deleted -wal/-shm — better-sqlite3 may
    // sweep them itself on close when the WAL is checkpointed. The
    // success criterion is "files gone", not "runReset deleted them".
    expect(result.deletedFiles).toContain(dbPath);

    // Worktrees gone.
    expect(existsSync(a.path)).toBe(false);
    expect(existsSync(b.path)).toBe(false);

    // Source tree intact.
    expect(existsSync(path.join(repoPath, 'README.md'))).toBe(true);
  });

  it('refuses with db-probe-failed when the DB file is malformed (Opus M1)', async () => {
    // Write a NOT-SQLite file at dbPath. better-sqlite3's open() will
    // succeed (it lazy-validates), but BEGIN IMMEDIATE fails because the
    // file has no valid header. The error is NOT busy/locked, so reset
    // must return 'db-probe-failed' — NOT 'server-running'.
    writeFileSync(dbPath, 'this is not a sqlite database', 'utf8');

    const result = await runReset({
      force: true,
      home,
      dbFilePath: dbPath,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('db-probe-failed');
    // DB file untouched.
    expect(existsSync(dbPath)).toBe(true);
  });

  it('refuses when another writer holds the DB (server-running)', async () => {
    await initRepo(repoPath);
    seedDb(dbPath, [repoPath]);

    // Hold an IMMEDIATE write transaction in the same process to
    // simulate a long-running writer (the real case is another
    // `symphony start` process). `BEGIN IMMEDIATE` acquires the reserved
    // lock; runReset's probe should fail with SQLITE_BUSY.
    const holder = new Database(dbPath);
    holder.pragma('journal_mode = WAL');
    holder.pragma('busy_timeout = 0');
    holder.exec('BEGIN IMMEDIATE');

    try {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const stderrBufs: string[] = [];
      stderr.on('data', (c: Buffer) => stderrBufs.push(c.toString('utf8')));

      const result = await runReset({
        force: true,
        home,
        dbFilePath: dbPath,
        stdout,
        stderr,
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toBe('server-running');
      expect(result.removed).toEqual([]);
      expect(result.deletedFiles).toEqual([]);

      // DB and worktrees untouched.
      expect(existsSync(dbPath)).toBe(true);
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
    }
  });

  it('cancels when user does not type the confirmation phrase exactly', async () => {
    await initRepo(repoPath);
    seedDb(dbPath, [repoPath]);

    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();

    const promise = runReset({ home, dbFilePath: dbPath, stdin, stdout, stderr });
    // Type 'yes' (not 'reset') and Enter.
    stdin.write('yes\n');

    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('cancelled');
    expect(existsSync(dbPath)).toBe(true);
  });

  it('cancels on stdin EOF without confirmation', async () => {
    await initRepo(repoPath);
    seedDb(dbPath, [repoPath]);

    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();

    const promise = runReset({ home, dbFilePath: dbPath, stdin, stdout, stderr });
    stdin.end(); // EOF without writing anything

    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('cancelled');
    expect(existsSync(dbPath)).toBe(true);
  });

  it('proceeds when user types exactly "reset"', async () => {
    await initRepo(repoPath);
    seedDb(dbPath, [repoPath]);

    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stderrBufs: string[] = [];
    stderr.on('data', (c: Buffer) => stderrBufs.push(c.toString('utf8')));

    const promise = runReset({ home, dbFilePath: dbPath, stdin, stdout, stderr });
    stdin.write('reset\n');

    const result = await promise;
    if (!result.ok) {
      throw new Error(`expected ok=true; got reason='${result.reason ?? 'undefined'}'; stderr=${stderrBufs.join('')}`);
    }
    expect(result.ok).toBe(true);
    expect(existsSync(dbPath)).toBe(false);
  });

  it('no-op on a fresh install (no db file, no projects)', async () => {
    expect(existsSync(dbPath)).toBe(false);

    const result = await runReset({
      force: true,
      home,
      dbFilePath: dbPath,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });

    expect(result.ok).toBe(true);
    expect(result.removed).toEqual([]);
    expect(result.deletedFiles).toEqual([]);
  });

  it('deletes the Maestro session jsonl when present', async () => {
    await initRepo(repoPath);
    seedDb(dbPath, [repoPath]);

    // Compute the path runReset will target and pre-create the file.
    const maestroCwd = path.resolve(path.join(home, '.symphony', 'maestro'));
    const encoded = encodeCwdForClaudeProjects(maestroCwd);
    const jsonlPath = path.join(home, '.claude', 'projects', encoded, `${MAESTRO_SESSION_UUID}.jsonl`);
    mkdirSync(path.dirname(jsonlPath), { recursive: true });
    writeFileSync(jsonlPath, '{"role":"user","content":"hi"}\n', 'utf8');

    // Also create a SIBLING project's jsonl that must NOT be touched.
    const otherProject = path.join(home, '.claude', 'projects', '-tmp-other');
    mkdirSync(otherProject, { recursive: true });
    const otherJsonl = path.join(otherProject, 'unrelated.jsonl');
    writeFileSync(otherJsonl, 'unrelated', 'utf8');

    const result = await runReset({
      force: true,
      home,
      dbFilePath: dbPath,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });

    expect(result.ok).toBe(true);
    expect(existsSync(jsonlPath)).toBe(false);
    expect(result.deletedFiles).toContain(jsonlPath);
    // Sibling untouched.
    expect(existsSync(otherJsonl)).toBe(true);
  });

  it('preserves user config files (config.json, voice-vocab)', async () => {
    await initRepo(repoPath);
    seedDb(dbPath, [repoPath]);

    const configPath = path.join(home, '.symphony', 'config.json');
    writeFileSync(configPath, '{"schemaVersion":1}', 'utf8');
    const vocabPath = path.join(home, '.symphony', 'voice-vocab.json');
    writeFileSync(vocabPath, '{}', 'utf8');

    const result = await runReset({
      force: true,
      home,
      dbFilePath: dbPath,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });

    expect(result.ok).toBe(true);
    // User preferences survive.
    expect(existsSync(configPath)).toBe(true);
    expect(existsSync(vocabPath)).toBe(true);
  });

  it('skips a project whose directory no longer exists on disk', async () => {
    const goneProject = path.join(sandbox, 'gone-project');
    seedDb(dbPath, [goneProject]); // path doesn't exist

    const stderr = new PassThrough();
    const stderrBufs: string[] = [];
    stderr.on('data', (c: Buffer) => stderrBufs.push(c.toString('utf8')));

    const result = await runReset({
      force: true,
      home,
      dbFilePath: dbPath,
      stdout: new PassThrough(),
      stderr,
    });

    expect(result.ok).toBe(true);
    expect(result.removed).toEqual([]);
    // The skip is logged but doesn't appear in `skipped[]` (that's
    // reserved for git-failure paths).
    expect(stderrBufs.join('')).toMatch(/no longer exists/);
  });

  it('returns ok=true with skipped[] when removeAllForProject fails', async () => {
    await initRepo(repoPath);
    seedDb(dbPath, [repoPath]);

    // Stub a worktreeManager that always throws for this project.
    const stubManager = {
      removeAllForProject: async (): Promise<never> => {
        throw new Error('simulated git failure');
      },
    } as unknown as WorktreeManager;

    const result = await runReset({
      force: true,
      home,
      dbFilePath: dbPath,
      worktreeManager: stubManager,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });

    expect(result.ok).toBe(true); // Reset itself still succeeds.
    expect(result.removed).toEqual([]);
    expect(result.skipped.length).toBe(1);
    expect(result.skipped[0]?.path).toBe(repoPath);
    expect(result.skipped[0]?.reason).toMatch(/simulated git failure/);
    expect(existsSync(dbPath)).toBe(false); // DB still wiped.
  });
});
