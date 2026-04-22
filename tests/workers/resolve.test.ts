import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveCommandPath,
  resolveClaudePath,
  _clearResolveCache,
} from '../../src/workers/resolve.js';

let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'symphony-resolve-'));
  _clearResolveCache();
});

afterEach(() => {
  try {
    rmSync(sandbox, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

function writeExecutable(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, '#!/usr/bin/env node\nconsole.log("hi")\n', 'utf8');
  chmodSync(file, 0o755);
  return file;
}

describe('resolveCommandPath — POSIX', () => {
  it('finds an executable on PATH', () => {
    const binDir = join(sandbox, 'bin');
    const exe = writeExecutable(binDir, 'myapp');
    const resolved = resolveCommandPath('myapp', {
      platform: 'linux',
      sourceEnv: { PATH: binDir },
    });
    expect(resolved).toBe(exe);
  });

  it('returns null when nothing matches', () => {
    const resolved = resolveCommandPath('nonexistent-xyz', {
      platform: 'linux',
      sourceEnv: { PATH: sandbox },
    });
    expect(resolved).toBeNull();
  });

  it('returns null for empty command', () => {
    expect(resolveCommandPath('', { platform: 'linux', sourceEnv: {} })).toBeNull();
    expect(resolveCommandPath('   ', { platform: 'linux', sourceEnv: {} })).toBeNull();
  });

  it('returns null when PATH is not set', () => {
    const resolved = resolveCommandPath('anything', { platform: 'linux', sourceEnv: {} });
    expect(resolved).toBeNull();
  });

  it('resolves absolute path-like inputs directly', () => {
    const exe = writeExecutable(join(sandbox, 'bin'), 'direct');
    const resolved = resolveCommandPath(exe, { platform: 'linux', sourceEnv: {} });
    expect(resolved).toBe(exe);
  });
});

describe('resolveCommandPath — Windows PATHEXT', () => {
  it('appends PATHEXT extensions and picks first match', () => {
    const binDir = join(sandbox, 'bin');
    const exe = writeExecutable(binDir, 'tool.exe');
    const resolved = resolveCommandPath('tool', {
      platform: 'win32',
      sourceEnv: { PATH: binDir, PATHEXT: '.COM;.EXE;.CMD' },
    });
    expect(resolved).toBe(exe);
  });

  it('finds .cmd when .exe not present', () => {
    const binDir = join(sandbox, 'bin');
    const cmd = writeExecutable(binDir, 'tool.cmd');
    const resolved = resolveCommandPath('tool', {
      platform: 'win32',
      sourceEnv: { PATH: binDir, PATHEXT: '.COM;.EXE;.CMD' },
    });
    expect(resolved).toBe(cmd);
  });

  it('does not re-append extensions when the command already has one', () => {
    const binDir = join(sandbox, 'bin');
    const exe = writeExecutable(binDir, 'tool.exe');
    const resolved = resolveCommandPath('tool.exe', {
      platform: 'win32',
      sourceEnv: { PATH: binDir, PATHEXT: '.COM;.EXE;.CMD' },
    });
    expect(resolved).toBe(exe);
  });

  it('uses default PATHEXT when the env var is missing', () => {
    const binDir = join(sandbox, 'bin');
    const exe = writeExecutable(binDir, 'tool.exe');
    const resolved = resolveCommandPath('tool', {
      platform: 'win32',
      sourceEnv: { PATH: binDir },
    });
    expect(resolved).toBe(exe);
  });
});

describe('resolveCommandPath — caching', () => {
  it('uses a provided cache and returns cached hits', () => {
    const binDir = join(sandbox, 'bin');
    const exe = writeExecutable(binDir, 'cached');
    const cache = new Map<string, string | null>();
    const first = resolveCommandPath('cached', {
      platform: 'linux',
      sourceEnv: { PATH: binDir },
      cache,
    });
    expect(first).toBe(exe);
    expect(cache.size).toBe(1);
    // Delete the file; cached lookup should still return the old path
    rmSync(exe);
    const second = resolveCommandPath('cached', {
      platform: 'linux',
      sourceEnv: { PATH: binDir },
      cache,
    });
    expect(second).toBe(exe);
  });
});

describe('resolveClaudePath', () => {
  it('returns the resolved path when claude is found', () => {
    const binDir = join(sandbox, 'bin');
    const claude = writeExecutable(binDir, 'claude');
    const resolved = resolveClaudePath(undefined, {
      platform: 'linux',
      sourceEnv: { PATH: binDir },
    });
    expect(resolved).toBe(claude);
  });

  it('returns the input verbatim when not found (spawn will surface error)', () => {
    const resolved = resolveClaudePath('claude', { platform: 'linux', sourceEnv: { PATH: '' } });
    expect(resolved).toBe('claude');
  });

  it('respects explicit claude path override', () => {
    const exe = writeExecutable(join(sandbox, 'bin'), 'my-claude');
    const resolved = resolveClaudePath(exe, { platform: 'linux', sourceEnv: {} });
    expect(resolved).toBe(exe);
  });
});
