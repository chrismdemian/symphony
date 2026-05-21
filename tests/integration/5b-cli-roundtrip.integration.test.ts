/**
 * Phase 5B integration — `runAdd` / `runList` / `runRemove` against a real
 * SQLite DB, with manually-inserted workers/tasks to exercise the
 * active-children gate + `--force` cascade semantics end-to-end.
 *
 * This complements the unit tests (which exercise one runner at a time)
 * and the scenario test (which covers the happy path) by stitching the
 * three CLI runners together and verifying SQL FK behavior with real
 * data.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runAdd } from '../../src/cli/add.js';
import { runList } from '../../src/cli/list.js';
import { runRemove } from '../../src/cli/remove.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd });
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

let sandbox: string;
let home: string;
let dbPath: string;
let repoA: string;
let repoB: string;

beforeEach(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), 'sym-5b-int-'));
  home = path.join(sandbox, 'home');
  mkdirSync(path.join(home, '.symphony'), { recursive: true });
  dbPath = path.join(home, '.symphony', 'symphony.db');
  repoA = path.join(sandbox, 'alpha');
  repoB = path.join(sandbox, 'beta');
});

afterEach(() => {
  try {
    rmSync(sandbox, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('Phase 5B integration — add → list → remove with multi-project + FK cascade', () => {
  it('two-project lifecycle with active-children gate and --force cascade', async () => {
    await initRepo(repoA);
    await initRepo(repoB);

    // ── Add both ─────────────────────────────────────────────────────
    expect(
      (
        await runAdd({
          projectPath: repoA,
              dbFilePath: dbPath,
          stdout: new PassThrough(),
          stderr: new PassThrough(),
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await runAdd({
          projectPath: repoB,
              dbFilePath: dbPath,
          stdout: new PassThrough(),
          stderr: new PassThrough(),
        })
      ).ok,
    ).toBe(true);

    // ── List sees both ───────────────────────────────────────────────
    {
      const r = await runList({
          dbFilePath: dbPath,
        format: 'json',
        stdout: new PassThrough(),
        stderr: new PassThrough(),
      });
      expect(r.ok).toBe(true);
      expect(r.projects.map((p) => p.name).sort()).toEqual(['alpha', 'beta']);
    }

    // ── Seed alpha with a running worker + a pending task ───────────
    {
      const db = new Database(dbPath);
      db.prepare(
        `INSERT INTO workers
           (id, project_id, worktree_path, status, role, feature_intent, task_description, created_at)
         VALUES
           ('w-alpha-1', 'alpha', ?, 'running', 'implementer', 'intent-a',
            'desc-a', ?)`,
      ).run(path.join(sandbox, 'wt', 'w-alpha-1'), new Date().toISOString());
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO tasks
           (id, project_id, description, status, priority, depends_on, notes,
            created_at, updated_at, insertion_seq)
         VALUES
           ('t-alpha-1', 'alpha', 'pending task', 'pending', 0, '[]', '[]', ?, ?, 1)`,
      ).run(now, now);
      db.close();
    }

    // ── Remove alpha refuses (active children) ──────────────────────
    {
      const r = await runRemove({
        nameOrId: 'alpha',
          dbFilePath: dbPath,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
      });
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('has-active-children');
      expect(r.activeWorkers).toBe(1);
      expect(r.pendingTasks).toBe(1);
    }

    // ── Remove alpha --force succeeds, FK cascade behaves ────────────
    {
      const r = await runRemove({
        nameOrId: 'alpha',
        force: true,
          dbFilePath: dbPath,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
      });
      expect(r.ok).toBe(true);
    }
    {
      const probe = new Database(dbPath, { readonly: true });
      // Project gone.
      expect(
        probe.prepare('SELECT id FROM projects WHERE id = ?').get('alpha'),
      ).toBeUndefined();
      // Worker row preserved (audit history); project_id flipped to NULL.
      const wRow = probe.prepare('SELECT project_id FROM workers WHERE id = ?').get('w-alpha-1') as
        | { project_id: string | null }
        | undefined;
      expect(wRow).not.toBeUndefined();
      expect(wRow!.project_id).toBeNull();
      // Task row CASCADE-deleted.
      expect(
        probe.prepare('SELECT id FROM tasks WHERE id = ?').get('t-alpha-1'),
      ).toBeUndefined();
      probe.close();
    }

    // ── Beta still present; list confirms ────────────────────────────
    {
      const r = await runList({
          dbFilePath: dbPath,
        format: 'json',
        stdout: new PassThrough(),
        stderr: new PassThrough(),
      });
      expect(r.ok).toBe(true);
      expect(r.projects.length).toBe(1);
      expect(r.projects[0]!.name).toBe('beta');
    }

    // ── Remove beta cleanly (no children) ────────────────────────────
    {
      const r = await runRemove({
        nameOrId: 'beta',
          dbFilePath: dbPath,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
      });
      expect(r.ok).toBe(true);
    }

    // ── Final state: DB has no projects; list reports empty ──────────
    {
      const r = await runList({
          dbFilePath: dbPath,
        format: 'json',
        stdout: new PassThrough(),
        stderr: new PassThrough(),
      });
      expect(r.ok).toBe(true);
      expect(r.projects).toEqual([]);
    }

    // DB file itself is preserved (only `symphony reset` deletes it).
    expect(existsSync(dbPath)).toBe(true);
  });
});
