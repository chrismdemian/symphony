import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyPatchToDisk,
  defaultConfig,
  loadConfig,
  SYMPHONY_CONFIG_FILE_ENV,
  _resetConfigWriteQueue,
} from '../../src/utils/config.js';

/**
 * Phase 3H.2 — `applyPatchToDisk` is the single in-process serializer for
 * config writes. Both `<ConfigProvider>.setConfig` and the RPC
 * `mode.setModel` route through it. Tests cover the serialization
 * behavior, merge semantics, and validation rollback.
 */

describe('applyPatchToDisk (3H.2)', () => {
  let tmp: string;
  let cfgFile: string;
  let prevEnv: string | undefined;

  beforeEach(() => {
    _resetConfigWriteQueue();
    tmp = mkdtempSync(join(tmpdir(), 'symphony-apply-patch-'));
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

  it('reads from disk fresh on every call (no stale cache)', async () => {
    writeFileSync(
      cfgFile,
      JSON.stringify({ schemaVersion: 1, maxConcurrentWorkers: 4 }, null, 2),
      'utf8',
    );
    await applyPatchToDisk({ modelMode: 'opus' });
    // Out-of-band edit (e.g. user `symphony config --edit`).
    writeFileSync(
      cfgFile,
      JSON.stringify({ schemaVersion: 1, modelMode: 'opus', maxConcurrentWorkers: 4, leaderTimeoutMs: 700 }, null, 2),
      'utf8',
    );
    // Next patch should preserve the out-of-band leaderTimeoutMs because
    // the helper re-reads disk before merging.
    const result = await applyPatchToDisk({ maxConcurrentWorkers: 12 });
    expect(result.config.leaderTimeoutMs).toBe(700);
    expect(result.config.modelMode).toBe('opus');
    expect(result.config.maxConcurrentWorkers).toBe(12);
  });

  it('serializes concurrent writes — both patches survive (audit C2)', async () => {
    const calls = [
      applyPatchToDisk({ modelMode: 'opus' }),
      applyPatchToDisk({ maxConcurrentWorkers: 16 }),
      applyPatchToDisk({ leaderTimeoutMs: 500 }),
    ];
    await Promise.all(calls);
    const loaded = await loadConfig();
    expect(loaded.config.modelMode).toBe('opus');
    expect(loaded.config.maxConcurrentWorkers).toBe(16);
    expect(loaded.config.leaderTimeoutMs).toBe(500);
  });

  it('does NOT poison the queue when one call rejects', async () => {
    const before = applyPatchToDisk({ modelMode: 'opus' });
    // Out-of-range — Zod throws inside the helper, before disk write.
    const rejected = applyPatchToDisk({ maxConcurrentWorkers: -1 });
    const after = applyPatchToDisk({ leaderTimeoutMs: 250 });

    await before;
    await expect(rejected).rejects.toThrow();
    await after;

    const loaded = await loadConfig();
    expect(loaded.config.modelMode).toBe('opus');
    expect(loaded.config.leaderTimeoutMs).toBe(250);
    // The bad write didn't land — should still be the schema default.
    expect(loaded.config.maxConcurrentWorkers).toBe(4);
  });

  it('returns source.kind="file" with resolved path (audit M1)', async () => {
    const result = await applyPatchToDisk({ modelMode: 'opus' });
    expect(result.source.kind).toBe('file');
    if (result.source.kind === 'file') {
      expect(result.source.path).toBe(cfgFile);
      expect(result.source.warnings).toEqual([]);
    }
  });

  it('partial-deep-merges nested theme + notifications', async () => {
    await applyPatchToDisk({ theme: { autoFallback16Color: false } });
    await applyPatchToDisk({ notifications: { enabled: true } });
    const loaded = await loadConfig();
    expect(loaded.config.theme.autoFallback16Color).toBe(false);
    expect(loaded.config.theme.name).toBe('symphony');
    expect(loaded.config.notifications.enabled).toBe(true);
  });

  it('explicit null on defaultProjectPath drops the field on disk', async () => {
    await applyPatchToDisk({ defaultProjectPath: '/tmp/foo' });
    let onDisk = JSON.parse(readFileSync(cfgFile, 'utf8')) as Record<string, unknown>;
    expect(onDisk['defaultProjectPath']).toBe('/tmp/foo');

    await applyPatchToDisk({ defaultProjectPath: null });
    onDisk = JSON.parse(readFileSync(cfgFile, 'utf8')) as Record<string, unknown>;
    expect(onDisk['defaultProjectPath']).toBeUndefined();
  });

  it('Zod rejection leaves disk unchanged', async () => {
    await applyPatchToDisk({ maxConcurrentWorkers: 8 });
    await expect(applyPatchToDisk({ maxConcurrentWorkers: 99 })).rejects.toThrow();
    const loaded = await loadConfig();
    expect(loaded.config.maxConcurrentWorkers).toBe(8);
  });

  it('respects an explicit filePath override', async () => {
    const altFile = join(tmp, 'alt-config.json');
    const result = await applyPatchToDisk({ modelMode: 'opus' }, altFile);
    expect(result.config.modelMode).toBe('opus');
    const altText = readFileSync(altFile, 'utf8');
    expect(JSON.parse(altText)['modelMode']).toBe('opus');
    // Default file should not exist — override took effect.
    expect(() => readFileSync(cfgFile, 'utf8')).toThrow(/ENOENT/);
  });

  it('starts from defaults when no file existed', async () => {
    const result = await applyPatchToDisk({ modelMode: 'opus' });
    expect(result.config.modelMode).toBe('opus');
    expect(result.config.maxConcurrentWorkers).toBe(defaultConfig().maxConcurrentWorkers);
  });
});
