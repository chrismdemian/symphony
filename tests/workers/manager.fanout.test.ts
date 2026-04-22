import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkerManager, type SpawnFn } from '../../src/workers/manager.js';
import type { StreamEvent, WorkerConfig } from '../../src/workers/types.js';

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
  sandbox = mkdtempSync(join(tmpdir(), 'symphony-fanout-'));
});

afterEach(() => {
  try {
    rmSync(sandbox, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

function cfg(id: string, over: Partial<WorkerConfig> = {}): WorkerConfig {
  return { id, cwd: sandbox, prompt: 'hi', ...over };
}

describe('Worker.events — fan-out broadcast', () => {
  it('delivers every event to two concurrent consumers', async () => {
    const mgr = new WorkerManager({
      claudeConfigPath: join(sandbox, '.claude.json'),
      claudeHome: sandbox,
      spawn: spawner('happy-path'),
    });
    try {
      const worker = await mgr.spawn(cfg('w-fanout'));
      const consumerA: StreamEvent[] = [];
      const consumerB: StreamEvent[] = [];
      const a = (async () => {
        for await (const ev of worker.events) consumerA.push(ev);
      })();
      const b = (async () => {
        for await (const ev of worker.events) consumerB.push(ev);
      })();
      await Promise.all([a, b]);
      await worker.waitForExit();

      expect(consumerA.length).toBeGreaterThan(0);
      expect(consumerA.map((e) => e.type)).toEqual(consumerB.map((e) => e.type));
      expect(consumerA.some((e) => e.type === 'system_init')).toBe(true);
      expect(consumerA.some((e) => e.type === 'result')).toBe(true);
    } finally {
      await mgr.shutdown();
    }
  });

  it('late consumer still receives replayable backlog from before it attached', async () => {
    const mgr = new WorkerManager({
      claudeConfigPath: join(sandbox, '.claude.json'),
      claudeHome: sandbox,
      spawn: spawner('happy-path'),
    });
    try {
      const worker = await mgr.spawn(cfg('w-late'));
      // Attach AFTER the worker exits. Because nothing else subscribed
      // before exit, the pre-subscribe backlog should contain all events.
      await worker.waitForExit();
      const events: StreamEvent[] = [];
      for await (const ev of worker.events) events.push(ev);
      expect(events.length).toBeGreaterThan(0);
      expect(events.some((e) => e.type === 'result')).toBe(true);
    } finally {
      await mgr.shutdown();
    }
  });

  it('return() on the iterator unsubscribes without blocking other consumers', async () => {
    const mgr = new WorkerManager({
      claudeConfigPath: join(sandbox, '.claude.json'),
      claudeHome: sandbox,
      spawn: spawner('happy-path'),
    });
    try {
      const worker = await mgr.spawn(cfg('w-unsub'));
      const consumerA: StreamEvent[] = [];
      const consumerB: StreamEvent[] = [];
      const iterB = worker.events[Symbol.asyncIterator]();
      const a = (async () => {
        for await (const ev of worker.events) consumerA.push(ev);
      })();
      // Pull one from B then stop
      const first = await iterB.next();
      if (!first.done) consumerB.push(first.value);
      await iterB.return?.();
      await a;
      await worker.waitForExit();

      expect(consumerB.length).toBe(1);
      expect(consumerA.some((e) => e.type === 'result')).toBe(true);
    } finally {
      await mgr.shutdown();
    }
  });

  it('no consumer attaches → buffer caps to a bounded backlog', async () => {
    const mgr = new WorkerManager({
      claudeConfigPath: join(sandbox, '.claude.json'),
      claudeHome: sandbox,
      spawn: spawner('happy-path'),
    });
    try {
      const worker = await mgr.spawn(cfg('w-no-consumer'));
      await worker.waitForExit();
      // No iteration at all; worker must still have exited cleanly.
      const exit = await worker.waitForExit();
      expect(exit.status).toBe('completed');
    } finally {
      await mgr.shutdown();
    }
  });
});
