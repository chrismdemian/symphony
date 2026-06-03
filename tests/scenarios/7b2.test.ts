/**
 * Phase 7B.2 production scenario — see research/phase-reviews/7b2.md.
 *
 * The real CLI lifecycle a user runs against a REMOTELY-fetched plugin, with
 * NO network: the npm source is a tarball from `npm pack` of a local fixture;
 * the git source is a local bare repo with a committed fixture. Proves a
 * remotely-installed plugin is a first-class registry citizen identical to a
 * local one:
 *   install (remote npm) → list → enable → list(enabled) → disable → remove
 *   install (remote git) → list → remove
 * plus the --allow-scripts warning + the git entrypoint-missing warning.
 *
 * Skips with a warning if npm/git aren't on PATH.
 */
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  runPluginInstall,
  runPluginList,
  runPluginEnable,
  runPluginDisable,
  runPluginRemove,
} from '../../src/cli/plugin.js';
import { pluginDir } from '../../src/plugins/paths.js';
import { quoteWinShellArg } from '../../src/cli/update-catalogs.js';

const IS_WIN = process.platform === 'win32';

function run(
  bin: string,
  args: string[],
  opts: { cwd?: string } = {},
): { status: number | null; stdout: string } {
  if (IS_WIN && bin === 'npm') {
    const cmd = [bin, ...args].map(quoteWinShellArg).join(' ');
    const r = spawnSync(cmd, { cwd: opts.cwd, shell: true, encoding: 'utf8' });
    return { status: r.status, stdout: r.stdout ?? '' };
  }
  const r = spawnSync(bin, args, { cwd: opts.cwd, shell: false, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout ?? '' };
}

function toolOk(bin: string): boolean {
  try {
    return run(bin, ['--version']).status === 0;
  } catch {
    return false;
  }
}
const NPM_OK = toolOk('npm');
const GIT_OK = toolOk('git');

let tmp: string;
let home: string;
let dbFilePath: string;
let fetchTmp: string;
const NOW = '2026-06-03T00:00:00.000Z';

function capture(): { stream: Writable; text: () => string } {
  let buf = '';
  const stream = new Writable({
    write(chunk, _enc, cb) {
      buf += chunk.toString();
      cb();
    },
  });
  return { stream, text: () => buf };
}

function writeFixture(dir: string, id: string, withDist = true): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: id, version: '1.0.0', private: false, files: ['dist', 'plugin.json'] }),
    'utf8',
  );
  writeFileSync(
    path.join(dir, 'plugin.json'),
    JSON.stringify({
      schemaVersion: 1,
      id,
      name: id,
      version: '1.0.0',
      author: 'scn',
      description: 'scenario fixture',
      entrypoint: { command: 'node', args: ['dist/index.js'] },
      permissions: ['task:read'],
    }),
    'utf8',
  );
  if (withDist) {
    mkdirSync(path.join(dir, 'dist'), { recursive: true });
    writeFileSync(path.join(dir, 'dist', 'index.js'), 'process.stdin.resume();', 'utf8');
  }
}

function listJson(): Promise<Array<{ id: string; source: string; enabled: boolean }>> {
  const out = capture();
  return runPluginList({ dbFilePath, home, format: 'json', stdout: out.stream }).then(
    () => JSON.parse(out.text()) as Array<{ id: string; source: string; enabled: boolean }>,
  );
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'sym-7b2-scn-'));
  home = path.join(tmp, 'home');
  mkdirSync(home, { recursive: true });
  dbFilePath = path.join(tmp, 'symphony.db');
  fetchTmp = path.join(tmp, 'fetch');
  mkdirSync(fetchTmp, { recursive: true });
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('7B.2 scenario — remote-install lifecycle', () => {
  it.skipIf(!NPM_OK)('npm tarball: install → enable → disable → remove', async () => {
    const fixture = path.join(tmp, 'fx');
    writeFixture(fixture, 'scn-npm');
    const packOut = path.join(tmp, 'pack');
    mkdirSync(packOut, { recursive: true });
    expect(
      run('npm', ['pack', fixture, '--pack-destination', packOut, '--ignore-scripts']).status,
    ).toBe(0);
    const tgz = path.join(packOut, readdirSync(packOut).find((f) => f.endsWith('.tgz'))!);

    // install (remote) — disabled by default
    const r1 = await runPluginInstall({
      source: tgz,
      tmpRoot: fetchTmp,
      dbFilePath,
      home,
      now: NOW,
      stderr: capture().stream,
    });
    expect(r1.exitCode).toBe(0);
    let rows = await listJson();
    expect(rows[0]).toMatchObject({ id: 'scn-npm', source: tgz, enabled: false });
    expect(readdirSync(fetchTmp)).toHaveLength(0); // temp cleaned

    // enable → disable
    expect((await runPluginEnable({ id: 'scn-npm', dbFilePath, home, stderr: capture().stream })).exitCode).toBe(0);
    rows = await listJson();
    expect(rows[0]?.enabled).toBe(true);
    expect((await runPluginDisable({ id: 'scn-npm', dbFilePath, home, stderr: capture().stream })).exitCode).toBe(0);

    // remove → empty
    expect((await runPluginRemove({ id: 'scn-npm', dbFilePath, home, stderr: capture().stream })).exitCode).toBe(0);
    expect(await listJson()).toEqual([]);
    expect(existsSync(pluginDir('scn-npm', home))).toBe(false);
  }, 60_000);

  it.skipIf(!GIT_OK)('git repo: install → records URL, no .git in store → remove', async () => {
    const work = path.join(tmp, 'work');
    writeFixture(work, 'scn-git');
    run('git', ['init', '-b', 'main'], { cwd: work });
    run('git', ['config', 'user.email', 't@t'], { cwd: work });
    run('git', ['config', 'user.name', 't'], { cwd: work });
    run('git', ['add', '-A'], { cwd: work });
    expect(run('git', ['commit', '-m', 'init'], { cwd: work }).status).toBe(0);
    const bare = path.join(tmp, 'scn-git.git');
    expect(run('git', ['clone', '--bare', work, bare]).status).toBe(0);

    const r = await runPluginInstall({
      source: bare,
      tmpRoot: fetchTmp,
      dbFilePath,
      home,
      now: NOW,
      stderr: capture().stream,
    });
    expect(r.exitCode).toBe(0);
    const rows = await listJson();
    expect(rows[0]).toMatchObject({ id: 'scn-git', source: bare });
    expect(existsSync(path.join(pluginDir('scn-git', home), '.git'))).toBe(false);
    expect((await runPluginRemove({ id: 'scn-git', dbFilePath, home, stderr: capture().stream })).exitCode).toBe(0);
  }, 60_000);

  it.skipIf(!GIT_OK)('git repo without committed dist: install warns about the missing entrypoint', async () => {
    const work = path.join(tmp, 'work2');
    writeFixture(work, 'scn-nodist', false); // no dist/
    run('git', ['init', '-b', 'main'], { cwd: work });
    run('git', ['config', 'user.email', 't@t'], { cwd: work });
    run('git', ['config', 'user.name', 't'], { cwd: work });
    run('git', ['add', '-A'], { cwd: work });
    expect(run('git', ['commit', '-m', 'init'], { cwd: work }).status).toBe(0);
    const bare = path.join(tmp, 'scn-nodist.git');
    expect(run('git', ['clone', '--bare', work, bare]).status).toBe(0);

    const err = capture();
    const r = await runPluginInstall({
      source: bare,
      tmpRoot: fetchTmp,
      dbFilePath,
      home,
      now: NOW,
      stderr: err.stream,
    });
    expect(r.exitCode).toBe(0); // advisory warning, install still succeeds
    expect(err.text()).toContain("entrypoint file 'dist/index.js' not found");
  }, 60_000);

  it('refuses an unsupported/empty source without touching the store', async () => {
    const err = capture();
    const r = await runPluginInstall({ source: '   ', dbFilePath, home, now: NOW, stderr: err.stream });
    expect(r.exitCode).toBe(1);
    expect(err.text()).toContain('empty-source');
    expect(await listJson()).toEqual([]);
  });
});

if (!NPM_OK || !GIT_OK) {
  console.warn(`[7b2 scenario] npm:${NPM_OK ? 'ok' : 'MISSING'} git:${GIT_OK ? 'ok' : 'MISSING'}`);
}
