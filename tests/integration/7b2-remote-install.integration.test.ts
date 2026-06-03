/**
 * Phase 7B.2 — REAL subprocess integration for remote plugin install. No
 * network: the npm source is a tarball produced by `npm pack` of a local
 * fixture; the git source is a local bare repo with a committed fixture.
 *
 * Exercises runPluginInstall end-to-end through its DEFAULT runNpm/runGit
 * (real `npm install --prefix` extraction + real `git clone`), then asserts
 * the plugin landed in the store, the DB recorded the spec/URL, and `.git`
 * was stripped from the git install.
 *
 * Skips with a warning if npm/git aren't on PATH.
 */
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runPluginInstall, runPluginList } from '../../src/cli/plugin.js';
import { pluginDir } from '../../src/plugins/paths.js';
import { quoteWinShellArg } from '../../src/cli/update-catalogs.js';

const IS_WIN = process.platform === 'win32';

function toolOk(bin: string): boolean {
  try {
    const r = run(bin, ['--version']);
    return r.status === 0;
  } catch {
    return false;
  }
}

/** Run a setup command. npm is a `.cmd` on Win32 → shell:true + quoting; git is a `.exe`. */
function run(
  bin: string,
  args: string[],
  opts: { cwd?: string } = {},
): { status: number | null; stdout: string; stderr: string } {
  if (IS_WIN && bin === 'npm') {
    const cmd = [bin, ...args].map(quoteWinShellArg).join(' ');
    const r = spawnSync(cmd, { cwd: opts.cwd, shell: true, encoding: 'utf8' });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  }
  const r = spawnSync(bin, args, { cwd: opts.cwd, shell: false, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const NPM_OK = toolOk('npm');
const GIT_OK = toolOk('git');

let tmpRoot: string;
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

/** Write a minimal, dependency-free, self-contained plugin fixture. */
function writeFixture(dir: string, id: string): void {
  mkdirSync(path.join(dir, 'dist'), { recursive: true });
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
      author: 'it',
      description: 'integration fixture',
      entrypoint: { command: 'node', args: ['dist/index.js'] },
    }),
    'utf8',
  );
  writeFileSync(path.join(dir, 'dist', 'index.js'), 'process.stdin.resume();', 'utf8');
}

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'sym-7b2-it-'));
  home = path.join(tmpRoot, 'home');
  mkdirSync(home, { recursive: true });
  dbFilePath = path.join(tmpRoot, 'symphony.db');
  fetchTmp = path.join(tmpRoot, 'fetch');
  mkdirSync(fetchTmp, { recursive: true });
});
afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('remote install (real npm)', () => {
  it.skipIf(!NPM_OK)('installs a plugin from an npm tarball spec', async () => {
    // Build a tarball from a local fixture — no registry, no network.
    const fixture = path.join(tmpRoot, 'npm-fixture');
    writeFixture(fixture, 'sym-it-npm');
    const packOut = path.join(tmpRoot, 'pack');
    mkdirSync(packOut, { recursive: true });
    const packed = run('npm', ['pack', fixture, '--pack-destination', packOut, '--ignore-scripts']);
    expect(packed.status).toBe(0);
    const tgz = readdirSync(packOut).find((f) => f.endsWith('.tgz'));
    expect(tgz).toBeDefined();
    const tgzPath = path.join(packOut, tgz!);

    const err = capture();
    const r = await runPluginInstall({
      source: tgzPath,
      tmpRoot: fetchTmp,
      dbFilePath,
      home,
      now: NOW,
      stderr: err.stream,
    });
    expect(r.exitCode).toBe(0);
    expect(existsSync(path.join(pluginDir('sym-it-npm', home), 'plugin.json'))).toBe(true);

    const out = capture();
    await runPluginList({ dbFilePath, home, format: 'json', stdout: out.stream });
    const parsed = JSON.parse(out.text()) as Array<{ id: string; source: string; enabled: boolean }>;
    expect(parsed[0]?.id).toBe('sym-it-npm');
    expect(parsed[0]?.source).toBe(tgzPath);
    expect(parsed[0]?.enabled).toBe(false);
    expect(readdirSync(fetchTmp)).toHaveLength(0); // temp cleaned up
  }, 60_000);
});

describe('remote install (real git)', () => {
  it.skipIf(!GIT_OK)('installs a plugin from a local bare git repo', async () => {
    // working repo → commit fixture → bare clone (the install source).
    const work = path.join(tmpRoot, 'work');
    mkdirSync(work, { recursive: true });
    writeFixture(work, 'sym-it-git');
    expect(run('git', ['init', '-b', 'main'], { cwd: work }).status).toBe(0);
    run('git', ['config', 'user.email', 't@t'], { cwd: work });
    run('git', ['config', 'user.name', 'tester'], { cwd: work });
    expect(run('git', ['add', '-A'], { cwd: work }).status).toBe(0);
    expect(run('git', ['commit', '-m', 'init'], { cwd: work }).status).toBe(0);

    const bare = path.join(tmpRoot, 'sym-it-git.git');
    expect(run('git', ['clone', '--bare', work, bare]).status).toBe(0);

    const err = capture();
    const r = await runPluginInstall({
      source: bare, // ends in `.git` → classified git
      tmpRoot: fetchTmp,
      dbFilePath,
      home,
      now: NOW,
      stderr: err.stream,
    });
    expect(r.exitCode).toBe(0);

    const installed = pluginDir('sym-it-git', home);
    expect(existsSync(path.join(installed, 'plugin.json'))).toBe(true);
    expect(existsSync(path.join(installed, 'dist', 'index.js'))).toBe(true);
    expect(existsSync(path.join(installed, '.git'))).toBe(false); // stripped

    const out = capture();
    await runPluginList({ dbFilePath, home, format: 'json', stdout: out.stream });
    const parsed = JSON.parse(out.text()) as Array<{ id: string; source: string }>;
    expect(parsed[0]?.source).toBe(bare);
    expect(readdirSync(fetchTmp)).toHaveLength(0);
  }, 60_000);
});

if (!NPM_OK || !GIT_OK) {
  console.warn(
    `[7b2 integration] skipped some cases — npm:${NPM_OK ? 'ok' : 'MISSING'} git:${GIT_OK ? 'ok' : 'MISSING'}`,
  );
}
