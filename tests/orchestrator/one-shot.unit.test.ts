import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  OneShotExecutionError,
  defaultOneShotRunner,
  type OneShotSpawnFn,
} from '../../src/orchestrator/one-shot.js';

interface FakeChildOptions {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number | null;
  /** Delay before emitting close (ms). */
  readonly closeDelayMs?: number;
  /** If true, emit 'error' instead of 'close'. */
  readonly emitError?: Error;
  /** Reject kill with abort. */
  readonly respondToSignals?: boolean;
}

function makeFakeSpawn(options: FakeChildOptions = {}): OneShotSpawnFn {
  return () => makeFakeChild(options);
}

function makeFakeChild(options: FakeChildOptions = {}): ChildProcess {
  const emitter = new EventEmitter() as ChildProcess;
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const stdin = new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  });
  (emitter as unknown as { stdout: Readable }).stdout = stdout;
  (emitter as unknown as { stderr: Readable }).stderr = stderr;
  (emitter as unknown as { stdin: Writable }).stdin = stdin;
  let killed = false;
  emitter.kill = ((_sig?: unknown) => {
    killed = true;
    if (options.respondToSignals !== false) {
      setTimeout(() => {
        emitter.emit('close', options.exitCode ?? null, 'SIGTERM');
      }, 0);
    }
    return true;
  }) as ChildProcess['kill'];

  setTimeout(() => {
    if (options.emitError !== undefined) {
      emitter.emit('error', options.emitError);
      return;
    }
    if (options.stdout !== undefined && options.stdout.length > 0) {
      stdout.push(Buffer.from(options.stdout, 'utf8'));
    }
    stdout.push(null);
    if (options.stderr !== undefined && options.stderr.length > 0) {
      stderr.push(Buffer.from(options.stderr, 'utf8'));
    }
    stderr.push(null);
    if (!killed) {
      setTimeout(() => {
        emitter.emit('close', options.exitCode ?? 0, null);
      }, options.closeDelayMs ?? 0);
    }
  }, 0);

  return emitter;
}

describe('defaultOneShotRunner (with fake spawn)', () => {
  let trustFile = '';
  let cwd = '';

  beforeEach(async () => {
    trustFile = path.join(
      await fs.mkdtemp(path.join(os.tmpdir(), 'sym-one-')),
      '.claude.json',
    );
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'sym-one-cwd-'));
  });

  afterEach(async () => {
    await fs.rm(path.dirname(trustFile), { recursive: true, force: true }).catch(() => {});
    await fs.rm(cwd, { recursive: true, force: true }).catch(() => {});
  });

  it('returns parsed envelope on clean exit', async () => {
    const stdout = JSON.stringify({ result: 'hi there', session_id: 'sess-A' });
    const r = await defaultOneShotRunner({
      prompt: 'say hi',
      cwd,
      claudeBinary: 'claude',
      claudeConfigPath: trustFile,
      spawn: makeFakeSpawn({ stdout, exitCode: 0 }),
    });
    expect(r.rawStdout).toBe(stdout);
    expect(r.text).toBe('hi there');
    expect(r.sessionId).toBe('sess-A');
    expect(r.exitCode).toBe(0);
    expect(r.signaled).toBe(false);
    expect(r.stderrTail).toBe('');
  });

  it('captures stderr tail even on successful exit', async () => {
    const stderr = 'warn: something\nanother line\n';
    const r = await defaultOneShotRunner({
      prompt: 'go',
      cwd,
      claudeBinary: 'claude',
      claudeConfigPath: trustFile,
      spawn: makeFakeSpawn({ stdout: '{}', stderr, exitCode: 0 }),
    });
    expect(r.stderrTail).toContain('warn: something');
  });

  it('throws OneShotExecutionError on non-zero exit with empty stdout', async () => {
    await expect(
      defaultOneShotRunner({
        prompt: 'fail',
        cwd,
        claudeBinary: 'claude',
        claudeConfigPath: trustFile,
        spawn: makeFakeSpawn({ stdout: '', stderr: 'boom\n', exitCode: 1 }),
      }),
    ).rejects.toBeInstanceOf(OneShotExecutionError);
  });

  it('returns stdout even on non-zero exit when stdout is non-empty', async () => {
    const r = await defaultOneShotRunner({
      prompt: 'fail-but-printed',
      cwd,
      claudeBinary: 'claude',
      claudeConfigPath: trustFile,
      spawn: makeFakeSpawn({
        stdout: JSON.stringify({ result: 'partial' }),
        stderr: 'warn\n',
        exitCode: 2,
      }),
    });
    expect(r.exitCode).toBe(2);
    expect(r.text).toBe('partial');
  });

  it('kills the child on timeout and marks signaled', async () => {
    const r = await defaultOneShotRunner({
      prompt: 'slow',
      cwd,
      claudeBinary: 'claude',
      claudeConfigPath: trustFile,
      timeoutMs: 20,
      spawn: makeFakeSpawn({
        stdout: JSON.stringify({ result: 'late' }),
        closeDelayMs: 200,
      }),
    });
    expect(r.signaled).toBe(true);
    // stdout was already pushed before timeout, so text is still populated.
    expect(r.text).toBe('late');
  });

  it('aborts on AbortSignal', async () => {
    const ctrl = new AbortController();
    const pendingPromise = defaultOneShotRunner({
      prompt: 'abortable',
      cwd,
      claudeBinary: 'claude',
      claudeConfigPath: trustFile,
      signal: ctrl.signal,
      spawn: makeFakeSpawn({
        stdout: JSON.stringify({ result: 'late' }),
        closeDelayMs: 200,
      }),
    });
    setTimeout(() => ctrl.abort(), 10);
    const r = await pendingPromise;
    expect(r.signaled).toBe(true);
  });

  it('returns early when signal is already aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const r = await defaultOneShotRunner({
      prompt: 'preaborted',
      cwd,
      claudeBinary: 'claude',
      claudeConfigPath: trustFile,
      signal: ctrl.signal,
      spawn: makeFakeSpawn({ stdout: JSON.stringify({ result: 'x' }) }),
    });
    expect(r.signaled).toBe(true);
  });

  it('writes trust dialog entry to ~/.claude.json override', async () => {
    await defaultOneShotRunner({
      prompt: 'ensure-trust',
      cwd,
      claudeBinary: 'claude',
      claudeConfigPath: trustFile,
      spawn: makeFakeSpawn({ stdout: '{}' }),
    });
    const parsed = JSON.parse(await fs.readFile(trustFile, 'utf8')) as {
      projects?: Record<string, { hasTrustDialogAccepted?: boolean }>;
    };
    const key = path.resolve(cwd);
    expect(parsed.projects?.[key]?.hasTrustDialogAccepted).toBe(true);
  });

  it('propagates spawn errors', async () => {
    await expect(
      defaultOneShotRunner({
        prompt: 'break',
        cwd,
        claudeBinary: 'claude',
        claudeConfigPath: trustFile,
        spawn: makeFakeSpawn({ emitError: new Error('ENOENT') }),
      }),
    ).rejects.toThrow(/ENOENT/);
  });
});
