import path from 'node:path';
import { describe, it, expect } from 'vitest';

import {
  VOICE_ENV_ALLOWLIST,
  buildVoiceEnv,
  resolveVoiceEnv,
} from '../../src/voice/env.js';

describe('buildVoiceEnv — allowlist', () => {
  it('passes through allowlisted keys, drops others', () => {
    const { env, droppedKeys } = buildVoiceEnv({
      sourceEnv: {
        HOME: '/home/chris',
        LANG: 'en_US.UTF-8',
        ANTHROPIC_API_KEY: 'sk-leak',
        GH_TOKEN: 'gh-leak',
        AWS_ACCESS_KEY_ID: 'aws-leak',
        SYMPHONY_DB_FILE: '/tmp/db',
      },
      platform: 'linux',
      venvDir: '/v',
      homeDir: '/home/chris',
    });
    expect(env.HOME).toBe('/home/chris');
    expect(env.LANG).toBe('en_US.UTF-8');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(env.SYMPHONY_DB_FILE).toBeUndefined();
    expect(droppedKeys).toContain('ANTHROPIC_API_KEY');
    expect(droppedKeys).toContain('GH_TOKEN');
    expect(droppedKeys).toContain('AWS_ACCESS_KEY_ID');
    expect(droppedKeys).toContain('SYMPHONY_DB_FILE');
  });

  it('drops non-UTF-8 locale values and falls back to C.UTF-8 on POSIX', () => {
    const { env, droppedKeys } = buildVoiceEnv({
      sourceEnv: { LANG: 'en_US.ISO8859-1', LC_ALL: 'C', HOME: '/h' },
      platform: 'linux',
      venvDir: '/v',
      homeDir: '/h',
    });
    // The ORIGINAL non-UTF-8 values were dropped from the allowlist walk.
    expect(droppedKeys).toContain('LANG');
    expect(droppedKeys).toContain('LC_ALL');
    // POSIX fallback fills in C.UTF-8 so child stdout decode is sane.
    expect(env.LANG).toBe('C.UTF-8');
    expect(env.LC_CTYPE).toBe('C.UTF-8');
    expect(env.LC_ALL).toBeUndefined();
  });

  it('keeps a UTF-8 locale value as-is', () => {
    const { env, droppedKeys } = buildVoiceEnv({
      sourceEnv: { LANG: 'en_US.UTF-8', HOME: '/h' },
      platform: 'linux',
      venvDir: '/v',
      homeDir: '/h',
    });
    expect(env.LANG).toBe('en_US.UTF-8');
    expect(droppedKeys).not.toContain('LANG');
  });

  it('honors proxy env (network egress for model download)', () => {
    const { env } = buildVoiceEnv({
      sourceEnv: { HTTP_PROXY: 'http://proxy:3128', HTTPS_PROXY: 'http://proxy:3128' },
      platform: 'linux',
      venvDir: '/v',
      homeDir: '/h',
    });
    expect(env.HTTP_PROXY).toBe('http://proxy:3128');
    expect(env.HTTPS_PROXY).toBe('http://proxy:3128');
  });
});

describe('buildVoiceEnv — venv activation', () => {
  it('sets VIRTUAL_ENV and prefixes PATH with venv bin (POSIX)', () => {
    const { env } = buildVoiceEnv({
      sourceEnv: { PATH: '/usr/bin:/bin', HOME: '/h' },
      platform: 'linux',
      venvDir: '/home/chris/.symphony/voice-env',
      homeDir: '/h',
    });
    expect(env.VIRTUAL_ENV).toBe('/home/chris/.symphony/voice-env');
    expect(env.PATH).toBe(
      `${path.join('/home/chris/.symphony/voice-env', 'bin')}:/usr/bin:/bin`,
    );
  });

  it('sets VIRTUAL_ENV and prefixes PATH with venv Scripts (Win32)', () => {
    const { env } = buildVoiceEnv({
      sourceEnv: { PATH: 'C:\\Windows;C:\\Windows\\System32', HOME: 'C:\\Users\\chris' },
      platform: 'win32',
      venvDir: 'C:\\Users\\chris\\.symphony\\voice-env',
      homeDir: 'C:\\Users\\chris',
    });
    expect(env.VIRTUAL_ENV).toBe('C:\\Users\\chris\\.symphony\\voice-env');
    expect(env.PATH).toBe(
      `${path.join('C:\\Users\\chris\\.symphony\\voice-env', 'Scripts')};C:\\Windows;C:\\Windows\\System32`,
    );
  });

  it('falls back to a sane default PATH on POSIX when source PATH is empty', () => {
    const { env } = buildVoiceEnv({
      sourceEnv: {},
      platform: 'linux',
      venvDir: '/v',
      homeDir: '/h',
    });
    expect(env.PATH).toContain(path.join('/v', 'bin'));
    expect(env.PATH).toContain('/usr/bin');
  });
});

describe('buildVoiceEnv — Python-specific defaults', () => {
  it('sets PYTHONUNBUFFERED=1 so JSON events flush per line', () => {
    const { env } = buildVoiceEnv({
      sourceEnv: {},
      platform: 'linux',
      venvDir: '/v',
      homeDir: '/h',
    });
    expect(env.PYTHONUNBUFFERED).toBe('1');
  });

  it('sets PYTHONIOENCODING=utf-8', () => {
    const { env } = buildVoiceEnv({
      sourceEnv: {},
      platform: 'linux',
      venvDir: '/v',
      homeDir: '/h',
    });
    expect(env.PYTHONIOENCODING).toBe('utf-8');
  });
});

describe('buildVoiceEnv — Win32 essentials', () => {
  it('populates SystemRoot, ComSpec, PATHEXT with defaults when absent', () => {
    const { env } = buildVoiceEnv({
      sourceEnv: { PATH: 'C:\\Windows' },
      platform: 'win32',
      venvDir: 'C:\\v',
      homeDir: 'C:\\Users\\chris',
    });
    expect(env.SystemRoot).toBe('C:\\Windows');
    expect(env.ComSpec).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(env.PATHEXT).toMatch(/EXE/);
    expect(env.USERPROFILE).toBe('C:\\Users\\chris');
  });
});

describe('VOICE_ENV_ALLOWLIST contents', () => {
  it('does NOT include Anthropic or cloud-tool keys', () => {
    expect(VOICE_ENV_ALLOWLIST).not.toContain('ANTHROPIC_API_KEY');
    expect(VOICE_ENV_ALLOWLIST).not.toContain('GH_TOKEN');
    expect(VOICE_ENV_ALLOWLIST).not.toContain('GITHUB_TOKEN');
    expect(VOICE_ENV_ALLOWLIST).not.toContain('AWS_ACCESS_KEY_ID');
  });

  it('includes the network-egress keys needed for Silero model download', () => {
    expect(VOICE_ENV_ALLOWLIST).toContain('HTTP_PROXY');
    expect(VOICE_ENV_ALLOWLIST).toContain('HTTPS_PROXY');
    expect(VOICE_ENV_ALLOWLIST).toContain('NO_PROXY');
    expect(VOICE_ENV_ALLOWLIST).toContain('HF_HOME');
  });
});

describe('resolveVoiceEnv', () => {
  it('returns exists=false when venv is missing', () => {
    // Use a path guaranteed not to exist
    const summary = resolveVoiceEnv('/this/path/does/not/exist/anywhere');
    expect(summary.exists).toBe(false);
    expect(summary.venvDir).toContain('voice-env');
    expect(summary.pythonPath).toContain('python');
  });
});
