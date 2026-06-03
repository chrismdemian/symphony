import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promises as fsp, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { quoteWinShellArg } from '../cli/update-catalogs.js';
import { PLUGIN_MANIFEST } from './paths.js';

/**
 * Phase 7B.2 — resolve a REMOTE plugin source (npm package spec or git URL)
 * into a local directory containing `plugin.json`, then hand that dir to the
 * existing 7A `installPlugin` path. Local sources pass through untouched.
 *
 * Supply-chain guard: `--ignore-scripts` is the locked DEFAULT for the npm
 * fetch, and git clones never execute repo code. A per-install `allowScripts`
 * opt-in (loud warning at the CLI) lets a build/lifecycle run for trusted
 * sources only.
 *
 * Extraction is delegated to `npm install --prefix` (npm's own `node-tar`),
 * NOT a hand-rolled tar reader — that avoids the bsdtar-vs-GNU ambiguity, the
 * PAX/long-name edge cases, and the tar-slip attack surface entirely.
 *
 * `runNpm` / `runGit` / `tmpRoot` are dependency-injection seams for tests;
 * defaults spawn the real tools. Mirrors `src/cli/update-catalogs.ts`.
 */

export type RemoteSourceKind = 'local' | 'npm' | 'git';

export type RemoteRefusalReason =
  | 'empty-source'
  | 'unsupported-source'
  | 'tool-missing'
  | 'npm-fetch-failed'
  | 'git-clone-failed'
  | 'git-checkout-failed'
  | 'build-failed'
  | 'manifest-missing-in-source'
  | 'fetch-timeout';

export interface RemoteRunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut?: boolean;
}

export interface RemoteRunOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
}

export type RemoteRunner = (
  args: readonly string[],
  options: RemoteRunOptions,
) => Promise<RemoteRunResult>;

export interface ResolveRemoteOptions {
  readonly source: string;
  /** Opt-in to running install/build scripts (default: false → --ignore-scripts). */
  readonly allowScripts?: boolean;
  readonly runNpm?: RemoteRunner;
  readonly runGit?: RemoteRunner;
  /** Override the temp root (default: os.tmpdir()). */
  readonly tmpRoot?: string;
}

export interface ResolvedSource {
  readonly ok: true;
  readonly kind: RemoteSourceKind;
  /** Local directory containing `plugin.json` — handed to `installPlugin`. */
  readonly dir: string;
  /** Original spec/URL — recorded as the DB `source` (not the temp dir). */
  readonly label: string;
  /** Remove any temp tree created during resolution (no-op for local). */
  readonly cleanup: () => Promise<void>;
}

export interface RemoteRefusal {
  readonly ok: false;
  readonly reason: RemoteRefusalReason;
  readonly message: string;
  /** Present on every result so the caller can `finally { cleanup() }` uniformly. */
  readonly cleanup: () => Promise<void>;
}

// Generous bounds — fetch/clone can be slow; builds slower still. The point
// is to bound a HANG (auth prompt, dead registry), not to race a slow link.
const CLONE_TIMEOUT_MS = 120_000;
const NPM_FETCH_TIMEOUT_MS = 120_000;
const BUILD_TIMEOUT_MS = 300_000;

const noop = async (): Promise<void> => {};

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

function isPathLike(s: string): boolean {
  return (
    s.startsWith('./') ||
    s.startsWith('../') ||
    s.startsWith('.\\') ||
    s.startsWith('..\\') ||
    s.startsWith('/') ||
    s.startsWith('\\') ||
    s.startsWith('~') ||
    /^[a-zA-Z]:[\\/]/.test(s) // Windows drive (C:\ or C:/)
  );
}

function existsOnDisk(s: string): boolean {
  try {
    return existsSync(path.resolve(s));
  } catch {
    return false;
  }
}

/**
 * Decide how to fetch a source. Precedence (first match wins):
 *  1. git — explicit git schemes/shorthands, known git hosts, or a `.git`
 *     suffix (the suffix rule also enables network-free tests via
 *     `git init --bare fixture.git`).
 *  2. npm tarball — a `.tgz`/`.tar.gz` is a package, not a plugin dir (also
 *     enables network-free npm tests via `npm pack`). Checked before local
 *     so a local `.tgz` routes to npm.
 *  3. local — a `plugin.json` path, a path-like string, or anything that
 *     exists on disk (a bare name that is also a local dir → local).
 *  4. else — npm registry spec.
 */
export function classifySource(source: string): RemoteSourceKind {
  const s = source.trim();
  if (
    /^git\+/i.test(s) ||
    /^git@/i.test(s) ||
    /^ssh:\/\//i.test(s) ||
    /^file:\/\//i.test(s) ||
    /^(github|gitlab|bitbucket):/i.test(s) ||
    /^https?:\/\/(www\.)?(github|gitlab|bitbucket)\.(com|org)\//i.test(s) ||
    /\.git(#.+)?$/i.test(s)
  ) {
    return 'git';
  }
  if (/\.(tgz|tar\.gz)(#.+)?$/i.test(s)) {
    return 'npm';
  }
  if (path.basename(s) === PLUGIN_MANIFEST || isPathLike(s) || existsOnDisk(s)) {
    return 'local';
  }
  return 'npm';
}

/**
 * Derive the installed package directory name from an npm spec, scope-aware.
 * Returns undefined for path/url/tarball specs (their on-disk `name` isn't
 * derivable from the spec — the manifest scan handles those).
 */
export function parseNpmPackageName(spec: string): string | undefined {
  const s = spec.trim();
  if (s === '' || s.includes('://') || /\.(tgz|tar\.gz)$/i.test(s)) return undefined;
  if (s.startsWith('@')) {
    const m = /^(@[^/@\s]+\/[^/@\s]+)(?:@[^@\s]*)?$/.exec(s);
    return m ? m[1] : undefined;
  }
  if (/[\\/]/.test(s)) return undefined; // unscoped name can't contain a separator
  const m = /^([^@\s][^@\s]*)(?:@[^@\s]*)?$/.exec(s);
  return m ? m[1] : undefined;
}

// ---------------------------------------------------------------------------
// Spawning
// ---------------------------------------------------------------------------

function killProc(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    // `child.kill` only signals the cmd.exe wrapper under shell:true; walk the
    // tree (mirrors finalize-runner's killTree). Best effort.
    try {
      execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => {});
    } catch {
      /* best effort */
    }
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL'); // detached → negative pid addresses the group
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* best effort */
    }
  }
}

interface SpawnCaptureOptions extends RemoteRunOptions {
  /** Win32 `.cmd` shims (npm) need shell:true + arg quoting; `.exe` (git) don't. */
  readonly winShell: boolean;
}

function spawnCapture(
  binary: string,
  args: readonly string[],
  opts: SpawnCaptureOptions,
): Promise<RemoteRunResult> {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const base = {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      windowsHide: true,
    } as const;
    let child: ChildProcess;
    if (isWin && opts.winShell) {
      // shell:true concatenates argv WITHOUT quoting (DEP0190; 4F.2 audit M1).
      const cmd = [binary, ...args].map(quoteWinShellArg).join(' ');
      child = spawn(cmd, { ...base, shell: true });
    } else {
      child = spawn(binary, args as string[], { ...base, shell: false, detached: !isWin });
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const timer =
      opts.timeoutMs !== undefined
        ? setTimeout(() => {
            timedOut = true;
            killProc(child);
          }, opts.timeoutMs)
        : undefined;
    const done = (r: RemoteRunResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(r);
    };
    child.stdout?.on('data', (c) => (stdout += String(c)));
    child.stderr?.on('data', (c) => (stderr += String(c)));
    child.on('error', (err) =>
      done({ exitCode: -1, stdout, stderr: `${stderr}\n${err.message}`, timedOut }),
    );
    child.on('close', (code) => done({ exitCode: code ?? -1, stdout, stderr, timedOut }));
  });
}

const defaultRunNpm: RemoteRunner = (args, options) =>
  spawnCapture('npm', args, { ...options, winShell: true });

const defaultRunGit: RemoteRunner = (args, options) =>
  spawnCapture('git', args, { ...options, winShell: false });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tail(s: string): string {
  // Keep the END — npm/git print progress noise first and the actionable
  // failure line (404, auth, "Repository not found") last.
  return s.trim().slice(-500);
}

function isToolMissing(res: RemoteRunResult): boolean {
  return (
    res.exitCode === -1 &&
    /ENOENT|not found|not recognized|cannot find/i.test(res.stderr)
  );
}

async function hasManifest(dir: string): Promise<boolean> {
  try {
    await fsp.access(path.join(dir, PLUGIN_MANIFEST));
    return true;
  } catch {
    return false;
  }
}

async function packageHasScript(dir: string, script: string): Promise<boolean> {
  try {
    const raw = await fsp.readFile(path.join(dir, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as { scripts?: Record<string, unknown> };
    return typeof pkg.scripts?.[script] === 'string';
  } catch {
    return false;
  }
}

function makeCleanup(dir: string): () => Promise<void> {
  return async () => {
    try {
      await fsp.rm(dir, { recursive: true, force: true });
    } catch {
      // Win32: git/npm may hold handles briefly post-exit — retry once.
      await new Promise((r) => setTimeout(r, 100));
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  };
}

/** Locate the single installed plugin dir under `<prefix>/node_modules`. */
async function locatePluginDir(prefix: string, spec: string): Promise<string | undefined> {
  const nm = path.join(prefix, 'node_modules');
  // The name fast-path is sound ONLY because `prefix` is a freshly-created
  // empty temp tree — the just-installed package is the only thing under
  // node_modules/<name>. If this ever runs against a populated prefix, drop
  // the fast-path and rely on the unique-match scan below.
  const name = parseNpmPackageName(spec);
  if (name !== undefined) {
    const cand = path.join(nm, ...name.split('/'));
    if (await hasManifest(cand)) return cand;
  }
  // Fallback scan: node_modules/*/plugin.json + node_modules/@scope/*/plugin.json.
  const matches: string[] = [];
  let entries;
  try {
    entries = await fsp.readdir(nm, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name === '.bin') continue;
    if (e.name.startsWith('@')) {
      const scopeDir = path.join(nm, e.name);
      let inner;
      try {
        inner = await fsp.readdir(scopeDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const i of inner) {
        const dir = path.join(scopeDir, i.name);
        if (i.isDirectory() && (await hasManifest(dir))) matches.push(dir);
      }
    } else if (await hasManifest(path.join(nm, e.name))) {
      matches.push(path.join(nm, e.name));
    }
  }
  return matches.length === 1 ? matches[0] : undefined;
}

/** Split `git+`/`#ref` decorations off a git URL. */
export function splitGitRef(raw: string): { url: string; ref?: string } {
  const s = raw.trim().replace(/^git\+/i, '');
  const hash = s.lastIndexOf('#');
  if (hash >= 0) {
    const ref = s.slice(hash + 1);
    return ref.length > 0 ? { url: s.slice(0, hash), ref } : { url: s.slice(0, hash) };
  }
  return { url: s };
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

async function resolveNpm(
  source: string,
  opts: ResolveRemoteOptions,
  tmp: string,
  runNpm: RemoteRunner,
  cleanup: () => Promise<void>,
): Promise<ResolvedSource | RemoteRefusal> {
  // Relative tarball/path specs must be absolute — npm resolves them against
  // the spawn cwd (the temp dir), not the user's cwd.
  const npmSpec =
    /\.(tgz|tar\.gz)$/i.test(source) || isPathLike(source) ? path.resolve(source) : source;

  await fsp.writeFile(
    path.join(tmp, 'package.json'),
    `${JSON.stringify({ name: 'symphony-plugin-fetch', private: true })}\n`,
    'utf8',
  );

  const args = [
    'install',
    npmSpec,
    '--prefix',
    tmp,
    '--no-save',
    '--no-package-lock',
    '--no-audit',
    '--no-fund',
    '--omit=dev',
    '--omit=optional',
  ];
  if (opts.allowScripts !== true) args.push('--ignore-scripts');

  const res = await runNpm(args, {
    cwd: tmp,
    timeoutMs: opts.allowScripts === true ? BUILD_TIMEOUT_MS : NPM_FETCH_TIMEOUT_MS,
  });
  if (res.exitCode !== 0) {
    if (isToolMissing(res)) {
      return {
        ok: false,
        reason: 'tool-missing',
        message: 'npm not found on PATH — required to install a plugin from an npm package',
        cleanup,
      };
    }
    if (res.timedOut === true) {
      return { ok: false, reason: 'fetch-timeout', message: `npm install '${source}' timed out`, cleanup };
    }
    return {
      ok: false,
      reason: 'npm-fetch-failed',
      message: `npm install '${source}' exited ${res.exitCode}: ${tail(res.stderr)}`,
      cleanup,
    };
  }

  const dir = await locatePluginDir(tmp, npmSpec);
  if (dir === undefined) {
    return {
      ok: false,
      reason: 'manifest-missing-in-source',
      message: `installed '${source}' but found no unique ${PLUGIN_MANIFEST} — not a Symphony plugin`,
      cleanup,
    };
  }
  return { ok: true, kind: 'npm', dir, label: source, cleanup };
}

async function resolveGit(
  source: string,
  opts: ResolveRemoteOptions,
  tmp: string,
  runGit: RemoteRunner,
  runNpm: RemoteRunner,
  cleanup: () => Promise<void>,
): Promise<ResolvedSource | RemoteRefusal> {
  const { url, ref } = splitGitRef(source);
  const cloneDir = path.join(tmp, 'clone');
  // GIT_TERMINAL_PROMPT=0 → a credential prompt fails fast instead of hanging.
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  const doClone = (args: readonly string[]): Promise<RemoteRunResult> =>
    runGit(args, { cwd: tmp, env, timeoutMs: CLONE_TIMEOUT_MS });

  // Resolve the ref WITHOUT guessing branch-vs-SHA from its shape (a 7-hex
  // tag/branch would be misjudged). Try the fast shallow `--branch` path first
  // (works for any branch or tag, incl. hex-looking names); if git rejects it
  // — which is what happens for a raw commit SHA — fall back to a full clone +
  // explicit checkout, which resolves any commit reachable in history.
  let c: RemoteRunResult;
  let needCheckout = false;
  if (ref === undefined) {
    c = await doClone(['clone', '--depth', '1', url, cloneDir]);
  } else {
    c = await doClone(['clone', '--depth', '1', '--branch', ref, url, cloneDir]);
    if (c.exitCode !== 0 && !isToolMissing(c) && c.timedOut !== true) {
      // The partial/empty dir from the failed shallow clone must go — `git
      // clone` refuses a non-empty target.
      await fsp.rm(cloneDir, { recursive: true, force: true }).catch(() => {});
      c = await doClone(['clone', url, cloneDir]);
      needCheckout = c.exitCode === 0;
    }
  }

  if (c.exitCode !== 0) {
    if (isToolMissing(c)) {
      return {
        ok: false,
        reason: 'tool-missing',
        message: 'git not found on PATH — required to install a plugin from a git URL',
        cleanup,
      };
    }
    if (c.timedOut === true) {
      return { ok: false, reason: 'fetch-timeout', message: `git clone '${url}' timed out`, cleanup };
    }
    return {
      ok: false,
      reason: 'git-clone-failed',
      message: `git clone '${url}' exited ${c.exitCode}: ${tail(c.stderr)}`,
      cleanup,
    };
  }

  if (needCheckout && ref !== undefined) {
    const co = await runGit(['checkout', ref], { cwd: cloneDir, env, timeoutMs: CLONE_TIMEOUT_MS });
    if (co.exitCode !== 0) {
      return {
        ok: false,
        reason: 'git-checkout-failed',
        message: `git checkout '${ref}' exited ${co.exitCode}: ${tail(co.stderr)}`,
        cleanup,
      };
    }
  }

  // Strip the repo history — `copyIntoStore` is recursive; a multi-MB `.git`
  // has no business in the central plugin store.
  await fsp.rm(path.join(cloneDir, '.git'), { recursive: true, force: true }).catch(() => {});

  if (opts.allowScripts === true) {
    const built = await buildClone(cloneDir, runNpm, env, cleanup);
    if (built !== undefined) return built; // refusal
  }

  if (!(await hasManifest(cloneDir))) {
    return {
      ok: false,
      reason: 'manifest-missing-in-source',
      message: `no ${PLUGIN_MANIFEST} at the repository root of '${url}'`,
      cleanup,
    };
  }
  return { ok: true, kind: 'git', dir: cloneDir, label: source, cleanup };
}

/** Run install + build inside a cloned repo (allowScripts only). Returns a refusal or undefined on success. */
async function buildClone(
  cloneDir: string,
  runNpm: RemoteRunner,
  env: NodeJS.ProcessEnv,
  cleanup: () => Promise<void>,
): Promise<RemoteRefusal | undefined> {
  // Full install WITH scripts + dev deps — `prepare` typically builds dist.
  const inst = await runNpm(['install', '--no-audit', '--no-fund'], {
    cwd: cloneDir,
    env,
    timeoutMs: BUILD_TIMEOUT_MS,
  });
  if (inst.exitCode !== 0) {
    if (inst.timedOut === true) {
      return { ok: false, reason: 'fetch-timeout', message: 'npm install (build) timed out', cleanup };
    }
    return {
      ok: false,
      reason: 'build-failed',
      message: `npm install (build) exited ${inst.exitCode}: ${tail(inst.stderr)}`,
      cleanup,
    };
  }
  if (await packageHasScript(cloneDir, 'build')) {
    const b = await runNpm(['run', 'build'], { cwd: cloneDir, env, timeoutMs: BUILD_TIMEOUT_MS });
    if (b.exitCode !== 0) {
      if (b.timedOut === true) {
        return { ok: false, reason: 'fetch-timeout', message: 'npm run build timed out', cleanup };
      }
      return {
        ok: false,
        reason: 'build-failed',
        message: `npm run build exited ${b.exitCode}: ${tail(b.stderr)}`,
        cleanup,
      };
    }
  }
  return undefined;
}

/**
 * Resolve any source to a local directory containing `plugin.json`. Local
 * sources pass through; npm/git are fetched into a temp dir (caller MUST
 * call `result.cleanup()` in a `finally`).
 */
export async function resolveRemoteSource(
  opts: ResolveRemoteOptions,
): Promise<ResolvedSource | RemoteRefusal> {
  const source = opts.source.trim();
  if (source === '') {
    return { ok: false, reason: 'empty-source', message: 'empty plugin source', cleanup: noop };
  }

  const kind = classifySource(source);
  if (kind === 'local') {
    return { ok: true, kind: 'local', dir: source, label: path.resolve(source), cleanup: noop };
  }

  const tmp = await fsp.mkdtemp(path.join(opts.tmpRoot ?? os.tmpdir(), 'sym-plugin-fetch-'));
  const cleanup = makeCleanup(tmp);
  const runNpm = opts.runNpm ?? defaultRunNpm;
  const runGit = opts.runGit ?? defaultRunGit;
  try {
    return kind === 'npm'
      ? await resolveNpm(source, opts, tmp, runNpm, cleanup)
      : await resolveGit(source, opts, tmp, runGit, runNpm, cleanup);
  } catch (err) {
    return {
      ok: false,
      reason: 'unsupported-source',
      message: err instanceof Error ? err.message : String(err),
      cleanup,
    };
  }
}
