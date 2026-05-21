/**
 * Phase 5B production scenario — exercises the `symphony add` / `list` /
 * `remove` CLI round-trip end-to-end against a real git repo, real
 * `.symphony.json`, and a real SQLite DB created from a fresh-machine
 * state (DB file does not exist at scenario start).
 *
 * See `tests/scenarios/5b.md` for the Given/When/Then.
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
  writeFileSync(path.join(repoPath, 'README.md'), '# demo\n');
  await git(repoPath, 'add', '.');
  await git(repoPath, 'commit', '-m', 'init');
}

describe('Phase 5B scenario — add → list → remove round-trip (real fs + real git + real sqlite)', () => {
  let sandbox: string;
  let home: string;
  let dbPath: string;
  let repoPath: string;

  beforeEach(() => {
    sandbox = mkdtempSync(path.join(tmpdir(), 'sym-5b-scn-'));
    home = path.join(sandbox, 'home');
    mkdirSync(path.join(home, '.symphony'), { recursive: true });
    dbPath = path.join(home, '.symphony', 'symphony.db');
    repoPath = path.join(sandbox, 'demo-app');
  });

  afterEach(() => {
    try {
      rmSync(sandbox, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('Given+When+Then — full CLI round-trip on a real git repo with .symphony.json overlay', async () => {
    // ── Given ────────────────────────────────────────────────────────
    await initRepo(repoPath);
    writeFileSync(
      path.join(repoPath, 'package.json'),
      JSON.stringify({ name: 'demo-app', version: '0.0.0' }),
      'utf8',
    );
    writeFileSync(
      path.join(repoPath, '.symphony.json'),
      JSON.stringify({
        project: {
          qualityPipeline: 'simplified',
          defaultAutonomyTier: 2,
          previewCommand: 'pnpm dev',
        },
      }),
      'utf8',
    );
    expect(existsSync(dbPath)).toBe(false);

    // ── When 1: runAdd ───────────────────────────────────────────────
    const addStdout = new PassThrough();
    const addBufs: string[] = [];
    addStdout.on('data', (c: Buffer) => addBufs.push(c.toString('utf8')));

    const addResult = await runAdd({
      projectPath: repoPath,
      dbFilePath: dbPath,
      stdout: addStdout,
      stderr: new PassThrough(),
    });

    // ── Then 1: registered + overlay persisted ───────────────────────
    expect(addResult.ok).toBe(true);
    expect(addResult.project?.name).toBe('demo-app');
    expect(addResult.project?.path).toBe(path.resolve(repoPath));
    expect(existsSync(dbPath)).toBe(true);
    expect(addBufs.join('')).toContain("Registered 'demo-app'");

    // Raw SQL verification — overlay round-tripped through migrations + INSERT.
    {
      const probe = new Database(dbPath, { readonly: true });
      const row = probe
        .prepare(
          'SELECT name, path, quality_pipeline, default_autonomy_tier, preview_command ' +
            'FROM projects WHERE id = ?',
        )
        .get('demo-app') as {
        name: string;
        path: string;
        quality_pipeline: string;
        default_autonomy_tier: number;
        preview_command: string;
      };
      probe.close();
      expect(row.name).toBe('demo-app');
      expect(row.path).toBe(path.resolve(repoPath));
      expect(row.quality_pipeline).toBe('simplified');
      expect(row.default_autonomy_tier).toBe(2);
      expect(row.preview_command).toBe('pnpm dev');
    }

    // ── When 2: runList --json ───────────────────────────────────────
    const listStdout = new PassThrough();
    const listBufs: string[] = [];
    listStdout.on('data', (c: Buffer) => listBufs.push(c.toString('utf8')));

    const listResult = await runList({
      dbFilePath: dbPath,
      format: 'json',
      stdout: listStdout,
      stderr: new PassThrough(),
    });

    // ── Then 2: one snapshot with the overlay surfaced ───────────────
    expect(listResult.ok).toBe(true);
    expect(listResult.projects.length).toBe(1);

    const parsed = JSON.parse(listBufs.join(''));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(1);
    expect(parsed[0].name).toBe('demo-app');
    expect(parsed[0].qualityPipeline).toBe('simplified');
    expect(parsed[0].defaultAutonomyTier).toBe(2);
    expect(parsed[0].previewCommand).toBe('pnpm dev');

    // ── When 3: runRemove ────────────────────────────────────────────
    const removeStdout = new PassThrough();
    const removeBufs: string[] = [];
    removeStdout.on('data', (c: Buffer) => removeBufs.push(c.toString('utf8')));

    const removeResult = await runRemove({
      nameOrId: 'demo-app',
      dbFilePath: dbPath,
      stdout: removeStdout,
      stderr: new PassThrough(),
    });

    // ── Then 3: row gone; subsequent list returns [] ─────────────────
    expect(removeResult.ok).toBe(true);
    expect(removeResult.removed?.name).toBe('demo-app');
    expect(removeBufs.join('')).toContain("Removed 'demo-app'");

    {
      const probe = new Database(dbPath, { readonly: true });
      const count = probe.prepare('SELECT COUNT(*) AS c FROM projects').get() as { c: number };
      probe.close();
      expect(count.c).toBe(0);
    }

    const finalListStdout = new PassThrough();
    const finalListBufs: string[] = [];
    finalListStdout.on('data', (c: Buffer) => finalListBufs.push(c.toString('utf8')));

    const finalListResult = await runList({
      dbFilePath: dbPath,
      format: 'json',
      stdout: finalListStdout,
      stderr: new PassThrough(),
    });
    expect(finalListResult.ok).toBe(true);
    expect(finalListBufs.join('').trim()).toBe('[]');
  });
});
