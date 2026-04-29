import { describe, it, expect } from 'vitest';
import {
  buildWorkerEnv,
  getWindowsEssentialEnv,
  isExtraEnvBlocked,
  ENV_ALLOWLIST,
} from '../../src/workers/env.js';

describe('buildWorkerEnv — allowlist', () => {
  it('passes through present allowlist keys', () => {
    const { env } = buildWorkerEnv({
      sourceEnv: { ANTHROPIC_API_KEY: 'sk-test', HOME: '/home/x' },
      platform: 'linux',
    });
    expect(env.ANTHROPIC_API_KEY).toBe('sk-test');
    expect(env.HOME).toBe('/home/x');
  });

  it('skips allowlist keys that are missing or empty strings', () => {
    const { env } = buildWorkerEnv({
      sourceEnv: { ANTHROPIC_API_KEY: '', HOME: '/home/x' },
      platform: 'linux',
    });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.HOME).toBe('/home/x');
  });

  it('drops non-UTF-8 locale values and falls back to C.UTF-8', () => {
    const { env } = buildWorkerEnv({
      sourceEnv: { LANG: 'en_US.ISO8859-1', LC_ALL: 'C', HOME: '/h' },
      platform: 'linux',
    });
    // Non-UTF-8 source values must not pass through verbatim
    expect(env.LANG).not.toBe('en_US.ISO8859-1');
    expect(env.LC_ALL).toBeUndefined();
    // Fallback ensures a UTF-8 locale is always present on non-Windows
    expect(env.LANG).toBe('C.UTF-8');
    expect(env.LC_CTYPE).toBe('C.UTF-8');
  });

  it('keeps UTF-8 locale values verbatim', () => {
    const { env } = buildWorkerEnv({
      sourceEnv: { LANG: 'en_US.UTF-8', HOME: '/h', PATH: '/usr/bin' },
      platform: 'linux',
    });
    expect(env.LANG).toBe('en_US.UTF-8');
  });

  it('falls back to C.UTF-8 on linux if no locale present', () => {
    const { env } = buildWorkerEnv({
      sourceEnv: { HOME: '/h', PATH: '/usr/bin' },
      platform: 'linux',
    });
    expect(env.LANG).toBe('C.UTF-8');
    expect(env.LC_CTYPE).toBe('C.UTF-8');
  });

  it('includes every documented allowlist key when set', () => {
    const localeKeys = new Set(['LANG', 'LC_ALL', 'LC_CTYPE']);
    const fullSource: NodeJS.ProcessEnv = {};
    for (const key of ENV_ALLOWLIST) {
      fullSource[key] = localeKeys.has(key) ? 'en_US.UTF-8' : `value-of-${key}`;
    }
    const { env } = buildWorkerEnv({ sourceEnv: fullSource, platform: 'linux' });
    for (const key of ENV_ALLOWLIST) {
      expect(env[key]).toBe(fullSource[key]);
    }
  });
});

describe('buildWorkerEnv — platform paths', () => {
  it('passes PATH unconditionally on non-Windows', () => {
    const { env } = buildWorkerEnv({
      sourceEnv: { PATH: '/usr/bin:/usr/local/bin' },
      platform: 'linux',
    });
    expect(env.PATH).toBe('/usr/bin:/usr/local/bin');
  });

  it('merges Windows essentials when platform is win32', () => {
    const { env } = buildWorkerEnv({
      sourceEnv: {
        PATH: 'C:\\Windows',
        PATHEXT: '.EXE;.CMD',
        SystemRoot: 'C:\\Windows',
        ComSpec: 'C:\\Windows\\System32\\cmd.exe',
        USERPROFILE: 'C:\\Users\\chris',
      },
      platform: 'win32',
    });
    expect(env.PATH).toBe('C:\\Windows');
    expect(env.PATHEXT).toBe('.EXE;.CMD');
    expect(env.SystemRoot).toBe('C:\\Windows');
    expect(env.ComSpec).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(env.USERPROFILE).toBe('C:\\Users\\chris');
  });

  it('uses Windows fallback defaults when source is sparse', () => {
    const { env } = buildWorkerEnv({
      sourceEnv: { PATH: '' },
      platform: 'win32',
    });
    expect(env.SystemRoot).toBe('C:\\Windows');
    expect(env.ComSpec).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(env.PATHEXT).toContain('.EXE');
  });
});

describe('buildWorkerEnv — extraEnv + blocklist', () => {
  it('merges extraEnv after allowlist', () => {
    const { env } = buildWorkerEnv({
      sourceEnv: { ANTHROPIC_API_KEY: 'sk-x' },
      extraEnv: { MY_APP_FLAG: 'true' },
      platform: 'linux',
    });
    expect(env.MY_APP_FLAG).toBe('true');
    expect(env.ANTHROPIC_API_KEY).toBe('sk-x');
  });

  it('rejects blocklisted extraEnv keys and calls onBlocklistHit', () => {
    const hits: string[] = [];
    const { env, blockedKeys } = buildWorkerEnv({
      sourceEnv: { HOME: '/home/real' },
      extraEnv: { HOME: '/tmp/fake', PATH: '/evil', KEEP: 'yes' },
      platform: 'linux',
      onBlocklistHit: (k) => hits.push(k),
    });
    expect(env.HOME).toBe('/home/real');
    expect(env.PATH).toBeUndefined();
    expect(env.KEEP).toBe('yes');
    expect(blockedKeys.sort()).toEqual(['HOME', 'PATH'].sort());
    expect(hits.sort()).toEqual(['HOME', 'PATH'].sort());
  });

  it('blocks CLAUDECODE*/CLAUDE_CODE_*/SYMPHONY_* prefixes in extraEnv', () => {
    const { env, blockedKeys } = buildWorkerEnv({
      sourceEnv: {},
      extraEnv: {
        CLAUDECODE: '1',
        CLAUDE_CODE_ENTRYPOINT: 'cli',
        SYMPHONY_WORKER_ID: 'abc',
        OK_KEY: 'yes',
      },
      platform: 'linux',
    });
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(env.SYMPHONY_WORKER_ID).toBeUndefined();
    expect(env.OK_KEY).toBe('yes');
    expect(blockedKeys).toEqual(
      expect.arrayContaining(['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'SYMPHONY_WORKER_ID']),
    );
  });
});

describe('buildWorkerEnv — allowExtraEnvKeys carve-out (Maestro Stop hook)', () => {
  it('exempts exact-match keys from the prefix blocklist', () => {
    const hits: string[] = [];
    const { env, blockedKeys } = buildWorkerEnv({
      sourceEnv: {},
      extraEnv: {
        SYMPHONY_HOOK_PORT: '54321',
        SYMPHONY_HOOK_TOKEN: 'tok-abc',
        SYMPHONY_DB_FILE: '/some/path.db',
      },
      allowExtraEnvKeys: ['SYMPHONY_HOOK_PORT', 'SYMPHONY_HOOK_TOKEN'],
      platform: 'linux',
      onBlocklistHit: (k) => hits.push(k),
    });
    expect(env.SYMPHONY_HOOK_PORT).toBe('54321');
    expect(env.SYMPHONY_HOOK_TOKEN).toBe('tok-abc');
    expect(env.SYMPHONY_DB_FILE).toBeUndefined();
    expect(blockedKeys).toEqual(['SYMPHONY_DB_FILE']);
    expect(hits).toEqual(['SYMPHONY_DB_FILE']);
  });

  it('default (no allowExtraEnvKeys) preserves the existing posture', () => {
    const { env, blockedKeys } = buildWorkerEnv({
      sourceEnv: {},
      extraEnv: { SYMPHONY_HOOK_PORT: '1', SYMPHONY_FOO: '2' },
      platform: 'linux',
    });
    expect(env.SYMPHONY_HOOK_PORT).toBeUndefined();
    expect(env.SYMPHONY_FOO).toBeUndefined();
    expect(blockedKeys.sort()).toEqual(['SYMPHONY_FOO', 'SYMPHONY_HOOK_PORT']);
  });

  it('does not exempt non-listed prefixed keys even when allowlist non-empty', () => {
    const { env, blockedKeys } = buildWorkerEnv({
      sourceEnv: {},
      extraEnv: { SYMPHONY_HOOK_PORT: '1', CLAUDECODE_X: '2' },
      allowExtraEnvKeys: ['SYMPHONY_HOOK_PORT'],
      platform: 'linux',
    });
    expect(env.SYMPHONY_HOOK_PORT).toBe('1');
    expect(env.CLAUDECODE_X).toBeUndefined();
    expect(blockedKeys).toEqual(['CLAUDECODE_X']);
  });
});

describe('buildWorkerEnv — CLAUDECODE pollution scrub', () => {
  it('strips CLAUDECODE and CLAUDE_CODE_* keys even if they sneak through', () => {
    // Simulate parent Claude Code session leaking CLAUDECODE=1 — must not
    // reach the spawned child.
    const { env } = buildWorkerEnv({
      sourceEnv: {
        HOME: '/home/x',
        CLAUDECODE: '1',
        CLAUDE_CODE_ENTRYPOINT: 'cli',
      },
      platform: 'linux',
    });
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(env.HOME).toBe('/home/x');
  });
});

describe('isExtraEnvBlocked', () => {
  it.each(['HOME', 'PATH', 'USER', 'SHELL', 'TERM'])('blocks exact key %s', (key) => {
    expect(isExtraEnvBlocked(key)).toBe(true);
  });

  it('blocks prefix matches', () => {
    expect(isExtraEnvBlocked('CLAUDECODE_FOO')).toBe(true);
    expect(isExtraEnvBlocked('CLAUDE_CODE_ANYTHING')).toBe(true);
    expect(isExtraEnvBlocked('SYMPHONY_X')).toBe(true);
  });

  it('allows unrelated keys', () => {
    expect(isExtraEnvBlocked('ANTHROPIC_API_KEY')).toBe(false);
    expect(isExtraEnvBlocked('FOO')).toBe(false);
    expect(isExtraEnvBlocked('XDG_CONFIG_HOME')).toBe(false);
  });
});

describe('getWindowsEssentialEnv', () => {
  it('always contains the core Windows keys', () => {
    const env = getWindowsEssentialEnv({ PATH: '', USERNAME: 'chris' });
    expect(env.SystemRoot).toBeDefined();
    expect(env.ComSpec).toBeDefined();
    expect(env.PATHEXT).toBeDefined();
    expect(env.USERNAME).toBe('chris');
  });

  it('strips empty optional keys', () => {
    const env = getWindowsEssentialEnv({ PATH: '', USERNAME: 'u' });
    expect(env.TEMP).toBeUndefined();
    expect(env.APPDATA).toBeUndefined();
  });
});
