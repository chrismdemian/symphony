import path from 'node:path';
import { describe, it, expect, afterEach, beforeEach } from 'vitest';

import {
  SYMPHONY_VOICE_ENV_DIR_ENV,
  voiceBinDir,
  voiceEnvDir,
  voicePythonPath,
  voicePythonPackageDir,
} from '../../src/voice/path.js';

describe('voiceEnvDir', () => {
  const originalOverride = process.env[SYMPHONY_VOICE_ENV_DIR_ENV];

  afterEach(() => {
    if (originalOverride === undefined) {
      delete process.env[SYMPHONY_VOICE_ENV_DIR_ENV];
    } else {
      process.env[SYMPHONY_VOICE_ENV_DIR_ENV] = originalOverride;
    }
  });

  it('resolves to ~/.symphony/voice-env when no override', () => {
    delete process.env[SYMPHONY_VOICE_ENV_DIR_ENV];
    const home = path.join('/home', 'chris');
    const dir = voiceEnvDir(home);
    expect(dir).toBe(path.join(home, '.symphony', 'voice-env'));
  });

  it('honors SYMPHONY_VOICE_ENV_DIR env override and resolves to absolute', () => {
    process.env[SYMPHONY_VOICE_ENV_DIR_ENV] = '  /tmp/voice  ';
    const dir = voiceEnvDir('/ignored');
    expect(dir).toBe(path.resolve('/tmp/voice'));
  });

  it('treats empty / whitespace override as unset (uses home)', () => {
    process.env[SYMPHONY_VOICE_ENV_DIR_ENV] = '   ';
    const dir = voiceEnvDir('/h');
    expect(dir).toBe(path.join('/h', '.symphony', 'voice-env'));
  });
});

describe('voicePythonPath', () => {
  it('resolves Scripts\\python.exe on win32', () => {
    const p = voicePythonPath('C:\\Users\\chris\\.symphony\\voice-env', 'win32');
    expect(p).toBe(
      path.join('C:\\Users\\chris\\.symphony\\voice-env', 'Scripts', 'python.exe'),
    );
  });

  it('resolves bin/python on POSIX', () => {
    const p = voicePythonPath('/home/chris/.symphony/voice-env', 'linux');
    expect(p).toBe(path.join('/home/chris/.symphony/voice-env', 'bin', 'python'));
  });

  it('uses platform-specific layout for darwin', () => {
    const p = voicePythonPath('/Users/chris/.symphony/voice-env', 'darwin');
    expect(p).toBe(path.join('/Users/chris/.symphony/voice-env', 'bin', 'python'));
  });
});

describe('voiceBinDir', () => {
  it('Scripts on win32, bin on POSIX', () => {
    expect(voiceBinDir('/v', 'win32')).toBe(path.join('/v', 'Scripts'));
    expect(voiceBinDir('/v', 'linux')).toBe(path.join('/v', 'bin'));
  });
});

describe('voicePythonPackageDir', () => {
  // The dev layout (src/voice/python/voice_bridge.py) MUST exist for the
  // bridge to spawn. This test locks that contract — moving the file
  // breaks 6A immediately.
  it('finds voice_bridge.py in the dev or built layout', () => {
    const dir = voicePythonPackageDir();
    expect(dir).toBeTruthy();
    // The directory contains voice_bridge.py — locked by the resolver's
    // own existsSync gate, but assert here as a regression-lock.
    expect(dir).toMatch(/python$/);
  });
});

// Cross-OS sanity — voiceEnvDir's join behavior is deterministic for
// repeated calls with the same input.
describe('voice path idempotency', () => {
  beforeEach(() => {
    delete process.env[SYMPHONY_VOICE_ENV_DIR_ENV];
  });

  it('returns the same string on repeated calls', () => {
    const a = voiceEnvDir('/h');
    const b = voiceEnvDir('/h');
    expect(a).toBe(b);
  });
});
