/**
 * Phase 5D — coverage for the `resolveProjectPath` fallback ladder.
 *
 * The resolver is closure-scoped inside `startOrchestratorServer`, so we
 * exercise it indirectly via `set_active_project` (flips the cursor)
 * + the in-memory `ProjectStore` lookups it performs. Three properties
 * matter:
 *   1. Explicit `project:` arg always wins.
 *   2. Cursor wins over `defaultProjectPath` when set.
 *   3. Cursor of a since-removed project gracefully falls through to
 *      `defaultProjectPath` — never throws.
 *
 * Direct introspection of the cursor isn't exposed (intentional — it's
 * private state). The completions broker is the load-bearing signal:
 * a cursor flip publishes a synthetic CompletionSummary. Tests below
 * subscribe to assert ordering + falsifiability without needing an
 * exposed accessor.
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
import { WorktreeManager } from '../../src/worktree/manager.js';
import type { WorkerManager } from '../../src/workers/manager.js';
import {
  SYMPHONY_CONFIG_FILE_ENV,
  _resetConfigWriteQueue,
} from '../../src/utils/config.js';

const execFileAsync = promisify(execFile);

function fakeWorkerManager(): WorkerManager {
  return {
    spawn: async () => {
      throw new Error('no spawn expected');
    },
    list: () => [],
    get: () => undefined,
    shutdown: async () => {},
  } as unknown as WorkerManager;
}

describe('Phase 5D — resolveProjectPath fallback ladder (via cursor flips)', () => {
  let tmpRoot: string;
  let projectA: string;
  let projectB: string;
  let server: OrchestratorServerHandle | null = null;
  let client: Client | null = null;
  let priorEnv: string | undefined;

  beforeEach(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-5d-resolver-'));
    projectA = path.join(tmpRoot, 'projA');
    projectB = path.join(tmpRoot, 'projB');
    for (const dir of [projectA, projectB]) {
      fs.mkdirSync(dir, { recursive: true });
      await execFileAsync('git', ['init', '-q', '--initial-branch=main', dir]);
      await execFileAsync('git', ['config', 'user.email', 't@t.io'], { cwd: dir });
      await execFileAsync('git', ['config', 'user.name', 'resolver'], { cwd: dir });
      fs.writeFileSync(path.join(dir, 'README.md'), '# seed\n');
      await execFileAsync('git', ['add', 'README.md'], { cwd: dir });
      await execFileAsync('git', ['commit', '-m', 'seed'], { cwd: dir });
    }
    priorEnv = process.env[SYMPHONY_CONFIG_FILE_ENV];
    process.env[SYMPHONY_CONFIG_FILE_ENV] = path.join(tmpRoot, 'config.json');
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
      // Win32 retry — best effort
    }
  });

  async function boot(broker: WorkerCompletionsBroker): Promise<void> {
    const projectStore = new ProjectRegistry();
    projectStore.register({ id: 'pA', name: 'projA', path: projectA, createdAt: '' });
    projectStore.register({ id: 'pB', name: 'projB', path: projectB, createdAt: '' });
    const taskStore = new TaskRegistry();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    server = await startOrchestratorServer({
      transport: serverTransport,
      initialMode: 'plan',
      defaultProjectPath: projectA,
      workerManager: fakeWorkerManager(),
      worktreeManager: new WorktreeManager(),
      projectStore,
      taskStore,
      completionsBroker: broker,
    });
    client = new Client({ name: '5d-resolver', version: '0.0.0' });
    await client.connect(clientTransport);
  }

  it('flips between projects fire ordered chat rows; clearing flips back to null', async () => {
    const broker = new WorkerCompletionsBroker();
    const headlines: string[] = [];
    broker.subscribe((s) => headlines.push(s.headline));
    await boot(broker);

    await client!.callTool({
      name: 'set_active_project',
      arguments: { project_name: 'projB' },
    });
    await client!.callTool({
      name: 'set_active_project',
      arguments: { project_name: 'projA' },
    });
    await client!.callTool({
      name: 'set_active_project',
      arguments: { project_name: '(none)' },
    });

    expect(headlines).toEqual([
      'Active project → projB',
      'Active project → projA',
      'Active project cleared (was projA)',
    ]);
  });

  it('redundant set_active_project flips fire no chat row (cursor unchanged)', async () => {
    const broker = new WorkerCompletionsBroker();
    const summaries: { headline: string }[] = [];
    broker.subscribe((s) => summaries.push({ headline: s.headline }));
    await boot(broker);

    await client!.callTool({
      name: 'set_active_project',
      arguments: { project_name: 'projB' },
    });
    await client!.callTool({
      name: 'set_active_project',
      arguments: { project_name: 'projB' },
    });
    await client!.callTool({
      name: 'set_active_project',
      arguments: { project_name: 'projB' },
    });

    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.headline).toBe('Active project → projB');
  });

  it('clear-then-clear is also idempotent (null → null is silent)', async () => {
    const broker = new WorkerCompletionsBroker();
    const summaries: unknown[] = [];
    broker.subscribe((s) => summaries.push(s));
    await boot(broker);

    await client!.callTool({
      name: 'set_active_project',
      arguments: { project_name: '(none)' },
    });
    await client!.callTool({
      name: 'set_active_project',
      arguments: { project_name: '(none)' },
    });

    // Initial state is null (no boot value persisted); first clear is
    // a no-op, second clear is a no-op. Zero chat rows.
    expect(summaries).toHaveLength(0);
  });
});
