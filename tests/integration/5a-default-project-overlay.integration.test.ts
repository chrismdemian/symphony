/**
 * Phase 5A audit-C1 regression test.
 *
 * The primary CLI boot path (`cd ~/myapp && symphony start`) hits
 * `ensureDefaultProjectRegistered` without ever going through
 * `mergeProjectConfigsWithFiles` (the `projects` map is empty when no
 * `--project` flag is passed). The pre-fix implementation silently
 * ignored `<defaultProjectPath>/.symphony.json` in that case — the
 * entire 5A feature was bypassed for the most common user flow.
 *
 * This test boots `startOrchestratorServer` with NO `projects` /
 * `projectConfigs` and asserts the synthesized default project picks
 * up the file overlay.
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
import type { WorkerManager } from '../../src/workers/manager.js';
import { WorktreeManager } from '../../src/worktree/manager.js';

const execFileAsync = promisify(execFile);

function fakeWorkerManager(): WorkerManager {
  return {
    spawn: async () => {
      throw new Error('no worker spawn expected in this regression test');
    },
    list: () => [],
    get: () => undefined,
    shutdown: async () => {},
  } as unknown as WorkerManager;
}

describe('Phase 5A audit-C1 — default project picks up `.symphony.json` overlay', () => {
  let tmpRoot: string;
  let projectDir: string;
  let server: OrchestratorServerHandle | null = null;
  let client: Client | null = null;

  beforeEach(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-5a-c1-'));
    projectDir = path.join(tmpRoot, 'myapp');
    fs.mkdirSync(projectDir, { recursive: true });
    await execFileAsync('git', ['init', '-q', '--initial-branch=main', projectDir]);
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: projectDir });
    await execFileAsync('git', ['config', 'user.name', 'Phase 5A C1 test'], { cwd: projectDir });
    fs.writeFileSync(path.join(projectDir, 'README.md'), '# seed\n');
    await execFileAsync('git', ['add', 'README.md'], { cwd: projectDir });
    await execFileAsync('git', ['commit', '-m', 'seed'], { cwd: projectDir });
  });

  afterEach(async () => {
    if (client !== null) await client.close().catch(() => {});
    if (server !== null) await server.close().catch(() => {});
    server = null;
    client = null;
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      // Windows file-lock retry — best effort
    }
  });

  it('synthesized default project absorbs file overlay (NO `projects` / `projectConfigs`)', async () => {
    fs.writeFileSync(
      path.join(projectDir, '.symphony.json'),
      JSON.stringify({
        project: {
          qualityPipeline: 'simplified',
          planModeRequired: true,
          defaultAutonomyTier: 2,
          maestroWarmth: 0.6,
          designInspiration: 'linear',
          testCommand: 'pnpm test:overlay',
        },
      }),
    );

    const projectStore = new ProjectRegistry();
    const taskStore = new TaskRegistry();
    const worktreeManager = new WorktreeManager();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    server = await startOrchestratorServer({
      transport: serverTransport,
      initialMode: 'plan',
      defaultProjectPath: projectDir,
      workerManager: fakeWorkerManager(),
      worktreeManager,
      projectStore,
      taskStore,
      // KEY: NO `projects` map. NO `projectConfigs`. Tests the bare
      // `symphony start` boot flow.
    });
    client = new Client({ name: '5a-c1-test', version: '0.0.0' });
    await client.connect(clientTransport);

    // The synthesized default project is named 'default' (no existing rows).
    const def = projectStore.get('default');
    expect(def).toBeDefined();
    expect(def!.path).toBe(path.resolve(projectDir));
    // Critical: every overlay field flows from the file.
    expect(def!.qualityPipeline).toBe('simplified');
    expect(def!.planModeRequired).toBe(true);
    expect(def!.defaultAutonomyTier).toBe(2);
    expect(def!.maestroWarmth).toBeCloseTo(0.6);
    expect(def!.designInspiration).toBe('linear');
    expect(def!.testCommand).toBe('pnpm test:overlay');
  });

  it('caller-supplied default config still wins over file overlay', async () => {
    fs.writeFileSync(
      path.join(projectDir, '.symphony.json'),
      JSON.stringify({
        project: {
          qualityPipeline: 'simplified',
          testCommand: 'file-test',
        },
      }),
    );

    const projectStore = new ProjectRegistry();
    const taskStore = new TaskRegistry();
    const worktreeManager = new WorktreeManager();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    server = await startOrchestratorServer({
      transport: serverTransport,
      initialMode: 'plan',
      defaultProjectPath: projectDir,
      workerManager: fakeWorkerManager(),
      worktreeManager,
      projectStore,
      taskStore,
      projectConfigs: { default: { qualityPipeline: 'full' } },
    });
    client = new Client({ name: '5a-c1-test', version: '0.0.0' });
    await client.connect(clientTransport);

    const def = projectStore.get('default')!;
    expect(def.qualityPipeline).toBe('full'); // caller wins
    expect(def.testCommand).toBe('file-test'); // file overlay still applied
  });

  it('missing `.symphony.json` boots clean without overlay (no warnings)', async () => {
    // No `.symphony.json` written — common path for first-time users.
    const projectStore = new ProjectRegistry();
    const taskStore = new TaskRegistry();
    const worktreeManager = new WorktreeManager();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    server = await startOrchestratorServer({
      transport: serverTransport,
      initialMode: 'plan',
      defaultProjectPath: projectDir,
      workerManager: fakeWorkerManager(),
      worktreeManager,
      projectStore,
      taskStore,
    });
    client = new Client({ name: '5a-c1-test', version: '0.0.0' });
    await client.connect(clientTransport);

    const def = projectStore.get('default')!;
    expect(def.qualityPipeline).toBeUndefined();
    expect(def.planModeRequired).toBeUndefined();
  });
});
