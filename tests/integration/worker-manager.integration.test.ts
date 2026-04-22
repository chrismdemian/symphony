import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkerManager, type SpawnFn } from '../../src/workers/manager.js';
import type {
  StreamEvent,
  Worker,
  WorkerConfig,
} from '../../src/workers/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fakeInteractive = join(
  __dirname,
  '..',
  'helpers',
  'fake-claude-interactive.mjs',
);

function spawner(scenario: string): SpawnFn {
  return (_command: string, _args: readonly string[], options): ChildProcess => {
    return nodeSpawn(process.execPath, [fakeInteractive, scenario], options);
  };
}

async function collect(worker: Worker): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const ev of worker.events) events.push(ev);
  return events;
}

let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'symphony-worker-int-'));
});

afterEach(() => {
  try {
    rmSync(sandbox, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

function cfg(id: string, over: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    id,
    cwd: sandbox,
    prompt: 'please run the scenario',
    ...over,
  };
}

describe('WorkerManager — happy path', () => {
  it('drives a single-turn conversation to completed', async () => {
    const mgr = new WorkerManager({
      claudeConfigPath: join(sandbox, '.claude.json'),
      claudeHome: sandbox,
      spawn: spawner('happy-path'),
    });
    try {
      const worker = await mgr.spawn(cfg('w-happy'));
      const eventPromise = collect(worker);
      const exit = await worker.waitForExit();
      const events = await eventPromise;

      expect(exit.status).toBe('completed');
      expect(exit.exitCode).toBe(0);
      expect(exit.sessionId).toBe('00000000-0000-4000-8000-000000000001');
      expect(events.map((e) => e.type)).toEqual([
        'system_init',
        'assistant_text',
        'result',
      ]);
      expect(events.some((e) => e.type === 'parse_error')).toBe(false);
      expect(worker.sessionId).toBe('00000000-0000-4000-8000-000000000001');
    } finally {
      await mgr.shutdown();
    }
  });
});

describe('WorkerManager — control_request auto-ack', () => {
  it('writes control_response to stdin so the scenario can continue', async () => {
    const mgr = new WorkerManager({
      claudeConfigPath: join(sandbox, '.claude.json'),
      claudeHome: sandbox,
      spawn: spawner('control-request'),
    });
    try {
      const worker = await mgr.spawn(cfg('w-ctrl'));
      const eventPromise = collect(worker);
      const exit = await worker.waitForExit();
      const events = await eventPromise;

      expect(exit.status).toBe('completed');
      const ctrl = events.find((e) => e.type === 'control_request');
      expect(ctrl?.type).toBe('control_request');
      // Assistant turn and result only arrive if fake-claude received
      // the correct control_response — the scenario waits for it.
      expect(events.some((e) => e.type === 'assistant_text')).toBe(true);
      expect(events.some((e) => e.type === 'result')).toBe(true);
    } finally {
      await mgr.shutdown();
    }
  });
});

describe('WorkerManager — follow-up messages', () => {
  it('sends a second user turn via sendFollowup()', async () => {
    const mgr = new WorkerManager({
      claudeConfigPath: join(sandbox, '.claude.json'),
      claudeHome: sandbox,
      spawn: spawner('two-turn'),
    });
    try {
      const worker = await mgr.spawn(cfg('w-2turn', { keepStdinOpen: true }));
      const received: StreamEvent[] = [];
      const consumer = (async () => {
        for await (const ev of worker.events) {
          received.push(ev);
          if (
            received.filter((e) => e.type === 'assistant_text').length === 1 &&
            !received.some((e) => e.type === 'result')
          ) {
            worker.sendFollowup('second prompt please');
          }
        }
      })();
      await consumer;
      const exit = await worker.waitForExit();
      expect(exit.status).toBe('completed');
      const textEvents = received.filter((e) => e.type === 'assistant_text');
      expect(textEvents.map((e) => e.text)).toEqual(['first turn', 'second turn']);
    } finally {
      await mgr.shutdown();
    }
  });

  it('sendFollowup throws when worker not running', async () => {
    const mgr = new WorkerManager({
      claudeConfigPath: join(sandbox, '.claude.json'),
      claudeHome: sandbox,
      spawn: spawner('happy-path'),
    });
    try {
      const worker = await mgr.spawn(cfg('w-done'));
      // Drain events so the worker completes
      for await (const _ of worker.events) void _;
      await worker.waitForExit();
      expect(() => worker.sendFollowup('too late')).toThrow(/cannot send follow-up/);
    } finally {
      await mgr.shutdown();
    }
  });
});

describe('WorkerManager — timeout + kill', () => {
  it('kills and reports timeout when the process hangs past timeoutMs', async () => {
    const mgr = new WorkerManager({
      claudeConfigPath: join(sandbox, '.claude.json'),
      claudeHome: sandbox,
      spawn: spawner('hang'),
    });
    try {
      const worker = await mgr.spawn(cfg('w-timeout', { timeoutMs: 250 }));
      const exit = await worker.waitForExit();
      expect(exit.status).toBe('timeout');
    } finally {
      await mgr.shutdown();
    }
  }, 15_000);

  it('explicit kill() produces status=killed', async () => {
    const mgr = new WorkerManager({
      claudeConfigPath: join(sandbox, '.claude.json'),
      claudeHome: sandbox,
      spawn: spawner('hang'),
    });
    try {
      const worker = await mgr.spawn(cfg('w-kill'));
      setTimeout(() => worker.kill(), 100);
      const exit = await worker.waitForExit();
      expect(exit.status).toBe('killed');
    } finally {
      await mgr.shutdown();
    }
  }, 15_000);

  it('AbortSignal cancellation produces status=killed', async () => {
    const mgr = new WorkerManager({
      claudeConfigPath: join(sandbox, '.claude.json'),
      claudeHome: sandbox,
      spawn: spawner('hang'),
    });
    const ac = new AbortController();
    try {
      const worker = await mgr.spawn(cfg('w-abort', { signal: ac.signal }));
      setTimeout(() => ac.abort(), 80);
      const exit = await worker.waitForExit();
      expect(exit.status).toBe('killed');
    } finally {
      await mgr.shutdown();
    }
  }, 15_000);
});
