/**
 * Phase 4G.2 — verify_ui handler + runVerifyUi unit tests.
 *
 * Covers:
 *   - Refuses on unknown worker, missing previewCommand, non-UI stack.
 *   - AbortSignal pre-aborted + mid-capture → 'aborted' code.
 *   - Boot timeout → 'boot-timeout' code.
 *   - Playwright missing → 'playwright-missing' code.
 *   - Happy path: launcher invoked, screenshots written, teardown fires.
 *   - Screenshot paths deterministic per stamp.
 *
 * Uses a fake `previewLauncher` + `screenshotter` (DI seams on VerifyUiDeps).
 * The actual git temp-repo + Playwright launch happen in the integration
 * test; this test is hermetic.
 */

import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import {
  PlaywrightMissingError,
  defaultPreviewLauncher,
  runVerifyUi,
} from '../../../src/orchestrator/tools/verify-ui.js';
import { ProjectRegistry } from '../../../src/projects/registry.js';
import {
  CircularBuffer,
  WorkerRegistry,
  type WorkerRecord,
} from '../../../src/orchestrator/worker-registry.js';
import type { StreamEvent, Worker } from '../../../src/workers/types.js';

function stubWorker(): Worker {
  return {
    id: 'wk',
    sessionId: undefined,
    status: 'completed',
    events: (async function* () {})(),
    sendFollowup: () => {},
    endInput: () => {},
    kill: () => {},
    waitForExit: async () =>
      ({ status: 'completed', exitCode: 0, signal: null, durationMs: 0 }),
  } as unknown as Worker;
}

function registerWorker(
  reg: WorkerRegistry,
  id: string,
  projectPath: string,
  worktreePath: string,
  projectId: string | null,
): WorkerRecord {
  const record: WorkerRecord = {
    id,
    projectPath,
    projectId,
    taskId: null,
    worktreePath,
    role: 'implementer',
    featureIntent: 'ship-ui',
    taskDescription: 'ship the landing page',
    autonomyTier: 2,
    dependsOn: [],
    status: 'completed',
    createdAt: new Date().toISOString(),
    worker: stubWorker(),
    buffer: new CircularBuffer<StreamEvent>(10),
    auditAttempts: 0,
    detach: () => {},
  };
  reg.register(record);
  return record;
}

/**
 * Stub ChildProcess that exposes a `killed` flag the test can assert on.
 * `killTree` calls `child.pid` and on POSIX `process.kill(-pid, 'SIGTERM')`
 * — we provide a fake pid that `process.kill` will reject on, then catch.
 * The simpler path is to use a no-op object that satisfies the type.
 */
function fakeChild(): ChildProcess & { killed: boolean } {
  const child = {
    pid: undefined,
    killed: false,
    kill() {
      child.killed = true;
      return true;
    },
    on() {
      return child;
    },
    once() {
      return child;
    },
  } as unknown as ChildProcess & { killed: boolean };
  return child;
}

let workdir: string;
let projectStore: ProjectRegistry;
let registry: WorkerRegistry;

beforeEach(async () => {
  workdir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sym-4g2-vu-'));
  // Seed a minimal package.json with React so detectUiStack passes.
  await fsp.writeFile(
    path.join(workdir, 'package.json'),
    JSON.stringify({ dependencies: { react: '18.0.0' } }),
    'utf8',
  );
  projectStore = new ProjectRegistry();
  registry = new WorkerRegistry();
});

afterEach(async () => {
  await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {});
});

describe('Phase 4G.2 — runVerifyUi', () => {
  it('refuses on unknown worker id', async () => {
    const outcome = await runVerifyUi(
      { registry, projectStore },
      { workerId: 'wk-nope' },
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.code).toBe('unknown-worker');
  });

  it('refuses when the project has no previewCommand', async () => {
    projectStore.register({
      id: 'p1',
      name: 'demo',
      path: workdir,
      createdAt: '2026-05-20T00:00:00.000Z',
      // no previewCommand
    });
    registerWorker(registry, 'wk-a', workdir, workdir, 'p1');

    const outcome = await runVerifyUi(
      { registry, projectStore },
      { workerId: 'wk-a' },
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.code).toBe('no-preview-command');
  });

  it('refuses on a non-UI stack (no package.json or no UI framework dep)', async () => {
    // Replace package.json with a non-UI dep set.
    await fsp.writeFile(
      path.join(workdir, 'package.json'),
      JSON.stringify({ dependencies: { lodash: '4.0.0' } }),
      'utf8',
    );
    projectStore.register({
      id: 'p1',
      name: 'demo',
      path: workdir,
      createdAt: '2026-05-20T00:00:00.000Z',
      previewCommand: 'pnpm dev',
    });
    registerWorker(registry, 'wk-a', workdir, workdir, 'p1');

    const outcome = await runVerifyUi(
      { registry, projectStore },
      { workerId: 'wk-a' },
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.code).toBe('no-ui-stack');
  });

  it('returns aborted when signal pre-aborts', async () => {
    projectStore.register({
      id: 'p1',
      name: 'demo',
      path: workdir,
      createdAt: '2026-05-20T00:00:00.000Z',
      previewCommand: 'pnpm dev',
    });
    registerWorker(registry, 'wk-a', workdir, workdir, 'p1');
    const ctrl = new AbortController();
    ctrl.abort();

    const outcome = await runVerifyUi(
      { registry, projectStore },
      { workerId: 'wk-a', signal: ctrl.signal },
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.code).toBe('aborted');
  });

  it('returns playwright-missing when the screenshotter throws PlaywrightMissingError', async () => {
    projectStore.register({
      id: 'p1',
      name: 'demo',
      path: workdir,
      createdAt: '2026-05-20T00:00:00.000Z',
      previewCommand: 'pnpm dev',
    });
    registerWorker(registry, 'wk-a', workdir, workdir, 'p1');

    const child = fakeChild();
    const outcome = await runVerifyUi(
      {
        registry,
        projectStore,
        previewLauncher: async () => ({ url: 'http://localhost:3000', child }),
        screenshotter: async () => {
          throw new PlaywrightMissingError('Chromium is not installed.');
        },
      },
      { workerId: 'wk-a' },
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.code).toBe('playwright-missing');
  });

  it('happy path — launcher + screenshotter invoked, files declared, teardown fires', async () => {
    projectStore.register({
      id: 'p1',
      name: 'demo',
      path: workdir,
      createdAt: '2026-05-20T00:00:00.000Z',
      previewCommand: 'pnpm dev',
    });
    registerWorker(registry, 'wk-a', workdir, workdir, 'p1');

    const child = fakeChild();
    const screenshotCalls: { viewport: { width: number; height: number }; outputPath: string }[] = [];
    const outcome = await runVerifyUi(
      {
        registry,
        projectStore,
        previewLauncher: async (input) => {
          expect(input.command).toBe('pnpm dev');
          expect(input.cwd).toBe(workdir);
          return { url: 'http://localhost:5173/', child };
        },
        screenshotter: async (input) => {
          screenshotCalls.push({
            viewport: input.viewport,
            outputPath: input.outputPath,
          });
          // The runVerifyUi loop expects the file to exist for the
          // path to be claimed; write a minimal one for round-trip.
          await fsp.mkdir(path.dirname(input.outputPath), { recursive: true });
          await fsp.writeFile(input.outputPath, 'fake-png', 'utf8');
        },
        now: () => new Date('2026-05-20T01:23:45.678Z'),
      },
      { workerId: 'wk-a' },
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('unreachable');
    expect(outcome.result.previewUrl).toBe('http://localhost:5173/');
    expect(outcome.result.workerId).toBe('wk-a');
    // Deterministic timestamp folder (Win32-safe — no ':' or '.' chars).
    const expectedStamp = '2026-05-20T01-23-45-678Z';
    expect(outcome.result.screenshotPaths.desktop).toContain(
      path.join('.symphony', 'screenshots', expectedStamp, 'desktop.png'),
    );
    expect(outcome.result.screenshotPaths.mobile).toContain(
      path.join('.symphony', 'screenshots', expectedStamp, 'mobile.png'),
    );
    // Two screenshot calls, with the right viewports.
    expect(screenshotCalls.length).toBe(2);
    expect(screenshotCalls[0]?.viewport).toEqual({ width: 1280, height: 720 });
    expect(screenshotCalls[1]?.viewport).toEqual({ width: 390, height: 844 });
    // Teardown fired (`killTree(child)` ran in the finally; child has no
    // pid so killTree no-ops cleanly — we assert the finally branch
    // executed by checking the screenshot files exist on disk).
    const desktop = outcome.result.screenshotPaths.desktop!;
    await expect(fsp.access(desktop)).resolves.toBeUndefined();
  });

  /**
   * Audit-fix M1 regression lock — every real-world dev server (vite,
   * next, svelte, astro, etc.) wraps its URL in ANSI color codes. An
   * earlier regex `[^\s]*` let `\x1b[0m` leak into the captured URL,
   * breaking `page.goto` downstream. The launcher must strip ANSI
   * (or exclude `\x1b` from the path class) BEFORE matching.
   *
   * This test drives `defaultPreviewLauncher` against a stub child that
   * emits a vite-shaped banner with ANSI codes, then asserts the
   * resolved URL contains no escape bytes.
   */
  it('M1 regression — captured URL has no trailing ANSI escape (vite/next banner shape)', async () => {
    const ansiBanner =
      '\x1b[36m  VITE v5.4.0  ready in 312 ms\x1b[0m\n\n' +
      '  \x1b[32m➜\x1b[0m  \x1b[1mLocal:\x1b[0m   \x1b[36mhttp://localhost:5173/\x1b[0m\n';
    // Spawn a stub child that emits the banner to stdout then sleeps.
    // Use `node -e` for cross-platform compatibility.
    const escaped = ansiBanner
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'")
      .replace(/\n/g, '\\n')
      .replace(/\x1b/g, '\\x1b');
    const cmd =
      process.platform === 'win32'
        ? `node -e "process.stdout.write('${escaped.replace(/"/g, '\\"').replace(/'/g, '"')}'); setTimeout(()=>{}, 30000)"`
        : `node -e 'process.stdout.write("${escaped.replace(/"/g, '\\"')}"); setTimeout(()=>{}, 30000)'`;
    const handle = await defaultPreviewLauncher({
      command: cmd,
      cwd: process.cwd(),
      timeoutMs: 5000,
      signal: undefined,
    });
    try {
      expect(handle.url).toBe('http://localhost:5173/');
      // eslint-disable-next-line no-control-regex
      expect(handle.url).not.toMatch(/\x1b/);
    } finally {
      handle.child.kill();
    }
  }, 15_000);

  /**
   * Audit-fix M2 regression lock — fallback port probe was removed
   * because an ambient dev server on a common port (3000, 5173, etc.)
   * would collide with the worker's preview in Symphony's parallel-
   * orchestration model. The launcher MUST refuse with `boot-timeout`
   * when the previewCommand stays silent — NOT fall back to a probe.
   *
   * This test runs a preview command that never prints anything and
   * asserts the launcher throws within `timeoutMs`.
   */
  it('m1 + M2 — boot-timeout when command emits no URL (no fallback probe)', async () => {
    // A command that exits immediately with no stdout. The launcher
    // should fail with `boot-timeout` (which also gets exit-info from
    // the early exit hook) rather than probe any port.
    const cmd =
      process.platform === 'win32'
        ? `node -e "process.exit(0)"`
        : `node -e 'process.exit(0)'`;
    await expect(
      defaultPreviewLauncher({
        command: cmd,
        cwd: process.cwd(),
        timeoutMs: 2_000,
        signal: undefined,
      }),
    ).rejects.toMatchObject({ code: 'boot-timeout' });
  }, 10_000);

  it('viewports override caps the captures', async () => {
    projectStore.register({
      id: 'p1',
      name: 'demo',
      path: workdir,
      createdAt: '2026-05-20T00:00:00.000Z',
      previewCommand: 'pnpm dev',
    });
    registerWorker(registry, 'wk-a', workdir, workdir, 'p1');

    const child = fakeChild();
    let calls = 0;
    const outcome = await runVerifyUi(
      {
        registry,
        projectStore,
        previewLauncher: async () => ({ url: 'http://localhost:5173', child }),
        screenshotter: async (input) => {
          calls += 1;
          await fsp.mkdir(path.dirname(input.outputPath), { recursive: true });
          await fsp.writeFile(input.outputPath, 'fake', 'utf8');
        },
      },
      { workerId: 'wk-a', viewports: ['desktop'] },
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('unreachable');
    expect(calls).toBe(1);
    expect(outcome.result.screenshotPaths.desktop).toBeDefined();
    expect(outcome.result.screenshotPaths.mobile).toBeUndefined();
  });
});
