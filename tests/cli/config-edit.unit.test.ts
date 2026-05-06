import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { spawn as nodeSpawn } from 'node:child_process';
import { runConfigEdit } from '../../src/cli/config-edit.js';
import { SYMPHONY_CONFIG_FILE_ENV } from '../../src/utils/config.js';

function fakeSpawn(exitCode: number): {
  spawn: typeof nodeSpawn;
  calls: Array<{ cmd: string; args: readonly string[]; opts: unknown }>;
} {
  const calls: Array<{ cmd: string; args: readonly string[]; opts: unknown }> = [];
  const spawnFn = ((cmd: string, args: readonly string[], opts: unknown) => {
    calls.push({ cmd, args, opts });
    const ee = new EventEmitter();
    setImmediate(() => ee.emit('exit', exitCode));
    return ee as unknown as ReturnType<typeof nodeSpawn>;
  }) as unknown as typeof nodeSpawn;
  return { spawn: spawnFn, calls };
}

describe('runConfigEdit (3H.1)', () => {
  let tmp: string;
  let cfgFile: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'symphony-edit-'));
    cfgFile = join(tmp, 'config.json');
    originalEnv = process.env[SYMPHONY_CONFIG_FILE_ENV];
    delete process.env[SYMPHONY_CONFIG_FILE_ENV];
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env[SYMPHONY_CONFIG_FILE_ENV];
    else process.env[SYMPHONY_CONFIG_FILE_ENV] = originalEnv;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('creates the file with default content when missing', async () => {
    const { spawn, calls } = fakeSpawn(0);
    expect(existsSync(cfgFile)).toBe(false);
    const result = await runConfigEdit({
      configFilePath: cfgFile,
      editor: 'vim',
      spawnFn: spawn,
      env: {},
      platform: 'linux',
    });
    expect(result.created).toBe(true);
    expect(existsSync(cfgFile)).toBe(true);
    const parsed = JSON.parse(readFileSync(cfgFile, 'utf8'));
    expect(parsed.schemaVersion).toBe(1);
    expect(calls.length).toBe(1);
    // Spawn now receives a single shell-escaped command string + empty
    // argv (audit C1 fix for paths with spaces). Verify both editor
    // name and quoted path appear in the command.
    expect(calls[0]?.cmd).toContain('vim');
    expect(calls[0]?.cmd).toContain(cfgFile);
    expect(calls[0]?.args).toEqual([]);
  });

  it('does not recreate an existing file', async () => {
    writeFileSync(cfgFile, '{ "schemaVersion": 1 }\n', 'utf8');
    const { spawn } = fakeSpawn(0);
    const result = await runConfigEdit({
      configFilePath: cfgFile,
      editor: 'vim',
      spawnFn: spawn,
      env: {},
      platform: 'linux',
    });
    expect(result.created).toBe(false);
  });

  it('returns the editor exit code', async () => {
    const { spawn } = fakeSpawn(7);
    const result = await runConfigEdit({
      configFilePath: cfgFile,
      editor: 'vim',
      spawnFn: spawn,
      env: {},
      platform: 'linux',
    });
    expect(result.exitCode).toBe(7);
  });

  it('honors $VISUAL over $EDITOR', async () => {
    const { spawn, calls } = fakeSpawn(0);
    await runConfigEdit({
      configFilePath: cfgFile,
      spawnFn: spawn,
      env: { VISUAL: 'nvim', EDITOR: 'nano' },
      platform: 'linux',
    });
    expect(calls[0]?.cmd).toContain('nvim');
    expect(calls[0]?.cmd).not.toContain('nano');
  });

  it('falls back to $EDITOR when $VISUAL unset', async () => {
    const { spawn, calls } = fakeSpawn(0);
    await runConfigEdit({
      configFilePath: cfgFile,
      spawnFn: spawn,
      env: { EDITOR: 'nano' },
      platform: 'linux',
    });
    expect(calls[0]?.cmd).toContain('nano');
  });

  it('falls back to notepad on Win32 when both unset', async () => {
    const { spawn, calls } = fakeSpawn(0);
    await runConfigEdit({
      configFilePath: cfgFile,
      spawnFn: spawn,
      env: {},
      platform: 'win32',
    });
    expect(calls[0]?.cmd).toContain('notepad');
  });

  it('falls back to vi on POSIX when both unset', async () => {
    const { spawn, calls } = fakeSpawn(0);
    await runConfigEdit({
      configFilePath: cfgFile,
      spawnFn: spawn,
      env: {},
      platform: 'darwin',
    });
    expect(calls[0]?.cmd).toContain('vi');
  });

  it('shell-quotes a Win32 path containing spaces (audit C1)', async () => {
    const { spawn, calls } = fakeSpawn(0);
    const cfgWithSpaces = join(tmp, 'config with spaces.json');
    await runConfigEdit({
      configFilePath: cfgWithSpaces,
      editor: 'notepad',
      spawnFn: spawn,
      env: {},
      platform: 'win32',
    });
    // Win32 quoting: double-quotes around the path so cmd.exe doesn't
    // split on whitespace. Verify the command contains a literal
    // `"<path>"` substring (escaping any embedded quotes).
    expect(calls[0]?.cmd).toContain(`"${cfgWithSpaces}"`);
  });

  it('shell-quotes a POSIX path containing spaces and a single-quote', async () => {
    const { spawn, calls } = fakeSpawn(0);
    const cfgWithSpaces = join(tmp, "config with chris's spaces.json");
    await runConfigEdit({
      configFilePath: cfgWithSpaces,
      editor: 'vim',
      spawnFn: spawn,
      env: {},
      platform: 'linux',
    });
    // POSIX single-quote close/escape/reopen pattern: `'\''`
    expect(calls[0]?.cmd).toContain(
      `'${cfgWithSpaces.replace(/'/g, `'\\''`)}'`,
    );
  });
});
