import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  spawnToast,
  xmlEscape,
  appleScriptEscape,
  buildPowerShellScript,
} from '../../src/notifications/spawn-toast.js';
import type { SpawnHandle, SpawnImpl } from '../../src/notifications/types.js';

/**
 * Phase 3H.3 — spawn-toast unit tests.
 *
 * The shim itself is platform-conditional; we drive each branch with
 * an explicit `platform` override + a mock `spawnImpl`. The real
 * `child_process.spawn` is never invoked in these tests — we assert on
 * the exact argv shape passed to spawn (including stdio + windowsHide
 * options) and the stdin payload (PowerShell only).
 *
 * Promise contract: NEVER rejects. Every error path settles via
 * resolve(). That promise-shape is itself part of the contract.
 */

// ── Helpers ──────────────────────────────────────────────────────────

function makeMockSpawn(): {
  spawn: SpawnImpl;
  calls: Array<{ command: string; args: readonly string[]; options: unknown }>;
  child: SpawnHandle & { stdinChunks: string[]; emitter: EventEmitter; emit: EventEmitter['emit'] };
} {
  const calls: Array<{ command: string; args: readonly string[]; options: unknown }> = [];
  const stdinChunks: string[] = [];
  const emitter = new EventEmitter();
  const child = {
    stdin: {
      write(data: string): void {
        stdinChunks.push(data);
      },
      end(): void {
        // no-op for the mock
      },
    },
    on(event: 'error' | 'exit' | 'close', listener: (...args: unknown[]) => void): SpawnHandle {
      emitter.on(event, listener);
      return child as unknown as SpawnHandle;
    },
    kill(_signal?: NodeJS.Signals): boolean {
      emitter.emit('exit', 0);
      return true;
    },
    stdinChunks,
    emitter,
    emit: emitter.emit.bind(emitter),
  } as SpawnHandle & {
    stdinChunks: string[];
    emitter: EventEmitter;
    emit: EventEmitter['emit'];
  };
  const spawn: SpawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    return child;
  };
  return { spawn, calls, child };
}

// ── XML escaping ─────────────────────────────────────────────────────

describe('xmlEscape', () => {
  it('escapes the five XML reserved characters in the right order', () => {
    expect(xmlEscape('a & b < c > d " e \' f')).toBe('a &amp; b &lt; c &gt; d &quot; e &apos; f');
  });

  it('does not double-encode an already-escaped ampersand', () => {
    expect(xmlEscape('foo &amp; bar')).toBe('foo &amp;amp; bar');
  });

  it('passes through ASCII printables unchanged', () => {
    expect(xmlEscape('Hello, world!')).toBe('Hello, world!');
  });
});

describe('appleScriptEscape', () => {
  it('escapes backslash before quote so re-escaping does not chain', () => {
    expect(appleScriptEscape('foo "bar" baz')).toBe('foo \\"bar\\" baz');
    expect(appleScriptEscape('a\\b')).toBe('a\\\\b');
    expect(appleScriptEscape('a\\"b')).toBe('a\\\\\\"b');
  });
});

describe('buildPowerShellScript', () => {
  it('embeds XML-escaped title and body', () => {
    const script = buildPowerShellScript('Symphony · Foo', 'Bar & Baz');
    // The "·" middle dot is not an XML reserved char — passes through
    // unchanged. Only the five XML reserved chars get escaped.
    expect(script).toContain('<text>Symphony · Foo</text>');
    expect(script).toContain('<text>Bar &amp; Baz</text>');
  });

  it('escapes embedded angle brackets and quotes so the XML stays parseable', () => {
    const script = buildPowerShellScript('a<b>c', '"quoted" \'q\'');
    expect(script).toContain('<text>a&lt;b&gt;c</text>');
    expect(script).toContain('<text>&quot;quoted&quot; &apos;q&apos;</text>');
  });

  it('uses ToastGeneric template + Symphony AUMID', () => {
    const script = buildPowerShellScript('t', 'b');
    expect(script).toContain('template="ToastGeneric"');
    expect(script).toContain(`CreateToastNotifier('Symphony')`);
  });
});

// ── Per-platform spawn argv ──────────────────────────────────────────

describe('spawnToast — per-platform argv', () => {
  it('Win32: spawns powershell.exe with -NoProfile + Hidden + reads from stdin', async () => {
    const { spawn, calls, child } = makeMockSpawn();
    const promise = spawnToast({
      title: 'Symphony · Test',
      body: 'failed: foo',
      platform: 'win32',
      spawnImpl: spawn,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe('powershell.exe');
    expect(calls[0]!.args).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-WindowStyle',
      'Hidden',
      '-Command',
      '-',
    ]);
    // Stdin gets the script
    expect(child.stdinChunks).toHaveLength(1);
    expect(child.stdinChunks[0]).toContain('<text>Symphony · Test</text>');
    expect(child.stdinChunks[0]).toContain('<text>failed: foo</text>');
    // Resolve via exit
    child.emit('exit', 0);
    await promise;
  });

  it('Darwin: spawns osascript with single -e arg containing escaped strings', async () => {
    const { spawn, calls, child } = makeMockSpawn();
    const promise = spawnToast({
      title: 'Sym "phony"',
      body: 'a "b"',
      platform: 'darwin',
      spawnImpl: spawn,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe('osascript');
    expect(calls[0]!.args).toEqual([
      '-e',
      'display notification "a \\"b\\"" with title "Sym \\"phony\\""',
    ]);
    child.emit('exit', 0);
    await promise;
  });

  it('Linux: spawns notify-send with title + body as positional args', async () => {
    const { spawn, calls, child } = makeMockSpawn();
    const promise = spawnToast({
      title: 'Symphony · Project',
      body: 'completed: do thing',
      platform: 'linux',
      spawnImpl: spawn,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe('notify-send');
    expect(calls[0]!.args).toEqual(['Symphony · Project', 'completed: do thing']);
    child.emit('exit', 0);
    await promise;
  });
});

// ── Error / timeout / unknown-platform handling ──────────────────────

describe('spawnToast — never rejects', () => {
  it('resolves when the child emits "error" (e.g. ENOENT for missing notify-send)', async () => {
    const { spawn, child } = makeMockSpawn();
    const promise = spawnToast({
      title: 't',
      body: 'b',
      platform: 'linux',
      spawnImpl: spawn,
    });
    child.emit('error', new Error('ENOENT'));
    await expect(promise).resolves.toBeUndefined();
  });

  it('resolves when synchronous spawn throws (e.g. EACCES)', async () => {
    const throwingSpawn: SpawnImpl = () => {
      throw new Error('EACCES');
    };
    await expect(
      spawnToast({
        title: 't',
        body: 'b',
        platform: 'linux',
        spawnImpl: throwingSpawn,
      }),
    ).resolves.toBeUndefined();
  });

  it('resolves on timeout and kills the child', async () => {
    vi.useFakeTimers();
    const { spawn, child } = makeMockSpawn();
    const killSpy = vi.spyOn(child, 'kill');
    const promise = spawnToast({
      title: 't',
      body: 'b',
      platform: 'win32',
      spawnImpl: spawn,
      timeoutMs: 100,
    });
    await vi.advanceTimersByTimeAsync(150);
    await promise;
    expect(killSpy).toHaveBeenCalledWith('SIGKILL');
    vi.useRealTimers();
  });

  it('resolves immediately on unknown platform without spawning', async () => {
    const { spawn, calls } = makeMockSpawn();
    await spawnToast({
      title: 't',
      body: 'b',
      // @ts-expect-error — testing the fall-through branch
      platform: 'aix',
      spawnImpl: spawn,
    });
    expect(calls).toHaveLength(0);
  });
});
