import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkerManager, type SpawnFn } from '../../src/workers/manager.js';
import { encodeCwdForClaudeProjects } from '../../src/workers/session.js';
import type { WorkerConfig } from '../../src/workers/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fakeInteractive = join(
  __dirname,
  '..',
  'helpers',
  'fake-claude-interactive.mjs',
);

function spawner(scenario: string): SpawnFn {
  return (_command: string, _args: readonly string[], options): ChildProcess =>
    nodeSpawn(process.execPath, [fakeInteractive, scenario], options);
}

let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'symphony-session-mgr-'));
});

afterEach(() => {
  try {
    rmSync(sandbox, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

function seedSessionFile(home: string, cwd: string, uuid: string): void {
  const encoded = encodeCwdForClaudeProjects(cwd);
  const dir = join(home, '.claude', 'projects', encoded);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${uuid}.jsonl`), '', 'utf8');
}

function cfg(id: string, over: Partial<WorkerConfig> = {}): WorkerConfig {
  return { id, cwd: sandbox, prompt: 'hi', ...over };
}

describe('WorkerManager — explicit sessionId validation', () => {
  it("rejects by default when sessionId's jsonl is missing", async () => {
    const mgr = new WorkerManager({
      claudeConfigPath: join(sandbox, '.claude.json'),
      claudeHome: sandbox,
      spawn: spawner('happy-path'),
    });
    try {
      await expect(
        mgr.spawn(cfg('w-stale', { sessionId: '00000000-0000-4000-8000-000000000099' })),
      ).rejects.toThrow(/requested resume session/);
    } finally {
      await mgr.shutdown();
    }
  });

  it('accepts resume when jsonl exists under the correct cwd', async () => {
    const validUuid = '00000000-0000-4000-8000-000000000042';
    seedSessionFile(sandbox, sandbox, validUuid);
    const mgr = new WorkerManager({
      claudeConfigPath: join(sandbox, '.claude.json'),
      claudeHome: sandbox,
      spawn: spawner('happy-path'),
    });
    try {
      const worker = await mgr.spawn(cfg('w-resume', { sessionId: validUuid }));
      await worker.waitForExit();
    } finally {
      await mgr.shutdown();
    }
  });

  it('onStaleResume="warn-and-fresh" fires hook and starts fresh', async () => {
    const hits: Array<{ id: string; reason: string }> = [];
    const mgr = new WorkerManager({
      claudeConfigPath: join(sandbox, '.claude.json'),
      claudeHome: sandbox,
      onStaleResume: (id, reason) => hits.push({ id, reason }),
      spawn: spawner('happy-path'),
    });
    try {
      const worker = await mgr.spawn(
        cfg('w-warn', {
          sessionId: '00000000-0000-4000-8000-000000000000',
          onStaleResume: 'warn-and-fresh',
        }),
      );
      await worker.waitForExit();
      expect(hits).toHaveLength(1);
      expect(hits[0]?.id).toBe('w-warn');
      expect(hits[0]?.reason).toBe('missing');
    } finally {
      await mgr.shutdown();
    }
  });

  it('onStaleResume="start-fresh" silently starts fresh and does NOT fire hook', async () => {
    const hits: Array<{ id: string }> = [];
    const mgr = new WorkerManager({
      claudeConfigPath: join(sandbox, '.claude.json'),
      claudeHome: sandbox,
      onStaleResume: (id) => hits.push({ id }),
      spawn: spawner('happy-path'),
    });
    try {
      const worker = await mgr.spawn(
        cfg('w-silent', {
          sessionId: '00000000-0000-4000-8000-000000000000',
          onStaleResume: 'start-fresh',
        }),
      );
      await worker.waitForExit();
      expect(hits).toHaveLength(0);
    } finally {
      await mgr.shutdown();
    }
  });

  it('no sessionId → fresh deterministic session, no rejection', async () => {
    const mgr = new WorkerManager({
      claudeConfigPath: join(sandbox, '.claude.json'),
      claudeHome: sandbox,
      spawn: spawner('happy-path'),
    });
    try {
      const worker = await mgr.spawn(cfg('w-fresh'));
      await worker.waitForExit();
    } finally {
      await mgr.shutdown();
    }
  });
});

describe('WorkerManager — trust failures', () => {
  it('throws by default when ensureClaudeTrust fails', async () => {
    const mgr = new WorkerManager({
      // Point at a file path that's actually a directory → write fails
      claudeConfigPath: sandbox,
      claudeHome: sandbox,
      spawn: spawner('happy-path'),
    });
    try {
      await expect(mgr.spawn(cfg('w-trust-fail'))).rejects.toThrow(
        /ensureClaudeTrust failed/,
      );
    } finally {
      await mgr.shutdown();
    }
  });

  it('onTrustFailure hook lets the caller opt into spawn-anyway', async () => {
    const errors: Array<{ id: string; message: string }> = [];
    const mgr = new WorkerManager({
      claudeConfigPath: sandbox,
      claudeHome: sandbox,
      onTrustFailure: (id, err) => errors.push({ id, message: err.message }),
      spawn: spawner('happy-path'),
    });
    try {
      const worker = await mgr.spawn(cfg('w-trust-hook'));
      await worker.waitForExit();
      expect(errors).toHaveLength(1);
      expect(errors[0]?.id).toBe('w-trust-hook');
    } finally {
      await mgr.shutdown();
    }
  });
});
