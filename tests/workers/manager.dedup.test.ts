import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkerManager, type SpawnFn } from '../../src/workers/manager.js';
import type { WorkerConfig } from '../../src/workers/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fakeClaude = join(__dirname, '..', 'helpers', 'fake-claude.mjs');

function makeFakeSpawner(fixture: string): SpawnFn {
  return (_command: string, _args: readonly string[], options): ChildProcess => {
    return nodeSpawn(process.execPath, [fakeClaude, fixture], {
      ...options,
      // Wipe the Symphony-built arg list and substitute our own. This is
      // exactly what the injectable spawner exists for.
    });
  };
}

let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'symphony-manager-'));
});

afterEach(() => {
  try {
    rmSync(sandbox, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

function baseConfig(id: string): WorkerConfig {
  return {
    id,
    cwd: sandbox,
    prompt: 'hi',
  };
}

describe('WorkerManager — inflight dedup', () => {
  it('returns the same Worker for concurrent spawns with identical id+cwd', async () => {
    const mgr = new WorkerManager({
      claudeConfigPath: join(sandbox, '.claude.json'),
      claudeHome: sandbox,
      spawn: makeFakeSpawner('structured-completion'),
    });
    try {
      const cfg = baseConfig('worker-a');
      const [a, b] = await Promise.all([mgr.spawn(cfg), mgr.spawn(cfg)]);
      expect(a).toBe(b);
      await a.waitForExit();
    } finally {
      await mgr.shutdown();
    }
  });

  it('allows concurrent spawns for different worker ids', async () => {
    const mgr = new WorkerManager({
      claudeConfigPath: join(sandbox, '.claude.json'),
      claudeHome: sandbox,
      spawn: makeFakeSpawner('happy-path'),
    });
    try {
      const [a, b] = await Promise.all([
        mgr.spawn(baseConfig('w1')),
        mgr.spawn(baseConfig('w2')),
      ]);
      expect(a).not.toBe(b);
      expect(a.id).toBe('w1');
      expect(b.id).toBe('w2');
      await Promise.all([a.waitForExit(), b.waitForExit()]);
    } finally {
      await mgr.shutdown();
    }
  });

  it('releases inflight entry once the worker exits', async () => {
    const mgr = new WorkerManager({
      claudeConfigPath: join(sandbox, '.claude.json'),
      claudeHome: sandbox,
      spawn: makeFakeSpawner('happy-path'),
    });
    try {
      const first = await mgr.spawn(baseConfig('reusable'));
      await first.waitForExit();
      const second = await mgr.spawn(baseConfig('reusable'));
      expect(second).not.toBe(first);
      await second.waitForExit();
    } finally {
      await mgr.shutdown();
    }
  });

  it('shutdown rejects subsequent spawns', async () => {
    const mgr = new WorkerManager({
      claudeConfigPath: join(sandbox, '.claude.json'),
      claudeHome: sandbox,
      spawn: makeFakeSpawner('happy-path'),
    });
    await mgr.shutdown();
    await expect(mgr.spawn(baseConfig('late'))).rejects.toThrow(/shut down/);
  });
});
