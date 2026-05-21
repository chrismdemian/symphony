import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runAdd } from '../../src/cli/add.js';
import { runRemove } from '../../src/cli/remove.js';

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

let sandbox: string;
let home: string;
let dbPath: string;
let repoPath: string;

beforeEach(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), 'symphony-remove-'));
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

async function seedProject(name = 'repo'): Promise<void> {
  await initRepo(repoPath);
  const r = await runAdd({
    projectPath: repoPath,
    nameOverride: name,
    dbFilePath: dbPath,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  expect(r.ok).toBe(true);
}

function insertWorker(
  projectId: string,
  workerId: string,
  status:
    | 'spawning'
    | 'running'
    | 'completed'
    | 'failed'
    | 'crashed'
    | 'timeout'
    | 'killed'
    | 'interrupted',
): void {
  const db = new Database(dbPath);
  db.prepare(
    `INSERT INTO workers
       (id, project_id, worktree_path, status, role, feature_intent, task_description, created_at)
     VALUES
       (?, ?, ?, ?, 'implementer', 'intent', 'desc', ?)`,
  ).run(workerId, projectId, path.join(sandbox, 'wt', workerId), status, new Date().toISOString());
  db.close();
}

function insertTask(
  projectId: string,
  taskId: string,
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled',
): void {
  const db = new Database(dbPath);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO tasks
       (id, project_id, description, status, priority, depends_on, notes, created_at, updated_at, insertion_seq)
     VALUES
       (?, ?, 'task', ?, 0, '[]', '[]', ?, ?, 1)`,
  ).run(taskId, projectId, status, now, now);
  db.close();
}

describe('runRemove (Phase 5B)', () => {
  it('refuses not-found when the DB file does not exist', async () => {
    const result = await runRemove({
      nameOrId: 'anything',
      dbFilePath: dbPath,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('not-found');
  });

  it('refuses not-found when the name is unknown', async () => {
    await seedProject('demo');

    const result = await runRemove({
      nameOrId: 'who-dis',
      dbFilePath: dbPath,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('not-found');
  });

  it('happy path: removes a project with no active children', async () => {
    await seedProject('demo');

    const stdout = new PassThrough();
    const stdoutBufs: string[] = [];
    stdout.on('data', (c: Buffer) => stdoutBufs.push(c.toString('utf8')));

    const result = await runRemove({
      nameOrId: 'demo',
      dbFilePath: dbPath,
      stdout,
      stderr: new PassThrough(),
    });
    expect(result.ok).toBe(true);
    expect(result.removed?.name).toBe('demo');
    expect(stdoutBufs.join('')).toContain("Removed 'demo'");
    expect(stdoutBufs.join('')).toContain('symphony reset');

    const probe = new Database(dbPath, { readonly: true });
    const row = probe.prepare('SELECT * FROM projects WHERE id = ?').get('demo');
    probe.close();
    expect(row).toBeUndefined();
  });

  it('refuses has-active-children when a worker is running (default, no --force)', async () => {
    await seedProject('demo');
    insertWorker('demo', 'w-active', 'running');
    insertWorker('demo', 'w-done', 'completed');

    const result = await runRemove({
      nameOrId: 'demo',
      dbFilePath: dbPath,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('has-active-children');
    expect(result.activeWorkers).toBe(1);
    expect(result.pendingTasks).toBe(0);

    // Project still in DB.
    const probe = new Database(dbPath, { readonly: true });
    const row = probe.prepare('SELECT id FROM projects WHERE id = ?').get('demo');
    probe.close();
    expect(row).not.toBeUndefined();
  });

  it('refuses has-active-children when a task is pending (default, no --force)', async () => {
    await seedProject('demo');
    insertTask('demo', 't-pending', 'pending');
    insertTask('demo', 't-done', 'completed');

    const result = await runRemove({
      nameOrId: 'demo',
      dbFilePath: dbPath,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('has-active-children');
    expect(result.pendingTasks).toBe(1);
  });

  it('--force removes despite active workers; FK SET NULL preserves audit history', async () => {
    await seedProject('demo');
    insertWorker('demo', 'w-running', 'running');
    insertWorker('demo', 'w-completed', 'completed');

    const result = await runRemove({
      nameOrId: 'demo',
      force: true,
      dbFilePath: dbPath,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    expect(result.ok).toBe(true);

    const probe = new Database(dbPath, { readonly: true });
    // Project gone.
    expect(probe.prepare('SELECT id FROM projects WHERE id = ?').get('demo')).toBeUndefined();
    // Workers still exist (audit history preserved); project_id is NULL.
    const wRows = probe
      .prepare('SELECT id, project_id FROM workers ORDER BY id')
      .all() as Array<{ id: string; project_id: string | null }>;
    expect(wRows.length).toBe(2);
    for (const r of wRows) {
      expect(r.project_id).toBeNull();
    }
    probe.close();
  });

  it('--force removes despite pending tasks; FK CASCADE drops them', async () => {
    await seedProject('demo');
    insertTask('demo', 't-pending', 'pending');
    insertTask('demo', 't-done', 'completed');

    const result = await runRemove({
      nameOrId: 'demo',
      force: true,
      dbFilePath: dbPath,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    expect(result.ok).toBe(true);

    const probe = new Database(dbPath, { readonly: true });
    expect(probe.prepare('SELECT id FROM projects WHERE id = ?').get('demo')).toBeUndefined();
    // Tasks all gone (CASCADE).
    const taskCount = probe.prepare('SELECT COUNT(*) AS c FROM tasks').get() as { c: number };
    expect(taskCount.c).toBe(0);
    probe.close();
  });

  it('refuses with server-running when another writer holds the DB', async () => {
    await seedProject('demo');

    const holder = new Database(dbPath);
    holder.pragma('journal_mode = WAL');
    holder.pragma('busy_timeout = 0');
    holder.exec('BEGIN IMMEDIATE');

    try {
      const result = await runRemove({
        nameOrId: 'demo',
          dbFilePath: dbPath,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('server-running');
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
    }
  });

  it('lookup works by id as well as name', async () => {
    await seedProject('alpha');
    // In Symphony's id-equals-name convention, both lookups resolve.
    const r = await runRemove({
      nameOrId: 'alpha',
      dbFilePath: dbPath,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    expect(r.ok).toBe(true);
  });
});
