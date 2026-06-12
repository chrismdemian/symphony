import { promises as fsp } from 'node:fs';

/**
 * Atomic-write rename with bounded retry on transient Windows failures.
 *
 * On Windows, `fsp.rename(tmp, target)` over an existing destination
 * intermittently throws `EPERM` / `EACCES` / `EBUSY` when antivirus or
 * another handle briefly holds the target — the classic graceful-fs
 * problem (`MoveFileEx` fails while the file is momentarily locked). POSIX
 * rename is atomic and never hits this contention class, so we retry ONLY
 * on Windows for those codes (a real `EACCES` on POSIX is a genuine
 * permission error and must surface immediately, not after a stall).
 *
 * The write itself already landed in `tmp` before this is called, so
 * retrying the rename is safe + idempotent. Every Symphony atomic writer
 * (config save, Maestro CLAUDE.md / mcp-config, worker CLAUDE.md, Stop-hook
 * settings) routes its final rename through here so the whole
 * write-then-rename family inherits the same Windows resilience.
 *
 * Surfaced as `tests/utils/config-context.test.tsx` EPERM flakes; root cause
 * documented in `.claude/rules/known-gotchas.md`. Throws the last error if
 * every attempt fails — callers keep their own tmp-cleanup + throw semantics.
 */

/** Windows rename-contention codes worth retrying. Mirrors graceful-fs. */
const TRANSIENT_RENAME_CODES: ReadonlySet<string> = new Set(['EPERM', 'EACCES', 'EBUSY']);

/**
 * Backoff schedule (ms). Six attempts total (initial + 5 retries) over
 * ~0.4s — long enough to outlast an antivirus scan window, short enough
 * that a genuinely stuck rename still fails fast.
 */
const RENAME_RETRY_DELAYS_MS: readonly number[] = [10, 25, 50, 100, 200];

export interface RenameWithRetryOptions {
  /** Test seam — inject a fake rename. Defaults to `fsp.rename`. */
  readonly _rename?: (oldPath: string, newPath: string) => Promise<void>;
  /** Test seam — inject a fake sleep. Defaults to a real `setTimeout`. */
  readonly _sleep?: (ms: number) => Promise<void>;
  /** Test seam — override the platform check. Defaults to `process.platform`. */
  readonly _platform?: NodeJS.Platform;
}

export async function renameWithRetry(
  tmp: string,
  target: string,
  opts?: RenameWithRetryOptions,
): Promise<void> {
  const rename = opts?._rename ?? fsp.rename;
  const sleep =
    opts?._sleep ?? ((ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)));
  const platform = opts?._platform ?? process.platform;

  let attempt = 0;
  for (;;) {
    try {
      await rename(tmp, target);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const retryable =
        platform === 'win32' &&
        code !== undefined &&
        TRANSIENT_RENAME_CODES.has(code) &&
        attempt < RENAME_RETRY_DELAYS_MS.length;
      if (!retryable) throw err;
      await sleep(RENAME_RETRY_DELAYS_MS[attempt] as number);
      attempt += 1;
    }
  }
}
