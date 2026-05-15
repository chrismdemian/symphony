/**
 * Phase 4A production scenario — worker role templates reach the spawned
 * worker through the real `spawn_worker` MCP tool path.
 *
 * Track 1 (deterministic, always runs): REAL `createWorkerLifecycle` +
 * REAL `WorkerRegistry` + REAL frozen artifacts, driven via the REAL
 * `makeSpawnWorkerTool` handler (the MCP dispatch entrypoint Maestro
 * uses). The lifecycle's OS boundary (the `claude` subprocess) is
 * stubbed to capture `cfg.prompt` — the observable ground truth.
 *
 * Track 2 (real `claude -p`, skips if the CLI is absent): mirrors the
 * 2A.2 scenario shape — real `startOrchestratorServer` + MCP client +
 * real worktree. Proves the multi-KB composed prompt is a valid
 * stream-json first frame the real CLI accepts (no `parse_error`).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { execFile, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  startOrchestratorServer,
  type OrchestratorServerHandle,
} from '../../src/orchestrator/index.js';
import { createWorkerLifecycle } from '../../src/orchestrator/worker-lifecycle.js';
import { WorkerRegistry } from '../../src/orchestrator/worker-registry.js';
import { makeSpawnWorkerTool } from '../../src/orchestrator/tools/spawn-worker.js';
import { DEFAULT_DISPATCH_CONTEXT } from '../../src/orchestrator/capabilities.js';
import type { DispatchContext } from '../../src/orchestrator/types.js';
import type { WorkerManager } from '../../src/workers/manager.js';
import type {
  StreamEvent,
  Worker,
  WorkerConfig,
  WorkerExitInfo,
} from '../../src/workers/types.js';
import type { WorktreeManager } from '../../src/worktree/manager.js';
import type { CreateWorktreeOptions, WorktreeInfo } from '../../src/worktree/types.js';

const execFileAsync = promisify(execFile);
const claudeAvailable = detectClaude();

function detectClaude(): boolean {
  try {
    const result = spawnSync('claude', ['--version'], {
      encoding: 'utf8',
      timeout: 5_000,
      shell: false,
    });
    return result.status === 0 && result.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

async function initRepo(repoPath: string): Promise<void> {
  const git = async (...args: string[]) => {
    await execFileAsync('git', args, { cwd: repoPath });
  };
  await git('init', '--initial-branch=main');
  await git('config', 'user.email', 'test@example.com');
  await git('config', 'user.name', 'Symphony Scenario 4a');
  await git('config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(repoPath, 'README.md'), '# Phase 4A scenario\n');
  await git('add', '.');
  await git('commit', '-m', 'init');
}

async function waitFor(
  pred: () => boolean,
  timeoutMs: number,
  intervalMs = 100,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return pred();
}

function ctx(): DispatchContext {
  return { ...DEFAULT_DISPATCH_CONTEXT, mode: 'act' };
}

class StubWorker implements Worker {
  readonly id: string;
  sessionId: string | undefined = undefined;
  status: WorkerExitInfo['status'] = 'running';
  events: AsyncIterable<StreamEvent> = (async function* () {})();
  constructor(id: string) {
    this.id = id;
  }
  sendFollowup(): void {}
  endInput(): void {}
  kill(): void {}
  waitForExit(): Promise<WorkerExitInfo> {
    return new Promise(() => {});
  }
}

function makeWm(): { mgr: WorkerManager; configs: WorkerConfig[] } {
  const configs: WorkerConfig[] = [];
  const mgr = {
    spawn: async (cfg: WorkerConfig): Promise<Worker> => {
      configs.push(cfg);
      return new StubWorker(cfg.id);
    },
    list: () => [],
    get: () => undefined,
    shutdown: async () => {},
  } as unknown as WorkerManager;
  return { mgr, configs };
}

function stubWt(): WorktreeManager {
  return {
    create: async (opts: CreateWorktreeOptions): Promise<WorktreeInfo> => ({
      id: opts.workerId,
      path: `/wt/${opts.workerId}`,
      branch: `b/${opts.workerId}`,
      baseRef: 'refs/heads/main',
      projectPath: opts.projectPath,
      createdAt: '2026-05-15T00:00:00.000Z',
    }),
    list: async () => [],
    remove: async () => {},
    removeIfClean: async () => true,
    status: async () => ({
      hasChanges: false,
      staged: [],
      unstaged: [],
      untracked: [],
    }),
  } as unknown as WorktreeManager;
}

describe('Phase 4A scenario — Track 1: spawn_worker tool composes the role prompt', () => {
  it('researcher: opener + read-only fence + suffix contract + task block', async () => {
    const wm = makeWm();
    const registry = new WorkerRegistry();
    const lifecycle = createWorkerLifecycle({
      registry,
      workerManager: wm.mgr,
      worktreeManager: stubWt(),
    });
    const tool = makeSpawnWorkerTool({
      registry,
      lifecycle,
      resolveProjectPath: () => '/home/chris/projects/symphony',
    });
    // z.infer on the tool registration collapses optionals to
    // required-with-undefined (2A.4a gotcha) — pass them explicitly.
    const res = await tool.handler(
      {
        project: undefined,
        task_description: 'survey the websocket reconnect path',
        role: 'researcher',
        model: undefined,
        depends_on: undefined,
        autonomy_tier: undefined,
        task_id: undefined,
      },
      ctx(),
    );
    expect(res.isError).toBeFalsy();
    const prompt = wm.configs[0]?.prompt ?? '';
    expect(prompt).toContain('## Your Role: Researcher');
    expect(prompt).toContain('read-only investigator');
    expect(prompt).toContain('### Reporting Format — MANDATORY');
    expect(prompt).toContain('"audit": "PASS"');
    expect(prompt).toContain(
      '# Your Task\n\nsurvey the websocket reconnect path',
    );
    expect(prompt).not.toContain('{worktree_path}');
    expect(prompt).not.toContain('## BEGIN SUFFIX');
  });

  it('implementer: opener + verbatim scope-clamp invariant (rule #7)', async () => {
    const wm = makeWm();
    const registry = new WorkerRegistry();
    const lifecycle = createWorkerLifecycle({
      registry,
      workerManager: wm.mgr,
      worktreeManager: stubWt(),
    });
    const tool = makeSpawnWorkerTool({
      registry,
      lifecycle,
      resolveProjectPath: () => '/p/proj',
    });
    const res = await tool.handler(
      {
        project: undefined,
        task_description: 'land the approved plan',
        role: 'implementer',
        model: undefined,
        depends_on: undefined,
        autonomy_tier: undefined,
        task_id: undefined,
      },
      ctx(),
    );
    expect(res.isError).toBeFalsy();
    const prompt = wm.configs[0]?.prompt ?? '';
    expect(prompt).toContain('execute an approved plan');
    // Verbatim scope-clamp sentence from worker-common-suffix-v1.md.
    expect(prompt).toContain(
      'Do what was asked, and no more.',
    );
    expect(prompt).toContain('# Your Task\n\nland the approved plan');
  });
});

describe('Phase 4A scenario — Track 2: real claude -p accepts the composed prompt', () => {
  let sandbox: string;
  let projectPath: string;
  let handle: OrchestratorServerHandle | null = null;
  let client: Client | null = null;

  beforeEach(async () => {
    sandbox = mkdtempSync(path.join(tmpdir(), 'symphony-4a-'));
    projectPath = path.join(sandbox, 'repo');
    if (!existsSync(projectPath)) mkdirSync(projectPath, { recursive: true });
    await initRepo(projectPath);
  });

  afterEach(async () => {
    try {
      await client?.close();
    } catch {
      /* ignore */
    }
    try {
      await handle?.close();
    } catch {
      /* ignore */
    }
    client = null;
    handle = null;
    try {
      rmSync(sandbox, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  if (!claudeAvailable) {
    console.warn(
      '[4a scenario] `claude --version` unavailable — real-claude track will skip. Install the CLI and re-run locally to exercise Gate 3.',
    );
  }

  it.skipIf(!claudeAvailable)(
    'composed researcher prompt is a valid stream-json first frame',
    async () => {
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      handle = await startOrchestratorServer({
        transport: serverTransport,
        initialMode: 'act',
        defaultProjectPath: projectPath,
      });
      client = new Client({ name: 'scenario-4a', version: '0.0.0' });
      await client.connect(clientTransport);

      const spawn = await client.callTool({
        name: 'spawn_worker',
        arguments: {
          task_description:
            'Reply with the single word ACK and nothing else. Do not use any tools. Do not emit a structured completion block.',
          role: 'researcher',
        },
      });
      expect(spawn.isError).toBeFalsy();
      const s = spawn.structuredContent as { id: string };
      expect(s.id).toMatch(/^wk-/);

      const record = handle.workerRegistry.get(s.id);
      expect(record).toBeDefined();
      const sawResult = await waitFor(
        () =>
          record!.buffer
            .tail(record!.buffer.size())
            .some((e) => e.type === 'result'),
        120_000,
      );
      expect(sawResult).toBe(true);
      const events = record!.buffer.tail(record!.buffer.size());
      // The composed multi-KB role prompt must be a clean first frame:
      // a malformed/oversized/bad-encoding prompt surfaces as parse_error.
      expect(events.some((e) => e.type === 'parse_error')).toBe(false);

      const kill = await client.callTool({
        name: 'kill_worker',
        arguments: { worker_id: s.id, reason: 'scenario-complete' },
      });
      expect(kill.isError).toBeFalsy();
      const exit = await record!.worker.waitForExit();
      expect(['completed', 'killed', 'failed']).toContain(exit.status);
    },
    150_000,
  );
});
