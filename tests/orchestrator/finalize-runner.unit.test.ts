import { describe, expect, it } from 'vitest';
import {
  defaultShellRunner,
  runFinalize,
  type FinalizeGitOps,
  type ShellCommandResult,
  type ShellCommandRunner,
} from '../../src/orchestrator/finalize-runner.js';
import {
  NothingToCommitError,
  PushRejectedError,
  type CommitResult,
  type MergeResult,
  type PushResult,
} from '../../src/orchestrator/git-ops.js';

interface MockCommandLog {
  readonly command: string;
  readonly cwd: string;
  readonly timeoutMs?: number;
}

function makeShell(
  responses: Readonly<Record<string, Partial<ShellCommandResult>>>,
  log: MockCommandLog[] = [],
): ShellCommandRunner {
  return async (input) => {
    const entry: MockCommandLog = {
      command: input.command,
      cwd: input.cwd,
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    };
    log.push(entry);
    const r = responses[input.command] ?? { exitCode: 0 };
    return {
      exitCode: r.exitCode ?? 0,
      stdout: r.stdout ?? '',
      stderr: r.stderr ?? '',
      signaled: r.signaled ?? false,
      timedOut: r.timedOut ?? false,
      durationMs: r.durationMs ?? 5,
    };
  };
}

interface GitOpsSpies {
  commitCalls: number;
  pushCalls: number;
  mergeCalls: number;
}

function makeGitOps(overrides: {
  commitAll?: (opts: unknown) => Promise<CommitResult>;
  push?: (opts: unknown) => Promise<PushResult>;
  mergeBranch?: (opts: unknown) => Promise<MergeResult>;
} = {}): { gitOps: FinalizeGitOps; spies: GitOpsSpies } {
  const spies: GitOpsSpies = { commitCalls: 0, pushCalls: 0, mergeCalls: 0 };
  const commitAll: FinalizeGitOps['commitAll'] =
    (overrides.commitAll as FinalizeGitOps['commitAll']) ??
    (async () => {
      spies.commitCalls += 1;
      return {
        sha: 'a'.repeat(40),
        shortSha: 'aaaaaaa',
        subject: 'feat: ship',
        stagedFiles: ['a.ts'],
      };
    });
  const push: FinalizeGitOps['push'] =
    (overrides.push as FinalizeGitOps['push']) ??
    (async () => {
      spies.pushCalls += 1;
      return { remote: 'origin', branch: 'feature/x', setUpstream: true };
    });
  const mergeBranch: FinalizeGitOps['mergeBranch'] =
    (overrides.mergeBranch as FinalizeGitOps['mergeBranch']) ??
    (async () => {
      spies.mergeCalls += 1;
      return {
        mergeSha: 'b'.repeat(40),
        targetBranch: 'main',
        sourceBranch: 'feature/x',
        deletedRemoteBranch: true,
      };
    });

  // Wrap overridden spies in call counters so the generic path still counts.
  const wrappedCommit = async (opts: unknown): Promise<CommitResult> => {
    spies.commitCalls += 1;
    return commitAll(opts as Parameters<FinalizeGitOps['commitAll']>[0]);
  };
  const wrappedPush = async (opts: unknown): Promise<PushResult> => {
    spies.pushCalls += 1;
    return push(opts as Parameters<FinalizeGitOps['push']>[0]);
  };
  const wrappedMerge = async (opts: unknown): Promise<MergeResult> => {
    spies.mergeCalls += 1;
    return mergeBranch(opts as Parameters<FinalizeGitOps['mergeBranch']>[0]);
  };
  return {
    gitOps: {
      commitAll: overrides.commitAll ? (wrappedCommit as FinalizeGitOps['commitAll']) : commitAll,
      push: overrides.push ? (wrappedPush as FinalizeGitOps['push']) : push,
      mergeBranch: overrides.mergeBranch
        ? (wrappedMerge as FinalizeGitOps['mergeBranch'])
        : mergeBranch,
    },
    spies,
  };
}

const BASE = {
  worktreePath: '/tmp/wt',
  repoPath: '/tmp/repo',
  featureBranch: 'feature/x',
  commitMessage: 'feat: ship',
};

describe('runFinalize', () => {
  it('happy path, no merge — audit PASS → all shell steps skipped (none configured) → commit → push', async () => {
    const log: MockCommandLog[] = [];
    const shell = makeShell({}, log);
    const { gitOps, spies } = makeGitOps();
    const r = await runFinalize({
      ...BASE,
      config: {},
      auditRunner: async () => ({ pass: true, detail: 'PASS' }),
      commandRunner: shell,
      gitOps,
    });
    expect(r.ok).toBe(true);
    expect(r.failedAt).toBeUndefined();
    expect(r.commitSha).toBe('a'.repeat(40));
    expect(r.mergeSha).toBeUndefined();
    expect(log).toHaveLength(0);
    expect(spies.commitCalls).toBe(1);
    expect(spies.pushCalls).toBe(1);
    expect(spies.mergeCalls).toBe(0);
    expect(r.steps.map((s) => s.step)).toEqual([
      'audit',
      'lint',
      'test',
      'build',
      'verify',
      'commit',
      'push',
    ]);
    expect(r.steps.find((s) => s.step === 'lint')?.status).toBe('skipped');
    expect(r.steps.find((s) => s.step === 'commit')?.status).toBe('ok');
  });

  it('audit FAIL stops at step 1, no commands run', async () => {
    const log: MockCommandLog[] = [];
    const shell = makeShell({}, log);
    const { gitOps, spies } = makeGitOps();
    const r = await runFinalize({
      ...BASE,
      config: { lintCommand: 'pnpm lint' },
      auditRunner: async () => ({ pass: false, detail: 'Critical: bug' }),
      commandRunner: shell,
      gitOps,
    });
    expect(r.ok).toBe(false);
    expect(r.failedAt).toBe('audit');
    expect(log).toHaveLength(0);
    expect(spies.commitCalls).toBe(0);
    expect(spies.pushCalls).toBe(0);
  });

  it('command step non-zero exit stops the chain', async () => {
    const log: MockCommandLog[] = [];
    const shell = makeShell(
      { 'pnpm lint': { exitCode: 1, stderr: 'lint failure\n' } },
      log,
    );
    const { gitOps, spies } = makeGitOps();
    const r = await runFinalize({
      ...BASE,
      config: { lintCommand: 'pnpm lint', testCommand: 'pnpm test' },
      auditRunner: async () => ({ pass: true, detail: 'PASS' }),
      commandRunner: shell,
      gitOps,
    });
    expect(r.ok).toBe(false);
    expect(r.failedAt).toBe('lint');
    expect(log.map((e) => e.command)).toEqual(['pnpm lint']);
    expect(spies.commitCalls).toBe(0);
  });

  it('verify step uses its configured timeout', async () => {
    const log: MockCommandLog[] = [];
    const shell = makeShell({}, log);
    const { gitOps } = makeGitOps();
    await runFinalize({
      ...BASE,
      config: { verifyCommand: 'pnpm start', verifyTimeoutMs: 5_000 },
      auditRunner: async () => ({ pass: true, detail: 'PASS' }),
      commandRunner: shell,
      gitOps,
    });
    const verifyEntry = log.find((e) => e.command === 'pnpm start');
    expect(verifyEntry?.timeoutMs).toBe(5_000);
  });

  it('verify timeout surfaces as failed with clear detail', async () => {
    const log: MockCommandLog[] = [];
    const shell = makeShell(
      { 'pnpm start': { exitCode: null, timedOut: true, signaled: true } },
      log,
    );
    const { gitOps } = makeGitOps();
    const r = await runFinalize({
      ...BASE,
      config: { verifyCommand: 'pnpm start' },
      auditRunner: async () => ({ pass: true, detail: 'PASS' }),
      commandRunner: shell,
      gitOps,
    });
    expect(r.ok).toBe(false);
    expect(r.failedAt).toBe('verify');
    const verify = r.steps.find((s) => s.step === 'verify');
    expect(verify?.detail).toContain('timed out');
  });

  it('NothingToCommitError surfaces as skipped + ok:true and halts the chain', async () => {
    const { gitOps, spies } = makeGitOps({
      commitAll: async () => {
        throw new NothingToCommitError();
      },
    });
    const r = await runFinalize({
      ...BASE,
      config: {},
      auditRunner: async () => ({ pass: true, detail: 'PASS' }),
      commandRunner: makeShell({}),
      gitOps,
    });
    expect(r.ok).toBe(true);
    expect(r.failedAt).toBeUndefined();
    expect(r.steps.find((s) => s.step === 'commit')?.status).toBe('skipped');
    // Must not attempt push when there was nothing to commit.
    expect(spies.pushCalls).toBe(0);
  });

  it('push failure keeps commitSha in the result', async () => {
    const { gitOps, spies } = makeGitOps({
      push: async () => {
        throw new PushRejectedError('non-fast-forward', 'rejected', 1);
      },
    });
    const r = await runFinalize({
      ...BASE,
      config: {},
      auditRunner: async () => ({ pass: true, detail: 'PASS' }),
      commandRunner: makeShell({}),
      gitOps,
    });
    expect(r.ok).toBe(false);
    expect(r.failedAt).toBe('push');
    expect(r.commitSha).toBe('a'.repeat(40));
    expect(spies.commitCalls).toBe(1);
  });

  it('merges when mergeTo is provided', async () => {
    const { gitOps, spies } = makeGitOps();
    const r = await runFinalize({
      ...BASE,
      mergeTo: 'main',
      config: {},
      auditRunner: async () => ({ pass: true, detail: 'PASS' }),
      commandRunner: makeShell({}),
      gitOps,
    });
    expect(r.ok).toBe(true);
    expect(r.mergeSha).toBe('b'.repeat(40));
    expect(spies.mergeCalls).toBe(1);
  });

  it('skips merge step entirely when mergeTo is absent', async () => {
    const { gitOps, spies } = makeGitOps();
    const r = await runFinalize({
      ...BASE,
      config: {},
      auditRunner: async () => ({ pass: true, detail: 'PASS' }),
      commandRunner: makeShell({}),
      gitOps,
    });
    expect(r.steps.map((s) => s.step)).not.toContain('merge');
    expect(spies.mergeCalls).toBe(0);
  });

  it('bails at audit when signal is already aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const { gitOps, spies } = makeGitOps();
    const r = await runFinalize({
      ...BASE,
      config: {},
      auditRunner: async () => ({ pass: true, detail: 'PASS' }),
      commandRunner: makeShell({}),
      gitOps,
      signal: ctrl.signal,
    });
    expect(r.ok).toBe(false);
    expect(r.failedAt).toBe('audit');
    expect(r.steps[0]?.status).toBe('aborted');
    expect(spies.commitCalls).toBe(0);
  });

  it('marks intermediate step aborted when signal fires between steps', async () => {
    const ctrl = new AbortController();
    const { gitOps, spies } = makeGitOps();
    const r = await runFinalize({
      ...BASE,
      config: {},
      auditRunner: async () => {
        ctrl.abort();
        return { pass: true, detail: 'PASS' };
      },
      commandRunner: makeShell({}),
      gitOps,
      signal: ctrl.signal,
    });
    // Audit itself passes, but abort is noticed on the next pre-step gate.
    expect(r.ok).toBe(false);
    expect(r.failedAt).toBe('lint');
    expect(r.steps.find((s) => s.step === 'lint')?.status).toBe('aborted');
    expect(spies.commitCalls).toBe(0);
  });

  it('audit runner that throws converts to a failed audit step', async () => {
    const { gitOps } = makeGitOps();
    const r = await runFinalize({
      ...BASE,
      config: {},
      auditRunner: async () => {
        throw new Error('reviewer unreachable');
      },
      commandRunner: makeShell({}),
      gitOps,
    });
    expect(r.ok).toBe(false);
    expect(r.failedAt).toBe('audit');
    expect(r.steps[0]?.detail).toContain('reviewer unreachable');
  });

  it('preCommitCheck failure stops at commit step and reports failedAt:commit', async () => {
    const { gitOps, spies } = makeGitOps();
    const r = await runFinalize({
      ...BASE,
      config: {},
      auditRunner: async () => ({ pass: true, detail: 'PASS' }),
      commandRunner: makeShell({}),
      preCommitCheck: async () => ({ ok: false, message: 'worktree changed' }),
      gitOps,
    });
    expect(r.ok).toBe(false);
    expect(r.failedAt).toBe('commit');
    expect(spies.commitCalls).toBe(0);
    const commitStep = r.steps.find((s) => s.step === 'commit');
    expect(commitStep?.status).toBe('failed');
    expect(commitStep?.detail).toBe('worktree changed');
  });

  it('preCommitCheck success proceeds to commit', async () => {
    const { gitOps, spies } = makeGitOps();
    const r = await runFinalize({
      ...BASE,
      config: {},
      auditRunner: async () => ({ pass: true, detail: 'PASS' }),
      commandRunner: makeShell({}),
      preCommitCheck: async () => ({ ok: true }),
      gitOps,
    });
    expect(r.ok).toBe(true);
    expect(spies.commitCalls).toBe(1);
  });

  it('runs commands in dependency order: lint → test → build → verify → commit → push → merge', async () => {
    const log: MockCommandLog[] = [];
    const shell = makeShell({}, log);
    const { gitOps } = makeGitOps();
    await runFinalize({
      ...BASE,
      mergeTo: 'main',
      config: {
        lintCommand: 'L',
        testCommand: 'T',
        buildCommand: 'B',
        verifyCommand: 'V',
      },
      auditRunner: async () => ({ pass: true, detail: 'PASS' }),
      commandRunner: shell,
      gitOps,
    });
    expect(log.map((e) => e.command)).toEqual(['L', 'T', 'B', 'V']);
  });
});

describe('defaultShellRunner killTree (M1)', () => {
  it(
    'returns within the timeout budget when running a long-lived child — tree kill works',
    async () => {
      // Platform-portable long-running command. The node one-liner won't
      // exit without the runner killing it.
      const command =
        process.platform === 'win32'
          ? 'node -e "setInterval(() => {}, 1000)"'
          : 'node -e "setInterval(() => {}, 1000)"';
      const start = Date.now();
      const result = await defaultShellRunner({
        command,
        cwd: process.cwd(),
        timeoutMs: 500,
      });
      const elapsed = Date.now() - start;
      // Generous ceiling: 4s — if killTree is broken on Win32 (no
      // taskkill /T /F), we'd hang on the 1000ms interval forever.
      expect(elapsed).toBeLessThan(4_000);
      expect(result.timedOut).toBe(true);
      expect(result.signaled).toBe(true);
    },
    10_000,
  );

  it('respects an AbortSignal mid-run and kills the tree', async () => {
    const ctrl = new AbortController();
    const start = Date.now();
    const pending = defaultShellRunner({
      command:
        process.platform === 'win32'
          ? 'node -e "setInterval(() => {}, 1000)"'
          : 'node -e "setInterval(() => {}, 1000)"',
      cwd: process.cwd(),
      timeoutMs: 30_000,
      signal: ctrl.signal,
    });
    setTimeout(() => ctrl.abort(), 100);
    const result = await pending;
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(4_000);
    expect(result.signaled).toBe(true);
  }, 10_000);
});
