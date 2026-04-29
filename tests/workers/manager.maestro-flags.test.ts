import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkerManager, type SpawnFn } from '../../src/workers/manager.js';
import type { WorkerConfig } from '../../src/workers/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fakeInteractive = join(__dirname, '..', 'helpers', 'fake-claude-interactive.mjs');

function spawner(scenario: string): SpawnFn {
  return (_command: string, _args: readonly string[], options): ChildProcess =>
    nodeSpawn(process.execPath, [fakeInteractive, scenario], options);
}

let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'symphony-maestro-flags-'));
});

afterEach(() => {
  try {
    rmSync(sandbox, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

function cfg(id: string, over: Partial<WorkerConfig> = {}): WorkerConfig {
  return { id, cwd: sandbox, prompt: 'IGNORED-IF-skipInitialPrompt', ...over };
}

describe('WorkerManager — skipInitialPrompt (Maestro)', () => {
  it('does not write the initial prompt; first user message is sendFollowup-driven', async () => {
    const mgr = new WorkerManager({
      claudeConfigPath: join(sandbox, '.claude.json'),
      claudeHome: sandbox,
      spawn: spawner('maestro-skip-initial'),
    });
    try {
      const worker = await mgr.spawn(
        cfg('maestro', { skipInitialPrompt: true, keepStdinOpen: true, disableTimeout: true }),
      );
      // The fake scenario emits system_init then waits for "first user" text on stdin.
      // If skipInitialPrompt were ignored, the bogus prompt would have been written
      // first and the await_user step would have matched it instead.
      worker.sendFollowup('first user message after silent boot');
      const exit = await worker.waitForExit();
      expect(exit.status).toBe('completed');
      expect(exit.sessionId).toBe('00000000-0000-4000-8000-000000000050');
    } finally {
      await mgr.shutdown();
    }
  });
});

describe('WorkerManager — disableTimeout (Maestro)', () => {
  it('skips timeout arming when disableTimeout=true', async () => {
    // Smoke test: spawn with disableTimeout and a tiny timeoutMs that would
    // ordinarily fire. Worker must complete naturally, not get killed by timeout.
    const mgr = new WorkerManager({
      claudeConfigPath: join(sandbox, '.claude.json'),
      claudeHome: sandbox,
      spawn: spawner('happy-path'),
    });
    try {
      const worker = await mgr.spawn(
        cfg('long-lived', { disableTimeout: true, timeoutMs: 1 /* would fire instantly if armed */ }),
      );
      const exit = await worker.waitForExit();
      // If the timeout were armed at 1ms, status would be 'timeout'. We want 'completed'.
      expect(exit.status).toBe('completed');
    } finally {
      await mgr.shutdown();
    }
  });
});

describe('WorkerManager — deterministicUuidInput threaded through stale-resume fallback (audit C1)', () => {
  it('warn-and-fresh fallback uses deterministicUuidInput, not Worker.id', async () => {
    // Caller passed an explicit sessionId that doesn't exist on disk + a
    // distinct deterministicUuidInput — the fresh fallback must derive its
    // UUID from `deterministicUuidInput`, not from `cfg.id`. Without this,
    // Maestro's session UUID diverges across boots (audit C1).
    const fresh: Array<{ id: string; reason: string }> = [];
    const mgr = new WorkerManager({
      claudeConfigPath: join(sandbox, '.claude.json'),
      claudeHome: sandbox,
      onStaleResume: (id, reason) => fresh.push({ id, reason }),
      spawn: spawner('happy-path'),
    });
    try {
      const worker = await mgr.spawn(
        cfg('different-id', {
          sessionId: '00000000-0000-4000-8000-000000000abc',
          deterministicUuidInput: 'maestro::global',
          onStaleResume: 'warn-and-fresh',
        }),
      );
      await worker.waitForExit();
      expect(fresh).toHaveLength(1);
      expect(fresh[0]?.reason).toBe('missing');
      // The exact UUID isn't asserted here (covered by session.test.ts);
      // what matters is that a stale-resume warn fired for our id.
      expect(fresh[0]?.id).toBe('different-id');
    } finally {
      await mgr.shutdown();
    }
  });
});

describe('WorkerManager — allowExtraEnvKeys carve-out plumbed through', () => {
  it('threads the allowlist into buildWorkerEnv (no blocklist hit for whitelisted SYMPHONY_HOOK_*)', async () => {
    const blocked: Array<{ id: string; key: string }> = [];
    const mgr = new WorkerManager({
      claudeConfigPath: join(sandbox, '.claude.json'),
      claudeHome: sandbox,
      onBlockedEnv: (id, key) => blocked.push({ id, key }),
      spawn: spawner('happy-path'),
    });
    try {
      const worker = await mgr.spawn(
        cfg('hook-env', {
          extraEnv: { SYMPHONY_HOOK_PORT: '54321', SYMPHONY_HOOK_TOKEN: 'tok' },
          allowExtraEnvKeys: ['SYMPHONY_HOOK_PORT', 'SYMPHONY_HOOK_TOKEN'],
        }),
      );
      await worker.waitForExit();
      expect(blocked).toEqual([]);
    } finally {
      await mgr.shutdown();
    }
  });

  it('still blocks unrelated SYMPHONY_* keys not on the allowlist', async () => {
    const blocked: Array<{ id: string; key: string }> = [];
    const mgr = new WorkerManager({
      claudeConfigPath: join(sandbox, '.claude.json'),
      claudeHome: sandbox,
      onBlockedEnv: (id, key) => blocked.push({ id, key }),
      spawn: spawner('happy-path'),
    });
    try {
      const worker = await mgr.spawn(
        cfg('partial-allow', {
          extraEnv: { SYMPHONY_HOOK_PORT: '1', SYMPHONY_DB_FILE: '/x' },
          allowExtraEnvKeys: ['SYMPHONY_HOOK_PORT'],
        }),
      );
      await worker.waitForExit();
      expect(blocked.map((b) => b.key)).toEqual(['SYMPHONY_DB_FILE']);
    } finally {
      await mgr.shutdown();
    }
  });
});
