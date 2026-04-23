import { execFile, spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import {
  commitAll,
  mergeBranch,
  NothingToCommitError,
  push,
  type CommitResult,
  type MergeResult,
  type PushResult,
} from './git-ops.js';

/**
 * Pure step-runner for `finalize`. Zero MCP awareness — takes injected
 * primitives, returns a structured log. Ordering invariant:
 *
 *   audit → lint → test → build → verify → commit → push → merge?
 *
 * Any step failing aborts the chain. Signal abort between steps produces
 * an `aborted` outcome and returns `ok: false`. No auto-rollback of git
 * state: if a commit lands and push fails, we return with `commitSha`
 * populated so USER can inspect `git log` themselves
 * (maestro-prompt-design.md §7: "Never push broken code.").
 */

const DEFAULT_VERIFY_TIMEOUT_MS = 60_000;
const COMMAND_STDERR_CAP = 2 * 1024;

export type FinalizeStep =
  | 'audit'
  | 'lint'
  | 'test'
  | 'build'
  | 'verify'
  | 'commit'
  | 'push'
  | 'merge';

export type FinalizeStepStatus = 'ok' | 'failed' | 'skipped' | 'aborted';

export interface FinalizeStepOutcome {
  readonly step: FinalizeStep;
  readonly status: FinalizeStepStatus;
  readonly durationMs: number;
  readonly detail?: string;
  readonly exitCode?: number | null;
}

export interface FinalizeConfig {
  readonly lintCommand?: string;
  readonly testCommand?: string;
  readonly buildCommand?: string;
  readonly verifyCommand?: string;
  readonly verifyTimeoutMs?: number;
}

export interface AuditOutcome {
  readonly pass: boolean;
  readonly detail: string;
}

export interface FinalizeRunOptions {
  readonly worktreePath: string;
  /** Main repo path — required for `mergeBranch` (can't checkout target in worktree). */
  readonly repoPath: string;
  readonly featureBranch: string;
  readonly commitMessage: string;
  /** Absence = skip merge step. */
  readonly mergeTo?: string;
  readonly sourceRemote?: string;
  readonly config: FinalizeConfig;
  readonly auditRunner: () => Promise<AuditOutcome>;
  /**
   * Optional pre-commit gate. Called AFTER all shell steps pass and
   * BEFORE `commitAll`. Used by `finalize` to re-check a worktree
   * fingerprint taken at audit time — catches post-audit mutation.
   * If the gate returns `ok: false`, the chain stops with
   * `failedAt: 'commit'` and the gate's message as the step detail.
   */
  readonly preCommitCheck?: () => Promise<
    { ok: true } | { ok: false; message: string }
  >;
  readonly signal?: AbortSignal;
  /** Test seam. */
  readonly commandRunner?: ShellCommandRunner;
  /** Test seam: override commit/push/merge. */
  readonly gitOps?: Partial<FinalizeGitOps>;
}

export interface FinalizeGitOps {
  commitAll: typeof commitAll;
  push: typeof push;
  mergeBranch: typeof mergeBranch;
}

export interface FinalizeRunResult {
  readonly ok: boolean;
  readonly steps: readonly FinalizeStepOutcome[];
  readonly commitSha?: string;
  readonly mergeSha?: string;
  readonly failedAt?: FinalizeStep;
  readonly featureBranch: string;
}

export interface ShellCommandInput {
  readonly command: string;
  readonly cwd: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface ShellCommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly signaled: boolean;
  readonly durationMs: number;
  readonly timedOut: boolean;
}

export type ShellCommandRunner = (input: ShellCommandInput) => Promise<ShellCommandResult>;

/**
 * Default shell runner. Uses `shell: true` so the command string is parsed
 * by the platform shell (cmd.exe on Win32, /bin/sh elsewhere). Captures the
 * last `COMMAND_STDERR_CAP` bytes of each stream and kills the subprocess
 * tree on timeout or signal.
 */
export const defaultShellRunner: ShellCommandRunner = async (input) => {
  const timeoutMs = input.timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS;
  const start = Date.now();
  const spawnOptions: SpawnOptions = {
    cwd: input.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
    // `detached: true` on POSIX sets the child as its own process-group
    // leader, so `process.kill(-pid, 'SIGTERM')` signals the whole tree
    // (shell + all its descendants) — critical for killing things like
    // `pnpm test` which spawn grandchildren. Win32 ignores `detached`
    // for tree kill; we use `taskkill /T /F` there.
    detached: process.platform !== 'win32',
    windowsHide: true,
  };
  const child: ChildProcess = nodeSpawn(input.command, [], spawnOptions);

  let stdout = '';
  let stderr = '';
  let signaled = false;
  let timedOut = false;

  const capTail = (s: string): string =>
    s.length > COMMAND_STDERR_CAP ? s.slice(-COMMAND_STDERR_CAP) : s;

  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
    stdout = capTail(stdout);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
    stderr = capTail(stderr);
  });

  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    signaled = true;
    killTree(child);
  }, timeoutMs);

  let abortHandler: (() => void) | undefined;
  if (input.signal !== undefined) {
    if (input.signal.aborted) {
      signaled = true;
      killTree(child);
    } else {
      abortHandler = () => {
        signaled = true;
        killTree(child);
      };
      input.signal.addEventListener('abort', abortHandler, { once: true });
    }
  }

  const exitInfo = await new Promise<{ code: number | null; sig: NodeJS.Signals | null }>(
    (resolve) => {
      child.on('error', () => {
        resolve({ code: null, sig: null });
      });
      child.on('close', (code, sig) => resolve({ code, sig }));
    },
  );

  clearTimeout(timeoutHandle);
  if (abortHandler !== undefined && input.signal !== undefined) {
    input.signal.removeEventListener('abort', abortHandler);
  }

  return {
    exitCode: exitInfo.code,
    stdout: capTail(stdout),
    stderr: capTail(stderr),
    signaled,
    timedOut,
    durationMs: Date.now() - start,
  };
};

function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    // `child.kill('SIGTERM')` on Win32 calls `TerminateProcess(hProc, 1)`
    // on the direct `cmd.exe` pid ONLY — descendants survive. Use
    // `taskkill /T /F` to walk the job-object tree. Fire-and-forget;
    // the child's own `close` resolves once cmd.exe actually dies.
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => {
      // Best effort — swallow stderr (common when the pid has already exited).
    });
    return;
  }
  // POSIX: signal the process group we created via `detached: true`.
  // Negative pid addresses the group; catches all descendants even if
  // the parent shell ignores SIGTERM.
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    // Group may not exist (child already exited); fall back to direct pid.
    try {
      child.kill('SIGTERM');
    } catch {
      // best effort
    }
  }
}

/** Run the finalize chain. */
export async function runFinalize(
  opts: FinalizeRunOptions,
): Promise<FinalizeRunResult> {
  const shell = opts.commandRunner ?? defaultShellRunner;
  const gitOps: FinalizeGitOps = {
    commitAll: opts.gitOps?.commitAll ?? commitAll,
    push: opts.gitOps?.push ?? push,
    mergeBranch: opts.gitOps?.mergeBranch ?? mergeBranch,
  };

  const steps: FinalizeStepOutcome[] = [];
  let commitSha: string | undefined;
  let mergeSha: string | undefined;

  const checkAborted = (step: FinalizeStep): boolean => {
    if (opts.signal?.aborted === true) {
      steps.push({
        step,
        status: 'aborted',
        durationMs: 0,
        detail: 'signal aborted before step',
      });
      return true;
    }
    return false;
  };

  // ---- 1. audit ----
  if (checkAborted('audit')) {
    return { ok: false, steps, featureBranch: opts.featureBranch, failedAt: 'audit' };
  }
  {
    const start = Date.now();
    try {
      const audit = await opts.auditRunner();
      steps.push({
        step: 'audit',
        status: audit.pass ? 'ok' : 'failed',
        durationMs: Date.now() - start,
        detail: audit.detail,
      });
      if (!audit.pass) {
        return { ok: false, steps, featureBranch: opts.featureBranch, failedAt: 'audit' };
      }
    } catch (err) {
      steps.push({
        step: 'audit',
        status: 'failed',
        durationMs: Date.now() - start,
        detail: `audit runner threw: ${errMessage(err)}`,
      });
      return { ok: false, steps, featureBranch: opts.featureBranch, failedAt: 'audit' };
    }
  }

  // ---- 2-5. shell steps (lint/test/build/verify) ----
  const shellSteps: readonly {
    step: Extract<FinalizeStep, 'lint' | 'test' | 'build' | 'verify'>;
    command: string | undefined;
    timeoutMs?: number;
  }[] = [
    { step: 'lint', command: opts.config.lintCommand },
    { step: 'test', command: opts.config.testCommand },
    { step: 'build', command: opts.config.buildCommand },
    {
      step: 'verify',
      command: opts.config.verifyCommand,
      timeoutMs: opts.config.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS,
    },
  ];

  for (const s of shellSteps) {
    if (checkAborted(s.step)) {
      return { ok: false, steps, featureBranch: opts.featureBranch, failedAt: s.step };
    }
    if (s.command === undefined || s.command.trim().length === 0) {
      steps.push({
        step: s.step,
        status: 'skipped',
        durationMs: 0,
        detail: `no ${s.step}Command configured`,
      });
      continue;
    }
    const input: ShellCommandInput = {
      command: s.command,
      cwd: opts.worktreePath,
      ...(s.timeoutMs !== undefined ? { timeoutMs: s.timeoutMs } : {}),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    };
    const result = await shell(input);
    const ok = result.exitCode === 0 && !result.timedOut && !result.signaled;
    steps.push({
      step: s.step,
      status: ok ? 'ok' : result.signaled || opts.signal?.aborted === true ? 'aborted' : 'failed',
      durationMs: result.durationMs,
      detail: formatShellDetail(s.command, result),
      exitCode: result.exitCode,
    });
    if (!ok) {
      return {
        ok: false,
        steps,
        featureBranch: opts.featureBranch,
        failedAt: s.step,
      };
    }
  }

  // ---- 6. commit ----
  if (checkAborted('commit')) {
    return { ok: false, steps, featureBranch: opts.featureBranch, failedAt: 'commit' };
  }
  if (opts.preCommitCheck !== undefined) {
    const gateStart = Date.now();
    const gate = await opts.preCommitCheck();
    if (!gate.ok) {
      steps.push({
        step: 'commit',
        status: 'failed',
        durationMs: Date.now() - gateStart,
        detail: gate.message,
      });
      return { ok: false, steps, featureBranch: opts.featureBranch, failedAt: 'commit' };
    }
  }
  {
    const start = Date.now();
    try {
      const commit: CommitResult = await gitOps.commitAll({
        worktreePath: opts.worktreePath,
        message: opts.commitMessage,
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      });
      commitSha = commit.sha;
      steps.push({
        step: 'commit',
        status: 'ok',
        durationMs: Date.now() - start,
        detail: `${commit.shortSha}: ${commit.subject} (${commit.stagedFiles.length} file${
          commit.stagedFiles.length === 1 ? '' : 's'
        })`,
      });
    } catch (err) {
      if (err instanceof NothingToCommitError) {
        steps.push({
          step: 'commit',
          status: 'skipped',
          durationMs: Date.now() - start,
          detail: 'nothing to commit — working tree clean',
        });
        // Nothing to ship — stop here with ok:true so the caller surfaces
        // the clean state rather than falling through to push/merge.
        return {
          ok: true,
          steps,
          featureBranch: opts.featureBranch,
        };
      }
      steps.push({
        step: 'commit',
        status: 'failed',
        durationMs: Date.now() - start,
        detail: `commit failed: ${errMessage(err)}`,
      });
      return { ok: false, steps, featureBranch: opts.featureBranch, failedAt: 'commit' };
    }
  }

  // ---- 7. push ----
  if (checkAborted('push')) {
    return {
      ok: false,
      steps,
      featureBranch: opts.featureBranch,
      failedAt: 'push',
      ...(commitSha !== undefined ? { commitSha } : {}),
    };
  }
  {
    const start = Date.now();
    try {
      const pushRes: PushResult = await gitOps.push({
        worktreePath: opts.worktreePath,
        branch: opts.featureBranch,
        setUpstream: true,
        ...(opts.sourceRemote !== undefined ? { remote: opts.sourceRemote } : {}),
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      });
      steps.push({
        step: 'push',
        status: 'ok',
        durationMs: Date.now() - start,
        detail: `${pushRes.remote}/${pushRes.branch}`,
      });
    } catch (err) {
      steps.push({
        step: 'push',
        status: 'failed',
        durationMs: Date.now() - start,
        detail: `push failed: ${errMessage(err)}`,
      });
      return {
        ok: false,
        steps,
        featureBranch: opts.featureBranch,
        failedAt: 'push',
        ...(commitSha !== undefined ? { commitSha } : {}),
      };
    }
  }

  // ---- 8. merge (optional) ----
  if (opts.mergeTo === undefined || opts.mergeTo.length === 0) {
    return {
      ok: true,
      steps,
      featureBranch: opts.featureBranch,
      ...(commitSha !== undefined ? { commitSha } : {}),
    };
  }
  if (checkAborted('merge')) {
    return {
      ok: false,
      steps,
      featureBranch: opts.featureBranch,
      failedAt: 'merge',
      ...(commitSha !== undefined ? { commitSha } : {}),
    };
  }
  {
    const start = Date.now();
    try {
      const merge: MergeResult = await gitOps.mergeBranch({
        repoPath: opts.repoPath,
        targetBranch: opts.mergeTo,
        sourceBranch: opts.featureBranch,
        deleteRemoteBranch: true,
        ...(opts.sourceRemote !== undefined ? { sourceRemote: opts.sourceRemote } : {}),
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      });
      mergeSha = merge.mergeSha;
      steps.push({
        step: 'merge',
        status: 'ok',
        durationMs: Date.now() - start,
        detail: `merged ${merge.sourceBranch} → ${merge.targetBranch} (${merge.mergeSha.slice(0, 7)})${
          merge.deletedRemoteBranch ? ', remote branch deleted' : ''
        }`,
      });
    } catch (err) {
      steps.push({
        step: 'merge',
        status: 'failed',
        durationMs: Date.now() - start,
        detail: `merge failed: ${errMessage(err)}`,
      });
      return {
        ok: false,
        steps,
        featureBranch: opts.featureBranch,
        failedAt: 'merge',
        ...(commitSha !== undefined ? { commitSha } : {}),
      };
    }
  }

  return {
    ok: true,
    steps,
    featureBranch: opts.featureBranch,
    ...(commitSha !== undefined ? { commitSha } : {}),
    ...(mergeSha !== undefined ? { mergeSha } : {}),
  };
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function formatShellDetail(command: string, result: ShellCommandResult): string {
  const head = `\`${command.length > 120 ? command.slice(0, 120) + '…' : command}\``;
  if (result.timedOut) {
    return `${head} timed out (exit ${result.exitCode ?? 'null'})`;
  }
  if (result.signaled) {
    return `${head} killed by signal`;
  }
  if (result.exitCode === 0) return head;
  const stderrTail = result.stderr.split(/\r?\n/).slice(-3).join(' | ').trim();
  return `${head} exit ${result.exitCode ?? 'null'}${stderrTail.length > 0 ? ` · ${stderrTail}` : ''}`;
}
