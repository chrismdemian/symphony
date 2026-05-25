/**
 * Phase 5D production scenario — `set_active_project` routes
 * omitted-`project:` calls to the active project, persists across
 * cursor flips, and falls back gracefully on clear.
 *
 * See `tests/scenarios/5d.md` for the Given/When/Then.
 *
 * Approach:
 *   - Real `startOrchestratorServer` + real `SqliteProjectStore` /
 *     `SqliteTaskStore` (the resolver IS the test target).
 *   - The resolver fires inside `create_task`'s `projectStore.get(project)`
 *     path. To exercise the omitted-`project:` route in production
 *     wiring, we observe via `worker-lifecycle.resolveProjectPath` —
 *     `WorkerLifecycle`'s `getMaxConcurrentWorkers` is the simplest
 *     consumer (called per-spawn AND through paths that round-trip an
 *     empty project arg).
 *   - For observable assertions we use the completions broker (chat-row
 *     signal) + `loadConfig()` (disk persistence).
 */
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ProjectRegistry,
  startOrchestratorServer,
  TaskRegistry,
  type OrchestratorServerHandle,
} from '../../src/orchestrator/index.js';
import { WorkerCompletionsBroker } from '../../src/orchestrator/completions-broker.js';
import type { CompletionSummary } from '../../src/orchestrator/completion-summarizer-types.js';
import { WorktreeManager } from '../../src/worktree/manager.js';
import type { WorkerManager } from '../../src/workers/manager.js';
import {
  SYMPHONY_CONFIG_FILE_ENV,
  _resetConfigWriteQueue,
  loadConfig,
} from '../../src/utils/config.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd });
}

async function initRepo(repoPath: string): Promise<void> {
  mkdirSync(repoPath, { recursive: true });
  await git(repoPath, 'init', '--initial-branch=main');
  await git(repoPath, 'config', 'user.email', 'test@example.com');
  await git(repoPath, 'config', 'user.name', '5D scenario');
  await git(repoPath, 'config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(repoPath, 'README.md'), '# seed\n');
  await git(repoPath, 'add', '.');
  await git(repoPath, 'commit', '-m', 'seed');
}

function fakeWorkerManager(): WorkerManager {
  return {
    spawn: async () => {
      throw new Error('no spawn expected in 5D scenario');
    },
    list: () => [],
    get: () => undefined,
    shutdown: async () => {},
  } as unknown as WorkerManager;
}

describe('Phase 5D scenario — set_active_project routing (real fs + real server)', () => {
  let sandbox: string;
  let projectA: string;
  let projectB: string;
  let configPath: string;
  let priorEnv: string | undefined;
  let server: OrchestratorServerHandle | null = null;
  let client: Client | null = null;

  beforeEach(async () => {
    sandbox = mkdtempSync(path.join(tmpdir(), 'sym-5d-scn-'));
    projectA = path.join(sandbox, 'projA');
    projectB = path.join(sandbox, 'projB');
    await initRepo(projectA);
    await initRepo(projectB);
    configPath = path.join(sandbox, 'config.json');
    priorEnv = process.env[SYMPHONY_CONFIG_FILE_ENV];
    process.env[SYMPHONY_CONFIG_FILE_ENV] = configPath;
    _resetConfigWriteQueue();
  });

  afterEach(async () => {
    if (client !== null) await client.close().catch(() => {});
    if (server !== null) await server.close().catch(() => {});
    server = null;
    client = null;
    if (priorEnv === undefined) {
      delete process.env[SYMPHONY_CONFIG_FILE_ENV];
    } else {
      process.env[SYMPHONY_CONFIG_FILE_ENV] = priorEnv;
    }
    _resetConfigWriteQueue();
    try {
      rmSync(sandbox, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      // Win32 retry — best effort
    }
  });

  it('Given+When+Then — set_active_project flips routing, persists, and clears', async () => {
    // ── Given ──────────────────────────────────────────────────────────
    const projectStore = new ProjectRegistry();
    projectStore.register({ id: 'pa', name: 'proja', path: projectA, createdAt: '' });
    projectStore.register({ id: 'pb', name: 'projb', path: projectB, createdAt: '' });
    const taskStore = new TaskRegistry();
    const worktreeManager = new WorktreeManager();
    const broker = new WorkerCompletionsBroker();
    const summaries: CompletionSummary[] = [];
    broker.subscribe((s) => summaries.push(s));

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    server = await startOrchestratorServer({
      transport: serverTransport,
      initialMode: 'plan',
      defaultProjectPath: projectA,
      workerManager: fakeWorkerManager(),
      worktreeManager,
      projectStore,
      taskStore,
      completionsBroker: broker,
    });
    client = new Client({ name: '5d-scn', version: '0.0.0' });
    await client.connect(clientTransport);

    // ── When 1: set the cursor to projb ─────────────────────────────
    const setResult = (await client.callTool({
      name: 'set_active_project',
      arguments: { project_name: 'projb' },
    })) as {
      content: ReadonlyArray<{ text: string }>;
      structuredContent?: { active?: { name?: string; path?: string } | null };
      isError?: boolean;
    };
    // ── Then 1: structured response carries the resolved snapshot ──
    expect(setResult.isError).toBeFalsy();
    expect(setResult.structuredContent?.active?.name).toBe('projb');
    expect(setResult.structuredContent?.active?.path).toBe(path.resolve(projectB));

    // ── Then 2: broker received the chat-row signal ─────────────────
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.headline).toBe('Active project → projb');
    expect(summaries[0]!.statusKind).toBe('completed');

    // ── When 2: create_task with explicit project ──────────────────
    const taskB1 = (await client.callTool({
      name: 'create_task',
      arguments: { project: 'projb', description: 'explicit projb task' },
    })) as unknown as {
      structuredContent: { id: string; projectId: string };
      isError?: boolean;
    };
    expect(taskB1.isError).toBeFalsy();
    // ── Then 3: lands on projb ──────────────────────────────────────
    expect(taskB1.structuredContent.projectId).toBe('pb');

    // ── When 3: create_task with NO project (cursor routes it) ─────
    // Post-M1 fix — `create_task.project` is now optional and the
    // tool consults the resolver. With cursor === projb, this task
    // MUST land on projb without an explicit `project:` arg.
    const taskB2 = (await client.callTool({
      name: 'create_task',
      arguments: { description: 'omitted-project task (cursor routes)' },
    })) as unknown as {
      structuredContent: { id: string; projectId: string };
      isError?: boolean;
    };
    expect(taskB2.isError).toBeFalsy();
    // ── Then 4: lands on projb via the cursor (NOT defaultProjectPath)
    expect(taskB2.structuredContent.projectId).toBe('pb');

    // ── When 4: clear the cursor ────────────────────────────────────
    const clearResult = (await client.callTool({
      name: 'set_active_project',
      arguments: { project_name: '(none)' },
    })) as {
      structuredContent?: { active: null };
      isError?: boolean;
    };
    expect(clearResult.isError).toBeFalsy();
    expect(clearResult.structuredContent?.active).toBeNull();

    // ── Then 5: broker received the clear signal ────────────────────
    expect(summaries).toHaveLength(2);
    expect(summaries[1]!.headline).toBe('Active project cleared (was projb)');

    // ── When 5: downstream create_task with NO project after clear ──
    // Cursor is null; the resolver falls through to defaultProjectPath
    // (= projA). The task MUST land on projA without an explicit
    // `project:` arg — the cleared cursor returns routing to the boot
    // default.
    const taskA = (await client.callTool({
      name: 'create_task',
      arguments: { description: 'omitted-project task after clear' },
    })) as unknown as {
      structuredContent: { id: string; projectId: string };
      isError?: boolean;
    };
    // ── Then 6: lands on proja (default fallback) ──────────────────
    expect(taskA.isError).toBeFalsy();
    expect(taskA.structuredContent.projectId).toBe('pa');

    // ── Then 7: config.activeProject is undefined after the clear ───
    const persisted = await loadConfig(configPath);
    expect(persisted.config.activeProject).toBeUndefined();
  });
});
