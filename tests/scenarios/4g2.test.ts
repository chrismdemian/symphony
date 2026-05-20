/**
 * Phase 4G.2 production scenario — `verify_ui` MCP tool surfaces the
 * three expected outcomes through the dispatch surface Maestro uses.
 *
 * REAL `makeVerifyUiTool` + REAL `WorkerRegistry` + REAL `ProjectRegistry`.
 * The OS boundary (subprocess + Playwright) is stubbed via the DI seam
 * (`previewLauncher` + `screenshotter`), mirroring the Track-1 boundary
 * pattern from 4e.test.ts + 4g1.test.ts.
 */
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeVerifyUiTool } from '../../src/orchestrator/tools/verify-ui.js';
import { ProjectRegistry } from '../../src/projects/registry.js';
import {
  CircularBuffer,
  WorkerRegistry,
  type WorkerRecord,
} from '../../src/orchestrator/worker-registry.js';
import { DEFAULT_DISPATCH_CONTEXT } from '../../src/orchestrator/capabilities.js';
import type { DispatchContext } from '../../src/orchestrator/types.js';
import type { StreamEvent, Worker } from '../../src/workers/types.js';

function ctx(): DispatchContext {
  return { ...DEFAULT_DISPATCH_CONTEXT, mode: 'act' };
}

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

function fakeChild(): ChildProcess {
  return {
    pid: undefined,
    killed: false,
    kill: () => true,
    on: () => {},
    once: () => {},
  } as unknown as ChildProcess;
}

function registerWorker(
  reg: WorkerRegistry,
  id: string,
  projectPath: string,
  worktreePath: string,
  projectId: string,
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

interface VerifyUiStructured {
  readonly ok?: boolean;
  readonly code?: string;
  readonly preview_url?: string;
  readonly screenshot_paths?: Record<string, string>;
}

let workdir: string;
let projectStore: ProjectRegistry;
let registry: WorkerRegistry;

beforeEach(async () => {
  workdir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sym-4g2-scenario-'));
  projectStore = new ProjectRegistry();
  registry = new WorkerRegistry();
});

afterEach(async () => {
  await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {});
});

describe('Phase 4G.2 scenario — verify_ui via the dispatch surface', () => {
  it('Section 1 — refuses when project has no previewCommand', async () => {
    // Seed React so the UI-stack guard passes; the FIRST refusal is the
    // previewCommand check.
    await fsp.writeFile(
      path.join(workdir, 'package.json'),
      JSON.stringify({ dependencies: { react: '18.0.0' } }),
      'utf8',
    );
    projectStore.register({
      id: 'p-no-preview',
      name: 'no-preview',
      path: workdir,
      createdAt: '2026-05-20T00:00:00.000Z',
      // no previewCommand
    });
    registerWorker(registry, 'wk-1', workdir, workdir, 'p-no-preview');
    const tool = makeVerifyUiTool({ registry, projectStore });

    const res = await tool.handler({ worker_id: 'wk-1', timeout_ms: undefined, viewports: undefined }, ctx());
    const struct = (res.structuredContent ?? {}) as VerifyUiStructured;
    expect(res.isError).toBe(true);
    expect(struct.code).toBe('no-preview-command');
    const text = res.content.map((c) => ('text' in c ? c.text : '')).join('');
    expect(text).toContain('previewCommand');
  });

  it('Section 2 — refuses when project has no UI stack', async () => {
    // Seed a NON-UI dep so detectUiStack returns false.
    await fsp.writeFile(
      path.join(workdir, 'package.json'),
      JSON.stringify({ dependencies: { lodash: '4.0.0' } }),
      'utf8',
    );
    projectStore.register({
      id: 'p-nonui',
      name: 'nonui',
      path: workdir,
      createdAt: '2026-05-20T00:00:00.000Z',
      previewCommand: 'pnpm dev',
    });
    registerWorker(registry, 'wk-2', workdir, workdir, 'p-nonui');
    const tool = makeVerifyUiTool({ registry, projectStore });

    const res = await tool.handler({ worker_id: 'wk-2', timeout_ms: undefined, viewports: undefined }, ctx());
    const struct = (res.structuredContent ?? {}) as VerifyUiStructured;
    expect(res.isError).toBe(true);
    expect(struct.code).toBe('no-ui-stack');
  });

  it('Section 3 — happy path returns screenshot_paths in structured_content', async () => {
    await fsp.writeFile(
      path.join(workdir, 'package.json'),
      JSON.stringify({ dependencies: { react: '18.0.0' } }),
      'utf8',
    );
    projectStore.register({
      id: 'p-ok',
      name: 'demo',
      path: workdir,
      createdAt: '2026-05-20T00:00:00.000Z',
      previewCommand: 'pnpm dev',
    });
    registerWorker(registry, 'wk-3', workdir, workdir, 'p-ok');

    const tool = makeVerifyUiTool({
      registry,
      projectStore,
      previewLauncher: async () => ({
        url: 'http://localhost:5173/',
        child: fakeChild(),
      }),
      screenshotter: async (input) => {
        await fsp.mkdir(path.dirname(input.outputPath), { recursive: true });
        // 8-byte PNG-ish stub.
        await fsp.writeFile(input.outputPath, '\x89PNG-stub', 'utf8');
      },
      now: () => new Date('2026-05-20T01:23:45.678Z'),
    });

    const res = await tool.handler({ worker_id: 'wk-3', timeout_ms: undefined, viewports: undefined }, ctx());
    const struct = (res.structuredContent ?? {}) as VerifyUiStructured;
    expect(res.isError).toBeFalsy();
    expect(struct.ok).toBe(true);
    expect(struct.preview_url).toBe('http://localhost:5173/');
    expect(struct.screenshot_paths?.desktop).toContain(
      path.join('.symphony', 'screenshots'),
    );
    expect(struct.screenshot_paths?.mobile).toContain(
      path.join('.symphony', 'screenshots'),
    );
    // Files exist on disk.
    await expect(fsp.access(struct.screenshot_paths!.desktop!)).resolves.toBeUndefined();
    await expect(fsp.access(struct.screenshot_paths!.mobile!)).resolves.toBeUndefined();
  });
});
