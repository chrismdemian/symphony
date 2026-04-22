import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerManager } from '../../src/workers/manager.js';
import { encodeCwdForClaudeProjects } from '../../src/workers/session.js';
import type { StreamEvent, Worker } from '../../src/workers/types.js';

// Probe synchronously at module-load so `it.skipIf(...)` sees the correct
// value during test registration. `beforeAll` runs AFTER skipIf evaluates.
const claudeAvailable = detectClaude();

function detectClaude(): boolean {
  try {
    const result = spawnSync('claude', ['--version'], {
      encoding: 'utf8',
      timeout: 5_000,
      shell: false,
    });
    const ok = result.status === 0 && result.stdout.trim().length > 0;
    if (!ok) {
      console.warn(
        `[1b scenario] claude --version probe: status=${result.status} err=${result.error?.message ?? 'none'} stderr=${result.stderr}`,
      );
    }
    return ok;
  } catch (err) {
    console.warn(
      `[1b scenario] claude --version probe threw: ${(err as Error).message}`,
    );
    return false;
  }
}

if (!claudeAvailable) {
  console.warn(
    '[1b scenario] `claude --version` unavailable — real-claude scenario will skip. Install the CLI and re-run locally to exercise Gate 3.',
  );
}

async function drain(worker: Worker): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const ev of worker.events) events.push(ev);
  return events;
}

describe('Phase 1B production scenario — real claude subprocess + session resume', () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'symphony-1b-'));
  });

  afterEach(() => {
    try {
      rmSync(sandbox, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it.skipIf(!claudeAvailable)(
    'spawns, captures session, resumes with --resume, exits completed on both turns',
    async () => {
      const mgr = new WorkerManager();
      try {
        // First worker: fresh session. Use deterministic input so if the
        // test flakes, we can re-resume via the same UUID.
        const first = await mgr.spawn({
          id: 'scenario-1b-first',
          cwd: sandbox,
          deterministicUuidInput: `scenario-1b::${sandbox}`,
          prompt: "Reply with exactly the word 'ok' and nothing else. Do not use any tools.",
          timeoutMs: 60_000,
        });
        const firstEvents = await drain(first);
        const firstExit = await first.waitForExit();

        expect(firstExit.status).toBe('completed');
        expect(firstExit.exitCode).toBe(0);
        expect(firstExit.sessionId).toBeDefined();
        expect(firstExit.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
        expect(firstEvents.some((e) => e.type === 'parse_error')).toBe(false);
        expect(firstEvents.some((e) => e.type === 'system_init')).toBe(true);
        const firstResult = firstEvents.find((e) => e.type === 'result');
        if (firstResult?.type !== 'result') throw new Error('expected result event');
        expect(firstResult.isError).toBe(false);

        const capturedSessionId = firstExit.sessionId!;

        // Confirm Claude wrote the jsonl on disk — this is what
        // validateResumeSession will check before the second spawn.
        const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
        const encoded = encodeCwdForClaudeProjects(sandbox);
        const sessionFile = join(home, '.claude', 'projects', encoded, `${capturedSessionId}.jsonl`);
        expect(existsSync(sessionFile)).toBe(true);

        // Second worker: resume.
        const second = await mgr.spawn({
          id: 'scenario-1b-second',
          cwd: sandbox,
          sessionId: capturedSessionId,
          prompt: "What exact word did I ask you to say in the previous message? Reply with only that word.",
          timeoutMs: 60_000,
        });
        const secondEvents = await drain(second);
        const secondExit = await second.waitForExit();

        expect(secondExit.status).toBe('completed');
        const secondInit = secondEvents.find((e) => e.type === 'system_init');
        if (secondInit?.type !== 'system_init') throw new Error('expected system_init');
        expect(secondInit.sessionId).toBe(capturedSessionId);
        expect(secondEvents.some((e) => e.type === 'parse_error')).toBe(false);
      } finally {
        await mgr.shutdown();
      }
    },
    180_000,
  );
});
