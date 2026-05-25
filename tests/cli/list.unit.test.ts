import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runAdd } from '../../src/cli/add.js';
import { runList } from '../../src/cli/list.js';
import {
  SYMPHONY_CONFIG_FILE_ENV,
  _resetConfigWriteQueue,
} from '../../src/utils/config.js';

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

beforeEach(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), 'symphony-list-'));
  home = path.join(sandbox, 'home');
  mkdirSync(path.join(home, '.symphony'), { recursive: true });
  dbPath = path.join(home, '.symphony', 'symphony.db');
});

afterEach(() => {
  try {
    rmSync(sandbox, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('runList (Phase 5B)', () => {
  it('prints a friendly hint when the DB file does not exist', async () => {
    const stdout = new PassThrough();
    const stdoutBufs: string[] = [];
    stdout.on('data', (c: Buffer) => stdoutBufs.push(c.toString('utf8')));

    const result = await runList({
      dbFilePath: dbPath,
      stdout,
      stderr: new PassThrough(),
    });

    expect(result.ok).toBe(true);
    expect(result.projects).toEqual([]);
    expect(stdoutBufs.join('')).toContain('No projects registered');
    expect(stdoutBufs.join('')).toContain('symphony add');
  });

  it('--json prints [] when the DB file does not exist (scripting-safe)', async () => {
    const stdout = new PassThrough();
    const stdoutBufs: string[] = [];
    stdout.on('data', (c: Buffer) => stdoutBufs.push(c.toString('utf8')));

    const result = await runList({
      dbFilePath: dbPath,
      format: 'json',
      stdout,
      stderr: new PassThrough(),
    });

    expect(result.ok).toBe(true);
    expect(stdoutBufs.join('').trim()).toBe('[]');
  });

  it('prints "no projects" line when DB exists but is empty', async () => {
    // Force the DB into existence with no rows.
    const repo = path.join(sandbox, 'init');
    await initRepo(repo);
    const r = await runAdd({
      projectPath: repo,
      dbFilePath: dbPath,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    expect(r.ok).toBe(true);

    // Now delete the row directly so the DB exists but is empty.
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(dbPath);
    db.exec("DELETE FROM projects WHERE name = 'init'");
    db.close();

    const stdout = new PassThrough();
    const stdoutBufs: string[] = [];
    stdout.on('data', (c: Buffer) => stdoutBufs.push(c.toString('utf8')));

    const result = await runList({
      dbFilePath: dbPath,
      stdout,
      stderr: new PassThrough(),
    });
    expect(result.ok).toBe(true);
    expect(result.projects).toEqual([]);
    expect(stdoutBufs.join('')).toContain('No projects registered');
  });

  it('happy path: prints a table with one row after a single add', async () => {
    const repo = path.join(sandbox, 'demo-app');
    await initRepo(repo);
    writeFileSync(
      path.join(repo, '.symphony.json'),
      JSON.stringify({
        project: { qualityPipeline: 'simplified', defaultAutonomyTier: 2 },
      }),
      'utf8',
    );
    const addResult = await runAdd({
      projectPath: repo,
      dbFilePath: dbPath,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    expect(addResult.ok).toBe(true);

    const stdout = new PassThrough();
    const stdoutBufs: string[] = [];
    stdout.on('data', (c: Buffer) => stdoutBufs.push(c.toString('utf8')));

    const result = await runList({
      dbFilePath: dbPath,
      stdout,
      stderr: new PassThrough(),
    });
    expect(result.ok).toBe(true);
    expect(result.projects.length).toBe(1);
    expect(result.projects[0]!.name).toBe('demo-app');

    const out = stdoutBufs.join('');
    // Headers + the row.
    expect(out).toContain('NAME');
    expect(out).toContain('PATH');
    expect(out).toContain('TIER');
    expect(out).toContain('PIPELINE');
    expect(out).toContain('demo-app');
    expect(out).toContain('T2');
    expect(out).toContain('simplified');
  });

  it('--json output is parseable JSON matching the snapshots', async () => {
    const repo = path.join(sandbox, 'json-demo');
    await initRepo(repo);
    const addResult = await runAdd({
      projectPath: repo,
      dbFilePath: dbPath,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    expect(addResult.ok).toBe(true);

    const stdout = new PassThrough();
    const stdoutBufs: string[] = [];
    stdout.on('data', (c: Buffer) => stdoutBufs.push(c.toString('utf8')));

    const result = await runList({
      dbFilePath: dbPath,
      format: 'json',
      stdout,
      stderr: new PassThrough(),
    });
    expect(result.ok).toBe(true);

    const parsed = JSON.parse(stdoutBufs.join(''));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(1);
    expect(parsed[0].name).toBe('json-demo');
    expect(parsed[0].path).toBe(path.resolve(repo));
    expect(parsed[0].id).toBe('json-demo');
  });

  describe('Phase 5D — active project annotation', () => {
    let priorConfig: string | undefined;
    let configPath: string;

    beforeEach(() => {
      configPath = path.join(home, '.symphony', 'config.json');
      priorConfig = process.env[SYMPHONY_CONFIG_FILE_ENV];
      process.env[SYMPHONY_CONFIG_FILE_ENV] = configPath;
      _resetConfigWriteQueue();
    });

    afterEach(() => {
      if (priorConfig === undefined) {
        delete process.env[SYMPHONY_CONFIG_FILE_ENV];
      } else {
        process.env[SYMPHONY_CONFIG_FILE_ENV] = priorConfig;
      }
      _resetConfigWriteQueue();
    });

    it('table: annotates the active row with " (active)" suffix on NAME', async () => {
      const repoA = path.join(sandbox, 'projA');
      const repoB = path.join(sandbox, 'projB');
      for (const r of [repoA, repoB]) {
        await initRepo(r);
        await runAdd({
          projectPath: r,
          dbFilePath: dbPath,
          stdout: new PassThrough(),
          stderr: new PassThrough(),
        });
      }
      writeFileSync(
        configPath,
        JSON.stringify({ schemaVersion: 1, activeProject: 'projb' }, null, 2),
      );

      const stdout = new PassThrough();
      const stdoutBufs: string[] = [];
      stdout.on('data', (c: Buffer) => stdoutBufs.push(c.toString('utf8')));

      const result = await runList({
        dbFilePath: dbPath,
        stdout,
        stderr: new PassThrough(),
      });
      expect(result.ok).toBe(true);
      expect(result.activeProject).toBe('projb');

      const out = stdoutBufs.join('');
      expect(out).toContain('projb (active)');
      // The non-active row stays bare (runAdd lowercases names per
      // `toProjectIdSlug`; tests rely on that slug shape).
      expect(out).toContain('proja ');
      expect(out).not.toContain('proja (active)');
    });

    it('JSON: spreads `active: true` only on the matching row', async () => {
      const repoA = path.join(sandbox, 'projA');
      const repoB = path.join(sandbox, 'projB');
      for (const r of [repoA, repoB]) {
        await initRepo(r);
        await runAdd({
          projectPath: r,
          dbFilePath: dbPath,
          stdout: new PassThrough(),
          stderr: new PassThrough(),
        });
      }
      writeFileSync(
        configPath,
        JSON.stringify({ schemaVersion: 1, activeProject: 'proja' }, null, 2),
      );

      const stdout = new PassThrough();
      const stdoutBufs: string[] = [];
      stdout.on('data', (c: Buffer) => stdoutBufs.push(c.toString('utf8')));

      const result = await runList({
        dbFilePath: dbPath,
        format: 'json',
        stdout,
        stderr: new PassThrough(),
      });
      expect(result.ok).toBe(true);
      expect(result.activeProject).toBe('proja');

      const parsed = JSON.parse(stdoutBufs.join('')) as ReadonlyArray<
        { name: string; active?: boolean }
      >;
      expect(parsed).toHaveLength(2);
      const projA = parsed.find((p) => p.name === 'proja');
      const projB = parsed.find((p) => p.name === 'projb');
      expect(projA?.active).toBe(true);
      expect(projB?.active).toBeUndefined();
    });

    it('no annotation when config.activeProject is absent', async () => {
      const repo = path.join(sandbox, 'solo');
      await initRepo(repo);
      await runAdd({
        projectPath: repo,
        dbFilePath: dbPath,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
      });
      // No config file present.

      const stdout = new PassThrough();
      const stdoutBufs: string[] = [];
      stdout.on('data', (c: Buffer) => stdoutBufs.push(c.toString('utf8')));

      const result = await runList({
        dbFilePath: dbPath,
        stdout,
        stderr: new PassThrough(),
      });
      expect(result.ok).toBe(true);
      expect(result.activeProject).toBeNull();
      expect(stdoutBufs.join('')).not.toContain('(active)');
    });

    it('stale activeProject (no matching row) does NOT annotate any row', async () => {
      const repo = path.join(sandbox, 'real');
      await initRepo(repo);
      await runAdd({
        projectPath: repo,
        dbFilePath: dbPath,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
      });
      writeFileSync(
        configPath,
        JSON.stringify({ schemaVersion: 1, activeProject: 'ghost' }, null, 2),
      );

      const stdout = new PassThrough();
      const stdoutBufs: string[] = [];
      stdout.on('data', (c: Buffer) => stdoutBufs.push(c.toString('utf8')));

      const result = await runList({
        dbFilePath: dbPath,
        stdout,
        stderr: new PassThrough(),
      });
      expect(result.ok).toBe(true);
      // The activeProject value is surfaced verbatim — config wins
      // over store state. Consumers (the table renderer here) decide
      // whether to annotate based on a name match.
      expect(result.activeProject).toBe('ghost');
      expect(stdoutBufs.join('')).not.toContain('(active)');
    });
  });

  it('runs without server-running probe (must work while server is up)', async () => {
    // Seed via a real add first.
    const repo = path.join(sandbox, 'live-app');
    await initRepo(repo);
    await runAdd({
      projectPath: repo,
      dbFilePath: dbPath,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });

    // Hold a long-running IMMEDIATE write transaction (simulates server).
    // runList must still succeed — reads in WAL mode don't block on
    // writers. We rely on better-sqlite3's default busy_timeout (5000ms)
    // to ride out any transient contention from SymphonyDatabase.open's
    // schema validation reads.
    const Database = (await import('better-sqlite3')).default;
    const holder = new Database(dbPath);
    holder.pragma('journal_mode = WAL');
    holder.exec('BEGIN IMMEDIATE');

    try {
      const result = await runList({
          dbFilePath: dbPath,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
      });
      expect(result.ok).toBe(true);
      expect(result.projects.length).toBe(1);
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
    }
  });
});
