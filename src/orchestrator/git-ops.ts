import { execFile, spawn as nodeSpawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Git operations for Maestro-only tools (2A.4a: review_diff; 2A.4b:
 * finalize, commit/push/merge). Uses `execFile` directly — matches the
 * raw-git pattern established in `src/worktree/manager.ts`. `simple-git`
 * is deferred to areas where its parsing helpers are a meaningful upgrade.
 */

/** Base class for git-ops errors. Carries stderr tail for user-visible messages. */
export class GitOpsError extends Error {
  readonly stderr: string;
  readonly exitCode: number | null;
  constructor(message: string, opts: { stderr?: string; exitCode?: number | null } = {}) {
    super(message);
    this.name = 'GitOpsError';
    this.stderr = opts.stderr ?? '';
    this.exitCode = opts.exitCode ?? null;
  }
}

/** Thrown by `commitAll` when the staged index has no changes and `allowEmpty !== true`. */
export class NothingToCommitError extends GitOpsError {
  constructor(message = 'Nothing to commit — working tree clean after git add -A.') {
    super(message);
    this.name = 'NothingToCommitError';
  }
}

/** Thrown by `push` when the remote rejects the push (non-fast-forward, hook failure, auth). */
export class PushRejectedError extends GitOpsError {
  constructor(message: string, stderr: string, exitCode: number | null) {
    super(message, { stderr, exitCode });
    this.name = 'PushRejectedError';
  }
}

/** Thrown by `mergeBranch` when `git merge` reports a conflict. */
export class MergeConflictError extends GitOpsError {
  constructor(message: string, stderr: string, exitCode: number | null) {
    super(message, { stderr, exitCode });
    this.name = 'MergeConflictError';
  }
}

/** Default per-tool diff text size cap. `review_diff` truncates above this. */
export const DEFAULT_DIFF_SIZE_CAP_BYTES = 50_000;

export interface FileChange {
  readonly path: string;
  /**
   * Single-letter git status code:
   * - `A`/`M`/`D`/`R`/`C`/`T`/`U` from `--name-status` (rename similarity
   *   digits like `R100` are collapsed to `R`)
   * - `??` for untracked files
   */
  readonly status: string;
}

export interface DiffResult {
  readonly diff: string;
  readonly bytes: number;
  readonly truncated: boolean;
  readonly files: readonly FileChange[];
  readonly baseRef: string;
}

export interface DiffWorktreeOptions {
  readonly worktreePath: string;
  /** Defaults to `HEAD` — diff against the worktree's current commit. */
  readonly baseRef?: string;
  readonly capBytes?: number;
  /** AbortSignal threaded into each git invocation. */
  readonly signal?: AbortSignal;
}

/**
 * Capture the combined diff of a worktree against `baseRef` (default HEAD).
 *
 * Combines:
 * - staged changes (`git diff --cached`)
 * - unstaged changes (`git diff`)
 * - untracked files (enumerated; not inlined — too risky for arbitrary binaries)
 *
 * Truncates above `capBytes` with an explicit marker line. Files list is
 * always complete (truncation is on the diff body, not the file list).
 */
export async function diffWorktree(opts: DiffWorktreeOptions): Promise<DiffResult> {
  const { worktreePath } = opts;
  const cap = opts.capBytes ?? DEFAULT_DIFF_SIZE_CAP_BYTES;
  const baseRef = opts.baseRef ?? 'HEAD';

  const exec = async (args: readonly string[]): Promise<string> => {
    const { stdout } = await execFileAsync('git', [...args], {
      cwd: worktreePath,
      maxBuffer: 64 * 1024 * 1024,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
    return stdout;
  };

  // Unified diff of staged + unstaged against baseRef.
  // `git diff HEAD` shows both staged and unstaged relative to HEAD.
  const trackedDiff = await exec(['diff', '--patch', baseRef]);
  const untrackedList = await exec([
    'ls-files',
    '--others',
    '--exclude-standard',
  ]);
  const untrackedPaths = untrackedList
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  // Tracked changes by name-status. git uses TAB as the field separator —
  // splitting on `\s+` corrupts any path containing a space. Rename/Copy
  // rows are `Rxxx\told\tnew` — we always take the LAST column as the
  // path (post-rename) and collapse `Rxxx`/`Cxxx` similarity digits to
  // single-letter status (per 2A.4a audit M1 + m1).
  const nameStatus = await exec(['diff', '--name-status', baseRef]);
  const trackedFiles: FileChange[] = nameStatus
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .map((line) => {
      const parts = line.split('\t');
      const rawStatus = parts[0] ?? '?';
      const status = rawStatus.length > 0 ? rawStatus.charAt(0) : '?';
      const tail = parts[parts.length - 1] ?? '';
      return { path: tail, status };
    });

  const untrackedFiles: FileChange[] = untrackedPaths.map((path) => ({
    path,
    status: '??',
  }));

  const files = [...trackedFiles, ...untrackedFiles];

  // Untracked files get a synthetic header line; their content is not inlined.
  const untrackedHeader =
    untrackedFiles.length > 0
      ? `\n\n=== untracked files (${untrackedFiles.length}) ===\n` +
        untrackedFiles.map((f) => `?? ${f.path}`).join('\n') +
        '\n'
      : '';

  const combined = trackedDiff + untrackedHeader;
  const totalBytes = Buffer.byteLength(combined, 'utf8');

  if (totalBytes <= cap) {
    return {
      diff: combined,
      bytes: totalBytes,
      truncated: false,
      files,
      baseRef,
    };
  }

  // Truncate at cap with a marker. Keep the first `cap` bytes so hunks at
  // the top are intact — reviewer reads top-down.
  const buf = Buffer.from(combined, 'utf8');
  const head = buf.subarray(0, cap).toString('utf8');
  const trailer = `\n... diff truncated at ${cap} bytes (total ${totalBytes} bytes) ...`;
  return {
    diff: head + trailer,
    bytes: totalBytes,
    truncated: true,
    files,
    baseRef,
  };
}

/** Current branch of a worktree, or null when detached-HEAD. */
export async function currentBranch(
  worktreePath: string,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['symbolic-ref', '--short', 'HEAD'],
      {
        cwd: worktreePath,
        ...(signal !== undefined ? { signal } : {}),
      },
    );
    const branch = stdout.trim();
    return branch.length > 0 ? branch : null;
  } catch {
    return null;
  }
}

export interface CommitAllOptions {
  readonly worktreePath: string;
  /** Commit message (multi-line accepted; piped via stdin as `-F -`). */
  readonly message: string;
  readonly signal?: AbortSignal;
  /** Allow an empty commit (default false). */
  readonly allowEmpty?: boolean;
}

export interface CommitResult {
  readonly sha: string;
  readonly shortSha: string;
  readonly subject: string;
  readonly stagedFiles: readonly string[];
}

/**
 * `git add -A` followed by `git commit -F -` (message on stdin — never
 * shell-quoted). Throws `NothingToCommitError` when staged tree is empty
 * and `allowEmpty` is not set. Returns the new HEAD SHA.
 */
export async function commitAll(opts: CommitAllOptions): Promise<CommitResult> {
  const { worktreePath, message } = opts;
  if (message.trim().length === 0) {
    throw new GitOpsError('commitAll: message must not be empty');
  }
  const subject = message.split(/\r?\n/)[0] ?? message;
  const baseExec: Pick<Parameters<typeof execFileAsync>[2] & object, 'cwd' | 'maxBuffer'> & {
    signal?: AbortSignal;
  } = {
    cwd: worktreePath,
    maxBuffer: 64 * 1024 * 1024,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  };

  await execFileAsync('git', ['add', '-A'], baseExec);

  const { stdout: stagedStdout } = await execFileAsync(
    'git',
    ['diff', '--cached', '--name-only'],
    baseExec,
  );
  const stagedFiles = stagedStdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (stagedFiles.length === 0 && opts.allowEmpty !== true) {
    throw new NothingToCommitError();
  }

  const commitArgs = ['commit', '-F', '-'];
  if (opts.allowEmpty === true) commitArgs.splice(1, 0, '--allow-empty');
  await runGitWithStdin(commitArgs, message, {
    cwd: worktreePath,
    signal: opts.signal,
  });

  const { stdout: shaStdout } = await execFileAsync(
    'git',
    ['rev-parse', 'HEAD'],
    baseExec,
  );
  const sha = shaStdout.trim();
  return {
    sha,
    shortSha: sha.slice(0, 7),
    subject,
    stagedFiles,
  };
}

export interface PushOptions {
  readonly worktreePath: string;
  /** Default `'origin'`. */
  readonly remote?: string;
  /** Default: current branch (symbolic-ref). */
  readonly branch?: string;
  /** Default true — always safe to pass `-u`. */
  readonly setUpstream?: boolean;
  readonly signal?: AbortSignal;
}

export interface PushResult {
  readonly remote: string;
  readonly branch: string;
  readonly setUpstream: boolean;
}

const NON_FAST_FORWARD_MARKERS = [
  'rejected',
  'non-fast-forward',
  'failed to push',
  'fetch first',
];

/**
 * `git push -u <remote> <branch>`. Throws `PushRejectedError` with stderr
 * on non-fast-forward / auth / hook rejections. Caller formats for USER.
 */
export async function push(opts: PushOptions): Promise<PushResult> {
  const { worktreePath } = opts;
  const remote = opts.remote ?? 'origin';
  let branch = opts.branch;
  if (branch === undefined || branch.length === 0) {
    const resolved = await currentBranch(worktreePath, opts.signal);
    if (resolved === null) {
      throw new GitOpsError(
        'push: worktree is in detached-HEAD state; pass an explicit branch.',
      );
    }
    branch = resolved;
  }
  const setUpstream = opts.setUpstream ?? true;

  const args = ['push'];
  if (setUpstream) args.push('--set-upstream');
  args.push(remote, branch);

  try {
    await execFileAsync('git', args, {
      cwd: worktreePath,
      maxBuffer: 64 * 1024 * 1024,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
  } catch (err) {
    const info = extractExecError(err);
    const stderrLower = info.stderr.toLowerCase();
    if (NON_FAST_FORWARD_MARKERS.some((m) => stderrLower.includes(m))) {
      throw new PushRejectedError(
        `git push rejected: ${info.stderr.split(/\r?\n/)[0] ?? 'unknown reason'}`,
        info.stderr,
        info.exitCode,
      );
    }
    throw new GitOpsError(`git push failed: ${info.message}`, {
      stderr: info.stderr,
      exitCode: info.exitCode,
    });
  }
  return { remote, branch, setUpstream };
}

export interface MergeBranchOptions {
  /** Main repo path (NOT a worktree — `git checkout <target>` is forbidden in worktrees). */
  readonly repoPath: string;
  /** e.g. `'master'`. */
  readonly targetBranch: string;
  /** The worker's feature branch (usually just pushed). */
  readonly sourceBranch: string;
  /** Default `'origin'`. */
  readonly sourceRemote?: string;
  /** Optional explicit merge-commit message. Defaults to git's auto-message. */
  readonly commitMessage?: string;
  /** After merge, `git push <remote> --delete <sourceBranch>`. Default true. */
  readonly deleteRemoteBranch?: boolean;
  readonly signal?: AbortSignal;
}

export interface MergeResult {
  readonly mergeSha: string;
  readonly targetBranch: string;
  readonly sourceBranch: string;
  readonly deletedRemoteBranch: boolean;
}

/**
 * Merge `sourceBranch` (from `sourceRemote`) into `targetBranch` in the
 * main repo, `--no-ff`, push, optionally delete remote branch. Runs in
 * `repoPath`. Callers must pass the main repo path — cannot run from a
 * linked worktree because `git checkout <target>` will conflict.
 */
export async function mergeBranch(opts: MergeBranchOptions): Promise<MergeResult> {
  const { repoPath, targetBranch, sourceBranch } = opts;
  const remote = opts.sourceRemote ?? 'origin';
  const deleteRemote = opts.deleteRemoteBranch ?? true;
  const baseExec: Pick<Parameters<typeof execFileAsync>[2] & object, 'cwd' | 'maxBuffer'> & {
    signal?: AbortSignal;
  } = {
    cwd: repoPath,
    maxBuffer: 64 * 1024 * 1024,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  };

  try {
    await execFileAsync('git', ['fetch', remote, sourceBranch], baseExec);
  } catch (err) {
    const info = extractExecError(err);
    throw new GitOpsError(`git fetch ${remote} ${sourceBranch} failed: ${info.message}`, {
      stderr: info.stderr,
      exitCode: info.exitCode,
    });
  }

  try {
    await execFileAsync('git', ['checkout', targetBranch], baseExec);
  } catch (err) {
    const info = extractExecError(err);
    throw new GitOpsError(
      `git checkout ${targetBranch} failed: ${info.message}`,
      { stderr: info.stderr, exitCode: info.exitCode },
    );
  }

  try {
    await execFileAsync(
      'git',
      ['pull', '--ff-only', remote, targetBranch],
      baseExec,
    );
  } catch (err) {
    const info = extractExecError(err);
    throw new GitOpsError(
      `git pull --ff-only ${remote} ${targetBranch} failed: ${info.message}`,
      { stderr: info.stderr, exitCode: info.exitCode },
    );
  }

  const mergeArgs = ['merge', '--no-ff', `${remote}/${sourceBranch}`];
  if (opts.commitMessage !== undefined && opts.commitMessage.length > 0) {
    mergeArgs.push('-m', opts.commitMessage);
  }
  try {
    await execFileAsync('git', mergeArgs, baseExec);
  } catch (err) {
    const info = extractExecError(err);
    const stderrLower = info.stderr.toLowerCase();
    if (stderrLower.includes('conflict')) {
      throw new MergeConflictError(
        `git merge ${remote}/${sourceBranch} into ${targetBranch} conflicted`,
        info.stderr,
        info.exitCode,
      );
    }
    throw new GitOpsError(
      `git merge ${remote}/${sourceBranch} failed: ${info.message}`,
      { stderr: info.stderr, exitCode: info.exitCode },
    );
  }

  const { stdout: shaStdout } = await execFileAsync(
    'git',
    ['rev-parse', 'HEAD'],
    baseExec,
  );
  const mergeSha = shaStdout.trim();

  try {
    await execFileAsync('git', ['push', remote, targetBranch], baseExec);
  } catch (err) {
    const info = extractExecError(err);
    throw new GitOpsError(
      `git push ${remote} ${targetBranch} failed after merge: ${info.message}`,
      { stderr: info.stderr, exitCode: info.exitCode },
    );
  }

  let deletedRemoteBranch = false;
  if (deleteRemote) {
    try {
      await execFileAsync('git', ['push', remote, '--delete', sourceBranch], baseExec);
      deletedRemoteBranch = true;
    } catch {
      // Non-fatal — branch may have been deleted already, or remote may refuse.
      deletedRemoteBranch = false;
    }
  }

  return {
    mergeSha,
    targetBranch,
    sourceBranch,
    deletedRemoteBranch,
  };
}

/** Internal: run git with arbitrary args and stdin. Rejects on non-zero exit. */
async function runGitWithStdin(
  args: readonly string[],
  stdin: string,
  opts: { cwd: string; signal?: AbortSignal },
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = nodeSpawn('git', [...args], {
      cwd: opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > 64 * 1024) stderr = stderr.slice(-64 * 1024);
    });
    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else {
        reject(
          new GitOpsError(
            `git ${args.join(' ')} exited with code ${code ?? 'null'}: ${stderr.trim()}`,
            { stderr, exitCode: code ?? null },
          ),
        );
      }
    });
    child.stdin.on('error', (err) => reject(err));
    child.stdin.end(stdin, 'utf8');
  });
}

/** Extract stderr + exit code from execFile rejection. */
function extractExecError(err: unknown): {
  message: string;
  stderr: string;
  exitCode: number | null;
} {
  if (err !== null && typeof err === 'object') {
    const e = err as { message?: string; stderr?: string | Buffer; code?: number | string };
    const message = typeof e.message === 'string' ? e.message : String(err);
    const stderr =
      typeof e.stderr === 'string'
        ? e.stderr
        : e.stderr instanceof Buffer
          ? e.stderr.toString('utf8')
          : '';
    const exitCode = typeof e.code === 'number' ? e.code : null;
    return { message, stderr, exitCode };
  }
  return { message: String(err), stderr: '', exitCode: null };
}
