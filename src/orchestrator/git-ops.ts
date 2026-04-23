import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Git operations for Maestro-only tools (2A.4a: review_diff; 2A.4b:
 * finalize, commit/push/merge). Uses `execFile` directly — matches the
 * raw-git pattern established in `src/worktree/manager.ts`. `simple-git`
 * is deferred to areas where its parsing helpers are a meaningful upgrade.
 */

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
