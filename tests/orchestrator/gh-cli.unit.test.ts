/**
 * Phase 3O.2 — gh-cli runner. Fully hermetic: a fake spawn records argv +
 * stdin and returns canned child output. Never launches a real `gh`/`git`,
 * never opens a PR.
 */

import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { createGhRunner, GhCliError } from '../../src/orchestrator/gh-cli.js';

/** The spawn fn type `createGhRunner` accepts — derived so we need no node:child_process value import. */
type FakeSpawn = NonNullable<Parameters<typeof createGhRunner>[0]>;

interface SpawnScript {
  stdout?: string;
  stderr?: string;
  code?: number;
}

interface SpawnCall {
  binary: string;
  args: string[];
  stdin: string;
}

type Responder = (binary: string, args: string[]) => SpawnScript;

function makeFakeSpawn(responder: Responder): {
  spawn: FakeSpawn;
  calls: SpawnCall[];
} {
  const calls: SpawnCall[] = [];
  const spawn = ((binary: string, args: string[]) => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      stdin: { on: () => void; end: (d?: string) => void };
      kill: () => boolean;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const record: SpawnCall = { binary, args: [...args], stdin: '' };
    calls.push(record);
    child.stdin = {
      on: () => undefined,
      end: (d?: string) => {
        record.stdin = d ?? '';
      },
    };
    child.kill = () => true;
    const script = responder(binary, args);
    setImmediate(() => {
      if (script.stdout) child.stdout.emit('data', Buffer.from(script.stdout, 'utf8'));
      if (script.stderr) child.stderr.emit('data', Buffer.from(script.stderr, 'utf8'));
      child.emit('close', script.code ?? 0);
    });
    return child;
  }) as unknown as FakeSpawn;
  return { spawn, calls };
}

function findCall(calls: SpawnCall[], match: (c: SpawnCall) => boolean): SpawnCall {
  const c = calls.find(match);
  if (c === undefined) throw new Error('expected spawn call not found');
  return c;
}

describe('Phase 3O.2 — gh-cli checkAvailable', () => {
  it('reports available when gh --version + gh auth status both succeed', async () => {
    const { spawn } = makeFakeSpawn((_b, args) =>
      args.includes('--version') ? { stdout: 'gh version 2.86.0', code: 0 } : { code: 0 },
    );
    const out = await createGhRunner(spawn).checkAvailable('/repo');
    expect(out.available).toBe(true);
  });

  it('reports gh-not-found when --version fails', async () => {
    const { spawn } = makeFakeSpawn(() => ({ stderr: 'command not found', code: 1 }));
    const out = await createGhRunner(spawn).checkAvailable('/repo');
    expect(out.available).toBe(false);
    expect(out.reason).toBe('gh-not-found');
    expect(out.detail).toContain('cli.github.com');
  });

  it('reports gh-not-authenticated when auth status fails', async () => {
    const { spawn } = makeFakeSpawn((_b, args) =>
      args.includes('--version') ? { code: 0 } : { stderr: 'not logged in', code: 1 },
    );
    const out = await createGhRunner(spawn).checkAvailable('/repo');
    expect(out.available).toBe(false);
    expect(out.reason).toBe('gh-not-authenticated');
  });
});

describe('Phase 3O.2 — gh-cli hasGitHubRemote', () => {
  it('accepts https and ssh github.com remotes', async () => {
    for (const url of [
      'https://github.com/owner/repo.git',
      'git@github.com:owner/repo.git',
      'https://github.com/owner/repo',
    ]) {
      const { spawn } = makeFakeSpawn(() => ({ stdout: url, code: 0 }));
      expect(await createGhRunner(spawn).hasGitHubRemote('/repo')).toBe(true);
    }
  });

  it('rejects non-github remotes and missing-remote failures', async () => {
    const gitlab = makeFakeSpawn(() => ({ stdout: 'https://gitlab.com/o/r.git', code: 0 }));
    expect(await createGhRunner(gitlab.spawn).hasGitHubRemote('/repo')).toBe(false);
    const noRemote = makeFakeSpawn(() => ({ stderr: 'no such remote', code: 2 }));
    expect(await createGhRunner(noRemote.spawn).hasGitHubRemote('/repo')).toBe(false);
  });
});

describe('Phase 3O.2 — gh-cli createPr', () => {
  it('builds the right argv, pipes the body via stdin, parses the URL', async () => {
    const { spawn, calls } = makeFakeSpawn((_b, args) =>
      args[0] === 'pr' && args[1] === 'create'
        ? { stdout: 'https://github.com/o/r/pull/42\n', code: 0 }
        : { code: 0 },
    );
    const res = await createGhRunner(spawn).createPr({
      cwd: '/repo',
      base: 'master',
      head: 'feature/x',
      title: 'feat: thing',
      body: '## Body\nmarkdown',
      draft: false,
    });
    expect(res).toEqual({ url: 'https://github.com/o/r/pull/42', alreadyExisted: false });
    const create = findCall(calls, (c) => c.args[0] === 'pr' && c.args[1] === 'create');
    expect(create.args).toEqual([
      'pr',
      'create',
      '--base',
      'master',
      '--head',
      'feature/x',
      '--title',
      'feat: thing',
      '--body-file',
      '-',
    ]);
    expect(create.stdin).toBe('## Body\nmarkdown');
    expect(create.args).not.toContain('--draft');
  });

  it('passes --draft when requested', async () => {
    const { spawn, calls } = makeFakeSpawn(() => ({
      stdout: 'https://github.com/o/r/pull/7',
      code: 0,
    }));
    await createGhRunner(spawn).createPr({
      cwd: '/repo',
      base: 'main',
      head: 'feat',
      title: 't',
      body: 'b',
      draft: true,
    });
    const create = findCall(calls, (c) => c.args[0] === 'pr' && c.args[1] === 'create');
    expect(create.args).toContain('--draft');
  });

  it('returns the existing URL inline from stderr when a PR already exists', async () => {
    const { spawn } = makeFakeSpawn(() => ({
      stderr:
        'a pull request for branch "feat" into branch "master" already exists:\nhttps://github.com/o/r/pull/9',
      code: 1,
    }));
    const res = await createGhRunner(spawn).createPr({
      cwd: '/repo',
      base: 'master',
      head: 'feat',
      title: 't',
      body: 'b',
      draft: false,
    });
    expect(res).toEqual({ url: 'https://github.com/o/r/pull/9', alreadyExisted: true });
  });

  it('falls back to `gh pr view` when already-exists carries no inline URL', async () => {
    const { spawn } = makeFakeSpawn((_b, args) => {
      if (args[0] === 'pr' && args[1] === 'create') {
        return { stderr: 'a pull request already exists for this branch', code: 1 };
      }
      if (args[0] === 'pr' && args[1] === 'view') {
        return { stdout: 'https://github.com/o/r/pull/12\n', code: 0 };
      }
      return { code: 0 };
    });
    const res = await createGhRunner(spawn).createPr({
      cwd: '/repo',
      base: 'master',
      head: 'feat',
      title: 't',
      body: 'b',
      draft: false,
    });
    expect(res).toEqual({ url: 'https://github.com/o/r/pull/12', alreadyExisted: true });
  });

  it('throws GhCliError on a generic failure', async () => {
    const { spawn } = makeFakeSpawn(() => ({ stderr: 'fatal: auth failed', code: 1 }));
    await expect(
      createGhRunner(spawn).createPr({
        cwd: '/repo',
        base: 'master',
        head: 'feat',
        title: 't',
        body: 'b',
        draft: false,
      }),
    ).rejects.toBeInstanceOf(GhCliError);
  });

  it('throws GhCliError when create succeeds but no URL is found', async () => {
    const { spawn } = makeFakeSpawn(() => ({ stdout: 'created something', code: 0 }));
    await expect(
      createGhRunner(spawn).createPr({
        cwd: '/repo',
        base: 'master',
        head: 'feat',
        title: 't',
        body: 'b',
        draft: false,
      }),
    ).rejects.toBeInstanceOf(GhCliError);
  });

  it('does NOT fabricate an already-exists result when the call was aborted (MAJOR-1)', async () => {
    // The aborted child's output happens to contain "already exists" — a
    // naive implementation would return { alreadyExisted: true }. The signaled
    // guard must surface the cancellation instead.
    const { spawn } = makeFakeSpawn(() => ({
      stderr: 'a pull request already exists: https://github.com/o/r/pull/99',
      code: 1,
    }));
    await expect(
      createGhRunner(spawn).createPr({
        cwd: '/repo',
        base: 'master',
        head: 'feat',
        title: 't',
        body: 'b',
        draft: false,
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrow(/cancelled/i);
  });
});
