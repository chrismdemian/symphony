import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSymphonyRouter } from '../../src/rpc/router-impl.js';
import { ProjectRegistry } from '../../src/projects/registry.js';
import { TaskRegistry } from '../../src/state/task-registry.js';
import { QuestionRegistry } from '../../src/state/question-registry.js';
import { WaveRegistry } from '../../src/orchestrator/research-wave-registry.js';
import { WorkerRegistry } from '../../src/orchestrator/worker-registry.js';
import { ModeController } from '../../src/orchestrator/mode.js';
import { SYMPHONY_CONFIG_FILE_ENV, _resetConfigWriteQueue } from '../../src/utils/config.js';

/**
 * Phase 3H.2 — RPC `mode.setModel` server-side handler. Persists `modelMode`
 * to `~/.symphony/config.json` via `loadConfig`/`saveConfig`. The TUI's
 * `<leader>m` chord and SettingsPanel modelMode editor both call this
 * (or the in-process `ConfigProvider.setConfig` — same disk effect).
 *
 * No in-memory cache server-side — every spawn re-reads disk so multi-
 * process Maestro/bootstrap state stays consistent without an
 * invalidation channel.
 */

function makeRouter() {
  const projectStore = new ProjectRegistry();
  const taskStore = new TaskRegistry({ projectStore });
  const questionStore = new QuestionRegistry();
  const waveStore = new WaveRegistry();
  const workerRegistry = new WorkerRegistry();
  const modeController = new ModeController({ initial: 'plan' });
  return createSymphonyRouter({
    projectStore,
    taskStore,
    questionStore,
    waveStore,
    workerRegistry,
    modeController,
  });
}

describe('rpc mode.setModel (3H.2)', () => {
  let tmp: string;
  let cfgFile: string;
  let prevEnv: string | undefined;

  beforeEach(() => {
    _resetConfigWriteQueue();
    tmp = mkdtempSync(join(tmpdir(), 'symphony-rpc-setmodel-'));
    cfgFile = join(tmp, 'config.json');
    prevEnv = process.env[SYMPHONY_CONFIG_FILE_ENV];
    process.env[SYMPHONY_CONFIG_FILE_ENV] = cfgFile;
  });

  afterEach(() => {
    _resetConfigWriteQueue();
    if (prevEnv === undefined) delete process.env[SYMPHONY_CONFIG_FILE_ENV];
    else process.env[SYMPHONY_CONFIG_FILE_ENV] = prevEnv;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('flips modelMode to opus and persists', async () => {
    const router = makeRouter();
    const result = await router.mode.setModel({ modelMode: 'opus' });
    expect(result).toEqual({ modelMode: 'opus', warnings: [] });
    const onDisk = JSON.parse(readFileSync(cfgFile, 'utf8')) as Record<string, unknown>;
    expect(onDisk['modelMode']).toBe('opus');
  });

  it('surfaces loadConfig warnings in the result (audit M3)', async () => {
    // Pre-seed a malformed-but-salvageable file: bad maxConcurrentWorkers
    // triggers the salvage path in `parseConfig` which emits a warning.
    writeFileSync(
      cfgFile,
      JSON.stringify({ schemaVersion: 1, modelMode: 'mixed', maxConcurrentWorkers: -99 }, null, 2),
      'utf8',
    );
    const router = makeRouter();
    const result = await router.mode.setModel({ modelMode: 'opus' });
    expect(result.modelMode).toBe('opus');
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.some((w) => w.includes('maxConcurrentWorkers'))).toBe(true);
  });

  it('round-trips: opus then mixed', async () => {
    const router = makeRouter();
    await router.mode.setModel({ modelMode: 'opus' });
    await router.mode.setModel({ modelMode: 'mixed' });
    const onDisk = JSON.parse(readFileSync(cfgFile, 'utf8')) as Record<string, unknown>;
    expect(onDisk['modelMode']).toBe('mixed');
  });

  it('preserves other config fields (e.g., maxConcurrentWorkers, theme)', async () => {
    writeFileSync(
      cfgFile,
      JSON.stringify(
        {
          schemaVersion: 1,
          modelMode: 'mixed',
          maxConcurrentWorkers: 12,
          theme: { name: 'symphony', autoFallback16Color: false },
        },
        null,
        2,
      ),
      'utf8',
    );
    const router = makeRouter();
    await router.mode.setModel({ modelMode: 'opus' });
    const onDisk = JSON.parse(readFileSync(cfgFile, 'utf8')) as Record<string, unknown>;
    expect(onDisk['modelMode']).toBe('opus');
    expect(onDisk['maxConcurrentWorkers']).toBe(12);
    expect((onDisk['theme'] as Record<string, unknown>)['autoFallback16Color']).toBe(false);
  });

  it('rejects bad args (modelMode neither opus nor mixed)', async () => {
    const router = makeRouter();
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      router.mode.setModel({ modelMode: 'turbo' as any }),
    ).rejects.toThrow(/modelMode/);
  });

  it('rejects bad args (missing modelMode)', async () => {
    const router = makeRouter();
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      router.mode.setModel({} as any),
    ).rejects.toThrow(/modelMode/);
  });

  it('rejects bad args (null / number / array — audit m5)', async () => {
    const router = makeRouter();
    for (const bad of [null, 0, [], {}, 'OPUS']) {
      await expect(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        router.mode.setModel({ modelMode: bad as any }),
      ).rejects.toThrow(/modelMode/);
    }
  });
});
