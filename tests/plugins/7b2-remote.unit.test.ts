/**
 * Phase 7B.2 — classifySource / parseNpmPackageName / splitGitRef and
 * resolveRemoteSource with fake `runNpm`/`runGit` runners. No network, no
 * real subprocess — the fakes write into the temp dir resolveRemoteSource
 * hands them, exactly as npm/git would.
 */
import path from 'node:path';
import os from 'node:os';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  classifySource,
  parseNpmPackageName,
  splitGitRef,
  resolveRemoteSource,
  type RemoteRunner,
  type RemoteRunResult,
} from '../../src/plugins/remote.js';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'sym-7b2-'));
});
afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// classifySource
// ---------------------------------------------------------------------------

describe('classifySource', () => {
  it('classifies npm registry specs', () => {
    expect(classifySource('left-pad')).toBe('npm');
    expect(classifySource('left-pad@1.2.3')).toBe('npm');
    expect(classifySource('left-pad@next')).toBe('npm');
    expect(classifySource('@scope/pkg')).toBe('npm');
    expect(classifySource('@scope/pkg@2.0.0')).toBe('npm');
  });

  it('classifies all git URL forms', () => {
    expect(classifySource('git+https://github.com/u/r.git')).toBe('git');
    expect(classifySource('git@github.com:u/r.git')).toBe('git');
    expect(classifySource('ssh://git@host/u/r.git')).toBe('git');
    expect(classifySource('github:u/r')).toBe('git');
    expect(classifySource('gitlab:u/r')).toBe('git');
    expect(classifySource('https://github.com/u/r')).toBe('git'); // known host, no .git
    expect(classifySource('https://example.com/u/r.git')).toBe('git'); // .git suffix
    expect(classifySource('https://example.com/u/r.git#v1.0.0')).toBe('git');
    expect(classifySource('file:///c:/tmp/r.git')).toBe('git');
    expect(classifySource('C:\\tmp\\fixture.git')).toBe('git'); // .git path → git
  });

  it('routes tarballs to npm (before the local check)', () => {
    expect(classifySource('./fixture.tgz')).toBe('npm');
    expect(classifySource('C:\\tmp\\fixture-1.0.0.tgz')).toBe('npm');
    expect(classifySource('pkg-1.0.0.tar.gz')).toBe('npm');
    expect(classifySource('https://host/x.tgz')).toBe('npm');
  });

  it('classifies path-like + on-disk sources as local', () => {
    expect(classifySource('./local-plugin')).toBe('local');
    expect(classifySource('../sibling')).toBe('local');
    expect(classifySource('/abs/plugin')).toBe('local');
    expect(classifySource('C:\\Users\\me\\plugin')).toBe('local');
    expect(classifySource('~/plugins/x')).toBe('local');
    expect(classifySource('some/dir/plugin.json')).toBe('local');
  });

  it('a bare name that is also a local dir resolves local (disk wins)', () => {
    const name = 'collide-pkg';
    mkdirSync(path.join(tmpRoot, name), { recursive: true });
    const cwd = process.cwd();
    try {
      process.chdir(tmpRoot);
      expect(classifySource(name)).toBe('local');
      expect(classifySource('definitely-not-a-local-dir-xyz')).toBe('npm');
    } finally {
      process.chdir(cwd);
    }
  });
});

// ---------------------------------------------------------------------------
// parseNpmPackageName / splitGitRef
// ---------------------------------------------------------------------------

describe('parseNpmPackageName', () => {
  it('parses scoped + unscoped, strips version', () => {
    expect(parseNpmPackageName('left-pad')).toBe('left-pad');
    expect(parseNpmPackageName('left-pad@1.2.3')).toBe('left-pad');
    expect(parseNpmPackageName('left-pad@^1.0.0')).toBe('left-pad');
    expect(parseNpmPackageName('@scope/pkg')).toBe('@scope/pkg');
    expect(parseNpmPackageName('@scope/pkg@2.0.0')).toBe('@scope/pkg');
  });

  it('returns undefined for path/url/tarball specs', () => {
    expect(parseNpmPackageName('./x.tgz')).toBeUndefined();
    expect(parseNpmPackageName('C:\\tmp\\x.tgz')).toBeUndefined();
    expect(parseNpmPackageName('https://host/x.tgz')).toBeUndefined();
    expect(parseNpmPackageName('some/local/dir')).toBeUndefined();
  });
});

describe('splitGitRef', () => {
  it('strips git+ and splits #ref', () => {
    expect(splitGitRef('git+https://h/r.git')).toEqual({ url: 'https://h/r.git' });
    expect(splitGitRef('https://h/r.git#main')).toEqual({ url: 'https://h/r.git', ref: 'main' });
    expect(splitGitRef('git+ssh://h/r.git#v1.0.0')).toEqual({ url: 'ssh://h/r.git', ref: 'v1.0.0' });
    expect(splitGitRef('https://h/r.git#')).toEqual({ url: 'https://h/r.git' }); // empty ref dropped
  });
});

// ---------------------------------------------------------------------------
// Fake runner factories
// ---------------------------------------------------------------------------

interface FakeNpm {
  runner: RemoteRunner;
  calls: { args: string[]; cwd?: string }[];
}

/** A fake `npm install --prefix <tmp> <spec>` that writes node_modules/<name>/plugin.json. */
function fakeNpmInstall(cfg: {
  pkgDir?: string; // node_modules subpath to create (default derived from spec)
  withManifest?: boolean;
  exitCode?: number;
  stderr?: string;
  timedOut?: boolean;
} = {}): FakeNpm {
  const calls: { args: string[]; cwd?: string }[] = [];
  const runner: RemoteRunner = async (args, options) => {
    calls.push({ args: [...args], cwd: options.cwd });
    const result: RemoteRunResult = {
      exitCode: cfg.exitCode ?? 0,
      stdout: '',
      stderr: cfg.stderr ?? '',
      ...(cfg.timedOut === true ? { timedOut: true } : {}),
    };
    if ((cfg.exitCode ?? 0) !== 0 || cfg.timedOut === true) return result;
    const pi = args.indexOf('--prefix');
    const prefix = pi >= 0 ? args[pi + 1]! : options.cwd!;
    const spec = args[1]!;
    const sub =
      cfg.pkgDir ?? parseNpmPackageName(spec) ?? 'unknown-pkg';
    const dir = path.join(prefix, 'node_modules', ...sub.split('/'));
    mkdirSync(dir, { recursive: true });
    if (cfg.withManifest !== false) {
      writeFileSync(path.join(dir, 'plugin.json'), '{}', 'utf8');
    }
    return result;
  };
  return { runner, calls };
}

interface FakeGit {
  runner: RemoteRunner;
  calls: { args: string[]; cwd?: string; env?: NodeJS.ProcessEnv }[];
}

/**
 * A fake git. `clone --branch <ref>` uses `branchExit` (default 0); a plain
 * `clone` uses `cloneExit` (default 0). On a 0-exit clone it writes the clone
 * dir (+ .git, + optional dist). This models real git: `--branch` rejects a
 * raw commit SHA, forcing resolveGit's full-clone + checkout fallback.
 */
function fakeGit(cfg: {
  withManifest?: boolean;
  withDist?: boolean;
  branchExit?: number;
  cloneExit?: number;
  checkoutExit?: number;
  stderr?: string;
} = {}): FakeGit {
  const calls: { args: string[]; cwd?: string; env?: NodeJS.ProcessEnv }[] = [];
  const runner: RemoteRunner = async (args, options) => {
    calls.push({ args: [...args], cwd: options.cwd, env: options.env });
    const sub = args[0];
    if (sub === 'clone') {
      const exit = args.includes('--branch') ? (cfg.branchExit ?? 0) : (cfg.cloneExit ?? 0);
      if (exit !== 0) {
        return { exitCode: exit, stdout: '', stderr: cfg.stderr ?? 'clone failed' };
      }
      const cloneDir = args[args.length - 1]!;
      mkdirSync(path.join(cloneDir, '.git'), { recursive: true });
      writeFileSync(path.join(cloneDir, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
      if (cfg.withManifest !== false) {
        writeFileSync(path.join(cloneDir, 'plugin.json'), '{}', 'utf8');
      }
      if (cfg.withDist === true) {
        mkdirSync(path.join(cloneDir, 'dist'), { recursive: true });
        writeFileSync(path.join(cloneDir, 'dist', 'index.js'), '// built', 'utf8');
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (sub === 'checkout') {
      return { exitCode: cfg.checkoutExit ?? 0, stdout: '', stderr: cfg.stderr ?? '' };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  return { runner, calls };
}

const clonesWithoutBranch = (calls: { args: string[] }[]): { args: string[] }[] =>
  calls.filter((c) => c.args[0] === 'clone' && !c.args.includes('--branch'));

// ---------------------------------------------------------------------------
// resolveRemoteSource — npm
// ---------------------------------------------------------------------------

describe('resolveRemoteSource (npm)', () => {
  it('installs with --ignore-scripts by default and returns the plugin dir', async () => {
    const npm = fakeNpmInstall();
    const r = await resolveRemoteSource({ source: 'cool-plugin@1.0.0', runNpm: npm.runner, tmpRoot });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.kind).toBe('npm');
    expect(r.label).toBe('cool-plugin@1.0.0');
    expect(existsSync(path.join(r.dir, 'plugin.json'))).toBe(true);
    expect(npm.calls[0]!.args).toContain('--ignore-scripts');
    expect(npm.calls[0]!.args).toContain('--prefix');
    // cwd pinned to the temp tree
    expect(npm.calls[0]!.cwd?.startsWith(tmpRoot)).toBe(true);
    await r.cleanup();
    expect(existsSync(r.dir)).toBe(false);
  });

  it('omits --ignore-scripts under allowScripts', async () => {
    const npm = fakeNpmInstall();
    const r = await resolveRemoteSource({
      source: 'cool-plugin',
      allowScripts: true,
      runNpm: npm.runner,
      tmpRoot,
    });
    expect(r.ok).toBe(true);
    expect(npm.calls[0]!.args).not.toContain('--ignore-scripts');
    if (r.ok) await r.cleanup();
  });

  it('resolves a scoped package dir', async () => {
    const npm = fakeNpmInstall();
    const r = await resolveRemoteSource({ source: '@acme/sym-plugin', runNpm: npm.runner, tmpRoot });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.dir.replace(/\\/g, '/')).toContain('node_modules/@acme/sym-plugin');
      await r.cleanup();
    }
  });

  it('falls back to a manifest scan for tarball specs (no name from spec)', async () => {
    const npm = fakeNpmInstall({ pkgDir: 'scanned-plugin' });
    const tgz = path.join(tmpRoot, 'pkg-1.0.0.tgz');
    writeFileSync(tgz, 'x', 'utf8'); // existence not required by npm fake, but keeps it real
    const r = await resolveRemoteSource({ source: tgz, runNpm: npm.runner, tmpRoot });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.dir.replace(/\\/g, '/')).toContain('node_modules/scanned-plugin');
      await r.cleanup();
    }
  });

  it('refuses when npm install fails', async () => {
    const npm = fakeNpmInstall({ exitCode: 1, stderr: '404 Not Found' });
    const r = await resolveRemoteSource({ source: 'nope-pkg', runNpm: npm.runner, tmpRoot });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('npm-fetch-failed');
      await r.cleanup();
    }
  });

  it('classifies npm ENOENT as tool-missing', async () => {
    const npm = fakeNpmInstall({ exitCode: -1, stderr: 'spawn npm ENOENT' });
    const r = await resolveRemoteSource({ source: 'pkg', runNpm: npm.runner, tmpRoot });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('tool-missing');
      await r.cleanup();
    }
  });

  it('reports timeout as fetch-timeout', async () => {
    const npm = fakeNpmInstall({ exitCode: -1, timedOut: true });
    const r = await resolveRemoteSource({ source: 'pkg', runNpm: npm.runner, tmpRoot });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('fetch-timeout');
      await r.cleanup();
    }
  });

  it('refuses when the package has no plugin.json', async () => {
    const npm = fakeNpmInstall({ withManifest: false });
    const r = await resolveRemoteSource({ source: 'not-a-plugin', runNpm: npm.runner, tmpRoot });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('manifest-missing-in-source');
      await r.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// resolveRemoteSource — git
// ---------------------------------------------------------------------------

describe('resolveRemoteSource (git)', () => {
  it('clones (depth 1, no ref), strips .git, returns the clone dir', async () => {
    const git = fakeGit();
    const r = await resolveRemoteSource({
      source: 'https://example.com/u/r.git',
      runGit: git.runner,
      tmpRoot,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.kind).toBe('git');
    expect(r.label).toBe('https://example.com/u/r.git');
    expect(existsSync(path.join(r.dir, 'plugin.json'))).toBe(true);
    expect(existsSync(path.join(r.dir, '.git'))).toBe(false); // stripped
    const clone = git.calls[0]!.args;
    expect(clone).toContain('--depth');
    expect(clone).not.toContain('--branch');
    expect(git.calls.some((c) => c.args[0] === 'checkout')).toBe(false);
    await r.cleanup();
    expect(existsSync(r.dir)).toBe(false);
  });

  it('uses a shallow --branch clone for a branch/tag ref (no fallback, no checkout)', async () => {
    const git = fakeGit();
    const r = await resolveRemoteSource({
      source: 'https://example.com/u/r.git#v1.2.3',
      runGit: git.runner,
      tmpRoot,
    });
    expect(r.ok).toBe(true);
    expect(git.calls[0]!.args).toContain('--branch');
    expect(git.calls[0]!.args).toContain('v1.2.3');
    expect(clonesWithoutBranch(git.calls)).toHaveLength(0); // no fallback
    expect(git.calls.some((c) => c.args[0] === 'checkout')).toBe(false);
    if (r.ok) await r.cleanup();
  });

  it('falls back to a full clone + checkout when --branch is rejected (SHA ref)', async () => {
    const git = fakeGit({ branchExit: 128 }); // git rejects --branch <sha>
    const sha = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
    const r = await resolveRemoteSource({
      source: `https://example.com/u/r.git#${sha}`,
      runGit: git.runner,
      tmpRoot,
    });
    expect(r.ok).toBe(true);
    expect(git.calls[0]!.args).toContain('--branch'); // attempted first
    const fallback = clonesWithoutBranch(git.calls);
    expect(fallback).toHaveLength(1); // full clone fallback
    expect(fallback[0]!.args).not.toContain('--depth');
    const checkout = git.calls.find((c) => c.args[0] === 'checkout');
    expect(checkout?.args).toContain(sha);
    if (r.ok) await r.cleanup();
  });

  it('refuses on clone failure', async () => {
    const git = fakeGit({ cloneExit: 128, stderr: 'Repository not found' });
    const r = await resolveRemoteSource({ source: 'https://x/y.git', runGit: git.runner, tmpRoot });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('git-clone-failed');
      await r.cleanup();
    }
  });

  it('refuses on checkout failure after the --branch fallback (SHA)', async () => {
    const git = fakeGit({ branchExit: 128, checkoutExit: 1, stderr: 'unknown revision' });
    const sha = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    const r = await resolveRemoteSource({
      source: `https://x/y.git#${sha}`,
      runGit: git.runner,
      tmpRoot,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('git-checkout-failed');
      await r.cleanup();
    }
  });

  it('refuses when the repo root has no plugin.json', async () => {
    const git = fakeGit({ withManifest: false });
    const r = await resolveRemoteSource({ source: 'https://x/y.git', runGit: git.runner, tmpRoot });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('manifest-missing-in-source');
      await r.cleanup();
    }
  });

  it('allowScripts runs an npm build inside the clone', async () => {
    const git = fakeGit({ withDist: false }); // clone ships no dist
    let built = false;
    const runNpm: RemoteRunner = async (args, options) => {
      // simulate the build producing dist/index.js in the clone cwd
      if (args[0] === 'install') {
        built = true;
        mkdirSync(path.join(options.cwd!, 'dist'), { recursive: true });
        writeFileSync(path.join(options.cwd!, 'dist', 'index.js'), '// built', 'utf8');
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const r = await resolveRemoteSource({
      source: 'https://x/y.git',
      allowScripts: true,
      runGit: git.runner,
      runNpm,
      tmpRoot,
    });
    expect(r.ok).toBe(true);
    expect(built).toBe(true);
    if (r.ok) {
      expect(existsSync(path.join(r.dir, 'dist', 'index.js'))).toBe(true);
      await r.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// resolveRemoteSource — security hardening (argv injection + transports)
// ---------------------------------------------------------------------------

describe('resolveRemoteSource (security)', () => {
  it('refuses an npm-ish source that starts with `-` (flag smuggling)', async () => {
    let called = false;
    const r = await resolveRemoteSource({
      source: '--registry=http://evil',
      runNpm: async () => {
        called = true;
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      tmpRoot,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('unsafe-source');
    expect(called).toBe(false); // never spawned
  });

  it('refuses a git-ish source that starts with `-` (e.g. `--upload-pack=…`.git)', async () => {
    let called = false;
    const r = await resolveRemoteSource({
      source: '--upload-pack=touch x.git',
      runGit: async () => {
        called = true;
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      tmpRoot,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('unsafe-source');
    expect(called).toBe(false);
  });

  it('refuses a git ref (#fragment) that starts with `-`', async () => {
    const git = fakeGit();
    const r = await resolveRemoteSource({
      source: 'https://example.com/u/r.git#--upload-pack=evil',
      runGit: git.runner,
      tmpRoot,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('unsafe-source');
    expect(git.calls).toHaveLength(0); // refused before any git call
  });

  it('sets GIT_ALLOW_PROTOCOL (blocks ext::/fd:: helper transports) and passes `--` to clone', async () => {
    const git = fakeGit();
    const r = await resolveRemoteSource({
      source: 'https://example.com/u/r.git',
      runGit: git.runner,
      tmpRoot,
    });
    expect(r.ok).toBe(true);
    const clone = git.calls[0]!;
    expect(clone.env?.GIT_ALLOW_PROTOCOL).toBe('file:git:http:https:ssh');
    expect(clone.env?.GIT_TERMINAL_PROMPT).toBe('0');
    // `--` terminates options before the positional URL + dir.
    const dashIdx = clone.args.indexOf('--');
    expect(dashIdx).toBeGreaterThan(-1);
    expect(clone.args[dashIdx + 1]).toBe('https://example.com/u/r.git');
    if (r.ok) await r.cleanup();
  });
});

// ---------------------------------------------------------------------------
// resolveRemoteSource — local + edge
// ---------------------------------------------------------------------------

describe('resolveRemoteSource (local + edge)', () => {
  it('passes a local dir through without spawning anything', async () => {
    const dir = path.join(tmpRoot, 'local');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'plugin.json'), '{}', 'utf8');
    let npmCalled = false;
    const r = await resolveRemoteSource({
      source: dir,
      runNpm: async () => {
        npmCalled = true;
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      tmpRoot,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.kind).toBe('local');
    expect(r.dir).toBe(dir);
    expect(r.label).toBe(path.resolve(dir));
    expect(npmCalled).toBe(false);
    await r.cleanup(); // no-op, must not throw
  });

  it('refuses an empty source', async () => {
    const r = await resolveRemoteSource({ source: '   ' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('empty-source');
  });
});
