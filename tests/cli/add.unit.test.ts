import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runAdd, toProjectIdSlug } from '../../src/cli/add.js';

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
  sandbox = mkdtempSync(path.join(tmpdir(), 'symphony-add-'));
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

describe('toProjectIdSlug', () => {
  it('lowercases and kebab-cases', () => {
    expect(toProjectIdSlug('My Awesome App')).toBe('my-awesome-app');
  });
  it('strips leading and trailing dashes', () => {
    expect(toProjectIdSlug('---foo---')).toBe('foo');
  });
  it('truncates to 60 chars without trailing dash', () => {
    const long = 'a'.repeat(80);
    const out = toProjectIdSlug(long);
    expect(out.length).toBeLessThanOrEqual(60);
    expect(out.endsWith('-')).toBe(false);
  });
  it('returns empty string when all chars are slug-unsafe', () => {
    expect(toProjectIdSlug('图书')).toBe('');
    expect(toProjectIdSlug('!!!')).toBe('');
  });
});

describe('runAdd (Phase 5B)', () => {
  it('refuses path-not-found when the directory does not exist', async () => {
    const result = await runAdd({
      projectPath: path.join(sandbox, 'nope'),
      dbFilePath: dbPath,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('path-not-found');
    expect(existsSync(dbPath)).toBe(false);
  });

  it('refuses path-not-found when the path is a file, not a directory', async () => {
    const filePath = path.join(sandbox, 'a-file');
    writeFileSync(filePath, 'data', 'utf8');
    const result = await runAdd({
      projectPath: filePath,
      dbFilePath: dbPath,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('path-not-found');
  });

  it('refuses not-a-git-repo when the directory has no .git', async () => {
    mkdirSync(repoPath, { recursive: true });
    const result = await runAdd({
      projectPath: repoPath,
      dbFilePath: dbPath,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('not-a-git-repo');
    expect(existsSync(dbPath)).toBe(false);
  });

  it('happy path: registers with directory basename when no name source exists', async () => {
    await initRepo(repoPath);
    const stdout = new PassThrough();
    const stdoutBufs: string[] = [];
    stdout.on('data', (c: Buffer) => stdoutBufs.push(c.toString('utf8')));

    const result = await runAdd({
      projectPath: repoPath,
      dbFilePath: dbPath,
      stdout,
      stderr: new PassThrough(),
    });

    expect(result.ok).toBe(true);
    expect(result.project?.name).toBe('repo');
    expect(result.project?.path).toBe(path.resolve(repoPath));
    expect(stdoutBufs.join('')).toContain("Registered 'repo'");
    expect(stdoutBufs.join('')).toContain('directory basename');

    // DB row exists.
    const probe = new Database(dbPath, { readonly: true });
    const row = probe.prepare('SELECT * FROM projects WHERE id = ?').get('repo') as
      | { id: string; name: string; path: string }
      | undefined;
    probe.close();
    expect(row?.name).toBe('repo');
    expect(row?.path).toBe(path.resolve(repoPath));
  });

  it('uses package.json name when present (over basename)', async () => {
    await initRepo(repoPath);
    writeFileSync(
      path.join(repoPath, 'package.json'),
      JSON.stringify({ name: 'pkg-name' }),
      'utf8',
    );

    const result = await runAdd({
      projectPath: repoPath,
      dbFilePath: dbPath,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });

    expect(result.ok).toBe(true);
    expect(result.project?.name).toBe('pkg-name');
  });

  it('uses .symphony.json project.name (over package.json)', async () => {
    await initRepo(repoPath);
    writeFileSync(
      path.join(repoPath, 'package.json'),
      JSON.stringify({ name: 'pkg-name' }),
      'utf8',
    );
    writeFileSync(
      path.join(repoPath, '.symphony.json'),
      JSON.stringify({
        project: {
          name: 'sym-name',
          qualityPipeline: 'simplified',
          defaultAutonomyTier: 2,
        },
      }),
      'utf8',
    );

    const result = await runAdd({
      projectPath: repoPath,
      dbFilePath: dbPath,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });

    expect(result.ok).toBe(true);
    expect(result.project?.name).toBe('sym-name');
    expect(result.project?.qualityPipeline).toBe('simplified');
    expect(result.project?.defaultAutonomyTier).toBe(2);
  });

  it('--name override wins over all other sources', async () => {
    await initRepo(repoPath);
    writeFileSync(
      path.join(repoPath, 'package.json'),
      JSON.stringify({ name: 'pkg-name' }),
      'utf8',
    );

    const result = await runAdd({
      projectPath: repoPath,
      nameOverride: 'My CLI Choice',
      dbFilePath: dbPath,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });

    expect(result.ok).toBe(true);
    expect(result.project?.name).toBe('my-cli-choice');
  });

  it('persists overlay fields (qualityPipeline, defaultAutonomyTier, previewCommand)', async () => {
    await initRepo(repoPath);
    writeFileSync(
      path.join(repoPath, '.symphony.json'),
      JSON.stringify({
        project: {
          qualityPipeline: 'none',
          defaultAutonomyTier: 3,
          previewCommand: 'pnpm dev',
          previewTimeoutMs: 45000,
          planModeRequired: true,
          maestroWarmth: 0.7,
        },
      }),
      'utf8',
    );

    const result = await runAdd({
      projectPath: repoPath,
      dbFilePath: dbPath,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });

    expect(result.ok).toBe(true);

    // Verify via raw SQL — confirms the overlay round-trips through
    // SqliteProjectStore's INSERT.
    const probe = new Database(dbPath, { readonly: true });
    const row = probe
      .prepare(
        'SELECT quality_pipeline, default_autonomy_tier, preview_command, ' +
          'preview_timeout_ms, plan_mode_required, maestro_warmth FROM projects WHERE name = ?',
      )
      .get('repo') as {
      quality_pipeline: string;
      default_autonomy_tier: number;
      preview_command: string;
      preview_timeout_ms: number;
      plan_mode_required: number;
      maestro_warmth: number;
    };
    probe.close();

    expect(row.quality_pipeline).toBe('none');
    expect(row.default_autonomy_tier).toBe(3);
    expect(row.preview_command).toBe('pnpm dev');
    expect(row.preview_timeout_ms).toBe(45000);
    expect(row.plan_mode_required).toBe(1);
    expect(row.maestro_warmth).toBe(0.7);
  });

  it('refuses name-resolution-failed when --name slug-empties (no silent fallback) — audit-M1', async () => {
    await initRepo(repoPath);
    // package.json provides a perfectly valid name, but the user typed
    // `--name '!!!'`. Pre-fix, runAdd would silently fall back through to
    // package.json and register the project under 'pkg-name'. Post-fix,
    // refuses because the user opted out of auto-detection by typing
    // --name.
    writeFileSync(
      path.join(repoPath, 'package.json'),
      JSON.stringify({ name: 'pkg-name' }),
      'utf8',
    );

    const stderr = new PassThrough();
    const stderrBufs: string[] = [];
    stderr.on('data', (c: Buffer) => stderrBufs.push(c.toString('utf8')));

    const result = await runAdd({
      projectPath: repoPath,
      nameOverride: '!!!',
      dbFilePath: dbPath,
      stdout: new PassThrough(),
      stderr,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('name-resolution-failed');
    expect(stderrBufs.join('')).toContain("--name '!!!'");
    // DB does NOT get created — the user's intent never resolved.
    expect(existsSync(dbPath)).toBe(false);
  });

  it('refuses name-resolution-failed when all auto-detection sources are slug-empty', async () => {
    const cjkRepo = path.join(sandbox, '图书');
    await initRepo(cjkRepo);
    // No package.json, no .symphony.json, no --name. Basename is non-ASCII.

    const result = await runAdd({
      projectPath: cjkRepo,
      dbFilePath: dbPath,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('name-resolution-failed');
  });

  it('same name + same path = idempotent success', async () => {
    await initRepo(repoPath);

    const first = await runAdd({
      projectPath: repoPath,
      dbFilePath: dbPath,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    expect(first.ok).toBe(true);
    expect(first.idempotent).toBeUndefined();

    const second = await runAdd({
      projectPath: repoPath,
      dbFilePath: dbPath,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    expect(second.ok).toBe(true);
    expect(second.idempotent).toBe(true);
    expect(second.project?.name).toBe('repo');
  });

  it('different name + same path → path-collision refusal', async () => {
    await initRepo(repoPath);

    const first = await runAdd({
      projectPath: repoPath,
      dbFilePath: dbPath,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    expect(first.ok).toBe(true);

    const second = await runAdd({
      projectPath: repoPath,
      nameOverride: 'a-different-name',
      dbFilePath: dbPath,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    expect(second.ok).toBe(false);
    expect(second.reason).toBe('path-collision');
  });

  it('same name + different path → name-collision refusal', async () => {
    const repoA = path.join(sandbox, 'repo-a');
    const repoB = path.join(sandbox, 'repo-b');
    await initRepo(repoA);
    await initRepo(repoB);

    const first = await runAdd({
      projectPath: repoA,
      nameOverride: 'shared',
      dbFilePath: dbPath,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    expect(first.ok).toBe(true);

    const second = await runAdd({
      projectPath: repoB,
      nameOverride: 'shared',
      dbFilePath: dbPath,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    expect(second.ok).toBe(false);
    expect(second.reason).toBe('name-collision');
  });

  it('refuses with server-running when another writer holds the DB', async () => {
    await initRepo(repoPath);

    // Seed the DB with a no-op write so it has WAL set up, then hold an
    // IMMEDIATE transaction to simulate a long-running writer.
    {
      const seed = new Database(dbPath);
      seed.pragma('journal_mode = WAL');
      seed.exec('CREATE TABLE seed_dummy (x INTEGER)');
      seed.close();
    }
    const holder = new Database(dbPath);
    holder.pragma('journal_mode = WAL');
    holder.pragma('busy_timeout = 0');
    holder.exec('BEGIN IMMEDIATE');

    try {
      const result = await runAdd({
        projectPath: repoPath,
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

  it('warns on malformed .symphony.json but still registers (loader is tolerant)', async () => {
    await initRepo(repoPath);
    writeFileSync(path.join(repoPath, '.symphony.json'), '{ not valid json', 'utf8');

    const stderr = new PassThrough();
    const stderrBufs: string[] = [];
    stderr.on('data', (c: Buffer) => stderrBufs.push(c.toString('utf8')));

    const result = await runAdd({
      projectPath: repoPath,
      dbFilePath: dbPath,
      stdout: new PassThrough(),
      stderr,
    });

    expect(result.ok).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(stderrBufs.join('')).toContain('warning:');
    expect(result.project?.name).toBe('repo');
  });

  it('migrations run on a fresh DB file', async () => {
    // dbPath does not exist. runAdd must apply migrations 0001..0009 so the
    // projects table has every Phase 5A column.
    await initRepo(repoPath);

    const result = await runAdd({
      projectPath: repoPath,
      dbFilePath: dbPath,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });

    expect(result.ok).toBe(true);
    const probe = new Database(dbPath, { readonly: true });
    const cols = probe.prepare('PRAGMA table_info(projects)').all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    probe.close();

    // 5A columns must all be present after fresh-DB add.
    expect(names.has('worktree_dir')).toBe(true);
    expect(names.has('quality_pipeline')).toBe(true);
    expect(names.has('default_autonomy_tier')).toBe(true);
    expect(names.has('maestro_warmth')).toBe(true);
  });
});
