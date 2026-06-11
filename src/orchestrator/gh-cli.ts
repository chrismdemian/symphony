import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import { resolveCommandPath } from '../workers/resolve.js';

/**
 * Phase 3O.2 — thin wrapper over the GitHub CLI (`gh`) for opening PRs.
 *
 * Only `gh` is used (Chris-chosen over the REST+PAT path): it already
 * handles auth, base/head resolution, and body input. Symphony spawns it
 * with `shell: false` + an argv array so the LLM-generated title can never
 * be shell-interpreted; the (potentially large, markdown) body is piped via
 * `--body-file -` on stdin. The `gh` binary is resolved through the
 * PATHEXT-aware `resolveCommandPath` so Win32 `gh.cmd`/`gh.exe` shims work
 * without `shell: true` (the 1B `.cmd` gotcha).
 *
 * Unlike worker spawns, `gh` INHERITS `process.env` — it needs the user's
 * HOME / gh config / keyring access to authenticate. Prompt + pager are
 * disabled so it never blocks on a TTY.
 *
 * All calls run under a default 30s timeout (the caller's signal wins if it
 * fires first). `createGhRunner(spawn)` is the single test seam — pass a
 * fake spawn fn so tests never launch a real `gh` (and never open a real PR).
 */

const DEFAULT_GH_TIMEOUT_MS = 30_000;
const PR_URL_RE = /https?:\/\/\S+\/pull\/\d+/;

/** Thrown by `createGhRunner().createPr` when `gh pr create` fails for a non-"already exists" reason. */
export class GhCliError extends Error {
  readonly stderr: string;
  readonly exitCode: number | null;
  constructor(message: string, opts: { stderr?: string; exitCode?: number | null } = {}) {
    super(message);
    this.name = 'GhCliError';
    this.stderr = opts.stderr ?? '';
    this.exitCode = opts.exitCode ?? null;
  }
}

export interface GhAvailability {
  readonly available: boolean;
  /** Set when `available === false`. */
  readonly reason?: 'gh-not-found' | 'gh-not-authenticated';
  /** Human-readable detail for the tool result. */
  readonly detail?: string;
}

export interface GhCreatePrInput {
  readonly cwd: string;
  readonly base: string;
  readonly head: string;
  readonly title: string;
  readonly body: string;
  readonly draft: boolean;
  readonly signal?: AbortSignal;
}

export interface GhCreatePrResult {
  readonly url: string;
  /** True when a PR for this branch already existed (`gh` refused; we returned the existing URL). */
  readonly alreadyExisted: boolean;
}

/**
 * Injectable seam — the open_pr tool depends on this interface so tests use
 * `createGhRunner(fakeSpawn)`.
 */
export interface GhRunner {
  checkAvailable(cwd: string, signal?: AbortSignal): Promise<GhAvailability>;
  hasGitHubRemote(cwd: string, remote?: string, signal?: AbortSignal): Promise<boolean>;
  createPr(input: GhCreatePrInput): Promise<GhCreatePrResult>;
}

type SpawnFn = typeof nodeSpawn;

interface RunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signaled: boolean;
  /** True when the binary couldn't be spawned at all (ENOENT etc.). */
  readonly spawnError: boolean;
}

function buildGhEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GH_PROMPT_DISABLED: '1',
    GH_NO_UPDATE_NOTIFIER: '1',
    GH_PAGER: '',
    PAGER: 'cat',
  };
}

interface RunOpts {
  readonly cwd: string;
  readonly stdin?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

/**
 * Run `<binary> <args>` collecting stdout/stderr. Never rejects — failures
 * (non-zero exit, spawn error, timeout) come back in the result so callers
 * branch on them. `stdin`, when provided, is written then the stream closed.
 */
function runCommand(
  spawn: SpawnFn,
  binary: string,
  args: readonly string[],
  opts: RunOpts,
): Promise<RunResult> {
  return new Promise<RunResult>((resolve) => {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_GH_TIMEOUT_MS;
    let settled = false;
    let stdout = '';
    let stderr = '';
    let signaled = false;

    const spawnOptions: SpawnOptions = {
      cwd: opts.cwd,
      env: buildGhEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    };

    let child;
    try {
      child = spawn(binary, [...args], spawnOptions);
    } catch (err) {
      resolve({
        stdout: '',
        stderr: err instanceof Error ? err.message : String(err),
        exitCode: null,
        signaled: false,
        spawnError: true,
      });
      return;
    }

    let abortHandler: (() => void) | undefined;
    const finish = (r: RunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (abortHandler !== undefined && opts.signal !== undefined) {
        opts.signal.removeEventListener('abort', abortHandler);
      }
      resolve(r);
    };

    const killChild = (): void => {
      signaled = true;
      try {
        child.kill('SIGTERM');
      } catch {
        /* best effort */
      }
      // Backstop: settle even if the child never emits 'close' after SIGTERM
      // (a binary that ignores the signal). Unref'd so it can't keep the
      // process alive; idempotent via the `settled` flag in `finish`.
      const backstop = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* best effort */
        }
        finish({ stdout, stderr, exitCode: null, signaled: true, spawnError: false });
      }, 2_000);
      backstop.unref?.();
    };

    const timer = setTimeout(killChild, timeoutMs);

    if (opts.signal !== undefined) {
      if (opts.signal.aborted) killChild();
      else {
        abortHandler = killChild;
        opts.signal.addEventListener('abort', abortHandler, { once: true });
      }
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err: Error) => {
      finish({
        stdout,
        stderr: stderr.length > 0 ? stderr : err.message,
        exitCode: null,
        signaled,
        spawnError: true,
      });
    });
    child.on('close', (code) => {
      finish({ stdout, stderr, exitCode: code, signaled, spawnError: false });
    });

    if (child.stdin !== null) {
      child.stdin.on('error', () => {
        /* EPIPE if the child exits before reading stdin — non-fatal */
      });
      child.stdin.end(opts.stdin ?? '', 'utf8');
    }
  });
}

function extractPrUrl(text: string): string | null {
  const m = text.match(PR_URL_RE);
  return m !== null ? m[0] : null;
}

/**
 * Build a `GhRunner`. `spawn` defaults to `child_process.spawn`; tests pass
 * a fake to record argv + stdin and return canned output without launching
 * a real process.
 */
export function createGhRunner(spawn: SpawnFn = nodeSpawn): GhRunner {
  const run = (
    binary: string,
    args: readonly string[],
    cwd: string,
    stdin?: string,
    signal?: AbortSignal,
  ): Promise<RunResult> =>
    runCommand(spawn, binary, args, {
      cwd,
      ...(stdin !== undefined ? { stdin } : {}),
      ...(signal !== undefined ? { signal } : {}),
    });

  return {
    async checkAvailable(cwd, signal): Promise<GhAvailability> {
      const ghPath = resolveCommandPath('gh') ?? 'gh';
      const version = await run(ghPath, ['--version'], cwd, undefined, signal);
      if (version.spawnError || version.exitCode !== 0) {
        return {
          available: false,
          reason: 'gh-not-found',
          detail:
            'The GitHub CLI (`gh`) is not installed or not on PATH. Install it from https://cli.github.com and run `gh auth login`.',
        };
      }
      const auth = await run(ghPath, ['auth', 'status'], cwd, undefined, signal);
      if (auth.exitCode !== 0) {
        return {
          available: false,
          reason: 'gh-not-authenticated',
          detail: '`gh` is installed but not authenticated. Run `gh auth login` first.',
        };
      }
      return { available: true };
    },

    async hasGitHubRemote(cwd, remote = 'origin', signal): Promise<boolean> {
      const gitPath = resolveCommandPath('git') ?? 'git';
      const res = await run(gitPath, ['remote', 'get-url', remote], cwd, undefined, signal);
      if (res.spawnError || res.exitCode !== 0) return false;
      return /(^|@|\/\/)([^/]*\.)?github\.com[/:]/i.test(res.stdout.trim());
    },

    async createPr(input): Promise<GhCreatePrResult> {
      const ghPath = resolveCommandPath('gh') ?? 'gh';
      const args = [
        'pr',
        'create',
        '--base',
        input.base,
        '--head',
        input.head,
        '--title',
        input.title,
        '--body-file',
        '-',
      ];
      if (input.draft) args.push('--draft');

      const res = await run(ghPath, args, input.cwd, input.body, input.signal);

      // A timed-out / aborted call must NOT be interpreted as success or as
      // "already exists" — its partial stderr could coincidentally contain
      // either signal. Surface the cancellation instead of fabricating a
      // result (audit MAJOR-1).
      if (res.signaled) {
        throw new GhCliError('gh pr create was cancelled (timeout or abort) before completing.', {
          stderr: res.stderr,
          exitCode: res.exitCode,
        });
      }

      if (res.exitCode === 0) {
        const url = extractPrUrl(res.stdout) ?? extractPrUrl(res.stderr);
        if (url === null) {
          throw new GhCliError('gh pr create succeeded but no PR URL was found in its output.', {
            stderr: res.stderr,
            exitCode: res.exitCode,
          });
        }
        return { url, alreadyExisted: false };
      }

      // A PR for this branch may already exist — gh refuses and prints the
      // existing URL in stderr. Surface it instead of erroring.
      if (/already exists/i.test(res.stderr)) {
        const inlineUrl = extractPrUrl(res.stderr);
        if (inlineUrl !== null) return { url: inlineUrl, alreadyExisted: true };
        const view = await run(
          ghPath,
          ['pr', 'view', input.head, '--json', 'url', '--jq', '.url'],
          input.cwd,
          undefined,
          input.signal,
        );
        const viewUrl = extractPrUrl(view.stdout);
        if (view.exitCode === 0 && viewUrl !== null) {
          return { url: viewUrl, alreadyExisted: true };
        }
      }

      const tail = res.stderr
        .split(/\r?\n/)
        .filter((l) => l.trim().length > 0)
        .slice(-4)
        .join(' | ');
      throw new GhCliError(
        `gh pr create failed (exit ${res.exitCode ?? 'null'}${
          res.signaled ? ', signaled' : ''
        }): ${tail.length > 0 ? tail : 'no stderr'}`,
        { stderr: res.stderr, exitCode: res.exitCode },
      );
    },
  };
}

/** The production runner — spawns the real `gh`. */
export const defaultGhRunner: GhRunner = createGhRunner();
