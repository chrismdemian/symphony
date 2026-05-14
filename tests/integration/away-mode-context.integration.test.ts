import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { startOrchestratorServer } from '../../src/orchestrator/index.js';
import type { OrchestratorServerHandle } from '../../src/orchestrator/index.js';
import { SYMPHONY_CONFIG_FILE_ENV, _resetConfigWriteQueue } from '../../src/utils/config.js';
import { createSymphonyRouter } from '../../src/rpc/router-impl.js';

/**
 * Phase 3M — server-side `awayMode` propagation. Two seams:
 *
 *   1. Boot stamp — on startup, `loadConfig().awayMode` flows into the
 *      dispatch context cursor. A user who left away mode on across a
 *      restart keeps the protection on the first tool call.
 *   2. Live update — the `runtime.setAwayMode` RPC procedure mutates
 *      the same cursor mid-session via the `setDispatchAwayMode`
 *      closure wired in `server.ts`.
 *
 * The capability shim (`capabilities.ts`) reads `ctx.awayMode` per
 * tool call; testing that path with a real `requires-host-browser-control`
 * tool waits for Phase 7 (no such tool exists today). The unit test
 * `capabilities.unit.test.ts` already covers the evaluator logic with
 * `awayMode: true`. This file covers the cursor-mutation path.
 */

describe('away-mode dispatch context (3M, integration)', () => {
  let handles: OrchestratorServerHandle[] = [];
  let tmp: string;
  let cfgFile: string;
  let prevEnv: string | undefined;

  beforeEach(() => {
    _resetConfigWriteQueue();
    handles = [];
    tmp = mkdtempSync(join(tmpdir(), 'symphony-away-ctx-'));
    cfgFile = join(tmp, 'config.json');
    prevEnv = process.env[SYMPHONY_CONFIG_FILE_ENV];
    process.env[SYMPHONY_CONFIG_FILE_ENV] = cfgFile;
  });

  afterEach(async () => {
    for (const h of handles) await h.close().catch(() => {});
    _resetConfigWriteQueue();
    if (prevEnv === undefined) delete process.env[SYMPHONY_CONFIG_FILE_ENV];
    else process.env[SYMPHONY_CONFIG_FILE_ENV] = prevEnv;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('stamps awayMode=true into the dispatch context at boot when config has it on', async () => {
    writeFileSync(cfgFile, JSON.stringify({ schemaVersion: 1, awayMode: true }, null, 2), 'utf8');
    const [, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = await startOrchestratorServer({ transport: serverTransport });
    handles.push(server);
    expect(server.getContext().awayMode).toBe(true);
  });

  it('stamps awayMode=false into the dispatch context at boot when config omits the field', async () => {
    writeFileSync(cfgFile, JSON.stringify({ schemaVersion: 1 }, null, 2), 'utf8');
    const [, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = await startOrchestratorServer({ transport: serverTransport });
    handles.push(server);
    expect(server.getContext().awayMode).toBe(false);
  });

  it('falls back to defaults when loadConfig throws (corrupt JSON)', async () => {
    writeFileSync(cfgFile, '{ this is not json', 'utf8');
    const [, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = await startOrchestratorServer({ transport: serverTransport });
    handles.push(server);
    // Schema default for awayMode is false; the catch-branch fallback in
    // server.ts uses `defaultConfig()`. Either way the result is false.
    expect(server.getContext().awayMode).toBe(false);
  });

  it('runtime.setAwayMode (router-level) mutates the context cursor closure', async () => {
    // Mirrors how server.ts wires the closure: a local `context` cursor
    // updated by `setDispatchAwayMode`. Exercises the router contract
    // directly without spinning up the WS-RPC server.
    let context = { awayMode: false };
    const setter = (value: boolean): void => {
      context = { ...context, awayMode: value };
    };
    const { ProjectRegistry } = await import('../../src/projects/registry.js');
    const { TaskRegistry } = await import('../../src/state/task-registry.js');
    const { QuestionRegistry } = await import('../../src/state/question-registry.js');
    const { WaveRegistry } = await import('../../src/orchestrator/research-wave-registry.js');
    const { WorkerRegistry } = await import('../../src/orchestrator/worker-registry.js');
    const { ModeController } = await import('../../src/orchestrator/mode.js');
    const projectStore = new ProjectRegistry();
    const router = createSymphonyRouter({
      projectStore,
      taskStore: new TaskRegistry({ projectStore }),
      questionStore: new QuestionRegistry(),
      waveStore: new WaveRegistry(),
      workerRegistry: new WorkerRegistry(),
      modeController: new ModeController({ initial: 'plan' }),
      setDispatchAwayMode: setter,
    });

    expect(context.awayMode).toBe(false);
    await router.runtime.setAwayMode({ awayMode: true });
    expect(context.awayMode).toBe(true);
    await router.runtime.setAwayMode({ awayMode: false });
    expect(context.awayMode).toBe(false);
  });

  // Phase 3S — autonomy tier propagation (same shape as awayMode above).

  it('stamps autonomyTier from config at boot (3S)', async () => {
    writeFileSync(
      cfgFile,
      JSON.stringify({ schemaVersion: 1, autonomyTier: 3 }, null, 2),
      'utf8',
    );
    const [, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = await startOrchestratorServer({ transport: serverTransport });
    handles.push(server);
    expect(server.getContext().tier).toBe(3);
  });

  it('falls back to default tier 2 when config omits autonomyTier (3S)', async () => {
    writeFileSync(cfgFile, JSON.stringify({ schemaVersion: 1 }, null, 2), 'utf8');
    const [, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = await startOrchestratorServer({ transport: serverTransport });
    handles.push(server);
    expect(server.getContext().tier).toBe(2);
  });

  it('options.initialTier overrides the disk-read tier (3S, test rig precedence)', async () => {
    writeFileSync(
      cfgFile,
      JSON.stringify({ schemaVersion: 1, autonomyTier: 3 }, null, 2),
      'utf8',
    );
    const [, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = await startOrchestratorServer({ transport: serverTransport, initialTier: 1 });
    handles.push(server);
    expect(server.getContext().tier).toBe(1);
  });

  it('runtime.setAutonomyTier mutates the context cursor closure (3S)', async () => {
    let context: { tier: import('../../src/orchestrator/types.js').AutonomyTier } = { tier: 2 };
    const setter = (value: import('../../src/orchestrator/types.js').AutonomyTier): void => {
      context = { ...context, tier: value };
    };
    const { ProjectRegistry } = await import('../../src/projects/registry.js');
    const { TaskRegistry } = await import('../../src/state/task-registry.js');
    const { QuestionRegistry } = await import('../../src/state/question-registry.js');
    const { WaveRegistry } = await import('../../src/orchestrator/research-wave-registry.js');
    const { WorkerRegistry } = await import('../../src/orchestrator/worker-registry.js');
    const { ModeController } = await import('../../src/orchestrator/mode.js');
    const projectStore = new ProjectRegistry();
    const router = createSymphonyRouter({
      projectStore,
      taskStore: new TaskRegistry({ projectStore }),
      questionStore: new QuestionRegistry(),
      waveStore: new WaveRegistry(),
      workerRegistry: new WorkerRegistry(),
      modeController: new ModeController({ initial: 'plan' }),
      setDispatchAutonomyTier: setter,
    });

    expect(context.tier).toBe(2);
    await router.runtime.setAutonomyTier({ tier: 3 });
    expect(context.tier).toBe(3);
    await router.runtime.setAutonomyTier({ tier: 1 });
    expect(context.tier).toBe(1);
  });

  it('runtime.setAutonomyTier rejects non-literal tier (3S, validates literal 1|2|3)', async () => {
    const { ProjectRegistry } = await import('../../src/projects/registry.js');
    const { TaskRegistry } = await import('../../src/state/task-registry.js');
    const { QuestionRegistry } = await import('../../src/state/question-registry.js');
    const { WaveRegistry } = await import('../../src/orchestrator/research-wave-registry.js');
    const { WorkerRegistry } = await import('../../src/orchestrator/worker-registry.js');
    const { ModeController } = await import('../../src/orchestrator/mode.js');
    const projectStore = new ProjectRegistry();
    const router = createSymphonyRouter({
      projectStore,
      taskStore: new TaskRegistry({ projectStore }),
      questionStore: new QuestionRegistry(),
      waveStore: new WaveRegistry(),
      workerRegistry: new WorkerRegistry(),
      modeController: new ModeController({ initial: 'plan' }),
    });

    await expect(
      router.runtime.setAutonomyTier({ tier: 4 as 1 | 2 | 3 }),
    ).rejects.toThrow(/tier must be 1, 2, or 3/);
    await expect(
      router.runtime.setAutonomyTier({ tier: 0 as 1 | 2 | 3 }),
    ).rejects.toThrow(/tier must be 1, 2, or 3/);
  });
});
