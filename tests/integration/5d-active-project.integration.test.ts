/**
 * Phase 5D — end-to-end integration coverage for the active-project
 * routing surface.
 *
 * Three signals are observable from outside the server:
 *   1. `set_active_project` tool response shape.
 *   2. `~/.symphony/config.json` (via `SYMPHONY_CONFIG_FILE`) carries
 *      `activeProject` after the tool call. A subsequent `loadConfig`
 *      reads it back — confirming persistence survives a restart.
 *   3. The completionsBroker receives a synthetic `Active project →`
 *      summary when the cursor flips (chat-row signaling path).
 *
 * Boot-time activeProject restoration is covered by booting a second
 * server with the same `SYMPHONY_CONFIG_FILE` and asserting the broker
 * fires on the next change rather than the initial boot.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
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

function fakeWorkerManager(): WorkerManager {
  return {
    spawn: async () => {
      throw new Error('no worker spawn expected in 5D integration test');
    },
    list: () => [],
    get: () => undefined,
    shutdown: async () => {},
  } as unknown as WorkerManager;
}

describe('Phase 5D — active-project end-to-end', () => {
  let tmpRoot: string;
  let projectA: string;
  let projectB: string;
  let configPath: string;
  let server: OrchestratorServerHandle | null = null;
  let client: Client | null = null;
  let priorEnv: string | undefined;

  beforeEach(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-5d-'));
    projectA = path.join(tmpRoot, 'projA');
    projectB = path.join(tmpRoot, 'projB');
    for (const dir of [projectA, projectB]) {
      fs.mkdirSync(dir, { recursive: true });
      await execFileAsync('git', ['init', '-q', '--initial-branch=main', dir]);
      await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
      await execFileAsync('git', ['config', 'user.name', '5D test'], { cwd: dir });
      fs.writeFileSync(path.join(dir, 'README.md'), '# seed\n');
      await execFileAsync('git', ['add', 'README.md'], { cwd: dir });
      await execFileAsync('git', ['commit', '-m', 'seed'], { cwd: dir });
    }
    configPath = path.join(tmpRoot, 'config.json');
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
      fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      // Windows file-lock retry — best effort
    }
  });

  async function bootServer(opts: {
    defaultProjectPath?: string;
    extraProjects?: ReadonlyArray<{ name: string; path: string }>;
    completionsBroker?: WorkerCompletionsBroker;
  } = {}): Promise<{ projectStore: ProjectRegistry; broker: WorkerCompletionsBroker }> {
    const projectStore = new ProjectRegistry();
    // Register A as the canonical project; B as a sibling for switching.
    projectStore.register({ id: 'pA', name: 'projA', path: projectA, createdAt: '' });
    projectStore.register({ id: 'pB', name: 'projB', path: projectB, createdAt: '' });
    for (const extra of opts.extraProjects ?? []) {
      projectStore.register({
        id: extra.name,
        name: extra.name,
        path: extra.path,
        createdAt: '',
      });
    }
    const taskStore = new TaskRegistry();
    const worktreeManager = new WorktreeManager();
    const broker = opts.completionsBroker ?? new WorkerCompletionsBroker();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    server = await startOrchestratorServer({
      transport: serverTransport,
      initialMode: 'plan',
      defaultProjectPath: opts.defaultProjectPath ?? projectA,
      workerManager: fakeWorkerManager(),
      worktreeManager,
      projectStore,
      taskStore,
      completionsBroker: broker,
    });
    client = new Client({ name: '5d-test', version: '0.0.0' });
    await client.connect(clientTransport);
    return { projectStore, broker };
  }

  it('set_active_project persists activeProject to disk and echoes the snapshot', async () => {
    await bootServer();
    const result = (await client!.callTool({
      name: 'set_active_project',
      arguments: { project_name: 'projB' },
    })) as {
      content: ReadonlyArray<{ type: string; text: string }>;
      structuredContent?: { active?: { name?: string; path?: string } | null };
      isError?: boolean;
    };
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent?.active?.name).toBe('projB');
    expect(result.structuredContent?.active?.path).toBe(path.resolve(projectB));
    const persisted = await loadConfig(configPath);
    expect(persisted.config.activeProject).toBe('projB');
  });

  it('publishes a chat-row signal on the completionsBroker when the cursor flips', async () => {
    const broker = new WorkerCompletionsBroker();
    const summaries: CompletionSummary[] = [];
    broker.subscribe((s) => summaries.push(s));
    await bootServer({ completionsBroker: broker });
    await client!.callTool({
      name: 'set_active_project',
      arguments: { project_name: 'projB' },
    });
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.statusKind).toBe('completed');
    expect(summaries[0]!.headline).toBe('Active project → projB');
    expect(summaries[0]!.workerName).toBe('Symphony');
  });

  it('clear sentinel ("(none)") removes the cursor and persists null', async () => {
    await bootServer();
    // First set, then clear.
    await client!.callTool({
      name: 'set_active_project',
      arguments: { project_name: 'projB' },
    });
    const persistedBefore = await loadConfig(configPath);
    expect(persistedBefore.config.activeProject).toBe('projB');

    const clearResult = (await client!.callTool({
      name: 'set_active_project',
      arguments: { project_name: '(none)' },
    })) as {
      structuredContent?: { active: null };
      isError?: boolean;
    };
    expect(clearResult.isError).toBeFalsy();
    expect(clearResult.structuredContent?.active).toBeNull();

    const persistedAfter = await loadConfig(configPath);
    expect(persistedAfter.config.activeProject).toBeUndefined();
  });

  it('rejects unknown project names without touching disk', async () => {
    await bootServer();
    const result = (await client!.callTool({
      name: 'set_active_project',
      arguments: { project_name: 'ghost' },
    })) as { content: ReadonlyArray<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content.map((c) => c.text).join('\n')).toContain("Unknown project 'ghost'");
    // No persisted state.
    const persisted = await loadConfig(configPath);
    expect(persisted.config.activeProject).toBeUndefined();
  });

  it('idempotent: setting the same project twice fires the chat row only once', async () => {
    const broker = new WorkerCompletionsBroker();
    const summaries: CompletionSummary[] = [];
    broker.subscribe((s) => summaries.push(s));
    await bootServer({ completionsBroker: broker });
    await client!.callTool({
      name: 'set_active_project',
      arguments: { project_name: 'projB' },
    });
    await client!.callTool({
      name: 'set_active_project',
      arguments: { project_name: 'projB' },
    });
    expect(summaries).toHaveLength(1);
  });

  it('persisted activeProject restores at boot: chat-row fires on the NEXT flip, not the boot read', async () => {
    // Pre-seed the config file with activeProject=projB BEFORE booting.
    fs.writeFileSync(
      configPath,
      JSON.stringify({ schemaVersion: 1, activeProject: 'projB' }, null, 2),
    );
    const broker = new WorkerCompletionsBroker();
    const summaries: CompletionSummary[] = [];
    broker.subscribe((s) => summaries.push(s));

    await bootServer({ completionsBroker: broker });

    // Boot is silent — the chat row is for user-driven changes only.
    expect(summaries).toHaveLength(0);

    // Now flip to projA. Should fire ONCE with "→ projA" (boot was projB).
    await client!.callTool({
      name: 'set_active_project',
      arguments: { project_name: 'projA' },
    });
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.headline).toBe('Active project → projA');
  });

  it('persisted activeProject pointing to a removed project boots clean (cursor stays null)', async () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({ schemaVersion: 1, activeProject: 'ghost' }, null, 2),
    );
    const broker = new WorkerCompletionsBroker();
    const summaries: CompletionSummary[] = [];
    broker.subscribe((s) => summaries.push(s));

    // Should not throw on boot.
    await bootServer({ completionsBroker: broker });
    expect(summaries).toHaveLength(0);

    // Subsequent set_active_project to a KNOWN project still works.
    await client!.callTool({
      name: 'set_active_project',
      arguments: { project_name: 'projB' },
    });
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.headline).toBe('Active project → projB');
  });
});
